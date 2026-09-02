/**
 * LeekWallet UI Framework
 * Screen state machine and rendering
 */

#include "ui.h"
#include <string.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"

#include "oled.h"
#include "button.h"
#include "pin.h"
#include "leek-wallet.h"
#include "mnemonic-entry.h"
#include "bip39.h"
#include "memzero.h"
#include "entropy.h"
#include "session.h"
#include "text-entry.h"
#include "eth-tx.h"
#include "eth-decode.h"
#include "blind-signing.h"
#include "sha3.h"
#include "device-wipe.h"
#include "transport.h"
#include "protocol.h"
#include "ble.h"
#include "ble-name.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"

/* For WiFi/BLE/USB testing - conditionally included */
#ifdef CONFIG_ESP_WIFI_ENABLED
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#endif

#ifdef CONFIG_BT_NIMBLE_ENABLED
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#elif defined(CONFIG_BT_ENABLED)
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"
#endif

#ifdef CONFIG_TINYUSB_ENABLED
#include "tinyusb.h"
#include "tusb_hid.h"
#endif

static const char *TAG = "ui";

/* Screen registry */
static const screen_t *screens[SCREEN_COUNT] = {NULL};
static screen_id_t current_screen = SCREEN_BOOT;
static bool needs_render = true;

/* Forward declarations for built-in screens */
static void screen_boot_enter(void);
static void screen_boot_render(void);
static void screen_boot_on_button(button_id_t btn);

static void screen_pin_setup_enter(void);
static void screen_pin_setup_render(void);
static void screen_pin_setup_on_button(button_id_t btn);

static void screen_pin_unlock_enter(void);
static void screen_pin_unlock_render(void);
static void screen_pin_unlock_on_button(button_id_t btn);

static void screen_main_menu_enter(void);
static void screen_main_menu_render(void);
static void screen_main_menu_on_button(button_id_t btn);

static void screen_wallet_info_enter(void);
static void screen_wallet_info_render(void);
static void screen_wallet_info_on_button(button_id_t btn);

static void screen_wallet_create_enter(void);
static void screen_wallet_create_render(void);
static void screen_wallet_create_on_button(button_id_t btn);

static void screen_wallet_select_enter(void);
static void screen_wallet_select_render(void);
static void screen_wallet_select_on_button(button_id_t btn);

static void screen_mnemonic_display_enter(void);
static void screen_mnemonic_display_render(void);
static void screen_mnemonic_display_on_button(button_id_t btn);

static void screen_mnemonic_entry_enter(void);
static void screen_mnemonic_entry_render(void);
static void screen_mnemonic_entry_on_button(button_id_t btn);

static void screen_settings_enter(void);
static void screen_settings_render(void);
static void screen_settings_on_button(button_id_t btn);

static void screen_entropy_enter(void);
static void screen_entropy_render(void);
static void screen_entropy_on_button(button_id_t btn);

static void screen_wipe_confirm_enter(void);
static void screen_wipe_confirm_render(void);
static void screen_wipe_confirm_on_button(button_id_t btn);

static void screen_lock_hold_enter(void);
static void screen_lock_hold_render(void);
static void screen_lock_hold_on_button(button_id_t btn);

static void screen_lock_confirm_render(void);
static void screen_lock_confirm_on_button(button_id_t btn);

static void screen_blind_warn_enter(void);
static void screen_blind_warn_render(void);
static void screen_blind_warn_on_button(button_id_t btn);

static void screen_mnemonic_verify_enter(void);
static void screen_mnemonic_verify_render(void);
static void screen_mnemonic_verify_on_button(button_id_t btn);

static void screen_session_confirm_enter(void);
static void screen_session_confirm_render(void);
static void screen_session_confirm_on_button(button_id_t btn);

static void screen_passphrase_enter(void);
static void screen_passphrase_render(void);
static void screen_passphrase_on_button(button_id_t btn);

static void screen_temp_seed_enter(void);
static void screen_temp_seed_render(void);
static void screen_temp_seed_on_button(button_id_t btn);

static void screen_ble_name_enter(void);
static void screen_ble_name_render(void);
static void screen_ble_name_on_button(button_id_t btn);

static void screen_passphrase_confirm_enter(void);
static void screen_passphrase_confirm_render(void);
static void screen_passphrase_confirm_on_button(button_id_t btn);

static void screen_sign_result_enter(void);
static void screen_sign_result_render(void);
static void screen_sign_result_on_button(button_id_t btn);

static void screen_sign_confirm_enter(void);
static void screen_sign_confirm_render(void);
static void screen_sign_confirm_on_button(button_id_t btn);

/* Secret-clearing exit hooks (AUDIT S5); defined with the buffers they own. */
static void forget_mnemonic_unless_needed(screen_id_t next);
static void forget_mnemonic_entry(screen_id_t next);
static void forget_pin_entry(screen_id_t next);
static void forget_passphrase_entry(screen_id_t next);

static void screen_qr_code_enter(void);
static void screen_qr_code_render(void);
static void screen_qr_code_on_button(button_id_t btn);

static const screen_t screen_sign_result = {
    .enter = screen_sign_result_enter,
    .render = screen_sign_result_render,
    .on_button = screen_sign_result_on_button,
    .exit = NULL
};

/* Built-in screen definitions */
static const screen_t screen_boot = {
    .enter = screen_boot_enter,
    .render = screen_boot_render,
    .on_button = screen_boot_on_button,
    .exit = NULL
};

static const screen_t screen_pin_setup = {
    .enter = screen_pin_setup_enter,
    .render = screen_pin_setup_render,
    .on_button = screen_pin_setup_on_button,
    .exit = forget_pin_entry
};

static const screen_t screen_pin_unlock = {
    .enter = screen_pin_unlock_enter,
    .render = screen_pin_unlock_render,
    .on_button = screen_pin_unlock_on_button,
    .exit = forget_pin_entry
};

static void screen_pin_change_enter(void);
static void screen_pin_change_render(void);
static void screen_pin_change_on_button(button_id_t btn);
static void screen_pin_change_exit(screen_id_t next);

static const screen_t screen_pin_change = {
    .enter = screen_pin_change_enter,
    .render = screen_pin_change_render,
    .on_button = screen_pin_change_on_button,
    .exit = screen_pin_change_exit
};

static const screen_t screen_main_menu = {
    .enter = screen_main_menu_enter,
    .render = screen_main_menu_render,
    .on_button = screen_main_menu_on_button,
    .exit = NULL
};

static const screen_t screen_wallet_info = {
    .enter = screen_wallet_info_enter,
    .render = screen_wallet_info_render,
    .on_button = screen_wallet_info_on_button,
    .exit = NULL
};

static const screen_t screen_wallet_create = {
    .enter = screen_wallet_create_enter,
    .render = screen_wallet_create_render,
    .on_button = screen_wallet_create_on_button,
    .exit = forget_mnemonic_unless_needed
};

static const screen_t screen_wallet_select = {
    .enter = screen_wallet_select_enter,
    .render = screen_wallet_select_render,
    .on_button = screen_wallet_select_on_button,
    .exit = NULL
};

static const screen_t screen_mnemonic_display = {
    .enter = screen_mnemonic_display_enter,
    .render = screen_mnemonic_display_render,
    .on_button = screen_mnemonic_display_on_button,
    .exit = forget_mnemonic_unless_needed
};

static const screen_t screen_mnemonic_entry = {
    .enter = screen_mnemonic_entry_enter,
    .render = screen_mnemonic_entry_render,
    .on_button = screen_mnemonic_entry_on_button,
    .exit = forget_mnemonic_entry
};

static const screen_t screen_settings = {
    .enter = screen_settings_enter,
    .render = screen_settings_render,
    .on_button = screen_settings_on_button,
    .exit = NULL
};

static const screen_t screen_entropy = {
    .enter = screen_entropy_enter,
    .render = screen_entropy_render,
    .on_button = screen_entropy_on_button,
    .exit = NULL
};

static const screen_t screen_wipe_confirm = {
    .enter = screen_wipe_confirm_enter,
    .render = screen_wipe_confirm_render,
    .on_button = screen_wipe_confirm_on_button,
    .exit = NULL
};

static const screen_t screen_lock_hold = {
    .enter = screen_lock_hold_enter,
    .render = screen_lock_hold_render,
    .on_button = screen_lock_hold_on_button,
    .exit = NULL
};

static const screen_t screen_lock_confirm = {
    .enter = NULL,
    .render = screen_lock_confirm_render,
    .on_button = screen_lock_confirm_on_button,
    .exit = NULL
};

static const screen_t screen_blind_warn = {
    .enter = screen_blind_warn_enter,
    .render = screen_blind_warn_render,
    .on_button = screen_blind_warn_on_button,
    .exit = NULL
};

static const screen_t screen_mnemonic_verify = {
    .enter = screen_mnemonic_verify_enter,
    .render = screen_mnemonic_verify_render,
    .on_button = screen_mnemonic_verify_on_button,
    .exit = forget_mnemonic_unless_needed
};

static const screen_t screen_session_confirm = {
    .enter = screen_session_confirm_enter,
    .render = screen_session_confirm_render,
    .on_button = screen_session_confirm_on_button,
    .exit = NULL
};

static const screen_t screen_passphrase = {
    .enter = screen_passphrase_enter,
    .render = screen_passphrase_render,
    .on_button = screen_passphrase_on_button,
    .exit = forget_passphrase_entry
};

static const screen_t screen_temp_seed = {
    .enter = screen_temp_seed_enter,
    .render = screen_temp_seed_render,
    .on_button = screen_temp_seed_on_button,
    .exit = NULL
};

static const screen_t screen_ble_name = {
    .enter = screen_ble_name_enter,
    .render = screen_ble_name_render,
    .on_button = screen_ble_name_on_button,
    .exit = NULL
};

static const screen_t screen_passphrase_confirm = {
    .enter = screen_passphrase_confirm_enter,
    .render = screen_passphrase_confirm_render,
    .on_button = screen_passphrase_confirm_on_button,
    .exit = NULL
};

static const screen_t screen_sign_confirm = {
    .enter = screen_sign_confirm_enter,
    .render = screen_sign_confirm_render,
    .on_button = screen_sign_confirm_on_button,
    .exit = NULL
};

static const screen_t screen_qr_code = {
    .enter = screen_qr_code_enter,
    .render = screen_qr_code_render,
    .on_button = screen_qr_code_on_button,
    .exit = NULL
};

/* ============================================================================
 * PIN Entry State
 * ============================================================================ */

#define PIN_DISPLAY_LEN PIN_MAX_LENGTH

/* The selector cycles 0-9 plus a submit option, so ACCEPT means "append the
 * highlighted digit" and submitting is a separate, deliberate act. Without it
 * the fourth digit doubled as submit and no PIN longer than the minimum could
 * ever be entered. */
#define PIN_OPTION_SUBMIT 10
#define PIN_OPTION_COUNT  11

static char pin_entry[PIN_MAX_LENGTH + 1] = {0};
static int pin_cursor = 0;
static bool pin_confirm_mode = false;
static char pin_first_entry[PIN_MAX_LENGTH + 1] = {0};
static int current_digit = 0;

/* Submit is only offered once the PIN is long enough to be valid. */
static bool pin_can_submit(void)
{
    return pin_cursor >= PIN_MIN_LENGTH;
}

static void pin_option_scroll(int dir)
{
    int n = pin_can_submit() ? PIN_OPTION_COUNT : 10;
    if (current_digit >= n) {
        current_digit = 0;
    }
    current_digit = ((current_digit + dir) % n + n) % n;
}

static void pin_option_text(int idx, char *out, size_t max)
{
    if (idx == PIN_OPTION_SUBMIT) {
        snprintf(out, max, "OK");
    } else {
        snprintf(out, max, "%d", idx);
    }
}

/* Render the selector with its neighbours, e.g. "8 <9> OK".
 *
 * Showing what comes next is what makes OK findable. With only the current
 * option on screen, OK sits one step past 9 with nothing hinting it exists, and
 * a user who never scrolls past 9 has no way to submit at all. */
static void pin_option_label(char *out, size_t max)
{
    int n = pin_can_submit() ? PIN_OPTION_COUNT : 10;
    if (current_digit >= n) {
        current_digit = 0;
    }

    char prev[4], cur[4], next[4];
    pin_option_text(((current_digit - 1) % n + n) % n, prev, sizeof(prev));
    pin_option_text(current_digit, cur, sizeof(cur));
    pin_option_text((current_digit + 1) % n, next, sizeof(next));

    snprintf(out, max, "%s <%s> %s", prev, cur, next);
}

static void pin_entry_reset(void)
{
    memset(pin_entry, 0, sizeof(pin_entry));
    pin_cursor = 0;
    current_digit = 0;
}

static void pin_entry_add_digit(int digit)
{
    if (pin_cursor < PIN_MAX_LENGTH) {
        pin_entry[pin_cursor] = '0' + digit;
        pin_cursor++;
        pin_entry[pin_cursor] = '\0';
    }
}

static void pin_entry_backspace(void)
{
    if (pin_cursor > 0) {
        pin_cursor--;
        pin_entry[pin_cursor] = '\0';
    }
}

/* ============================================================================
 * Menu State
 * ============================================================================ */

/* The menu is built per render rather than fixed.
 *
 * One seed is the recommended configuration (docs/VAULT.md), so "Select Wallet"
 * is noise until a second one exists - and a menu entry that does nothing is
 * worse than absent on a four-button device where every scroll costs a press. */
typedef enum {
    MENU_VIEW_ADDRESS,
    MENU_SELECT_WALLET,
    MENU_NEW_WALLET,
    MENU_IMPORT_WALLET,
    /* Temporary seed (T69). A menu action rather than a settings toggle, and
     * that is a security decision, not a layout one: a toggle leaves the device
     * in a state where stored wallets and a typed seed both exist and nothing
     * on screen settles which one is being signed with. Entering the mode is an
     * act with a beginning and an end, so it is a verb in the menu. */
    MENU_TEMP_SEED,
    /* And the way out, offered only while the mode is on. It locks - which is
     * the only way out there is, because ending temporary mode means destroying
     * the seed, and destroying the seed is what locking does. */
    MENU_END_TEMP,
    MENU_SETTINGS,
    MENU_ACTION_COUNT
} MenuAction;

#define MENU_MAX_ITEMS MENU_ACTION_COUNT

static MenuAction menu_actions[MENU_MAX_ITEMS];
static int menu_item_count = 0;
static int menu_selection = 0;

static const char *menu_action_label(MenuAction a)
{
    switch (a) {
        case MENU_VIEW_ADDRESS:  return "View Address";
        case MENU_SELECT_WALLET: return "Select Wallet";
        case MENU_NEW_WALLET:    return "New Wallet";
        case MENU_IMPORT_WALLET: return "Import Wallet";
        case MENU_TEMP_SEED:     return "Temp Seed";
        case MENU_END_TEMP:      return "End Temp Seed";
        case MENU_SETTINGS:      return "Settings";
        default:                 return "?";
    }
}

static void menu_rebuild(void)
{
    WalletStatus status = wallet_get_status();
    menu_item_count = 0;

    const bool temp = wallet_has_temporary_mnemonic();

    if (status.wallet_count > 0 || temp) {
        menu_actions[menu_item_count++] = MENU_VIEW_ADDRESS;
    }
    if (status.wallet_count > 1 || (temp && status.wallet_count > 0)) {
        menu_actions[menu_item_count++] = MENU_SELECT_WALLET;
    }

    /* Unlike New/Import below, this stays on the home screen whatever is
     * stored. It is the whole feature: a user who wants to sign with a seed
     * this device must never keep should not have to go looking for the option
     * under Settings, and a careless press costs them a warning screen and a
     * seed phrase they would have to type in full. */
    if (temp) {
        menu_actions[menu_item_count++] = MENU_END_TEMP;
    } else {
        menu_actions[menu_item_count++] = MENU_TEMP_SEED;
    }

    /* Creating or importing a seed is only a top-level action on a device that
     * has none. Once one exists, those entries sit one careless press from
     * generating a wallet the user then mistakes for theirs, and no established
     * hardware wallet offers them from the home screen either - you reset the
     * device instead. They remain available under Settings. */
    if (status.wallet_count == 0) {
        menu_actions[menu_item_count++] = MENU_NEW_WALLET;
        menu_actions[menu_item_count++] = MENU_IMPORT_WALLET;
    }

    menu_actions[menu_item_count++] = MENU_SETTINGS;

    if (menu_selection >= menu_item_count) {
        menu_selection = menu_item_count - 1;
    }
    if (menu_selection < 0) {
        menu_selection = 0;
    }
}

/* ============================================================================
 * Wallet State
 * ============================================================================ */

static EthAddress eth_address;

/* Which address of the active wallet is shown: m/44'/60'/0'/0/<index>.
 * Ten is arbitrary but covers ordinary use; the derivation itself is unbounded
 * and the limit exists only to keep UP/DOWN a short cycle. */
#define ADDRESS_INDEX_COUNT 10
static uint32_t address_index = 0;

/* Which account of the active seed everything on this device derives from
 * (T45): m/44'/60'/<hd_account>'/0/<address_index>.
 *
 * Why this is persisted and address_index is not, even though both are
 * selections rather than secrets. The address index is browsing: the user
 * walks it to find a receiving address and the walk has no meaning tomorrow.
 * The account is *which identity is in use* — the same role active_idx plays
 * for seeds — and a device that silently reverts to account 0 after a reboot
 * shows a different address for the same wallet, which reads as funds having
 * vanished. So the account persists like active_idx, and the index restarts
 * at 0 whenever the wallet or the account changes, because it indexes into
 * something that just changed underneath it.
 *
 * Bounded by HD_ACCOUNT_COUNT on this device's own screens; see ui.h for why
 * the bound is a UI bound and not a derivation one. */
static uint32_t hd_account = 0;

/* The path everything on the device browses at. Built in one place so the
 * address screen, the QR screen and the account selector cannot drift into
 * deriving from three different paths — which is the failure mode T47 was
 * about, one level up. */
static HDPath hd_path_at(uint32_t index)
{
    HDPath path = HDPATH_ETH_DEFAULT;
    path.account = hd_account;
    path.address_index = index;
    return path;
}

/* "m/44'/60'/0'/0/0" — 16 characters at the defaults, and the display is 21
 * columns wide, so the ordinary case is never truncated. A host-chosen account
 * or index large enough to overflow that would be truncated by snprintf, which
 * is why the caller renders it on a row of its own with nothing after it. */
static void format_hd_path(char *out, size_t size, const HDPath *path)
{
    snprintf(out, size, "m/%u'/%u'/%u'/%u/%u",
             (unsigned)path->purpose, (unsigned)path->coin_type,
             (unsigned)path->account, (unsigned)path->change,
             (unsigned)path->address_index);
}
static char mnemonic_buffer[256];
static int mnemonic_word_count = 0;

/* Set when the seed display is gated behind a fresh PIN entry. Declared here
 * because auto-lock clears it, and auto-lock is defined above its old home. */
static bool pending_mnemonic_display = false;
static int mnemonic_page = 0;  /* Current page (3 words per page) */
static int wallet_list_selection = 0;

/* Create wallet state */
static int create_word_count = 12;  /* 12 or 24 */
/* Set when the entropy screen has met the gate for the chosen length, so the
 * create screen knows it is being re-entered to finish rather than to ask
 * again. Cleared by the menu on the way in, which is the only path that starts
 * a new wallet. */
static bool create_entropy_ready = false;
static bool create_show_mnemonic = false;
static char create_error[32] = {0};

/* Set by the button handler, consumed by ui_poll_deferred() (AUDIT S8f).
 *
 * Generating a seed unlocks the vault and runs BIP39 — a second or more on
 * this silicon, with the UI task blocked throughout — so the user has to be
 * told it started. The old code told them by calling ui_render() from inside
 * the button handler: a second render path into a screen that was already
 * mid-transition, so a repaint arriving from anywhere else could redraw a
 * screen whose state had half-changed, and the flush ordering depended on
 * which of the two paths ran last. Setting a flag instead keeps exactly one
 * render path — the loop's — and the work happens after the frame is on the
 * panel, which is what the ui_render() call was reaching for. */
static bool create_generate_pending = false;

/* Mnemonic entry state - logic lives in mnemonic-entry.c so it can be tested
 * on the host without an ESP32 attached (see sim/). */
static MnemonicEntry entry;
static char entry_error[20] = {0};

/* Import starts by asking how long the phrase is (T3, AUDIT S8d).
 *
 * The entry logic has always handled 24 words; there was simply no way to say
 * so, which made every 24-word backup unimportable. Asking first rather than
 * inferring: a 24-word phrase typed into a 12-word target silently imports the
 * wrong wallet at word 12, and the checksum makes that look like a typing
 * error rather than the wrong question. */
static bool entry_choosing_length = true;
static int  entry_length_choice = 12;

/* Whether the phrase being typed is destined for storage or for this session
 * only (T69). The two flows are the same keystrokes over the same buffers and
 * differ in exactly one place - what mnemonic_entry_finish() hands the phrase
 * to - so they share a screen rather than being copied. The screen still says
 * which one it is on every frame, because the difference between them is
 * whether the user's seed survives the next reboot. */
static bool entry_is_temporary = false;

/* ============================================================================
 * Leaving a screen that held a secret (AUDIT S5, T6)
 *
 * `wallet_lock()` is careful with the seed; the UI layer above it was not. The
 * plaintext mnemonic sat in `mnemonic_buffer` from the moment it was displayed
 * until some later screen happened to overwrite it - across lock, across a
 * wipe, and into any crash dump or JTAG pause taken in between. "Wipe Device"
 * left the seed in RAM until the next reboot.
 *
 * These hooks close that window at the only moment that is both well-defined
 * and cheap: the screen transition.
 * ============================================================================ */

/* The seed-creation flow hands the buffer back and forth between showing the
 * words and checking the user wrote them down. Within that group the mnemonic
 * is still live; leaving it, it is not. */
static bool mnemonic_still_needed_by(screen_id_t next)
{
    return next == SCREEN_MNEMONIC_DISPLAY || next == SCREEN_MNEMONIC_VERIFY;
}

static void forget_mnemonic_unless_needed(screen_id_t next)
{
    if (mnemonic_still_needed_by(next)) {
        return;
    }
    memzero(mnemonic_buffer, sizeof(mnemonic_buffer));
    mnemonic_word_count = 0;
    mnemonic_page = 0;

    /* And the copy nobody in this file owns. mnemonic_from_data() builds the
     * phrase in a file-scope `static CONFIDENTIAL char mnemo[240]` inside
     * bip39.c and returns a pointer into it; wallet_create_mnemonic() copies
     * out of that pointer, so every generated seed leaves a second plaintext
     * copy behind. mnemonic_clear() exists to wipe it and was called from
     * nowhere in this firmware, which left a freshly generated phrase sitting
     * in RAM until reboot - through lock, through wipe, into any crash dump or
     * JTAG halt taken in between.
     *
     * Here is the right place rather than immediately after generation, for the
     * same reason mnemonic_buffer is cleared here: this hook is the one moment
     * that is both well-defined and known to be past the last reader. The
     * import path reaches it too, which is free - clearing a buffer that
     * already holds zeros costs nothing and means no future caller of
     * mnemonic_from_data() can reintroduce the leak by taking a different route
     * out of these screens. */
    mnemonic_clear();
}

/* The import screen's word buffer. Nothing downstream reads it - the built
 * mnemonic goes straight into the wallet and is zeroed there - so this can go
 * unconditionally. */
static void forget_mnemonic_entry(screen_id_t next)
{
    (void)next;
    mnemonic_entry_clear(&entry);
    memzero(entry_error, sizeof(entry_error));
    entry_choosing_length = true;
    entry_is_temporary = false;
}

/* The digits as typed. `pin.c` keeps its own verified copy for wallet
 * encryption and clears that on lock; this is the UI's transcript of the
 * keypresses and no one needs it after the screen is gone. */
static void forget_pin_entry(screen_id_t next)
{
    (void)next;
    memzero(pin_entry, sizeof(pin_entry));
    memzero(pin_first_entry, sizeof(pin_first_entry));
    pin_cursor = 0;
    current_digit = 0;
    pin_confirm_mode = false;
}

/* ============================================================================
 * Auto-lock
 *
 * Locking clears secrets, not preferences. Two kinds of state exist after an
 * unlock and they must be treated differently:
 *
 *   Secret   - passphrase, decrypted mnemonic, cached seed. Cleared on lock,
 *              because that is what locking is for. Keeping the passphrase
 *              across a lock would mean the PIN alone reopens a hidden wallet,
 *              which removes the second factor entirely.
 *
 *   Selection - which wallet, which address index. Not secret, already stored
 *              in NVS, and losing it on every lock is pure annoyance. Kept.
 * ============================================================================ */

/* 1, 5, 10 or 30 minutes. Trezor and Ledger both default to 10; 5 is chosen
 * here because a device meant for cold storage is idle far more often than it
 * is used, and the cost of being wrong in that direction is one PIN entry.
 *
 * There is deliberately no "never". A wallet that stays unlocked indefinitely
 * is a footgun, and 30 minutes is long enough for bench work. */
static const uint32_t LOCK_TIMEOUT_CHOICES[] = { 60, 300, 600, 1800 };
#define LOCK_TIMEOUT_COUNT (sizeof(LOCK_TIMEOUT_CHOICES) / sizeof(LOCK_TIMEOUT_CHOICES[0]))

static int      lock_timeout_choice = 1;   /* default 5 minutes */

/* What NVS holds, which is not always what is in force (T69).
 *
 * A temporary seed changes what a lock costs. With a stored wallet, locking
 * costs one PIN entry; with a seed that exists only in RAM, it costs the seed
 * and up to 24 words to type it again. So temporary mode runs on a longer
 * default - and only temporary mode does, which is why the override lives in
 * a second variable instead of being written to flash. Nothing about a stored
 * wallet's timeout changes, and the user's own choice comes back untouched the
 * moment the temporary seed is gone. */
static int      lock_timeout_stored_choice = 1;

/* 30 minutes, the longest offer, as this mode's default. Chosen by the owner:
 * re-entering a 24-word phrase every five idle minutes is the kind of friction
 * that ends with the seed being stored after all. Every other choice stays
 * reachable in Settings while the mode is on. */
#define LOCK_TIMEOUT_TEMP_SEED 3

static int64_t  last_activity_us = 0;

/* Settings are persisted separately from the vault: they are not secret, and
 * they must survive a wipe of neither more nor less than the wallet does. */
#define UI_NVS_NAMESPACE "leek_ui"
#define UI_KEY_LOCK_TIMEOUT "lock_to"
#define UI_KEY_BRIGHTNESS   "bright"
#define UI_KEY_ENTRY_BLOCKS "wblocks"
/* The selected BIP44 account (T45). Not secret — it is in every watch-only
 * descriptor — and stored beside the other selections rather than in the
 * vault, so it survives a lock exactly as the active wallet index does. */
#define UI_KEY_ACCOUNT      "acct"

/* Four steps rather than a slider: the OLED is legible across the whole range,
 * so fine control buys nothing and costs presses. Low is genuinely useful -
 * a dim screen is harder to read over someone's shoulder. */
static const uint8_t BRIGHTNESS_LEVELS[] = { 0x10, 0x50, 0xA0, 0xFF };
#define BRIGHTNESS_COUNT (sizeof(BRIGHTNESS_LEVELS) / sizeof(BRIGHTNESS_LEVELS[0]))
static int brightness_choice = 2;

static const char *brightness_label(int choice)
{
    switch (choice) {
        case 0:  return "Low";
        case 1:  return "Mid";
        case 2:  return "High";
        case 3:  return "Max";
        default: return "?";
    }
}

/* One setting, both selectors (T60).
 *
 * The seed-word selector and the passphrase selector are the same two-level
 * control over different alphabets, and a mode on four unlabelled buttons is a
 * real cost. A user who has decided how they want to be asked for letters has
 * decided it for both screens, so "Entry: Simple/Blocks" drives both and there
 * is deliberately no second preference to get out of step with this one. */
/* The setting drives the seed selector only.
 *
 * Blocks are measurably faster on both screens - 9.1 presses per character
 * against 14.4 on the passphrase ring - and were reported worse to use there
 * anyway. The reason they differ is structural rather than a matter of taste.
 * Seed entry offers one dimension: 26 letters, narrowing as you type. The
 * passphrase ring already has a mode dimension on top of its ~95 characters,
 * so adding blocks makes it three levels of navigation on four unlabelled
 * buttons - open a block, pick a character, and separately remember which
 * character set you are in.
 *
 * So the passphrase keeps the flat ring, which still improved: it now offers
 * the two sets you are NOT in, which is where most of its gain came from.
 * Fewer presses is not the only axis, and a passphrase typed wrong is worse
 * than a passphrase typed slowly. */
static void entry_blocks_apply(bool enabled)
{
    mnemonic_entry_set_blocks(enabled);
    text_entry_set_blocks(false);
}

static void settings_load(void)
{
    nvs_handle_t nvs;
    if (nvs_open(UI_NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;   /* never saved; keep the defaults */
    }

    uint8_t stored = 0;
    if (nvs_get_u8(nvs, UI_KEY_LOCK_TIMEOUT, &stored) == ESP_OK &&
        stored < LOCK_TIMEOUT_COUNT) {
        lock_timeout_choice = (int)stored;
        lock_timeout_stored_choice = (int)stored;
    }
    if (nvs_get_u8(nvs, UI_KEY_BRIGHTNESS, &stored) == ESP_OK &&
        stored < BRIGHTNESS_COUNT) {
        brightness_choice = (int)stored;
    }
    if (nvs_get_u8(nvs, UI_KEY_ENTRY_BLOCKS, &stored) == ESP_OK) {
        entry_blocks_apply(stored != 0);
    }
    /* Range-checked on the way in, not just on the way out. A byte outside the
     * menu's range would leave the device deriving from an account no screen
     * can reach or re-select, which is precisely the "shows a different wallet
     * than you think" failure the path row exists to prevent. */
    if (nvs_get_u8(nvs, UI_KEY_ACCOUNT, &stored) == ESP_OK &&
        stored < HD_ACCOUNT_COUNT) {
        hd_account = stored;
    }
    nvs_close(nvs);
}

static void brightness_apply_and_save(void)
{
    oled_set_contrast(BRIGHTNESS_LEVELS[brightness_choice]);

    nvs_handle_t nvs;
    if (nvs_open(UI_NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_u8(nvs, UI_KEY_BRIGHTNESS, (uint8_t)brightness_choice);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

/* Which selector the seed-entry screen uses. Persisted because the answer is a
 * preference about how the buttons behave, and re-choosing it every time would
 * be its own small tax. */
static void entry_blocks_save(void)
{
    nvs_handle_t nvs;
    if (nvs_open(UI_NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_u8(nvs, UI_KEY_ENTRY_BLOCKS,
                   mnemonic_entry_blocks_enabled() ? 1 : 0);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

/* Persisting the account, and resetting the address index with it.
 *
 * The reset is not politeness: index 3 of account 0 and index 3 of account 1
 * are unrelated addresses, so carrying the index across a change would leave
 * the screen at an address the user never chose in an account they just
 * entered. Callers change the account through here for that reason. */
uint32_t ui_hd_account(void)
{
    return hd_account;
}

static void hd_account_set(uint32_t account)
{
    hd_account = account % HD_ACCOUNT_COUNT;
    address_index = 0;

    nvs_handle_t nvs;
    if (nvs_open(UI_NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist the account selection");
        return;
    }
    nvs_set_u8(nvs, UI_KEY_ACCOUNT, (uint8_t)hd_account);
    nvs_commit(nvs);
    nvs_close(nvs);
}

/* The cached BIP32 master fingerprint, as eight hex characters, or "" when
 * there is none to show. Lives up here because locking has to be able to drop
 * it; the reasoning about what it is for is with refresh_master_xfp(). */
static char master_xfp[9] = {0};

/* Whether a passphrase was applied when the address and fingerprint currently
 * on the wallet screen were derived (T42).
 *
 * The screen derives on entry and then sits there. A host can set or clear a
 * passphrase over the wire, and a lock can drop one, while it sits — leaving
 * an address and an XFP that belong to a wallet that is no longer selected.
 * That is the stale-passphrase failure in its most direct form: the user reads
 * a receive address off a screen the device would no longer produce. So the
 * derived-at state is recorded here and checked by ui_poll_deferred(). */
static bool wallet_info_passphrase_shown = false;

/* Lock the device. The ONLY way this file locks anything.
 *
 * Reported from hardware: the user pressed "Lock device" on the main menu,
 * entered their PIN again, and was still in their passphrase wallet. The menu
 * item called pin_lock() and nothing else, so the PIN gate closed over a vault
 * that stayed open - passphrase, decrypted mnemonic, cached seed and derived
 * node all still in RAM and still applied. Auto-lock and the host lock did
 * call wallet_lock(), which is why it survived: the lock a user reaches for
 * deliberately was the one that did not lock.
 *
 * Each of pin_lock() and wallet_lock() was individually correct. What was
 * wrong was that four call sites each had to remember both, and one did not.
 * So there is now one function, it is what every path calls, and "locked"
 * means the same thing everywhere:
 *
 *   - the PIN gate is closed (pin_lock)
 *   - the vault is shut and the passphrase, mnemonic and seed cache are zeroed
 *     (wallet_lock) - this is the T42 rule, because keeping a passphrase
 *     across a lock means the PIN alone reopens a hidden wallet
 *   - the UI's own copies of the seed go with them
 *   - the cached fingerprint goes too. It names the seed the passphrase
 *     produced, and a fingerprint outliving its passphrase is the same bug in
 *     a quieter form: the next screen to draw it would vouch for a wallet the
 *     device can no longer derive.
 *
 * What survives is what a lock is not for: which wallet, which account, which
 * address index. All three are selections, not secrets, and all three are
 * already in NVS. */
static void lock_device(void)
{
    pin_lock();
    wallet_lock();

    pending_mnemonic_display = false;
    memzero(mnemonic_buffer, sizeof(mnemonic_buffer));
    mnemonic_word_count = 0;
    mnemonic_page = 0;

    memzero(master_xfp, sizeof(master_xfp));
    wallet_info_passphrase_shown = false;

    /* wallet_lock() has just destroyed any temporary seed, so the longer
     * timeout it justified goes with it. The user's own preference is what is
     * left, and it was never overwritten. */
    lock_timeout_choice = lock_timeout_stored_choice;

    /* And the channel goes too.
     *
     * Locking used to leave the encrypted session up: the wallet closed, the
     * host kept talking, and a user who came back and entered their PIN
     * resumed on a session they had authorised before the lock -- possibly
     * hours before, with the device unattended in between. Seen on hardware,
     * where the companion carried on polling for two minutes after an
     * auto-lock.
     *
     * A lock is the deliberate hammer, so it should mean what a user assumes:
     * wallet away, channel closed, and a returning host compares six fresh
     * digits. That costs a handshake and never a retyped seed phrase -- which
     * is precisely why this belongs here and not in the idle timeout, whose
     * whole point is to be the weaker of the two.
     *
     * Here rather than at the five call sites because they have disagreed
     * before: this one shipped calling pin_lock() alone and left the vault
     * open underneath the PIN gate. */
    session_reset();
}

static void lock_timeout_save(void)
{
    nvs_handle_t nvs;
    if (nvs_open(UI_NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist the auto-lock setting");
        return;
    }
    nvs_set_u8(nvs, UI_KEY_LOCK_TIMEOUT, (uint8_t)lock_timeout_choice);
    nvs_commit(nvs);
    nvs_close(nvs);

    /* Whatever the user picks becomes their standing preference, including one
     * picked while a temporary seed is in use. Otherwise the restore on lock
     * would quietly undo a setting they had just chosen. */
    lock_timeout_stored_choice = lock_timeout_choice;
}

static const char *lock_timeout_label(int choice)
{
    switch (choice) {
        case 0:  return "1 min";
        case 1:  return "5 min";
        case 2:  return "10 min";
        case 3:  return "30 min";
        default: return "?";
    }
}

static void lock_note_activity(void)
{
    last_activity_us = esp_timer_get_time();
}

/* Called from the UI task. Returns true if the device just auto-locked. */
static bool lock_check_timeout(void)
{
    uint32_t seconds = LOCK_TIMEOUT_CHOICES[lock_timeout_choice];
    if (!pin_is_unlocked()) {
        return false;
    }

    int64_t idle_us = esp_timer_get_time() - last_activity_us;
    if (idle_us < (int64_t)seconds * 1000000) {
        return false;
    }

    ESP_LOGI(TAG, "Auto-lock after %u s idle", (unsigned)seconds);
    /* address_index, the account and the active wallet survive deliberately;
     * everything else lock_device() drops. */
    lock_device();
    ui_set_screen(SCREEN_PIN_UNLOCK);
    return true;
}

/* Settings, ordered by how often they are wanted and how much they cost when
 * chosen by accident: wallet actions first, diagnostics next, wipe last. */
typedef enum {
    SET_SHOW_SEED,
    SET_NEW_WALLET,
    SET_IMPORT_WALLET,
    SET_PASSPHRASE,
    /* Next to the passphrase deliberately (T45). Both answer the same question
     * — "which wallet am I in?" — and neither is browsing, which is why the
     * account is not a fifth thing for UP/DOWN to mean on the address screen.
     * All four buttons there already do something, and stealing one would cost
     * either the QR code or address browsing to save a menu entry. */
    SET_ACCOUNT,
    SET_BRIGHTNESS,
    SET_AUTOLOCK,
    SET_ENTRY_STYLE,
    SET_CHANGE_PIN,
/* The Wi-Fi AP is a test fixture, not a feature (AUDIT S8g). It brings up an
 * access point with a hardcoded password on a device holding seeds, so it is
 * compiled out unless a build asks for it. The enum and the label array below
 * are positional and guarded together, which is what keeps them in step. */
#ifdef CONFIG_ESP_WIFI_ENABLED
    SET_WIFI,
#endif
    SET_TRANSPORT,
    SET_BLE_NAME,
    SET_USB,
    /* Next to Wipe, and for the same reason: both are things you should have
     * to scroll past everything else to reach. */
    SET_BLIND,
    SET_WIPE,
    SET_BACK,
    SETTINGS_ITEMS
} SettingsAction;

static const char *settings_items[SETTINGS_ITEMS] = {
    "Show Seed",
    "New Wallet",
    "Import Wallet",
    "Passphrase",
    "Account",
    "Brightness",
    "Auto-lock",
    "Word entry",
    "Change PIN",
#ifdef CONFIG_ESP_WIFI_ENABLED
    "WiFi Test",
#endif
    "Link",
    "BLE Name",
    "USB HID Test",
    "Blind sign",
    "Wipe Device",
    "Back"
};
static int settings_selection = 0;
static bool wifi_enabled = false;

/* ============================================================================
 * Helper: Unlock wallet with PIN
 * ============================================================================ */

static bool ensure_wallet_unlocked(void)
{
    WalletStatus status = wallet_get_status();

    /* Reinitialize if not initialized (e.g., after wipe) */
    if (!status.initialized) {
        ESP_LOGI(TAG, "Wallet not initialized, initializing...");
        wallet_init();
        status = wallet_get_status();
    }

    if (!status.unlocked) {
        char pin[PIN_MAX_LENGTH + 1];
        if (!pin_get_current(pin, sizeof(pin))) {
            ESP_LOGE(TAG, "No PIN available");
            return false;
        }

        /* First time: set password, subsequent: unlock. The stack copy is
         * zeroed on every path out: pin.c keeps the one authoritative copy and
         * clears it on lock, and a second one left in this frame would outlive
         * that lock in whatever called us next. */
        if (!status.password_set) {
            WalletError err = wallet_set_password(pin, strlen(pin));
            if (err != WALLET_OK) {
                ESP_LOGE(TAG, "Failed to set wallet password: %d", err);
                memzero(pin, sizeof(pin));
                return false;
            }
        }

        WalletError err = wallet_unlock(pin, strlen(pin));
        memzero(pin, sizeof(pin));
        if (err != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to unlock wallet: %d", err);
            button_drain();
            return false;
        }
    }

    /* Key derivation blocks for roughly a second and a half - a PIN entry runs
     * PBKDF2 three times, once here in pin_verify() and twice inside
     * wallet_unlock() (see docs/AUDIT-SECRETS-2.md N1). Drop anything pressed
     * while the screen was frozen. */
    button_drain();
    return true;
}

/* ============================================================================
 * Helper: Parse mnemonic into word count
 * ============================================================================ */

static int count_mnemonic_words(const char *mnemonic)
{
    int count = 0;
    const char *p = mnemonic;

    while (*p) {
        /* Skip whitespace */
        while (*p == ' ') p++;
        if (*p == '\0') break;

        /* Count word */
        count++;

        /* Skip to next whitespace */
        while (*p && *p != ' ') p++;
    }

    return count;
}

/* ============================================================================
 * Helper: Get word N from mnemonic
 * ============================================================================ */

static bool get_mnemonic_word(const char *mnemonic, int index, char *word_out, size_t max_len)
{
    int count = 0;
    const char *p = mnemonic;

    while (*p) {
        /* Skip whitespace */
        while (*p == ' ') p++;
        if (*p == '\0') break;

        if (count == index) {
            /* Found the word - copy it */
            size_t i = 0;
            while (*p && *p != ' ' && i < max_len - 1) {
                word_out[i++] = *p++;
            }
            word_out[i] = '\0';
            return true;
        }

        /* Skip to next whitespace */
        while (*p && *p != ' ') p++;
        count++;
    }

    return false;
}

/* ============================================================================
 * Boot Screen
 * ============================================================================ */

static void screen_boot_enter(void)
{
    ESP_LOGI(TAG, "Boot screen");
}

static void screen_boot_render(void)
{
    oled_clear();
    oled_draw_string_centered(1, "LeekWallet");
    oled_draw_string_centered(3, "v0.3");
    oled_draw_string_centered(6, "Press any key");
}

static void screen_boot_on_button(button_id_t btn)
{
    (void)btn;

    /* Initialize subsystems and determine next screen */
    pin_init();
    pending_mnemonic_display = false;  /* Clear any pending state */

    if (!pin_is_set()) {
        /* First boot - need to set up PIN */
        ui_set_screen(SCREEN_PIN_SETUP);
    } else if (pin_should_wipe()) {
        /* Attempts were exhausted but the wipe did not complete - most likely
         * power was cut between the two. Finish it now, before offering any
         * further attempts, otherwise a reboot resets the counter. */
        ESP_LOGW(TAG, "Resuming interrupted wipe");
        device_wipe();
        wallet_init();
        ui_set_screen(SCREEN_PIN_SETUP);
    } else {
        /* PIN is set - need to unlock */
        ui_set_screen(SCREEN_PIN_UNLOCK);
    }
}

/* ============================================================================
 * PIN Setup Screen
 * ============================================================================ */

static void screen_pin_setup_enter(void)
{
    ESP_LOGI(TAG, "PIN setup screen");
    pin_entry_reset();
    pin_confirm_mode = false;
    memset(pin_first_entry, 0, sizeof(pin_first_entry));
}

static void screen_pin_setup_render(void)
{
    oled_clear();

    if (!pin_confirm_mode) {
        oled_draw_string_centered(0, "Set New PIN");
    } else {
        oled_draw_string_centered(0, "Confirm PIN");
    }

    /* Draw the selector (digit, or OK once the PIN is long enough) */
    char digit_line[22];
    pin_option_label(digit_line, sizeof(digit_line));
    oled_draw_string_centered(2, digit_line);

    /* Draw PIN display with asterisks */
    char display[PIN_DISPLAY_LEN + 3];
    display[0] = '[';
    for (int i = 0; i < PIN_DISPLAY_LEN; i++) {
        if (i < pin_cursor) {
            display[i + 1] = '*';
        } else {
            display[i + 1] = '_';
        }
    }
    display[PIN_DISPLAY_LEN + 1] = ']';
    display[PIN_DISPLAY_LEN + 2] = '\0';
    oled_draw_string_centered(4, display);

    /* Show progress */
    char progress[22];
    if (pin_can_submit()) {
        snprintf(progress, sizeof(progress), "%d digits, pick OK", pin_cursor);
    } else {
        snprintf(progress, sizeof(progress), "%d of %d min", pin_cursor, PIN_MIN_LENGTH);
    }
    oled_draw_string_centered(5, progress);

    /* Draw instructions */
    oled_draw_string(7, 0, "UP DN  DEL  SEL");
}

static void screen_pin_setup_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            pin_option_scroll(1);
            break;

        case BUTTON_DOWN:
            pin_option_scroll(-1);
            break;

        case BUTTON_CANCEL:
            if (pin_cursor > 0) {
                pin_entry_backspace();
                current_digit = 0;
            }
            break;

        case BUTTON_ACCEPT:
            if (current_digit != PIN_OPTION_SUBMIT) {
                if (pin_cursor < PIN_MAX_LENGTH) {
                    pin_entry_add_digit(current_digit);
                }
                current_digit = 0;
                break;
            }

            /* Submit */
            if (pin_can_submit()) {
                current_digit = 0;
                if (!pin_confirm_mode) {
                    /* First entry - save and ask for confirmation */
                    strncpy(pin_first_entry, pin_entry, PIN_MAX_LENGTH);
                    pin_first_entry[PIN_MAX_LENGTH] = '\0';
                    pin_confirm_mode = true;
                    pin_entry_reset();
                } else {
                    /* Confirmation - check if matches */
                    if (strcmp(pin_first_entry, pin_entry) == 0) {
                        /* PINs match - set it */
                        if (pin_set(pin_entry)) {
                            ESP_LOGI(TAG, "PIN set successfully");
                            ui_set_screen(SCREEN_MAIN_MENU);
                        } else {
                            /* Failed to set - restart */
                            pin_entry_reset();
                            pin_confirm_mode = false;
                        }
                    } else {
                        /* PINs don't match - restart */
                        ESP_LOGW(TAG, "PINs don't match");
                        pin_entry_reset();
                        pin_confirm_mode = false;
                    }
                }
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * PIN Unlock Screen
 * ============================================================================ */

static void screen_pin_unlock_enter(void)
{
    ESP_LOGI(TAG, "PIN unlock screen");
    pin_entry_reset();
}

static void screen_pin_unlock_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Enter PIN");

    /* Draw the selector (digit, or OK once the PIN is long enough) */
    char digit_line[22];
    pin_option_label(digit_line, sizeof(digit_line));
    oled_draw_string_centered(2, digit_line);

    /* Draw PIN display with asterisks */
    char display[PIN_DISPLAY_LEN + 3];
    display[0] = '[';
    for (int i = 0; i < PIN_DISPLAY_LEN; i++) {
        if (i < pin_cursor) {
            display[i + 1] = '*';
        } else {
            display[i + 1] = '_';
        }
    }
    display[PIN_DISPLAY_LEN + 1] = ']';
    display[PIN_DISPLAY_LEN + 2] = '\0';
    oled_draw_string_centered(4, display);

    /* Attempts remaining, and how to submit once the PIN is long enough */
    char attempts_str[22];
    if (pin_can_submit()) {
        snprintf(attempts_str, sizeof(attempts_str), "Tries: %d - pick OK",
                 pin_get_remaining_attempts());
    } else {
        snprintf(attempts_str, sizeof(attempts_str), "Tries: %d",
                 pin_get_remaining_attempts());
    }
    oled_draw_string_centered(5, attempts_str);

    /* Draw instructions */
    oled_draw_string(7, 0, "UP DN  DEL  SEL");
}

static void screen_pin_unlock_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            pin_option_scroll(1);
            break;

        case BUTTON_DOWN:
            pin_option_scroll(-1);
            break;

        case BUTTON_CANCEL:
            if (pin_cursor > 0) {
                pin_entry_backspace();
                current_digit = 0;
            }
            break;

        case BUTTON_ACCEPT:
            if (current_digit != PIN_OPTION_SUBMIT) {
                if (pin_cursor < PIN_MAX_LENGTH) {
                    pin_entry_add_digit(current_digit);
                }
                current_digit = 0;
                break;
            }

            /* Submit - each press here costs one of the 3 attempts. */
            if (pin_can_submit()) {
                current_digit = 0;
                if (pin_verify(pin_entry)) {
                    ESP_LOGI(TAG, "PIN verified");

                    /* Unlock the vault now rather than lazily.
                     *
                     * Waiting until a screen needed keys produced a deadlock:
                     * the menu hid "View Address" because wallet_count was
                     * still zero, and wallet_count only became non-zero once
                     * something unlocked the vault - which only the hidden
                     * screen did. A rebooted device with wallets on it looked
                     * empty until the user wandered into Settings. */
                    ensure_wallet_unlocked();

                    if (pending_mnemonic_display) {
                        pending_mnemonic_display = false;
                        ui_set_screen(SCREEN_MNEMONIC_DISPLAY);
                    } else {
                        ui_set_screen(SCREEN_MAIN_MENU);
                    }
                } else {
                    /* Wrong PIN */
                    pin_entry_reset();

                    if (pin_should_wipe()) {
                        /* Wipe device and reset */
                        device_wipe();
                        ui_set_screen(SCREEN_PIN_SETUP);
                    }
                }
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * PIN Change Screen
 *
 * Three entries: the current PIN, then the new one twice. The current PIN is
 * needed for more than authorisation - it derives the key every stored
 * mnemonic is encrypted under, and re-encrypting them needs both keys at once.
 * ============================================================================ */

typedef enum {
    PIN_CHANGE_CURRENT = 0,
    PIN_CHANGE_NEW,
    PIN_CHANGE_CONFIRM,
} PinChangePhase;

static PinChangePhase pin_change_phase = PIN_CHANGE_CURRENT;
static char pin_change_current[PIN_MAX_LENGTH + 1] = {0};
static char pin_change_message[22] = {0};

static void pin_change_clear_secrets(void)
{
    memzero(pin_change_current, sizeof(pin_change_current));
    memzero(pin_first_entry, sizeof(pin_first_entry));
    pin_entry_reset();
}

/* Re-encryption is seconds of PBKDF2 and AES with no button polling in
 * between, so without this the device looks hung at exactly the moment the
 * user must not pull the power. */
static void pin_change_progress_cb(uint8_t done, uint8_t total)
{
    oled_clear();
    oled_draw_string_centered(1, "Changing PIN");
    oled_draw_string_centered(3, "Re-encrypting...");

    char line[22];
    snprintf(line, sizeof(line), "%d of %d", (int)done, (int)total);
    oled_draw_string_centered(5, line);
    oled_draw_string_centered(7, "Do not power off");
    oled_flush();
}

static void screen_pin_change_enter(void)
{
    ESP_LOGI(TAG, "PIN change screen");
    pin_change_phase = PIN_CHANGE_CURRENT;
    pin_change_message[0] = '\0';
    pin_change_clear_secrets();
}

static void screen_pin_change_exit(screen_id_t next)
{
    (void)next;
    pin_change_clear_secrets();
    pin_set_change_progress(NULL);
}

static void screen_pin_change_render(void)
{
    oled_clear();

    switch (pin_change_phase) {
        case PIN_CHANGE_CURRENT: oled_draw_string_centered(0, "Current PIN"); break;
        case PIN_CHANGE_NEW:     oled_draw_string_centered(0, "New PIN");     break;
        case PIN_CHANGE_CONFIRM: oled_draw_string_centered(0, "Confirm New PIN"); break;
    }

    char digit_line[22];
    pin_option_label(digit_line, sizeof(digit_line));
    oled_draw_string_centered(2, digit_line);

    char display[PIN_DISPLAY_LEN + 3];
    display[0] = '[';
    for (int i = 0; i < PIN_DISPLAY_LEN; i++) {
        display[i + 1] = (i < pin_cursor) ? '*' : '_';
    }
    display[PIN_DISPLAY_LEN + 1] = ']';
    display[PIN_DISPLAY_LEN + 2] = '\0';
    oled_draw_string_centered(4, display);

    if (pin_change_message[0] != '\0') {
        oled_draw_string_centered(5, pin_change_message);
    } else if (pin_can_submit()) {
        oled_draw_string_centered(5, "Pick OK when done");
    } else {
        char progress[22];
        snprintf(progress, sizeof(progress), "%d of %d min", pin_cursor, PIN_MIN_LENGTH);
        oled_draw_string_centered(5, progress);
    }

    oled_draw_string(7, 0, "UP DN  DEL  SEL");
}

/* The whole change, once all three PINs are in hand. */
static void pin_change_commit(void)
{
    pin_set_change_progress(pin_change_progress_cb);
    bool ok = pin_change(pin_change_current, pin_first_entry);
    pin_set_change_progress(NULL);

    if (ok) {
        ESP_LOGI(TAG, "PIN changed");
        pin_change_clear_secrets();
        ui_set_screen(SCREEN_SETTINGS);
        return;
    }

    /* Say which failure it was. "Wrong PIN" and "a wallet would not decrypt"
     * call for completely different reactions from the user, and a device that
     * refuses without explaining leaves them retyping a PIN that was right.
     * Asking the vault afterwards is safe: it costs no attempt, and the answer
     * is one the user just proved they are entitled to. */
    if (wallet_verify_password(pin_change_current, strlen(pin_change_current))) {
        strncpy(pin_change_message, "Wallet unreadable", sizeof(pin_change_message) - 1);
        ESP_LOGE(TAG, "PIN change refused: a wallet failed verification");
    } else {
        strncpy(pin_change_message, "Wrong current PIN", sizeof(pin_change_message) - 1);
    }
    pin_change_message[sizeof(pin_change_message) - 1] = '\0';

    /* Nothing was written, so start over rather than leaving half the entries
     * standing. */
    pin_change_phase = PIN_CHANGE_CURRENT;
    pin_change_clear_secrets();

    if (pin_should_wipe()) {
        device_wipe();
        ui_set_screen(SCREEN_PIN_SETUP);
    }
}

static void screen_pin_change_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            pin_option_scroll(1);
            break;

        case BUTTON_DOWN:
            pin_option_scroll(-1);
            break;

        case BUTTON_CANCEL:
            if (pin_cursor > 0) {
                pin_entry_backspace();
                current_digit = 0;
            } else {
                pin_change_clear_secrets();
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            break;

        case BUTTON_ACCEPT:
            if (current_digit != PIN_OPTION_SUBMIT) {
                if (pin_cursor < PIN_MAX_LENGTH) {
                    pin_entry_add_digit(current_digit);
                }
                current_digit = 0;
                break;
            }

            if (!pin_can_submit()) {
                break;
            }
            current_digit = 0;
            pin_change_message[0] = '\0';

            if (pin_change_phase == PIN_CHANGE_CURRENT) {
                strncpy(pin_change_current, pin_entry, PIN_MAX_LENGTH);
                pin_change_current[PIN_MAX_LENGTH] = '\0';
                pin_entry_reset();
                pin_change_phase = PIN_CHANGE_NEW;
            } else if (pin_change_phase == PIN_CHANGE_NEW) {
                strncpy(pin_first_entry, pin_entry, PIN_MAX_LENGTH);
                pin_first_entry[PIN_MAX_LENGTH] = '\0';
                pin_entry_reset();
                pin_change_phase = PIN_CHANGE_CONFIRM;
            } else {
                if (strcmp(pin_first_entry, pin_entry) != 0) {
                    strncpy(pin_change_message, "PINs don't match",
                            sizeof(pin_change_message) - 1);
                    pin_entry_reset();
                    memzero(pin_first_entry, sizeof(pin_first_entry));
                    pin_change_phase = PIN_CHANGE_NEW;
                    break;
                }
                pin_change_commit();
                return;
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Main Menu Screen
 * ============================================================================ */

static void screen_main_menu_enter(void)
{
    /* A no-op unless seed creation suspended them. Every exit from that flow
     * arrives here, which is why the resume lives at the destination rather
     * than being repeated at each of the ways out. */
    transport_resume();

    ESP_LOGI(TAG, "Main menu screen");
    menu_selection = 0;
    menu_rebuild();
}

static void screen_main_menu_render(void)
{
    oled_clear();
    menu_rebuild();

    /* Show which wallet is active, so "View Address" is not a mystery box. */
    WalletStatus status = wallet_get_status();
    char header[22];
    if (wallet_has_temporary_mnemonic()) {
        /* Named on the home screen, permanently, in place of the wallet
         * number. A user who forgets which mode the device is in and reboots
         * has lost the seed; there is no recovering it from anywhere. */
        snprintf(header, sizeof(header), "-- Menu -- TEMP");
    } else if (status.wallet_count > 1) {
        snprintf(header, sizeof(header), "-- Menu -- W%u/%u",
                 (unsigned)status.active_wallet_index, (unsigned)status.wallet_count);
    } else {
        snprintf(header, sizeof(header), "-- Menu --");
    }
    oled_draw_string_centered(0, header);

    /* Draw menu items (3 visible at a time on 128x64) */
    int start = (menu_selection > 1) ? menu_selection - 1 : 0;
    if (start > menu_item_count - 3) {
        start = menu_item_count - 3;
    }
    if (start < 0) start = 0;

    for (int i = 0; i < 3 && (start + i) < menu_item_count; i++) {
        int item_idx = start + i;
        char line[22];

        snprintf(line, sizeof(line), "%s %s",
                 item_idx == menu_selection ? ">" : " ",
                 menu_action_label(menu_actions[item_idx]));
        oled_draw_string(2 + i * 2, 0, line);
    }

    /* Draw instructions */
    oled_draw_string(7, 0, "UP DN       SEL");
}

static void screen_main_menu_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            if (menu_selection > 0) {
                menu_selection--;
            }
            break;

        case BUTTON_DOWN:
            if (menu_selection < menu_item_count - 1) {
                menu_selection++;
            }
            break;

        case BUTTON_ACCEPT:
            if (menu_selection < 0 || menu_selection >= menu_item_count) {
                break;
            }
            switch (menu_actions[menu_selection]) {
                case MENU_VIEW_ADDRESS:
                    ui_set_screen(SCREEN_WALLET_INFO);
                    break;
                case MENU_SELECT_WALLET:
                    ui_set_screen(SCREEN_WALLET_SELECT);
                    break;
                case MENU_NEW_WALLET:
                    /* Length first: the entropy gate is 128 bits for 12 words
                     * and 256 for 24, so the screen that collects it has to
                     * know which was asked for. */
                    create_entropy_ready = false;
                    ui_set_screen(SCREEN_WALLET_CREATE);
                    break;
                case MENU_IMPORT_WALLET:
                    entry_is_temporary = false;
                    ui_set_screen(SCREEN_MNEMONIC_ENTRY);
                    break;
                case MENU_TEMP_SEED:
                    ui_set_screen(SCREEN_TEMP_SEED);
                    break;
                case MENU_END_TEMP:
                    /* Ending the mode is locking. There is no lighter version:
                     * the seed only exists in RAM, so "put it away" and "destroy
                     * it" are the same operation. */
                    lock_device();
                    ui_set_screen(SCREEN_PIN_UNLOCK);
                    break;
                case MENU_SETTINGS:
                    ui_set_screen(SCREEN_SETTINGS);
                    break;
                default:
                    break;
            }
            break;

        case BUTTON_CANCEL:
            /* Lock device -- held, not tapped. See LOCK_HOLD_US.
             *
             * The lock itself called pin_lock() alone and shipped that way:
             * the PIN gate closed and the vault stayed open underneath it, so
             * unlocking again landed the user back in their passphrase wallet
             * with the seed never having left RAM. Reported from hardware. It
             * is the deliberate lock, so it must be at least as strong as the
             * one that happens by itself -- which is why it goes through
             * lock_device() and not through anything lighter. */
            ui_set_screen(SCREEN_LOCK_HOLD);
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Wallet Info Screen (View Address)
 * ============================================================================ */

/* Why this is a separate field rather than a message parked in
 * `eth_address.hex` (AUDIT S8a, T7).
 *
 * The address renderer slices its buffer at fixed offsets 0/16/30. An error
 * string written there renders as a short first line over two blank ones -
 * which at a glance is a truncated address, not a failure. Worse, the QR
 * screen encoded whatever was in that field, so "Addr failed" was offered to
 * a camera as a receive address.
 *
 * An address and an explanation of why there is no address are different
 * things and are now stored as different things. `address_valid()` is the
 * single gate every consumer asks. */
static char address_error[24] = {0};

/* ------------------------------------------------------------ XFP (T39b)
 *
 * The BIP32 master fingerprint: eight hex characters that identify the *seed*
 * rather than one address off it. That is what makes it worth the row it costs
 * on a 128x64 screen - a wrong passphrase does not fail, it derives a
 * different, perfectly valid, empty-looking wallet, and the fingerprint is the
 * cheapest way to see that has happened. It is the same value Electrum, Trezor
 * Suite and every PSBT show, so it can be checked against something.
 *
 * Not a secret: it is published in every watch-only descriptor.
 *
 * Cached rather than derived per render, because deriving it runs PBKDF2 on a
 * cold seed cache and the render path runs on every repaint. */
static void refresh_master_xfp(void)
{
    uint32_t fp = 0;

    master_xfp[0] = '\0';
    if (wallet_get_master_fingerprint(&fp) == WALLET_OK) {
        snprintf(master_xfp, sizeof(master_xfp), "%08lX", (unsigned long)fp);
    }
}

/* Draw the fingerprint, or nothing at all. A blank row says "not shown"; a row
 * reading "XFP" with a placeholder after it would be read as a value. */
static void draw_master_xfp(int row, const char *prefix)
{
    if (master_xfp[0] == '\0') {
        return;
    }

    char line[22];
    snprintf(line, sizeof(line), "%s %s", prefix, master_xfp);
    oled_draw_string_centered(row, line);
}

static void set_address_error(const char *message)
{
    memzero(&eth_address, sizeof(eth_address));
    snprintf(address_error, sizeof(address_error), "%s", message);
}

/* A real, complete address - never an error, never a partial derivation. */
static bool address_valid(void)
{
    return address_error[0] == '\0' && strlen(eth_address.hex) == 42;
}

static void screen_wallet_info_enter(void)
{
    ESP_LOGI(TAG, "Wallet info screen");

    memset(&eth_address, 0, sizeof(eth_address));
    address_error[0] = '\0';

    if (!ensure_wallet_unlocked()) {
        set_address_error("Unlock failed");
        return;
    }

    WalletStatus status = wallet_get_status();
    const bool temp = wallet_has_temporary_mnemonic();
    if (status.wallet_count == 0 && !temp) {
        set_address_error("No wallet");
        return;
    }

    /* Select first wallet if none active.
     *
     * Not in temporary mode: the active index is 0 there by design, and
     * "helpfully" selecting wallet 1 would load a stored seed over the one the
     * user typed - silently deriving addresses off the wrong wallet, which is
     * the exact failure this screen's title row exists to make impossible. */
    if (!temp && status.active_wallet_index == 0) {
        WalletError err = wallet_select_wallet(1);
        if (err != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to select wallet: %d", err);
            set_address_error("Select failed");
            return;
        }
    }

    /* m/44'/60'/0'/0/<address_index>, under the derivation lock.
     *
     * This runs on entering the wallet screen, which is exactly where the UI
     * lands after approving a transaction - so an unlocked select here
     * re-derives to the *browsing* index while the protocol task is signing,
     * and the device signs with a key the confirmation screen never named. */
    HDPath eth_path = hd_path_at(address_index);

    WalletError err = wallet_get_address_at_path(&eth_path, &eth_address);
    if (err != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to get address: %d", err);
        set_address_error("Addr failed");
    }

    refresh_master_xfp();
    wallet_info_passphrase_shown = wallet_has_passphrase();
}

static void screen_wallet_info_render(void)
{
    oled_clear();

    WalletStatus status = wallet_get_status();
    const bool temp = wallet_has_temporary_mnemonic();
    char title[22];
    /* Which seed, and whether a passphrase is on it. The passphrase marker is
     * on the title row rather than buried because a passphrase changes every
     * address on this screen and leaves no other visible trace (T42) - the
     * XFP below says the seed changed, but only to someone who recorded it. */
    if (temp) {
        /* "TEMP" where the wallet number goes, because there is no wallet
         * number: this address came off a seed no slot holds. It is the same
         * row the passphrase marker uses and for the same reason - the address
         * below it is indistinguishable from a stored wallet's, and the user
         * is about to hand it to someone. */
        snprintf(title, sizeof(title), "TEMP  addr %u%s",
                 (unsigned)address_index, wallet_has_passphrase() ? " P" : "");
    } else {
        snprintf(title, sizeof(title), "W%u/%u  addr %u%s",
                 (unsigned)status.active_wallet_index, (unsigned)status.wallet_count,
                 (unsigned)address_index, wallet_has_passphrase() ? " P" : "");
    }
    oled_draw_string_centered(0, title);

    /* The full derivation path, on its own row (T45).
     *
     * With the account level selectable, "addr 3" no longer identifies an
     * address: the same index under another account is a different wallet
     * entirely. The path is the only text on this screen that says which one,
     * and it is the same string the signing confirmation shows, so the two can
     * be compared by eye. */
    if (status.wallet_count > 0 || temp) {
        char path_str[24];
        HDPath shown = hd_path_at(address_index);
        format_hd_path(path_str, sizeof(path_str), &shown);
        oled_draw_string_centered(1, path_str);
    }

    if (status.wallet_count == 0 && !temp) {
        oled_draw_string_centered(3, "No wallet");
        oled_draw_string_centered(4, "Create one first");
    } else if (!address_valid()) {
        /* Say plainly that there is no address, rather than drawing something
         * address-shaped. The word "Error" is what distinguishes this from a
         * short address at a glance. */
        oled_draw_string_centered(2, "Error");
        oled_draw_string_centered(4, address_error[0] ? address_error : "No address");
    } else {
        /* Display address in 3 lines (42 chars total) */
        /* Line 1: 0x + 14 chars = 16 chars */
        char line1[17], line2[17], line3[17];

        strncpy(line1, eth_address.hex, 16);
        line1[16] = '\0';

        strncpy(line2, eth_address.hex + 16, 14);
        line2[14] = '\0';

        strncpy(line3, eth_address.hex + 30, 12);
        line3[12] = '\0';

        oled_draw_string_centered(2, line1);
        oled_draw_string_centered(3, line2);
        oled_draw_string_centered(4, line3);

        /* Which seed this address came off. The address alone cannot say
         * whether a passphrase is applied, and the wrong one looks exactly
         * like the right one until funds fail to appear. */
        draw_master_xfp(6, "XFP");
    }

    /* Offering QR for something that is not an address invites the user to
     * scan a failure message. */
    oled_draw_string(7, 0, address_valid() ? "UP DN BCK   QR" : "UP DN BCK");
}

/* Re-derive the displayed address for the current index. */
static void wallet_info_refresh_address(void)
{
    memset(&eth_address, 0, sizeof(eth_address));

    HDPath eth_path = hd_path_at(address_index);

    address_error[0] = '\0';

    if (wallet_get_address_at_path(&eth_path, &eth_address) != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to derive address %u", (unsigned)address_index);
        set_address_error("Derive failed");
    }

    /* Refreshed together, always. The fingerprint names the seed the address
     * came off, so an address re-derived under a new passphrase beside an XFP
     * from the old one would be worse than showing no fingerprint at all. */
    refresh_master_xfp();
    wallet_info_passphrase_shown = wallet_has_passphrase();
}

static void screen_wallet_info_on_button(button_id_t btn)
{
    WalletStatus status = wallet_get_status();

    switch (btn) {
        case BUTTON_UP:
            if (status.wallet_count > 0) {
                address_index = (address_index + 1) % ADDRESS_INDEX_COUNT;
                wallet_info_refresh_address();
            }
            break;

        case BUTTON_DOWN:
            if (status.wallet_count > 0) {
                address_index = (address_index + ADDRESS_INDEX_COUNT - 1)
                                % ADDRESS_INDEX_COUNT;
                wallet_info_refresh_address();
            }
            break;

        case BUTTON_CANCEL:
            ui_set_screen(SCREEN_MAIN_MENU);
            break;

        case BUTTON_ACCEPT:
            /* Go to QR code display */
            ui_set_screen(SCREEN_QR_CODE);
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Lock: held, not tapped
 * ============================================================================ */

/* LOCK_HOLD_US, and why locking is held rather than tapped, are in ui.h.
 *
 * Width of the bar, in characters. Text rather than pixels because every other
 * screen here is text, and because a test can read it back. */
#define LOCK_HOLD_SEGMENTS 16

static int64_t lock_hold_start_us = 0;

/* Is there anything here that a lock would cost more than a PIN entry to get
 * back? Both of these live only in RAM and both die in wallet_lock(). */
static bool lock_would_lose_something(void)
{
    return wallet_has_passphrase() || wallet_has_temporary_mnemonic();
}

static void screen_lock_hold_enter(void)
{
    ESP_LOGI(TAG, "Lock hold screen");
    lock_hold_start_us = esp_timer_get_time();
}

static void screen_lock_hold_render(void)
{
    int64_t held = esp_timer_get_time() - lock_hold_start_us;
    if (held < 0) held = 0;

    int filled = (int)((held * LOCK_HOLD_SEGMENTS) / LOCK_HOLD_US);
    if (filled > LOCK_HOLD_SEGMENTS) filled = LOCK_HOLD_SEGMENTS;

    char bar[LOCK_HOLD_SEGMENTS + 3];
    bar[0] = '[';
    for (int i = 0; i < LOCK_HOLD_SEGMENTS; i++) {
        bar[i + 1] = (i < filled) ? '#' : ' ';
    }
    bar[LOCK_HOLD_SEGMENTS + 1] = ']';
    bar[LOCK_HOLD_SEGMENTS + 2] = '\0';

    oled_clear();
    oled_draw_string_centered(0, "Lock device");
    oled_draw_string_centered(2, "Keep holding BACK");
    oled_draw_string_centered(4, bar);
    oled_draw_string_centered(6, "Let go to cancel");
}

static void screen_lock_hold_on_button(button_id_t btn)
{
    /* Any other button abandons it. The hold itself is not a button event --
     * there is no press to repeat and no release to hear -- so it is watched
     * from the task loop instead. See service_lock_hold(). */
    (void)btn;
    ui_set_screen(SCREEN_MAIN_MENU);
}

/**
 * Watch the hold. Called once per turn of the UI task's loop.
 *
 * Polls the debounced level rather than waiting for an event, because a button
 * held down produces exactly one event and no more, and a button released
 * produces none at all.
 */
static void service_lock_hold(void)
{
    if (ui_get_screen() != SCREEN_LOCK_HOLD) {
        return;
    }

    if (!button_is_pressed(BUTTON_CANCEL)) {
        /* A tap. Which is what leaving a menu looks like, and is exactly why
         * this screen exists. */
        ui_set_screen(SCREEN_MAIN_MENU);
        return;
    }

    if (esp_timer_get_time() - lock_hold_start_us < LOCK_HOLD_US) {
        ui_invalidate();        /* advance the bar */
        return;
    }

    if (lock_would_lose_something()) {
        ui_set_screen(SCREEN_LOCK_CONFIRM);
        return;
    }

    ESP_LOGI(TAG, "Locked by held BACK");
    lock_device();
    ui_set_screen(SCREEN_PIN_UNLOCK);
}

/* Names what the lock costs, rather than asking whether the user is sure.
 *
 * "Are you sure?" is answered reflexively within a week and then protects
 * nothing. What the user cannot see from the home screen is which of the two
 * RAM-only secrets is about to go, and how much typing it will take to get it
 * back -- so that is what this says. */
static void screen_lock_confirm_render(void)
{
    bool temp = wallet_has_temporary_mnemonic();
    bool pass = wallet_has_passphrase();

    oled_clear();
    oled_draw_string_centered(0, "Lock device?");

    if (temp && pass) {
        oled_draw_string_centered(2, "Temp seed AND");
        oled_draw_string_centered(3, "passphrase go.");
        oled_draw_string_centered(5, "Type both again.");
    } else if (temp) {
        oled_draw_string_centered(2, "Temp seed goes.");
        oled_draw_string_centered(4, "Nothing stored it.");
        oled_draw_string_centered(5, "Type it again.");
    } else {
        oled_draw_string_centered(2, "Passphrase goes.");
        oled_draw_string_centered(4, "Type it again to");
        oled_draw_string_centered(5, "reach this wallet.");
    }

    oled_draw_string(7, 0, "BACK        LOCK");
}

static void screen_lock_confirm_on_button(button_id_t btn)
{
    if (btn == BUTTON_ACCEPT) {
        ESP_LOGI(TAG, "Locked by held BACK, confirmed");
        lock_device();
        ui_set_screen(SCREEN_PIN_UNLOCK);
        return;
    }
    if (btn == BUTTON_CANCEL) {
        ui_set_screen(SCREEN_MAIN_MENU);
    }
}

/* ============================================================================
 * Wallet Create Screen
 * ============================================================================ */

static void screen_wallet_create_enter(void)
{
    ESP_LOGI(TAG, "Wallet create screen");
    create_show_mnemonic = false;
    create_generate_pending = false;
    create_error[0] = '\0';
    memset(mnemonic_buffer, 0, sizeof(mnemonic_buffer));

    if (create_entropy_ready) {
        /* Coming back from the entropy screen with the gate met for the length
         * chosen on the way in. Generate straight away: asking again would
         * invite a different answer, and the entropy that was just collected
         * was measured against the first one. */
        create_entropy_ready = false;
        create_show_mnemonic = true;
        create_generate_pending = true;
        return;
    }

    /* Fresh start. The length is chosen here, before any entropy is gathered,
     * because the gate depends on it. */
    create_word_count = 12;
}

static void screen_wallet_create_render(void)
{
    oled_clear();

    if (!create_show_mnemonic) {
        oled_draw_string_centered(0, "New Wallet");

        char words_str[16];
        snprintf(words_str, sizeof(words_str), "< %d words >", create_word_count);
        oled_draw_string_centered(2, words_str);

        oled_draw_string_centered(4, "UP/DN: 12/24");

        if (create_error[0] != '\0') {
            oled_draw_string_centered(5, create_error);
        }

        oled_draw_string(7, 0, "BCK         GEN");
    } else {
        /* Show "generating" message briefly, then switch to mnemonic display */
        oled_draw_string_centered(3, "Generating...");
    }
}

static void screen_wallet_create_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
        case BUTTON_DOWN:
            /* Toggle between 12 and 24 words */
            create_word_count = (create_word_count == 12) ? 24 : 12;
            break;

        case BUTTON_CANCEL:
            ui_set_screen(SCREEN_MAIN_MENU);
            break;

        case BUTTON_ACCEPT:
            if (!create_show_mnemonic) {
                create_error[0] = '\0';
                /* Length first, then entropy measured against it. The screen
                 * that gathers it reads create_word_count for its target and
                 * returns here to generate. */
                ui_set_screen(SCREEN_ENTROPY);
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* The slow half of "GEN", run from ui_poll_deferred() with the
 * "Generating..." frame already on the panel (AUDIT S8f).
 *
 * Every exit path clears create_generate_pending, including the failures: a
 * flag that survives its own handler would regenerate a seed on the next pass
 * through the loop, silently, and the second one would be the wallet the user
 * ends up with. */
static void wallet_create_run_generation(void)
{
    create_generate_pending = false;

    if (!ensure_wallet_unlocked()) {
        ESP_LOGE(TAG, "Failed to unlock wallet");
        snprintf(create_error, sizeof(create_error), "Unlock failed");
        create_show_mnemonic = false;
        ui_invalidate();
        return;
    }

    WalletError err = wallet_create_mnemonic(create_word_count,
                                             mnemonic_buffer,
                                             sizeof(mnemonic_buffer));
    if (err != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to create mnemonic: %d", err);
        snprintf(create_error, sizeof(create_error), "Gen err: %d", err);
        create_show_mnemonic = false;
        ui_invalidate();
        return;
    }

    /* wallet_create_mnemonic already stores and selects the wallet. A new seed
     * is a new set of identities, so the account selection goes back to 0 for
     * the same reason a wallet switch resets it (T45). */
    hd_account_set(0);

    WalletStatus status = wallet_get_status();
    ESP_LOGI(TAG, "Created wallet %d with %d words",
             status.active_wallet_index, create_word_count);

    /* Presses made during the generation belong to the screen the user was
     * looking at, not the one they are about to get. */
    button_drain();
    ui_set_screen(SCREEN_MNEMONIC_DISPLAY);
    ui_invalidate();
}

/* ============================================================================
 * Wallet Select Screen
 * ============================================================================ */

static void screen_wallet_select_enter(void)
{
    ESP_LOGI(TAG, "Wallet select screen");
    WalletStatus status = wallet_get_status();
    wallet_list_selection = (status.active_wallet_index > 0) ?
                            status.active_wallet_index - 1 : 0;
}

static void screen_wallet_select_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Select Wallet");

    WalletStatus status = wallet_get_status();

    if (status.wallet_count == 0) {
        oled_draw_string_centered(3, "No wallets");
        oled_draw_string_centered(4, "Create one first");
    } else {
        /* List wallets (3 visible at a time) */
        int start = (wallet_list_selection > 1) ? wallet_list_selection - 1 : 0;
        if (start > (int)status.wallet_count - 3) {
            start = status.wallet_count - 3;
        }
        if (start < 0) start = 0;

        for (int i = 0; i < 3 && (start + i) < status.wallet_count; i++) {
            int idx = start + i;
            char line[22];

            if (idx == wallet_list_selection) {
                if (idx + 1 == status.active_wallet_index) {
                    snprintf(line, sizeof(line), "> Wallet %d *", idx + 1);
                } else {
                    snprintf(line, sizeof(line), "> Wallet %d", idx + 1);
                }
            } else {
                if (idx + 1 == status.active_wallet_index) {
                    snprintf(line, sizeof(line), "  Wallet %d *", idx + 1);
                } else {
                    snprintf(line, sizeof(line), "  Wallet %d", idx + 1);
                }
            }
            oled_draw_string(2 + i * 2, 0, line);
        }
    }

    oled_draw_string(7, 0, "BCK  UP DN  SEL");
}

static void screen_wallet_select_on_button(button_id_t btn)
{
    WalletStatus status = wallet_get_status();

    switch (btn) {
        case BUTTON_UP:
            if (wallet_list_selection > 0) {
                wallet_list_selection--;
            }
            break;

        case BUTTON_DOWN:
            if (wallet_list_selection < (int)status.wallet_count - 1) {
                wallet_list_selection++;
            }
            break;

        case BUTTON_CANCEL:
            ui_set_screen(SCREEN_MAIN_MENU);
            break;

        case BUTTON_ACCEPT:
            if (status.wallet_count > 0) {
                wallet_select_wallet(wallet_list_selection + 1);
                address_index = 0;   /* a different seed, start from its first address */
                /* The ACCOUNT is deliberately kept. Every seed has an account
                 * 3, so unlike the passphrase there is nothing seed-specific
                 * being carried across - and the wallet screen names the full
                 * path, so the selection is visible rather than implied. What
                 * a passphrase carries across a switch is a wallet nobody
                 * asked for; what an account number carries is a number. */
                ESP_LOGI(TAG, "Selected wallet %d", wallet_list_selection + 1);
                ui_set_screen(SCREEN_WALLET_INFO);
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Mnemonic Display Screen
 * ============================================================================ */

static void screen_mnemonic_display_enter(void)
{
    ESP_LOGI(TAG, "Mnemonic display screen");
    mnemonic_page = 0;

    if (!ensure_wallet_unlocked()) {
        return;
    }

    /* Get mnemonic for current wallet */
    WalletError err = wallet_get_mnemonic(mnemonic_buffer, sizeof(mnemonic_buffer));
    if (err != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to get mnemonic: %d", err);
        strcpy(mnemonic_buffer, "");
        mnemonic_word_count = 0;
        return;
    }

    mnemonic_word_count = count_mnemonic_words(mnemonic_buffer);
    ESP_LOGI(TAG, "Displaying %d words", mnemonic_word_count);
}

static void screen_mnemonic_display_render(void)
{
    oled_clear();

    if (mnemonic_word_count == 0) {
        oled_draw_string_centered(3, "No mnemonic");
        oled_draw_string(7, 0, "BACK");
        return;
    }

    /* Name the wallet and the page.
     *
     * With more than one seed stored, "Seed Phrase" alone is how a backup ends
     * up labelled with the wrong wallet - and a phrase written down under the
     * wrong name is a phrase you will not find when you need it. */
    int total_pages = (mnemonic_word_count + 2) / 3;
    WalletStatus mstatus = wallet_get_status();
    /* Clamped so the compiler can size the buffer: a 24-word phrase is 8 pages
     * and MAX_WALLETS is 30, so none of these need more than two digits. */
    unsigned page_no  = (unsigned)(mnemonic_page + 1) & 0xF;
    unsigned page_tot = (unsigned)total_pages & 0xF;
    char mheader[22];
    if (mstatus.wallet_count > 1) {
        snprintf(mheader, sizeof(mheader), "Seed W%u/%u %u-%u",
                 (unsigned)mstatus.active_wallet_index & 0x3F,
                 (unsigned)mstatus.wallet_count & 0x3F,
                 page_no, page_tot);
    } else {
        snprintf(mheader, sizeof(mheader), "Seed Phrase %u/%u", page_no, page_tot);
    }
    oled_draw_string_centered(0, mheader);

    /* Display 3 words */
    for (int i = 0; i < 3; i++) {
        int word_idx = mnemonic_page * 3 + i;
        if (word_idx >= mnemonic_word_count) break;

        char word[10];
        if (get_mnemonic_word(mnemonic_buffer, word_idx, word, sizeof(word))) {
            char line[24];
            int n = word_idx + 1;
            snprintf(line, sizeof(line), "%d. %s", n, word);
            oled_draw_string(2 + i, 0, line);
        }
    }

    /* Navigation hint */
    bool has_prev = mnemonic_page > 0;
    bool has_next = mnemonic_page < total_pages - 1;

    if (has_prev && has_next) {
        oled_draw_string(7, 0, "DONE PREV   NEXT");
    } else if (has_prev) {
        oled_draw_string(7, 0, "DONE PREV");
    } else if (has_next) {
        oled_draw_string(7, 0, "DONE        NEXT");
    } else {
        oled_draw_string(7, 0, "DONE");
    }
}

static void screen_mnemonic_display_on_button(button_id_t btn)
{
    int total_pages = (mnemonic_word_count + 2) / 3;

    switch (btn) {
        case BUTTON_UP:
        case BUTTON_CANCEL:
            /* Previous page or back */
            if (mnemonic_page > 0) {
                mnemonic_page--;
            } else {
                ui_set_screen(SCREEN_WALLET_INFO);
            }
            break;

        case BUTTON_DOWN:
        case BUTTON_ACCEPT:
            /* Next page, or on the last page move to verification */
            if (mnemonic_page < total_pages - 1) {
                mnemonic_page++;
            } else if (mnemonic_word_count > 0) {
                ui_set_screen(SCREEN_MNEMONIC_VERIFY);
            } else {
                ui_set_screen(SCREEN_WALLET_INFO);
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Mnemonic Entry Screen (Import Wallet)
 * ============================================================================ */

static void screen_mnemonic_entry_enter(void)
{
    ESP_LOGI(TAG, "Mnemonic entry screen");
    entry_choosing_length = true;
    entry_length_choice = 12;
    mnemonic_entry_reset(&entry, entry_length_choice);
    entry_error[0] = '\0';
}

/*
 * One line describing what ACCEPT would do right now, shared by the import and
 * verify screens so the two can never drift into showing different things.
 *
 * The selector has three shapes: a block of letters ("ord[a-f]"), a single
 * letter ("ord[i]"), and - once few enough words still match - the whole word,
 * which is shown in full because that is what a press would commit.
 */
static void entry_selector_line(char *out, size_t len)
{
    const char *word = mnemonic_entry_selected_word(&entry);
    if (word) {
        snprintf(out, len, "OK:%s", word);
        return;
    }

    char label[MNEMONIC_ENTRY_WORD_LEN + 8];
    mnemonic_entry_option_label(&entry, label, sizeof(label));

    if (mnemonic_entry_option(&entry) == MNEMONIC_ENTRY_COMMIT &&
        !mnemonic_entry_on_group(&entry)) {
        /* Name the word OK would accept. "pos[OK]" tells the user nothing;
         * "OK:position" lets them catch a wrong turn before committing it. */
        const char *target = mnemonic_entry_suggestion(&entry);
        snprintf(out, len, "OK:%s", target ? target : entry.prefix);
        return;
    }

    snprintf(out, len, "%s[%s]", entry.prefix, label);
}

static void screen_mnemonic_entry_render(void)
{
    oled_clear();

    if (entry_choosing_length) {
        oled_draw_string_centered(0, entry_is_temporary ? "Temp seed" : "Import seed");
        oled_draw_string(2, 0, "How many words?");
        if (entry_is_temporary) {
            /* Repeated here, one screen after the warning, because this is the
             * last page before the user starts typing 24 words. */
            oled_draw_string(3, 0, "Not saved anywhere");
        }

        char line[22];
        snprintf(line, sizeof(line), "%s 12", entry_length_choice == 12 ? ">" : " ");
        oled_draw_string(4, 0, line);
        snprintf(line, sizeof(line), "%s 24", entry_length_choice == 24 ? ">" : " ");
        oled_draw_string(5, 0, line);

        oled_draw_string(7, 0, "UP DN  BCK  SEL");
        return;
    }

    char header[22];
    /* The mode is on the header row of every word, not just the first. Twelve
     * to twenty-four screens pass between the warning and the last word, and a
     * user who has forgotten which flow they are in is exactly the user who
     * reboots afterwards. */
    snprintf(header, sizeof(header), entry_is_temporary ? "TEMP word %d/%d"
                                                        : "Word %d/%d",
             entry.current_word + 1, entry.target_words);
    oled_draw_string_centered(0, header);

    char prefix_display[MNEMONIC_ENTRY_WORD_LEN + 24];
    entry_selector_line(prefix_display, sizeof(prefix_display));
    oled_draw_string(2, 0, "Type:");
    oled_draw_string(2, 36, prefix_display);

    if (entry_error[0] != '\0') {
        oled_draw_string(4, 0, entry_error);
    } else {
        char line[22];
        if (entry.word_mode) {
            /* The selector is already naming a whole word, so repeating the
             * first match would point at a different word than ACCEPT takes.
             * Show the position in the shortlist instead. */
            snprintf(line, sizeof(line), "%d of %d",
                     entry.option_index + 1, entry.option_count);
            oled_draw_string(4, 0, "Choice:");
            oled_draw_string(4, 48, line);
        } else {
            const char *suggestion = mnemonic_entry_suggestion(&entry);
            if (suggestion) {
                int n = mnemonic_entry_match_count(&entry, 100);
                if (n > 1) {
                    snprintf(line, sizeof(line), "%s +%d", suggestion, n - 1);
                } else {
                    snprintf(line, sizeof(line), "%s", suggestion);
                }
                oled_draw_string(4, 0, "Match:");
                oled_draw_string(4, 42, line);
            }
        }
    }

    /* With a block open, BACK closes it instead of deleting a character, so
     * the hint has to say which one the next press will do. */
    oled_draw_string(7, 0, entry.in_group ? "UP DN  BCK  SEL" : "UP DN  DEL  SEL");
}

/* Import the phrase now held in `entry`. Always clears it before returning. */
static void mnemonic_entry_finish(void)
{
    char full_mnemonic[300];
    mnemonic_entry_build(&entry, full_mnemonic, sizeof(full_mnemonic));

    if (!wallet_validate_mnemonic(full_mnemonic)) {
        /* Almost always a mistyped word - the checksum catches it here rather
         * than after the user has trusted a wrong wallet. */
        ESP_LOGW(TAG, "Invalid mnemonic checksum");
        snprintf(entry_error, sizeof(entry_error), "Bad checksum");
        memzero(full_mnemonic, sizeof(full_mnemonic));
        mnemonic_entry_clear(&entry);
        return;
    }

    if (!ensure_wallet_unlocked()) {
        memzero(full_mnemonic, sizeof(full_mnemonic));
        mnemonic_entry_clear(&entry);
        ui_set_screen(SCREEN_MAIN_MENU);
        return;
    }

    if (entry_is_temporary) {
        /* The one line that differs from an import: the phrase goes into RAM
         * and nothing else happens to it. No slot is allocated, no ciphertext
         * is written, no wallet count moves, and the backup bitmask - which
         * would record that a seed exists here - is not touched. */
        WalletError terr = wallet_use_temporary_mnemonic(full_mnemonic);
        memzero(full_mnemonic, sizeof(full_mnemonic));
        mnemonic_entry_clear(&entry);

        if (terr != WALLET_OK) {
            ESP_LOGE(TAG, "Temporary seed rejected: %d", terr);
            ui_set_screen(SCREEN_MAIN_MENU);
            return;
        }

        /* The longer default takes effect now rather than at the warning
         * screen, so an abandoned entry leaves the user's own timeout alone. */
        lock_timeout_choice = LOCK_TIMEOUT_TEMP_SEED;
        ESP_LOGI(TAG, "Temporary seed active; auto-lock %s",
                 lock_timeout_label(lock_timeout_choice));
        ui_set_screen(SCREEN_WALLET_INFO);
        return;
    }

    uint8_t idx = wallet_add_mnemonic(full_mnemonic);
    memzero(full_mnemonic, sizeof(full_mnemonic));
    mnemonic_entry_clear(&entry);

    if (idx > 0) {
        wallet_select_wallet(idx);
        ESP_LOGI(TAG, "Imported wallet %d", idx);
        ui_set_screen(SCREEN_WALLET_INFO);
    } else {
        ESP_LOGE(TAG, "Failed to import wallet");
        ui_set_screen(SCREEN_MAIN_MENU);
    }
}

static void screen_mnemonic_entry_on_button(button_id_t btn)
{
    entry_error[0] = '\0';

    if (entry_choosing_length) {
        switch (btn) {
            case BUTTON_UP:
            case BUTTON_DOWN:
                /* Two options, so either direction is a toggle. */
                entry_length_choice = (entry_length_choice == 12) ? 24 : 12;
                break;

            case BUTTON_CANCEL:
                mnemonic_entry_clear(&entry);
                ui_set_screen(SCREEN_MAIN_MENU);
                return;

            case BUTTON_ACCEPT:
                mnemonic_entry_reset(&entry, entry_length_choice);
                entry_choosing_length = false;
                ESP_LOGI(TAG, "Importing a %d-word phrase", entry_length_choice);
                break;

            default:
                break;
        }
        ui_invalidate();
        return;
    }

    switch (btn) {
        case BUTTON_UP:
            mnemonic_entry_scroll(&entry, 1);
            break;

        case BUTTON_DOWN:
            mnemonic_entry_scroll(&entry, -1);
            break;

        case BUTTON_CANCEL:
            if (!mnemonic_entry_back(&entry)) {
                /* Backing out of the first character returns to the length
                 * question rather than leaving outright, so a wrong choice
                 * costs one press instead of a restart. */
                entry_choosing_length = true;
                mnemonic_entry_clear(&entry);
                mnemonic_entry_reset(&entry, entry_length_choice);
            }
            break;

        case BUTTON_ACCEPT:
            if (mnemonic_entry_accept(&entry) == MNEMONIC_ENTRY_ALL_DONE) {
                mnemonic_entry_finish();
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Settings Screen
 * ============================================================================ */

#ifdef CONFIG_ESP_WIFI_ENABLED
/* WiFi test functions - AP mode so other devices can see it */
static bool wifi_event_loop_created = false;

#define WIFI_AP_SSID     "LeekWallet"
#define WIFI_AP_PASS     "leek1234"
#define WIFI_AP_CHANNEL  1
#define WIFI_AP_MAX_CONN 4

static void wifi_test_toggle(void)
{
    if (!wifi_enabled) {
        ESP_LOGI(TAG, "Enabling WiFi AP...");

        /* Create default event loop if not already created */
        if (!wifi_event_loop_created) {
            esp_err_t err = esp_event_loop_create_default();
            if (err == ESP_OK || err == ESP_ERR_INVALID_STATE) {
                wifi_event_loop_created = true;
            }
        }

        /* Initialize netif */
        esp_netif_init();
        esp_netif_create_default_wifi_ap();

        wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
        esp_wifi_init(&cfg);

        /* Configure AP mode */
        wifi_config_t wifi_config = {
            .ap = {
                .ssid = WIFI_AP_SSID,
                .ssid_len = strlen(WIFI_AP_SSID),
                .channel = WIFI_AP_CHANNEL,
                .password = WIFI_AP_PASS,
                .max_connection = WIFI_AP_MAX_CONN,
                .authmode = WIFI_AUTH_WPA2_PSK,
            },
        };

        esp_wifi_set_mode(WIFI_MODE_AP);
        esp_wifi_set_config(WIFI_IF_AP, &wifi_config);
        esp_wifi_start();

        wifi_enabled = true;
        entropy_set_wifi_active(true);
        ESP_LOGI(TAG, "WiFi AP enabled: SSID='%s' PASS='%s'", WIFI_AP_SSID, WIFI_AP_PASS);
    } else {
        ESP_LOGI(TAG, "Disabling WiFi...");
        esp_wifi_stop();
        esp_wifi_deinit();
        wifi_enabled = false;
        entropy_set_wifi_active(false);
        ESP_LOGI(TAG, "WiFi disabled");
    }
}
#endif /* CONFIG_ESP_WIFI_ENABLED */

/* BLE lives in ble.c and is reached only through transport.c: the settings
 * screen selects a link, it does not drive a radio. The ad-hoc NimBLE toggle
 * that used to sit here advertised forever and served nothing, and it could be
 * on at the same time as the USB endpoint. */

/* USB HID test function */
static void usb_hid_test(void)
{
#ifdef CONFIG_TINYUSB_ENABLED
    ESP_LOGI(TAG, "USB HID test - typing address...");
    if (address_valid()) {
        ESP_LOGI(TAG, "Address: %s", eth_address.hex);
        /* TinyUSB HID would type the address here */
    } else {
        ESP_LOGW(TAG, "No address available");
    }
#else
    ESP_LOGW(TAG, "TinyUSB not enabled in sdkconfig");
    ESP_LOGI(TAG, "To enable: CONFIG_TINYUSB_ENABLED=y");
#endif
}

static void screen_settings_enter(void)
{
    ESP_LOGI(TAG, "Settings screen");
    settings_selection = 0;
}

static void screen_settings_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "-- Settings --");

    /* Scrollable menu (3 visible at a time) */
    int start = (settings_selection > 1) ? settings_selection - 1 : 0;
    if (start > SETTINGS_ITEMS - 3) {
        start = SETTINGS_ITEMS - 3;
    }
    if (start < 0) start = 0;

    for (int i = 0; i < 3 && (start + i) < SETTINGS_ITEMS; i++) {
        int item_idx = start + i;
        char line[22];

        /* Show status for toggles */
#ifdef CONFIG_ESP_WIFI_ENABLED
        if (item_idx == SET_WIFI) {
            if (item_idx == settings_selection) {
                snprintf(line, sizeof(line), "> WiFi %s", wifi_enabled ? "[ON]" : "[OFF]");
            } else {
                snprintf(line, sizeof(line), "  WiFi %s", wifi_enabled ? "[ON]" : "[OFF]");
            }
        } else
#endif
        if (item_idx == SET_TRANSPORT) {
            /* Named for what it is rather than "BLE [ON]": the two are
             * exclusive, so a per-radio on/off would imply a state the device
             * cannot be in (PROTOCOL.md 3b). */
            snprintf(line, sizeof(line), "%s Link %s",
                     item_idx == settings_selection ? ">" : " ",
                     transport_label(transport_get()));
        } else if (item_idx == SET_BLE_NAME) {
            /* The name is on the menu line for the same reason the blind
             * signing state is: it is broadcast to everyone in range, so it
             * should be visible without going looking for it. Truncated for
             * the 21-column display only - what goes on air is whatever
             * ble_name_get() returns. */
            snprintf(line, sizeof(line), "%s %.14s",
                     item_idx == settings_selection ? ">" : " ",
                     ble_name_get());
        } else if (item_idx == SET_ACCOUNT) {
            /* The value is on the menu line, like Link and Blind: which
             * identity the device is deriving from is not something a user
             * should have to open a screen to discover. */
            snprintf(line, sizeof(line), "%s Account %u",
                     item_idx == settings_selection ? ">" : " ",
                     (unsigned)hd_account);
        } else if (item_idx == SET_BRIGHTNESS) {
            snprintf(line, sizeof(line), "%s Bright %s",
                     item_idx == settings_selection ? ">" : " ",
                     brightness_label(brightness_choice));
        } else if (item_idx == SET_ENTRY_STYLE) {
            snprintf(line, sizeof(line), "%s Entry %s",
                     item_idx == settings_selection ? ">" : " ",
                     mnemonic_entry_blocks_enabled() ? "Blocks" : "Simple");
        } else if (item_idx == SET_BLIND) {
            /* The state is on the menu line, not hidden behind the item. A
             * weakened device must be visible without going looking. */
            snprintf(line, sizeof(line), "%s Blind %s",
                     item_idx == settings_selection ? ">" : " ",
                     blind_signing_enabled() ? "[ON]" : "[OFF]");
        } else if (item_idx == SET_AUTOLOCK) {
            snprintf(line, sizeof(line), "%s Lock %s",
                     item_idx == settings_selection ? ">" : " ",
                     lock_timeout_label(lock_timeout_choice));
        } else {
            snprintf(line, sizeof(line), "%s %s",
                     item_idx == settings_selection ? ">" : " ",
                     settings_items[item_idx]);
        }
        oled_draw_string(2 + i * 2, 0, line);
    }

    oled_draw_string(7, 0, "UP DN       SEL");
}

static void screen_settings_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            if (settings_selection > 0) {
                settings_selection--;
            }
            break;

        case BUTTON_DOWN:
            if (settings_selection < SETTINGS_ITEMS - 1) {
                settings_selection++;
            }
            break;

        case BUTTON_CANCEL:
            ui_set_screen(SCREEN_MAIN_MENU);
            break;

        case BUTTON_ACCEPT:
            switch ((SettingsAction)settings_selection) {
                case SET_SHOW_SEED:
                    /* Re-entering the PIN is the point: this reveals the seed,
                     * so it must not ride on a session unlocked minutes ago.
                     *
                     * A full lock, not just the PIN gate, and that is a
                     * decision rather than a tidy-up. The question this screen
                     * asks is "prove you are the owner again", and holding a
                     * decrypted mnemonic and a live seed cache in RAM while
                     * asking it answers a different question - it is the state
                     * AUDIT S5 was written about, entered on purpose. The cost
                     * is one re-derivation the correct PIN pays for anyway;
                     * the benefit is that a device sitting on a PIN prompt has
                     * no seed in memory no matter how it got there. */
                    if (wallet_has_temporary_mnemonic()) {
                        /* Locking is what this menu item does, and locking is
                         * what destroys a temporary seed. Someone who has just
                         * typed 24 words and wants to check them would lose
                         * them to the act of asking -- the one outcome nobody
                         * would choose on purpose.
                         *
                         * There is also nothing to show: the phrase came from
                         * the user's own paper a moment ago, and no stored
                         * seed is reachable while a temporary one is loaded.
                         * So this goes to the screen that explains the mode
                         * rather than silently doing nothing or destroying
                         * what it was asked to display. */
                        ui_set_screen(SCREEN_TEMP_SEED);
                        break;
                    }
                    lock_device();
                    pending_mnemonic_display = true;
                    ui_set_screen(SCREEN_PIN_UNLOCK);
                    break;
                case SET_NEW_WALLET:
                    /* The same route as the main menu's New Wallet, and for
                     * the same reason: the entropy gate is 128 bits for 12
                     * words and 256 for 24, so the length has to be chosen
                     * before the screen that measures against it. Two entry
                     * points to one flow is exactly how one of them keeps the
                     * old behaviour -- this one did. */
                    create_entropy_ready = false;
                    ui_set_screen(SCREEN_WALLET_CREATE);
                    break;
                case SET_IMPORT_WALLET:
                    ui_set_screen(SCREEN_MNEMONIC_ENTRY);
                    break;
                case SET_PASSPHRASE:
                    ui_set_screen(SCREEN_PASSPHRASE);
                    break;
                case SET_ACCOUNT:
                    /* Cycles, like Brightness and Auto-lock. Ten presses to
                     * cross the range is acceptable for something changed
                     * rarely, and it costs no extra screen; the wallet screen
                     * shows the resulting path in full, which is where the
                     * change is actually confirmed. */
                    hd_account_set(hd_account + 1);
                    ESP_LOGI(TAG, "Account %u selected", (unsigned)hd_account);
                    break;
                case SET_ENTRY_STYLE:
                    entry_blocks_apply(!mnemonic_entry_blocks_enabled());
                    entry_blocks_save();
                    ESP_LOGI(TAG, "Word entry: %s",
                             mnemonic_entry_blocks_enabled() ? "blocks" : "simple");
                    break;

                case SET_BRIGHTNESS:
                    brightness_choice = (brightness_choice + 1) % (int)BRIGHTNESS_COUNT;
                    brightness_apply_and_save();
                    ESP_LOGI(TAG, "Brightness set to %s",
                             brightness_label(brightness_choice));
                    break;
                case SET_AUTOLOCK:
                    lock_timeout_choice = (lock_timeout_choice + 1) % (int)LOCK_TIMEOUT_COUNT;
                    lock_timeout_save();
                    ESP_LOGI(TAG, "Auto-lock set to %s",
                             lock_timeout_label(lock_timeout_choice));
                    break;
                case SET_CHANGE_PIN:
                    ui_set_screen(SCREEN_PIN_CHANGE);
                    break;
#ifdef CONFIG_ESP_WIFI_ENABLED
                case SET_WIFI: wifi_test_toggle(); break;
#endif
                case SET_TRANSPORT:
                    /* Turning one on turns the other off and kills any
                     * session; transport.c is the only place that may. */
                    /* transport_apply() reports the radio to the entropy gate
                     * itself, at boot as well as here. */
                    transport_toggle();
                    break;
                case SET_BLE_NAME:
                    ui_set_screen(SCREEN_BLE_NAME);
                    break;
                case SET_USB:  usb_hid_test();     break;
                case SET_BLIND:
                    /* Asymmetric on purpose. Turning the protection back on
                     * is one press, because nothing is lost by doing it by
                     * accident; turning it off goes through a screen that
                     * says what it costs and asks repeatedly. */
                    if (blind_signing_enabled()) {
                        blind_signing_set(false);
                    } else {
                        ui_set_screen(SCREEN_BLIND_WARN);
                    }
                    break;
                case SET_WIPE:
                    ui_set_screen(SCREEN_WIPE_CONFIRM);
                    break;
                case SET_BACK:
                    ui_set_screen(SCREEN_MAIN_MENU);
                    break;
                default:
                    break;
            }
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * QR Code Screen
 * ============================================================================ */

static void screen_qr_code_enter(void)
{
    ESP_LOGI(TAG, "QR code screen");

    /* eth_address should already be populated from wallet_info screen */
    if (!address_valid()) {
        /* Fallback: try to get address again */
        address_error[0] = '\0';
        if (ensure_wallet_unlocked()) {
            WalletStatus status = wallet_get_status();
            if (status.wallet_count > 0) {
                if (status.active_wallet_index == 0) {
                    wallet_select_wallet(1);
                }
                HDPath eth_path = hd_path_at(address_index);
                if (wallet_get_address_at_path(&eth_path, &eth_address) != WALLET_OK) {
                    set_address_error("Addr failed");
                }
            } else {
                set_address_error("No wallet");
            }
        } else {
            set_address_error("Unlock failed");
        }
    }
}

static void screen_qr_code_render(void)
{
    /* One gate, asked of the same field the QR is built from.
     *
     * The old check listed the error strings it knew about, so every failure
     * added later - "Addr failed", "Derive failed" - was encoded into a QR
     * code and presented to a camera as a receive address. Ask whether there
     * is an address instead of trying to enumerate the ways there is not. */
    if (!address_valid()) {
        oled_clear();
        oled_draw_string_centered(3, "No address");
        oled_draw_string(7, 0, "BACK");
        return;
    }

    /* Draw QR code (fills entire display) */
    oled_draw_qrcode(eth_address.hex);

    /* We can't overlay text on QR code easily, so just show the QR */
    /* User can press buttons to navigate */
}

static void screen_qr_code_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_CANCEL:
        case BUTTON_UP:
            /* Go back to wallet info */
            ui_set_screen(SCREEN_WALLET_INFO);
            break;

        case BUTTON_ACCEPT:
        case BUTTON_DOWN:
            /* Also just goes back.
             *
             * This used to mean "reveal the seed phrase", which locked the
             * device and demanded the PIN. The QR fills the display, so there
             * was no footer to say so, and pressing a button to leave a screen
             * instead locked you out of it. Revealing the seed now lives in
             * Settings, where it is labelled. */
            ui_set_screen(SCREEN_WALLET_INFO);
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Entropy Collection Screen
 *
 * Mandatory extra randomness before generating a seed, in two flavours, both
 * mixed with the hardware RNG and neither substituted for it (entropy.h).
 *
 *   - Button presses. What is harvested is not which button but the timing
 *     between presses. Worth 2 bits each, and that number is an estimate: both
 *     audits found the bits actually come from ui_task's dequeue jitter rather
 *     than from the human, and that variance has never been measured on a
 *     board.
 *   - Physical dice. Worth log2(6) = 2.585 bits each, and that number is
 *     arithmetic. This is why the mode exists: the health checks in entropy.c
 *     provably cannot see a source that is statistically clean and shallow -
 *     0 detections in 200,000 trials, which is Coldcard's 2021 defect exactly -
 *     so user-supplied entropy is the only layer covering it, and a layer that
 *     important should rest on a number that can be defended rather than
 *     modelled.
 *
 * The two compose without overlapping: a roll's own button presses are hashed
 * into the pool and credited zero bits, so the gate's total is a strict lower
 * bound with the dice-press jitter left over as margin.
 * ============================================================================ */

/* The gate, in bits rather than in presses. 128 is the strength of a 12-word
 * seed and the floor this screen has always enforced; expressing it as bits is
 * what lets presses and rolls be spent interchangeably against it.
 *
 * Pure press mode still means exactly 64 presses (64 x 2 bits), which is where
 * the count landed when BITS_PER_EVENT was corrected from 4 to 2. Pure dice mode
 * means 50 rolls: 50 x 2585/1000 = 129 bits. A hundred rolls is 258 bits, i.e.
 * full 256-bit strength from the dice alone, which anyone who wants it can reach
 * by carrying on rolling rather than being demanded of everyone. */
/* The gate follows the seed the user asked for, which is why the word count is
 * now chosen before this screen rather than after it.
 *
 * Collecting 128 bits and then choosing 24 words used to be possible, and it
 * quietly meant a 256-bit seed with 128 bits of user entropy behind it. That is
 * only a real difference if the hardware RNG is shallow -- but that is the
 * exact case this pool exists for, so it is the case the number has to be right
 * in. Asking for the length first costs one screen and makes the gate mean what
 * a reader would assume it means. */
static int entropy_target_bits(void)
{
    return create_word_count == 24 ? 256 : 128;
}

/* Mirrors DICE_MILLIBITS_PER_ROLL in entropy.c. Used only to turn a bits
 * shortfall back into a roll count for the display; the credited figure always
 * comes from entropy_dice_bits() so there is one source of truth for the claim. */
#define ENTROPY_MILLIBITS_PER_ROLL 2585

typedef enum {
    ENTROPY_MODE_CHOOSE = 0,
    ENTROPY_MODE_DICE,
    ENTROPY_MODE_PRESS,
} entropy_mode_t;

static entropy_mode_t entropy_mode = ENTROPY_MODE_CHOOSE;
static int  entropy_menu_sel = 0;
/* The face the selector is showing, which is NOT yet in the pool. It survives a
 * commit so that rolling the same number twice is one press, and so the screen
 * always displays a value the user last looked at rather than snapping back to
 * a default they then have to re-read. */
static uint8_t dice_face = 1;
/* The last committed face, echoed back so a misentry is visible immediately.
 * There is no undo, and cannot be: the pool is a running SHA-256 and a commit is
 * not reversible. That is acceptable precisely because a wrong roll is not a
 * security problem - it is still an unpredictable value mixed into a hash - but
 * a user who cannot tell what they entered will not trust the ceremony, so the
 * cost of the missing undo is paid in confirmation instead. */
static uint8_t dice_last = 0;

static bool entropy_target_met(void)
{
    return entropy_total_bits_estimate() >= entropy_target_bits();
}

/* How many more presses / rolls would finish the job, given what the OTHER
 * source has already contributed. Computed rather than fixed because a user who
 * rolled 30 dice should not then be told they still owe 64 presses. */
static int entropy_press_target(void)
{
    int need = entropy_target_bits() - entropy_total_bits_estimate();
    if (need <= 0) return entropy_user_event_count();
    return entropy_user_event_count() + (need + 1) / 2;
}

static int entropy_dice_target(void)
{
    int need = entropy_target_bits() - entropy_total_bits_estimate();
    if (need <= 0) return entropy_dice_roll_count();
    int rolls = (need * 1000 + ENTROPY_MILLIBITS_PER_ROLL - 1) / ENTROPY_MILLIBITS_PER_ROLL;
    return entropy_dice_roll_count() + rolls;
}

static void screen_entropy_enter(void)
{
    ESP_LOGI(TAG, "Entropy collection screen");
    /* Nothing may be listening while a seed is made. This is the first screen
     * of wallet creation, so suspending here covers the whole of it: the
     * collection, the generation, the words on screen and their verification.
     * screen_main_menu_enter() puts the link back, and every way out of this
     * flow -- finishing, cancelling, failing -- goes through the main menu.
     *
     * The device cannot tell what it is plugged into, so this is the part it
     * can enforce. The part it cannot is the cable: see docs/VAULT.md on
     * generating a seed on power alone. */
    transport_suspend();
    entropy_reset_user_pool();
    entropy_mode     = ENTROPY_MODE_CHOOSE;
    entropy_menu_sel = 0;
    dice_face        = 1;
    dice_last        = 0;
}

/* --------------------------------------------------------------- chooser */

static void screen_entropy_render_choose(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Add Randomness");

    /* 32 rather than the 21 columns the display has: the compiler has to be able
     * to prove no truncation, and the bit totals are int-width to it. */
    char line[32];
    snprintf(line, sizeof(line), "dice %d = %d bits",
             entropy_dice_roll_count(), entropy_dice_bits());
    oled_draw_string(1, 0, line);
    snprintf(line, sizeof(line), "taps %d = %d bits",
             entropy_user_event_count(), entropy_user_bits_estimate());
    oled_draw_string(2, 0, line);

    bool ready = entropy_target_met();

    oled_draw_string(4, 0, entropy_menu_sel == 0 ? "> Roll dice" : "  Roll dice");
    oled_draw_string(5, 0, entropy_menu_sel == 1 ? "> Tap buttons" : "  Tap buttons");
    if (ready) {
        oled_draw_string(6, 0, entropy_menu_sel == 2 ? "> Create wallet"
                                                     : "  Create wallet");
    } else {
        snprintf(line, sizeof(line), "  need %d bits",
                 entropy_target_bits() - entropy_total_bits_estimate());
        oled_draw_string(6, 0, line);
    }

    oled_draw_string(7, 0, "UP  DN  BCK SEL");
}

/* ------------------------------------------------------------ dice entry */

static void screen_entropy_render_dice(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Physical Dice");

    /* The warning is on screen every frame, not once behind an OK button,
     * because the failure it prevents is a user who is *more* confident for
     * having done the ceremony wrong. A phone's dice app is an unauditable PRNG
     * on a networked computer: if the phone is compromised the attacker chose
     * this seed, and the user believes it is the strongest one they have ever
     * made. Rolling nothing at all is strictly safer than that. */
    /* "dice", not the singular "die", which is the technically correct word
     * and the wrong one here. Most readers of this screen do not have English
     * as a first language and know "dice"; and on a wallet's warning line the
     * word "die" reads for half a second as the verb. Grammar loses to being
     * understood at a glance. */
    oled_draw_string(1, 0, "Use REAL dice -");
    oled_draw_string(2, 0, "phone apps can lie");

    char line[22];
    snprintf(line, sizeof(line), "roll %d/%d  ~%d bits",
             entropy_dice_roll_count(), entropy_dice_target(),
             entropy_dice_bits());
    oled_draw_string(3, 0, line);

    /* All six faces, with the armed one bracketed. Showing the whole range
     * rather than a bare number means the value is read as a position as well
     * as a digit, which is what makes a slip visible before ROLL commits it. */
    char sel[20];
    int n = 0;
    for (int f = 1; f <= 6; f++) {
        sel[n++] = (f == dice_face) ? '[' : ' ';
        sel[n++] = (char)('0' + f);
        sel[n++] = (f == dice_face) ? ']' : ' ';
    }
    sel[n] = '\0';
    oled_draw_string_centered(5, sel);

    if (dice_last) {
        snprintf(line, sizeof(line), "entered: %d", dice_last);
        oled_draw_string_centered(6, line);
    } else {
        oled_draw_string_centered(6, "roll, then ROLL");
    }

    oled_draw_string(7, 0, "+1  -1  BCK ROLL");
}

/* ---------------------------------------------------------- press entry */

static void screen_entropy_render_press(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Add Randomness");

    int events = entropy_user_event_count();
    int target = entropy_press_target();

    char line[22];
    snprintf(line, sizeof(line), "%d / %d  (+%d bits)",
             events, target, entropy_user_bits_estimate());
    oled_draw_string_centered(2, line);

    /* A 16-cell bar so progress is legible at a glance. */
    char bar[19];
    int filled = (events >= target) ? 16 : (events * 16) / target;
    bar[0] = '[';
    for (int i = 0; i < 16; i++) {
        bar[1 + i] = (i < filled) ? '#' : '-';
    }
    bar[17] = ']';
    bar[18] = '\0';
    oled_draw_string_centered(4, bar);

    /* One job per button, and the footer says which (T61).
     *
     * UP and DOWN are the only samples; ACCEPT only ever proceeds. It used to
     * be a sample too until the target was met, which made the same press mean
     * "collect" and then "create a wallet" - the one press on this screen that
     * must not be reached by reflex. Until it does something it is drawn as
     * unavailable rather than as a third way to stir the pool. */
    if (entropy_target_met()) {
        oled_draw_string_centered(5, "Ready");
        oled_draw_string(7, 0, "MIX MIX BCK NEXT");
    } else {
        char remaining[22];
        snprintf(remaining, sizeof(remaining), "%d more to go", target - events);
        oled_draw_string_centered(5, remaining);
        /* No NEXT yet - the target is required, not suggested. CANCEL still
         * backs out so nobody is stuck on this screen. */
        oled_draw_string(7, 0, "MIX MIX BCK ----");
    }
}

static void screen_entropy_render(void)
{
    switch (entropy_mode) {
        case ENTROPY_MODE_DICE:  screen_entropy_render_dice();   break;
        case ENTROPY_MODE_PRESS: screen_entropy_render_press();  break;
        default:                 screen_entropy_render_choose(); break;
    }
}

static void screen_entropy_proceed(void)
{
    /* Counts and totals. The roll values themselves are entropy and never reach
     * a log line - the same rule the seed words are under. */
    ESP_LOGI(TAG, "Collected %d taps + %d rolls (~%d bits) for the pool",
             entropy_user_event_count(), entropy_dice_roll_count(),
             entropy_total_bits_estimate());
    /* Set before the screen change, because ui_set_screen() runs the enter
     * hook synchronously and that hook is what reads it. */
    create_entropy_ready = true;
    ui_set_screen(SCREEN_WALLET_CREATE);
}

static void screen_entropy_on_button(button_id_t btn)
{
    /* CANCEL never lowers the bar. From a collection mode it steps back to the
     * chooser, keeping everything already contributed - a user switching from
     * dice to taps is not restarting. From the chooser it abandons wallet
     * creation outright, which is the only escape offered: "do not create a
     * wallet", never "create one with less entropy". */
    if (btn == BUTTON_CANCEL) {
        if (entropy_mode != ENTROPY_MODE_CHOOSE) {
            entropy_mode = ENTROPY_MODE_CHOOSE;
            ui_invalidate();
            return;
        }
        ESP_LOGI(TAG, "Entropy collection cancelled at %d taps, %d rolls",
                 entropy_user_event_count(), entropy_dice_roll_count());
        entropy_reset_user_pool();
        dice_face = 1;
        dice_last = 0;
        ui_set_screen(SCREEN_MAIN_MENU);
        return;
    }

    if (entropy_mode == ENTROPY_MODE_CHOOSE) {
        int items = entropy_target_met() ? 3 : 2;
        switch (btn) {
            case BUTTON_UP:
                entropy_menu_sel = (entropy_menu_sel + items - 1) % items;
                break;
            case BUTTON_DOWN:
                entropy_menu_sel = (entropy_menu_sel + 1) % items;
                break;
            case BUTTON_ACCEPT:
                if (entropy_menu_sel == 0) {
                    entropy_mode = ENTROPY_MODE_DICE;
                } else if (entropy_menu_sel == 1) {
                    entropy_mode = ENTROPY_MODE_PRESS;
                } else {
                    screen_entropy_proceed();
                    return;
                }
                break;
            default:
                break;
        }
        ui_invalidate();
        return;
    }

    if (entropy_mode == ENTROPY_MODE_DICE) {
        /* UP and DOWN move the selector; ACCEPT is the only thing that commits,
         * and it commits a roll and nothing else. Proceeding to generation is
         * not reachable from this mode at all - it lives behind BCK, on the
         * chooser - so the button being pressed a hundred times in a row can
         * never become the button that creates a wallet.
         *
         * The selector wraps, which is what keeps entry at roughly two presses
         * per roll: the mean circular distance between two faces of a d6 is 1.5,
         * plus the commit. It also keeps the previous face armed, so a repeated
         * number costs a single press. */
        switch (btn) {
            case BUTTON_UP:
                dice_face = (uint8_t)(dice_face % 6 + 1);
                break;
            case BUTTON_DOWN:
                dice_face = (uint8_t)((dice_face + 4) % 6 + 1);
                break;
            case BUTTON_ACCEPT:
                entropy_add_dice_roll(dice_face, (uint64_t)esp_timer_get_time());
                dice_last = dice_face;
                break;
            default:
                break;
        }
        ui_invalidate();
        return;
    }

    /* Press mode. ACCEPT is the "proceed" button and nothing else. It does
     * nothing at all until the target is met, rather than quietly counting as a
     * sample: a button whose meaning changes partway through teaches the user
     * the wrong reflex for the one press that creates a wallet.
     *
     * This costs nothing in entropy. What the pool harvests is the timing
     * jitter between presses, so two collecting buttons gather exactly what
     * four would - and the seed is full strength either way, because
     * entropy_mix_pool() hashes this pool together with the hardware RNG and
     * user input can only add to it. */
    if (btn == BUTTON_ACCEPT) {
        if (entropy_target_met()) {
            screen_entropy_proceed();
        }
        return;
    }

    /* UP and DOWN collect. What is harvested is the timing, not which one. */
    entropy_add_user_event((uint8_t)btn, (uint64_t)esp_timer_get_time());
    ui_invalidate();
}

/* ============================================================================
 * Wipe Confirmation Screen
 *
 * Wiping was previously immediate from a three-item menu, and a live test
 * destroyed a wallet by selecting it while scrolling. Destructive and
 * irreversible actions get a stop.
 * ============================================================================ */

/* Deliberately awkward: hold-to-confirm rather than a single press, so the
 * gesture cannot be reached by the same reflex that selected the menu item. */
#define WIPE_CONFIRM_PRESSES 3

/* More friction when a seed has never been read back, because that is the case
 * where the device holds the only usable copy. */
#define WIPE_CONFIRM_PRESSES_UNVERIFIED 5

static int wipe_confirm_count = 0;

static void screen_wipe_confirm_enter(void)
{
    ESP_LOGI(TAG, "Wipe confirmation screen");
    wipe_confirm_count = 0;
}

static void screen_wipe_confirm_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "!! WIPE DEVICE !!");

    WalletStatus status = wallet_get_status();
    char line[22];
    snprintf(line, sizeof(line), "Erases %u wallet%s",
             (unsigned)status.wallet_count, status.wallet_count == 1 ? "" : "s");
    oled_draw_string_centered(2, line);
    oled_draw_string_centered(3, "and the PIN.");

    /* The dangerous case is not "was this the owner" - Settings already
     * required the PIN, and three wrong PINs wipe the device anyway. It is
     * erasing a seed whose backup was never confirmed correct. */
    uint8_t unverified = wallet_unverified_count();
    if (unverified > 0) {
        snprintf(line, sizeof(line), "%u NOT backed up!", (unsigned)unverified);
        oled_draw_string_centered(4, line);
    } else {
        oled_draw_string_centered(4, "No undo.");
    }

    int required = (wallet_unverified_count() > 0)
                       ? WIPE_CONFIRM_PRESSES_UNVERIFIED
                       : WIPE_CONFIRM_PRESSES;
    int left = required - wipe_confirm_count;
    char msg[32];
    snprintf(msg, sizeof(msg), "Press OK %u more", (unsigned)(left < 0 ? 0 : left));
    oled_draw_string_centered(6, msg);

    oled_draw_string(7, 0, "BACK        WIPE");
}

static void screen_wipe_confirm_on_button(button_id_t btn)
{
    int required = (wallet_unverified_count() > 0)
                       ? WIPE_CONFIRM_PRESSES_UNVERIFIED
                       : WIPE_CONFIRM_PRESSES;

    if (btn == BUTTON_ACCEPT) {
        if (++wipe_confirm_count >= required) {
            ESP_LOGW(TAG, "Wipe confirmed by user");
            device_wipe();
            wallet_init();
            /* The wipe erased the stored flag; drop the cached copy too, or
             * this boot would keep answering "on" for a device that no longer
             * has it stored and the next boot would disagree. */
            blind_signing_forget();
            /* Same reasoning one level down (T45): the account selection lives
             * in the settings namespace, which a wipe does not erase, so a
             * wiped device would come up deriving the next seed at whatever
             * account the previous owner left selected. */
            hd_account_set(0);
            memzero(mnemonic_buffer, sizeof(mnemonic_buffer));
            mnemonic_word_count = 0;
            /* bip39.c's static phrase buffer as well. A wipe that leaves the
             * seed readable in RAM is not a wipe, and this path does not exit
             * through forget_mnemonic_unless_needed(). */
            mnemonic_clear();
            mnemonic_entry_clear(&entry);
            entropy_reset_user_pool();
            ESP_LOGW(TAG, "Device wiped");
            ui_set_screen(SCREEN_PIN_SETUP);
            return;
        }
    } else {
        /* Anything else aborts. */
        ui_set_screen(SCREEN_SETTINGS);
        return;
    }

    ui_invalidate();
}

/* ============================================================================
 * Blind Signing Warning (T16, PROTOCOL.md 6bis)
 *
 * The device refuses calldata it cannot describe. This screen is the only way
 * past that refusal, and it deliberately costs something: the same repeated
 * deliberate act as a wipe, because both are decisions whose consequence
 * arrives later and cannot be taken back at the moment it matters.
 *
 * There is no command that reaches here. A host able to switch the protection
 * off would be a host the protection never protected you from, so enabling is
 * on-device only, by construction rather than by policy.
 * ============================================================================ */

/* One more than a wipe's three. A wipe destroys a device you can restore from
 * a backup; this one changes what every future signature means, silently, from
 * now on. */
#define BLIND_CONFIRM_PRESSES 5

static int blind_confirm_count = 0;

static void screen_blind_warn_enter(void)
{
    ESP_LOGI(TAG, "Blind signing warning screen");
    blind_confirm_count = 0;
}

static void screen_blind_warn_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "!! BLIND SIGN !!");

    /* What it costs, in words, and no reassurance. The user is about to give
     * up the thing that makes this a hardware wallet rather than a keyring. */
    oled_draw_string(1, 0, "Allows signing");
    oled_draw_string(2, 0, "calls this device");
    oled_draw_string(3, 0, "cannot read.");
    oled_draw_string(4, 0, "A bad app can");
    oled_draw_string(5, 0, "drain you.");

    int left = BLIND_CONFIRM_PRESSES - blind_confirm_count;
    char msg[32];
    snprintf(msg, sizeof(msg), "Press OK %u more", (unsigned)(left < 0 ? 0 : left));
    oled_draw_string_centered(6, msg);

    oled_draw_string(7, 0, "BACK      ENABLE");
}

static void screen_blind_warn_on_button(button_id_t btn)
{
    if (btn != BUTTON_ACCEPT) {
        /* Anything else abandons it, and the count goes with the screen. */
        ui_set_screen(SCREEN_SETTINGS);
        return;
    }

    if (++blind_confirm_count >= BLIND_CONFIRM_PRESSES) {
        if (!blind_signing_set(true)) {
            /* Failing to persist means the next boot would disagree with this
             * one about whether the device is protected. Say so and stay off
             * rather than run in a state that will not survive a reset. */
            ESP_LOGE(TAG, "Blind signing could not be stored; left off");
        }
        ui_set_screen(SCREEN_SETTINGS);
        return;
    }

    ui_invalidate();
}

/* ============================================================================
 * Mnemonic Verification Screen
 *
 * After showing a new seed, ask for a few words back. This is the standard
 * hardware-wallet flow and it exists because "I wrote it down" and "I wrote it
 * down correctly" are different claims, and the difference is only discovered
 * when the backup is needed.
 *
 * Reuses the predictive entry from mnemonic-entry.c, so verification feels the
 * same as import and exercises the same code path.
 * ============================================================================ */

#define VERIFY_CHALLENGES 3

static bool verify_done = false;
static int  verify_indices[VERIFY_CHALLENGES];
static int  verify_current = 0;
static int  verify_failures = 0;
static bool verify_last_wrong = false;

static void verify_pick_challenges(void)
{
    /* Distinct word positions, drawn from the hardware RNG rather than a
     * counter so the challenge cannot be anticipated. */
    for (int i = 0; i < VERIFY_CHALLENGES; i++) {
        bool unique;
        int candidate;
        do {
            unique = true;
            candidate = (int)(esp_random() % (uint32_t)mnemonic_word_count);
            for (int j = 0; j < i; j++) {
                if (verify_indices[j] == candidate) { unique = false; break; }
            }
        } while (!unique);
        verify_indices[i] = candidate;
    }
}

static void screen_mnemonic_verify_enter(void)
{
    ESP_LOGI(TAG, "Mnemonic verification screen");

    if (mnemonic_word_count == 0) {
        ui_set_screen(SCREEN_WALLET_INFO);
        return;
    }

    verify_pick_challenges();
    verify_current = 0;
    verify_failures = 0;
    verify_last_wrong = false;
    verify_done = false;
    mnemonic_entry_reset(&entry, 12);
}

static void screen_mnemonic_verify_render(void)
{
    oled_clear();

    if (verify_done) {
        oled_draw_string_centered(1, "Backup verified");
        oled_draw_string_centered(3, "Keep the phrase");
        oled_draw_string_centered(4, "somewhere safe.");
        oled_draw_string(7, 0, "            DONE");
        return;
    }

    WalletStatus vstatus = wallet_get_status();
    char header[22];
    unsigned step = (unsigned)(verify_current + 1) & 0x7;
    if (vstatus.wallet_count > 1) {
        snprintf(header, sizeof(header), "Verify W%u %u/%u",
                 (unsigned)vstatus.active_wallet_index & 0x3F,
                 step, (unsigned)VERIFY_CHALLENGES);
    } else {
        snprintf(header, sizeof(header), "Verify %u/%u", step,
                 (unsigned)VERIFY_CHALLENGES);
    }
    oled_draw_string_centered(0, header);

    char prompt[22];
    int word_no = verify_indices[verify_current] + 1;
    snprintf(prompt, sizeof(prompt), "Enter word #%d",
             (word_no < 1 || word_no > 24) ? 1 : word_no);
    oled_draw_string_centered(1, prompt);

    char typed[MNEMONIC_ENTRY_WORD_LEN + 24];
    entry_selector_line(typed, sizeof(typed));
    oled_draw_string(3, 0, "Type:");
    oled_draw_string(3, 36, typed);

    if (verify_last_wrong) {
        oled_draw_string(5, 0, "Wrong - try again");
    } else {
        if (entry.word_mode) {
            char line[22];
            snprintf(line, sizeof(line), "%d of %d",
                     entry.option_index + 1, entry.option_count);
            oled_draw_string(5, 0, "Choice:");
            oled_draw_string(5, 48, line);
        } else {
            const char *suggestion = mnemonic_entry_suggestion(&entry);
            if (suggestion) {
                oled_draw_string(5, 0, "Match:");
                oled_draw_string(5, 42, suggestion);
            }
        }
    }

    /* With a block open, BACK closes it instead of deleting a character, so
     * the hint has to say which one the next press will do. */
    oled_draw_string(7, 0, entry.in_group ? "UP DN  BCK  SEL" : "UP DN  DEL  SEL");
}

static void screen_mnemonic_verify_on_button(button_id_t btn)
{
    if (verify_done) {
        /* Any button continues; the device stays unlocked, since verifying a
         * backup is not a reason to make the user authenticate again. */
        ui_set_screen(SCREEN_WALLET_INFO);
        return;
    }

    verify_last_wrong = false;

    switch (btn) {
        case BUTTON_UP:   mnemonic_entry_scroll(&entry, 1);  break;
        case BUTTON_DOWN: mnemonic_entry_scroll(&entry, -1); break;

        case BUTTON_CANCEL:
            if (!mnemonic_entry_back(&entry)) {
                /* Backing out of verification returns to the seed, not onward -
                 * the user may need to read it again. */
                ui_set_screen(SCREEN_MNEMONIC_DISPLAY);
            }
            break;

        case BUTTON_ACCEPT: {
            if (mnemonic_entry_accept(&entry) == MNEMONIC_ENTRY_CONTINUE) {
                break;
            }

            /* A word was committed - compare it against the real one. */
            char expected[MNEMONIC_ENTRY_WORD_LEN];
            if (!get_mnemonic_word(mnemonic_buffer, verify_indices[verify_current],
                                   expected, sizeof(expected))) {
                ui_set_screen(SCREEN_WALLET_INFO);
                return;
            }

            bool correct = (strcmp(entry.words[0], expected) == 0);
            memzero(expected, sizeof(expected));
            mnemonic_entry_reset(&entry, 12);

            if (!correct) {
                verify_failures++;
                verify_last_wrong = true;
                ESP_LOGW(TAG, "Verification failed for word #%d (attempt %d)",
                         verify_indices[verify_current] + 1, verify_failures);

                /* Three misses means the backup is probably wrong, not the
                 * typing. Send them back to read the phrase again. */
                if (verify_failures >= 3) {
                    ESP_LOGW(TAG, "Too many misses; showing the phrase again");
                    verify_failures = 0;
                    ui_set_screen(SCREEN_MNEMONIC_DISPLAY);
                }
                break;
            }

            verify_current++;
            if (verify_current >= VERIFY_CHALLENGES) {
                ESP_LOGI(TAG, "Seed phrase verified");
                {
                    WalletStatus vs = wallet_get_status();
                    wallet_mark_backup_verified(vs.active_wallet_index);
                }
                /* The seed has served its purpose on screen; do not leave it
                 * sitting in .bss (AUDIT.md S5). */
                memzero(mnemonic_buffer, sizeof(mnemonic_buffer));
                mnemonic_word_count = 0;
                mnemonic_entry_clear(&entry);

                /* Say it passed before moving on. Jumping straight to the
                 * address screen leaves the user unsure whether the check
                 * succeeded or the device simply gave up on them. */
                verify_done = true;
                ui_invalidate();
                return;
            }
            break;
        }

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Session Confirmation Screen
 *
 * The whole point of the passkey. It is derived from the ECDH shared secret,
 * so an attacker relaying between the host and the device holds a different
 * secret and cannot make the two codes agree. Encryption alone would protect a
 * conversation with an impostor perfectly well; a human comparing two screens
 * is what notices one.
 *
 * Which means this screen is not a formality to be skipped or auto-confirmed.
 * Without someone actually looking, the channel is encrypted and unauthenticated.
 * ============================================================================ */

static volatile bool session_confirm_pending = false;
static screen_id_t   session_confirm_return = SCREEN_MAIN_MENU;

static volatile bool host_unlock_pending = false;
static volatile bool host_lock_pending = false;

void ui_request_unlock(void)
{
    host_unlock_pending = true;
}

void ui_request_lock(void)
{
    host_lock_pending = true;
}

void ui_request_session_confirm(void)
{
    /* Called from the protocol task. Only sets a flag; the UI task owns screen
     * transitions, and having two tasks drive the screen graph is how you get
     * a render against half-changed state. */
    session_confirm_pending = true;
}

static void screen_session_confirm_enter(void)
{
    ESP_LOGI(TAG, "Session confirmation screen");
}

static void screen_session_confirm_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Connect?");

    const char *code = session_passkey();
    char spaced[16];
    /* Grouped 3+3: six digits in a row are easy to misread, and misreading is
     * the failure this screen exists to prevent. */
    snprintf(spaced, sizeof(spaced), "%.3s %.3s", code, code + 3);
    oled_draw_string_centered(2, spaced);

    oled_draw_string_centered(4, "Match the code");
    oled_draw_string_centered(5, "shown in the app");

    oled_draw_string(7, 0, "DENY       ALLOW");
}

static void screen_session_confirm_on_button(button_id_t btn)
{
    if (btn == BUTTON_ACCEPT) {
        session_confirm();
        ESP_LOGI(TAG, "Session confirmed by user");
    } else {
        session_reset();
        ESP_LOGW(TAG, "Session denied by user");
    }
    ui_set_screen(session_confirm_return);
}

/* ============================================================================
 * Passphrase Entry
 *
 * BIP39's optional extra word. Applied to the active seed for this session
 * only; nothing about it is ever written down by the device, which is what
 * gives a passphrase wallet its deniability - and also why a typo cannot be
 * reported as an error. See docs/VAULT.md.
 * ============================================================================ */

static TextEntry passphrase_entry;

static void screen_passphrase_enter(void)
{
    ESP_LOGI(TAG, "Passphrase entry screen");
    text_entry_reset(&passphrase_entry);
}

/* Every button path off this screen already clears the buffer. This is for the
 * paths that are not button paths: the auto-lock timer, and a host request
 * that moves the screen out from under a half-typed passphrase. Without it a
 * passphrase the user never finished typing outlives the lock in .bss, which
 * is the S5 residue in the one buffer S5 did not cover. Unconditional - unlike
 * the seed buffer there is no hand-off that needs it kept. */
static void forget_passphrase_entry(screen_id_t next)
{
    (void)next;
    text_entry_clear(&passphrase_entry);
}

static void screen_passphrase_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Passphrase");

    /* Show the tail of what has been typed. Masking it would be worse than
     * useless here: the user cannot verify a string they cannot see, and the
     * screen is already in their hand. */
    const char *text = passphrase_entry.text;
    int len = passphrase_entry.length;
    const char *tail = (len > 18) ? text + (len - 18) : text;
    char shown[24];
    /* Copy explicitly rather than through %s. The compiler cannot prove the
     * tail is short, and a truncating snprintf would silently misreport what
     * the user typed - on this screen that is the difference between two
     * wallets. */
    size_t out = 0;
    if (len > 18) {
        shown[out++] = '<';
    }
    for (size_t i = 0; tail[i] != '\0' && out < sizeof(shown) - 1; i++) {
        shown[out++] = tail[i];
    }
    shown[out] = '\0';
    oled_draw_string(2, 0, len ? shown : "(empty = no pass)");

    /* Neighbours, so the mode entries are visible before they are reached.
     * With the block selector on these are whole blocks ("a-f"), because a
     * press moves a block and the screen must say what a press does. */
    char prev[8], cur[8], next[8];
    text_entry_label_offset(&passphrase_entry, -1, prev, sizeof(prev));
    text_entry_label_offset(&passphrase_entry,  0, cur,  sizeof(cur));
    text_entry_label_offset(&passphrase_entry,  1, next, sizeof(next));

    char sel[32];
    snprintf(sel, sizeof(sel), "%s <%s> %s", prev, cur, next);
    oled_draw_string_centered(4, sel);

    char count[22];
    snprintf(count, sizeof(count), "%u chars", (unsigned)len & 0x7F);
    oled_draw_string_centered(5, count);

    /* ACCEPT opens a block before it picks anything, so it must not say SEL. */
    oled_draw_string(7, 0, text_entry_on_group(&passphrase_entry)
                               ? "UP DN  BCK OPEN"
                               : "UP DN  BCK  SEL");
}

static void screen_passphrase_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:   text_entry_scroll(&passphrase_entry, 1);  break;
        case BUTTON_DOWN: text_entry_scroll(&passphrase_entry, -1); break;

        case BUTTON_CANCEL:
            /* Closes an open block first, and only then deletes: backing out
             * of the wrong block must not cost a character the user did type. */
            if (!text_entry_back(&passphrase_entry)) {
                text_entry_clear(&passphrase_entry);
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            break;

        case BUTTON_ACCEPT: {
            TextEntryResult r = text_entry_accept(&passphrase_entry);
            if (r == TEXT_ENTRY_CANCELLED) {
                text_entry_clear(&passphrase_entry);
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            if (r == TEXT_ENTRY_DONE) {
                if (!ensure_wallet_unlocked()) {
                    text_entry_clear(&passphrase_entry);
                    ui_set_screen(SCREEN_MAIN_MENU);
                    return;
                }
                wallet_set_passphrase(passphrase_entry.text,
                                      (size_t)passphrase_entry.length);
                /* Typed here, so it is not the host's to revoke: a disconnect
                 * must not drop the user back into the base wallet without
                 * saying so (T42). */
                protocol_note_device_passphrase();
                text_entry_clear(&passphrase_entry);
                address_index = 0;
                ui_set_screen(SCREEN_PASSPHRASE_CONFIRM);
                return;
            }
            break;
        }

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * BLE Device Name (T56)
 *
 * "LeekWallet" broadcast to every scanner in range tells a room that someone
 * in it is carrying a hardware wallet. This is where that stops being true.
 *
 * Set here and nowhere else. There is deliberately no protocol method for it:
 * a host that could rename the device could make it advertise as something
 * else entirely, and the name is one of the few things a user can check
 * against their own phone.
 * ============================================================================ */

static TextEntry ble_name_entry;
/* Set when a name was refused, so the screen can say so rather than appearing
 * to ignore the press. Cleared on the next edit. */
static bool ble_name_rejected = false;

static void screen_ble_name_enter(void)
{
    ESP_LOGI(TAG, "BLE name screen");
    text_entry_reset(&ble_name_entry);
    ble_name_rejected = false;
}

static void screen_ble_name_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "BLE Name");

    /* The tail of what has been typed, same as the passphrase screen and for
     * the same reason: a name the user cannot see is a name they cannot
     * check. Copied by hand rather than through %s because -Werror=
     * format-truncation is on and a truncating snprintf would misreport what
     * was typed. */
    const char *text = ble_name_entry.text;
    int len = ble_name_entry.length;
    const char *tail = (len > 18) ? text + (len - 18) : text;
    char shown[24];
    size_t out = 0;
    if (len > 18) {
        shown[out++] = '<';
    }
    for (size_t i = 0; tail[i] != '\0' && out < sizeof(shown) - 1; i++) {
        shown[out++] = tail[i];
    }
    shown[out] = '\0';
    oled_draw_string(2, 0, len ? shown : ble_name_get());

    int n = text_entry_option_count(&ble_name_entry);
    int idx = ble_name_entry.option_index;
    char sa[4], sb[4], sc[4];
    const char *prev = text_entry_option_label(
        text_entry_option_at(&ble_name_entry, ((idx - 1) % n + n) % n), sa, sizeof(sa));
    const char *cur = text_entry_option_label(
        text_entry_option_at(&ble_name_entry, idx), sb, sizeof(sb));
    const char *next = text_entry_option_label(
        text_entry_option_at(&ble_name_entry, (idx + 1) % n), sc, sizeof(sc));

    char sel[22];
    snprintf(sel, sizeof(sel), "%s <%s> %s", prev, cur, next);
    oled_draw_string_centered(4, sel);

    if (ble_name_rejected) {
        /* Says the limit rather than "invalid": the user has to be able to act
         * on it, and the alternative to saying no here is a device that stops
         * advertising with no explanation at all. */
        char why[22];
        snprintf(why, sizeof(why), "Max %d chars", BLE_NAME_MAX_LEN);
        oled_draw_string_centered(5, why);
    } else {
        char count[22];
        snprintf(count, sizeof(count), "%u/%u chars",
                 (unsigned)len & 0x7F, (unsigned)BLE_NAME_MAX_LEN);
        oled_draw_string_centered(5, count);
    }

    oled_draw_string(7, 0, "UP DN  BCK  SEL");
}

static void screen_ble_name_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:   text_entry_scroll(&ble_name_entry, 1);  break;
        case BUTTON_DOWN: text_entry_scroll(&ble_name_entry, -1); break;

        case BUTTON_CANCEL:
            ble_name_rejected = false;
            if (!text_entry_backspace(&ble_name_entry)) {
                text_entry_clear(&ble_name_entry);
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            break;

        case BUTTON_ACCEPT: {
            ble_name_rejected = false;
            TextEntryResult r = text_entry_accept(&ble_name_entry);
            if (r == TEXT_ENTRY_CANCELLED) {
                text_entry_clear(&ble_name_entry);
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            if (r == TEXT_ENTRY_DONE) {
                /* An empty entry means "leave it alone", not "clear it": a
                 * nameless device is not something the user can ask for by
                 * pressing OK on a blank field by accident. */
                if (ble_name_entry.length == 0) {
                    ui_set_screen(SCREEN_SETTINGS);
                    return;
                }
                /* The refusal that keeps the radio alive. TEXT_ENTRY_MAX is
                 * 64 and the scan response holds 29, so this screen CAN
                 * produce a name that would stop advertising - and the answer
                 * is to say no and stay put, not to silently store a prefix of
                 * a name the user would never see again. */
                if (!ble_name_set(ble_name_entry.text)) {
                    ble_name_rejected = true;
                    break;
                }
                ESP_LOGI(TAG, "BLE name set (%d chars)", ble_name_entry.length);
                /* Put it on air now if the radio is up; otherwise the next
                 * start reads it. */
                ble_transport_refresh_name();
                text_entry_clear(&ble_name_entry);
                ui_set_screen(SCREEN_SETTINGS);
                return;
            }
            break;
        }

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Passphrase Confirmation
 *
 * The one defence against a mistyped passphrase. A wrong passphrase does not
 * error - it derives a different, perfectly valid, empty-looking wallet - so
 * the device shows the resulting address and the user compares it with what
 * they recorded last time.
 *
 * Its limitation is worth stating: on first use there is nothing to compare
 * against. That is exactly why this address must be written down alongside the
 * seed, not merely glanced at.
 * ============================================================================ */

static void screen_passphrase_confirm_enter(void)
{
    ESP_LOGI(TAG, "Passphrase confirmation screen");
    /* Derivation runs PBKDF2 over the new passphrase, so this is the slow one. */
    wallet_info_refresh_address();
}

static void screen_passphrase_confirm_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, wallet_has_passphrase() ? "Passphrase set"
                                                         : "No passphrase");

    /* This screen asks the user to confirm a passphrase by recognising its
     * address. With no address there is nothing to recognise, and rendering
     * blank lines under "Match your record" invites them to accept a wallet
     * that never derived. */
    if (!address_valid()) {
        oled_draw_string_centered(2, "Error");
        oled_draw_string_centered(4, address_error[0] ? address_error : "No address");
        oled_draw_string_centered(6, "Cannot confirm");
        oled_draw_string(7, 0, "RETRY");
        return;
    }

    char line1[17], line2[17], line3[17];
    strncpy(line1, eth_address.hex, 16);      line1[16] = '\0';
    strncpy(line2, eth_address.hex + 16, 14); line2[14] = '\0';
    strncpy(line3, eth_address.hex + 30, 12); line3[12] = '\0';
    oled_draw_string_centered(2, line1);
    oled_draw_string_centered(3, line2);
    oled_draw_string_centered(4, line3);

    /* The fingerprint names the seed, so it is the fact that actually says
     * "this is the passphrase you meant" - the address below it is only one
     * account off that seed. */
    draw_master_xfp(5, "XFP");

    oled_draw_string_centered(6, "Match your record");
    oled_draw_string(7, 0, "RETRY         OK");
}

static void screen_passphrase_confirm_on_button(button_id_t btn)
{
    if (btn == BUTTON_CANCEL) {
        /* Wrong address means the wrong passphrase. Clear it rather than
         * leaving a wallet the user did not intend selected. */
        wallet_clear_passphrase();
        ui_set_screen(SCREEN_PASSPHRASE);
        return;
    }
    ui_set_screen(SCREEN_WALLET_INFO);
}

/* ============================================================================
 * Transaction Confirmation
 *
 * The screen that makes this a hardware wallet rather than a USB key. The
 * fields shown are the device's own parse of the request, and the bytes signed
 * are the ones hashed from exactly these values. A host that says one thing and
 * sends another is visible here, which is the only place it can be.
 *
 * Paged, because 128x64 cannot hold a 42-character address, an amount, a chain
 * and a source address at a legible size. Every page must be seen before the
 * approve option appears - scrolling past is the point, not an obstacle.
 *
 * Which pages exist depends on what the device could decode. A token transfer
 * has a different set of facts worth reading than a native one, and the
 * protocol task has already refused anything outside the decodable set (T50)
 * unless the owner turned blind signing on (T16) — which is the only way a
 * page here ever renders "unknown", and when it does it says so in those
 * words rather than dressing the call up as something it understood.
 * ============================================================================ */

typedef enum {
    SIGN_PAGE_MESSAGE,      /* the full text of an EIP-191 personal_sign */
    SIGN_PAGE_VALUE,        /* amount in ether, and the chain */
    SIGN_PAGE_TO,           /* recipient of a native transfer */
    SIGN_PAGE_ACTION,       /* what the token call does, and for how much */
    SIGN_PAGE_PARTY,        /* the token recipient or the approved spender */
    SIGN_PAGE_PARTY2,       /* transferFrom's destination */
    SIGN_PAGE_CONTRACT,     /* the token contract being called, and the chain */
    SIGN_PAGE_BLIND_WARN,   /* blind signing: the device cannot read this call */
    SIGN_PAGE_BLIND_DATA,   /* blind signing: calldata length and its hash */
    SIGN_PAGE_TYPED_DOMAIN, /* EIP-712: which contract, which chain, what name */
    SIGN_PAGE_TYPED_FIELD,  /* EIP-712: one leaf of the struct, one page */
    SIGN_PAGE_TYPED_BLIND,  /* EIP-712: hashed, but not showable in full */
    SIGN_PAGE_CALL_NAME,    /* generic call: the function's name, and the limit
                             * of what a name proves */
    SIGN_PAGE_CALL_ARG,     /* generic call: one declared argument, one page */
    SIGN_PAGE_FROM          /* the address that will sign (T47) */
} SignPageKind;

/* The longest plan is a generic call: its name, one page for each of its six
 * possible arguments, the contract and the source. Typed data wants the domain,
 * one page per struct leaf and the source; a transaction, blind or not, needs
 * at most five. */
#define SIGN_TYPED_PAGES   (EIP712_MAX_RENDER_FIELDS + 2)
#define SIGN_GENERIC_PAGES (ETH_MAX_ARGS + 3)
#define SIGN_MAX_PAGES \
    (SIGN_TYPED_PAGES > SIGN_GENERIC_PAGES ? SIGN_TYPED_PAGES : SIGN_GENERIC_PAGES)

static EthTx        sign_tx;
static EthCall      sign_call;
/* The path the signature will be taken at, carried in whole rather than as an
 * index (T45/T47). The account level is host-selectable, so an index alone
 * cannot say which wallet is signing - and this screen exists to say exactly
 * that. Rendered in full on the source page. */
static HDPath       sign_path_shown;
static char         sign_from[43];
static int          sign_page;
static SignPageKind sign_page_kind[SIGN_MAX_PAGES] = {SIGN_PAGE_FROM};
/* Never zero: the button handler takes a modulus by it, so reaching this
 * screen without a request must be a blank page, not a divide-by-zero.
 * ui_request_sign() overwrites both before the screen can be shown. */
static int          sign_page_count = 1;
static bool         sign_seen[SIGN_MAX_PAGES];
static volatile SignOutcome sign_outcome = SIGN_PENDING;
static volatile bool sign_request_pending = false;

/* A personal_sign request rides the same screen, the same paging and the same
 * outcome as a transaction. A second approval path would be a second place for
 * "what was displayed" and "what was signed" to drift apart, which is the one
 * thing this screen exists to prevent. */
static bool sign_is_message = false;
static char sign_message[ETH_MAX_MESSAGE + 1];

/* Typed data rides the same screen for the same reason, and carries the render
 * model eip712.c built rather than a re-parse of the request. There is exactly
 * one traversal of a typed-data document on this device and this is what it
 * produced; a second one here could disagree with the digest. */
static bool         sign_is_typed = false;
static Eip712Render sign_typed;
/* Which struct leaf each page shows. Parallel to sign_page_kind[] and only
 * meaningful for SIGN_PAGE_TYPED_FIELD. */
static int          sign_page_field[SIGN_MAX_PAGES];

/* Set when the request got here only because blind signing is on. The screen
 * has to look different from a normal confirmation - same buttons, same paging
 * rule, but nobody should be able to approve one while thinking they approved
 * the other. */
static bool    sign_blind = false;
static uint8_t sign_data_hash[32];   /* keccak256 of the calldata as received */

void ui_request_sign_message(const char *message, size_t length,
                             const HDPath *path, const char *from)
{
    memzero(&sign_tx, sizeof(sign_tx));
    memzero(&sign_call, sizeof(sign_call));
    memzero(sign_message, sizeof(sign_message));

    /* Truncation here would show less than is signed, so refuse the whole
     * request rather than display a prefix. The protocol task has already
     * bounded it; this is the belt to that pair of braces. */
    if (!message || length > ETH_MAX_MESSAGE) {
        sign_outcome = SIGN_REJECTED;
        return;
    }
    memcpy(sign_message, message, length);
    sign_message[length] = '\0';

    sign_is_message = true;
    sign_is_typed = false;
    /* A message that reached this screen was renderable in full; blind
     * signing does not and must not reopen the ones that were not. */
    sign_blind = false;
    memzero(sign_data_hash, sizeof(sign_data_hash));
    sign_path_shown = path ? *path : (HDPath)HDPATH_ETH_DEFAULT;
    if (from) {
        snprintf(sign_from, sizeof(sign_from), "%s", from);
    } else {
        sign_from[0] = '\0';
    }

    sign_page_kind[0] = SIGN_PAGE_MESSAGE;
    sign_page_kind[1] = SIGN_PAGE_FROM;
    sign_page_count = 2;

    sign_outcome = SIGN_PENDING;
    sign_request_pending = true;
}

void ui_request_sign_typed_data(const Eip712Render *render,
                                const uint8_t digest[32], bool blind,
                                const HDPath *path, const char *from)
{
    memzero(&sign_tx, sizeof(sign_tx));
    memzero(&sign_call, sizeof(sign_call));
    memzero(sign_message, sizeof(sign_message));
    memzero(&sign_typed, sizeof(sign_typed));

    if (!render || !digest) {
        sign_outcome = SIGN_REJECTED;
        return;
    }
    sign_typed = *render;

    sign_is_message = false;
    sign_is_typed = true;
    sign_blind = blind;
    /* The typed-data digest, not a calldata hash — but the same field, because
     * the page that draws it is asking the same question: which exact bytes is
     * this signature over, so they can be checked somewhere else. */
    memcpy(sign_data_hash, digest, sizeof(sign_data_hash));

    sign_path_shown = path ? *path : (HDPath)HDPATH_ETH_DEFAULT;
    if (from) {
        snprintf(sign_from, sizeof(sign_from), "%s", from);
    } else {
        sign_from[0] = '\0';
    }

    int n = 0;
    memset(sign_page_field, 0, sizeof(sign_page_field));
    if (blind) {
        /* No field pages at all. Showing the leaves that happened to fit would
         * read as the whole document, and the one thing this page has to
         * communicate is that it is not. */
        sign_page_kind[n++] = SIGN_PAGE_TYPED_BLIND;
        sign_page_kind[n++] = SIGN_PAGE_TYPED_DOMAIN;
        sign_page_kind[n++] = SIGN_PAGE_BLIND_DATA;
    } else {
        /* Domain first: a Permit's fields are meaningless until you know which
         * contract on which chain will honour them, and that is the field a
         * lookalike token gets wrong. */
        sign_page_kind[n++] = SIGN_PAGE_TYPED_DOMAIN;
        for (int i = 0; i < sign_typed.field_count &&
                        n < SIGN_MAX_PAGES - 1; i++) {
            sign_page_field[n] = i;
            sign_page_kind[n++] = SIGN_PAGE_TYPED_FIELD;
        }
    }
    sign_page_kind[n++] = SIGN_PAGE_FROM;
    sign_page_count = n;

    sign_outcome = SIGN_PENDING;
    sign_request_pending = true;
}

void ui_request_sign(const EthTx *tx, const HDPath *path, const char *from)
{
    sign_is_message = false;
    sign_is_typed = false;
    memzero(sign_message, sizeof(sign_message));
    memzero(&sign_typed, sizeof(sign_typed));
    memcpy(&sign_tx, tx, sizeof(sign_tx));
    sign_path_shown = path ? *path : (HDPath)HDPATH_ETH_DEFAULT;

    /* The source address is derived by the protocol task before it asks, and
     * carried in rather than looked up here. Deriving on the UI task would put
     * this screen in the same race that once signed with a key it never named
     * (T47) - and a screen that names the wrong address is worse than one that
     * names none. */
    if (from) {
        snprintf(sign_from, sizeof(sign_from), "%s", from);
    } else {
        sign_from[0] = '\0';
    }

    eth_decode_call(sign_tx.data, sign_tx.data_length, &sign_call);

    sign_blind = (sign_call.kind == ETH_CALL_UNKNOWN);
    memzero(sign_data_hash, sizeof(sign_data_hash));
    if (sign_blind) {
        /* The one thing the device can honestly say about bytes it cannot
         * read: which bytes they were. Hashed here, from the same buffer the
         * signature is taken over, so a user who wants to check the call
         * against a second source has something to compare. */
        keccak_256(sign_tx.data, sign_tx.data_length, sign_data_hash);
    }

    int n = 0;
    switch (sign_call.kind) {
        case ETH_CALL_ERC20_TRANSFER:
        case ETH_CALL_ERC20_APPROVE:
        case ETH_CALL_MINT_TO:
            sign_page_kind[n++] = SIGN_PAGE_ACTION;
            sign_page_kind[n++] = SIGN_PAGE_PARTY;
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_MINT_TOKEN_TO:
            /* Two addresses again, but the first is the TOKEN and the second
             * the recipient - not a payer and a payee. Same pages, different
             * labels; see sign_party_label(). */
        case ETH_CALL_ERC20_TRANSFER_FROM:
            /* Two parties, and which is which matters more here than
             * anywhere: this call moves someone else's tokens. */
            sign_page_kind[n++] = SIGN_PAGE_ACTION;
            sign_page_kind[n++] = SIGN_PAGE_PARTY;
            sign_page_kind[n++] = SIGN_PAGE_PARTY2;
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_SET_APPROVAL_ALL:
            sign_page_kind[n++] = SIGN_PAGE_ACTION;
            sign_page_kind[n++] = SIGN_PAGE_PARTY;
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_WETH_DEPOSIT:
            /* The amount wrapped is the transaction's own value, so the ether
             * page is the amount page here. */
            sign_page_kind[n++] = SIGN_PAGE_ACTION;
            sign_page_kind[n++] = SIGN_PAGE_VALUE;
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_WETH_WITHDRAW:
        case ETH_CALL_MINT:
            sign_page_kind[n++] = SIGN_PAGE_ACTION;
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_GENERIC:
            /* Name first, then every declared argument in the order the
             * contract will read them, then the contract itself. One argument
             * per page and none skipped: a page that quietly dropped the
             * fourth of five would be a screen the signature does not match. */
            sign_page_kind[n++] = SIGN_PAGE_CALL_NAME;
            for (int a = 0; a < sign_call.arg_count && n < SIGN_MAX_PAGES - 2; a++) {
                sign_page_field[n] = a;
                sign_page_kind[n++] = SIGN_PAGE_CALL_ARG;
            }
            sign_page_kind[n++] = SIGN_PAGE_CONTRACT;
            break;
        case ETH_CALL_UNKNOWN:
            /* Only reachable with blind signing on (T16); the protocol task
             * refuses it otherwise. The warning comes first so the page the
             * user lands on is the one that says the device cannot read this,
             * and the rest is everything it does know. */
            sign_page_kind[n++] = SIGN_PAGE_BLIND_WARN;
            sign_page_kind[n++] = SIGN_PAGE_VALUE;
            sign_page_kind[n++] = SIGN_PAGE_TO;
            sign_page_kind[n++] = SIGN_PAGE_BLIND_DATA;
            break;
        default:
            /* ETH_CALL_EMPTY: a plain transfer, and the two facts that
             * describe it entirely. */
            sign_page_kind[n++] = SIGN_PAGE_VALUE;
            sign_page_kind[n++] = SIGN_PAGE_TO;
            break;
    }
    sign_page_kind[n++] = SIGN_PAGE_FROM;
    sign_page_count = n;

    sign_outcome = SIGN_PENDING;
    sign_request_pending = true;
}

SignOutcome ui_sign_outcome(void)
{
    return sign_outcome;
}

/* What to say, and until when. Reported by the protocol task; the UI task
 * dismisses it so a user who walks away is not left on a stale screen. */
static volatile bool  sign_result_ok = false;
static volatile bool  sign_result_ready = false;
static int64_t        sign_result_until_us = 0;

/* Raised when the approval window closed with nobody answering. Separate from
 * sign_result_ok because "you said no" and "you said nothing" are different
 * things to tell a user, and only one of them means the host is still waiting
 * for an answer it will never get. */
static volatile bool  sign_result_expired = false;
static volatile bool  sign_expired_pending = false;

#define SIGN_RESULT_HOLD_US 2000000   /* long enough to read, short enough not to nag */

void ui_sign_report(bool ok)
{
    sign_result_ok = ok;
    sign_result_expired = false;
    sign_result_ready = true;
    sign_result_until_us = esp_timer_get_time() + SIGN_RESULT_HOLD_US;

    /* Without this the acknowledgement never appears.
     *
     * The UI task only repaints inside `if (ui_needs_render())`, and every
     * other thing that changes the screen is either a button press or a screen
     * transition, both of which set the flag. This is neither: it is called
     * from the protocol task the moment wallet_sign_hash_at_path() returns,
     * and on the path that matters - approve, sign, done - there is no press
     * afterwards. So the "Signing..." frame drawn on entry stayed the last
     * frame drawn, the two-second auto-dismiss then moved on, and the device
     * dropped back to the address list without ever saying it had signed.
     * Reported on hardware against a WalletConnect transaction. The simple
     * send flow looked correct only because unrelated activity happened to
     * mark the screen dirty in time.
     *
     * Safe from another task for the same reason ui_request_sign() is: this
     * sets a flag and nothing else. Screen transitions stay the UI task's, and
     * a render that races this call paints either the old frame or the new one
     * - both are frames the device is entitled to draw, and the loop repaints
     * within 100 ms regardless. */
    ui_invalidate();
}

/**
 * The approval window closed with nobody answering. Take the question down.
 *
 * wait_for_user() has a 120 s deadline, after which it answers the host and
 * calls ui_sign_clear() -- which zeroes the request but leaves the screen
 * exactly where it was. The device then sat on a confirmation screen rendering
 * a *wiped* request and still accepting buttons: pressing SIGN advanced to the
 * result screen and said the transaction had been approved, when nothing was
 * signed and the host had been told no seconds earlier.
 *
 * Found on hardware while reproducing H-1, and it is the one thing this device
 * must never do -- claim an approval happened. Nothing was exploitable, because
 * the outcome is no longer read by then; the harm is entirely that the screen
 * lied about what the device had done.
 *
 * Sets a flag rather than moving the screen, for the same reason
 * ui_sign_report() does: screen transitions belong to the UI task, and this
 * runs on the protocol task.
 */
void ui_sign_expire(void)
{
    sign_result_ok = false;
    sign_result_expired = true;
    sign_result_ready = true;
    sign_result_until_us = esp_timer_get_time() + SIGN_RESULT_HOLD_US;
    sign_expired_pending = true;
    ui_invalidate();
}

static void screen_sign_result_enter(void)
{
    ESP_LOGI(TAG, "Sign result screen");
}

static void screen_sign_result_render(void)
{
    oled_clear();

    if (!sign_result_ready) {
        /* Approved, and the signature is being computed - about 30 ms, but
         * saying so beats a frozen-looking screen if it ever is not. */
        oled_draw_string_centered(2, "Approved");
        oled_draw_string_centered(4, "Signing...");
        return;
    }

    if (sign_result_expired) {
        oled_draw_string_centered(2, "Expired");
        /* Says why, because the user's next question is what they did wrong,
         * and the answer is that they took longer than the device waits. */
        oled_draw_string_centered(4, "No answer in time");
        oled_draw_string_centered(6, "Nothing was sent");
        oled_draw_string(7, 0, "any key");
        return;
    }

    if (sign_result_ok) {
        oled_draw_string_centered(2, "Signed");
        /* Deliberately not "Sent". Broadcasting happens on the host and the
         * device has no way to know whether it worked. */
        oled_draw_string_centered(4, "Handed to host");
    } else {
        oled_draw_string_centered(2, "NOT signed");
        oled_draw_string_centered(4, "Nothing was sent");
    }
    oled_draw_string(7, 0, "any key");
}

static void screen_sign_result_on_button(button_id_t btn)
{
    (void)btn;
    ui_set_screen(SCREEN_WALLET_INFO);
}

void ui_sign_clear(void)
{
    sign_outcome = SIGN_PENDING;
    memzero(&sign_tx, sizeof(sign_tx));
    memzero(&sign_call, sizeof(sign_call));
    memzero(sign_from, sizeof(sign_from));
    memzero(sign_message, sizeof(sign_message));
    memzero(&sign_typed, sizeof(sign_typed));
    sign_is_message = false;
    sign_is_typed = false;
    sign_blind = false;
    memzero(sign_data_hash, sizeof(sign_data_hash));
}

static bool sign_all_seen(void)
{
    for (int i = 0; i < sign_page_count; i++) {
        if (!sign_seen[i]) return false;
    }
    return true;
}

static void screen_sign_confirm_enter(void)
{
    ESP_LOGI(TAG, "Sign confirmation screen (%s)", eth_call_name(sign_call.kind));
    sign_page = 0;
    memset(sign_seen, 0, sizeof(sign_seen));
    sign_seen[0] = true;
}

/* An address across three rows, never truncated: the user compares it against
 * what they intended, and a shortened address compares equal to one that is
 * not the same. */
/**
 * A count of seconds since 1970, as a calendar date.
 *
 * No clock is involved, and that is the point. This device has no RTC, which
 * was once taken to mean it could not show a date at all -- but a date is a
 * function of the number alone. Only "how far away is that" needs to know the
 * present, and that is not the question a deadline poses. The question is
 * whether the permission being signed ends this afternoon or in 2033, and
 * "2033-05-18" answers it where "2000000000" does not: both deadlines are ten
 * digits, and on a small screen they read the same.
 *
 * Hinnant's civil_from_days, exact for every day this can express and needing
 * no table. Returns false rather than a wrong date when the text is not a
 * plain decimal or the year would not fit four digits, so the caller can show
 * the raw seconds instead of inventing something.
 */
bool unix_to_civil_date(const char *secs, int *year, int *month, int *day)
{
    if (!secs || !*secs) {
        return false;
    }
    uint64_t t = 0;
    for (const char *p = secs; *p; p++) {
        if (*p < '0' || *p > '9') {
            return false;
        }
        if (t > (UINT64_MAX - (uint64_t)(*p - '0')) / 10) {
            return false;               /* longer than any real timestamp */
        }
        t = t * 10 + (uint64_t)(*p - '0');
    }
    if (t > 253402300799ULL) {          /* past 9999-12-31 */
        return false;
    }

    int64_t  z   = (int64_t)(t / 86400) + 719468;
    int64_t  era = (z >= 0 ? z : z - 146096) / 146097;
    uint32_t doe = (uint32_t)(z - era * 146097);
    uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t  yr  = (int64_t)yoe + era * 400;
    uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    uint32_t mp  = (5 * doy + 2) / 153;
    uint32_t dd  = doy - (153 * mp + 2) / 5 + 1;
    uint32_t mm  = mp + (mp < 10 ? 3 : (uint32_t)-9);

    *year  = (int)(yr + (mm <= 2));
    *month = (int)mm;
    *day   = (int)dd;
    return true;
}

static void sign_draw_address(int row, const char *hex42)
{
    char part[17];

    /* Anything that is not a full address is a derivation that failed. Say so
     * rather than slicing a short string into three misleading rows. */
    if (!hex42 || strlen(hex42) < 42) {
        oled_draw_string(row, 0, "(unavailable)");
        return;
    }

    snprintf(part, sizeof(part), "%.16s", hex42);
    oled_draw_string(row, 0, part);
    snprintf(part, sizeof(part), "%.14s", hex42 + 16);
    oled_draw_string(row + 1, 0, part);
    snprintf(part, sizeof(part), "%.12s", hex42 + 30);
    oled_draw_string(row + 2, 0, part);
}

/* A token amount, wrapped over two rows and labelled for what it is.
 *
 * "raw units" is not a hedge, it is the truth: decimals() lives on the
 * contract and the device cannot call it, so scaling the number would mean
 * inventing the scale. Long values wrap rather than truncate, because a
 * shortened amount is a different amount. */
static void sign_draw_amount(int row)
{
    char amount[80];
    if (!eth_format_integer(&sign_call.amount, amount, sizeof(amount))) {
        snprintf(amount, sizeof(amount), "?");
    }
    size_t alen = strlen(amount);
    for (int i = 0; i < 2 && (size_t)(i * 21) < alen; i++) {
        char part[22];
        snprintf(part, sizeof(part), "%.21s", amount + i * 21);
        oled_draw_string(row + i, 0, part);
    }
    oled_draw_string(row + 2, 0, "raw units");
}

static void screen_sign_confirm_render(void)
{
    oled_clear();

    char line[24];
    /* The header is the one row on every page, so it is where "this is not a
     * normal confirmation" belongs. A blind request has to be distinguishable
     * at a glance from one the device understood. */
    const char *title = sign_blind ? "!BLIND SIGN!"
                      : sign_is_typed ? "Sign data?"
                      : (sign_is_message ? "Sign msg?" : "Sign?");
    snprintf(line, sizeof(line), "%s  %u/%u", title,
             (unsigned)(sign_page + 1), (unsigned)sign_page_count);
    oled_draw_string_centered(0, line);

    char scratch[32];

    switch (sign_page_kind[sign_page]) {
        case SIGN_PAGE_MESSAGE: {
            /* The whole message, wrapped over the six free rows, never cut.
             * Anything that would not fit, or that is not printable ASCII, was
             * refused before this screen was ever reached (eth_message_is_
             * displayable) — so what is on screen is the entire preimage. */
            size_t mlen = strlen(sign_message);
            for (int row = 0; row < 6; row++) {
                size_t off = (size_t)row * 20;
                if (off >= mlen) break;
                char part[21];
                snprintf(part, sizeof(part), "%.20s", sign_message + off);
                oled_draw_string(1 + row, 0, part);
            }
            if (mlen == 0) {
                oled_draw_string(2, 0, "(empty message)");
            }
            break;
        }
        case SIGN_PAGE_VALUE: {
            /* Amount and chain. The two fields that decide what it costs. */
            char value[40];
            if (!eth_format_value(&sign_tx.value, value, sizeof(value), 8)) {
                snprintf(value, sizeof(value), "?");
            }
            oled_draw_string(2, 0, "Send");

            /* Compose explicitly. A truncating snprintf here would silently
             * shorten an amount, and a shortened amount is a different
             * amount. Eighteen characters fit the line; anything longer is
             * marked rather than cut. */
            char amount[24];
            size_t vlen = strlen(value);
            if (vlen <= 18) {
                snprintf(amount, sizeof(amount), "%.18s ETH", value);
            } else {
                snprintf(amount, sizeof(amount), "%.15s.. ETH", value);
            }
            oled_draw_string(3, 0, amount);
            oled_draw_string(5, 0, "On");
            oled_draw_string(6, 0,
                eth_chain_name(sign_tx.chain_id, scratch, sizeof(scratch)));
            break;
        }
        case SIGN_PAGE_TO: {
            char addr[43];
            if (sign_tx.has_to && eth_format_address(sign_tx.to, addr, sizeof(addr))) {
                oled_draw_string(2, 0, "To");
                sign_draw_address(3, addr);
            } else {
                /* Refused upstream (T50); shown plainly if it ever gets here. */
                oled_draw_string(2, 0, "Contract creation");
                oled_draw_string(4, 0, "No recipient!");
            }
            break;
        }
        case SIGN_PAGE_ACTION: {
            /* What the call actually does, in words.
             *
             * Amounts are raw token units: the device cannot call decimals()
             * on the contract, and printing "12.5" from a scale it guessed
             * would be a confident lie about the thing being signed. */
            switch (sign_call.kind) {
                case ETH_CALL_ERC20_APPROVE:
                    oled_draw_string(2, 0, "Approve spending");
                    if (sign_call.unlimited) {
                        /* The pattern behind most drain incidents: an
                         * allowance the user never revisits and an attacker
                         * can empty at leisure. */
                        oled_draw_string(4, 0, "UNLIMITED amount");
                        oled_draw_string(5, 0, "Spender can take");
                        oled_draw_string(6, 0, "all of this token");
                    } else {
                        sign_draw_amount(4);
                    }
                    break;

                case ETH_CALL_SET_APPROVAL_ALL:
                    /* Not an amount at all, which is exactly why it gets its
                     * own words. This is broader than an unlimited ERC-20
                     * allowance: it hands over every token in the collection,
                     * including ones bought after the approval was given. */
                    if (sign_call.flag) {
                        oled_draw_string(1, 0, "APPROVE ALL");
                        oled_draw_string(2, 0, "tokens in this");
                        oled_draw_string(3, 0, "collection");
                        oled_draw_string(5, 0, "Operator may move");
                        oled_draw_string(6, 0, "every one, anytime");
                    } else {
                        oled_draw_string(1, 0, "Revoke approval");
                        oled_draw_string(2, 0, "for all tokens");
                        oled_draw_string(5, 0, "Operator loses");
                        oled_draw_string(6, 0, "access");
                    }
                    break;

                case ETH_CALL_ERC20_TRANSFER_FROM:
                    /* Spends an allowance rather than the signer's balance,
                     * so the holder and the destination are different
                     * addresses and both get a page of their own. */
                    oled_draw_string(2, 0, "Move tokens");
                    oled_draw_string(3, 0, "between accounts");
                    sign_draw_amount(4);
                    break;

                case ETH_CALL_WETH_DEPOSIT:
                    /* No arguments: the amount wrapped is the ether attached
                     * to the transaction, which the next page shows. */
                    oled_draw_string(2, 0, "Wrap ETH");
                    oled_draw_string(4, 0, "Sends the ether");
                    oled_draw_string(5, 0, "below to this");
                    oled_draw_string(6, 0, "contract");
                    break;

                case ETH_CALL_WETH_WITHDRAW:
                    oled_draw_string(2, 0, "Unwrap tokens");
                    sign_draw_amount(4);
                    break;

                case ETH_CALL_MINT_TO:
                    oled_draw_string(2, 0, "Mint tokens");
                    oled_draw_string(3, 0, "to address below");
                    sign_draw_amount(4);
                    break;

                case ETH_CALL_MINT_TOKEN_TO:
                    oled_draw_string(2, 0, "Mint a token");
                    oled_draw_string(3, 0, "to address below");
                    sign_draw_amount(4);
                    break;

                case ETH_CALL_MINT:
                    oled_draw_string(2, 0, "Mint tokens");
                    oled_draw_string(3, 0, "to this account");
                    sign_draw_amount(4);
                    break;

                default:
                    oled_draw_string(2, 0, "Send tokens");
                    sign_draw_amount(4);
                    break;
            }
            break;
        }
        case SIGN_PAGE_PARTY: {
            /* One page, several meanings, so the label is never generic: an
             * address under "To" and the same address under "Spender" are
             * different things to agree to. */
            char addr[43];
            const char *label;
            switch (sign_call.kind) {
                case ETH_CALL_ERC20_APPROVE:       label = "Spender";      break;
                case ETH_CALL_SET_APPROVAL_ALL:    label = "Operator";     break;
                case ETH_CALL_ERC20_TRANSFER_FROM: label = "Taken from";   break;
                case ETH_CALL_MINT_TO:             label = "Minted to";    break;
                case ETH_CALL_MINT_TOKEN_TO:       label = "Token";        break;
                default:                           label = "To";           break;
            }
            oled_draw_string(2, 0, label);
            if (eth_format_address(sign_call.address, addr, sizeof(addr))) {
                sign_draw_address(3, addr);
            }
            break;
        }
        case SIGN_PAGE_PARTY2: {
            char addr[43];
            /* "Sent to" is right for transferFrom, where the two addresses are
             * a payer and a payee. For mint(token,to,amount) the first word is
             * the token and this one is the recipient, so naming both "Sent
             * to" would describe the wrong argument. */
            oled_draw_string(2, 0,
                sign_call.kind == ETH_CALL_MINT_TOKEN_TO ? "Minted to" : "Sent to");
            if (sign_call.has_second &&
                eth_format_address(sign_call.second, addr, sizeof(addr))) {
                sign_draw_address(3, addr);
            } else {
                oled_draw_string(4, 0, "(unavailable)");
            }
            break;
        }
        case SIGN_PAGE_BLIND_WARN: {
            /* The whole point of the hatch being opt-in is that this page
             * exists and is unmissable. It claims nothing about the call. */
            oled_draw_string(1, 0, "UNKNOWN CALL");
            oled_draw_string(2, 0, "Device cannot read");
            oled_draw_string(3, 0, "this contract call");
            oled_draw_string(4, 0, "or say what it");
            oled_draw_string(5, 0, "does. You trust");
            oled_draw_string(6, 0, "the app, not this.");
            break;
        }
        case SIGN_PAGE_TYPED_DOMAIN: {
            /* Which contract, on which chain, calling itself what.
             *
             * The domain is the half of an EIP-712 signature that decides where
             * it is valid, and it is where a lookalike hides: a Permit whose
             * fields all read correctly against a verifyingContract that is not
             * the token you think it is drains the token that it is. The name
             * is shown last and lowest on purpose - it is the one field of the
             * three the contract does not have to prove. */
            snprintf(line, sizeof(line), "%.20s", sign_typed.primary_type);
            oled_draw_string(1, 0, line);
            if (sign_typed.has_verifying_contract) {
                char addr[43];
                oled_draw_string(2, 0, "Contract");
                if (eth_format_address(sign_typed.verifying_contract, addr, sizeof(addr))) {
                    sign_draw_address(3, addr);
                }
            } else {
                /* Legal, and worth saying out loud: a domain with no contract
                 * binds the signature to nothing on chain. */
                oled_draw_string(2, 0, "No contract named");
            }
            if (sign_typed.has_chain_id) {
                oled_draw_string(6, 0,
                    eth_chain_name(sign_typed.chain_id, scratch, sizeof(scratch)));
            } else {
                oled_draw_string(6, 0, "Any chain!");
            }
            break;
        }
        case SIGN_PAGE_TYPED_FIELD: {
            const Eip712Field *f = &sign_typed.fields[sign_page_field[sign_page]];

            snprintf(line, sizeof(line), "%.20s", f->label);
            oled_draw_string(1, 0, line);
            if (f->is_deadline) {
                /* As a date, not as seconds since 1970.
                 *
                 * This row used to say "valid until (unix)" and leave the
                 * number, on the reasoning that a device with no clock cannot
                 * produce a date. The reasoning was wrong: turning a count of
                 * seconds into a calendar date is arithmetic and needs no
                 * clock. What needs a clock is saying how far away it is, and
                 * that is not what makes a deadline suspicious.
                 *
                 * What makes it suspicious is being years out, and 2000000000
                 * against 1787950000 is not a difference a person reads off a
                 * small screen -- both are ten digits starting with 1 or 2.
                 * "2033-05-18" against "2026-08-28" is. A far-future deadline
                 * is the signature of a drainer holding a permit until it
                 * suits them (docs/ANTI-SCAM.md), so it has to be the part
                 * that is legible. */
                int y = 0, mo = 0, d = 0;
                if (unix_to_civil_date(f->value, &y, &mo, &d)) {
                    char when[24];
                    snprintf(when, sizeof(when), "%04d-%02d-%02d", y, mo, d);
                    oled_draw_string(2, 0, "valid until");
                    oled_draw_string(3, 0, when);
                    /* The seconds stay too, one row down and quieter. The date
                     * is what a person can judge; the number is what is
                     * actually being signed, and it is the only form that can
                     * be checked against what the dapp claims to have sent. A
                     * rendering that replaced it would be asking to be trusted
                     * about the very field it exists to expose. */
                    snprintf(line, sizeof(line), "%.21s", f->value);
                    oled_draw_string(5, 0, line);
                    break;
                }
                /* Unparseable: fall through and show the raw seconds rather
                 * than invent a date. */
                oled_draw_string(2, 0, "valid until (unix)");
            }

            if (f->is_address) {
                sign_draw_address(3, f->value);
            } else if (f->unlimited) {
                /* The same words the ERC-20 approve screen uses, because it is
                 * the same thing being agreed to and a user should not have to
                 * learn two vocabularies for one risk. A Permit is worse than
                 * an approve only in that it costs nothing and leaves no trace
                 * on chain. */
                oled_draw_string(3, 0, "UNLIMITED amount");
                oled_draw_string(4, 0, "Spender can take");
                oled_draw_string(5, 0, "all of this token");
            } else {
                /* Wrapped over four rows, never cut. A shortened value is a
                 * different value, and a uint256 in decimal needs the room. */
                size_t vlen = strlen(f->value);
                for (int row = 0; row < 4; row++) {
                    size_t off = (size_t)row * 21;
                    if (off >= vlen) break;
                    char part[22];
                    snprintf(part, sizeof(part), "%.21s", f->value + off);
                    oled_draw_string(3 + row, 0, part);
                }
            }
            break;
        }
        case SIGN_PAGE_TYPED_BLIND: {
            oled_draw_string(1, 0, "UNREADABLE DATA");
            oled_draw_string(2, 0, "Device hashed this");
            oled_draw_string(3, 0, "but cannot show");
            oled_draw_string(4, 0, "all of it. You");
            oled_draw_string(5, 0, "trust the app,");
            oled_draw_string(6, 0, "not this screen.");
            break;
        }
        case SIGN_PAGE_BLIND_DATA: {
            /* Which bytes, since not what they mean. The length says how much
             * is hidden and the digest lets it be checked against a second
             * source - the only two honest facts available about calldata the
             * device cannot parse. Typed data has no calldata to measure, so it
             * names the digest for what it is instead. */
            if (sign_is_typed) {
                snprintf(line, sizeof(line), "Typed data");
            } else {
                snprintf(line, sizeof(line), "Calldata %u bytes",
                         (unsigned)sign_tx.data_length);
            }
            oled_draw_string(1, 0, line);
            oled_draw_string(2, 0, "keccak256:");

            /* All 64 hex characters, four rows of sixteen. A prefix would be
             * cheaper to read and trivially forgeable, which is the reason a
             * truncated hash is not shown anywhere on this device. */
            for (int row = 0; row < 4; row++) {
                char part[17];
                for (int i = 0; i < 8; i++) {
                    static const char hex[] = "0123456789abcdef";
                    uint8_t b = sign_data_hash[row * 8 + i];
                    part[i * 2]     = hex[b >> 4];
                    part[i * 2 + 1] = hex[b & 0x0F];
                }
                part[16] = '\0';
                oled_draw_string(3 + row, 0, part);
            }
            break;
        }
        case SIGN_PAGE_CALL_NAME: {
            /* The function name, taken from the same string whose keccak
             * matched the selector being signed — so the name and the four
             * bytes cannot disagree.
             *
             * The three rows under it are not hedging, they are the honest
             * limit of what this page can claim. Hashing a signature proves
             * what the function is CALLED and what its arguments ARE. It
             * proves nothing about what the code does: any contract may name a
             * drain `supply`, and nothing on chain forbids it. So the wording
             * stays descriptive ("Contract calls this") rather than reassuring
             * ("Supplying to Aave"), and the contract address keeps a page of
             * its own — the address is the only thing here that identifies who
             * will run the code. */
            char name[21];
            eth_call_function_name(&sign_call, name, sizeof(name));
            oled_draw_string(1, 0, "Call");
            oled_draw_string(2, 0, name[0] ? name : "(unnamed)");
            oled_draw_string(4, 0, "Name and args are");
            oled_draw_string(5, 0, "read from the ABI.");
            oled_draw_string(6, 0, "Not what it does!");
            break;
        }
        case SIGN_PAGE_CALL_ARG: {
            /* One declared argument: its name, its value, nothing inferred.
             *
             * Values are rendered by the same rules as everywhere else on this
             * device - an address across three rows and never truncated, an
             * integer in raw units because decimals() is not callable from
             * here, and an allowance past its own type's halfway mark named
             * UNLIMITED in the words the ERC-20 approve screen uses. A user
             * should not have to learn a second vocabulary for the same risk
             * just because the call arrived through a different decoder. */
            int a = sign_page_field[sign_page];
            char label[21];
            eth_call_arg_name(&sign_call, a, label, sizeof(label));
            oled_draw_string(1, 0, label[0] ? label : "argument");

            uint8_t addr_bytes[20];
            EthQuantity q;
            char addr[43];
            if (eth_arg_address(&sign_call, sign_tx.data, sign_tx.data_length,
                                a, addr_bytes)) {
                if (eth_format_address(addr_bytes, addr, sizeof(addr))) {
                    sign_draw_address(3, addr);
                }
            } else if (eth_arg_unlimited(&sign_call, sign_tx.data,
                                         sign_tx.data_length, a)) {
                oled_draw_string(3, 0, "UNLIMITED amount");
                oled_draw_string(4, 0, "Spender can take");
                oled_draw_string(5, 0, "all of this token");
            } else if (eth_arg_quantity(&sign_call, sign_tx.data,
                                        sign_tx.data_length, a, &q)) {
                char amount[80];
                if (!eth_format_integer(&q, amount, sizeof(amount))) {
                    snprintf(amount, sizeof(amount), "?");
                }
                /* The unit note goes ABOVE the number, because the number owns
                 * the four rows below it: a uint256 in decimal is 78 digits,
                 * and row 7 is the button bar. Wrapped, never cut - a
                 * shortened number is a different number. */
                oled_draw_string(2, 0, "raw units");
                size_t alen = strlen(amount);
                for (int row = 0; row < 4; row++) {
                    size_t off = (size_t)row * 21;
                    if (off >= alen) break;
                    char part[22];
                    snprintf(part, sizeof(part), "%.21s", amount + off);
                    oled_draw_string(3 + row, 0, part);
                }
            } else {
                const uint8_t *word = eth_arg_word(&sign_call, sign_tx.data,
                                                   sign_tx.data_length, a);
                /* All that is left is a bool. Printed flat, with no adjective:
                 * what a true means here belongs to the contract, and
                 * setApprovalForAll - the one bool whose meaning IS known - has
                 * its own loud screen rather than this one. */
                oled_draw_string(3, 0, (word && word[31]) ? "true" : "false");
            }
            break;
        }
        case SIGN_PAGE_CONTRACT: {
            /* Which token. An amount and a spender mean nothing without it:
             * the same approval against a different contract is a different
             * thing to lose. */
            char addr[43];
            oled_draw_string(1, 0,
                sign_call.kind == ETH_CALL_GENERIC ? "Contract" : "Token contract");
            if (eth_format_address(sign_tx.to, addr, sizeof(addr))) {
                sign_draw_address(2, addr);
            }
            oled_draw_string(6, 0,
                eth_chain_name(sign_tx.chain_id, scratch, sizeof(scratch)));
            break;
        }
        default: {
            /* The address that will sign, in full.
             *
             * The index alone was true of what the device was asked and blind
             * to what it did - a task race had it signing with a key this
             * screen never named (T47). The address is derived from the same
             * path the signature is taken at. */
            /* The whole path, not "addr N".
             *
             * T47 put the source address here because an index was not enough
             * to know what was signing. An account level makes that strictly
             * worse: m/44'/60'/0'/0/0 and m/44'/60'/9'/0/0 are both "addr 0"
             * and are different wallets, so a host moving accounts between
             * requests would be invisible. The path is what makes it visible,
             * and it is the same string the wallet screen shows. */
            oled_draw_string(1, 0, "From");
            sign_draw_address(2, sign_from);

            /* On a row of its own, so nothing can push it off the edge: a
             * truncated path would misname the wallet that is signing, which
             * is worse than the index this replaced. */
            format_hd_path(line, sizeof(line), &sign_path_shown);
            oled_draw_string(5, 0, line);

            if (sign_is_message) {
                /* No value, no chain: a personal_sign moves nothing by itself.
                 * Saying so stops the page reading as "+0 ETH transfer". */
                oled_draw_string(6, 0, "Message signature");
            } else if (sign_is_typed) {
                /* Same reasoning as a message, and more easily forgotten: a
                 * Permit moves nothing when it is signed, which is exactly what
                 * makes it comfortable to sign. */
                oled_draw_string(6, 0, "Typed data sig");
            } else if (sign_call.kind == ETH_CALL_EMPTY) {
                oled_draw_string(6, 0, "Plain transfer");
            } else {
                char value[40];
                if (!eth_format_value(&sign_tx.value, value, sizeof(value), 8)) {
                    snprintf(value, sizeof(value), "?");
                }
                /* A token call that also moves ether is unusual and worth
                 * seeing; almost always this reads "+0 ETH". */
                char eth[24];
                snprintf(eth, sizeof(eth), "+%.15s ETH", value);
                oled_draw_string(6, 0, eth);
            }
            break;
        }
    }

    if (sign_all_seen()) {
        oled_draw_string(7, 0, "NO  <  >    SIGN");
    } else {
        oled_draw_string(7, 0, "NO  <  >  more");
    }
}

static void screen_sign_confirm_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            sign_page = (sign_page + sign_page_count - 1) % sign_page_count;
            sign_seen[sign_page] = true;
            break;
        case BUTTON_DOWN:
            sign_page = (sign_page + 1) % sign_page_count;
            sign_seen[sign_page] = true;
            break;

        case BUTTON_CANCEL:
            ESP_LOGW(TAG, "Transaction rejected by user");
            sign_outcome = SIGN_REJECTED;
            ui_set_screen(SCREEN_WALLET_INFO);
            return;

        case BUTTON_ACCEPT:
            /* Approving without having seen every page is not approval. */
            if (!sign_all_seen()) {
                break;
            }
            ESP_LOGW(TAG, "Transaction approved by user");
            sign_result_ready = false;
            sign_outcome = SIGN_APPROVED;
            ui_set_screen(SCREEN_SIGN_RESULT);
            return;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Host-supplied Passphrase Confirmation (PROTOCOL.md 5)
 *
 * The app can act as a keyboard for the passphrase, which is a real
 * convenience and a real downgrade: a compromised host sees the passphrase
 * before encryption ever touches it. What makes the trade survivable is this
 * screen. A wrong or substituted passphrase derives a different, perfectly
 * valid wallet rather than failing, so the address shown here is the only
 * signal that anything went wrong — and rejecting it must put the device back
 * where it was, not leave a wallet nobody chose selected.
 *
 * Separate from SCREEN_PASSPHRASE_CONFIRM (the on-device entry path) for two
 * reasons: it answers a waiting host through the sign-outcome channel, and it
 * has to say out loud that the passphrase came from the host. Sharing a screen
 * would mean the weaker path borrowing the stronger one's wording.
 * ============================================================================ */

static volatile bool host_passphrase_pending = false;
static char host_passphrase_address[43];

void ui_request_passphrase_confirm(const char *address)
{
    snprintf(host_passphrase_address, sizeof(host_passphrase_address), "%s",
             address ? address : "");
    sign_outcome = SIGN_PENDING;
    host_passphrase_pending = true;
}

/* M-2. Placed here rather than beside ui_request_session_confirm() only
 * because it reads two flags that are defined this far down the file. */
bool ui_user_is_answering(void)
{
    /* A request already handed to the UI task counts even before the screen
     * has changed: these flags are set by the protocol task and acted on a
     * tick later, and a `hello` landing in that gap would discard the pending
     * approval just as thoroughly as one landing a tick after it.
     *
     * SCREEN_SESSION_CONFIRM is deliberately absent. A second handshake while
     * the pairing screen is up already resets and repaints, so the user
     * compares the new digits rather than the old — that behaviour is tested
     * and it is the right one. Refusing here instead would strand a host that
     * abandoned a handshake behind a screen only a button press can clear. */
    if (sign_request_pending || host_passphrase_pending) {
        return true;
    }

    switch (ui_get_screen()) {
        case SCREEN_SIGN_CONFIRM:
        case SCREEN_HOST_PASSPHRASE_CONFIRM:
        case SCREEN_PASSPHRASE_CONFIRM:
        case SCREEN_WIPE_CONFIRM:
        /* Not questions, but a seed is on the glass and the user is working
         * through it. Wiping that away for a stranger's pairing prompt loses
         * their place in the one procedure that has no second chance. */
        case SCREEN_MNEMONIC_DISPLAY:
        case SCREEN_MNEMONIC_VERIFY:
            return true;
        default:
            return false;
    }
}

static void screen_host_passphrase_enter(void)
{
    ESP_LOGI(TAG, "Host passphrase confirmation screen");
    /* The passphrase was typed somewhere this device cannot see. The
     * fingerprint is what the user can compare against their own record. */
    refresh_master_xfp();
}

static void screen_host_passphrase_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "App passphrase");

    if (strlen(host_passphrase_address) < 42) {
        /* Nothing to recognise means nothing to confirm. */
        oled_draw_string_centered(3, "No address");
        oled_draw_string(7, 0, "NO");
        return;
    }

    sign_draw_address(2, host_passphrase_address);
    oled_draw_string(5, 0, "Typed on host!");
    if (master_xfp[0]) {
        draw_master_xfp(6, "Match XFP");
    } else {
        oled_draw_string(6, 0, "Match your record");
    }
    oled_draw_string(7, 0, "NO           YES");
}

static void screen_host_passphrase_on_button(button_id_t btn)
{
    if (btn == BUTTON_ACCEPT && strlen(host_passphrase_address) == 42) {
        sign_outcome = SIGN_APPROVED;
    } else if (btn == BUTTON_ACCEPT || btn == BUTTON_CANCEL) {
        /* The protocol task clears the passphrase on a rejection: the wrong
         * wallet must not stay selected just because the user said no. */
        sign_outcome = SIGN_REJECTED;
    } else {
        return;
    }
    memzero(host_passphrase_address, sizeof(host_passphrase_address));
    ui_set_screen(SCREEN_WALLET_INFO);
}

static const screen_t screen_host_passphrase = {
    .enter = screen_host_passphrase_enter,
    .render = screen_host_passphrase_render,
    .on_button = screen_host_passphrase_on_button,
    .exit = NULL,
};

/* ============================================================================
 * Temporary Seed Screen (T69)
 *
 * What SeedSigner does by construction, offered here as a session: the seed is
 * typed, held in RAM, and never written down by the device. Every at-rest
 * attack in docs/AUDIT-SECRETS.md - the flash dump, the PIN that falls to a GPU
 * in seconds, the logical erase that leaves ciphertext behind - is an attack on
 * a stored seed. This mode has nothing stored to attack.
 *
 * It buys that with two costs the user must read before they pay them, which
 * is why this screen exists between the menu and the keyboard:
 *
 *   The PIN protects nothing at rest. It still stops someone picking up an
 *   unlocked device, and that is genuinely all it does here - there is no
 *   ciphertext for it to guard, because there is no ciphertext.
 *
 *   A reboot, a crash or a flat battery loses the seed. The device cannot
 *   warn about that after the fact; the words are gone and only the user's own
 *   backup has them.
 *
 * Two pages rather than one dense screen: 128x64 fits about five readable rows,
 * and a warning nobody can read is decoration.
 * ============================================================================ */

#define TEMP_SEED_PAGES 2
static int temp_seed_page = 0;

static void screen_temp_seed_enter(void)
{
    ESP_LOGI(TAG, "Temporary seed warning");
    temp_seed_page = 0;
}

static void screen_temp_seed_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "-- Temp seed --");

    if (temp_seed_page == 0) {
        oled_draw_string(2, 0, "Seed is NOT saved.");
        oled_draw_string(3, 0, "Lock, reboot or");
        oled_draw_string(4, 0, "power loss erases");
        oled_draw_string(5, 0, "it. Keep a backup.");
        oled_draw_string(7, 0, "DN:more BCK  SEL");
    } else {
        oled_draw_string(2, 0, "PIN guards nothing");
        oled_draw_string(3, 0, "at rest: nothing");
        oled_draw_string(4, 0, "is stored to guard.");
        oled_draw_string(5, 0, "Auto-lock 30 min.");
        oled_draw_string(7, 0, "UP:back BCK  SEL");
    }
}

static void screen_temp_seed_on_button(button_id_t btn)
{
    switch (btn) {
        case BUTTON_UP:
            if (temp_seed_page > 0) {
                temp_seed_page--;
            }
            break;

        case BUTTON_DOWN:
            if (temp_seed_page < TEMP_SEED_PAGES - 1) {
                temp_seed_page++;
            }
            break;

        case BUTTON_CANCEL:
            ui_set_screen(SCREEN_MAIN_MENU);
            return;

        case BUTTON_ACCEPT:
            /* Accepting from either page. The second page is the harsher one,
             * but forcing a scroll to reach the button teaches scrolling, not
             * reading, and the first page already carries the loss the user
             * cannot undo. */
            entry_is_temporary = true;
            ui_set_screen(SCREEN_MNEMONIC_ENTRY);
            return;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Public API
 * ============================================================================ */

void ui_init(void)
{
    /* Register built-in screens */
    screens[SCREEN_BOOT] = &screen_boot;
    screens[SCREEN_PIN_SETUP] = &screen_pin_setup;
    screens[SCREEN_PIN_UNLOCK] = &screen_pin_unlock;
    screens[SCREEN_PIN_CHANGE] = &screen_pin_change;
    screens[SCREEN_MAIN_MENU] = &screen_main_menu;
    screens[SCREEN_WALLET_INFO] = &screen_wallet_info;
    screens[SCREEN_MNEMONIC_ENTRY] = &screen_mnemonic_entry;
    screens[SCREEN_WALLET_CREATE] = &screen_wallet_create;
    screens[SCREEN_WALLET_SELECT] = &screen_wallet_select;
    screens[SCREEN_MNEMONIC_DISPLAY] = &screen_mnemonic_display;
    screens[SCREEN_SETTINGS] = &screen_settings;
    screens[SCREEN_QR_CODE] = &screen_qr_code;
    screens[SCREEN_ENTROPY] = &screen_entropy;
    screens[SCREEN_WIPE_CONFIRM] = &screen_wipe_confirm;
    screens[SCREEN_BLIND_WARN] = &screen_blind_warn;
    screens[SCREEN_MNEMONIC_VERIFY] = &screen_mnemonic_verify;
    screens[SCREEN_SESSION_CONFIRM] = &screen_session_confirm;
    screens[SCREEN_LOCK_HOLD] = &screen_lock_hold;
    screens[SCREEN_LOCK_CONFIRM] = &screen_lock_confirm;
    screens[SCREEN_PASSPHRASE] = &screen_passphrase;
    screens[SCREEN_BLE_NAME] = &screen_ble_name;
    screens[SCREEN_TEMP_SEED] = &screen_temp_seed;
    screens[SCREEN_PASSPHRASE_CONFIRM] = &screen_passphrase_confirm;
    screens[SCREEN_SIGN_CONFIRM] = &screen_sign_confirm;
    screens[SCREEN_SIGN_RESULT] = &screen_sign_result;
    screens[SCREEN_HOST_PASSPHRASE_CONFIRM] = &screen_host_passphrase;

    current_screen = SCREEN_BOOT;
    needs_render = true;

    settings_load();
    oled_set_contrast(BRIGHTNESS_LEVELS[brightness_choice]);

    ESP_LOGI(TAG, "UI initialized (auto-lock %s, brightness %s)",
             lock_timeout_label(lock_timeout_choice),
             brightness_label(brightness_choice));
}

void ui_set_screen(screen_id_t screen)
{
    if (screen >= SCREEN_COUNT) {
        ESP_LOGE(TAG, "Invalid screen ID: %d", screen);
        return;
    }

    /* Exit current screen. This is where secrets held in static buffers get
     * zeroed - see the .exit hooks and AUDIT S5. */
    if (screens[current_screen] && screens[current_screen]->exit) {
        screens[current_screen]->exit(screen);
    }

    current_screen = screen;

    /* Enter new screen */
    if (screens[current_screen] && screens[current_screen]->enter) {
        screens[current_screen]->enter();
    }

    needs_render = true;
    ESP_LOGI(TAG, "Screen changed to %d", screen);
}

screen_id_t ui_get_screen(void)
{
    return current_screen;
}

void ui_handle_button(button_id_t btn)
{
    if (screens[current_screen] && screens[current_screen]->on_button) {
        screens[current_screen]->on_button(btn);
    }
}

void ui_render(void)
{
    if (screens[current_screen] && screens[current_screen]->render) {
        screens[current_screen]->render();
    }
    /* Screens draw into the buffer; the panel changes exactly once, here. */
    oled_flush();
    needs_render = false;
}

void ui_invalidate(void)
{
    needs_render = true;
}

void ui_poll_deferred(void)
{
    if (create_generate_pending && current_screen == SCREEN_WALLET_CREATE) {
        wallet_create_run_generation();
        return;
    }
    /* Left the screen before the work ran (CANCEL is still live while
     * "Generating..." is up, because the handler no longer blocks). The
     * request goes with the screen. */
    create_generate_pending = false;

    /* The passphrase changed under a screen that is already showing an address
     * derived from the old one (T42). Every way that can happen is another
     * task or a timer: a host setPassphrase, a host-rejected confirmation, an
     * auto-lock. Re-derive rather than merely repaint - the address itself is
     * wrong now, not just the marker beside it. */
    if (current_screen == SCREEN_WALLET_INFO &&
        wallet_has_passphrase() != wallet_info_passphrase_shown) {
        ESP_LOGW(TAG, "Passphrase changed under the wallet screen; re-deriving");
        wallet_info_refresh_address();
        ui_invalidate();
    }
}

bool ui_needs_render(void)
{
    return needs_render;
}

void ui_clear_invalidation(void)
{
    needs_render = false;
}

void ui_register_screen(screen_id_t id, const screen_t *screen)
{
    if (id < SCREEN_COUNT) {
        screens[id] = screen;
    }
}

/* The host asked the device to lock (PROTOCOL.md). Extracted from the task
 * loop so the tests exercise the same path the firmware does - the bug this
 * whole family came from was four call sites disagreeing, and a test driving
 * its own copy of one of them would have hidden it. */
static void service_host_lock(void)
{
    if (!host_lock_pending) {
        return;
    }
    host_lock_pending = false;
    lock_device();
    ui_set_screen(SCREEN_PIN_UNLOCK);
}

/* Take down a confirmation nobody answered. Guarded on the screen still being
 * the one that was raised: by the time this runs the user may have walked
 * somewhere else entirely, and yanking them out of it to report a question
 * they already abandoned is its own annoyance. */
static void service_sign_expiry(void)
{
    if (!sign_expired_pending) {
        return;
    }
    sign_expired_pending = false;

    screen_id_t here = ui_get_screen();
    if (here == SCREEN_SIGN_CONFIRM) {
        ui_set_screen(SCREEN_SIGN_RESULT);
    } else if (here == SCREEN_HOST_PASSPHRASE_CONFIRM) {
        /* Same expiry, different question. There is no result screen for a
         * passphrase, and the wallet is the honest place to land: whatever was
         * proposed has already been dropped by the protocol task. */
        ui_set_screen(SCREEN_WALLET_INFO);
    }
}

void ui_task(void *pvParameters)
{
    (void)pvParameters;
    QueueHandle_t queue = button_get_queue();
    button_event_t event;

    /* Initial render */
    ui_render();

    ESP_LOGI(TAG, "UI task started");

    lock_note_activity();

    while (1) {
        /* Wait for button event with timeout for periodic refresh */
        if (xQueueReceive(queue, &event, pdMS_TO_TICKS(100)) == pdTRUE) {
            lock_note_activity();
            ui_handle_button(event.id);
        } else if (lock_check_timeout()) {
            /* Just locked; fall through to render the unlock screen. */
        }

        /* A handshake arrived on the protocol task. Interrupt whatever is on
         * screen: the host is waiting, and the user needs to compare a code. */
        if (session_confirm_pending) {
            session_confirm_pending = false;
            /* Same class of omission as ui_sign_report(): a second handshake
             * while this screen is already up derives a NEW passkey, and
             * without a repaint the user would compare the app's code against
             * the previous handshake's digits and see a mismatch that is not
             * one. ui_set_screen() covers the other branch. */
            ui_invalidate();
            if (ui_get_screen() != SCREEN_SESSION_CONFIRM) {
                /* Return somewhere useful. Coming back to the boot splash
                 * after approving a connection reads as the device having
                 * reset, and leaves the user pressing keys to get anywhere. */
                screen_id_t here = ui_get_screen();
                session_confirm_return =
                    (here == SCREEN_BOOT)
                        ? (pin_is_unlocked() ? SCREEN_MAIN_MENU : SCREEN_PIN_UNLOCK)
                        : here;
                ui_set_screen(SCREEN_SESSION_CONFIRM);
            }
        }

        /* Dismiss the result once it has been up long enough. Doing it here
         * rather than blocking in the screen keeps buttons live throughout. */
        if (ui_get_screen() == SCREEN_SIGN_RESULT && sign_result_ready &&
            esp_timer_get_time() > sign_result_until_us) {
            ui_set_screen(SCREEN_WALLET_INFO);
        }

        service_lock_hold();

        /* A companion that died without saying so. Tears down the channel
         * only: the wallet stays unlocked and a temporary seed survives, so
         * this costs a re-handshake and never a retyped phrase. */
        if (session_check_idle()) {
            ESP_LOGI(TAG, "Session idle for %d s; channel closed",
                     SESSION_IDLE_TIMEOUT_S);
        }

        service_sign_expiry();

        if (sign_request_pending) {
            sign_request_pending = false;
            ui_set_screen(SCREEN_SIGN_CONFIRM);
        }

        if (host_passphrase_pending) {
            host_passphrase_pending = false;
            ui_set_screen(SCREEN_HOST_PASSPHRASE_CONFIRM);
        }

        if (host_unlock_pending) {
            host_unlock_pending = false;
            if (!pin_is_unlocked()) {
                pending_mnemonic_display = false;
                ui_set_screen(SCREEN_PIN_UNLOCK);
            }
        }

        service_host_lock();

        /* Re-render if needed */
        if (ui_needs_render()) {
            ui_render();
        }

        /* After the repaint, never before: the work deferred here is deferred
         * precisely so the frame announcing it is already on the panel
         * (AUDIT S8f). */
        ui_poll_deferred();
    }
}

/* ============================================================================
 * Test-only accessors (sim/test_ui.c)
 *
 * The interesting invariants here are about state that is deliberately private:
 * whether the seed buffer is zero after leaving the seed flow, and whether the
 * typed PIN survives a screen change. Both are unobservable from the outside,
 * which is why they went unnoticed in the first place. Same precedent as
 * pin__reset_static_state_for_test(): compiled out of the firmware entirely.
 * ============================================================================ */

#ifdef LEEK_HOST_TEST

const char *ui__mnemonic_buffer_for_test(void)     { return mnemonic_buffer; }
size_t      ui__mnemonic_buffer_size_for_test(void) { return sizeof(mnemonic_buffer); }
int         ui__mnemonic_word_count_for_test(void)  { return mnemonic_word_count; }

const char *ui__pin_entry_for_test(void)  { return pin_entry; }
int         ui__pin_cursor_for_test(void) { return pin_cursor; }
int         ui__pin_option_for_test(void) { return current_digit; }

/* The auto-lock decision, which otherwise only ui_task()'s loop can reach.
 *
 * Exposed rather than reimplemented in the test: "what the device drops when
 * it locks itself" is a T42 invariant, and a test asserting it against its own
 * copy of the rule would pass while the device kept a passphrase applied. */
bool ui__check_autolock_for_test(void) { return lock_check_timeout(); }
void ui__service_sign_expiry_for_test(void) { service_sign_expiry(); }
void ui__service_lock_hold_for_test(void) { service_lock_hold(); }
void ui__service_host_lock_for_test(void) { service_host_lock(); }

/* The cached fingerprint, which is not on any screen while the device is
 * locked and so cannot be asserted through the framebuffer - the stale-XFP
 * failure is that it is still HERE when the next screen goes to draw it. */
const char *ui__master_xfp_for_test(void) { return master_xfp; }

/* Which account the device is deriving at, and whether the wallet screen's
 * address was derived with a passphrase applied. Both are private on purpose;
 * both are the state a stale-passphrase or wrong-account bug lives in. */
uint32_t ui__account_for_test(void)            { return hd_account; }
bool ui__wallet_info_pass_shown_for_test(void) { return wallet_info_passphrase_shown; }

const MnemonicEntry *ui__entry_for_test(void)  { return &entry; }
bool ui__entry_is_temporary_for_test(void)     { return entry_is_temporary; }

/* The timeout in force and the one in NVS. Separate on purpose (T69), and a
 * test that could only see one of them could not tell a temporary session's
 * longer default from a stored wallet's timeout having been lengthened. */
int ui__lock_timeout_choice_for_test(void)        { return lock_timeout_choice; }
int ui__lock_timeout_stored_choice_for_test(void) { return lock_timeout_stored_choice; }
bool ui__entry_choosing_length_for_test(void)  { return entry_choosing_length; }
int  ui__entry_length_choice_for_test(void)    { return entry_length_choice; }

/* Back to power-on state. Covers everything the tests observe; screens with
 * purely cosmetic state (entropy meter, QR page) reinitialise in enter(). */
void ui__reset_static_state_for_test(void)
{
    current_screen = SCREEN_BOOT;
    needs_render = true;

    menu_selection = 0;
    menu_item_count = 0;
    settings_selection = 0;
    wallet_list_selection = 0;

    address_index = 0;
    hd_account = 0;
    wallet_info_passphrase_shown = false;
    memzero(&eth_address, sizeof(eth_address));
    memzero(mnemonic_buffer, sizeof(mnemonic_buffer));
    mnemonic_word_count = 0;
    mnemonic_page = 0;
    pending_mnemonic_display = false;

    entropy_mode     = ENTROPY_MODE_CHOOSE;
    entropy_menu_sel = 0;
    dice_face        = 1;
    dice_last        = 0;

    create_word_count = 12;
    create_show_mnemonic = false;
    create_generate_pending = false;
    memzero(create_error, sizeof(create_error));

    mnemonic_entry_clear(&entry);
    memzero(entry_error, sizeof(entry_error));
    entry_choosing_length = true;
    entry_length_choice = 12;
    entry_is_temporary = false;
    temp_seed_page = 0;
    /* Both selectors back to the default, together - a test that flipped the
     * setting must not leak it into the next one. */
    entry_blocks_apply(false);
    text_entry_reset(&passphrase_entry);

    memzero(pin_entry, sizeof(pin_entry));
    memzero(pin_first_entry, sizeof(pin_first_entry));
    pin_cursor = 0;
    current_digit = 0;
    pin_confirm_mode = false;
    pin_change_phase = PIN_CHANGE_CURRENT;
    memzero(pin_change_current, sizeof(pin_change_current));
    memzero(pin_change_message, sizeof(pin_change_message));

    verify_done = false;
    verify_current = 0;
    verify_failures = 0;
    verify_last_wrong = false;
    memset(verify_indices, 0, sizeof(verify_indices));

    session_confirm_pending = false;
    session_confirm_return = SCREEN_MAIN_MENU;
    host_unlock_pending = false;
    host_lock_pending = false;
    sign_request_pending = false;
    sign_outcome = SIGN_PENDING;
    sign_is_message = false;
    sign_blind = false;
    memzero(sign_data_hash, sizeof(sign_data_hash));
    blind_confirm_count = 0;
    blind_signing_forget();
    memzero(sign_message, sizeof(sign_message));
    host_passphrase_pending = false;
    memzero(host_passphrase_address, sizeof(host_passphrase_address));

    lock_timeout_choice = 1;
    lock_timeout_stored_choice = 1;
    brightness_choice = 2;
    memzero(master_xfp, sizeof(master_xfp));
    last_activity_us = 0;
}

#endif /* LEEK_HOST_TEST */
