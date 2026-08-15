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
#include "blind-signing.h"
#include "fake_usb.h"
#include "fake_wallet.h"
#include "leek-wallet.h"
#include "pin.h"
#include "ble.h"
#include "ble-chunk.h"
#include "ble-name.h"
#include "nvs.h"
#include "protocol.h"
#include "transport.h"
#include "session.h"
#include "ui.h"

#include "chacha20poly1305/rfc7539.h"
#include "sha3.h"

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
#define E_NO_WALLET    0x0300
#define E_SESSION      0x0400
#define E_BUSY         0x0401

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

static int  message_prompts;       /* ui_request_sign_message calls */
static char shown_message[256];
static size_t shown_message_len;
static int  passphrase_prompts;    /* ui_request_passphrase_confirm calls */
static char shown_passphrase_address[64];

/* What the device's own screens are browsing. A variable rather than a constant
 * so a test can move it the way a button press does, and check getStatus
 * reports it -- the field exists precisely so the host can follow a change the
 * user made on the device without telling the app. */
static uint32_t stub_hd_account;

uint32_t ui_hd_account(void)          { return stub_hd_account; }

void ui_request_session_confirm(void) { session_confirm_prompts++; }
void ui_request_unlock(void)          { unlock_prompts++; }
void ui_request_lock(void)            { lock_requests++; }

/* The path the device said it would sign at. Recorded whole, because the
 * account level is the half of it a host can move without the index changing
 * (T45) - "shown_index == 0" was true of two different wallets. */
static HDPath shown_path;

void ui_request_sign(const EthTx *tx, const HDPath *path, const char *from)
{
    confirm_requests++;
    shown_tx = *tx;
    shown_path = *path;
    shown_index = path->address_index;
    snprintf(shown_from, sizeof(shown_from), "%s", from ? from : "");
}

void ui_request_sign_message(const char *message, size_t length,
                             const HDPath *path, const char *from)
{
    message_prompts++;
    shown_message_len = length < sizeof(shown_message) - 1 ? length
                                                          : sizeof(shown_message) - 1;
    memcpy(shown_message, message, shown_message_len);
    shown_message[shown_message_len] = '\0';
    shown_path = *path;
    shown_index = path->address_index;
    snprintf(shown_from, sizeof(shown_from), "%s", from ? from : "");
}

/* Typed data. The rendering itself is eip712.c's business and is checked
 * against the EIP's vectors in test_eip712.c; what matters at this tier is that
 * the device asked at all, what digest it says it will sign, and whether it
 * admitted to being blind. */
static int          typed_prompts;
static uint8_t      shown_typed_digest[32];
static bool         shown_typed_blind;
static Eip712Render shown_typed;

void ui_request_sign_typed_data(const Eip712Render *render,
                                const uint8_t digest[32], bool blind,
                                const HDPath *path, const char *from)
{
    typed_prompts++;
    shown_typed = *render;
    memcpy(shown_typed_digest, digest, sizeof(shown_typed_digest));
    shown_typed_blind = blind;
    shown_path = *path;
    shown_index = path->address_index;
    snprintf(shown_from, sizeof(shown_from), "%s", from ? from : "");
}

void ui_request_passphrase_confirm(const char *address)
{
    passphrase_prompts++;
    snprintf(shown_passphrase_address, sizeof(shown_passphrase_address), "%s",
             address ? address : "");
}

SignOutcome ui_sign_outcome(void) { return scripted_outcome; }

/* What the device told the screen about the signature it produced. -1 means
 * it said nothing, which is the bug this records: an approval that silently
 * drops back to the address list is indistinguishable from a press that never
 * registered. Reported on hardware over BLE. */
static int sign_reports;
static int last_sign_report = -1;

void ui_sign_report(bool ok)
{
    sign_reports++;
    last_sign_report = ok ? 1 : 0;
}
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

/* Collect whatever the device has written, without sending anything. Needed
 * for the few paths that emit a frame without a request arriving first. */
static void collect_output(void)
{
    stash_len += fake_usb_device_read(stash + stash_len, sizeof(stash) - stash_len);
}

/** Frame a payload the way the device expects and hand it over. */
static void send_frame(uint8_t type, const uint8_t *payload, size_t len)
{
    uint8_t frame[PROTOCOL_MAX_FRAME + 8];
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
    /* Sized to the device's own limit rather than to today's longest request:
     * signTypedData carries its type definitions and is several times the size
     * of anything else here, and a harness buffer that quietly overflowed
     * would look exactly like a firmware bug. */
    uint8_t buf[PROTOCOL_MAX_FRAME];
    memcpy(buf, payload, len);
    send_frame(T_ENC_REQUEST, buf, host_seal(buf, len));
}

typedef struct {
    bool    present;
    uint8_t type;
    uint8_t payload[PROTOCOL_MAX_FRAME];
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
    /* The wipe of simulated flash took the blind-signing flag with it; the
     * cached copy has to go too, or a test that enabled it would leak the
     * weaker mode into the next one. This is the same call the wipe screen
     * makes on hardware. */
    blind_signing_forget();
    pin__reset_static_state_for_test();
    pin_init();
    fake_wallet_reset();
    session_reset();
    protocol__reset_for_test();
    /* On hardware transport_init() always runs before the endpoint serves, and
     * it is what turns receive on. The suite has no transport layer, so it
     * stands in for that call -- without it every test would be exercising a
     * device that has not yet chosen a transport and answers nothing. */
    protocol_set_rx_enabled(true);

    stub_hd_account = 0;
    stash_len = 0;
    host_tx = host_rx = 0;
    session_up = false;
    confirm_requests = unlock_prompts = lock_requests = session_confirm_prompts = 0;
    sign_reports = 0;
    last_sign_report = -1;
    message_prompts = passphrase_prompts = typed_prompts = 0;
    shown_typed_blind = false;
    memset(&shown_typed, 0, sizeof(shown_typed));
    memset(shown_typed_digest, 0, sizeof(shown_typed_digest));
    memset(shown_message, 0, sizeof(shown_message));
    shown_message_len = 0;
    memset(shown_passphrase_address, 0, sizeof(shown_passphrase_address));
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

/* Boot order. protocol_start() used to run before transport_init(), so for a
 * few milliseconds the USB endpoint answered anything -- on a BLE device too --
 * and transport_apply() reset the receive state of a task already parsing a
 * frame. A host that opens the port without resetting the board lands in that
 * window; the device panicked in the USB-Serial-JTAG ISR on the third request.
 * The endpoint must answer nothing until a transport has been chosen. */
static void test_nothing_is_answered_before_a_transport_is_chosen(void)
{
    printf("== the endpoint is silent until a transport is selected\n");

    /* Checked before any fixture runs: fresh_device() stands in for
     * transport_init() and turns receive on, so after it the boot default is no
     * longer observable. This assertion is the only place it is. */
    CHECK(!protocol_rx_enabled(),
          "receive is on before transport_init() has chosen a transport");

    fresh_device();
    protocol_set_rx_enabled(false);     /* the pre-transport_init() state */

    uint8_t payload[64];
    for (const char *const *m = (const char *[]){"ping", "getFeatures", "getStatus", NULL};
         *m; m++) {
        send_plain(payload, req(payload, sizeof(payload), *m));
        Frame f = next_frame();
        CHECK(!f.present, "%s was answered before a transport was chosen", *m);
    }

    /* And once transport_apply() has run, the same frames are served. */
    protocol_set_rx_enabled(true);
    send_plain(payload, req(payload, sizeof(payload), "ping"));
    Frame f = next_frame();
    CHECK(f.present && f.type == T_RESPONSE,
          "ping went unanswered after a transport was selected");
}

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

/* A signTransaction request whose calldata nothing decodes. `to` present, so
 * the only thing standing between it and the screen is the setting. */
static size_t undecodable_request(uint8_t *payload, size_t cap,
                                  const uint8_t to[20],
                                  const uint8_t *data, size_t data_len)
{
    CborWriter w;
    cbor_writer_init(&w, payload, cap);
    cbor_write_map(&w, 5);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, 0);
    cbor_write_text(&w, "to");
    cbor_write_bytes(&w, to, 20);
    cbor_write_text(&w, "data");
    cbor_write_bytes(&w, data, data_len);
    return cbor_writer_ok(&w) ? w.length : 0;
}

/* getFeatures over whatever channel is live. Asked inside a session it must
 * go encrypted like everything else, or the two sides desync and every later
 * assertion in the test is about the wrong frame. */
static uint32_t features_blind_signing(void)
{
    uint8_t payload[64];
    size_t len = req(payload, sizeof(payload), "getFeatures");
    Frame f;
    if (session_up) {
        send_encrypted(payload, len);
        f = next_reply();
    } else {
        send_plain(payload, len);
        f = next_frame();
    }
    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len) &&
        cbor_map_find(body, body_len, "blindSigning", &it) && it.type == CBOR_UINT) {
        return (uint32_t)it.value;
    }
    return 0xFFFFFFFFu;   /* "no answer" must not read as "off" */
}

/* The escape hatch (T16): what it opens, and everything it does not. */
static void test_blind_signing_is_off_until_the_device_says_otherwise(void)
{
    printf("== blind signing is off by default, on-device only, and narrow\n");
    fresh_device();
    device_unlocked();
    confirmed_session(40);

    uint8_t to[20];
    memset(to, 0xC0, sizeof(to));
    uint8_t data[36] = { 0xde, 0xad, 0xbe, 0xef };
    uint8_t payload[512];
    size_t len;

    CHECK(features_blind_signing() == 0,
          "a fresh device does not report blind signing off");

    /* There is no command for this. If one is ever added, this is where it
     * will start failing: the setting must be unchanged by anything the host
     * can send, including a request that names it. */
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "setBlindSigning");
    cbor_write_text(&w, "enabled");
    cbor_write_uint(&w, 1);
    send_encrypted(payload, w.length);
    (void)next_reply();     /* an unknown method; the answer does not matter */
    CHECK(features_blind_signing() == 0,
          "a host request changed the blind-signing setting");

    /* Off: refused before the screen. This is the assertion the whole design
     * rests on, restated here so the hatch cannot quietly remove it. */
    len = undecodable_request(payload, sizeof(payload), to, data, sizeof(data));
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_UNDECODABLE, "undecodable call, setting off");
    CHECK(confirm_requests == 0, "an undecodable call reached the screen while off");

    /* On, as the device's own settings screen would do it. */
    CHECK(blind_signing_set(true), "could not enable blind signing");
    CHECK(features_blind_signing() == 1,
          "getFeatures hides that the device is in the weaker mode");

    /* Now it reaches the confirmation, and can be approved. */
    scripted_outcome = SIGN_APPROVED;
    len = undecodable_request(payload, sizeof(payload), to, data, sizeof(data));
    send_encrypted(payload, len);
    CHECK(confirm_requests == 1, "the hatch did not put the call on screen");

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "the signature was not returned");
    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        /* Blind about the meaning, never about the bytes: the signature is
         * still over the transaction the device parsed and showed, calldata
         * included. */
        CHECK(shown_tx.data_length == sizeof(data) &&
              memcmp(shown_tx.data, data, sizeof(data)) == 0,
              "the screen was shown different calldata than was sent");
        uint8_t expect_digest[32];
        CHECK(eth_tx_hash(&shown_tx, expect_digest), "could not re-hash what was shown");
        CHECK(cbor_map_find(body, body_len, "r", &it) && it.type == CBOR_BYTES &&
              it.value == 32 && memcmp(it.data, expect_digest, 32) == 0,
              "the blind signature is not over what was displayed");
    }

    /* And can be refused, which must still be the cheap outcome. */
    confirm_requests = 0;
    scripted_outcome = SIGN_REJECTED;
    len = undecodable_request(payload, sizeof(payload), to, data, sizeof(data));
    send_encrypted(payload, len);
    CHECK(confirm_requests == 1, "the rejected call never reached the screen");
    expect_error(T_ENC_ERROR, E_REJECTED, "blind call rejected on device");

    scripted_outcome = SIGN_APPROVED;

    /* --- what the hatch deliberately does NOT open --- */

    /* Contract creation. No recipient to name, so a blind confirmation would
     * have nothing true left on it. */
    confirm_requests = 0;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "data");
    cbor_write_bytes(&w, data, sizeof(data));
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_UNDECODABLE, "contract creation with the hatch open");
    CHECK(confirm_requests == 0, "the hatch let contract creation through");

    /* Oversized calldata. Refused for a different reason again: the device
     * never held those bytes, so it could not hash what it signed. */
    uint8_t huge[300] = { 0xde, 0xad, 0xbe, 0xef };   /* ETH_MAX_DATA is 256 */
    len = undecodable_request(payload, sizeof(payload), to, huge, sizeof(huge));
    CHECK(len > 0, "the oversized request did not fit the buffer");
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_MALFORMED, "oversized calldata with the hatch open");
    CHECK(confirm_requests == 0, "the hatch let oversized calldata through");

    /* A message the screen cannot render. Blind signing is about calldata; a
     * confirmation showing mangled text carries no information at all. */
    message_prompts = 0;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signMessage");
    cbor_write_text(&w, "message");
    cbor_write_text(&w, "hello\x01world");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_UNDECODABLE, "unrenderable message with the hatch open");
    CHECK(message_prompts == 0, "the hatch let an unrenderable message through");

    /* Off again, on the device, and the refusal is back with no reboot. */
    CHECK(blind_signing_set(false), "could not disable blind signing");
    CHECK(features_blind_signing() == 0, "getFeatures still reports blind signing on");
    confirm_requests = 0;
    len = undecodable_request(payload, sizeof(payload), to, data, sizeof(data));
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_UNDECODABLE, "undecodable call after turning it back off");
    CHECK(confirm_requests == 0, "turning the setting off did not take effect");

    /* Persistence: the setting survives a reboot, because a device that
     * forgets it is on would silently re-protect - and one that forgets it is
     * off would silently stay weak. */
    CHECK(blind_signing_set(true), "could not re-enable");
    fake_nvs_reboot();
    blind_signing_forget();
    CHECK(blind_signing_enabled(), "blind signing did not survive a reboot");
    CHECK(blind_signing_set(false), "could not disable after the reboot");

    /* A stored byte this firmware never wrote - corruption, or an older or
     * newer build's encoding. Only an exact 1 may turn the protection off;
     * anything else has to read as protected, because the safe reading of a
     * damaged security flag is the safe setting. */
    nvs_handle_t nvs;
    CHECK(nvs_open("leek_ui", NVS_READWRITE, &nvs) == ESP_OK,
          "could not open settings to plant a corrupt flag");
    nvs_set_u8(nvs, "blindsig", 2);
    nvs_commit(nvs);
    nvs_close(nvs);
    blind_signing_forget();
    CHECK(!blind_signing_enabled(),
          "a stored byte of 2 was read as blind signing enabled");
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

        /* And the user is told. Dropping straight back to the address list
         * after an approval reads as a press that never registered - observed
         * on hardware, over BLE, where there is no cable to check against. */
        CHECK(sign_reports == 1, "the screen was told %d times, expected once", sign_reports);
        CHECK(last_sign_report == 1, "the screen was not told the signature succeeded");
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

/* ------------------------------------------------- EIP-191 personal_sign */

/**
 * The prefixed digest, spelled out here rather than called out of eth-tx.c.
 *
 * The whole risk in personal_sign is the preimage: a wrong prefix or a wrong
 * decimal length produces a valid signature over something the user never
 * agreed to, and nothing downstream notices. A test that asked the device's own
 * hasher what the answer was would agree with any prefix at all.
 */
static void personal_digest(const char *message, uint8_t out[32])
{
    char prefix[64];
    int n = snprintf(prefix, sizeof(prefix),
                     "\x19" "Ethereum Signed Message:\n%zu", strlen(message));

    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    sha3_Update(&ctx, (const uint8_t *)prefix, (size_t)n);
    sha3_Update(&ctx, (const uint8_t *)message, strlen(message));
    keccak_Final(&ctx, out);
}

/** { "method": ..., "message": ..., "index": ... } */
static size_t sign_message_request(uint8_t *buf, size_t cap,
                                   const char *message, uint32_t index)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signMessage");
    cbor_write_text(&w, "message");
    cbor_write_text(&w, message);
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, index);
    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_sign_message_signs_what_it_showed(void)
{
    printf("== signMessage hashes the EIP-191 preimage of the text it displayed\n");
    fresh_device();
    device_unlocked();
    confirmed_session(20);

    /* The keccak the helper above uses is the same primitive the address
     * checksum depends on, so pin it against the one vector everyone knows
     * before trusting it to judge a prefix. */
    static const uint8_t KECCAK_EMPTY[32] = {
        0xc5,0xd2,0x46,0x01,0x86,0xf7,0x23,0x3c, 0x92,0x7e,0x7d,0xb2,0xdc,0xc7,0x03,0xc0,
        0xe5,0x00,0xb6,0x53,0xca,0x82,0x27,0x3b, 0x7b,0xfa,0xd8,0x04,0x5d,0x85,0xa4,0x70,
    };
    uint8_t empty[32];
    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    keccak_Final(&ctx, empty);
    CHECK(memcmp(empty, KECCAK_EMPTY, 32) == 0,
          "the test's own keccak is wrong; nothing below means anything");

    const char *message = "Sign in to LeekWallet";

    uint8_t payload[256];
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, sign_message_request(payload, sizeof(payload), message, 2));

    CHECK(message_prompts == 1, "the message was signed without a prompt");
    CHECK(shown_index == 2, "the screen named index %u, not 2", shown_index);
    CHECK(strlen(shown_from) == 42,
          "the screen was not given a full source address: '%s'", shown_from);
    CHECK(shown_message_len == strlen(message) &&
          memcmp(shown_message, message, shown_message_len) == 0,
          "the screen was shown something other than the message: '%s'", shown_message);

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "the signature was not returned");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    uint8_t first[32];
    memset(first, 0, sizeof(first));

    if (f.present && result_body(&f, &body, &body_len)) {
        /* The fake wallet returns the digest as r, so this compares the bytes
         * signed against the prefixed hash of the bytes displayed. */
        uint8_t want[32];
        personal_digest(shown_message, want);

        CHECK(cbor_map_find(body, body_len, "r", &it) && it.type == CBOR_BYTES &&
              it.value == 32 && memcmp(it.data, want, 32) == 0,
              "the signature is not over the EIP-191 digest of what was shown");
        if (cbor_map_find(body, body_len, "r", &it) && it.type == CBOR_BYTES &&
            it.value == 32) {
            memcpy(first, it.data, 32);
        }

        /* And specifically that the prefix is there at all: signing the bare
         * keccak of the message would be a working signature over a preimage
         * an attacker can choose to look like a transaction. */
        uint8_t unprefixed[32];
        keccak_256_Init(&ctx);
        sha3_Update(&ctx, (const uint8_t *)message, strlen(message));
        keccak_Final(&ctx, unprefixed);
        CHECK(memcmp(first, unprefixed, 32) != 0,
              "signMessage hashed the message without the EIP-191 prefix");

        CHECK(cbor_map_find(body, body_len, "yParity", &it) &&
              it.type == CBOR_UINT && it.value <= 1,
              "yParity is %u - that is the legacy v", it.value);
        CHECK(cbor_map_find(body, body_len, "index", &it) &&
              it.type == CBOR_UINT && it.value == 2,
              "the reply names a different index than was signed");
    }

    /* The decimal length is a byte count with no padding, so a message one byte
     * longer must hash under a different prefix as well as different content. */
    send_encrypted(payload,
                   sign_message_request(payload, sizeof(payload),
                                        "Sign in to LeekWallet!", 2));
    f = next_reply();
    if (f.present && result_body(&f, &body, &body_len) &&
        cbor_map_find(body, body_len, "r", &it) && it.type == CBOR_BYTES &&
        it.value == 32) {
        uint8_t want2[32];
        personal_digest("Sign in to LeekWallet!", want2);
        CHECK(memcmp(it.data, want2, 32) == 0,
              "a 22-byte message did not hash under its own length prefix");
        CHECK(memcmp(it.data, first, 32) != 0, "two messages hashed the same");
    } else {
        CHECK(false, "the second message was not signed");
    }
}

static void test_sign_message_refuses_what_it_cannot_show(void)
{
    printf("== signMessage refuses tiers, junk and anything it cannot render\n");
    fresh_device();
    device_has_a_wallet();          /* wallet present, PIN not entered */

    uint8_t payload[512];
    size_t len = sign_message_request(payload, sizeof(payload), "hi", 0);

    /* No session at all. */
    send_plain(payload, len);
    expect_error(T_ERROR, E_SESSION, "signMessage before any handshake");
    CHECK(message_prompts == 0, "a session-less request reached the screen");

    confirmed_session(21);

    /* Session, but locked: the keys tier is not open. */
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "signMessage while locked");
    CHECK(message_prompts == 0, "a locked device put a message on screen");

    pin_set("123456");
    pin_verify("123456");
    CHECK(pin_is_unlocked(), "the fixture did not unlock the device");

    CborWriter w;

    /* No message field at all. */
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signMessage");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "signMessage with no message");

    /* A byte string where text was specified. Guessing that bytes are UTF-8 is
     * how one message acquires two spellings and the device stops knowing which
     * one it displayed. */
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signMessage");
    cbor_write_text(&w, "message");
    cbor_write_bytes(&w, (const uint8_t *)"hi", 2);
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "a message sent as bytes");

    /* Longer than the screen can hold. Truncating would sign more than it
     * showed, which is the failure this whole file is about. */
    char long_message[200];
    memset(long_message, 'A', sizeof(long_message) - 1);
    long_message[sizeof(long_message) - 1] = '\0';
    send_encrypted(payload,
                   sign_message_request(payload, sizeof(payload), long_message, 0));
    expect_error(T_ENC_ERROR, E_MALFORMED, "a message longer than the display");
    CHECK(message_prompts == 0, "an oversized message reached the screen");

    /* Exactly at the bound is fine, one over is not. */
    char at_limit[121];
    memset(at_limit, 'B', 120);
    at_limit[120] = '\0';
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, sign_message_request(payload, sizeof(payload), at_limit, 0));
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "a 120-byte message was refused");
    CHECK(message_prompts == 1, "the 120-byte message was not confirmed");
    CHECK(shown_message_len == 120, "the screen was shown %zu of 120 bytes",
          shown_message_len);

    char over_limit[122];
    memset(over_limit, 'B', 121);
    over_limit[121] = '\0';
    send_encrypted(payload, sign_message_request(payload, sizeof(payload), over_limit, 0));
    expect_error(T_ENC_ERROR, E_MALFORMED, "a 121-byte message");

    /* Not renderable on a 128x64 OLED, so not signable: a control byte, a
     * newline, a non-ASCII byte and a tab. Showing a mangled version of a
     * message while signing the real one is blind signing in a costume (6bis),
     * so each is 0x0202 - the device cannot say what this is. */
    message_prompts = 0;
    static const char *unrenderable[] = {
        "hello\x01world",
        "line one\nline two",
        "caf\xc3\xa9",
        "tab\there",
    };
    for (size_t i = 0; i < sizeof(unrenderable) / sizeof(unrenderable[0]); i++) {
        send_encrypted(payload,
                       sign_message_request(payload, sizeof(payload),
                                            unrenderable[i], 0));
        expect_error(T_ENC_ERROR, E_UNDECODABLE, "an unrenderable message");
    }
    CHECK(message_prompts == 0,
          "the device asked for approval of a message it could not render");

    /* An index beyond the non-hardened range is a parse failure, not an
     * address. */
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signMessage");
    cbor_write_text(&w, "message");
    cbor_write_text(&w, "hi");
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, 0x80000000u);
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "an index above 0x7FFFFFFF");
    CHECK(message_prompts == 0, "an out-of-range index reached the screen");

    /* And the two ways a user ends a request. */
    len = sign_message_request(payload, sizeof(payload), "hi", 0);
    scripted_outcome = SIGN_REJECTED;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_REJECTED, "the user refused the message");

    scripted_outcome = SIGN_PENDING;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_TIMEOUT, "nobody answered the message prompt");
}

/* ----------------------------------------------------------- selectWallet */

static size_t select_wallet_request(uint8_t *buf, size_t cap, uint64_t index)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "selectWallet");
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, index);
    return cbor_writer_ok(&w) ? w.length : 0;
}

static bool address_of_index_zero(char *out, size_t out_size)
{
    uint8_t payload[96];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "getAddress");
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, 0);
    send_encrypted(payload, w.length);

    Frame f = next_reply();
    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (!f.present || !result_body(&f, &body, &body_len)) return false;
    if (!cbor_map_find(body, body_len, "address", &it) || it.type != CBOR_TEXT) {
        return false;
    }
    return cbor_text_copy(&it, out, out_size);
}

/* ------------------------------------------------------- signTypedData */

/* An ERC-2612 Permit against USDC. The digest this hashes to is pinned in
 * test_eip712.c against viem; here the question is only what the command does
 * with it, so the value is a parameter and the rest is fixed.
 *
 * `field_type` is a parameter for one reason: swapping "uint256" for
 * "uint256[]" turns a document the device can hash into one it cannot, without
 * changing anything else about the request. */
static size_t permit_request(uint8_t *buf, size_t cap, const uint8_t value[32],
                             const char *field_type, uint32_t index)
{
    static const uint8_t USDC[20] = {
        0xa0,0xb8,0x69,0x91,0xc6,0x21,0x8b,0x36,0xc1,0xd1,
        0x9d,0x4a,0x2e,0x9e,0xb0,0xce,0x36,0x06,0xeb,0x48
    };
    static const uint8_t OWNER[20] = {
        0x5b,0x38,0xda,0x6a,0x70,0x1c,0x56,0x85,0x45,0xdc,
        0xfc,0xb0,0x3f,0xcb,0x87,0x5f,0x56,0xbe,0xdd,0xc4
    };
    static const uint8_t SPENDER[20] = {
        0x11,0x11,0x11,0x12,0x54,0xee,0xb2,0x54,0x77,0xb6,
        0x8f,0xb8,0x5e,0xd9,0x29,0xf7,0x3a,0x96,0x05,0x82
    };

    CborWriter w;
    cbor_writer_init(&w, buf, cap);
    cbor_write_map(&w, 6);

    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTypedData");

    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "EIP712Domain");
    cbor_write_array(&w, 4);
    static const char *dom_names[] = {"name", "version", "chainId", "verifyingContract"};
    static const char *dom_types[] = {"string", "string", "uint256", "address"};
    for (int i = 0; i < 4; i++) {
        cbor_write_map(&w, 2);
        cbor_write_text(&w, "name");
        cbor_write_text(&w, dom_names[i]);
        cbor_write_text(&w, "type");
        cbor_write_text(&w, dom_types[i]);
    }
    cbor_write_text(&w, "Permit");
    cbor_write_array(&w, 5);
    static const char *p_names[] = {"owner", "spender", "value", "nonce", "deadline"};
    for (int i = 0; i < 5; i++) {
        cbor_write_map(&w, 2);
        cbor_write_text(&w, "name");
        cbor_write_text(&w, p_names[i]);
        cbor_write_text(&w, "type");
        cbor_write_text(&w, i < 2 ? "address" : (i == 2 ? field_type : "uint256"));
    }

    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Permit");

    cbor_write_text(&w, "domain");
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "USD Coin");
    cbor_write_text(&w, "version");
    cbor_write_text(&w, "2");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "verifyingContract");
    cbor_write_bytes(&w, USDC, 20);

    cbor_write_text(&w, "message");
    cbor_write_map(&w, 5);
    cbor_write_text(&w, "owner");
    cbor_write_bytes(&w, OWNER, 20);
    cbor_write_text(&w, "spender");
    cbor_write_bytes(&w, SPENDER, 20);
    cbor_write_text(&w, "value");
    cbor_write_bytes(&w, value, 32);
    cbor_write_text(&w, "nonce");
    cbor_write_uint(&w, 0);
    cbor_write_text(&w, "deadline");
    cbor_write_uint(&w, 1893456000u);

    cbor_write_text(&w, "index");
    cbor_write_uint(&w, index);

    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_sign_typed_data_signs_what_it_showed(void)
{
    printf("== signTypedData shows the domain and the fields, then signs that digest\n");
    fresh_device();
    device_unlocked();
    confirmed_session(30);

    uint8_t max[32];
    memset(max, 0xff, sizeof(max));

    uint8_t payload[2048];
    size_t  len = permit_request(payload, sizeof(payload), max, "uint256", 3);
    CHECK(len > 0, "the permit request did not fit");

    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, len);
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "a well-formed Permit was refused");
    CHECK(typed_prompts == 1, "the Permit was signed without a confirmation");
    CHECK(!shown_typed_blind, "a renderable Permit was shown as blind");

    /* The digest test_eip712.c pins against viem. Checked again here because
     * this is the path where a signature actually comes out: a command that
     * hashed correctly and then signed something else would pass every test in
     * that file. */
    static const uint8_t WANT[32] = {
        0x42,0x3a,0x95,0x8e,0xc7,0x2d,0xaf,0x49, 0x6f,0xde,0x79,0xb1,0x2e,0x29,0x2d,0xd6,
        0xed,0xe3,0x71,0xac,0x07,0x07,0xc0,0xcc, 0x84,0x8d,0xfe,0x6d,0x7d,0x45,0xd1,0x11,
    };
    CHECK(memcmp(shown_typed_digest, WANT, 32) == 0,
          "the device signed a digest other than the Permit's");

    /* The screen was given the fields, not a summary of them - and the
     * infinite allowance is named rather than printed. */
    CHECK(shown_typed.field_count == 5, "the screen got %d fields",
          shown_typed.field_count);
    CHECK(shown_typed.fields[2].unlimited,
          "an infinite Permit reached the screen as an ordinary number");
    CHECK(shown_typed.fields[4].is_deadline, "the deadline was not flagged");
    CHECK(shown_typed.has_verifying_contract,
          "the screen was not told which contract honours this");

    /* Same reply shape as the other two signing commands, and the index the
     * request asked for. */
    CborItem it;
    CHECK(cbor_map_find(f.payload, f.len, "result", &it), "no result map");
    /* The signature rides in the result map; what matters here is that the
     * path the screen saw is the path the request named. */
    CHECK(shown_path.address_index == 3, "signed at index %u, asked for 3",
          (unsigned)shown_path.address_index);
}

static void test_sign_typed_data_refuses_what_it_cannot_show(void)
{
    printf("== signTypedData refuses tiers, arrays, and structures it cannot render\n");
    fresh_device();
    device_has_a_wallet();

    uint8_t value[32];
    memset(value, 0, sizeof(value));
    value[31] = 1;

    uint8_t payload[2048];
    size_t  len = permit_request(payload, sizeof(payload), value, "uint256", 0);

    send_plain(payload, len);
    expect_error(T_ERROR, E_SESSION, "signTypedData before any handshake");
    CHECK(typed_prompts == 0, "a session-less request reached the screen");

    confirmed_session(31);
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "signTypedData while locked");
    CHECK(typed_prompts == 0, "a locked device put typed data on screen");

    pin_set("123456");
    pin_verify("123456");

    /* Nothing typed-data-shaped in the request at all. A protocol error, not a
     * policy one, and it must not read as a refusal to display. */
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTypedData");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "signTypedData with no structure");

    /* An array field. The device can neither hash nor show it, and this is the
     * refusal blind signing does NOT reopen - checked below. */
    len = permit_request(payload, sizeof(payload), value, "uint256[]", 0);
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_UNDECODABLE, "a typed-data array");
    CHECK(typed_prompts == 0, "an array structure reached the screen");

    CHECK(blind_signing_set(true), "could not enable blind signing");
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_UNDECODABLE,
                 "an array structure with blind signing on");
    CHECK(typed_prompts == 0,
          "blind signing reopened a document the device cannot hash");
    CHECK(blind_signing_set(false), "could not disable blind signing");
}

static void test_unrenderable_typed_data_is_the_blind_case(void)
{
    printf("== an unshowable structure is refused by default and blind-signable after\n");
    fresh_device();
    device_unlocked();
    confirmed_session(32);

    /* A string with no glyphs on this screen. It hashes perfectly well, which
     * is exactly what separates it from the array above. */
    CborWriter w;
    uint8_t   payload[1024];
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 5);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTypedData");
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "EIP712Domain");
    cbor_write_array(&w, 1);
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "type");
    cbor_write_text(&w, "string");
    cbor_write_text(&w, "Note");
    cbor_write_array(&w, 1);
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "body");
    cbor_write_text(&w, "type");
    cbor_write_text(&w, "string");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Note");
    cbor_write_text(&w, "domain");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Notes");
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "body");
    cbor_write_text(&w, "approve \xf0\x9f\x92\xb8 now");
    size_t len = w.length;

    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_UNDECODABLE,
                 "a structure the screen cannot draw");
    CHECK(typed_prompts == 0, "an unrenderable structure reached the screen");

    /* With the hatch open it signs — but the screen is told it is blind, so it
     * can lead with the warning and the digest rather than a field list that
     * would read as complete. */
    CHECK(blind_signing_set(true), "could not enable blind signing");
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, len);
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE,
          "blind signing did not admit an unrenderable structure");
    CHECK(typed_prompts == 1, "it signed without asking");
    CHECK(shown_typed_blind, "the screen was not told the request was blind");
    CHECK(blind_signing_set(false), "could not disable blind signing");
}

static void test_select_wallet(void)
{
    printf("== selectWallet moves between stored seeds, and refuses the rest\n");
    fresh_device();
    device_has_a_wallet();

    uint8_t payload[96];
    size_t len = select_wallet_request(payload, sizeof(payload), 1);

    send_plain(payload, len);
    expect_error(T_ERROR, E_SESSION, "selectWallet before any handshake");

    confirmed_session(22);
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "selectWallet while locked");

    pin_set("123456");
    pin_verify("123456");
    fake_wallet_preload(
        "legal winner thank year wave sausage worth useful legal winner thank year "
        "wave sausage worth useful legal winner thank year wave sausage worth title");

    char before[64] = {0}, after[64] = {0};
    CHECK(address_of_index_zero(before, sizeof(before)), "no address before the switch");

    send_encrypted(payload, select_wallet_request(payload, sizeof(payload), 1));
    Frame f = next_reply();
    const uint8_t *body;
    size_t body_len;
    CborItem it;
    CHECK(f.present && f.type == T_ENC_RESPONSE, "selectWallet was not answered");
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "activeWallet", &it) &&
              it.type == CBOR_UINT && it.value == 1,
              "selectWallet did not report the wallet it selected");
    }

    CHECK(address_of_index_zero(after, sizeof(after)), "no address after the switch");
    /* The switch has to reach derivation, not merely a status field: a
     * selectWallet that updates a counter and leaves the keys alone is worse
     * than one that fails, because the screen would then name wallet 1 while
     * signing with wallet 2. */
    CHECK(strcmp(before, after) != 0,
          "selecting a different wallet derived the same address (%s)", after);

    /* Out of range, in every direction the host can reach for. 256 and 257 are
     * the ones worth naming: a uint8_t cast would turn them into 0 and 1, and 1
     * is a wallet that exists. */
    static const uint64_t bad[] = { 0, 3, 99, 255, 256, 257, 0xFFFFFFFFu };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        send_encrypted(payload, select_wallet_request(payload, sizeof(payload), bad[i]));
        expect_error(T_ENC_ERROR, E_NO_WALLET, "an out-of-range wallet index");
    }
    /* Whatever it refused, it must not have moved. */
    char still[64] = {0};
    CHECK(address_of_index_zero(still, sizeof(still)), "no address after the refusals");
    CHECK(strcmp(still, after) == 0,
          "a refused selectWallet changed the active wallet anyway");

    /* No index, and an index of the wrong type. */
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "selectWallet");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "selectWallet with no index");

    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "selectWallet");
    cbor_write_text(&w, "index");
    cbor_write_text(&w, "2");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "an index sent as text");

    /* A passphrase belongs to the seed it was entered against. Switching seeds
     * must drop it, or the user lands in a third wallet nobody named. */
    wallet_set_passphrase("hunter2", 7);
    CHECK(wallet_has_passphrase(), "the fixture did not apply a passphrase");
    send_encrypted(payload, select_wallet_request(payload, sizeof(payload), 2));
    (void)next_reply();
    CHECK(!wallet_has_passphrase(),
          "switching wallets carried the passphrase across");
}

/* ---------------------------------------------------------- setPassphrase */

static size_t set_passphrase_request(uint8_t *buf, size_t cap, const char *pass)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "setPassphrase");
    cbor_write_text(&w, "passphrase");
    cbor_write_text(&w, pass);
    return cbor_writer_ok(&w) ? w.length : 0;
}

/** Do these bytes appear anywhere in the reply? */
static bool contains(const uint8_t *hay, size_t hay_len, const char *needle)
{
    size_t n = strlen(needle);
    if (n > hay_len) return false;
    for (size_t i = 0; i + n <= hay_len; i++) {
        if (memcmp(hay + i, needle, n) == 0) return true;
    }
    return false;
}

static void test_set_passphrase(void)
{
    printf("== setPassphrase confirms a fingerprint, and a refusal is recoverable\n");
    fresh_device();
    device_has_a_wallet();

    uint8_t payload[256];
    size_t len = set_passphrase_request(payload, sizeof(payload), "hunter2");

    send_plain(payload, len);
    expect_error(T_ERROR, E_SESSION, "setPassphrase before any handshake");

    confirmed_session(23);
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_NOT_UNLOCKED, "setPassphrase while locked");
    CHECK(passphrase_prompts == 0, "a locked device asked to confirm a passphrase");
    CHECK(!wallet_has_passphrase(), "a locked device applied a passphrase");

    pin_set("123456");
    pin_verify("123456");

    /* The happy path. The address the device shows is the one it answers with:
     * a reply naming a different wallet than the screen did would make the
     * confirmation meaningless. */
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, len);

    CHECK(passphrase_prompts == 1, "the passphrase was applied without a prompt");
    CHECK(strlen(shown_passphrase_address) == 42,
          "the screen was given '%s', not a full address", shown_passphrase_address);
    CHECK(wallet_has_passphrase(), "an approved passphrase was not applied");

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "setPassphrase was not answered");

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    if (f.present && result_body(&f, &body, &body_len)) {
        CHECK(cbor_map_find(body, body_len, "address", &it) &&
              it.type == CBOR_TEXT && it.value == 42 &&
              memcmp(it.data, shown_passphrase_address, 42) == 0,
              "the reply names a different wallet than the screen did");
        CHECK(cbor_map_find(body, body_len, "passphrase", &it) &&
              it.type == CBOR_UINT && it.value == 1,
              "the reply does not report the passphrase as active");
        /* Never the passphrase itself, in any field. */
        CHECK(!contains(f.payload, f.len, "hunter2"),
              "the reply echoes the passphrase back");
    }

    /* A refusal has to be recoverable: the wrong wallet must not stay selected
     * just because the user said no. That is the entire reason the fingerprint
     * is shown before the passphrase is used for anything. */
    wallet_clear_passphrase();
    scripted_outcome = SIGN_REJECTED;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_REJECTED, "the user did not recognise the wallet");
    CHECK(!wallet_has_passphrase(),
          "a rejected passphrase stayed applied - the user is now in a wallet "
          "they refused");

    scripted_outcome = SIGN_PENDING;
    send_encrypted(payload, len);
    expect_error(T_ENC_ERROR, E_TIMEOUT, "nobody answered the fingerprint prompt");
    CHECK(!wallet_has_passphrase(), "an unanswered passphrase stayed applied");

    /* Malformed input is refused rather than guessed at, and nothing is applied
     * on the way to refusing it. */
    scripted_outcome = SIGN_APPROVED;
    passphrase_prompts = 0;

    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "setPassphrase");
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "setPassphrase with no passphrase");

    send_encrypted(payload, set_passphrase_request(payload, sizeof(payload), ""));
    expect_error(T_ENC_ERROR, E_MALFORMED, "an empty passphrase");

    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "setPassphrase");
    cbor_write_text(&w, "passphrase");
    cbor_write_bytes(&w, (const uint8_t *)"hunter2", 7);
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "a passphrase sent as bytes");

    /* Longer than the buffer, and outside what the device's own keyboard can
     * produce: a passphrase enterable only from the app is a wallet the user
     * cannot reach without the app. */
    char too_long[80];
    memset(too_long, 'x', sizeof(too_long) - 1);
    too_long[sizeof(too_long) - 1] = '\0';
    send_encrypted(payload, set_passphrase_request(payload, sizeof(payload), too_long));
    expect_error(T_ENC_ERROR, E_MALFORMED, "an over-long passphrase");

    send_encrypted(payload,
                   set_passphrase_request(payload, sizeof(payload), "bad\x01pass"));
    expect_error(T_ENC_ERROR, E_MALFORMED, "a passphrase with a control byte");

    CHECK(passphrase_prompts == 0, "a malformed passphrase reached the screen");
    CHECK(!wallet_has_passphrase(), "a malformed passphrase was applied anyway");
}


/* ==========================================================================
 * BLE transport (ROADMAP T25, T57)
 *
 * The point of these is not that chunking works — sim/test_ble_chunk.c covers
 * that layer on its own bytes. It is that the SAME dispatch answers over BLE:
 * same frames, same errors, no sync marker, and no second code path that could
 * quietly disagree with the cable. And that the two transports are never both
 * live, which is the property session.c's single nonce pair depends on.
 * ========================================================================== */

/* What the device notified, as chunks, exactly as a peer would see them. */
static uint8_t ble_chunks[64][BLE_CHUNK_MAX_FRAME + 1];
static size_t  ble_chunk_len[64];
static int     ble_chunk_count;
static uint16_t ble_mtu = 23;

static bool ble_capture(void *ctx, const uint8_t *chunk, size_t len)
{
    (void)ctx;
    if (ble_chunk_count >= 64) return false;
    memcpy(ble_chunks[ble_chunk_count], chunk, len);
    ble_chunk_len[ble_chunk_count] = len;
    ble_chunk_count++;
    return true;
}

/* Stands in for ble.c's notify path: the same ble_chunk_split call, at the same
 * negotiated MTU, into a buffer instead of a radio. */
static void ble_writer(const uint8_t *frame, size_t len)
{
    ble_chunk_split(frame, len, ble_mtu, ble_capture, NULL);
}

/* Send a request over BLE the way a host does: encode the frame with NO sync
 * marker, split it at the MTU, and deliver each chunk as its own GATT write. */
static void ble_send_frame(uint8_t type, const uint8_t *payload, size_t len)
{
    uint8_t frame[PROTOCOL_MAX_FRAME + 8];
    size_t body = len + 1;
    frame[0] = (uint8_t)(body >> 8);
    frame[1] = (uint8_t)body;
    frame[2] = type;
    if (len) memcpy(frame + 3, payload, len);

    static uint8_t wire[64][BLE_CHUNK_MAX_FRAME + 1];
    static size_t  wire_len[64];

    /* Chunked by the same function the device uses, because that is what the
     * TypeScript client does too — chunkForBle is one algorithm on both ends. */
    ble_chunk_count = 0;
    ble_chunk_split(frame, body + 2, ble_mtu, ble_capture, NULL);
    int n = ble_chunk_count;
    for (int i = 0; i < n; i++) {
        memcpy(wire[i], ble_chunks[i], ble_chunk_len[i]);
        wire_len[i] = ble_chunk_len[i];
    }
    ble_chunk_count = 0;

    static BleReassembler rx;
    ble_chunk_reset(&rx);
    for (int i = 0; i < n; i++) {
        BleChunkResult res = ble_chunk_push(&rx, wire[i], wire_len[i]);
        if (res == BLE_CHUNK_FRAME_READY) {
            protocol_handle_frame(rx.buf, rx.len);
            ble_chunk_reset(&rx);
        } else if (res == BLE_CHUNK_ERROR) {
            printf("  FAIL: the device refused its own chunking\n");
            failures++;
        }
    }
}

/** Reassemble whatever the device notified back into one frame, undecrypted. */
static Frame ble_next_frame(void)
{
    Frame f;
    memset(&f, 0, sizeof(f));

    BleReassembler rx;
    ble_chunk_reset(&rx);
    for (int i = 0; i < ble_chunk_count; i++) {
        if (ble_chunk_push(&rx, ble_chunks[i], ble_chunk_len[i]) == BLE_CHUNK_FRAME_READY) {
            f.present = true;
            f.type = rx.buf[2];
            f.len  = rx.len - 3;
            memcpy(f.payload, rx.buf + 3, f.len);
            break;
        }
    }
    ble_chunk_count = 0;
    return f;
}

/** The next notified frame, decrypted if it is one of the encrypted types. */
static Frame ble_next_reply(void)
{
    Frame f = ble_next_frame();
    if (f.present && (f.type == T_ENC_RESPONSE || f.type == T_ENC_ERROR)) {
        int n = host_open(f.payload, f.len);
        f.len = n < 0 ? 0 : (size_t)n;
    }
    return f;
}

static void ble_selected(void)
{
    fresh_device();
    ble_chunk_count = 0;
    transport_set(TRANSPORT_BLE);
    protocol_set_writer(ble_writer);
}

static void test_ble_carries_the_same_frames(void)
{
    printf("== BLE answers the same frames as the cable, unmarked\n");

    ble_selected();

    uint8_t payload[64];
    ble_mtu = 23;                       /* the floor many stacks actually give */
    ble_send_frame(T_REQUEST, payload, req(payload, sizeof(payload), "ping"));

    CHECK(ble_chunk_count > 0, "no notification at all");

    /* The marker is a USB artifact. If it appeared here the host — which ships
     * BLE_USES_SYNC = false — would read 'L','K' as a length and hang. */
    CHECK(!(ble_chunk_count > 0 && ble_chunk_len[0] >= 3 &&
            ble_chunks[0][1] == 'L' && ble_chunks[0][2] == 'K'),
          "a sync marker leaked onto BLE");

    Frame f = ble_next_reply();
    CHECK(f.present, "ping produced no reassemblable frame");
    CHECK(f.type == T_RESPONSE, "ping answered with frame type 0x%02X", f.type);

    /* Byte-for-byte the cable's answer. Two transports, one dispatch. */
    fresh_device();
    transport_set(TRANSPORT_USB);   /* also detaches the BLE writer */
    send_plain(payload, req(payload, sizeof(payload), "ping"));
    Frame usb = next_frame();
    CHECK(usb.present && usb.type == f.type && usb.len == f.len &&
          memcmp(usb.payload, f.payload, f.len) == 0,
          "BLE and USB gave different answers to the same request");
}

static void test_ble_survives_a_split_write_at_mtu_23(void)
{
    printf("== a request split across many GATT writes is answered\n");

    ble_selected();
    device_has_a_wallet();

    /* getStatus's reply is comfortably over 19 bytes, so the answer has to be
     * chunked as well as the request. */
    ble_mtu = 23;
    uint8_t payload[64];
    ble_send_frame(T_REQUEST, payload, req(payload, sizeof(payload), "getStatus"));

    CHECK(ble_chunk_count >= 1, "no reply chunks");
    for (int i = 0; i < ble_chunk_count; i++) {
        CHECK(ble_chunk_len[i] <= 20,
              "chunk %d is %zu bytes, past the 19+1 an MTU of 23 allows",
              i, ble_chunk_len[i]);
    }
    Frame f = ble_next_reply();
    CHECK(f.present && f.type == T_RESPONSE, "getStatus was not answered over BLE");
}

static void test_ble_rejects_hostile_writes(void)
{
    printf("== hostile GATT writes are dropped without reaching dispatch\n");

    ble_selected();

    BleReassembler rx;
    ble_chunk_reset(&rx);

    /* A frame claiming 64 KB. Nothing may be buffered on that claim. */
    uint8_t huge[8] = { 0x80, 0xff, 0xff, 0x01, 0x00 };
    CHECK(ble_chunk_push(&rx, huge, 5) == BLE_CHUNK_ERROR, "an oversized frame was buffered");
    CHECK(ble_chunk_count == 0, "the device answered a frame it never received");

    /* Out of order: chunk 1 with no chunk 0. */
    uint8_t stray[8] = { 0x01, 0xaa, 0xbb };
    CHECK(ble_chunk_push(&rx, stray, 3) == BLE_CHUNK_ERROR, "an orphan chunk was accepted");
    CHECK(ble_chunk_count == 0, "the device answered an orphan chunk");

    /* And after all that noise the next real request still works — a peer that
     * misbehaves must not wedge the endpoint for the next one. */
    uint8_t payload[64];
    ble_send_frame(T_REQUEST, payload, req(payload, sizeof(payload), "ping"));
    Frame f = ble_next_reply();
    CHECK(f.present && f.type == T_RESPONSE, "the endpoint was wedged by bad chunks");
}

static void test_only_one_transport_is_live(void)
{
    printf("== USB and BLE are never both reachable (T57)\n");

    fresh_device();
    transport_init();

    /* Default is the cable, and BLE is off — not idle, off. */
    CHECK(transport_get() == TRANSPORT_USB, "the device did not default to USB");
    CHECK(!ble_transport_running(), "BLE was up before anyone selected it");

    uint8_t payload[64];
    send_plain(payload, req(payload, sizeof(payload), "ping"));
    CHECK(next_frame().present, "USB did not answer while selected");

    /* Select BLE: the radio comes up and the cable goes quiet. A device that
     * kept answering here would have two peers on one set of nonce counters. */
    transport_set(TRANSPORT_BLE);
    protocol_set_writer(ble_writer);
    CHECK(ble_transport_running(), "selecting BLE did not start the radio");

    drop_pending();
    ble_chunk_count = 0;
    send_plain(payload, req(payload, sizeof(payload), "ping"));
    expect_silence("USB while BLE is selected");
    /* Not just "no bytes on the cable": the cable must not have been PARSED.
     * A device that dispatches a USB request and notifies the answer over BLE
     * is still serving two peers from one set of nonce counters, which is the
     * fault this setting exists to prevent. */
    CHECK(ble_chunk_count == 0,
          "a USB request was dispatched and answered over BLE");

    /* Back to the cable: advertising stops. */
    transport_set(TRANSPORT_USB);
    CHECK(!ble_transport_running(), "BLE kept advertising after USB was selected");
    CHECK(transport_get() == TRANSPORT_USB, "the setting did not follow");

    send_plain(payload, req(payload, sizeof(payload), "ping"));
    CHECK(next_frame().present, "USB stayed deaf after being reselected");
}

static void test_switching_transports_drops_the_session(void)
{
    printf("== switching transports tears the session down (T57)\n");

    fresh_device();
    transport_set(TRANSPORT_USB);
    device_unlocked();
    confirmed_session(31);
    CHECK(session_state() == SESSION_ACTIVE, "no session to tear down");

    transport_set(TRANSPORT_BLE);
    /* A passkey confirmed on the cable does not authorise the radio. */
    CHECK(session_state() == SESSION_IDLE,
          "a confirmed session survived a transport switch (state %d)",
          session_state());

    transport_set(TRANSPORT_USB);
    CHECK(session_state() == SESSION_IDLE, "switching back left a session");
}


/* ==========================================================================
 * Two transports, one dispatch (ROADMAP T26)
 *
 * The BLE tests above prove that ping is answered over the radio. That is not
 * the property that matters. Hardware found the one that does: `getMnemonic`,
 * an unknown method, returned a clean error frame over the cable and produced
 * NOTHING AT ALL over BLE. A request that goes unanswered is worse than one
 * that is refused - on an active session the device's receive counter has
 * moved and the host's send counter has not, so the channel is silently dead
 * from then on, and with no request IDs in this protocol the host cannot even
 * tell which request it lost.
 *
 * So the two transports are compared by construction rather than by hope:
 * every case below runs twice, once down each channel, and the reply must
 * agree in frame type and in decrypted payload. Adding a case covers both
 * transports whether the author thought about BLE or not, which is the only
 * version of this that stays true.
 *
 * Encrypted replies are compared AFTER opening them: the device's session key
 * is ephemeral, so the ciphertext legitimately differs between the two runs
 * while the plaintext must not.
 * ========================================================================== */

typedef enum { VIA_USB, VIA_BLE } Via;

static const char *via_name(Via v) { return v == VIA_BLE ? "BLE" : "USB"; }

/** A fresh device with `v` as the selected transport, and nothing else. */
static void via_fresh(Via v)
{
    fresh_device();
    ble_chunk_count = 0;
    ble_mtu = 23;                  /* the floor, so replies chunk on BLE */
    if (v == VIA_BLE) {
        transport_set(TRANSPORT_BLE);
        protocol_set_writer(ble_writer);
    } else {
        transport_set(TRANSPORT_USB);
    }
}

static void via_send(Via v, uint8_t type, const uint8_t *payload, size_t len)
{
    if (v == VIA_BLE) {
        ble_send_frame(type, payload, len);
    } else {
        send_frame(type, payload, len);
    }
}

static void via_send_plain(Via v, const uint8_t *payload, size_t len)
{
    via_send(v, T_REQUEST, payload, len);
}

static void via_send_encrypted(Via v, const uint8_t *payload, size_t len)
{
    uint8_t buf[512];
    memcpy(buf, payload, len);
    via_send(v, T_ENC_REQUEST, buf, host_seal(buf, len));
}

/** The reply, with encrypted bodies opened so two runs can be compared. */
static Frame via_reply(Via v)
{
    return v == VIA_BLE ? ble_next_reply() : next_reply();
}

/** Handshake to PENDING over `v`. The USB-only twin is handshake(). */
static void via_handshake(Via v, uint8_t seed)
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
    via_send_plain(v, payload, w.length);

    Frame f = via_reply(v);
    const uint8_t *body;
    size_t body_len;
    CborItem it;
    char passkey[SESSION_PASSKEY_LEN + 1];
    if (!f.present || !result_body(&f, &body, &body_len) ||
        !cbor_map_find(body, body_len, "devicePubkey", &it) ||
        it.type != CBOR_BYTES || it.value != 32 ||
        !session_derive(host_priv, it.data, k_h2d, k_d2h, passkey)) {
        printf("  FAIL: handshake over %s did not produce a session\n", via_name(v));
        failures++;
    }
}

static void via_confirmed_session(Via v, uint8_t seed)
{
    via_handshake(v, seed);
    session_confirm();
    session_up = true;
}

/* One conformance case. Each performs its own setup so the two runs share no
 * state, and returns the device's reply. */
typedef enum {
    CASE_PING,
    CASE_UNKNOWN_METHOD,          /* the getMnemonic that started this */
    CASE_TIER_NEEDS_SESSION,
    CASE_TIER_NEEDS_UNLOCK,
    CASE_UNKNOWN_METHOD_IN_SESSION,
    CASE_PLAINTEXT_IN_SESSION,
    CASE_NO_METHOD_KEY,
    CASE_NOT_CBOR,
    CASE_UNKNOWN_FRAME_TYPE,
    CASE_FORGED_TAG,
    CASE_COUNT
} ConformanceCase;

static const char *case_name(ConformanceCase c)
{
    switch (c) {
        case CASE_PING:                      return "ping";
        case CASE_UNKNOWN_METHOD:            return "getMnemonic (unknown method)";
        case CASE_TIER_NEEDS_SESSION:        return "getAddress with no session";
        case CASE_TIER_NEEDS_UNLOCK:         return "getAddress while locked";
        case CASE_UNKNOWN_METHOD_IN_SESSION: return "unknown method in a session";
        case CASE_PLAINTEXT_IN_SESSION:      return "plaintext request in a session";
        case CASE_NO_METHOD_KEY:             return "a request with no method";
        case CASE_NOT_CBOR:                  return "bytes that are not CBOR";
        case CASE_UNKNOWN_FRAME_TYPE:        return "an unknown frame type";
        case CASE_FORGED_TAG:                return "a forged tag";
        default:                             return "?";
    }
}

static Frame run_case(Via v, ConformanceCase c)
{
    uint8_t payload[96];
    size_t  len;

    via_fresh(v);

    switch (c) {
        case CASE_PING:
            via_send_plain(v, payload, req(payload, sizeof(payload), "ping"));
            break;

        case CASE_UNKNOWN_METHOD:
            /* The exact request the BLE probe sends and the cable answered
             * alone. It must be refused, and it must be refused audibly. */
            via_send_plain(v, payload, req(payload, sizeof(payload), "getMnemonic"));
            break;

        case CASE_TIER_NEEDS_SESSION:
            device_unlocked();
            via_send_plain(v, payload, req(payload, sizeof(payload), "getAddress"));
            break;

        case CASE_TIER_NEEDS_UNLOCK:
            device_has_a_wallet();
            via_confirmed_session(v, 61);
            via_send_encrypted(v, payload, req(payload, sizeof(payload), "getAddress"));
            break;

        case CASE_UNKNOWN_METHOD_IN_SESSION:
            device_unlocked();
            via_confirmed_session(v, 62);
            via_send_encrypted(v, payload,
                               req(payload, sizeof(payload), "getMnemonic"));
            break;

        case CASE_PLAINTEXT_IN_SESSION:
            device_unlocked();
            via_confirmed_session(v, 63);
            via_send_plain(v, payload, req(payload, sizeof(payload), "getStatus"));
            break;

        case CASE_NO_METHOD_KEY: {
            CborWriter w;
            cbor_writer_init(&w, payload, sizeof(payload));
            cbor_write_map(&w, 1);
            cbor_write_text(&w, "notmethod");
            cbor_write_uint(&w, 1);
            via_send_plain(v, payload, w.length);
            break;
        }

        case CASE_NOT_CBOR:
            memset(payload, 0xFF, 16);
            via_send_plain(v, payload, 16);
            break;

        case CASE_UNKNOWN_FRAME_TYPE:
            len = req(payload, sizeof(payload), "ping");
            via_send(v, 0x55, payload, len);
            break;

        case CASE_FORGED_TAG: {
            device_unlocked();
            via_confirmed_session(v, 64);
            uint8_t buf[128];
            len = req(payload, sizeof(payload), "ping");
            memcpy(buf, payload, len);
            size_t sealed = host_seal(buf, len);
            buf[0] ^= 0x01;
            via_send(v, T_ENC_REQUEST, buf, sealed);
            break;
        }

        default:
            break;
    }

    return via_reply(v);
}

static void test_both_transports_answer_the_same(void)
{
    printf("== every request is answered identically over USB and BLE (T26)\n");

    for (int c = 0; c < CASE_COUNT; c++) {
        Frame usb = run_case(VIA_USB, (ConformanceCase)c);
        Frame ble = run_case(VIA_BLE, (ConformanceCase)c);

        /* Silence is the failure this whole section exists for, so it is
         * checked first and named for what it costs. */
        CHECK(usb.present, "%s: the cable did not answer at all",
              case_name((ConformanceCase)c));
        CHECK(ble.present,
              "%s: BLE did not answer at all - the host will time out and, "
              "inside a session, the counters are now one apart",
              case_name((ConformanceCase)c));
        if (!usb.present || !ble.present) continue;

        CHECK(usb.type == ble.type,
              "%s: USB answered 0x%02X, BLE answered 0x%02X",
              case_name((ConformanceCase)c), usb.type, ble.type);
        CHECK(usb.len == ble.len && memcmp(usb.payload, ble.payload, usb.len) == 0,
              "%s: the two transports disagreed on the body",
              case_name((ConformanceCase)c));

        /* Every one of these is a refusal except the first two: check that
         * they carry an error code rather than an empty result, so a mutant
         * answering everything with a bare "ok" on both transports would
         * still be caught. */
        if (c != CASE_PING && c != CASE_PLAINTEXT_IN_SESSION) {
            uint32_t code = 0;
            CHECK(error_code(&usb, &code) && code != 0,
                  "%s: the reply carries no error code",
                  case_name((ConformanceCase)c));
        }
    }

    /* Back to the cable, and back to the USB writer. The last case ran over
     * BLE, and leaving the radio selected would send the next suite's replies
     * into a notification buffer nobody reads - which looks exactly like the
     * silence this test is about. */
    via_fresh(VIA_USB);
}

/* ==========================================================================
 * A reply matches the frame type of the request that caused it
 *
 * The device used to decide that on session STATE. Once a session existed, a
 * PLAINTEXT request came back ENCRYPTED - and the host that sent it had no
 * session, which is precisely why it was in plaintext. It had no keys, so it
 * CBOR-decoded raw ciphertext and reported "unsupported CBOR major type 7"
 * and "32 trailing bytes after CBOR value": random bytes spelled out as a data
 * format, where the honest answer was "no session".
 *
 * The counter argument for encrypting cuts the other way here, and this is the
 * part worth writing down. session_encrypt() advances the DEVICE's tx counter;
 * the host advances its rx counter only when it opens a reply (session.ts
 * decrypt()). An encrypted reply the host cannot open therefore leaves the
 * device->host stream one ahead forever - the old behaviour was itself a
 * desync. A plaintext request never advanced the device's rx counter, because
 * only session_decrypt() does, and a plaintext reply never advances the host's
 * tx counter, because the host defers that until it opens a reply. Both sides
 * stand still. That is why this is safe and encrypting was not.
 *
 * The rule the firmware now enforces: an encrypted reply is only ever produced
 * for a request that was successfully decrypted.
 * ========================================================================== */

static void test_a_reply_matches_its_request(void)
{
    printf("== a plaintext request gets a plaintext reply, session or not\n");

    fresh_device();
    device_unlocked();
    confirmed_session(70);

    uint8_t payload[64];

    /* One encrypted exchange first, so both directions are off zero and a
     * drift shows up as a decrypt failure rather than as an accident. */
    send_encrypted(payload, req(payload, sizeof(payload), "getStatus"));
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE,
          "the session was not working to begin with");

    /* A host that lost its keys and fell back to plaintext. It cannot decrypt
     * anything, so an encrypted answer is unreadable by construction. */
    send_plain(payload, req(payload, sizeof(payload), "getStatus"));
    f = next_frame();
    CHECK(f.present, "a plaintext request inside a session went unanswered");
    CHECK(f.type == T_RESPONSE,
          "a plaintext request was answered with frame type 0x%02X - the host "
          "has no keys and will try to parse ciphertext as CBOR", f.type);

    const uint8_t *body;
    size_t body_len;
    CborItem it;
    CHECK(f.present && result_body(&f, &body, &body_len) &&
          cbor_map_find(body, body_len, "unlocked", &it),
          "the plaintext reply was not a readable getStatus result");

    /* And an unimplemented method the same way: plaintext in, plaintext out. */
    send_plain(payload, req(payload, sizeof(payload), "getMnemonic"));
    expect_error(T_ERROR, E_MALFORMED, "a plaintext unknown method in a session");

    /* The point of all of it: neither counter moved, so the encrypted channel
     * is still exactly where it was. If the device had encrypted either reply
     * above, its tx counter would be ahead and this would fail to open. */
    send_encrypted(payload, req(payload, sizeof(payload), "ping"));
    f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE && f.len > 0,
          "answering plaintext desynchronised the encrypted stream");

    /* Belt and braces on the other direction: a key operation still refuses in
     * plaintext, since a plaintext frame proves nothing about who sent it. */
    send_plain(payload, req(payload, sizeof(payload), "getAddress"));
    expect_error(T_ERROR, E_SESSION, "plaintext getAddress inside a session");
}

/* A complete request a transport cannot hand to the dispatcher is refused, not
 * dropped. BLE is the only transport with a queue between the two (its worker
 * cannot be the NimBLE host task, because signing waits on a human), and a
 * full queue used to be one log line the peer never saw. The queue itself
 * lives behind CONFIG_BT_NIMBLE_ENABLED and has no radio here; what is
 * testable, and what matters, is that the refusal it now sends is a real frame
 * and that it leaves the session alone. */
static void test_a_busy_transport_refuses_rather_than_drops(void)
{
    printf("== a request the transport cannot queue is refused, not dropped\n");

    fresh_device();
    device_unlocked();
    confirmed_session(71);

    uint8_t payload[64];
    send_encrypted(payload, req(payload, sizeof(payload), "getStatus"));
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE,
          "the session was not working to begin with");

    /* Called directly, because the queue that triggers it on hardware lives
     * behind CONFIG_BT_NIMBLE_ENABLED. Nothing arrived on the port, so the
     * pump has to be told to collect what the device wrote. */
    protocol_send_transport_busy();
    collect_output();
    f = next_frame();
    CHECK(f.present, "a refused request produced no frame - that is the timeout");
    CHECK(f.type == T_ERROR,
          "the refusal came back as 0x%02X; nothing was decrypted, so the host "
          "cannot open an encrypted one", f.type);
    uint32_t code = 0;
    CHECK(error_code(&f, &code) && code == E_BUSY,
          "the refusal reported 0x%04X, not busy", code);

    /* Nothing was decrypted and nothing was encrypted, so the session is
     * untouched and the host may simply send the request again. */
    send_encrypted(payload, req(payload, sizeof(payload), "ping"));
    f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE,
          "refusing a request broke the session it arrived on");
}

/* ==========================================================================
 * The advertised device name (T56)
 *
 * The bound is the feature. A legacy scan response holds 31 bytes; overflow it
 * and NimBLE rejects the whole advertisement, advertising never starts, and a
 * battery-powered device sits there looking fine while being invisible. That
 * shipped once already, back when the name shared the advertisement with the
 * 128-bit service UUID. A user typing a long name must not be able to
 * reproduce it.
 * ========================================================================== */

static void test_ble_name_is_bounded_and_persisted(void)
{
    printf("== the BLE name is bounded, refused when too long, and persists (T56)\n");

    fake_nvs_reset();
    ble_name_forget();

    CHECK(strcmp(ble_name_get(), BLE_NAME_DEFAULT) == 0,
          "a device nobody renamed does not advertise as " BLE_NAME_DEFAULT);

    CHECK(ble_name_set("Groceries"), "a perfectly ordinary name was refused");
    CHECK(strcmp(ble_name_get(), "Groceries") == 0, "the name did not take");

    /* Exactly at the bound: 2 bytes of AD header + 29 = 31, which fits. */
    char at_limit[BLE_NAME_MAX_LEN + 1];
    memset(at_limit, 'A', BLE_NAME_MAX_LEN);
    at_limit[BLE_NAME_MAX_LEN] = '\0';
    CHECK(ble_name_set(at_limit), "a name of exactly the maximum length was refused");
    CHECK(strlen(ble_name_get()) == BLE_NAME_MAX_LEN,
          "the maximum-length name did not take");

    /* One past it. Refused outright: truncating would advertise a device the
     * user never named, and they are the only one who could notice. */
    char too_long[BLE_NAME_MAX_LEN + 8];
    memset(too_long, 'B', sizeof(too_long) - 1);
    too_long[sizeof(too_long) - 1] = '\0';
    CHECK(!ble_name_set(too_long),
          "an over-long name was accepted - advertising would stop");
    CHECK(strlen(ble_name_get()) == BLE_NAME_MAX_LEN,
          "a refused name changed the one already set");
    CHECK(strchr(ble_name_get(), 'B') == NULL,
          "an over-long name was silently truncated and stored");

    /* The bound is the one the radio actually has to satisfy, not a number
     * picked nearby. This is the assertion in ble.c, restated where it can be
     * checked without a build of the firmware. */
    CHECK(2 + BLE_NAME_MAX_LEN <= 31,
          "BLE_NAME_MAX_LEN does not fit a legacy scan response");

    /* Empty is not a name, and neither is anything the device's own keyboard
     * cannot produce or a scanner render. */
    CHECK(!ble_name_set(""), "an empty name was accepted");
    CHECK(!ble_name_set(NULL), "a null name was accepted");
    CHECK(!ble_name_set("Leek\nWallet"), "a control character was accepted");
    CHECK(!ble_name_set("Leek\x80Wallet"), "a non-ASCII byte was accepted");

    /* Persistence across a reboot, which is what "set on-device" has to mean. */
    CHECK(ble_name_set("Toaster"), "could not set a name to reboot with");
    fake_nvs_reboot();
    ble_name_forget();
    CHECK(strcmp(ble_name_get(), "Toaster") == 0, "the name did not survive a reboot");

    /* A stored value this firmware would not have written - a longer name from
     * another version, or a corrupt read - must not reach the radio either.
     * The default is the safe answer: it is known to fit. */
    static const size_t hostile_lengths[] = {
        BLE_NAME_MAX_LEN + 1,       /* one past the bound, and short enough to
                                     * be read back — the case that reaches the
                                     * validity check rather than the read
                                     * guard */
        BLE_NAME_MAX_LEN + 40,      /* and one far past it */
    };
    for (size_t i = 0; i < sizeof(hostile_lengths) / sizeof(hostile_lengths[0]); i++) {
        ble_name_forget();
        fake_nvs_reset();

        nvs_handle_t nvs;
        char hostile[BLE_NAME_MAX_LEN + 41];
        memset(hostile, 'C', sizeof(hostile));
        CHECK(nvs_open("leek_ui", NVS_READWRITE, &nvs) == ESP_OK,
              "could not stage a bad name");
        nvs_set_blob(nvs, "ble_name", hostile, hostile_lengths[i]);
        nvs_commit(nvs);
        nvs_close(nvs);

        CHECK(strlen(ble_name_get()) <= BLE_NAME_MAX_LEN,
              "a %zu-byte stored name was handed to the radio", hostile_lengths[i]);
        CHECK(strcmp(ble_name_get(), BLE_NAME_DEFAULT) == 0,
              "a %zu-byte stored name did not fall back to the default",
              hostile_lengths[i]);
    }

    /* Leave nothing behind for the suites that follow. */
    fake_nvs_reset();
    ble_name_forget();
}


/* ============================================================================
 * T45 - the account level in a requested path
 * ============================================================================ */

/* The bug this is here for: m/44'/60'/3'/0/0 was parsed for its trailing 0 and
 * answered with ACCOUNT 0's address, under the label the host asked for. A
 * device that quietly substitutes one wallet for another is the failure every
 * confirmation screen exists to prevent, and here it happened before any
 * screen was involved. */
static void test_the_account_level_is_read_not_assumed(void)
{
    printf("== a request naming an account gets that account (T45)\n");
    fresh_device();
    device_unlocked();
    confirmed_session(41);

    char account0[43] = {0};
    char account3[43] = {0};
    const char *paths[2] = { "m/44'/60'/0'/0/5", "m/44'/60'/3'/0/5" };
    char *out[2] = { account0, account3 };

    for (int i = 0; i < 2; i++) {
        uint8_t payload[96];
        CborWriter w;
        cbor_writer_init(&w, payload, sizeof(payload));
        cbor_write_map(&w, 2);
        cbor_write_text(&w, "method");
        cbor_write_text(&w, "getAddress");
        cbor_write_text(&w, "path");
        cbor_write_text(&w, paths[i]);
        send_encrypted(payload, w.length);

        Frame f = next_reply();
        CHECK(f.present && f.type == T_ENC_RESPONSE, "getAddress was not answered");
        const uint8_t *body;
        size_t body_len;
        CborItem it;
        if (f.present && result_body(&f, &body, &body_len)) {
            CHECK(cbor_map_find(body, body_len, "index", &it) &&
                  it.type == CBOR_UINT && it.value == 5,
                  "the address index was lost while reading the account");
            if (cbor_map_find(body, body_len, "address", &it) &&
                it.type == CBOR_TEXT && it.value == 42) {
                memcpy(out[i], it.data, 42);
            }
        }
    }

    CHECK(strlen(account0) == 42 && strlen(account3) == 42,
          "one of the two requests produced no address");
    CHECK(strcmp(account0, account3) != 0,
          "m/44'/60'/3'/0/5 answered with account 0's address - the device "
          "returned a different wallet than the one that was asked for");
}

/* A path is not an arbitrary integer. Hardened levels are encoded as
 * 0x80000000|n, so anything at or above 2^31 is an overflow that would land
 * somewhere else entirely; refusing is the only honest answer. */
static void test_an_out_of_range_account_is_refused(void)
{
    printf("== an account outside the hardened range is refused (T45)\n");
    fresh_device();
    device_unlocked();
    confirmed_session(42);

    uint8_t payload[96];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "getAddress");
    cbor_write_text(&w, "account");
    cbor_write_uint(&w, 0x80000000u);
    cbor_write_text(&w, "index");
    cbor_write_uint(&w, 0);
    send_encrypted(payload, w.length);
    expect_error(T_ENC_ERROR, E_MALFORMED, "an account of 2^31");

    /* And the account the device's own menu cannot reach is still legal: the
     * bound on the selector is a UI bound, not a derivation one. What makes
     * that safe is the confirmation rendering the whole path. */
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "getAddress");
    cbor_write_text(&w, "account");
    cbor_write_uint(&w, 40);
    send_encrypted(payload, w.length);
    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE,
          "account 40 was refused; the menu's bound has leaked into the wire");
}

/* The signing path has to carry the account all the way through: what the
 * screen was shown and what the key was derived from must be one object. */
static void test_the_signing_path_carries_the_account(void)
{
    printf("== the account reaches both the confirmation and the signature\n");
    fresh_device();
    device_unlocked();
    confirmed_session(43);
    scripted_outcome = SIGN_APPROVED;

    uint8_t to[20];
    memset(to, 0xAB, sizeof(to));

    uint8_t payload[256];
    CborWriter w;
    cbor_writer_init(&w, payload, sizeof(payload));
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "signTransaction");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "path");
    cbor_write_text(&w, "m/44'/60'/6'/0/2");
    cbor_write_text(&w, "to");
    cbor_write_bytes(&w, to, sizeof(to));
    CHECK(cbor_writer_ok(&w), "request did not fit");
    send_encrypted(payload, w.length);

    CHECK(confirm_requests == 1, "no confirmation was asked for");
    CHECK(shown_path.account == 6 && shown_path.address_index == 2,
          "the screen was told m/44'/60'/%u'/0/%u, not the requested "
          "m/44'/60'/6'/0/2",
          (unsigned)shown_path.account, (unsigned)shown_path.address_index);

    Frame f = next_reply();
    CHECK(f.present && f.type == T_ENC_RESPONSE, "the signature was not returned");
}

/* ============================================================================
 * T42 - a host-supplied passphrase belongs to the host's session
 * ============================================================================ */

/* The failure: the app types a passphrase, the user approves it, the cable is
 * pulled or the phone walks out of BLE range - and the device is still in the
 * hidden wallet. The next thing to connect inherits it, derives from it and
 * signs with it, and nothing was ever re-approved.
 *
 * A passphrase entered ON the device is a different case and must survive; the
 * second half of this test is that distinction. */
static void test_a_host_passphrase_dies_with_its_session(void)
{
    printf("== a host-supplied passphrase does not outlive its session (T42)\n");
    fresh_device();
    device_has_a_wallet();
    device_unlocked();
    confirmed_session(44);

    uint8_t payload[256];
    size_t len = set_passphrase_request(payload, sizeof(payload), "hunter2");
    scripted_outcome = SIGN_APPROVED;
    send_encrypted(payload, len);
    (void)next_reply();
    CHECK(wallet_has_passphrase(), "setup: the passphrase was not applied");

    /* Every teardown funnels through session_reset(): a disconnect, a new
     * peer, a transport switch, a frame that failed to authenticate. */
    session_reset();
    CHECK(!wallet_has_passphrase(),
          "the passphrase survived the session that supplied it - whatever "
          "connects next inherits a hidden wallet nobody re-approved");

    /* A passphrase the user typed on the device is not the host's to revoke.
     * Dropping it on a disconnect would silently return them to the base
     * wallet, which looks exactly like an empty one.
     *
     * Set up as it actually happens: the host supplies one, and the user then
     * overrides it at the device. The endpoint has to stop considering the
     * passphrase its own at that point, or its own teardown takes the user's
     * passphrase with it. */
    confirmed_session(45);
    /* A new session restarts the device's nonce counters, so the host's have
     * to restart with them - the same thing a real client does on reconnect. */
    host_tx = host_rx = 0;
    scripted_outcome = SIGN_APPROVED;
    len = set_passphrase_request(payload, sizeof(payload), "hunter2");
    send_encrypted(payload, len);
    (void)next_reply();
    CHECK(wallet_has_passphrase(), "setup: the host passphrase was not applied");

    wallet_set_passphrase("typed-here", 10);
    protocol_note_device_passphrase();
    session_reset();
    CHECK(wallet_has_passphrase(),
          "a passphrase entered on the device was dropped when a host "
          "disconnected");
    wallet_clear_passphrase();
}

int main(void)
{
    test_nothing_is_answered_before_a_transport_is_chosen();
    test_plaintext_ping_and_features();
    test_status_is_public_but_thin();
    test_keys_need_a_session_and_a_passkey();
    test_locked_device_refuses_keys();
    test_address_derivation_reads_the_path();
    test_undecodable_calldata_refused_before_confirmation();
    test_blind_signing_is_off_until_the_device_says_otherwise();
    test_signing_signs_what_it_showed();
    test_rejection_and_timeout();
    test_errors_stay_encrypted_once_a_session_exists();
    test_malformed_input();
    test_tampered_frame_tears_down_the_session();
    test_sign_message_signs_what_it_showed();
    test_sign_message_refuses_what_it_cannot_show();
    test_sign_typed_data_signs_what_it_showed();
    test_sign_typed_data_refuses_what_it_cannot_show();
    test_unrenderable_typed_data_is_the_blind_case();
    test_select_wallet();
    test_set_passphrase();
    test_ble_carries_the_same_frames();
    test_ble_survives_a_split_write_at_mtu_23();
    test_ble_rejects_hostile_writes();
    test_only_one_transport_is_live();
    test_switching_transports_drops_the_session();
    test_both_transports_answer_the_same();
    test_a_reply_matches_its_request();
    test_a_busy_transport_refuses_rather_than_drops();
    test_ble_name_is_bounded_and_persisted();

    test_the_account_level_is_read_not_assumed();
    test_an_out_of_range_account_is_refused();
    test_the_signing_path_carries_the_account();
    test_a_host_passphrase_dies_with_its_session();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
