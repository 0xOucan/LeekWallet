/**
 * Transport fuzzer — attacker-controlled bytes into the real receive path.
 *
 * Five targets, all reachable by someone who has the cable or the radio and no
 * credentials at all:
 *
 *   1. cbor    — the reader over random and near-valid buffers
 *   2. chunk   — ble_chunk_push, with reassembler invariants asserted
 *   3. usb     — arbitrary byte streams into consume(), the resynchroniser
 *   4. frame   — structured frames with hostile length/type fields
 *   5. session — mutated CBOR *inside* a confirmed session, which is the only
 *                way to reach dispatch(), eth-decode and eip712 with bytes the
 *                peer chose
 *
 * Randomised rather than coverage-guided: the corpus here is small and the
 * grammar is known, so a seeded PRNG plus splice/flip mutation of valid
 * requests reaches the interesting states without a libFuzzer dependency. The
 * seed is printed and accepted on the command line, so any hit reproduces.
 *
 * Built with ASan+UBSan by `make -C sim fuzz`. Without a sanitiser this only
 * catches hangs and invariant violations, which is the smaller half.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ble-chunk.h"
#include "blind-signing.h"
#include "cbor.h"
#include "eip712.h"
#include "esp_stubs.h"
#include "eth-decode.h"
#include "eth-tx.h"
#include "fake_nvs.h"
#include "fake_usb.h"
#include "fake_wallet.h"
#include "leek-wallet.h"
#include "pin.h"
#include "protocol.h"
#include "session.h"
#include "ui.h"

#include "chacha20poly1305/rfc7539.h"

void pin__reset_static_state_for_test(void);
void protocol__pump_for_test(void);
void protocol__reset_for_test(void);

/* ------------------------------------------------------------- UI stubs */

uint32_t ui_hd_account(void) { return 0; }
void ui_request_session_confirm(void) { }
void ui_request_unlock(void) { }
void ui_request_lock(void) { }
void ui_request_sign(const EthTx *tx, const HDPath *path, const char *from)
{ (void)tx; (void)path; (void)from; }
void ui_request_sign_message(const char *m, size_t n, const HDPath *p, const char *f)
{ (void)m; (void)n; (void)p; (void)f; }
void ui_request_sign_typed_data(const Eip712Render *r, const uint8_t d[32], bool b,
                                const HDPath *p, const char *f)
{ (void)r; (void)d; (void)b; (void)p; (void)f; }
void ui_request_passphrase_confirm(const char *a) { (void)a; }
/* Rejected, always: an approval would run PBKDF2 and secp256k1 on every
 * iteration and turn a fuzzer into a benchmark. Everything this file is
 * looking for happens in the parse, which is upstream of the prompt. */
SignOutcome ui_sign_outcome(void) { return SIGN_REJECTED; }
void ui_sign_report(bool ok) { (void)ok; }
void ui_sign_clear(void) { }

/* ---------------------------------------------------------------- random */

static uint64_t rng_state;

static uint32_t rnd(void)
{
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 7;
    rng_state ^= rng_state << 17;
    return (uint32_t)(rng_state >> 32);
}

static uint32_t rnd_below(uint32_t n) { return n ? rnd() % n : 0; }

/* --------------------------------------------------------- host session */

void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n,
                                 const uint8_t *basepoint);

static uint8_t host_priv[32], host_pub[32];
static uint8_t k_h2d[32], k_d2h[32];
static uint32_t host_tx;
static bool     session_up;

static void make_nonce(uint32_t counter, uint8_t nonce[12])
{
    memset(nonce, 0, 12);
    nonce[8]  = (uint8_t)(counter >> 24);
    nonce[9]  = (uint8_t)(counter >> 16);
    nonce[10] = (uint8_t)(counter >> 8);
    nonce[11] = (uint8_t)counter;
}

static size_t host_seal(uint8_t *buf, size_t len)
{
    uint8_t nonce[12];
    make_nonce(host_tx++, nonce);
    chacha20poly1305_ctx ctx;
    rfc7539_init(&ctx, k_h2d, nonce);
    chacha20poly1305_encrypt(&ctx, buf, buf, len);
    rfc7539_finish(&ctx, 0, len, buf + len);
    return len + 16;
}

/* ------------------------------------------------------------- the wire */

static void drain(void)
{
    uint8_t sink[4096];
    while (fake_usb_device_read(sink, sizeof(sink)) > 0) { }
}

static void feed(const uint8_t *bytes, size_t len)
{
    fake_usb_host_write(bytes, len);
    protocol__pump_for_test();
    drain();
}

static void send_frame(uint8_t type, const uint8_t *payload, size_t len)
{
    uint8_t frame[PROTOCOL_MAX_FRAME + 8];
    if (len + 5 > sizeof(frame)) return;
    size_t body = len + 1;
    frame[0] = 'L';
    frame[1] = 'K';
    frame[2] = (uint8_t)(body >> 8);
    frame[3] = (uint8_t)body;
    frame[4] = type;
    if (len) memcpy(frame + 5, payload, len);
    feed(frame, len + 5);
}

/* ------------------------------------------------------------- fixtures */

static const char *FUZZ_MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

static void fresh_device(void)
{
    fake_usb_reset();
    fake_nvs_reset();
    blind_signing_forget();
    pin__reset_static_state_for_test();
    pin_init();
    fake_wallet_reset();
    session_reset();
    protocol__reset_for_test();
    protocol_set_rx_enabled(true);
    host_tx = 0;
    session_up = false;
    protocol_start();
}

/* Read the device public key out of a helloAck sitting in the output pipe. */
static bool open_session(void)
{
    static const uint8_t base[32] = { 9 };
    uint8_t clamped[32];
    for (int i = 0; i < 32; i++) host_priv[i] = (uint8_t)rnd();
    memcpy(clamped, host_priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(host_pub, clamped, base);

    uint8_t payload[128];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "hello");
    cbor_write_text(&w, "hostPubkey");
    cbor_write_bytes(&w, host_pub, sizeof(host_pub));
    if (!cbor_writer_ok(&w)) return false;

    size_t body = w.length + 1;
    uint8_t frame[256];
    frame[0] = 'L'; frame[1] = 'K';
    frame[2] = (uint8_t)(body >> 8); frame[3] = (uint8_t)body;
    frame[4] = 0x01;
    memcpy(frame + 5, payload, w.length);
    fake_usb_host_write(frame, w.length + 5);
    protocol__pump_for_test();

    uint8_t out[512];
    size_t n = fake_usb_device_read(out, sizeof(out));
    if (n < 7) return false;

    /* out is 'L','K',len,len,type,<cbor> */
    const uint8_t *cbor = out + 5;
    size_t cbor_len = n - 5;
    CborItem it;
    CborReader r;
    cbor_reader_init(&r, cbor, cbor_len);
    if (!cbor_read(&r, &it) || it.type != CBOR_MAP) return false;
    if (!cbor_read(&r, &it) || it.type != CBOR_TEXT) return false;
    const uint8_t *inner = cbor + r.pos;
    size_t inner_len = cbor_len - r.pos;
    if (!cbor_map_find(inner, inner_len, "devicePubkey", &it) ||
        it.type != CBOR_BYTES || it.value != 32) return false;

    char passkey[7];
    if (!session_derive(host_priv, it.data, k_h2d, k_d2h, passkey)) return false;
    session_confirm();
    host_tx = 0;
    session_up = true;
    drain();
    return true;
}

static bool armed_session(void)
{
    fresh_device();
    pin_set("123456");
    pin_verify("123456");
    wallet_unlock("password", 8);
    fake_wallet_preload(FUZZ_MNEMONIC);
    return open_session();
}

/* --------------------------------------------------------------- corpus */

/* Valid requests, as bytes, to be mutated. Written with the real encoder: the
 * point is to start from something the device accepts and walk away from it. */
#define CORPUS_MAX 8
static uint8_t corpus[CORPUS_MAX][PROTOCOL_MAX_FRAME];
static size_t  corpus_len[CORPUS_MAX];
static int     corpus_count;

static void add_corpus(const CborWriter *w)
{
    if (corpus_count >= CORPUS_MAX || !cbor_writer_ok(w)) return;
    memcpy(corpus[corpus_count], w->buf, w->length);
    corpus_len[corpus_count] = w->length;
    corpus_count++;
}

static void build_corpus(void)
{
    static uint8_t buf[PROTOCOL_MAX_FRAME];
    CborWriter w;

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method"); cbor_write_text(&w, "getStatus");
    add_corpus(&w);

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "method"); cbor_write_text(&w, "getAddress");
    cbor_write_text(&w, "index");  cbor_write_uint(&w, 3);
    cbor_write_text(&w, "path");   cbor_write_text(&w, "m/44'/60'/1'/0/7");
    add_corpus(&w);

    /* signTransaction with realistically shaped fields. */
    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 8);
    cbor_write_text(&w, "method");   cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");  cbor_write_uint(&w, 1);
    cbor_write_text(&w, "nonce");    cbor_write_uint(&w, 5);
    cbor_write_text(&w, "gasLimit"); cbor_write_uint(&w, 21000);
    cbor_write_text(&w, "to");
    { uint8_t to[20]; memset(to, 0xAB, sizeof(to)); cbor_write_bytes(&w, to, sizeof(to)); }
    cbor_write_text(&w, "value");
    { uint8_t v[8]; memset(v, 0x11, sizeof(v)); cbor_write_bytes(&w, v, sizeof(v)); }
    cbor_write_text(&w, "data");
    { uint8_t d[68]; memset(d, 0x22, sizeof(d));
      d[0] = 0xa9; d[1] = 0x05; d[2] = 0x9c; d[3] = 0xbb;
      cbor_write_bytes(&w, d, sizeof(d)); }
    cbor_write_text(&w, "index");    cbor_write_uint(&w, 0);
    add_corpus(&w);

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");  cbor_write_text(&w, "signMessage");
    cbor_write_text(&w, "message");
    { uint8_t m[32]; memset(m, 'A', sizeof(m)); cbor_write_bytes(&w, m, sizeof(m)); }
    add_corpus(&w);

    /* Typed data: nested maps inside arrays inside maps, which is the shape
     * the recursive descent in eip712.c is walking. */
    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "method"); cbor_write_text(&w, "signTypedData");
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "EIP712Domain");
    cbor_write_array(&w, 1);
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "name"); cbor_write_text(&w, "name");
    cbor_write_text(&w, "type"); cbor_write_text(&w, "string");
    cbor_write_text(&w, "primaryType"); cbor_write_text(&w, "EIP712Domain");
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "name"); cbor_write_text(&w, "leek");
    add_corpus(&w);

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method"); cbor_write_text(&w, "setPassphrase");
    cbor_write_text(&w, "passphrase"); cbor_write_text(&w, "hunter2");
    add_corpus(&w);
}

/* Splice/flip/truncate/extend, over a corpus entry or from nothing. */
static size_t mutate(uint8_t *out, size_t cap)
{
    size_t len;
    if (corpus_count && rnd_below(4)) {
        int which = (int)rnd_below((uint32_t)corpus_count);
        len = corpus_len[which];
        if (len > cap) len = cap;
        memcpy(out, corpus[which], len);
    } else {
        len = rnd_below(64) + 1;
        if (len > cap) len = cap;
        for (size_t i = 0; i < len; i++) out[i] = (uint8_t)rnd();
    }

    int rounds = 1 + (int)rnd_below(6);
    for (int i = 0; i < rounds; i++) {
        switch (rnd_below(6)) {
            case 0:     /* bit flip */
                if (len) out[rnd_below((uint32_t)len)] ^= (uint8_t)(1u << rnd_below(8));
                break;
            case 1: {   /* byte set, biased to CBOR heads */
                static const uint8_t heads[] = {
                    0x00, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1f, 0x20,
                    0x40, 0x58, 0x59, 0x5a, 0x5f, 0x60, 0x78, 0x79,
                    0x7f, 0x80, 0x98, 0x9f, 0xa0, 0xb8, 0xbf, 0xc0,
                    0xd8, 0xe0, 0xf7, 0xff,
                };
                if (len) out[rnd_below((uint32_t)len)] = heads[rnd_below(sizeof(heads))];
                break;
            }
            case 2:     /* truncate */
                if (len > 1) len = 1 + rnd_below((uint32_t)len - 1);
                break;
            case 3: {   /* extend with noise */
                size_t add = rnd_below(64);
                while (add-- && len < cap) out[len++] = (uint8_t)rnd();
                break;
            }
            case 4:     /* splice another corpus entry in */
                if (corpus_count) {
                    int which = (int)rnd_below((uint32_t)corpus_count);
                    size_t take = corpus_len[which];
                    size_t at = len ? rnd_below((uint32_t)len) : 0;
                    if (at + take <= cap) {
                        memcpy(out + at, corpus[which], take);
                        if (at + take > len) len = at + take;
                    }
                }
                break;
            default:    /* stretch to the frame limit, to probe the bounds */
                if (cap > 32) {
                    len = cap - 32 + rnd_below(32);
                }
                break;
        }
        if (len > cap) len = cap;
    }
    return len;
}

/* ------------------------------------------------------------- targets */

static int invariant_failures;

static void fail(const char *what)
{
    printf("  FAIL: %s\n", what);
    invariant_failures++;
}

static void fuzz_usb(int iterations)
{
    static uint8_t buf[2048];
    for (int i = 0; i < iterations; i++) {
        if ((i % 512) == 0) fresh_device();

        size_t len = rnd_below(sizeof(buf) - 2) + 2;
        for (size_t j = 0; j < len; j++) buf[j] = (uint8_t)rnd();
        /* Sprinkle sync markers so the resynchroniser is actually entered. */
        for (int k = 0; k < 6; k++) {
            size_t at = rnd_below((uint32_t)len - 1);
            buf[at] = 'L'; buf[at + 1] = 'K';
        }
        /* Arbitrary write boundaries: consume() has to survive a frame split
         * across any number of reads. */
        size_t off = 0;
        while (off < len) {
            size_t take = rnd_below(97) + 1;
            if (off + take > len) take = len - off;
            feed(buf + off, take);
            off += take;
        }
    }
}

static void fuzz_frames(int iterations)
{
    static uint8_t payload[PROTOCOL_MAX_FRAME];
    static uint8_t frame[PROTOCOL_MAX_FRAME + 64];

    for (int i = 0; i < iterations; i++) {
        if ((i % 512) == 0) fresh_device();

        size_t len = mutate(payload, PROTOCOL_MAX_FRAME - 8);
        uint8_t type;
        switch (rnd_below(8)) {
            case 0: type = 0x01; break;
            case 1: type = 0x11; break;
            case 2: type = 0x02; break;
            case 3: type = 0x12; break;
            case 4: type = 0x7e; break;
            case 5: type = 0x7f; break;
            default: type = (uint8_t)rnd(); break;
        }

        /* Half the time the declared length is a lie. */
        size_t body = len + 1;
        size_t declared = body;
        if (rnd_below(2)) {
            switch (rnd_below(5)) {
                case 0: declared = 0; break;
                case 1: declared = 0xFFFF; break;
                case 2: declared = body + 1 + rnd_below(64); break;
                case 3: declared = body ? body - 1 : 0; break;
                default: declared = rnd_below(0x10000); break;
            }
        }

        frame[0] = 'L'; frame[1] = 'K';
        frame[2] = (uint8_t)(declared >> 8);
        frame[3] = (uint8_t)declared;
        frame[4] = type;
        memcpy(frame + 5, payload, len);
        feed(frame, len + 5);
    }
}

static void fuzz_cbor(int iterations)
{
    static const char *keys[] = { "method", "index", "path", "data", "types",
                                  "message", "passphrase", "", "hostPubkey" };
    static uint8_t buf[1024];
    char text[64];

    for (int i = 0; i < iterations; i++) {
        size_t len = mutate(buf, sizeof(buf));

        CborItem it;
        const char *key = keys[rnd_below(sizeof(keys) / sizeof(keys[0]))];
        if (cbor_map_find(buf, len, key, &it)) {
            if (it.type == CBOR_TEXT) {
                cbor_text_copy(&it, text, sizeof(text));
                /* A one-byte destination is where an off-by-one shows. */
                char tiny[1];
                cbor_text_copy(&it, tiny, sizeof(tiny));
            }
            if ((it.type == CBOR_BYTES || it.type == CBOR_TEXT) && it.data) {
                volatile uint8_t sink = 0;
                for (uint32_t k = 0; k < it.value; k++) sink ^= it.data[k];
                (void)sink;
            }
        }

        CborReader r;
        cbor_reader_init(&r, buf, len);
        while (!cbor_reader_done(&r)) {
            if (!cbor_skip(&r)) break;
        }
    }
}

/* The reassembler, with its invariants checked on every step. */
static void fuzz_chunk(int iterations)
{
    BleReassembler r;
    ble_chunk_reset(&r);

    static uint8_t chunk[BLE_CHUNK_MAX_FRAME + 8];

    for (int i = 0; i < iterations; i++) {
        if (rnd_below(64) == 0) ble_chunk_reset(&r);

        size_t len;
        switch (rnd_below(8)) {
            case 0: len = 0; break;
            case 1: len = 1; break;
            case 2: len = BLE_CHUNK_MAX_FRAME; break;
            case 3: len = 20; break;
            default: len = rnd_below(64) + 1; break;
        }
        for (size_t j = 0; j < len; j++) chunk[j] = (uint8_t)rnd();

        /* Mostly a header the reassembler will accept, so long runs happen. */
        if (len && rnd_below(4)) {
            chunk[0] = (uint8_t)((rnd_below(2) ? BLE_CHUNK_MORE : 0) | r.next_seq);
        }

        uint8_t before_seq = r.next_seq;
        bool was_complete = r.complete;
        BleChunkResult res = ble_chunk_push(&r, chunk, len);

        if (r.len > BLE_CHUNK_MAX_FRAME) {
            fail("the reassembler ran past its buffer");
        }
        if (res == BLE_CHUNK_ERROR) {
            if (r.len != 0 || r.next_seq != 0 || r.complete) {
                fail("an error left reassembly state behind");
            }
        } else if (res == BLE_CHUNK_FRAME_READY) {
            if (r.len < 4) {
                fail("a frame shorter than a header was announced");
            } else {
                size_t declared = (((size_t)r.buf[0] << 8) | r.buf[1]) + 2;
                if (declared != r.len) {
                    fail("a ready frame's declared length is not its size");
                }
            }
            if (!r.complete) fail("a ready frame is not marked complete");
        } else if (res == BLE_CHUNK_NEED_MORE) {
            uint8_t want = was_complete ? 1
                         : (uint8_t)((before_seq + 1) & BLE_CHUNK_SEQ_MASK);
            if (r.next_seq != want) fail("the sequence did not advance by one");
        }

        /* Whatever came out, it goes to the endpoint the way ble.c sends it. */
        if (res == BLE_CHUNK_FRAME_READY) {
            static uint8_t copy[BLE_CHUNK_MAX_FRAME];
            size_t n = r.len;
            memcpy(copy, r.buf, n);
            protocol_handle_frame(copy, n);
            ble_chunk_reset(&r);
        }
    }
}

/* Inside a confirmed session: this is the only path to dispatch(). */
static void fuzz_session(int iterations)
{
    static uint8_t plain[PROTOCOL_MAX_FRAME];
    static uint8_t sealed[PROTOCOL_MAX_FRAME];

    if (!armed_session()) {
        fail("could not open a session to fuzz through");
        return;
    }

    for (int i = 0; i < iterations; i++) {
        if (!session_up || session_state() != SESSION_ACTIVE) {
            /* A frame that failed its tag tears the session down, as designed.
             * Build a new one and carry on. */
            if (!armed_session()) return;
        }

        size_t len = mutate(plain, PROTOCOL_MAX_FRAME - 32);
        memcpy(sealed, plain, len);
        size_t total = host_seal(sealed, len);
        send_frame(0x11, sealed, total);

        if (session_state() != SESSION_ACTIVE) session_up = false;
    }
}

/* ---------------------------------------------------------------- main */

int main(int argc, char **argv)
{
    uint64_t seed = (argc > 1) ? strtoull(argv[1], NULL, 0)
                               : (uint64_t)time(NULL);
    int iterations = (argc > 2) ? atoi(argv[2]) : 20000;
    if (seed == 0) seed = 0x2545F4914F6CDD1Dull;
    if (iterations <= 0) iterations = 1;
    rng_state = seed * 0x9E3779B97F4A7C15ull + 1;

    printf("transport fuzzer: seed %llu, %d iterations per target\n",
           (unsigned long long)seed, iterations);

    build_corpus();

    printf("== cbor reader\n");      fuzz_cbor(iterations);
    printf("== ble reassembly\n");   fuzz_chunk(iterations);
    printf("== usb byte stream\n");  fuzz_usb(iterations / 8 + 1);
    printf("== frame decoder\n");    fuzz_frames(iterations / 2 + 1);
    printf("== inside a session\n"); fuzz_session(iterations / 4 + 1);

    if (invariant_failures) {
        printf("\nFAILED (%d invariant violations)\n", invariant_failures);
        return 1;
    }
    printf("\nno crashes, no invariant violations\n");
    return 0;
}
