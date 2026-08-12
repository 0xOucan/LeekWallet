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
#include "pin.h"
#include "leek-wallet.h"
#include "mnemonic-entry.h"
#include "bip39.h"
#include "memzero.h"
#include "entropy.h"
#include "esp_timer.h"

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

static void screen_qr_code_enter(void);
static void screen_qr_code_render(void);
static void screen_qr_code_on_button(button_id_t btn);

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
    .exit = NULL
};

static const screen_t screen_pin_unlock = {
    .enter = screen_pin_unlock_enter,
    .render = screen_pin_unlock_render,
    .on_button = screen_pin_unlock_on_button,
    .exit = NULL
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
    .exit = NULL
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
    .exit = NULL
};

static const screen_t screen_mnemonic_entry = {
    .enter = screen_mnemonic_entry_enter,
    .render = screen_mnemonic_entry_render,
    .on_button = screen_mnemonic_entry_on_button,
    .exit = NULL
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

/* Render the selector into `out`, e.g. "< 7 >" or "< OK >". */
static void pin_option_label(char *out, size_t max)
{
    if (current_digit == PIN_OPTION_SUBMIT) {
        snprintf(out, max, "< OK >");
    } else {
        snprintf(out, max, "< %d >", current_digit);
    }
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

#define MENU_ITEMS 5
static const char *menu_items[MENU_ITEMS] = {
    "View Address",
    "Select Wallet",
    "New Wallet",
    "Import Wallet",
    "Settings"
};
static int menu_selection = 0;

/* ============================================================================
 * Wallet State
 * ============================================================================ */

static EthAddress eth_address;
static char mnemonic_buffer[256];
static int mnemonic_word_count = 0;
static int mnemonic_page = 0;  /* Current page (3 words per page) */
static int wallet_list_selection = 0;

/* Create wallet state */
static int create_word_count = 12;  /* 12 or 24 */
static bool create_show_mnemonic = false;
static char create_error[32] = {0};

/* Mnemonic entry state - logic lives in mnemonic-entry.c so it can be tested
 * on the host without an ESP32 attached (see sim/). */
static MnemonicEntry entry;
static char entry_error[20] = {0};

/* Settings state */
#define SETTINGS_ITEMS 6
static const char *settings_items[SETTINGS_ITEMS] = {
    "WiFi Test",
    "BLE Test",
    "USB HID Test",
    "Change PIN",
    "Wipe Device",
    "Back"
};
static int settings_selection = 0;
static bool wifi_enabled = false;
static bool ble_enabled = false;

/* PIN verification for sensitive operations */
static bool pending_mnemonic_display = false;

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

        /* First time: set password, subsequent: unlock */
        if (!status.password_set) {
            WalletError err = wallet_set_password(pin, strlen(pin));
            if (err != WALLET_OK) {
                ESP_LOGE(TAG, "Failed to set wallet password: %d", err);
                return false;
            }
        }

        WalletError err = wallet_unlock(pin, strlen(pin));
        if (err != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to unlock wallet: %d", err);
            return false;
        }
    }

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
        pin_wipe();
        wallet_wipe();
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
        snprintf(progress, sizeof(progress), "%d digits - OK to set", pin_cursor);
    } else {
        snprintf(progress, sizeof(progress), "%d/%d min", pin_cursor, PIN_MIN_LENGTH);
    }
    oled_draw_string_centered(5, progress);

    /* Draw instructions */
    oled_draw_string(7, 0, "UP DN  DEL  ADD");
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

    /* Draw attempts remaining */
    char attempts_str[20];
    snprintf(attempts_str, sizeof(attempts_str), "Tries: %d",
             pin_get_remaining_attempts());
    oled_draw_string_centered(5, attempts_str);

    /* Draw instructions */
    oled_draw_string(7, 0, "UP DN  DEL  ADD");
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
                        pin_wipe();
                        wallet_wipe();
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
 * Main Menu Screen
 * ============================================================================ */

static void screen_main_menu_enter(void)
{
    ESP_LOGI(TAG, "Main menu screen");
    menu_selection = 0;
}

static void screen_main_menu_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "-- Menu --");

    /* Draw menu items (3 visible at a time on 128x64) */
    int start = (menu_selection > 1) ? menu_selection - 1 : 0;
    if (start > MENU_ITEMS - 3) {
        start = MENU_ITEMS - 3;
    }
    if (start < 0) start = 0;

    for (int i = 0; i < 3 && (start + i) < MENU_ITEMS; i++) {
        int item_idx = start + i;
        char line[22];

        if (item_idx == menu_selection) {
            snprintf(line, sizeof(line), "> %s", menu_items[item_idx]);
        } else {
            snprintf(line, sizeof(line), "  %s", menu_items[item_idx]);
        }
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
            if (menu_selection < MENU_ITEMS - 1) {
                menu_selection++;
            }
            break;

        case BUTTON_ACCEPT:
            /* Handle menu selection */
            switch (menu_selection) {
                case 0: /* View Address */
                    ui_set_screen(SCREEN_WALLET_INFO);
                    break;
                case 1: /* Select Wallet */
                    ui_set_screen(SCREEN_WALLET_SELECT);
                    break;
                case 2: /* New Wallet - collect extra entropy first */
                    ui_set_screen(SCREEN_ENTROPY);
                    break;
                case 3: /* Import Wallet */
                    ui_set_screen(SCREEN_MNEMONIC_ENTRY);
                    break;
                case 4: /* Settings */
                    ui_set_screen(SCREEN_SETTINGS);
                    break;
            }
            break;

        case BUTTON_CANCEL:
            /* Lock device */
            pin_lock();
            pending_mnemonic_display = false;
            ui_set_screen(SCREEN_PIN_UNLOCK);
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Wallet Info Screen (View Address)
 * ============================================================================ */

static void screen_wallet_info_enter(void)
{
    ESP_LOGI(TAG, "Wallet info screen");

    memset(&eth_address, 0, sizeof(eth_address));

    if (!ensure_wallet_unlocked()) {
        strcpy(eth_address.hex, "Unlock failed");
        return;
    }

    WalletStatus status = wallet_get_status();
    if (status.wallet_count == 0) {
        /* No wallet - show message */
        strcpy(eth_address.hex, "No wallet");
        return;
    }

    /* Select first wallet if none active */
    if (status.active_wallet_index == 0) {
        WalletError err = wallet_select_wallet(1);
        if (err != WALLET_OK) {
            ESP_LOGE(TAG, "Failed to select wallet: %d", err);
            strcpy(eth_address.hex, "Select failed");
            return;
        }
    }

    /* Select default ETH path: m/44'/60'/0'/0/0 */
    HDPath eth_path = HDPATH_ETH_DEFAULT;
    WalletError err = wallet_select_path(&eth_path);
    if (err != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to select path: %d", err);
        strcpy(eth_address.hex, "Path failed");
        return;
    }

    /* Get ETH address */
    err = wallet_get_eth_address(&eth_address);
    if (err != WALLET_OK) {
        ESP_LOGE(TAG, "Failed to get address: %d", err);
        strcpy(eth_address.hex, "Addr failed");
    }
}

static void screen_wallet_info_render(void)
{
    oled_clear();

    WalletStatus status = wallet_get_status();
    char title[22];
    snprintf(title, sizeof(title), "Wallet %d/%d",
             status.active_wallet_index, status.wallet_count);
    oled_draw_string_centered(0, title);

    if (status.wallet_count == 0) {
        oled_draw_string_centered(3, "No wallet");
        oled_draw_string_centered(4, "Create one first");
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
    }

    oled_draw_string(7, 0, "BCK           QR");
}

static void screen_wallet_info_on_button(button_id_t btn)
{
    switch (btn) {
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
 * Wallet Create Screen
 * ============================================================================ */

static void screen_wallet_create_enter(void)
{
    ESP_LOGI(TAG, "Wallet create screen");
    create_word_count = 12;
    create_show_mnemonic = false;
    create_error[0] = '\0';
    memset(mnemonic_buffer, 0, sizeof(mnemonic_buffer));
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

                /* Generate mnemonic */
                create_show_mnemonic = true;
                ui_invalidate();
                ui_render();  /* Show "Generating..." */

                if (!ensure_wallet_unlocked()) {
                    ESP_LOGE(TAG, "Failed to unlock wallet");
                    strncpy(create_error, "Unlock failed", sizeof(create_error));
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

                /* wallet_create_mnemonic already stores and selects the wallet */
                WalletStatus status = wallet_get_status();
                ESP_LOGI(TAG, "Created wallet %d with %d words",
                         status.active_wallet_index, create_word_count);

                /* Go to mnemonic display */
                ui_set_screen(SCREEN_MNEMONIC_DISPLAY);
            }
            break;

        default:
            break;
    }

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

    /* Header: "Seed Phrase" */
    int total_pages = (mnemonic_word_count + 2) / 3;
    oled_draw_string_centered(0, "Seed Phrase");

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
            /* Next page or done */
            if (mnemonic_page < total_pages - 1) {
                mnemonic_page++;
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
    mnemonic_entry_reset(&entry, entry.target_words ? entry.target_words : 12);
    entry_error[0] = '\0';
}

static void screen_mnemonic_entry_render(void)
{
    oled_clear();

    char header[22];
    snprintf(header, sizeof(header), "Word %d/%d",
             entry.current_word + 1, entry.target_words);
    oled_draw_string_centered(0, header);

    /* Prefix typed so far, plus the highlighted selector option. The selector
     * only offers letters that can still lead to a real BIP39 word, and offers
     * "OK" once the prefix is a complete word. */
    char option = mnemonic_entry_option(&entry);
    char prefix_display[MNEMONIC_ENTRY_WORD_LEN + 6];

    if (option == MNEMONIC_ENTRY_COMMIT) {
        snprintf(prefix_display, sizeof(prefix_display), "%s[OK]", entry.prefix);
    } else {
        snprintf(prefix_display, sizeof(prefix_display), "%s%c", entry.prefix, option);
    }
    oled_draw_string(2, 0, "Type:");
    oled_draw_string(2, 36, prefix_display);

    if (entry_error[0] != '\0') {
        oled_draw_string(4, 0, entry_error);
    } else {
        const char *suggestion = mnemonic_entry_suggestion(&entry);
        if (suggestion) {
            int n = mnemonic_entry_match_count(&entry, 100);
            char line[22];
            if (n > 1) {
                snprintf(line, sizeof(line), "%s +%d", suggestion, n - 1);
            } else {
                snprintf(line, sizeof(line), "%s", suggestion);
            }
            oled_draw_string(4, 0, "Match:");
            oled_draw_string(4, 42, line);
        }
    }

    oled_draw_string(7, 0, "UP DN  DEL  SEL");
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

    switch (btn) {
        case BUTTON_UP:
            mnemonic_entry_scroll(&entry, 1);
            break;

        case BUTTON_DOWN:
            mnemonic_entry_scroll(&entry, -1);
            break;

        case BUTTON_CANCEL:
            if (!mnemonic_entry_back(&entry)) {
                mnemonic_entry_clear(&entry);
                ui_set_screen(SCREEN_MAIN_MENU);
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

/* WiFi test functions - AP mode so other devices can see it */
static bool wifi_event_loop_created = false;

#define WIFI_AP_SSID     "LeekWallet"
#define WIFI_AP_PASS     "leek1234"
#define WIFI_AP_CHANNEL  1
#define WIFI_AP_MAX_CONN 4

static void wifi_test_toggle(void)
{
#ifdef CONFIG_ESP_WIFI_ENABLED
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
        entropy_set_rf_active(true);
        ESP_LOGI(TAG, "WiFi AP enabled: SSID='%s' PASS='%s'", WIFI_AP_SSID, WIFI_AP_PASS);
    } else {
        ESP_LOGI(TAG, "Disabling WiFi...");
        esp_wifi_stop();
        esp_wifi_deinit();
        wifi_enabled = false;
        entropy_set_rf_active(ble_enabled);
        ESP_LOGI(TAG, "WiFi disabled");
    }
#else
    ESP_LOGW(TAG, "WiFi not enabled in sdkconfig");
    wifi_enabled = !wifi_enabled;  /* Just toggle display */
#endif
}

/* BLE test functions */
#ifdef CONFIG_BT_NIMBLE_ENABLED
static uint8_t ble_addr_type;

/* BLE advertising data */
static void ble_advertise(void)
{
    struct ble_gap_adv_params adv_params;
    struct ble_hs_adv_fields fields;
    int rc;

    memset(&fields, 0, sizeof(fields));

    /* Advertise flags: general discoverable + BLE only */
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;

    /* Include device name */
    fields.name = (uint8_t *)"LeekWallet";
    fields.name_len = strlen("LeekWallet");
    fields.name_is_complete = 1;

    /* Include TX power level */
    fields.tx_pwr_lvl_is_present = 1;
    fields.tx_pwr_lvl = BLE_HS_ADV_TX_PWR_LVL_AUTO;

    rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error setting adv fields: %d", rc);
        return;
    }

    /* Start advertising */
    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;  /* Undirected connectable */
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;  /* General discoverable */
    adv_params.itvl_min = 160;  /* 100ms */
    adv_params.itvl_max = 160;

    rc = ble_gap_adv_start(ble_addr_type, NULL, BLE_HS_FOREVER, &adv_params, NULL, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error starting advertising: %d", rc);
        return;
    }

    ESP_LOGI(TAG, "BLE advertising started as 'LeekWallet'");
}

static void ble_on_sync(void)
{
    int rc = ble_hs_id_infer_auto(0, &ble_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error determining address type: %d", rc);
        return;
    }

    uint8_t addr[6] = {0};
    ble_hs_id_copy_addr(ble_addr_type, addr, NULL);
    ESP_LOGI(TAG, "BLE Address: %02X:%02X:%02X:%02X:%02X:%02X",
             addr[5], addr[4], addr[3], addr[2], addr[1], addr[0]);

    ble_advertise();
}

static void ble_on_reset(int reason)
{
    ESP_LOGW(TAG, "BLE reset, reason: %d", reason);
}

static void ble_host_task(void *param)
{
    ESP_LOGI(TAG, "BLE Host Task Started");
    nimble_port_run();
    nimble_port_freertos_deinit();
}
#endif

static void ble_test_toggle(void)
{
#ifdef CONFIG_BT_NIMBLE_ENABLED
    if (!ble_enabled) {
        ESP_LOGI(TAG, "Enabling BLE (NimBLE)...");
        esp_err_t ret = nimble_port_init();
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "NimBLE init failed: %d", ret);
            return;
        }

        /* Configure NimBLE host */
        ble_hs_cfg.sync_cb = ble_on_sync;
        ble_hs_cfg.reset_cb = ble_on_reset;

        /* Initialize GAP and GATT services */
        ble_svc_gap_device_name_set("LeekWallet");
        ble_svc_gap_init();
        ble_svc_gatt_init();

        /* Start host task */
        nimble_port_freertos_init(ble_host_task);
        ble_enabled = true;
        entropy_set_rf_active(true);
        ESP_LOGI(TAG, "BLE enabled - advertising as 'LeekWallet'");
    } else {
        ESP_LOGI(TAG, "Disabling BLE...");
        ble_gap_adv_stop();
        nimble_port_stop();
        nimble_port_deinit();
        ble_enabled = false;
        entropy_set_rf_active(wifi_enabled);
        ESP_LOGI(TAG, "BLE disabled");
    }
#elif defined(CONFIG_BT_ENABLED)
    if (!ble_enabled) {
        ESP_LOGI(TAG, "Enabling BLE (Bluedroid)...");
        esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
        esp_bt_controller_init(&bt_cfg);
        esp_bt_controller_enable(ESP_BT_MODE_BLE);
        esp_bluedroid_init();
        esp_bluedroid_enable();
        ble_enabled = true;
        ESP_LOGI(TAG, "BLE enabled");
    } else {
        ESP_LOGI(TAG, "Disabling BLE...");
        esp_bluedroid_disable();
        esp_bluedroid_deinit();
        esp_bt_controller_disable();
        esp_bt_controller_deinit();
        ble_enabled = false;
        entropy_set_rf_active(wifi_enabled);
        ESP_LOGI(TAG, "BLE disabled");
    }
#else
    ESP_LOGW(TAG, "BLE not enabled in sdkconfig");
    ble_enabled = !ble_enabled;  /* Just toggle display */
#endif
}

/* USB HID test function */
static void usb_hid_test(void)
{
#ifdef CONFIG_TINYUSB_ENABLED
    ESP_LOGI(TAG, "USB HID test - typing address...");
    if (eth_address.hex[0] != '\0' && eth_address.hex[0] != 'N') {
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
        if (item_idx == 0) {  /* WiFi */
            if (item_idx == settings_selection) {
                snprintf(line, sizeof(line), "> WiFi %s", wifi_enabled ? "[ON]" : "[OFF]");
            } else {
                snprintf(line, sizeof(line), "  WiFi %s", wifi_enabled ? "[ON]" : "[OFF]");
            }
        } else if (item_idx == 1) {  /* BLE */
            if (item_idx == settings_selection) {
                snprintf(line, sizeof(line), "> BLE %s", ble_enabled ? "[ON]" : "[OFF]");
            } else {
                snprintf(line, sizeof(line), "  BLE %s", ble_enabled ? "[ON]" : "[OFF]");
            }
        } else {
            if (item_idx == settings_selection) {
                snprintf(line, sizeof(line), "> %s", settings_items[item_idx]);
            } else {
                snprintf(line, sizeof(line), "  %s", settings_items[item_idx]);
            }
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
            switch (settings_selection) {
                case 0: /* WiFi Test */
                    wifi_test_toggle();
                    break;
                case 1: /* BLE Test */
                    ble_test_toggle();
                    break;
                case 2: /* USB HID Test */
                    usb_hid_test();
                    break;
                case 3: /* Change PIN */
                    ESP_LOGI(TAG, "Change PIN not yet implemented");
                    break;
                case 4: /* Wipe Device */
                    pin_wipe();
                    wallet_wipe();
                    wallet_init();
                    ESP_LOGI(TAG, "Device wiped");
                    ui_set_screen(SCREEN_PIN_SETUP);
                    break;
                case 5: /* Back */
                    ui_set_screen(SCREEN_MAIN_MENU);
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
    if (eth_address.hex[0] == '\0') {
        /* Fallback: try to get address again */
        if (ensure_wallet_unlocked()) {
            WalletStatus status = wallet_get_status();
            if (status.wallet_count > 0) {
                if (status.active_wallet_index == 0) {
                    wallet_select_wallet(1);
                }
                HDPath eth_path = HDPATH_ETH_DEFAULT;
                wallet_select_path(&eth_path);
                wallet_get_eth_address(&eth_address);
            }
        }
    }
}

static void screen_qr_code_render(void)
{
    if (eth_address.hex[0] == '\0' || strcmp(eth_address.hex, "No wallet") == 0) {
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
            /* Show seed phrase (requires PIN) */
            pending_mnemonic_display = true;
            pin_lock();  /* Force re-entry of PIN */
            ui_set_screen(SCREEN_PIN_UNLOCK);
            break;

        default:
            break;
    }

    ui_invalidate();
}

/* ============================================================================
 * Entropy Collection Screen
 *
 * Optional extra randomness before generating a seed. The user presses buttons;
 * what is harvested is not which button but the microsecond timing between
 * presses, which is genuinely unpredictable. It is mixed with the hardware RNG,
 * never substituted for it - see entropy.h.
 * ============================================================================ */

/* Enough presses that the conservative 4-bits-each estimate clears 128 bits. */
#define ENTROPY_TARGET_EVENTS 32

static void screen_entropy_enter(void)
{
    ESP_LOGI(TAG, "Entropy collection screen");
    entropy_reset_user_pool();
}

static void screen_entropy_render(void)
{
    oled_clear();
    oled_draw_string_centered(0, "Add Randomness");

    int events = entropy_user_event_count();
    int target = ENTROPY_TARGET_EVENTS;

    char line[22];
    snprintf(line, sizeof(line), "%d / %d presses", events, target);
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

    if (events >= target) {
        oled_draw_string_centered(5, "Ready");
        oled_draw_string(7, 0, "SKIP       DONE");
    } else {
        oled_draw_string_centered(5, "Press any key");
        oled_draw_string(7, 0, "SKIP");
    }
}

static void screen_entropy_on_button(button_id_t btn)
{
    int events = entropy_user_event_count();
    bool ready = events >= ENTROPY_TARGET_EVENTS;

    /* Once the target is met, CANCEL skips and ACCEPT proceeds. Before that,
     * every press is a sample - including CANCEL, so the user cannot leave
     * early by accident. A deliberate skip is still available via CANCEL after
     * one press, which the footer advertises. */
    if (ready && btn == BUTTON_ACCEPT) {
        ESP_LOGI(TAG, "Collected %d events (~%d bits) for the pool",
                 events, entropy_user_bits_estimate());
        ui_set_screen(SCREEN_WALLET_CREATE);
        return;
    }

    if (btn == BUTTON_CANCEL && events > 0 && !ready) {
        /* Skipping is allowed: hardware entropy alone is the baseline, and the
         * pool is additive. Keep whatever was collected. */
        ESP_LOGI(TAG, "User skipped with %d events", events);
        ui_set_screen(SCREEN_WALLET_CREATE);
        return;
    }

    entropy_add_user_event((uint8_t)btn, (uint64_t)esp_timer_get_time());
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
    screens[SCREEN_MAIN_MENU] = &screen_main_menu;
    screens[SCREEN_WALLET_INFO] = &screen_wallet_info;
    screens[SCREEN_MNEMONIC_ENTRY] = &screen_mnemonic_entry;
    screens[SCREEN_WALLET_CREATE] = &screen_wallet_create;
    screens[SCREEN_WALLET_SELECT] = &screen_wallet_select;
    screens[SCREEN_MNEMONIC_DISPLAY] = &screen_mnemonic_display;
    screens[SCREEN_SETTINGS] = &screen_settings;
    screens[SCREEN_QR_CODE] = &screen_qr_code;
    screens[SCREEN_ENTROPY] = &screen_entropy;

    current_screen = SCREEN_BOOT;
    needs_render = true;

    ESP_LOGI(TAG, "UI initialized");
}

void ui_set_screen(screen_id_t screen)
{
    if (screen >= SCREEN_COUNT) {
        ESP_LOGE(TAG, "Invalid screen ID: %d", screen);
        return;
    }

    /* Exit current screen */
    if (screens[current_screen] && screens[current_screen]->exit) {
        screens[current_screen]->exit();
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
    needs_render = false;
}

void ui_invalidate(void)
{
    needs_render = true;
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

void ui_task(void *pvParameters)
{
    (void)pvParameters;
    QueueHandle_t queue = button_get_queue();
    button_event_t event;

    /* Initial render */
    ui_render();

    ESP_LOGI(TAG, "UI task started");

    while (1) {
        /* Wait for button event with timeout for periodic refresh */
        if (xQueueReceive(queue, &event, pdMS_TO_TICKS(100)) == pdTRUE) {
            ui_handle_button(event.id);
        }

        /* Re-render if needed */
        if (ui_needs_render()) {
            ui_render();
        }
    }
}
