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
#include "leek-wallet.h"

/* Test hooks from ui.c and pin.c (compiled with -DLEEK_HOST_TEST). */
void        pin__reset_static_state_for_test(void);
void        ui__reset_static_state_for_test(void);
const char *ui__mnemonic_buffer_for_test(void);
size_t      ui__mnemonic_buffer_size_for_test(void);
int         ui__mnemonic_word_count_for_test(void);
const char *ui__pin_entry_for_test(void);
int         ui__pin_cursor_for_test(void);
int         ui__pin_option_for_test(void);
const MnemonicEntry *ui__entry_for_test(void);
bool        ui__entry_choosing_length_for_test(void);
int         ui__entry_length_choice_for_test(void);

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

static void test_entropy_accept_only_proceeds(void)
{
    printf("== ACCEPT collects nothing and only ever proceeds (T61)\n");
    boot_unlocked_with_seed();
    go(SCREEN_ENTROPY);

    CHECK_SCREEN(fake_oled_contains("0 / 32"), "the pool did not start empty");
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
    CHECK_SCREEN(fake_oled_contains("0 / 32"),
                 "ACCEPT was counted as a sample");

    /* UP and DOWN are the samples. */
    press(BUTTON_UP);
    CHECK_SCREEN(fake_oled_contains("1 / 32"), "UP did not collect a sample");
    press(BUTTON_DOWN);
    CHECK_SCREEN(fake_oled_contains("2 / 32"), "DOWN did not collect a sample");

    for (int i = 2; i < 32; i++) {
        press(BUTTON_UP);
    }
    CHECK_SCREEN(fake_oled_contains("32 / 32"), "32 presses did not fill the pool");
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
    go(SCREEN_ENTROPY);

    for (int i = 0; i < 10; i++) {
        press(BUTTON_UP);
    }
    press(BUTTON_CANCEL);
    CHECK(ui_get_screen() == SCREEN_MAIN_MENU, "CANCEL did not leave the screen");

    /* And the half-full pool does not survive to be topped up later. */
    go(SCREEN_ENTROPY);
    CHECK_SCREEN(fake_oled_contains("0 / 32"), "the abandoned pool was kept");
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
    printf("== one Entry setting drives seed and passphrase entry (T60)\n");
    boot_unlocked_with_seed();

    CHECK(!mnemonic_entry_blocks_enabled() && !text_entry_blocks_enabled(),
          "the selectors did not start on the same default");

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
    CHECK(text_entry_blocks_enabled(),
          "the passphrase selector ignored the setting");

    /* And the passphrase screen actually behaves as a two-level selector:
     * ACCEPT opens a block instead of typing, and says so. */
    go(SCREEN_PASSPHRASE);
    CHECK_SCREEN(fake_oled_row_contains(7, "OPEN"),
                 "the footer still claims ACCEPT selects a character");
    CHECK_SCREEN(fake_oled_contains("a-f"), "the selector does not show blocks");

    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_contains("0 chars"), "opening a block typed a character");
    CHECK_SCREEN(fake_oled_row_contains(7, "SEL"),
                 "an open block still says OPEN");

    press(BUTTON_ACCEPT);
    CHECK_SCREEN(fake_oled_contains("1 chars"), "picking inside a block typed nothing");
    /* And the block closes again, so the next press means what the footer
     * says it means rather than what the last one did. */
    CHECK_SCREEN(fake_oled_row_contains(7, "OPEN"),
                 "the block stayed open after a character");

    /* Back to the default so the rest of the suite finds what it expects. */
    go(SCREEN_SETTINGS);
    for (int i = 0; i < 40; i++) {
        if (fake_oled_contains("> Entry ")) { press(BUTTON_ACCEPT); break; }
        press(BUTTON_DOWN);
    }
    CHECK(!text_entry_blocks_enabled(), "the setting would not turn off again");
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
    ui_request_sign_message(message, strlen(message), 3,
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

    ui_request_sign(&tx, 0, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
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
    ui_request_sign(&tx, 0, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
    go(SCREEN_SIGN_CONFIRM);
    press(BUTTON_CANCEL);
    CHECK(ui_sign_outcome() == SIGN_REJECTED, "CANCEL did not reject a blind call");
    ui_sign_clear();
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

    ui_request_sign(&tx, 0, "0x0100aaaaaaaabbbbbbbbccccccccddddddddeeee");
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

int main(void)
{
    test_blind_signing_takes_a_deliberate_act();
    test_blind_confirmation_is_marked_and_shows_the_digest();
    test_a_decoded_call_is_not_marked_blind();
    test_message_confirmation_shows_all_of_it();
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
    test_xfp_is_shown_with_the_address();
    test_xfp_tells_passphrase_wallets_apart();
    test_xfp_is_absent_when_it_cannot_be_derived();
    test_entry_style_drives_both_selectors();
    test_change_pin_is_reachable_and_works();
    test_change_pin_rejects_a_wrong_current_pin();
    test_change_pin_catches_a_mismatch();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
