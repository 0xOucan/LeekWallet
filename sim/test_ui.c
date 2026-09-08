/**
 * Host-native tests for src/ui.c (ROADMAP T0.2-T0.4)
 *
 * The UI is the part of this firmware that has historically only been testable
 * by flashing a board and pressing buttons, which is why screen bugs kept
 * reaching hardware. Here the real ui.c runs against a framebuffer OLED and a
 * scripted button sequence, so "what is on screen after these presses" is an
 * assertion.
 *
 * Assertions are on the text the firmware drew, not on pixels. A pixel golden
 * fails on every cosmetic change and tells you nothing about which one; "row 0
 * says Word 24/24" fails only when the device is actually wrong.
 */

#include <stdio.h>
#include <string.h>

#include "esp_stubs.h"
#include "fake_nvs.h"
#include "fake_oled.h"
#include "fake_wallet.h"

#include "ble.h"
#include "transport.h"
#include "ui.h"
#include "pin.h"
#include "button.h"
bool fake_protocol_rx_enabled(void);
#include "mnemonic-entry.h"
#include "text-entry.h"
#include "blind-signing.h"
#include "eth-tx.h"
#include "sha3.h"
#include "memzero.h"
#include "leek-wallet.h"
#include "session.h"

/* Test hooks from ui.c and pin.c (compiled with -DLEEK_HOST_TEST). */
void        pin__reset_static_state_for_test(void);
void        ui__reset_static_state_for_test(void);
bool        ui__check_autolock_for_test(void);
void        ui__service_sign_expiry_for_test(void);
void        ui__service_lock_hold_for_test(void);
void        fake_button_hold(button_id_t id);
void        fake_button_release(void);
void        ui__service_host_lock_for_test(void);
const char *ui__master_xfp_for_test(void);
uint32_t    ui__account_for_test(void);
bool        ui__wallet_info_pass_shown_for_test(void);
int         fake_protocol_device_passphrase_notices(void);
void        fake_protocol_reset(void);
const char *ui__mnemonic_buffer_for_test(void);
size_t      ui__mnemonic_buffer_size_for_test(void);
int         ui__mnemonic_word_count_for_test(void);
const char *ui__pin_entry_for_test(void);
int         ui__pin_cursor_for_test(void);
int         ui__pin_option_for_test(void);
const MnemonicEntry *ui__entry_for_test(void);
bool        ui__entry_choosing_length_for_test(void);
int         ui__entry_length_choice_for_test(void);
bool        ui__entry_is_temporary_for_test(void);
int         ui__lock_timeout_choice_for_test(void);
int         ui__lock_timeout_stored_choice_for_test(void);

void fake_input_reset(void);

/* The 12-word phrase fake_wallet hands out; a real BIP39 test vector. */
static const char *PHRASE_12 =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* Dump the screen when an assertion about it fails - a bare "expected X" tells
 * you nothing about what the device did instead. */
#define CHECK_SCREEN(cond, ...) do {                 \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); fake_oled_dump(); failures++;  \
    }                                                \
} while (0)

/* ------------------------------------------------------------------ driver */

/* One press, then a render - the same order ui_task uses. */
static void press(button_id_t btn)
{
    ui_handle_button(btn);
    ui_render();
}

static void go(screen_id_t screen)
{
    ui_set_screen(screen);
    ui_render();
}

/* One turn of ui_task's loop with nothing pressed: repaint ONLY if something
 * marked the screen dirty.
 *
 * Everything else in this file calls ui_render() unconditionally, which is
 * exactly why a missing ui_invalidate() could never fail a test here - and how
 * the "Signed" acknowledgement shipped never appearing on hardware. Anything
 * the protocol task changes while the screen is already up has to be checked
 * through this, not through press() or go(). */
static void idle_pump(void)
{
    if (ui_needs_render()) {
        ui_render();
    }
    /* Same order as ui_task(): the repaint first, then the work that was
     * deferred so it would happen behind a frame the user has already seen
     * (AUDIT S8f). A pump that ran them the other way round would let a test
     * pass against code that does the slow work inside the button handler. */
    ui_poll_deferred();
}

/* Power-on: empty flash, cleared RAM, registered screens. */
static void boot_device(void)
{
    fake_nvs_reset();
    fake_clock_reset();
    fake_oled_reset();
    fake_input_reset();
    fake_wallet_reset();
    pin__reset_static_state_for_test();
    ui__reset_static_state_for_test();

    pin_init();
    wallet_init();
    ui_init();
    ui_render();
}

/* A device that is past the PIN, with one seed stored. */
static void boot_unlocked_with_seed(void)
{
    boot_device();
    CHECK(pin_set("1234"), "setup: could not set a PIN");
    CHECK(pin_verify("1234"), "setup: could not unlock");
    CHECK(fake_wallet_preload(PHRASE_12) == 1, "setup: could not preload a seed");
}

/* ---------------------------------------------------- typing on 4 buttons */

/* Drive the selector onto option `to` through the real screen. A long option
 * list is shown as blocks, so reaching a letter means scrolling to its block,
 * pressing ACCEPT to open it, then scrolling inside - T44 added that level, and
 * this helper is where the extra press is spent. */
static void select_option(int to)
{
    const MnemonicEntry *e = ui__entry_for_test();

    if (mnemonic_entry_on_group(e)) {
        int want = to / e->group_size;
        for (int guard = 0; guard < 40 && e->option_index / e->group_size != want; guard++) {
            press(BUTTON_UP);
        }
        press(BUTTON_ACCEPT);   /* open the block */
    }
    for (int guard = 0; guard < 40 && e->option_index != to; guard++) {
        press(BUTTON_UP);
    }
}

/*
 * Type `target` on the seed-entry selector, the way a user would: pick the
 * letter, accept, repeat - and once the selector switches to whole words, pick
 * the word itself. Returns false if what is needed is not on offer, which means
 * the screen has stopped following the word.
 */
static bool type_word(const char *target)
{
    const MnemonicEntry *e = ui__entry_for_test();
    const int before = e->word_count;
    size_t next = 0;

    for (int guard = 0; guard < 400; guard++) {
        int found = -1;

        if (e->word_mode) {
            /* option_index is the read-only view of the selector, so probe the
             * candidates by walking it with real presses. */
            for (int i = 0; i < e->option_count; i++) {
                const char *w;
                select_option(i);
                w = mnemonic_entry_selected_word(e);
                if (w && strcmp(w, target) == 0) { found = i; break; }
            }
            if (found < 0) {
                return false;
            }
            select_option(found);
        } else {
            char want = (next < strlen(target)) ? target[next] : MNEMONIC_ENTRY_COMMIT;
            for (int i = 0; i < e->option_count; i++) {
                if (e->options[i] == want) { found = i; break; }
            }
            if (found < 0) {
                return false;
            }
            select_option(found);
            if (want != MNEMONIC_ENTRY_COMMIT) {
                next++;
            }
        }

        press(BUTTON_ACCEPT);

        if (e->word_count != before) {
            return e->word_count > before;
        }
    }
    return false;
}

/* Scroll the PIN selector to `option` (0-9, or 10 for OK) and press it. */
static bool pin_pick(int option)
{
    for (int guard = 0; guard < 24; guard++) {
        if (ui__pin_option_for_test() == option) {
            press(BUTTON_ACCEPT);
            return true;
        }
        press(BUTTON_UP);
    }
    return false;   /* the option is not in the cycle at all */
}

#define PIN_SUBMIT_OPTION 10

/* ============================================================================
 * T3 / AUDIT S8d - the import screen asks how many words
 * ============================================================================ */

static void test_import_word_count_prompt(void)
{
    printf("== import asks 12 or 24 before the first letter (T3)\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_ENTRY);
    CHECK_SCREEN(fake_oled_contains("How many words?"), "no word-count question");
    CHECK_SCREEN(fake_oled_row_contains(4, "> 12"), "12 is not the default choice");
    CHECK_SCREEN(fake_oled_row_contains(5, "  24"), "24 is not offered");

    /* Two options, so either direction toggles. */
    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_row_contains(5, "> 24"), "DOWN did not move to 24");
    CHECK(ui__entry_length_choice_for_test() == 24, "choice is %d, expected 24",
          ui__entry_length_choice_for_test());

    press(BUTTON_ACCEPT);
    CHECK(!ui__entry_choosing_length_for_test(), "still on the length question");
    CHECK_SCREEN(fake_oled_row_contains(0, "Word 1/24"),
                 "header is \"%s\", expected Word 1/24", fake_oled_row(0));
}

static void test_import_back_from_first_character(void)
{
    printf("== BACK from the first letter returns to the prompt, not the menu\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_ENTRY);
    press(BUTTON_DOWN);      /* choose 24 */
    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_row_contains(0, "Word 1/24"), "setup: not on word 1");

    /* Nothing typed yet, so this is the press that used to drop the user out of
     * the import flow entirely - a wrong length choice cost a full restart. */
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_ENTRY,
          "BACK left the import screen (now on screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_contains("How many words?"), "did not return to the prompt");
    CHECK(ui__entry_length_choice_for_test() == 24,
          "the 24-word choice was forgotten (now %d)", ui__entry_length_choice_for_test());

    /* And the choice is still live: accepting again resumes a 24-word import. */
    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_row_contains(0, "Word 1/24"), "resumed as \"%s\"",
                 fake_oled_row(0));
}

static void test_import_reaches_word_24(void)
{
    printf("== choosing 24 actually reaches word 24\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_ENTRY);
    press(BUTTON_DOWN);
    press(BUTTON_ACCEPT);

    /* "zoo" is a BIP39 word that no other word extends, so it auto-commits and
     * keeps this loop short. The phrase is nonsense; reaching word 24 is the
     * claim, not importing it. */
    for (int i = 0; i < 23; i++) {
        if (!type_word("zoo")) {
            CHECK(false, "could not type word %d of 24", i + 1);
            return;
        }
    }

    CHECK_SCREEN(fake_oled_row_contains(0, "Word 24/24"),
                 "after 23 words the header reads \"%s\"", fake_oled_row(0));
    CHECK(ui__entry_for_test()->target_words == 24, "target is %d words",
          ui__entry_for_test()->target_words);
}

static void test_import_rejects_bad_checksum(void)
{
    printf("== a phrase that fails its checksum is refused\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_ENTRY);
    press(BUTTON_ACCEPT);              /* keep 12 */

    for (int i = 0; i < 12; i++) {
        if (!type_word("zoo") && i < 11) {
            CHECK(false, "could not type word %d", i + 1);
            return;
        }
    }

    /* The 12th word completes the phrase and triggers the import attempt. */
    CHECK_SCREEN(fake_oled_contains("Bad checksum"),
                 "24 identical words were not rejected");
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_ENTRY,
          "a bad checksum navigated away (screen %d)", ui_get_screen());
    CHECK(wallet_get_status().wallet_count == 1,
          "an invalid phrase was stored (%u wallets)",
          wallet_get_status().wallet_count);
}

/* ============================================================================
 * AUDIT S5 / T6 - the seed does not linger in .bss
 *
 * The regression this exists to prevent is not "the buffer is never cleared".
 * It is the over-correction: an exit hook that zeroes unconditionally breaks
 * wallet creation, because the display and verification screens hand the same
 * buffer to each other in both directions.
 * ============================================================================ */

static bool mnemonic_buffer_is_zero(void)
{
    const char *buf = ui__mnemonic_buffer_for_test();
    size_t len = ui__mnemonic_buffer_size_for_test();
    for (size_t i = 0; i < len; i++) {
        if (buf[i] != 0) {
            return false;
        }
    }
    return true;
}

static void test_seed_survives_the_display_verify_handoff(void)
{
    printf("== the seed survives DISPLAY -> VERIFY (S5 over-correction guard)\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_DISPLAY);
    CHECK(ui__mnemonic_word_count_for_test() == 12, "showing %d words",
          ui__mnemonic_word_count_for_test());
    CHECK_SCREEN(fake_oled_row_contains(2, "1. legal"),
                 "first word row reads \"%s\"", fake_oled_row(2));

    go(SCREEN_MNEMONIC_VERIFY);
    CHECK(!mnemonic_buffer_is_zero(), "the handoff to verification cleared the seed");
    CHECK(strcmp(ui__mnemonic_buffer_for_test(), PHRASE_12) == 0,
          "the seed changed across the handoff: \"%s\"", ui__mnemonic_buffer_for_test());

    /* Behavioural form of the same claim: verification needs the buffer to know
     * what the right answer is, and bails to the wallet screen without it. */
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_VERIFY,
          "verification gave up immediately (screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_row_contains(0, "Verify 1/3"), "header reads \"%s\"",
                 fake_oled_row(0));
}

static void test_seed_survives_the_user_path_into_verification(void)
{
    printf("== pressing through the last page reaches verification with the seed\n");
    boot_unlocked_with_seed();

    go(SCREEN_MNEMONIC_DISPLAY);
    /* 12 words at 3 per page: three presses to the last page, one more to move on. */
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_row_contains(2, "10. winner"),
                 "last page reads \"%s\"", fake_oled_row(2));

    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_VERIFY,
          "the last page did not lead to verification (screen %d)", ui_get_screen());

    /* And back again: CANCEL with nothing typed returns to the phrase, which is
     * only useful if the phrase is still there to read. */
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_DISPLAY,
          "CANCEL did not return to the seed (screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_row_contains(2, "1. legal"),
                 "returned to a blank phrase: \"%s\"", fake_oled_row(2));
}

static void test_seed_is_zeroed_on_leaving_the_flow(void)
{
    printf("== leaving the seed flow zeroes the buffer (S5)\n");

    /* From the display screen. */
    boot_unlocked_with_seed();
    go(SCREEN_MNEMONIC_DISPLAY);
    CHECK(!mnemonic_buffer_is_zero(), "setup: nothing was displayed");
    go(SCREEN_MAIN_MENU);
    CHECK(mnemonic_buffer_is_zero(), "the seed outlived the display screen");
    CHECK(ui__mnemonic_word_count_for_test() == 0, "the word count outlived it too");

    /* And from the verification screen, which is where wallet creation ends.
     * Without this the first check above would still pass with a hook missing
     * on the verify screen entirely. */
    boot_unlocked_with_seed();
    go(SCREEN_MNEMONIC_DISPLAY);
    go(SCREEN_MNEMONIC_VERIFY);
    CHECK(!mnemonic_buffer_is_zero(), "setup: the seed was already gone");
    go(SCREEN_WALLET_INFO);
    CHECK(mnemonic_buffer_is_zero(), "the seed outlived the verification screen");
}

/* ============================================================================
 * PIN entry
 * ============================================================================ */

static void test_pin_explicit_submit(void)
{
    printf("== the PIN selector submits only when OK is chosen\n");
    boot_device();
    CHECK(pin_set("54321"), "setup: could not set a PIN");
    pin_lock();

    go(SCREEN_PIN_UNLOCK);
    CHECK_SCREEN(fake_oled_row_contains(0, "Enter PIN"), "header reads \"%s\"",
                 fake_oled_row(0));
    CHECK_SCREEN(fake_oled_row_contains(4, "[________]"), "PIN field reads \"%s\"",
                 fake_oled_row(4));

    /* Below the minimum length there is no OK in the cycle - offering it would
     * mean offering a submit that can only fail. */
    CHECK_SCREEN(!fake_oled_row_contains(2, "OK"),
                 "OK is offered with no digits typed: \"%s\"", fake_oled_row(2));

    for (int i = 0; i < 4; i++) {
        CHECK(pin_pick(5 - i), "could not pick digit %d", 5 - i);
    }
    CHECK(ui__pin_cursor_for_test() == 4, "typed %d digits, expected 4",
          ui__pin_cursor_for_test());

    /* Four ACCEPTs and still here: the fourth digit is a digit, not a submit.
     * This is the bug the explicit OK option was added to fix - without it no
     * PIN longer than the minimum could be entered at all. */
    CHECK(ui_get_screen() == SCREEN_PIN_UNLOCK,
          "the device submitted on the minimum length (screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_row_contains(4, "[****____]"), "PIN field reads \"%s\"",
                 fake_oled_row(4));
    CHECK_SCREEN(fake_oled_contains("pick OK"), "no hint that OK is now reachable");

    /* A fifth digit, then submit. Reaching five proves the selector really did
     * keep appending rather than submitting. */
    CHECK(pin_pick(1), "could not pick the fifth digit");
    CHECK(ui__pin_cursor_for_test() == 5, "typed %d digits, expected 5",
          ui__pin_cursor_for_test());

    CHECK(pin_pick(PIN_SUBMIT_OPTION), "OK is not reachable from the selector");
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU,
          "a correct PIN did not unlock (screen %d)", ui_get_screen());
    CHECK(pin_is_unlocked(), "unlocked screen reached while still locked");
}

static void test_pin_wrong_spends_an_attempt(void)
{
    printf("== a wrong PIN costs an attempt and clears the field\n");
    boot_device();
    CHECK(pin_set("1234"), "setup: could not set a PIN");
    pin_lock();

    go(SCREEN_PIN_UNLOCK);
    for (int i = 0; i < 4; i++) {
        CHECK(pin_pick(9), "could not type digit %d", i + 1);
    }
    CHECK(pin_pick(PIN_SUBMIT_OPTION), "OK unreachable");

    CHECK(ui_get_screen() == SCREEN_PIN_UNLOCK, "a wrong PIN let the user in");
    CHECK(pin_get_remaining_attempts() == 2, "%d attempts left, expected 2",
          pin_get_remaining_attempts());
    CHECK(ui__pin_cursor_for_test() == 0, "the rejected digits were left on screen");
    CHECK_SCREEN(fake_oled_row_contains(4, "[________]"), "PIN field reads \"%s\"",
                 fake_oled_row(4));
    CHECK_SCREEN(fake_oled_row_contains(5, "Tries: 2"), "attempts row reads \"%s\"",
                 fake_oled_row(5));
}

static void test_pin_digits_do_not_outlive_the_screen(void)
{
    printf("== leaving the PIN screen zeroes the typed digits (S5)\n");
    boot_device();
    CHECK(pin_set("1234"), "setup: could not set a PIN");
    pin_lock();

    go(SCREEN_PIN_UNLOCK);
    for (int i = 0; i < 4; i++) {
        CHECK(pin_pick(7), "could not type digit %d", i + 1);
    }
    CHECK(strcmp(ui__pin_entry_for_test(), "7777") == 0,
          "setup: the field holds \"%s\"", ui__pin_entry_for_test());

    go(SCREEN_BOOT);

    /* Every byte, not just the terminator: a shortened string still leaves the
     * tail of the previous PIN in RAM. */
    const char *entry = ui__pin_entry_for_test();
    bool clean = true;
    for (int i = 0; i <= PIN_MAX_LENGTH; i++) {
        if (entry[i] != 0) {
            clean = false;
        }
    }
    CHECK(clean, "the typed PIN survived the screen change");
    CHECK(ui__pin_cursor_for_test() == 0, "cursor left at %d",
          ui__pin_cursor_for_test());
}

/* ============================================================================
 * Harness self-check
 *
 * A screen assertion that cannot fail is worse than no assertion, so confirm
 * the framebuffer really is being written and cleared between frames.
 * ============================================================================ */

static void test_harness_sees_the_screen(void)
{
    printf("== the framebuffer tracks what was drawn\n");
    boot_device();

    CHECK_SCREEN(fake_oled_contains("LeekWallet"), "the boot splash is not on screen");
    CHECK(fake_oled_find_row("LeekWallet") == 1, "splash is on row %d, expected 1",
          fake_oled_find_row("LeekWallet"));
    CHECK(fake_oled_flush_count() > 0, "nothing was ever pushed to the panel");

    /* Each render starts from a cleared frame; stale text must not survive. */
    go(SCREEN_MAIN_MENU);
    CHECK_SCREEN(!fake_oled_contains("LeekWallet"),
                 "the previous frame bled into this one");
}


/* ============================================================================
 * An error is not an address (AUDIT S8a, T7)
 * ============================================================================ */

/* The failure this guards against is subtle by design. The address renderer
 * slices its buffer at fixed offsets, so a short error string parked in that
 * buffer draws as one short line over two blank ones - which reads as a
 * truncated address, not as a failure. The QR screen then encoded the same
 * buffer, so a failure message could be offered to a camera as somewhere to
 * send money. */

static void test_failed_derivation_is_not_shown_as_an_address(void)
{
    printf("== a failed derivation says Error, not something address-shaped (S8a)\n");
    boot_unlocked_with_seed();

    fake_wallet_fail_derivation(true);
    go(SCREEN_WALLET_INFO);

    CHECK_SCREEN(fake_oled_contains("Error"), "the screen does not say anything failed");
    CHECK_SCREEN(fake_oled_contains("Addr failed"), "the reason is missing");
    CHECK_SCREEN(!fake_oled_contains("0x"), "something address-shaped was drawn anyway");
}

static void test_qr_refuses_to_encode_an_error(void)
{
    printf("== the QR screen will not encode a failure message (S8a)\n");
    boot_unlocked_with_seed();

    fake_wallet_fail_derivation(true);
    go(SCREEN_WALLET_INFO);
    go(SCREEN_QR_CODE);

    /* The old guard listed the error strings it knew about, so each new one
     * silently became a QR code. Assert on what was encoded, not on which
     * message was current. */
    const char *encoded = fake_oled_qr_data();
    CHECK_SCREEN(encoded == NULL || encoded[0] == '\0',
                 "a QR code was drawn for \"%s\"", encoded ? encoded : "");
    CHECK_SCREEN(fake_oled_contains("No address"), "the QR screen did not explain itself");
}

static void test_qr_still_works_for_a_real_address(void)
{
    printf("== a real address still reaches the QR screen\n");
    boot_unlocked_with_seed();

    go(SCREEN_WALLET_INFO);
    CHECK_SCREEN(fake_oled_contains("QR"), "the QR option is missing for a valid address");

    go(SCREEN_QR_CODE);
    const char *encoded = fake_oled_qr_data();
    CHECK(encoded != NULL && strlen(encoded) == 42 && encoded[0] == '0' && encoded[1] == 'x',
          "encoded \"%s\" instead of a 42-character address", encoded ? encoded : "(none)");
}

static void test_passphrase_confirmation_needs_an_address(void)
{
    printf("== passphrase confirmation refuses to confirm nothing (S8a)\n");
    boot_unlocked_with_seed();

    /* This screen asks the user to recognise an address. With no address there
     * is nothing to recognise, and the old code drew blank lines under "Match
     * your record" - an invitation to accept a wallet that never derived. */
    fake_wallet_fail_derivation(true);
    go(SCREEN_PASSPHRASE_CONFIRM);

    CHECK_SCREEN(!fake_oled_contains("Match your record"),
                 "the user was asked to match a record against nothing");
    CHECK_SCREEN(fake_oled_contains("Error"), "the failure is not stated");
}

/* ============================================================================
 * The Wi-Fi test fixture is gone from release builds (AUDIT S8g, T17)
 * ============================================================================ */

static void test_settings_has_no_wifi_entry(void)
{
    printf("== settings offers no Wi-Fi AP in a build without it (S8g)\n");
    boot_unlocked_with_seed();
    go(SCREEN_SETTINGS);

    /* The host build defines no CONFIG_ESP_WIFI_ENABLED, so this exercises
     * exactly what ships. Walk the whole menu rather than reading one page:
     * the entry used to sit below the fold. */
    bool seen_back = false;
    for (int i = 0; i < 40 && !seen_back; i++) {
        CHECK_SCREEN(!fake_oled_contains("WiFi"), "the Wi-Fi entry is still offered");
        seen_back = fake_oled_contains("Back");
        press(BUTTON_DOWN);
    }
    CHECK(seen_back, "never reached the end of the settings menu");
}


/* ============================================================================
 * T57 - the transport is chosen on the device, and only one is ever live
 * ============================================================================ */

static void test_settings_selects_one_transport(void)
{
    printf("== settings picks USB or BLE, and never both (T57)\n");
    boot_unlocked_with_seed();
    go(SCREEN_SETTINGS);

    transport_init();
    CHECK(transport_get() == TRANSPORT_USB, "the device did not default to USB");
    CHECK(!ble_transport_running(), "BLE was advertising before it was chosen");

    /* Reach the entry the way a user does. There is one item, not a pair of
     * radio toggles: a screen offering "BLE [ON]" alongside a live USB link
     * would be offering a state the device must never be in. */
    bool found = false;
    for (int i = 0; i < 40 && !found; i++) {
        found = fake_oled_contains("> Link USB");
        if (!found) press(BUTTON_DOWN);
    }
    CHECK(found, "no transport entry in the settings menu");
    if (!found) return;

    press(BUTTON_ACCEPT);
    CHECK(transport_get() == TRANSPORT_BLE, "accepting did not switch to BLE");
    CHECK(ble_transport_running(), "BLE was selected but is not up");
    CHECK(!fake_protocol_rx_enabled(), "the USB endpoint stayed live under BLE");
    CHECK_SCREEN(fake_oled_contains("Link BLE"), "the screen still claims USB");

    press(BUTTON_ACCEPT);
    CHECK(transport_get() == TRANSPORT_USB, "accepting again did not return to USB");
    CHECK(!ble_transport_running(), "BLE kept advertising after USB was chosen");
    CHECK(fake_protocol_rx_enabled(), "the cable stayed deaf after being chosen");
}

/* ============================================================================
 * T61 - one job per button on the entropy screen
 * ============================================================================ */

/* Mirrors ENTROPY_TARGET_BITS / BITS_PER_EVENT in ui.c and entropy.c, which are
 * static. Written once here and formatted into the expectations below rather
 * than spelled into a dozen string literals: the press count moved from 32 to 64
 * when BITS_PER_EVENT was corrected to 2, and it should be able to move again
 * without this file needing a search-and-replace to notice. */
#define UI_ENTROPY_TARGET_BITS 128
#define UI_ENTROPY_TARGET      (UI_ENTROPY_TARGET_BITS / 2)

static void counter_text(char *out, size_t n, int events)
{
    snprintf(out, n, "%d / %d", events, UI_ENTROPY_TARGET);
}

/* The screen opens on a chooser now, because there are two ways to feed the
 * pool. Item 0 is dice, item 1 is taps. */
static void enter_entropy_mode(int item)
{
    go(SCREEN_ENTROPY);
    for (int i = 0; i < item; i++) press(BUTTON_DOWN);
    press(BUTTON_ACCEPT);
}

/* Walk the real creation flow up to the point of generation.
 *
 * The length is chosen first now, because the entropy gate depends on it (128
 * bits for 12 words, 256 for 24). Tests that used to open the create screen and
 * press ACCEPT have to come through here instead -- which is the point of the
 * change, and worth their going the long way for. */
static void reach_generation_ready(void)
{
    go(SCREEN_WALLET_CREATE);          /* the length chooser, 12 by default */
    press(BUTTON_ACCEPT);              /* -> entropy, target 128 bits */
    press(BUTTON_DOWN);                /* chooser: dice -> taps */
    press(BUTTON_ACCEPT);              /* -> taps mode */
    for (int i = 0; i < UI_ENTROPY_TARGET; i++) press(BUTTON_UP);
    press(BUTTON_ACCEPT);              /* full pool proceeds -> create, ready */
}

static void test_entropy_accept_only_proceeds(void)
{
    printf("== ACCEPT collects nothing and only ever proceeds (T61)\n");
    boot_unlocked_with_seed();
    enter_entropy_mode(1);

    char want[24];
    counter_text(want, sizeof(want), 0);
    CHECK_SCREEN(fake_oled_contains(want), "the pool did not start empty");
    CHECK_SCREEN(fake_oled_row_contains(7, "----"),
                 "the footer offers something for ACCEPT before the target");
    CHECK_SCREEN(!fake_oled_contains("NEXT"), "NEXT is offered before the target");

    /* ACCEPT before the target does nothing at all - not a sample, not a
     * screen change. It used to count as a sample, which taught the reflex
     * that creates a wallet. */
    for (int i = 0; i < 5; i++) {
        press(BUTTON_ACCEPT);
    }
    CHECK(ui_get_screen() == SCREEN_ENTROPY, "ACCEPT left the screen early");
    counter_text(want, sizeof(want), 0);
    CHECK_SCREEN(fake_oled_contains(want),
                 "ACCEPT was counted as a sample");

    /* UP and DOWN are the samples. */
    press(BUTTON_UP);
    counter_text(want, sizeof(want), 1);
    CHECK_SCREEN(fake_oled_contains(want), "UP did not collect a sample");
    press(BUTTON_DOWN);
    counter_text(want, sizeof(want), 2);
    CHECK_SCREEN(fake_oled_contains(want), "DOWN did not collect a sample");

    for (int i = 2; i < UI_ENTROPY_TARGET; i++) {
        press(BUTTON_UP);
    }
    counter_text(want, sizeof(want), UI_ENTROPY_TARGET);
    CHECK_SCREEN(fake_oled_contains(want), "the target did not fill the pool");
    CHECK_SCREEN(fake_oled_contains("Ready"), "a full pool does not say Ready");
    CHECK_SCREEN(fake_oled_row_contains(7, "NEXT"), "NEXT is still not offered");

    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_WALLET_CREATE,
          "ACCEPT on a full pool did not proceed");
}

static void test_entropy_cancel_abandons(void)
{
    printf("== CANCEL abandons wallet creation rather than lowering the bar\n");
    boot_unlocked_with_seed();
    enter_entropy_mode(1);

    for (int i = 0; i < 10; i++) {
        press(BUTTON_UP);
    }
    /* One step back to the chooser, keeping what was collected, then out. */
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_ENTROPY, "CANCEL skipped the chooser");
    CHECK_SCREEN(fake_oled_contains("taps 10"),
                 "backing out of tap mode discarded the pool");
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU, "CANCEL did not leave the screen");

    /* And the half-full pool does not survive to be topped up later. */
    enter_entropy_mode(1);
    char want[24];
    counter_text(want, sizeof(want), 0);
    CHECK_SCREEN(fake_oled_contains(want), "the abandoned pool was kept");
    press(BUTTON_CANCEL);
    press(BUTTON_CANCEL);
}

/* ============================================================================
 * Dice entropy
 *
 * The reason this mode exists is that its bit count is arithmetic rather than
 * modelled, so the tests are about the arithmetic being on screen and about
 * ROLL never turning into "create a wallet" under the user's thumb.
 * ============================================================================ */

/* log2(6) = 2.5849625, credited as floor(n * 2585 / 1000). */
static int dice_bits_for(int rolls)
{
    return (rolls * 2585) / 1000;
}

/* Commit `face` on the wrapping 1..6 selector, which starts (and stays) on
 * whatever was last armed. Walks up because that is all these tests need. */
static void roll(int from, int face)
{
    int steps = (face - from + 6) % 6;
    for (int i = 0; i < steps; i++) press(BUTTON_UP);
    press(BUTTON_ACCEPT);
}

static void test_dice_counts_are_arithmetic(void)
{
    printf("== the dice screen shows a defensible bit count\n");
    boot_unlocked_with_seed();
    enter_entropy_mode(0);

    CHECK_SCREEN(fake_oled_contains("REAL dice"),
                 "the screen does not say the dice must be physical");
    CHECK_SCREEN(fake_oled_contains("phone apps"),
                 "the screen does not warn against phone dice apps");
    CHECK_SCREEN(fake_oled_contains("roll 0/50"),
                 "50 rolls is the 128-bit target and the screen does not say so");
    CHECK_SCREEN(fake_oled_contains("[1]"), "the selector does not start on 1");

    /* The selector is a position, not a free-typed digit: it must show which
     * face is armed before ROLL commits it. */
    press(BUTTON_UP);
    CHECK_SCREEN(fake_oled_contains("[2]"), "UP did not move the selector");
    CHECK_SCREEN(fake_oled_contains("roll 0/50"),
                 "moving the selector was counted as a roll");
    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("[1]"), "DOWN did not move the selector back");

    press(BUTTON_ACCEPT);
    char want[32];
    snprintf(want, sizeof(want), "roll 1/50  ~%d bits", dice_bits_for(1));
    CHECK_SCREEN(fake_oled_contains(want), "one roll is not credited %d bits",
                 dice_bits_for(1));
    CHECK_SCREEN(fake_oled_contains("entered: 1"),
                 "the committed roll is not echoed back");

    /* Ten rolls of assorted faces: 10 * 2.585 = 25 bits, floored. */
    int cur = 1;
    static const int faces[9] = {4, 4, 6, 2, 5, 1, 3, 6, 2};
    for (int i = 0; i < 9; i++) { roll(cur, faces[i]); cur = faces[i]; }
    snprintf(want, sizeof(want), "roll 10/50  ~%d bits", dice_bits_for(10));
    CHECK_SCREEN(fake_oled_contains(want), "10 rolls is not %d bits",
                 dice_bits_for(10));
    CHECK(dice_bits_for(10) == 25, "log2(6) arithmetic drifted: %d",
          dice_bits_for(10));
}

static void test_dice_roll_never_creates_a_wallet(void)
{
    printf("== ROLL only ever commits a roll; creating is elsewhere\n");
    boot_unlocked_with_seed();
    enter_entropy_mode(0);

    int cur = 1;
    for (int i = 0; i < 60; i++) { roll(cur, (i % 6) + 1); cur = (i % 6) + 1; }

    /* Past the target, and pressing the collect button dozens more times still
     * cannot generate a seed - the reflex button is not the commit button. */
    CHECK(ui_get_screen() == SCREEN_ENTROPY, "ROLL wandered off the screen");
    for (int i = 0; i < 5; i++) press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_ENTROPY, "ROLL created a wallet");

    press(BUTTON_CANCEL);
    char want[40];
    snprintf(want, sizeof(want), "dice 65 = %d bits", dice_bits_for(65));
    CHECK_SCREEN(fake_oled_contains(want), "the chooser lost the dice total");
    CHECK_SCREEN(fake_oled_contains("Create wallet"),
                 "a met target does not offer to create the wallet");

    press(BUTTON_DOWN);
    press(BUTTON_DOWN);
    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_WALLET_CREATE,
          "the chooser would not proceed on a met target");
}

static void test_dice_and_taps_compose(void)
{
    printf("== dice and tap bits add up to one gate\n");
    boot_unlocked_with_seed();
    enter_entropy_mode(0);

    int cur = 1;
    for (int i = 0; i < 20; i++) { roll(cur, (i % 6) + 1); cur = (i % 6) + 1; }
    press(BUTTON_CANCEL);

    /* 20 rolls = 51 bits, so tap mode should now be asking for the remaining
     * 77 bits as ceil(77/2) = 39 presses on top of nothing - not 64. */
    int have = dice_bits_for(20);
    int taps = (UI_ENTROPY_TARGET_BITS - have + 1) / 2;
    press(BUTTON_DOWN);
    press(BUTTON_ACCEPT);
    char want[32];
    snprintf(want, sizeof(want), "0 / %d", taps);
    CHECK_SCREEN(fake_oled_contains(want),
                 "tap mode ignored the dice already rolled (wanted %s)", want);

    for (int i = 0; i < taps; i++) press(BUTTON_UP);
    CHECK_SCREEN(fake_oled_contains("Ready"),
                 "dice plus taps did not reach the gate");
    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_WALLET_CREATE,
          "a combined pool would not proceed");
}

/* ============================================================================
 * T39b - the master fingerprint is on screen
 * ============================================================================ */

static void test_xfp_is_shown_with_the_address(void)
{
    printf("== the wallet screen names the seed, not just an address (T39b)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    go(SCREEN_WALLET_INFO);
    int row = fake_oled_find_row("XFP");
    CHECK_SCREEN(row >= 0, "no fingerprint on the wallet screen");

    uint32_t fp = 0;
    CHECK(wallet_get_master_fingerprint(&fp) == WALLET_OK, "no fingerprint to show");
    char expect[16];
    snprintf(expect, sizeof(expect), "XFP %08lX", (unsigned long)fp);
    CHECK_SCREEN(fake_oled_contains(expect), "the screen does not show %s", expect);

    /* It identifies the seed, so scrolling accounts must not change it. */
    press(BUTTON_UP);
    CHECK_SCREEN(fake_oled_contains(expect),
                 "the fingerprint changed when the account did");
}

static void test_xfp_tells_passphrase_wallets_apart(void)
{
    printf("== the passphrase confirmation shows which seed it produced (T39b)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    go(SCREEN_WALLET_INFO);
    uint32_t plain = 0;
    CHECK(wallet_get_master_fingerprint(&plain) == WALLET_OK, "no base fingerprint");

    wallet_set_passphrase("hunter2", 7);
    go(SCREEN_PASSPHRASE_CONFIRM);

    uint32_t with = 0;
    CHECK(wallet_get_master_fingerprint(&with) == WALLET_OK, "no passphrase fingerprint");
    CHECK(with != plain, "the passphrase did not change the fingerprint");

    char expect[16];
    snprintf(expect, sizeof(expect), "XFP %08lX", (unsigned long)with);
    CHECK_SCREEN(fake_oled_contains(expect),
                 "the confirmation does not show %s", expect);
    /* A wrong passphrase is a valid wallet, so the screen still has to say
     * what the user is meant to do with the value. */
    CHECK_SCREEN(fake_oled_contains("Match"), "nothing tells the user to compare");

    wallet_clear_passphrase();
}

/* A fingerprint that cannot be derived must be absent, not a placeholder: a
 * row reading "XFP --------" is read as a value. */
static void test_xfp_is_absent_when_it_cannot_be_derived(void)
{
    printf("== no fingerprint is shown when none could be derived\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    /* Only the fingerprint fails: the address is still real, so this is the
     * case where an "XFP --------" placeholder would sit next to genuine data
     * and be read as genuine too. */
    fake_wallet_fail_fingerprint(true);

    go(SCREEN_WALLET_INFO);
    CHECK_SCREEN(fake_oled_contains("0x01"), "setup: the address failed too");
    CHECK_SCREEN(!fake_oled_contains("XFP"), "a fingerprint was drawn without one");

    fake_wallet_fail_fingerprint(false);
}

/* ============================================================================
 * T60 - the passphrase selector honours the seed selector's setting
 * ============================================================================ */

static void test_entry_style_drives_both_selectors(void)
{
    printf("== the Entry setting drives seed entry only (T60)\n");
    boot_unlocked_with_seed();

    CHECK(!mnemonic_entry_blocks_enabled() && !text_entry_blocks_enabled(),
          "the selectors did not start flat");

    go(SCREEN_SETTINGS);
    bool found = false;
    for (int i = 0; i < 40 && !found; i++) {
        found = fake_oled_contains("> Entry ");
        if (!found) press(BUTTON_DOWN);
    }
    CHECK(found, "no Entry style item in the settings menu");
    if (!found) return;

    press(BUTTON_ACCEPT);
    CHECK(mnemonic_entry_blocks_enabled(), "the seed selector did not change");

    /* The passphrase ring deliberately stays flat, whatever the setting says.
     *
     * Blocks are fewer presses there too - 9.1 per character against 14.4 -
     * and were still reported worse to use on hardware. The reason is
     * structural: seed entry has one dimension, 26 letters narrowing as you
     * type, while the passphrase ring already carries a character-set mode on
     * top of ~95 characters. Blocks make that three levels of navigation on
     * four unlabelled buttons. A passphrase typed wrong is worse than one
     * typed slowly, so speed loses here. */
    CHECK(!text_entry_blocks_enabled(),
          "blocks reached the passphrase ring; it is meant to stay flat");

    go(SCREEN_PASSPHRASE);
    CHECK_SCREEN(!fake_oled_row_contains(7, "OPEN"),
                 "the passphrase footer offers a block level it should not have");
}

/* ============================================================================
 * T4 / AUDIT S8e - Change PIN is wired up and asks for three PINs
 * ============================================================================ */

/* Type a PIN on the selector and submit it. */
static bool type_pin(const char *pin)
{
    for (const char *p = pin; *p; p++) {
        if (!pin_pick(*p - '0')) {
            return false;
        }
    }
    return pin_pick(PIN_SUBMIT_OPTION);
}

static void test_change_pin_is_reachable_and_works(void)
{
    printf("== Change PIN asks for the old PIN then the new one twice (T4)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    /* Reach it the way a user does, by walking the settings menu. */
    go(SCREEN_SETTINGS);
    bool found = false;
    for (int i = 0; i < 40 && !found; i++) {
        /* The cursor, not merely the text: several entries are on screen at
         * once, and pressing ACCEPT acts on the selected one. */
        if (fake_oled_contains("> Change PIN")) {
            press(BUTTON_ACCEPT);
            found = ui_get_screen() == SCREEN_PIN_CHANGE;
            break;
        }
        press(BUTTON_DOWN);
    }
    CHECK(found, "Change PIN did not open its screen (screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_row_contains(0, "Current PIN"),
                 "header reads \"%s\"", fake_oled_row(0));

    CHECK(type_pin("1234"), "could not enter the current PIN");
    CHECK_SCREEN(fake_oled_row_contains(0, "New PIN"), "header reads \"%s\"",
                 fake_oled_row(0));

    CHECK(type_pin("8765"), "could not enter the new PIN");
    CHECK_SCREEN(fake_oled_row_contains(0, "Confirm"), "header reads \"%s\"",
                 fake_oled_row(0));

    CHECK(type_pin("8765"), "could not confirm the new PIN");
    CHECK(ui_get_screen() == SCREEN_SETTINGS,
          "a completed change did not return to settings (screen %d)",
          ui_get_screen());

    pin_lock();
    CHECK(pin_verify("8765"), "the new PIN does not unlock the device");
    pin_reset_attempts();
    CHECK(!pin_verify("1234"), "the old PIN still unlocks the device");
}

static void test_change_pin_rejects_a_wrong_current_pin(void)
{
    printf("== a wrong current PIN is refused and said so on screen (T4)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    go(SCREEN_PIN_CHANGE);
    CHECK(type_pin("9999"), "could not enter a wrong current PIN");
    CHECK(type_pin("8765"), "could not enter the new PIN");
    CHECK(type_pin("8765"), "could not confirm the new PIN");

    CHECK(ui_get_screen() == SCREEN_PIN_CHANGE,
          "a wrong current PIN was accepted (screen %d)", ui_get_screen());
    CHECK_SCREEN(fake_oled_contains("Wrong current PIN"),
                 "the refusal does not say why");

    pin_lock();
    pin_reset_attempts();
    CHECK(pin_verify("1234"), "the original PIN stopped working");
}

static void test_change_pin_catches_a_mismatch(void)
{
    printf("== a mistyped confirmation restarts at the new PIN (T4)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    go(SCREEN_PIN_CHANGE);
    CHECK(type_pin("1234"), "could not enter the current PIN");
    CHECK(type_pin("8765"), "could not enter the new PIN");
    CHECK(type_pin("8760"), "could not enter the mismatched confirmation");

    CHECK_SCREEN(fake_oled_contains("don't match"), "the mismatch is not stated");
    CHECK_SCREEN(fake_oled_row_contains(0, "New PIN"),
                 "did not return to the new PIN (header \"%s\")", fake_oled_row(0));

    pin_lock();
    pin_reset_attempts();
    CHECK(pin_verify("1234"), "the PIN changed despite the mismatch");
}

/* A personal_sign confirmation must show the whole message, because the
 * signature covers the whole message. Anything the screen leaves out is
 * something the user approved without reading. */
static void test_message_confirmation_shows_all_of_it(void)
{
    printf("== the message screen renders the entire message, then the source\n");
    boot_unlocked_with_seed();

    const char *message = "Sign in to LeekWallet as user 42 on 2026-08-13 ok";
    HDPath msg_path = HDPATH_ETH_DEFAULT;
    msg_path.address_index = 3;
    ui_request_sign_message(message, strlen(message), &msg_path,
                            "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    /* Twenty characters a row, so a 48-character message spans three of them
     * and every one has to be on screen. */
    CHECK_SCREEN(fake_oled_contains("Sign in to LeekWalle"), "first row missing");
    CHECK_SCREEN(fake_oled_contains("t as user 42 on 2026"), "second row missing");
    CHECK_SCREEN(fake_oled_contains("-08-13 ok"), "the tail of the message is missing");
    CHECK_SCREEN(fake_oled_contains("Sign msg?"),
                 "the screen does not say it is signing a message");

    /* And the source address, on its own page, as for a transaction (T47). */
    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("From"), "no source page");
    CHECK_SCREEN(fake_oled_contains("0x0100aaaaaaaabb"),
                 "the source address is not on the source page");

    /* Approval only after every page has been seen, and only then. */
    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_APPROVED, "approving both pages did not approve");
    ui_sign_clear();
}

/* A typed-data confirmation has to answer three questions the fields alone do
 * not: which contract will honour this, on which chain, and is the amount a
 * number or an infinity. A Permit costs no gas and leaves no trace on chain,
 * which is exactly what makes it comfortable to approve without reading. */
static void test_typed_data_confirmation_names_the_contract_and_the_amount(void)
{
    printf("== the typed-data screen shows the domain, then each field (T12b)\n");
    boot_unlocked_with_seed();

    Eip712Render render;
    memset(&render, 0, sizeof(render));
    snprintf(render.primary_type, sizeof(render.primary_type), "Permit");
    snprintf(render.domain_name, sizeof(render.domain_name), "USD Coin");
    render.has_domain_name = true;
    render.chain_id = 1;
    render.has_chain_id = true;
    /* USDC. */
    static const uint8_t usdc[20] = {
        0xa0,0xb8,0x69,0x91,0xc6,0x21,0x8b,0x36,0xc1,0xd1,
        0x9d,0x4a,0x2e,0x9e,0xb0,0xce,0x36,0x06,0xeb,0x48
    };
    memcpy(render.verifying_contract, usdc, 20);
    render.has_verifying_contract = true;

    snprintf(render.fields[0].label, sizeof(render.fields[0].label), "spender");
    render.fields[0].is_address = true;
    snprintf(render.fields[0].value, sizeof(render.fields[0].value),
             "0x1111111254EEB25477B68fb85Ed929f73A960582");
    snprintf(render.fields[1].label, sizeof(render.fields[1].label), "value");
    render.fields[1].unlimited = true;
    snprintf(render.fields[2].label, sizeof(render.fields[2].label), "deadline");
    render.fields[2].is_deadline = true;
    snprintf(render.fields[2].value, sizeof(render.fields[2].value), "1893456000");
    render.field_count = 3;

    uint8_t digest[32];
    memset(digest, 0xab, sizeof(digest));

    HDPath path = HDPATH_ETH_DEFAULT;
    ui_request_sign_typed_data(&render, digest, false, &path,
                               "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    CHECK_SCREEN(fake_oled_contains("Sign data?"),
                 "the header does not say this is typed data");
    CHECK_SCREEN(fake_oled_contains("Permit"), "the struct is not named");
    /* The domain page, before any field. A Permit whose fields all read
     * correctly against the wrong contract drains the wrong token. */
    CHECK_SCREEN(fake_oled_contains("Contract"), "the domain page names no contract");
    CHECK_SCREEN(fake_oled_contains("0xA0b86991c6218b"),
                 "the verifying contract is not on the domain page");
    CHECK_SCREEN(fake_oled_contains("Ethereum"), "the chain is not on the domain page");

    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("spender"), "no spender page");
    CHECK_SCREEN(fake_oled_contains("0x1111111254EEB2"),
                 "the spender address is not shown");

    press(BUTTON_DOWN);
    /* The word, not seventy-eight digits. Same wording as the ERC-20 approve
     * screen, because it is the same thing being agreed to. */
    CHECK_SCREEN(fake_oled_contains("UNLIMITED amount"),
                 "an infinite allowance is not named as one");

    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("1893456000"), "the deadline value is missing");
    CHECK_SCREEN(fake_oled_contains("valid until"),
                 "the deadline is not labelled as one");

    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("From"), "no source page");
    CHECK_SCREEN(fake_oled_contains("Typed data sig"),
                 "the source page does not say a signature moves nothing by itself");

    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_APPROVED, "paging through every page did not approve");
    ui_sign_clear();
}

/* The blind form of the same screen. It must not look like the one above: the
 * warning leads, and the digest replaces a field list that would read as
 * complete when it is not. */
static void test_blind_typed_data_leads_with_the_warning(void)
{
    printf("== an unshowable structure gets a warning and a digest, not a field list\n");
    boot_unlocked_with_seed();

    Eip712Render render;
    memset(&render, 0, sizeof(render));
    snprintf(render.primary_type, sizeof(render.primary_type), "Wide");
    render.chain_id = 1;
    render.has_chain_id = true;

    uint8_t digest[32];
    for (int i = 0; i < 32; i++) digest[i] = (uint8_t)i;

    HDPath path = HDPATH_ETH_DEFAULT;
    ui_request_sign_typed_data(&render, digest, true, &path,
                               "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    CHECK_SCREEN(fake_oled_contains("!BLIND SIGN!"),
                 "a blind typed-data request is not marked as blind");
    CHECK_SCREEN(fake_oled_contains("UNREADABLE DATA"), "no warning page");

    press(BUTTON_DOWN);
    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("keccak256:"), "the digest page is missing");
    /* All 64 characters, four rows of sixteen, never a prefix: a truncated
     * hash is trivially forged, and checking it against a second source is the
     * only thing a blind approval has going for it. */
    CHECK_SCREEN(fake_oled_contains("0001020304050607"), "digest row 1 missing");
    CHECK_SCREEN(fake_oled_contains("08090a0b0c0d0e0f"), "digest row 2 missing");
    CHECK_SCREEN(fake_oled_contains("1011121314151617"), "digest row 3 missing");
    CHECK_SCREEN(fake_oled_contains("18191a1b1c1d1e1f"),
                 "the last quarter of the digest is missing");
    ui_sign_clear();
}

/* ------------------------------------------------- blind signing (T16) */

/* Walk the settings list until `label` is the selected row. The list scrolls
 * three at a time, so "press DOWN n times" would encode the position of every
 * item above it and break on the next one added. */
static bool settings_select(const char *label)
{
    go(SCREEN_SETTINGS);
    for (int i = 0; i < 30; i++) {
        for (int row = 0; row < FAKE_OLED_ROWS; row++) {
            const char *text = fake_oled_row(row);
            if (text[0] == '>' && strstr(text, label)) {
                return true;
            }
        }
        press(BUTTON_DOWN);
    }
    return false;
}

/* Enabling the hatch has to cost something. One press must not do it, and the
 * screen has to say what is being given up before it asks. */
static void test_blind_signing_takes_a_deliberate_act(void)
{
    printf("== turning blind signing on warns, and needs more than one press\n");
    boot_unlocked_with_seed();

    CHECK(!blind_signing_enabled(), "blind signing is not off on a fresh device");
    CHECK(settings_select("Blind"), "no blind-signing entry in settings");
    CHECK_SCREEN(fake_oled_contains("[OFF]"),
                 "the settings row does not show the setting is off");

    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_BLIND_WARN,
          "selecting it did not open the warning (screen %d)", ui_get_screen());

    /* What it costs, in words. Not "advanced mode" or "expert settings". */
    CHECK_SCREEN(fake_oled_contains("cannot read"),
                 "the warning does not say the device cannot read the calls");
    CHECK_SCREEN(fake_oled_contains("drain"),
                 "the warning does not say what can go wrong");

    /* Four presses is not five. */
    for (int i = 0; i < 4; i++) {
        press(BUTTON_ACCEPT);
        CHECK(!blind_signing_enabled(),
              "blind signing turned on after only %d presses", i + 1);
        CHECK(ui_get_screen() == SCREEN_BLIND_WARN,
              "the warning left the screen after %d presses", i + 1);
    }
    press(BUTTON_ACCEPT);
    CHECK(blind_signing_enabled(), "five presses did not enable blind signing");
    CHECK(ui_get_screen() == SCREEN_SETTINGS, "did not return to settings");
    CHECK(settings_select("Blind"), "the entry vanished once enabled");
    CHECK_SCREEN(fake_oled_contains("[ON]"),
                 "a weakened device does not say so on the settings row");

    /* Turning it back off is one press: nothing is lost by doing it early. */
    press(BUTTON_ACCEPT);
    CHECK(!blind_signing_enabled(), "one press did not turn the protection back on");

    /* And abandoning the warning part-way leaves it off, with no partial
     * credit carried into the next visit. */
    CHECK(settings_select("Blind"), "the entry vanished");
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_SETTINGS, "CANCEL did not leave the warning");
    CHECK(!blind_signing_enabled(), "an abandoned warning enabled it anyway");

    /* Leaving reset the settings cursor, so find the row again rather than
     * assuming where it is. */
    CHECK(settings_select("Blind"), "the entry vanished after a cancel");
    press(BUTTON_ACCEPT);          /* re-enter the warning */
    CHECK(ui_get_screen() == SCREEN_BLIND_WARN, "could not re-enter the warning");
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    CHECK(!blind_signing_enabled(),
          "the earlier presses were still counted on a second visit");
    press(BUTTON_CANCEL);
}

/* Aqua's ship, on the device's own screen.
 *
 * The one page this test exists for is the maker. The registry files a
 * position under msg.sender and hashes the strategy without it, so "whose
 * position is this" is a claim the strategy makes and nothing on chain checks.
 * The host refuses a mismatch (packages/apps/aqua/src/strategy.ts), but a
 * refusal that only exists on the host is a refusal a compromised host can
 * skip, so the address has to be legible here, in full, beside the one the
 * device will actually sign with.
 */
static void test_an_aqua_ship_shows_its_maker_and_every_leg(void)
{
    printf("== an Aqua ship draws its maker, its hash and each leg\n");
    boot_unlocked_with_seed();

    static const uint8_t APP[20] = {
        0x22, 0x8e, 0x82, 0x83, 0x1a, 0xfa, 0xc5, 0xdd, 0x9e, 0xbd,
        0xe3, 0x48, 0x9e, 0x9e, 0x18, 0xae, 0x9c, 0x7b, 0xcb, 0xf4,
    };
    static const uint8_t MAKER[20] = {
        0x39, 0xd2, 0xba, 0xe5, 0xea, 0xed, 0xa9, 0x28, 0x35, 0x35,
        0xdd, 0xc9, 0x8f, 0x19, 0x91, 0xc8, 0x1e, 0xd5, 0xcd, 0x7e,
    };
    static const uint8_t TOKEN[20] = {
        0xd8, 0xdA, 0x6B, 0xF2, 0x69, 0x64, 0xaF, 0x9D, 0x7e, 0xEd,
        0x9e, 0x03, 0xE5, 0x34, 0x15, 0xD3, 0x7a, 0xA9, 0x60, 0x45,
    };

    /* The strategy, as abi.encode of a dynamic tuple whose first field is the
     * maker -- the shape every Aqua deployment observed on chain uses, and the
     * only one the decoder will accept. */
    uint8_t strategy[96];
    memset(strategy, 0, sizeof(strategy));
    strategy[31] = 0x20;
    memcpy(strategy + 32 + 12, MAKER, 20);
    strategy[95] = 0x07;

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 11155111;      /* Sepolia, where Aqua is actually deployed */
    tx.has_to = true;
    memset(tx.to, 0x11, sizeof(tx.to));
    eth_quantity_set_u64(&tx.value, 0);

    /* Canonical calldata, laid out the way solc would. */
    size_t off_s = 4 * 32;
    size_t off_t = off_s + 32 + sizeof(strategy);
    size_t off_a = off_t + 32 + 32;
    size_t len   = 4 + off_a + 32 + 32;
    CHECK(len <= ETH_MAX_DATA, "the ship probe does not fit ETH_MAX_DATA");
    memset(tx.data, 0, len);
    {
        uint8_t sel[32];
        const char *sig = "ship(address,bytes,address[],uint256[])";
        keccak_256((const uint8_t *)sig, strlen(sig), sel);
        memcpy(tx.data, sel, 4);
    }
    uint8_t *args = tx.data + 4;
    memcpy(args + 12, APP, 20);
    /* Two bytes, big-endian: off_t is 256 and a one-byte write would silently
     * store zero -- which is exactly the kind of encoding the decoder refuses,
     * so the test would have passed for the wrong reason. */
    args[62] = (uint8_t)(off_s >> 8);   args[63] = (uint8_t)off_s;
    args[94] = (uint8_t)(off_t >> 8);   args[95] = (uint8_t)off_t;
    args[126] = (uint8_t)(off_a >> 8);  args[127] = (uint8_t)off_a;
    args[off_s + 31] = (uint8_t)sizeof(strategy);
    memcpy(args + off_s + 32, strategy, sizeof(strategy));
    args[off_t + 31] = 1;
    args[off_a + 31] = 1;
    memcpy(args + off_t + 32 + 12, TOKEN, 20);
    args[off_a + 32 + 31] = 0x64;             /* 100 raw units */
    tx.data_length = len;

    char maker_hex[43], token_hex[43];
    CHECK(eth_format_address(MAKER, maker_hex, sizeof(maker_hex)), "maker format");
    CHECK(eth_format_address(TOKEN, token_hex, sizeof(token_hex)), "token format");
    char maker_head[17], token_head[17];
    snprintf(maker_head, sizeof(maker_head), "%.16s", maker_hex);
    snprintf(token_head, sizeof(token_head), "%.16s", token_hex);

    char expect_hash[65];
    {
        uint8_t digest[32];
        keccak_256(strategy, sizeof(strategy), digest);
        for (int i = 0; i < 32; i++) {
            snprintf(expect_hash + i * 2, 3, "%02x", digest[i]);
        }
    }

    HDPath sign_at = HDPATH_ETH_DEFAULT;
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    /* Not blind: the whole point of the decoder is that this call is read. */
    CHECK_SCREEN(!fake_oled_row_contains(0, "BLIND"),
                 "a decoded ship was drawn as a blind signature (\"%s\")",
                 fake_oled_row(0));

    bool saw_ship = false, saw_pull = false, saw_maker = false;
    bool saw_token = false, saw_amount = false, saw_hash = false;
    bool saw_must_match = false, saw_from = false;

    for (int page = 0; page < 9; page++) {
        if (fake_oled_contains("SHIP to Aqua"))   saw_ship = true;
        if (fake_oled_contains("PULL"))           saw_pull = true;
        if (fake_oled_contains(maker_head))       saw_maker = true;
        if (fake_oled_contains("Must match From")) saw_must_match = true;
        if (fake_oled_contains(token_head))       saw_token = true;
        if (fake_oled_contains("100"))            saw_amount = true;
        if (fake_oled_contains("0x0100aaaaaaaabb")) saw_from = true;
        if (fake_oled_contains("Strategy hash")) {
            char joined[65] = "";
            for (int row = 0; row < FAKE_OLED_ROWS; row++) {
                const char *text = fake_oled_row(row);
                if (strlen(text) == 16 && strspn(text, "0123456789abcdef") == 16) {
                    strncat(joined, text, sizeof(joined) - strlen(joined) - 1);
                }
            }
            saw_hash = (strcmp(joined, expect_hash) == 0);
            CHECK_SCREEN(saw_hash, "strategy hash is %s, expected %s",
                         joined, expect_hash);
        }
        press(BUTTON_DOWN);
    }

    CHECK_SCREEN(saw_ship, "the ship page never named the action");
    CHECK_SCREEN(saw_pull, "the screen never says Aqua pulls from this wallet");
    CHECK_SCREEN(saw_maker, "the strategy's maker never appeared");
    CHECK_SCREEN(saw_must_match, "the maker page does not say it must match From");
    CHECK_SCREEN(saw_token, "the leg's token never appeared");
    CHECK_SCREEN(saw_amount, "the leg's amount never appeared");
    CHECK(saw_hash, "the strategy hash was never shown");
    CHECK_SCREEN(saw_from, "the signing address never appeared (T47)");

    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_APPROVED, "a fully paged ship could not be approved");
    ui_sign_clear();
}

/* The confirmation for a call the device cannot read: visibly different, and
 * honest about exactly how little it knows. */
static void test_blind_confirmation_is_marked_and_shows_the_digest(void)
{
    printf("== a blind confirmation names itself and shows the calldata hash\n");
    boot_unlocked_with_seed();

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    tx.has_to = true;
    memset(tx.to, 0x5A, sizeof(tx.to));
    eth_quantity_set_u64(&tx.value, 0);

    static const uint8_t data[36] = { 0xde, 0xad, 0xbe, 0xef };
    memcpy(tx.data, data, sizeof(data));
    tx.data_length = sizeof(data);

    /* The checksummed form the device will draw, computed the same way it
     * does: a hand-written expectation would be asserting the case rules of
     * EIP-55 rather than what is on screen. */
    char to_hex[43];
    CHECK(eth_format_address(tx.to, to_hex, sizeof(to_hex)), "could not format `to`");
    char to_head[17];
    snprintf(to_head, sizeof(to_head), "%.16s", to_hex);

    HDPath sign_at = HDPATH_ETH_DEFAULT;
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    /* Distinct from a normal confirmation at a glance, on every page. */
    CHECK_SCREEN(fake_oled_row_contains(0, "BLIND"),
                 "the header does not mark this as blind (\"%s\")", fake_oled_row(0));
    CHECK_SCREEN(fake_oled_contains("UNKNOWN CALL"),
                 "the first page does not say the call is unknown");
    CHECK_SCREEN(fake_oled_contains("cannot read"),
                 "the device does not say it cannot read the call");

    /* Approving without paging is not approval, and that rule must not be
     * looser here of all places. */
    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_PENDING,
          "a blind call was approved without seeing every page");

    /* Everything the device honestly knows, page by page. */
    bool saw_to = false, saw_chain = false, saw_len = false, saw_from = false;
    char expect_hex[65];
    {
        uint8_t digest[32];
        keccak_256(data, sizeof(data), digest);
        for (int i = 0; i < 32; i++) {
            snprintf(expect_hex + i * 2, 3, "%02x", digest[i]);
        }
    }
    bool saw_hash = false;

    for (int page = 0; page < 6; page++) {
        if (fake_oled_contains(to_head))              saw_to = true;
        if (fake_oled_contains("Ethereum"))           saw_chain = true;
        if (fake_oled_contains("36 bytes"))           saw_len = true;
        if (fake_oled_contains("0x0100aaaaaaaabb"))   saw_from = true;
        /* The digest, in full and in four rows of sixteen. A truncated hash
         * is forgeable, so a prefix would be worse than none. */
        if (fake_oled_contains("keccak256:")) {
            char joined[65] = "";
            for (int row = 0; row < FAKE_OLED_ROWS; row++) {
                const char *text = fake_oled_row(row);
                if (strlen(text) == 16 && strspn(text, "0123456789abcdef") == 16) {
                    strncat(joined, text, sizeof(joined) - strlen(joined) - 1);
                }
            }
            saw_hash = (strcmp(joined, expect_hex) == 0);
            CHECK_SCREEN(saw_hash, "calldata digest is %s, expected %s",
                         joined, expect_hex);
        }
        press(BUTTON_DOWN);
    }

    CHECK_SCREEN(saw_to, "the recipient never appeared");
    CHECK_SCREEN(saw_chain, "the chain never appeared");
    CHECK_SCREEN(saw_len, "the calldata length never appeared");
    CHECK_SCREEN(saw_from, "the signing address never appeared (T47)");
    CHECK(saw_hash, "the calldata digest was never shown");

    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_APPROVED,
          "a fully paged blind call could not be approved");
    ui_sign_clear();

    /* And refusing works from the first page, without paging. */
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);
    press(BUTTON_CANCEL);
    CHECK(ui_sign_outcome() == SIGN_REJECTED, "CANCEL did not reject a blind call");
    ui_sign_clear();
}

/* Locking takes the channel with it.
 *
 * The encrypted session used to survive a lock: the wallet closed, the host
 * kept talking, and a user returning to enter their PIN resumed on a session
 * authorised before the lock -- possibly hours before, with the device
 * unattended in between. Seen on hardware, where the companion carried on
 * polling for two minutes after a 300 s auto-lock.
 *
 * Checked through the auto-lock because it is the path nobody chooses; the
 * others reach the same lock_device().
 */
static void test_locking_closes_the_channel(void)
{
    printf("== locking the device closes the channel too\n");
    boot_unlocked_with_seed();

    /* Any well-formed peer key will do: this is about the lock, not the
     * handshake, which test_session covers. */
    uint8_t host_pub[SESSION_PUBKEY_SIZE];
    for (size_t i = 0; i < sizeof(host_pub); i++) {
        host_pub[i] = (uint8_t)(0x40 + i);
    }
    uint8_t dev_pub[SESSION_PUBKEY_SIZE], commit[SESSION_COMMIT_SIZE];
    uint8_t host_nonce[SESSION_NONCE_SIZE], dev_nonce[SESSION_NONCE_SIZE];
    memset(host_nonce, 0x5a, sizeof(host_nonce));

    CHECK(session_begin(host_pub, dev_pub, commit), "session_begin refused");
    CHECK(session_reveal(host_nonce, dev_nonce), "session_reveal refused");
    session_confirm();
    CHECK(session_state() == SESSION_ACTIVE, "no session to lose");

    /* Idle past the auto-lock deadline. */
    fake_clock_advance_us((int64_t)31 * 60 * 1000000);
    CHECK(ui__check_autolock_for_test(), "the device did not auto-lock");

    CHECK(session_state() == SESSION_IDLE,
          "the channel survived the lock: a returning host resumes on a session "
          "authorised before the device was left unattended");
}

/* An approval nobody answered has to leave the screen.
 *
 * wait_for_user()'s 120 s deadline answers the host and calls ui_sign_clear(),
 * which zeroes the request and nothing else. So the device sat on a
 * confirmation screen rendering a *wiped* transaction and still taking
 * buttons: pressing SIGN advanced to the result screen and reported the
 * transaction approved, seconds after the host had been told no.
 *
 * Found on hardware while reproducing H-1. Nothing was exploitable -- the
 * outcome is no longer read by then -- but a device whose one guarantee is
 * "what you see is what you sign" must not tell a user it signed something it
 * did not.
 */
static void test_an_expired_approval_leaves_the_screen(void)
{
    printf("== an approval nobody answered comes off the screen\n");
    boot_unlocked_with_seed();

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    memset(tx.to, 0xab, sizeof(tx.to));

    HDPath sign_at = HDPATH_ETH_DEFAULT;
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    /* The protocol task gives up: answers the host, clears the request. */
    ui_sign_clear();
    ui_sign_expire();
    ui__service_sign_expiry_for_test();
    ui_render();

    CHECK(ui_get_screen() != SCREEN_SIGN_CONFIRM,
          "an expired request left the confirmation screen up, still taking presses");
    CHECK(ui_get_screen() == SCREEN_SIGN_RESULT,
          "an expired request did not land on the result screen");

    /* And it says what happened, rather than borrowing the wording for a
     * refusal -- "you said no" and "you said nothing" are different facts. */
    CHECK_SCREEN(fake_oled_contains("Expired"),
                 "the device does not say the request expired");
    CHECK_SCREEN(!fake_oled_contains("Signed"),
                 "an expired request claimed a signature");
    CHECK_SCREEN(!fake_oled_contains("Approved"),
                 "an expired request claimed an approval");

    /* The same expiry on the host-passphrase question, which shares
     * wait_for_user() and had the same gap. */
    ui_request_passphrase_confirm("0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_HOST_PASSPHRASE_CONFIRM);
    ui_sign_clear();
    ui_sign_expire();
    ui__service_sign_expiry_for_test();
    ui_render();
    CHECK(ui_get_screen() != SCREEN_HOST_PASSPHRASE_CONFIRM,
          "an expired passphrase question left its confirmation screen up");
}

/* A decodable call must not borrow the blind wording: "unknown" on a screen
 * that did understand the call would teach the user to ignore it. */
static void test_a_decoded_call_is_not_marked_blind(void)
{
    printf("== a call the device did decode is not dressed as a blind one\n");
    boot_unlocked_with_seed();

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    tx.has_to = true;
    memset(tx.to, 0x5A, sizeof(tx.to));

    /* setApprovalForAll(operator, true) - the widest approval there is, and
     * the one that has to read as such. */
    memset(tx.data, 0, 68);
    tx.data[0] = 0xa2; tx.data[1] = 0x2c; tx.data[2] = 0xb4; tx.data[3] = 0x65;
    memset(tx.data + 16, 0x77, 20);
    tx.data[67] = 1;
    tx.data_length = 68;

    char op_hex[43];
    uint8_t op[20];
    memset(op, 0x77, sizeof(op));
    CHECK(eth_format_address(op, op_hex, sizeof(op_hex)), "could not format operator");
    char op_head[17];
    snprintf(op_head, sizeof(op_head), "%.16s", op_hex);

    HDPath sign_at = HDPATH_ETH_DEFAULT;
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    CHECK_SCREEN(!fake_oled_row_contains(0, "BLIND"),
                 "a decoded call is marked blind (\"%s\")", fake_oled_row(0));
    CHECK_SCREEN(fake_oled_contains("APPROVE ALL"),
                 "setApprovalForAll is not described as approving everything");

    bool saw_operator = false;
    for (int page = 0; page < 4; page++) {
        if (fake_oled_contains("Operator") && fake_oled_contains(op_head)) {
            saw_operator = true;
        }
        press(BUTTON_DOWN);
    }
    CHECK_SCREEN(saw_operator, "the operator being approved was never named");
    ui_sign_clear();
}

/* A call from the signature table (T12c): every declared argument gets a page,
 * and the screen says what a verified signature does and does not prove.
 *
 * Aave's supply() is the case that prompted the work - the device refused it
 * while signing the two approvals that made it dangerous - so it is the case
 * the screen is tested against. */
static void test_a_generic_call_shows_every_argument(void)
{
    printf("== a table call names its function and pages every argument\n");
    boot_unlocked_with_seed();

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    tx.has_to = true;
    memset(tx.to, 0x5A, sizeof(tx.to));

    /* Hashed here rather than typed: a hand-copied selector would encode
     * cleanly and this test would then be asserting against the wrong call. */
    const char *sig = "supply(address,uint256,address,uint16)";
    uint8_t selector[32];
    keccak_256((const uint8_t *)sig, strlen(sig), selector);

    uint8_t asset[20], behalf[20];
    memset(asset, 0x11, sizeof(asset));
    memset(behalf, 0x22, sizeof(behalf));

    memset(tx.data, 0, 132);
    memcpy(tx.data, selector, 4);
    memcpy(tx.data + 4 + 12, asset, 20);
    tx.data[4 + 63] = 0x2A;                    /* amount = 42 */
    memcpy(tx.data + 4 + 64 + 12, behalf, 20);
    tx.data_length = 132;

    char to_hex[43], asset_hex[43], behalf_hex[43];
    CHECK(eth_format_address(tx.to, to_hex, sizeof(to_hex)), "format contract");
    char to_head[17];
    snprintf(to_head, sizeof(to_head), "%.16s", to_hex);
    CHECK(eth_format_address(asset, asset_hex, sizeof(asset_hex)), "format asset");
    CHECK(eth_format_address(behalf, behalf_hex, sizeof(behalf_hex)), "format behalf");
    char asset_head[17], behalf_head[17];
    snprintf(asset_head, sizeof(asset_head), "%.16s", asset_hex);
    snprintf(behalf_head, sizeof(behalf_head), "%.16s", behalf_hex);

    HDPath sign_at = HDPATH_ETH_DEFAULT;
    ui_request_sign(&tx, &sign_at, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);

    /* Decoded, so not dressed as blind - and named, on the first page. */
    CHECK_SCREEN(!fake_oled_row_contains(0, "BLIND"),
                 "a table call is marked blind (\"%s\")", fake_oled_row(0));
    CHECK_SCREEN(fake_oled_contains("supply"), "the function is not named");
    /* The limit, in the same breath as the name: this proves what the call is
     * CALLED, never what it does. */
    CHECK_SCREEN(fake_oled_contains("Not what it does"),
                 "the screen does not state what a verified name proves");

    bool saw_asset = false, saw_amount = false, saw_behalf = false;
    bool saw_referral = false, saw_contract = false, saw_from = false;
    for (int page = 0; page < 8; page++) {
        if (fake_oled_contains("asset") && fake_oled_contains(asset_head)) {
            saw_asset = true;
        }
        if (fake_oled_contains("amount") && fake_oled_contains("42") &&
            fake_oled_contains("raw units")) {
            saw_amount = true;
        }
        if (fake_oled_contains("onBehalfOf") && fake_oled_contains(behalf_head)) {
            saw_behalf = true;
        }
        if (fake_oled_contains("referral") && fake_oled_contains("0")) {
            saw_referral = true;
        }
        /* The contract stays visible: a name proves nothing about who runs
         * the code, and this address is the only thing that identifies it. */
        if (fake_oled_contains("Contract") && fake_oled_contains(to_head)) {
            saw_contract = true;
        }
        if (fake_oled_contains("0x0100aaaaaaaabb")) saw_from = true;
        press(BUTTON_DOWN);
    }

    CHECK_SCREEN(saw_asset, "the asset argument never appeared");
    CHECK_SCREEN(saw_amount, "the amount never appeared in raw units");
    CHECK_SCREEN(saw_behalf, "onBehalfOf never appeared");
    CHECK_SCREEN(saw_referral, "the referral code never appeared");
    CHECK_SCREEN(saw_contract, "the contract address never appeared");
    CHECK_SCREEN(saw_from, "the signing address never appeared (T47)");

    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_APPROVED,
          "a fully paged table call could not be approved");
    ui_sign_clear();
}

/* The host-entry passphrase path (PROTOCOL.md 5): the address is the whole
 * defence, and saying no has to be a real answer rather than a delay. */
static void test_host_passphrase_confirmation(void)
{
    printf("== a host-supplied passphrase is confirmed against its address\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    ui_request_passphrase_confirm("0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_HOST_PASSPHRASE_CONFIRM);

    CHECK_SCREEN(fake_oled_contains("0x0100aaaaaaaabb"),
                 "the wallet's address is not on screen");
    /* The user has to know this came from the host, which is the weaker path. */
    CHECK_SCREEN(fake_oled_contains("host"),
                 "the screen does not say the passphrase came from the app");
    /* The address is one account; the fingerprint is the seed the host's
     * passphrase produced, which is the thing that is either yours or not. */
    CHECK_SCREEN(fake_oled_contains("XFP"),
                 "the host confirmation does not name the resulting seed");
    CHECK(ui_sign_outcome() == SIGN_PENDING, "the prompt answered itself");

    press(BUTTON_CANCEL);
    CHECK(ui_sign_outcome() == SIGN_REJECTED, "CANCEL did not reject");
    ui_sign_clear();

    /* With no address there is nothing to recognise, so there is nothing to
     * accept: a blank confirmation is worse than none. */
    ui_request_passphrase_confirm("");
    go(SCREEN_HOST_PASSPHRASE_CONFIRM);
    press(BUTTON_ACCEPT);
    CHECK(ui_sign_outcome() == SIGN_REJECTED,
          "an empty address was confirmable anyway");
    ui_sign_clear();
}


/* The acknowledgement after signing (reported on hardware).
 *
 * ui_sign_report() is called from the PROTOCOL task the moment
 * wallet_sign_hash_at_path() returns, and on the WalletConnect path there is
 * no button press afterwards - approval was the last one. The UI task only
 * repaints inside `if (ui_needs_render())`, so without an invalidate the
 * "Signing..." frame drawn on entry stayed the last frame drawn and the
 * two-second auto-dismiss moved on to the address list. The device signed and
 * never said so.
 *
 * The whole test is therefore about idle_pump(): render unconditionally and it
 * passes against the broken code, which is how this was verified green once
 * already. */
static void test_the_signed_acknowledgement_actually_appears(void)
{
    printf("== the result screen repaints itself when the signature lands\n");
    boot_unlocked_with_seed();

    /* Entering the screen before the signature exists - what the approval
     * press does. */
    go(SCREEN_SIGN_RESULT);
    CHECK_SCREEN(fake_oled_contains("Signing"),
                 "the result screen does not say it is working");
    CHECK(!ui_needs_render(), "setup: the screen was left dirty");

    /* The protocol task reports success. No press follows. */
    ui_sign_report(true);
    CHECK(ui_needs_render(),
          "ui_sign_report did not mark the screen dirty - the UI task will "
          "never repaint and the user will never see the acknowledgement");
    idle_pump();

    CHECK_SCREEN(fake_oled_contains("Signed"),
                 "the screen never said the transaction was signed");
    CHECK_SCREEN(!fake_oled_contains("Signing"),
                 "the screen is still showing the in-progress frame");

    /* A failure has to reach the screen the same way, and must not read as
     * success: "nothing was sent" is the fact the user needs. */
    ui_sign_clear();
    go(SCREEN_SIGN_RESULT);
    ui_sign_report(false);
    CHECK(ui_needs_render(), "a failed signature did not mark the screen dirty");
    idle_pump();
    CHECK_SCREEN(fake_oled_contains("NOT signed"),
                 "a failed signature was not reported");
    CHECK_SCREEN(!fake_oled_contains("Handed to host"),
                 "a failure claimed the signature went to the host");
    ui_sign_clear();
}


/* ============================================================================
 * AUDIT S8f - the wallet-create handler no longer renders re-entrantly
 * ============================================================================ */

/* What S8f actually was: screen_wallet_create_on_button() called ui_render()
 * itself, from inside a button handler, to get "Generating..." onto the panel
 * before a second of blocking work. The intent was real - the device must not
 * look dead - so the fix keeps it and moves the work instead: the handler sets
 * a flag, the loop paints, and ui_poll_deferred() does the generating.
 *
 * The property under test is the one the second render path put at risk: after
 * the press and before the pump, the screen says it is working and NOTHING has
 * happened yet. Delete the deferral and the wallet is already created by the
 * time press() returns; keep the re-entrant render and the frame is produced
 * from inside a handler that is still mutating the screen's state. */
static void test_seed_generation_happens_behind_its_own_frame(void)
{
    printf("== generating a seed is deferred out of the button handler (S8f)\n");
    boot_unlocked_with_seed();

    reach_generation_ready();

    CHECK(ui_get_screen() == SCREEN_WALLET_CREATE,
          "the handler left the screen before the work was announced");
    CHECK_SCREEN(fake_oled_contains("Generating"),
                 "the user is not told the device is working");
    /* The seed buffer is the evidence: it is filled by the generation and by
     * nothing else on this path. */
    CHECK(ui__mnemonic_buffer_for_test()[0] == '\0',
          "the seed was generated inside the button handler - the frame that "
          "announces it can never have been on the panel first (S8f)");

    /* One turn of the loop: paint, then the deferred work. */
    idle_pump();

    CHECK(ui__mnemonic_buffer_for_test()[0] != '\0',
          "the deferred generation never ran");
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_DISPLAY,
          "the new seed was not shown to be written down");
}

/* Leaving the screen while "Generating..." is up must cancel the request, not
 * queue a seed for whatever screen comes next. Only reachable at all because
 * the handler no longer blocks. */
static void test_leaving_the_create_screen_cancels_the_generation(void)
{
    printf("== abandoning the create screen abandons the generation (S8f)\n");
    boot_unlocked_with_seed();

    go(SCREEN_WALLET_CREATE);
    press(BUTTON_ACCEPT);
    go(SCREEN_MAIN_MENU);
    idle_pump();

    CHECK(ui__mnemonic_buffer_for_test()[0] == '\0',
          "a seed was generated after the user left the screen");
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU, "the deferred work stole the screen");
}

/* ============================================================================
 * T42 - when the passphrase clears, and what the screen says about it
 *
 * A passphrase is not a setting; it selects a wallet. Every one of these is a
 * path where the device could go on deriving from a passphrase the user
 * believes is gone, or show an address from one they believe is applied.
 * ============================================================================ */

static void test_autolock_drops_the_passphrase(void)
{
    printf("== auto-lock drops the passphrase, not just the screen (T42)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");
    wallet_set_passphrase("hunter2", 7);
    CHECK(wallet_has_passphrase(), "setup: the passphrase did not apply");

    go(SCREEN_WALLET_INFO);
    /* Default timeout is 5 minutes; go well past it. */
    fake_clock_advance_us(6 * 60 * 1000000LL);
    CHECK(ui__check_autolock_for_test(), "the device did not auto-lock");

    CHECK(!wallet_has_passphrase(),
          "the passphrase survived an auto-lock - the PIN alone would reopen "
          "a hidden wallet, which is the second factor gone");
    CHECK(ui_get_screen() == SCREEN_PIN_UNLOCK, "auto-lock did not ask for the PIN");

    /* And unlocking again does not bring it back. */
    CHECK(pin_verify("1234"), "could not unlock again");
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "vault would not reopen");
    CHECK(!wallet_has_passphrase(), "unlocking restored a passphrase nobody typed");
}

static void test_switching_wallets_drops_the_passphrase(void)
{
    printf("== switching seeds drops the passphrase and the address with it\n");
    boot_unlocked_with_seed();
    CHECK(fake_wallet_preload(PHRASE_12) == 2, "setup: need a second seed");
    CHECK(wallet_select_wallet(1) == WALLET_OK, "setup: could not select seed 1");
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    wallet_set_passphrase("hunter2", 7);
    go(SCREEN_WALLET_INFO);
    char with_pass[43];
    snprintf(with_pass, sizeof(with_pass), "%s", fake_oled_row(2));

    go(SCREEN_WALLET_SELECT);
    press(BUTTON_DOWN);
    press(BUTTON_ACCEPT);

    CHECK(!wallet_has_passphrase(),
          "the passphrase followed the user to another seed - a wallet nobody "
          "named, that looks empty");
    CHECK(ui_get_screen() == SCREEN_WALLET_INFO, "the switch did not show the wallet");
    CHECK_SCREEN(strcmp(fake_oled_row(2), with_pass) != 0,
                 "the address did not change with the wallet");
}

/* The one that cannot be fixed by clearing state alone: the screen is ALREADY
 * showing an address and a fingerprint when the passphrase changes underneath
 * it. Nothing presses a button, so nothing re-derives unless the UI task
 * notices. Every real trigger is another task - a host setPassphrase, a
 * host-rejected confirmation, a disconnect dropping a host passphrase. */
static void test_a_passphrase_change_under_the_wallet_screen_re_derives(void)
{
    printf("== the wallet screen never shows an address from a passphrase that "
           "is no longer applied (T42)\n");
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");

    go(SCREEN_WALLET_INFO);
    char base_addr[43];
    snprintf(base_addr, sizeof(base_addr), "%s", fake_oled_row(2));
    uint32_t base_fp = 0;
    CHECK(wallet_get_master_fingerprint(&base_fp) == WALLET_OK, "no base fingerprint");

    /* A host applies one while the screen sits there. */
    wallet_set_passphrase("hunter2", 7);
    idle_pump();    /* notices, re-derives, marks dirty */
    idle_pump();    /* paints */

    CHECK_SCREEN(strcmp(fake_oled_row(2), base_addr) != 0,
                 "the screen still shows the base wallet's address after a "
                 "passphrase was applied");
    CHECK_SCREEN(fake_oled_row_contains(0, "P"),
                 "nothing on screen says a passphrase is applied (\"%s\")",
                 fake_oled_row(0));
    uint32_t with_fp = 0;
    CHECK(wallet_get_master_fingerprint(&with_fp) == WALLET_OK, "no fingerprint");
    char expect[16];
    snprintf(expect, sizeof(expect), "XFP %08lX", (unsigned long)with_fp);
    CHECK_SCREEN(fake_oled_contains(expect),
                 "the fingerprint is stale relative to the applied passphrase");

    /* And the other direction: the host, or a rejection, clears it again. */
    wallet_clear_passphrase();
    idle_pump();
    idle_pump();

    CHECK_SCREEN(strcmp(fake_oled_row(2), base_addr) == 0,
                 "the screen kept an address derived from a passphrase that is "
                 "gone - the user would read it off and never be paid");
    snprintf(expect, sizeof(expect), "XFP %08lX", (unsigned long)base_fp);
    CHECK_SCREEN(fake_oled_contains(expect), "the fingerprint stayed stale");
    CHECK(!ui__wallet_info_pass_shown_for_test(),
          "the screen still believes a passphrase is applied");
}

/* ============================================================================
 * T45 - accounts
 * ============================================================================ */

/* Walk the settings list to an item by its label, the way a user would. */
static void settings_goto(const char *label)
{
    go(SCREEN_SETTINGS);
    for (int guard = 0; guard < 40; guard++) {
        if (fake_oled_contains(label)) {
            /* Only stop when it is the SELECTED line: pressing ACCEPT acts on
             * the selection, not on whatever happens to be visible. */
            for (int page = 2; page <= 6; page += 2) {
                const char *row = fake_oled_row(page);
                if (row && row[0] == '>' && strstr(row, label)) {
                    return;
                }
            }
        }
        press(BUTTON_DOWN);
    }
    CHECK(false, "settings has no item labelled \"%s\"", label);
}

static void test_the_account_is_selectable_and_bounded(void)
{
    printf("== the account level is selectable, and bounded (T45)\n");
    boot_unlocked_with_seed();

    settings_goto("Account");
    CHECK_SCREEN(fake_oled_contains("Account 0"), "the account is not shown");

    press(BUTTON_ACCEPT);
    CHECK(ui__account_for_test() == 1, "the account did not advance");
    CHECK_SCREEN(fake_oled_contains("Account 1"), "the new account is not shown");

    /* Round the whole cycle: it must wrap, and it must wrap at the documented
     * bound rather than running off into accounts no screen can name. */
    for (int i = 1; i < HD_ACCOUNT_COUNT; i++) {
        press(BUTTON_ACCEPT);
    }
    CHECK(ui__account_for_test() == 0,
          "the account selector did not wrap at HD_ACCOUNT_COUNT (%u after a "
          "full cycle)", (unsigned)ui__account_for_test());
}

static void test_the_wallet_screen_names_the_whole_path(void)
{
    printf("== the wallet screen shows the derivation path, not just an index\n");
    boot_unlocked_with_seed();

    go(SCREEN_WALLET_INFO);
    CHECK_SCREEN(fake_oled_contains("m/44'/60'/0'/0/0"),
                 "no derivation path on the wallet screen");
    char account0[43];
    snprintf(account0, sizeof(account0), "%s", fake_oled_row(2));

    /* Browse to address 1, then change account: the index must restart, because
     * index 1 of account 0 and index 1 of account 1 are unrelated addresses. */
    press(BUTTON_UP);
    CHECK_SCREEN(fake_oled_contains("m/44'/60'/0'/0/1"), "the index is not in the path");

    settings_goto("Account");
    press(BUTTON_ACCEPT);
    go(SCREEN_WALLET_INFO);

    CHECK_SCREEN(fake_oled_contains("m/44'/60'/1'/0/0"),
                 "the path does not follow the account, or the index did not "
                 "restart with it");
    CHECK_SCREEN(strcmp(fake_oled_row(2), account0) != 0,
                 "account 1 derives the same address as account 0");
}

/* The selection is the analogue of active_idx, so it survives a reboot for the
 * same reason: a device that silently reverts to account 0 shows a different
 * address for the same wallet, which reads as funds having vanished. */
static void test_the_account_survives_a_reboot(void)
{
    printf("== the selected account persists like the selected wallet (T45)\n");
    boot_unlocked_with_seed();

    settings_goto("Account");
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    CHECK(ui__account_for_test() == 2, "setup: could not select account 2");

    /* Power-cycle without erasing flash - everything boot_device() does except
     * fake_nvs_reset(). */
    fake_clock_reset();
    fake_oled_reset();
    fake_input_reset();
    fake_wallet_reset();
    pin__reset_static_state_for_test();
    ui__reset_static_state_for_test();
    pin_init();
    wallet_init();
    ui_init();
    ui_render();

    CHECK(ui__account_for_test() == 2,
          "the account reverted to 0 across a reboot (got %u)",
          (unsigned)ui__account_for_test());
}

/* A wipe erases the vault namespaces, not the settings one, so the account has
 * to be reset explicitly or the next owner's first seed comes up at the
 * previous owner's account. */
static void test_a_wipe_resets_the_account(void)
{
    printf("== a wipe returns the device to account 0 (T45)\n");
    boot_unlocked_with_seed();

    settings_goto("Account");
    press(BUTTON_ACCEPT);
    CHECK(ui__account_for_test() == 1, "setup: could not select account 1");

    go(SCREEN_WIPE_CONFIRM);
    for (int i = 0; i < 8; i++) {
        press(BUTTON_ACCEPT);
    }
    CHECK(ui_get_screen() == SCREEN_PIN_SETUP, "setup: the wipe did not complete");
    CHECK(ui__account_for_test() == 0, "the account selection survived a wipe");
}

/* T47 with the account level added. An index alone was already not enough to
 * know what was signing; two paths that differ only in their account are both
 * "addr 0", so the confirmation has to render the path. */
static void test_the_signing_confirmation_shows_the_account(void)
{
    printf("== the signing confirmation names the full path, not the index (T45/T47)\n");
    boot_unlocked_with_seed();

    EthTx tx;
    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    tx.has_to = true;
    memset(tx.to, 0x11, sizeof(tx.to));

    HDPath path = HDPATH_ETH_DEFAULT;
    path.account = 7;
    path.address_index = 2;
    ui_request_sign(&tx, &path, "0x0107020aaaaaabbbbbbbbccccccccddddddddeee");
    go(SCREEN_SIGN_CONFIRM);

    bool saw_path = false;
    for (int page = 0; page < 6; page++) {
        if (fake_oled_contains("m/44'/60'/7'/0/2")) {
            saw_path = true;
            break;
        }
        press(BUTTON_DOWN);
    }
    CHECK_SCREEN(saw_path,
                 "the confirmation never showed the account it was signing "
                 "from - a host moving accounts would be invisible");
    ui_sign_clear();
}


/* ============================================================================
 * T42 - every lock path locks the same thing
 *
 * Reported from hardware: lock the device from the menu, unlock it, and you
 * are still in the passphrase wallet. pin_lock() and wallet_lock() were each
 * individually right; the four CALL SITES disagreed, and the one a user
 * reaches for deliberately was the one that only closed the PIN gate.
 *
 * That is why these are per-path tests rather than one test of a function. A
 * test of lock_device() would have passed on the broken firmware, because
 * lock_device() is not what the menu called.
 * ============================================================================ */

/* The shared assertion: after this, nothing about the previous session is
 * still live. Takes the path's name so a failure says which one. */
static void check_fully_locked(const char *path)
{
    CHECK(!pin_is_unlocked(), "%s: the PIN gate is still open", path);

    WalletStatus st = wallet_get_status();
    CHECK(!st.unlocked,
          "%s: the vault stayed open behind the PIN gate - the seed never left "
          "RAM and unlocking returns to the same wallet", path);
    CHECK(!wallet_has_passphrase(),
          "%s: the passphrase survived the lock, so the PIN alone reopens a "
          "hidden wallet (T42)", path);
    CHECK(ui__mnemonic_buffer_for_test()[0] == '\0',
          "%s: the UI's copy of the seed outlived the lock", path);
    CHECK(ui_get_screen() == SCREEN_PIN_UNLOCK,
          "%s: the device did not ask for the PIN", path);

    /* The fingerprint names the seed the passphrase produced. Left cached, the
     * next screen to draw it would vouch for a wallet the device can no longer
     * derive - the same bug, one row quieter. */
    CHECK_SCREEN(!fake_oled_contains("XFP"),
                 "%s: a stale fingerprint is still on screen", path);
    CHECK(ui__master_xfp_for_test()[0] == '\0',
          "%s: the cached fingerprint survived the lock - the next screen to "
          "draw it would vouch for a wallet the device can no longer derive",
          path);
}

/* Put the device in the state the bug was reported from: unlocked, seed
 * loaded, a passphrase applied, and an address on screen derived from it. */
static void unlocked_in_a_passphrase_wallet(void)
{
    boot_unlocked_with_seed();
    CHECK(wallet_unlock("1234", 4) == WALLET_OK, "setup: vault would not unlock");
    wallet_set_passphrase("hunter2", 7);
    go(SCREEN_WALLET_INFO);
    CHECK(wallet_has_passphrase(), "setup: no passphrase applied");
    CHECK_SCREEN(fake_oled_contains("XFP"), "setup: no fingerprint on screen");
}

/* Perform the deliberate lock: hold BACK on the home screen for its full
 * duration, and answer the confirmation if one is raised.
 *
 * BACK is held rather than tapped because a tap is how you leave every other
 * screen, and on the home screen it used to also throw away the passphrase,
 * the temporary seed and the channel. `confirm` says whether this call expects
 * the device to ask first -- it does exactly when there is a RAM-only secret
 * to lose. */
static void hold_back_to_lock(bool expect_confirm)
{
    go(SCREEN_MAIN_MENU);
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_LOCK_HOLD,
          "BACK on the home screen did not start a hold");

    fake_button_hold(BUTTON_CANCEL);
    fake_clock_advance_us(LOCK_HOLD_US);
    ui__service_lock_hold_for_test();
    fake_button_release();

    if (expect_confirm) {
        CHECK(ui_get_screen() == SCREEN_LOCK_CONFIRM,
              "a lock that costs a RAM-only secret did not say so first");
        CHECK(pin_is_unlocked(), "the confirmation screen had already locked");
        press(BUTTON_ACCEPT);
    }
    ui_render();
}

/* Defined further down, with the other temporary-seed fixtures. */
static void enter_temporary_seed(void);

/* A tap is not a lock.
 *
 * The whole reason this screen exists: BACK is how you leave every other
 * screen, and on the home screen the same press used to throw away the
 * passphrase, the temporary seed and the encrypted channel.
 */
static void test_a_tap_on_back_does_not_lock(void)
{
    printf("== a tap on BACK does not lock; only a full hold does\n");
    unlocked_in_a_passphrase_wallet();

    go(SCREEN_MAIN_MENU);
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_LOCK_HOLD, "BACK did not start a hold");

    /* Released immediately -- which is what a tap is. */
    fake_button_release();
    ui__service_lock_hold_for_test();

    CHECK(ui_get_screen() == SCREEN_MAIN_MENU,
          "letting go did not abandon the lock");
    CHECK(pin_is_unlocked(), "a tap locked the device");
    CHECK(wallet_has_passphrase(), "a tap threw away the passphrase");

    /* Nor does letting go part-way through. */
    press(BUTTON_CANCEL);
    fake_button_hold(BUTTON_CANCEL);
    fake_clock_advance_us(LOCK_HOLD_US - 1);
    ui__service_lock_hold_for_test();
    CHECK(ui_get_screen() == SCREEN_LOCK_HOLD, "the hold ended early");
    CHECK(pin_is_unlocked(), "the device locked before the hold completed");

    fake_button_release();
    ui__service_lock_hold_for_test();
    CHECK(pin_is_unlocked(), "letting go one tick short still locked");
}

/* The bar has to move, or the user lets go thinking the button is broken. */
static void test_the_hold_shows_progress(void)
{
    printf("== the hold draws a bar that fills\n");
    boot_unlocked_with_seed();

    go(SCREEN_MAIN_MENU);
    press(BUTTON_CANCEL);
    fake_button_hold(BUTTON_CANCEL);

    ui_render();
    CHECK_SCREEN(fake_oled_contains("[") && !fake_oled_contains("#"),
                 "the bar was not empty at the start of the hold");

    fake_clock_advance_us(LOCK_HOLD_US / 2);
    ui_render();
    CHECK_SCREEN(fake_oled_contains("########") &&
                 !fake_oled_contains("################"),
                 "the bar was not half full half way through the hold");

    fake_button_release();
}

/* With nothing RAM-only to lose, the hold is the whole gesture. A confirmation
 * every time is answered reflexively within a week and then protects nothing. */
static void test_a_hold_with_nothing_to_lose_locks_outright(void)
{
    printf("== a hold with no passphrase or temp seed locks without asking\n");
    boot_unlocked_with_seed();
    CHECK(!wallet_has_passphrase(), "setup: a passphrase is applied");
    CHECK(!wallet_has_temporary_mnemonic(), "setup: a temporary seed is loaded");

    hold_back_to_lock(false);       /* nothing to lose: no question */

    CHECK(ui_get_screen() == SCREEN_PIN_UNLOCK, "the device did not ask for the PIN");
    CHECK(!pin_is_unlocked(), "the hold did not lock the device");
}

/* And when there is something to lose, the screen says what it is. A bare
 * "Are you sure?" is friction; naming the cost is information. */
static void test_the_confirmation_names_what_is_lost(void)
{
    printf("== the lock confirmation names what the lock costs\n");

    /* A passphrase on a stored wallet. */
    unlocked_in_a_passphrase_wallet();
    go(SCREEN_MAIN_MENU);
    press(BUTTON_CANCEL);
    fake_button_hold(BUTTON_CANCEL);
    fake_clock_advance_us(LOCK_HOLD_US);
    ui__service_lock_hold_for_test();
    fake_button_release();
    ui_render();

    CHECK(ui_get_screen() == SCREEN_LOCK_CONFIRM, "no confirmation was raised");
    CHECK_SCREEN(fake_oled_contains("Passphrase"),
                 "the confirmation does not say the passphrase is at stake");
    CHECK(pin_is_unlocked(), "the confirmation had already locked the device");

    /* Backing out leaves everything exactly as it was. */
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU, "backing out did not return home");
    CHECK(pin_is_unlocked() && wallet_has_passphrase(),
          "backing out of the confirmation locked anyway");

    /* A temporary seed, which is the more expensive one to retype. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    go(SCREEN_MAIN_MENU);
    press(BUTTON_CANCEL);
    fake_button_hold(BUTTON_CANCEL);
    fake_clock_advance_us(LOCK_HOLD_US);
    ui__service_lock_hold_for_test();
    fake_button_release();
    ui_render();

    CHECK(ui_get_screen() == SCREEN_LOCK_CONFIRM, "no confirmation for a temp seed");
    CHECK_SCREEN(fake_oled_contains("Temp seed"),
                 "the confirmation does not say the temporary seed is at stake");
}

static void test_the_menu_lock_actually_locks(void)
{
    printf("== \"Lock device\" on the menu locks the vault, not just the PIN\n");
    unlocked_in_a_passphrase_wallet();

    hold_back_to_lock(true);    /* a passphrase is live: it must ask */

    check_fully_locked("menu lock");
}

static void test_the_host_lock_actually_locks(void)
{
    printf("== a host-requested lock drops the same things (T42)\n");
    unlocked_in_a_passphrase_wallet();

    /* What the protocol task does; the UI task picks it up on its next pass. */
    ui_request_lock();
    ui__service_host_lock_for_test();
    idle_pump();

    check_fully_locked("host lock");
}

static void test_the_autolock_timeout_locks(void)
{
    printf("== the auto-lock timeout drops the same things (T42)\n");
    unlocked_in_a_passphrase_wallet();

    fake_clock_advance_us(6 * 60 * 1000000LL);
    CHECK(ui__check_autolock_for_test(), "the device did not auto-lock");
    idle_pump();

    check_fully_locked("auto-lock");
}

/* Show Seed re-asks for the PIN so a reveal cannot ride on a session unlocked
 * minutes ago. It now locks fully, deliberately: asking "prove you are the
 * owner" while holding the decrypted mnemonic in RAM answers a different
 * question, and the correct PIN re-derives it anyway. */
static void test_show_seed_relocks_the_vault_too(void)
{
    printf("== Show Seed re-asks for the PIN with nothing left in RAM (S5/T42)\n");
    unlocked_in_a_passphrase_wallet();

    settings_goto("Show Seed");
    press(BUTTON_ACCEPT);

    check_fully_locked("show seed");

    /* And the request itself survives, or the item would do nothing. */
    CHECK(pin_verify("1234"), "could not re-enter the PIN");
    press(BUTTON_ACCEPT);
}


/* ============================================================================
 * T69 - the temporary seed
 *
 * The mode's whole claim is that nothing is stored. That property is asserted
 * against real NVS bytes in test_temp_seed.c, which links the real vault; what
 * belongs here is the half a user can see and act on: that the device says it
 * is in the mode, that it says what the mode costs before they type 24 words,
 * and that every way of leaving it actually leaves it.
 * ============================================================================ */

/* Walk the main menu to the item with this label and stop on it selected. The
 * temporary-seed entry moves as wallets appear and disappear, so the tests find
 * it by name rather than by index. */
static bool menu_goto(const char *label)
{
    go(SCREEN_MAIN_MENU);
    for (int guard = 0; guard < 12; guard++) {
        for (int row = 2; row <= 6; row += 2) {
            const char *r = fake_oled_row(row);
            if (r && r[0] == '>' && strstr(r, label)) {
                return true;
            }
        }
        press(BUTTON_DOWN);
    }
    CHECK(false, "the main menu has no item labelled \"%s\"", label);
    return false;
}

/* Menu -> warning -> twelve words, the way a user gets there. */
static void enter_temporary_seed(void)
{
    if (!menu_goto("Temp Seed")) {
        return;
    }
    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_TEMP_SEED, "the warning screen did not open");
    press(BUTTON_ACCEPT);
    CHECK(ui_get_screen() == SCREEN_MNEMONIC_ENTRY, "seed entry did not open");
    CHECK(ui__entry_is_temporary_for_test(), "entry is not marked temporary");

    press(BUTTON_ACCEPT);   /* 12 words, the default */

    char words[16][16];
    int n = 0;
    const char *p = PHRASE_12;
    while (*p && n < 16) {
        int k = 0;
        while (*p && *p != ' ' && k < 15) { words[n][k++] = *p++; }
        words[n][k] = '\0';
        n++;
        while (*p == ' ') { p++; }
    }
    /* The last word is the one that commits the phrase: mnemonic_entry_finish()
     * runs inside that press, clears the entry and changes screen, so
     * type_word() sees an emptied buffer and reports failure. What proves the
     * word landed there is the mode being on, not the word counter. */
    for (int i = 0; i < n; i++) {
        const bool last = (i == n - 1);
        if (!type_word(words[i]) && !last) {
            CHECK(false, "could not type word %d (\"%s\")", i + 1, words[i]);
            return;
        }
    }
    CHECK(wallet_has_temporary_mnemonic(),
          "the phrase was typed in full and the device did not adopt it");
}

static void test_temp_seed_warns_before_it_is_used(void)
{
    printf("== the temporary seed says what it costs before a word is typed (T69)\n");
    boot_unlocked_with_seed();

    CHECK(menu_goto("Temp Seed"), "the mode is not offered on the home screen");
    press(BUTTON_ACCEPT);

    /* Consequence one: it is not stored, and losing power loses it. */
    CHECK_SCREEN(fake_oled_contains("NOT saved"),
                 "the warning does not say the seed is not stored");
    CHECK_SCREEN(fake_oled_contains("reboot") && fake_oled_contains("erases"),
                 "the warning does not say a reboot destroys the seed");

    press(BUTTON_DOWN);
    /* Consequence two: the PIN is guarding nothing at rest, and the longer
     * auto-lock this mode runs on. */
    CHECK_SCREEN(fake_oled_contains("PIN guards nothing"),
                 "the warning does not say what the PIN is worth here");
    CHECK_SCREEN(fake_oled_contains("30 min"),
                 "the warning does not state this mode's auto-lock");

    /* And it is escapable without entering anything. */
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU, "CANCEL did not return to the menu");
    CHECK(!wallet_has_temporary_mnemonic(), "backing out started the mode anyway");
}

static void test_temp_seed_is_visible_on_screen(void)
{
    printf("== a temporary seed is named on screen, not merely in effect (T69)\n");
    boot_unlocked_with_seed();

    /* Typing it says so on every word, not only on the warning. */
    CHECK(menu_goto("Temp Seed"), "the mode is not offered");
    press(BUTTON_ACCEPT);
    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_contains("Temp seed"),
                 "the entry screen does not say which flow this is");
    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_row_contains(0, "TEMP word 1/12"),
                 "the word header reads \"%s\"", fake_oled_row(0));
    go(SCREEN_MAIN_MENU);

    enter_temporary_seed();
    CHECK(wallet_has_temporary_mnemonic(), "the seed was not adopted");
    CHECK(ui_get_screen() == SCREEN_WALLET_INFO,
          "the device did not land on the address screen");

    /* The address screen names the seed it derived from. "W1/1" here would be
     * a lie about a wallet that is not the one being signed with. */
    CHECK_SCREEN(fake_oled_row_contains(0, "TEMP"),
                 "the address screen reads \"%s\"", fake_oled_row(0));
    CHECK_SCREEN(!fake_oled_row_contains(0, "W1/1"),
                 "the address screen claims a stored wallet");
    /* A real, complete address off the typed seed - the mode has to be usable,
     * not merely announced. */
    CHECK_SCREEN(fake_oled_contains("0x"),
                 "no address was derived from the temporary seed");
    CHECK_SCREEN(fake_oled_contains("XFP"),
                 "no fingerprint - the user cannot tell which seed this is");

    go(SCREEN_MAIN_MENU);
    CHECK_SCREEN(fake_oled_row_contains(0, "TEMP"),
                 "the home screen does not say the device is in temporary mode: \"%s\"",
                 fake_oled_row(0));
    CHECK(menu_goto("End Temp Seed"), "there is no way out of the mode on the menu");
}

/* The stored wallet is untouched underneath: the temporary seed did not become
 * wallet 2, and it did not replace wallet 1. */
static void test_temp_seed_does_not_become_a_stored_wallet(void)
{
    printf("== a temporary seed never joins the stored wallets (T69)\n");
    boot_unlocked_with_seed();
    enter_temporary_seed();

    WalletStatus st = wallet_get_status();
    CHECK(st.wallet_count == 1, "the wallet count moved to %u", (unsigned)st.wallet_count);
    CHECK(st.active_wallet_index == 0,
          "a stored wallet is still selected (%u) while a temporary seed is in use",
          (unsigned)st.active_wallet_index);
    CHECK(!fake_wallet_backup_verified(1),
          "the stored wallet's backup state was rewritten");
}

/* Every way out. Each is checked through the same predicate, because "cleared"
 * has to mean the same thing on all of them. */
static void check_temp_seed_gone(const char *path)
{
    CHECK(!wallet_has_temporary_mnemonic(), "%s: the temporary seed survived", path);

    /* And nothing is deriving from it. While the vault is open that means a
     * stored wallet has taken over the selection; while it is locked it means
     * the vault answers nothing at all. Both are checked, because the paths
     * out of this mode are of both kinds. */
    WalletStatus st = wallet_get_status();
    if (st.unlocked) {
        CHECK(st.active_wallet_index != 0,
              "%s: the vault is open with no wallet selected - something is "
              "still deriving from a seed nobody named", path);
    } else {
        char leaked[256];
        CHECK(wallet_get_mnemonic(leaked, sizeof(leaked)) != WALLET_OK,
              "%s: a locked device still hands out a seed phrase", path);
        memzero(leaked, sizeof(leaked));
    }
}

static void test_temp_seed_every_clearing_path(void)
{
    printf("== every way out of temporary mode destroys the seed (T69)\n");

    /* 1. The deliberate exit, from the menu. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    CHECK(menu_goto("End Temp Seed"), "no exit on the menu");
    press(BUTTON_ACCEPT);
    check_fully_locked("end temp seed");
    check_temp_seed_gone("end temp seed");

    /* 2. CANCEL on the menu, the other deliberate lock. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    hold_back_to_lock(true);    /* a temporary seed is live: it must ask */
    check_fully_locked("menu lock");
    check_temp_seed_gone("menu lock");

    /* 3. Auto-lock. The one nobody presses, and the one that matters most:
     * here it destroys a seed that exists nowhere else. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    fake_clock_advance_us(31 * 60 * 1000000LL);
    CHECK(ui__check_autolock_for_test(), "the device did not auto-lock");
    idle_pump();
    check_fully_locked("auto-lock");
    check_temp_seed_gone("auto-lock");

    /* 4. A host-requested lock. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    ui_request_lock();
    ui__service_host_lock_for_test();
    idle_pump();
    check_temp_seed_gone("host lock");

    /* 5. Switching to a stored wallet. Not a lock, so the device stays
     * unlocked - which is exactly why the temporary seed has to go: two seeds
     * live at once is the ambiguous state this feature refuses to have. */
    boot_unlocked_with_seed();
    CHECK(fake_wallet_preload(PHRASE_12) == 2, "setup: could not preload a second seed");
    enter_temporary_seed();
    CHECK(wallet_select_wallet(1) == WALLET_OK, "could not switch wallets");
    check_temp_seed_gone("wallet switch");
    CHECK(wallet_get_status().active_wallet_index == 1, "the switch did not take effect");

    /* 6. A wipe. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    CHECK(wallet_wipe() == WALLET_OK, "the wipe failed");
    check_temp_seed_gone("wipe");
}

/* The longer default is this mode's, and only this mode's. A stored wallet's
 * timeout is the user's setting, before and after. */
static void test_temp_seed_autolock_is_scoped_to_the_mode(void)
{
    printf("== temporary mode lengthens its own auto-lock, and nothing else's (T69)\n");
    boot_unlocked_with_seed();

    const int before = ui__lock_timeout_choice_for_test();
    CHECK(before == 1, "the stored default is not 5 min (choice %d)", before);

    enter_temporary_seed();
    CHECK(ui__lock_timeout_choice_for_test() == 3,
          "temporary mode did not take the 30 min default (choice %d)",
          ui__lock_timeout_choice_for_test());
    CHECK(ui__lock_timeout_stored_choice_for_test() == 1,
          "the stored preference was overwritten - a stored wallet would now "
          "sit unlocked for 30 minutes too");

    /* Five idle minutes no longer lock it, which is the point of the change. */
    fake_clock_advance_us(6 * 60 * 1000000LL);
    CHECK(!ui__check_autolock_for_test(),
          "the temporary session locked at the stored wallet's timeout");
    CHECK(wallet_has_temporary_mnemonic(), "the seed was dropped anyway");

    /* And once it does lock, the user's own choice is what is back in force. */
    fake_clock_advance_us(31 * 60 * 1000000LL);
    CHECK(ui__check_autolock_for_test(), "the device never auto-locked");
    idle_pump();
    CHECK(ui__lock_timeout_choice_for_test() == 1,
          "the 30 min timeout outlived the temporary seed (choice %d)",
          ui__lock_timeout_choice_for_test());

    /* The user is still free to choose mid-session, and their choice sticks
     * rather than being reverted by the next lock. */
    boot_unlocked_with_seed();
    enter_temporary_seed();
    /* The row reads "Lock 30 min" - the label carries the value, which is
     * what makes the override visible in Settings as well. */
    settings_goto("Lock 30 min");
    press(BUTTON_ACCEPT);
    const int picked = ui__lock_timeout_choice_for_test();
    CHECK(picked == 0, "cycling from 30 min did not wrap to 1 min (choice %d)", picked);
    CHECK(ui__lock_timeout_stored_choice_for_test() == picked,
          "a choice made during a temporary session was not stored");
}

int main(void)
{
    test_blind_signing_takes_a_deliberate_act();
    test_blind_confirmation_is_marked_and_shows_the_digest();
    test_an_aqua_ship_shows_its_maker_and_every_leg();
    test_locking_closes_the_channel();
    test_an_expired_approval_leaves_the_screen();
    test_a_decoded_call_is_not_marked_blind();
    test_a_generic_call_shows_every_argument();
    test_message_confirmation_shows_all_of_it();
    test_typed_data_confirmation_names_the_contract_and_the_amount();
    test_blind_typed_data_leads_with_the_warning();
    test_the_signed_acknowledgement_actually_appears();
    test_host_passphrase_confirmation();
    test_harness_sees_the_screen();

    test_import_word_count_prompt();
    test_import_back_from_first_character();
    test_import_reaches_word_24();
    test_import_rejects_bad_checksum();

    test_seed_survives_the_display_verify_handoff();
    test_seed_survives_the_user_path_into_verification();
    test_seed_is_zeroed_on_leaving_the_flow();

    test_pin_explicit_submit();
    test_pin_wrong_spends_an_attempt();
    test_pin_digits_do_not_outlive_the_screen();

    test_failed_derivation_is_not_shown_as_an_address();
    test_qr_refuses_to_encode_an_error();
    test_qr_still_works_for_a_real_address();
    test_passphrase_confirmation_needs_an_address();

    test_settings_has_no_wifi_entry();

    test_settings_selects_one_transport();
    test_entropy_accept_only_proceeds();
    test_entropy_cancel_abandons();
    test_dice_counts_are_arithmetic();
    test_dice_roll_never_creates_a_wallet();
    test_dice_and_taps_compose();
    test_xfp_is_shown_with_the_address();
    test_xfp_tells_passphrase_wallets_apart();
    test_xfp_is_absent_when_it_cannot_be_derived();
    test_entry_style_drives_both_selectors();
    test_change_pin_is_reachable_and_works();
    test_change_pin_rejects_a_wrong_current_pin();
    test_change_pin_catches_a_mismatch();

    test_seed_generation_happens_behind_its_own_frame();
    test_leaving_the_create_screen_cancels_the_generation();

    test_autolock_drops_the_passphrase();
    test_switching_wallets_drops_the_passphrase();
    test_a_passphrase_change_under_the_wallet_screen_re_derives();

    test_the_account_is_selectable_and_bounded();
    test_the_wallet_screen_names_the_whole_path();
    test_the_account_survives_a_reboot();
    test_a_wipe_resets_the_account();
    test_the_signing_confirmation_shows_the_account();

    test_a_tap_on_back_does_not_lock();
    test_the_hold_shows_progress();
    test_a_hold_with_nothing_to_lose_locks_outright();
    test_the_confirmation_names_what_is_lost();
    test_the_menu_lock_actually_locks();
    test_the_host_lock_actually_locks();
    test_the_autolock_timeout_locks();
    test_show_seed_relocks_the_vault_too();

    test_temp_seed_warns_before_it_is_used();
    test_temp_seed_is_visible_on_screen();
    test_temp_seed_does_not_become_a_stored_wallet();
    test_temp_seed_every_clearing_path();
    test_temp_seed_autolock_is_scoped_to_the_mode();

    /* ---------------------------------------------------------------------
     * Seed creation talks to nothing.
     *
     * A host that cannot reach the device cannot observe or steer the seed,
     * and -- less obviously -- nothing else is drawing from the entropy gate
     * while the seed is drawn, which matters because bootloader_random_enable()
     * is not reference-counted and the protocol task exists whether or not a
     * link is selected.
     *
     * Asserted through the endpoint's own state rather than a flag of its own, so
     * the test fails if the suspend stops actually silencing the endpoint,
     * not merely if somebody renames something.
     */
    printf("== seed creation runs with both links down\n");
    {
        transport_set(TRANSPORT_USB);
        CHECK(fake_protocol_rx_enabled(), "USB should answer before seed creation");

        go(SCREEN_ENTROPY);
        CHECK(!fake_protocol_rx_enabled(),
              "the USB endpoint kept answering during seed creation");

        /* Every way out of the flow goes through the main menu, which is where
         * the link is restored -- including this one, cancelling. */
        go(SCREEN_MAIN_MENU);
        CHECK(fake_protocol_rx_enabled(), "the link was not restored after leaving");

        /* Suspending twice, and resuming what was never suspended, are both
         * no-ops: the resume sits on a screen reachable without ever having
         * created a wallet. */
        go(SCREEN_MAIN_MENU);
        CHECK(fake_protocol_rx_enabled(), "a second resume disturbed the link");
    }

    /* ---------------------------------------------------------------------
     * A deadline reads as a date.
     *
     * The screen used to show "valid until (unix)" and ten raw digits, on the
     * reasoning that a device with no clock cannot produce a date. It can: the
     * date is a function of the number, and only "how far away" needs the
     * present. It matters because a drainer's permit is far-future, and
     * 2000000000 against 1787950000 is not a difference anyone reads off a
     * 128x64 panel -- while 2033 against 2026 is.
     */
    printf("== a deadline is rendered as a date, not as seconds\n");
    {
        struct { const char *secs; int y, m, d; } ok[] = {
            { "0",            1970,  1,  1 },   /* the epoch itself */
            { "1735689600",   2025,  1,  1 },
            { "1787950000",   2026,  8, 28 },   /* a plausible near deadline */
            { "2000000000",   2033,  5, 18 },   /* the far-future one */
            { "253402300799", 9999, 12, 31 },   /* the last day it will express */
        };
        for (size_t i = 0; i < sizeof(ok) / sizeof(ok[0]); i++) {
            int y = 0, m = 0, d = 0;
            CHECK(unix_to_civil_date(ok[i].secs, &y, &m, &d),
                  "%s was refused", ok[i].secs);
            CHECK(y == ok[i].y && m == ok[i].m && d == ok[i].d,
                  "%s rendered as %04d-%02d-%02d, expected %04d-%02d-%02d",
                  ok[i].secs, y, m, d, ok[i].y, ok[i].m, ok[i].d);
        }

        /* Refused rather than guessed at, so the caller falls back to the raw
         * seconds instead of drawing a date nobody can justify. */
        const char *bad[] = { "", "12x4", "-1", "99999999999999999999",
                              "253402300800" /* one second past 9999 */ };
        for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
            int y = 0, m = 0, d = 0;
            CHECK(!unix_to_civil_date(bad[i], &y, &m, &d),
                  "\"%s\" was accepted as a date", bad[i]);
        }
    }

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
