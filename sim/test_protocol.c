/**
 * Wire-protocol conformance tests (ROADMAP T26).
 *
 * The real src/protocol.c, running on the host against an in-memory port. Up
 * to now the only machine that had ever executed the device's parser was a
 * board, which made "the mock must never be more permissive than the device"
 * an aspiration: there was nothing to compare the mock against except a
 * document. Twice the mock accepted requests the firmware rejects and
 * certified broken code. This is the other half of that comparison.
 *
 * So the tests here are deliberately written at the byte level — sync marker,
 * length, frame type, CBOR body — rather than through a helper that speaks the
 * protocol on the endpoint's own terms. A test that shares the encoder with
 * the code under test agrees with it by construction, which is exactly the
 * agreement that stopped being informative.
 *
 * Two properties are worth naming because they are the ones that bite:
 *
 *   - Errors returned once a session is active must be ENCRYPTED (0x7E). The
 *     device advances its receive counter the moment a frame decrypts, error
 *     or not, so a plaintext error leaves the two sides one apart and every
 *     later frame fails to decrypt. This is a permanent desynchronisation from
 *     a transient fault.
 *   - A call the device cannot describe is refused BEFORE the confirmation
 *     screen. Asking a user to approve something the device could not decode
 *     is blind signing with extra steps (PROTOCOL.md 6bis).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cbor.h"
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

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Frame types and error codes as the wire carries them, spelled out here
 * rather than included from protocol.c. A test that imports the constants it
 * is checking cannot notice one of them changing. */
#define T_REQUEST      0x01
#define T_RESPONSE     0x02
#define T_ENC_REQUEST  0x11
#define T_ENC_RESPONSE 0x12
#define T_ENC_ERROR    0x7E
#define T_ERROR        0x7F

#define E_MALFORMED    0x0001
#define E_NOT_UNLOCKED 0x0100
#define E_REJECTED     0x0200
#define E_TIMEOUT      0x0201
#define E_UNDECODABLE  0x0202
#define E_SESSION      0x0400

/* ------------------------------------------------------------- fake UI */

/* The screens are another agent's file and another tier's problem. What the
 * protocol tests need to know is only whether the device asked the user
 * anything, and what answer came back. */

static int  confirm_requests;      /* ui_request_sign calls */
static int  unlock_prompts;
static int  lock_requests;
static int  session_confirm_prompts;
static SignOutcome scripted_outcome;
static EthTx    shown_tx;
static uint32_t shown_index;
static char     shown_from[43];

void ui_request_session_confirm(void) { session_confirm_prompts++; }
void ui_request_unlock(void)          { unlock_prompts++; }
void ui_request_lock(void)            { lock_requests++; }

void ui_request_sign(const EthTx *tx, uint32_t address_index, const char *from)
{
    confirm_requests++;
    shown_tx = *tx;
    shown_index = address_index;
    snprintf(shown_from, sizeof(shown_from), "%s", from ? from : "");
}

SignOutcome ui_sign_outcome(void) { return scripted_outcome; }
void ui_sign_clear(void) { }

/* ------------------------------------------------------------ host side */

/* The host half of the session: same derivation, opposite direction. Written
 * out rather than borrowed from session.c because the point is to check the
 * device against an independent implementation of the same rules. */

void curve25519_scalarmult_donna(uint8_t *mypublic, const uint8_t *n,
                                 const uint8_t *basepoint);

static uint8_t host_priv[32], host_pub[32];
static uint8_t k_h2d[32], k_d2h[32];
static uint32_t host_tx, host_rx;
static bool session_up;

static void fill(uint8_t *buf, size_t len, uint8_t seed)
{
    uint32_t s = 0x9e3779b9u ^ seed;
    for (size_t i = 0; i < len; i++) {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        buf[i] = (uint8_t)(s >> 24);
    }
}

static void host_keypair(uint8_t seed)
{
    static const uint8_t base[32] = { 9 };
    uint8_t clamped[32];
    fill(host_priv, 32, seed);
    memcpy(clamped, host_priv, 32);
    clamped[0] &= 248; clamped[31] &= 127; clamped[31] |= 64;
    curve25519_scalarmult_donna(host_pub, clamped, base);
}

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

/* Returns the plaintext length, or -1 if the tag does not verify — which is
 * what a counter that has drifted looks like from here. */
static int host_open(uint8_t *buf, size_t len)
{
    if (len < 16) return -1;
    size_t body = len - 16;

    uint8_t nonce[12];
    make_nonce(host_rx, nonce);

    chacha20poly1305_ctx ctx;
    rfc7539_init(&ctx, k_d2h, nonce);
    chacha20poly1305_decrypt(&ctx, buf, buf, body);

    uint8_t tag[16];
    rfc7539_finish(&ctx, 0, body, tag);
    if (memcmp(tag, buf + body, 16) != 0) return -1;

    host_rx++;
    return (int)body;
}

/* ------------------------------------------------------------- the wire */

static uint8_t stash[8192];
static size_t  stash_len;

static void raw_send(const uint8_t *bytes, size_t len)
{
    fake_usb_host_write(bytes, len);
    protocol__pump_for_test();
    stash_len += fake_usb_device_read(stash + stash_len, sizeof(stash) - stash_len);
}

/** Frame a payload the way the device expects and hand it over. */
static void send_frame(uint8_t type, const uint8_t *payload, size_t len)
{
    uint8_t frame[1024];
    size_t body = len + 1;

    frame[0] = 'L';
    frame[1] = 'K';
    frame[2] = (uint8_t)(body >> 8);
    frame[3] = (uint8_t)body;
    frame[4] = type;
    if (len) {
        memcpy(frame + 5, payload, len);
    }
    raw_send(frame, len + 5);
}

static void send_plain(const uint8_t *payload, size_t len)
{
    send_frame(T_REQUEST, payload, len);
}

static void send_encrypted(const uint8_t *payload, size_t len)
{
    uint8_t buf[512];
    memcpy(buf, payload, len);
    send_frame(T_ENC_REQUEST, buf, host_seal(buf, len));
}

typedef struct {
    bool    present;
    uint8_t type;
    uint8_t payload[512];
    size_t  len;
} Frame;

/** Pull the next complete frame the device wrote, if there is one. */
static Frame next_frame(void)
{
    Frame f;
    memset(&f, 0, sizeof(f));

    size_t i = 0;
    while (i + 1 < stash_len && !(stash[i] == 'L' && stash[i + 1] == 'K')) i++;
    if (i + 4 >= stash_len) return f;

    size_t body = ((size_t)stash[i + 2] << 8) | stash[i + 3];
    if (i + 4 + body > stash_len) return f;
    if (body < 1 || body - 1 > sizeof(f.payload)) return f;

    f.present = true;
    f.type = stash[i + 4];
    f.len = body - 1;
    memcpy(f.payload, stash + i + 5, f.len);

    size_t consumed = i + 4 + body;
    memmove(stash, stash + consumed, stash_len - consumed);
    stash_len -= consumed;
    return f;
}

/** The next frame, decrypted if it is one of the encrypted types. */
static Frame next_reply(void)
{
    Frame f = next_frame();
    if (f.present && (f.type == T_ENC_RESPONSE || f.type == T_ENC_ERROR)) {
        int n = host_open(f.payload, f.len);
        if (n < 0) {
            f.len = 0;
            f.payload[0] = 0;   /* caller's assertions will report the miss */
        } else {
            f.len = (size_t)n;
        }
    }
    return f;
}

static void drop_pending(void) { stash_len = 0; }

/* ---------------------------------------------------------- CBOR helpers */

/** { "method": <name> } — the smallest legal request. */
static size_t req(uint8_t *buf, size_t cap, const char *method)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, method);
    return cbor_writer_ok(&w) ? w.length : 0;
}

/**
 * The body of the top-level { "result": ... } wrapper.
 *
 * cbor_map_find only walks one level, so nested lookups need the offset of the
 * value, which the reader tracks and the finder does not.
 */
static bool result_body(const Frame *f, const uint8_t **out, size_t *out_len)
{
    CborReader r;
    CborItem it;
    cbor_reader_init(&r, f->payload, f->len);

    if (!cbor_read(&r, &it) || it.type != CBOR_MAP || it.value != 1) return false;
    if (!cbor_read(&r, &it) || it.type != CBOR_TEXT) return false;
    if (it.value != 6 || memcmp(it.data, "result", 6) != 0) return false;

    *out = f->payload + r.pos;
    *out_len = f->len - r.pos;
    return true;
}

static bool error_code(const Frame *f, uint32_t *code)
{
    CborItem it;
    if (!cbor_map_find(f->payload, f->len, "code", &it)) return false;
    if (it.type != CBOR_UINT) return false;
    *code = it.value;
    return true;
}

/** An error of exactly this code, in a frame of exactly this type. */
static void expect_error(uint8_t type, uint32_t want, const char *what)
{
    Frame f = next_reply();
    if (!f.present) {
        printf("  FAIL: %s: no reply at all\n", what);
        failures++;
        return;
    }
    CHECK(f.type == type, "%s: frame type 0x%02X, wanted 0x%02X", what, f.type, type);

    uint32_t code = 0;
    if (!error_code(&f, &code)) {
        printf("  FAIL: %s: reply carries no error code\n", what);
        failures++;
        return;
    }
    CHECK(code == want, "%s: error 0x%04X, wanted 0x%04X", what, code, (unsigned)want);
}

static void expect_silence(const char *what)
{
    Frame f = next_frame();
    CHECK(!f.present, "%s: device answered when it had nothing to answer", what);
}

/* ------------------------------------------------------------- fixtures */

static const char *TEST_MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

/* Fresh device, nothing negotiated, no PIN entered. */
static void fresh_device(void)
{
    fake_usb_reset();
    fake_nvs_reset();
    pin__reset_static_state_for_test();
    pin_init();
    fake_wallet_reset();
    session_reset();
    protocol__reset_for_test();

    stash_len = 0;
    host_tx = host_rx = 0;
    session_up = false;
    confirm_requests = unlock_prompts = lock_requests = session_confirm_prompts = 0;
    scripted_outcome = SIGN_APPROVED;

    protocol_start();
}

static void device_has_a_wallet(void)
{
    wallet_unlock("password", 8);
    fake_wallet_preload(TEST_MNEMONIC);
}

static void device_unlocked(void)
{
    pin_set("123456");
    pin_verify("123456");
    device_has_a_wallet();
}

/** Run the handshake and stop at PENDING: keys agreed, user has not confirmed. */
static void handshake(uint8_t seed)
{
    host_keypair(seed);

    uint8_t payload[128];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "hello");
    cbor_write_text(&w, "hostPubkey");
    cbor_write_bytes(&w, host_pub, sizeof(host_pub));
    send_plain(payload, w.length);

    Frame f = next_frame();
    CHECK(f.present && f.type == T_RESPONSE, "hello was not answered in plaintext");
    if (!f.present) return;

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (!result_body(&f, &body, &body_len) ||
        !cbor_map_find(body, body_len, "devicePubkey", &it) ||
        it.type != CBOR_BYTES || it.value != 32) {
        printf("  FAIL: helloAck carried no device public key\n");
        failures++;
        return;
    }

    char passkey[7];
    CHECK(session_derive(host_priv, it.data, k_h2d, k_d2h, passkey),
          "host could not derive the session");
}

/** Complete the handshake: the user compares the passkey and accepts. */
static void confirmed_session(uint8_t seed)
{
    handshake(seed);
    session_confirm();
    session_up = true;
}

/* ================================================================= tests */

static void test_plaintext_ping_and_features(void)
{
    printf("== ping and getFeatures answer in plaintext, byte for byte\n");
    fresh_device();

    CHECK(fake_usb_driver_installed(), "protocol_start did not install the port");

    uint8_t payload[64];
    send_plain(payload, req(payload, sizeof(payload), "ping"));

    Frame f = next_frame();
    CHECK(f.present, "ping went unanswered");
    if (f.present) {
        CHECK(f.type == T_RESPONSE, "ping replied with type 0x%02X", f.type);

        /* {"result": {"pong": 1}}, canonical: a1 66 "result" a1 64 "pong" 01 */
        static const uint8_t want[] = {
            0xa1, 0x66, 'r','e','s','u','l','t',
            0xa1, 0x64, 'p','o','n','g', 0x01,
        };
        CHECK(f.len == sizeof(want) && memcmp(f.payload, want, f.len) == 0,
              "ping payload is not the canonical encoding (%zu bytes)", f.len);
    }

    send_plain(payload, req(payload, sizeof(payload), "getFeatures"));
    f = next_frame();
    CHECK(f.present && f.type == T_RESPONSE, "getFeatures went unanswered");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "blindSigning", &it) &&
              it.type == CBOR_UINT && it.value == 0,
              "getFeatures does not report blind signing off by default");
        CHECK(cbor_map_find(body, body_len, "model", &it) && it.type == CBOR_TEXT,
              "getFeatures names no model");
        /* Nothing user-specific may appear here: it is answered before any
         * session exists, to anything plugged into the port. */
        CHECK(!cbor_map_find(body, body_len, "walletCount", &it) &&
              !cbor_map_find(body, body_len, "activeWallet", &it),
              "getFeatures leaks wallet state to an unauthenticated peer");
    } else {
        CHECK(!f.present, "getFeatures reply is not a result map");
    }
}

static void test_status_is_public_but_thin(void)
{
    printf("== getStatus answers pre-session and says only what it must\n");
    fresh_device();
    device_unlocked();

    uint8_t payload[64];
    send_plain(payload, req(payload, sizeof(payload), "getStatus"));

    Frame f = next_frame();
    CHECK(f.present && f.type == T_RESPONSE, "getStatus went unanswered in plaintext");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "unlocked", &it) &&
              it.type == CBOR_UINT && it.value == 1, "getStatus lost the unlock flag");
        CHECK(cbor_map_find(body, body_len, "passphrase", &it) &&
              it.type == CBOR_UINT && it.value == 0, "getStatus lost the passphrase flag");
        /* Whether a passphrase is applied, never which one. */
        CHECK(!cbor_map_find(body, body_len, "passphraseValue", &it),
              "getStatus reveals the passphrase itself");
    }
}

static void test_keys_need_a_session_and_a_passkey(void)
{
    printf("== key operations wait for a session and for the user to confirm\n");
    fresh_device();
    device_unlocked();

    uint8_t payload[64];

    /* No handshake at all. */
    send_plain(payload, req(payload, sizeof(payload), "getAddress"));
    expect_error(T_ERROR, E_SESSION, "getAddress before any handshake");

    /* Keys agreed, but the six digits on the OLED have not been compared. The
     * whole MITM defence is that step, so PENDING must be as good as nothing:
     * a relay that got this far would otherwise be talking to a wallet. */
    handshake(11);
    CHECK(session_confirm_prompts == 1, "the handshake did not put a passkey on screen");
    CHECK(session_state() == SESSION_PENDING, "handshake left the session in state %d",
          session_state());

    send_encrypted(payload, req(payload, sizeof(payload), "getAddress"));
    expect_error(T_ERROR, E_SESSION, "getAddress before the passkey was confirmed");

    /* And the plaintext door stays shut too — a host that skips the confirm
     * step and drops back to plaintext must not be answered either. */
    send_plain(payload, req(payload, sizeof(payload), "getAddress"));
    expect_error(T_ERROR, E_SESSION, "plaintext getAddress during a pending session");
}

static void test_locked_device_refuses_keys(void)
{
    printf("== a locked device refuses key operations with 0x0100\n");
    fresh_device();
    device_has_a_wallet();          /* a wallet exists; the PIN has not been entered */
    confirmed_session(12);

    CHECK(!pin_is_unlocked(), "the fixture left the device unlocked");

    uint8_t payload[64];
    send_encrypted(payload, req(payload, sizeof(payload), "getAddress"));
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "getAddress while locked");

    send_encrypted(payload, req(payload, sizeof(payload), "signTransaction"));
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "signTransaction while locked");
    CHECK(confirm_requests == 0, "a locked device put a transaction on screen");

    /* unlock() prompts on the device and never carries a PIN. */
    send_encrypted(payload, req(payload, sizeof(payload), "unlock"));
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "unlock was not answered");
    CHECK(unlock_prompts == 1, "unlock did not ask the device to prompt");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "unlocked", &it) &&
              it.type == CBOR_UINT && it.value == 0,
              "unlock claimed success before the user typed anything");
    }
}

static void test_address_derivation_reads_the_path(void)
{
    printf("== getAddress derives from the path, not from address zero\n");
    fresh_device();
    device_unlocked();
    confirmed_session(13);

    uint8_t payload[96];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "getAddress");
    cbor_write_text(&w, "path");
    cbor_write_text(&w, "m/44'/60'/0'/0/7");
    send_encrypted(payload, w.length);

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "getAddress was not answered");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "index", &it) &&
              it.type == CBOR_UINT && it.value == 7,
              "the trailing path component was ignored — every request would "
              "derive address zero");
        CHECK(cbor_map_find(body, body_len, "address", &it) &&
              it.type == CBOR_TEXT && it.value == 42,
              "address is not a 42-character hex string");
    }
}

/* The centrepiece: what happens to a call the device cannot put into words. */
static void test_undecodable_calldata_refused_before_confirmation(void)
{
    printf("== calldata outside the decodable set is 0x0202, before any prompt\n");
    fresh_device();
    device_unlocked();
    confirmed_session(14);

    uint8_t to[20];
    memset(to, 0xAB, sizeof(to));

    /* A selector nothing decodes, with a plausible argument block behind it. */
    uint8_t data[36] = { 0xde, 0xad, 0xbe, 0xef };

    uint8_t payload[256];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 5);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "path");
    cbor_write_text(&w, "m/44'/60'/0'/0/0");
    cbor_write_text(&w, "to");
    cbor_write_bytes(&w, to, sizeof(to));
    cbor_write_text(&w, "data");
    cbor_write_bytes(&w, data, sizeof(data));
    CHECK(cbor_writer_ok(&w), "request did not fit");
    send_encrypted(payload, w.length);

    expect_error(T_ENC_ERROR, E_UNDECODABLE, "unknown selector");

    /* The refusal has to come first. Showing the screen and then refusing is
     * only marginally better than showing a hash: the user has already been
     * trained to press the button. */
    CHECK(confirm_requests == 0,
          "the device asked for approval of a call it could not describe");

    /* A recognised selector with a truncated argument block is refused too —
     * decoding is exact, not best-effort. */
    uint8_t short_transfer[40] = { 0xa9, 0x05, 0x9c, 0xbb };
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "to");
    cbor_write_bytes(&w, to, sizeof(to));
    cbor_write_text(&w, "data");
    cbor_write_bytes(&w, short_transfer, sizeof(short_transfer));
    send_encrypted(payload, w.length);

    expect_error(T_ENC_ERROR, E_UNDECODABLE, "half a transfer() call");
    CHECK(confirm_requests == 0, "a half-decoded call reached the screen");

    /* Contract creation: no recipient to name, no code to describe. */
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    send_encrypted(payload, w.length);

    expect_error(T_ENC_ERROR, E_UNDECODABLE, "contract creation");
    CHECK(confirm_requests == 0, "contract creation reached the screen");
}

static size_t native_transfer_request(uint8_t *payload, size_t cap,
                                      const uint8_t to[20], uint32_t index)
{
    CborWriter w;
    cbor_writer_init(&w, payload, cap);
    cbor_write_map(&w, 6);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "nonce");
    cbor_write_uint(&w, 42);
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, index);
    cbor_write_text(&w, "to");
    cbor_write_bytes(&w, to, 20);
    cbor_write_text(&w, "value");
    {
        static const uint8_t value[] = { 0x0d, 0xe0, 0xb6, 0xb3, 0xa7, 0x64, 0x00, 0x00 };
        cbor_write_bytes(&w, value, sizeof(value));
    }
    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_signing_signs_what_it_showed(void)
{
    printf("== an approved signature is taken over the fields that were rendered\n");
    fresh_device();
    device_unlocked();
    confirmed_session(15);

    uint8_t to[20];
    memset(to, 0x11, sizeof(to));

    uint8_t payload[256];
    size_t len = native_transfer_request(payload, sizeof(payload), to, 3);
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, len);

    CHECK(confirm_requests == 1, "the transaction was signed without a prompt");
    CHECK(shown_index == 3, "the screen named index %u, not 3", shown_index);
    CHECK(strlen(shown_from) == 42,
          "the screen was not given a full source address (T47): '%s'", shown_from);

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "the signature was not returned");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        /* The fake wallet returns the digest as r, so this is the assertion
         * that the bytes signed are the bytes the device parsed and drew —
         * the one property Rule 1 reduces to. */
        uint8_t expect_digest[32];
        CHECK(eth_tx_hash(&shown_tx, expect_digest), "could not re-hash what was shown");

        CHECK(cbor_map_find(body, body_len, "r", &it) && it.type == CBOR_BYTES &&
              it.value == 32 && memcmp(it.data, expect_digest, 32) == 0,
              "the signature is not over the transaction that was displayed");

        /* yParity, never the legacy 27/28 form: a client masking the low bit
         * of 27 inverts it and recovers an address nobody owns. */
        CHECK(cbor_map_find(body, body_len, "yParity", &it) && it.type == CBOR_UINT &&
              it.value <= 1, "yParity is %u — that is the legacy v, not yParity",
              it.value);
        CHECK(cbor_map_find(body, body_len, "index", &it) && it.type == CBOR_UINT &&
              it.value == 3, "the reply names a different index than was signed");
    }
}

static void test_rejection_and_timeout(void)
{
    printf("== refusing and ignoring the prompt both end the request\n");
    fresh_device();
    device_unlocked();
    confirmed_session(16);

    uint8_t to[20];
    memset(to, 0x22, sizeof(to));
    uint8_t payload[256];
    size_t len = native_transfer_request(payload, sizeof(payload), to, 0);

    scripted_outcome = SIGN_REJECTED;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_REJECTED, "user rejected the transaction");

    /* Nobody touches the device. It must give up rather than hold the channel
     * open forever. */
    scripted_outcome = SIGN_PENDING;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_TIMEOUT, "nobody answered the prompt");
}

/* The asymmetry that cost a hardware session: see the file header. */
static void test_errors_stay_encrypted_once_a_session_exists(void)
{
    printf("== an error inside a session is encrypted, or the two sides desync\n");
    fresh_device();
    device_unlocked();
    confirmed_session(17);

    uint8_t payload[64];

    /* One good exchange first, so both counters are off zero and a drift
     * shows up as a decrypt failure rather than as an accident. */
    send_encrypted(payload, req(payload, sizeof(payload), "getStatus"));
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "getStatus inside the session failed");

    /* Now something the device does not implement. The tempting reply is a
     * plaintext error: it is simple, and it is the bug. The device advanced
     * its receive counter to decrypt this request, so a reply outside the
     * encrypted stream leaves the host's send counter one behind forever. */
    send_encrypted(payload, req(payload, sizeof(payload), "definitelyNotAMethod"));

    Frame err = next_frame();
    CHECK(err.present, "the unknown method went unanswered");
    CHECK(err.type == T_ENC_ERROR,
          "an in-session error came back as frame type 0x%02X, not 0x7E — "
          "every later frame will fail to decrypt", err.type);

    if (err.type == T_ENC_ERROR) {
        int n = host_open(err.payload, err.len);
        CHECK(n > 0, "the encrypted error did not open with the expected nonce");
        if (n > 0) {
            err.len = (size_t)n;
            uint32_t code = 0;
            CHECK(error_code(&err, &code) && code == E_MALFORMED,
                  "unknown method reported 0x%04X", code);
        }
    }

    /* The point of all of it: the channel still works afterwards. */
    send_encrypted(payload, req(payload, sizeof(payload), "ping"));
    f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE && f.len > 0,
          "the session did not survive an error — this is the desync");
}

static void test_malformed_input(void)
{
    printf("== truncated, lying, oversized and unparseable input\n");
    fresh_device();
    device_unlocked();

    uint8_t payload[64];
    size_t len = req(payload, sizeof(payload), "ping");

    /* A frame split across two reads. The endpoint shares its port with the
     * console, so this is the normal case, not the exotic one. */
    uint8_t frame[128];
    frame[0] = 'L'; frame[1] = 'K';
    frame[2] = 0; frame[3] = (uint8_t)(len + 1);
    frame[4] = T_REQUEST;
    memcpy(frame + 5, payload, len);

    raw_send(frame, 6);
    expect_silence("half a frame");
    raw_send(frame + 6, len + 5 - 6);
    CHECK(next_frame().present, "the second half of a split frame was dropped");

    /* A length field that lies about a frame far bigger than the device will
     * ever hold. It must be rejected on sight, without buffering toward it. */
    uint8_t liar[8] = { 'L', 'K', 0xFF, 0xFF, T_REQUEST, 0, 0, 0 };
    raw_send(liar, sizeof(liar));
    expect_silence("a length field claiming 65535 bytes");

    /* And a zero length, which is not a frame either. */
    uint8_t empty[6] = { 'L', 'K', 0x00, 0x00, 'x', 'y' };
    raw_send(empty, sizeof(empty));
    expect_silence("a zero-length frame");

    /* After all of that the device is still able to find a real frame — the
     * resynchronisation is the whole reason for the sync marker. */
    send_plain(payload, len);
    CHECK(next_frame().present, "the device never resynchronised");

    /* Console noise ahead of a frame, which is what actually arrives on this
     * port in production. */
    drop_pending();
    raw_send((const uint8_t *)"I (1234) wifi: some log line\n", 29);
    send_plain(payload, len);
    CHECK(next_frame().present, "log output ahead of a frame lost the frame");

    /* More bytes than the receive buffer, all at once. The device must drop
     * them rather than grow, and must recover afterwards. */
    drop_pending();
    static uint8_t flood[2048];
    memset(flood, 0x41, sizeof(flood));
    raw_send(flood, sizeof(flood));
    send_plain(payload, len);
    CHECK(next_frame().present, "the device did not recover from a flood");

    /* CBOR outside the supported subset. A float, an indefinite-length map,
     * and a 64-bit argument: each is a grammar the device deliberately does
     * not implement, and each must be a refusal rather than a guess. */
    static const uint8_t a_float[] = { 0xfb, 0x40, 0x09, 0x21, 0xfb, 0x54, 0x44, 0x2d, 0x18 };
    send_plain(a_float, sizeof(a_float));
    expect_error(T_ERROR, E_MALFORMED, "an IEEE double");

    static const uint8_t indefinite[] = { 0xbf, 0x66, 'm','e','t','h','o','d',
                                          0x64, 'p','i','n','g', 0xff };
    send_plain(indefinite, sizeof(indefinite));
    expect_error(T_ERROR, E_MALFORMED, "an indefinite-length map");

    static const uint8_t huge_arg[] = { 0xa1, 0x66, 'm','e','t','h','o','d',
                                        0x1b, 0,0,0,0,0,0,0,1 };
    send_plain(huge_arg, sizeof(huge_arg));
    expect_error(T_ERROR, E_MALFORMED, "a 64-bit argument");

    /* A frame carrying nothing but its type byte. */
    send_frame(T_REQUEST, NULL, 0);
    expect_error(T_ERROR, E_MALFORMED, "an empty payload");

    /* A method name longer than the device's buffer must not be truncated
     * into a shorter one that happens to be real. */
    CborWriter w;
    uint8_t long_method[128];
    cbor_writer_init(&w, long_method, sizeof(long_method));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "pingpingpingpingpingpingpingpingpingpingping");
    send_plain(long_method, w.length);
    expect_error(T_ERROR, E_MALFORMED, "an overlong method name");

    /* An unknown frame type is not a frame this device speaks. */
    send_frame(0x42, payload, len);
    expect_error(T_ERROR, E_MALFORMED, "an unknown frame type");

    /* An encrypted frame with no session behind it. */
    static const uint8_t junk[32] = { 0 };
    send_frame(T_ENC_REQUEST, junk, sizeof(junk));
    expect_error(T_ERROR, E_SESSION, "an encrypted frame with no session");
}

static void test_tampered_frame_tears_down_the_session(void)
{
    printf("== a forged tag ends the session rather than dropping one frame\n");
    fresh_device();
    device_unlocked();
    confirmed_session(18);

    uint8_t payload[64];
    size_t len = req(payload, sizeof(payload), "ping");

    uint8_t buf[128];
    memcpy(buf, payload, len);
    size_t sealed = host_seal(buf, len);
    buf[0] ^= 0x01;
    send_frame(T_ENC_REQUEST, buf, sealed);

    expect_error(T_ERROR, E_SESSION, "a tampered frame");
    CHECK(session_state() == SESSION_IDLE,
          "a failed tag left the session standing (state %d)", session_state());
}

int main(void)
{
    test_plaintext_ping_and_features();
    test_status_is_public_but_thin();
    test_keys_need_a_session_and_a_passkey();
    test_locked_device_refuses_keys();
    test_address_derivation_reads_the_path();
    test_undecodable_calldata_refused_before_confirmation();
    test_signing_signs_what_it_showed();
    test_rejection_and_timeout();
    test_errors_stay_encrypted_once_a_session_exists();
    test_malformed_input();
    test_tampered_frame_tears_down_the_session();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
