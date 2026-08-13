/**
 * LeekWallet UI Framework
 * Screen state machine and rendering
 */

#ifndef UI_H
#define UI_H

#include <stdbool.h>
#include <stdint.h>
#include "button.h"

/**
 * Screen identifiers
 */
typedef enum {
    SCREEN_BOOT,
    SCREEN_PIN_SETUP,
    SCREEN_PIN_UNLOCK,
    SCREEN_MAIN_MENU,
    SCREEN_WALLET_INFO,
    SCREEN_WALLET_SELECT,
    SCREEN_MNEMONIC_DISPLAY,
    SCREEN_MNEMONIC_ENTRY,
    SCREEN_WALLET_CREATE,
    SCREEN_SETTINGS,
    SCREEN_WIPE_CONFIRM,
    SCREEN_QR_CODE,
    SCREEN_ENTROPY,
    SCREEN_MNEMONIC_VERIFY,
    SCREEN_SESSION_CONFIRM,
    SCREEN_PASSPHRASE,
    SCREEN_PASSPHRASE_CONFIRM,
    SCREEN_COUNT
} screen_id_t;

/**
 * Screen interface - each screen implements these callbacks
 */
typedef struct {
    void (*enter)(void);                    /* Called when screen becomes active */
    void (*render)(void);                   /* Called to draw the screen */
    void (*on_button)(button_id_t btn);     /* Called on button press */
    void (*exit)(void);                     /* Called when leaving screen */
} screen_t;

/**
 * Initialize UI subsystem
 * Call after OLED and button init
 */
void ui_init(void);

/**
 * Set the current screen
 * Calls exit() on old screen and enter() on new screen
 * @param screen Screen to switch to
 */
void ui_set_screen(screen_id_t screen);

/**
 * Get the current screen ID
 * @return Current screen
 */
screen_id_t ui_get_screen(void);

/**
 * Handle a button press event
 * Routes to current screen's on_button callback
 * @param btn Button that was pressed
 */
void ui_handle_button(button_id_t btn);

/**
 * Render the current screen
 * Calls the current screen's render callback
 */
void ui_render(void);

/**
 * Request a screen re-render
 * Call this when screen data has changed
 */
void ui_invalidate(void);

/**
 * Check if screen needs re-rendering
 * @return true if ui_invalidate() was called
 */
bool ui_needs_render(void);

/**
 * Clear the invalidation flag after rendering
 */
void ui_clear_invalidation(void);

/**
 * Register a custom screen
 * @param id Screen ID to register
 * @param screen Screen callbacks
 */
void ui_register_screen(screen_id_t id, const screen_t *screen);

/**
 * UI main task - runs the screen state machine
 * This should be started as a FreeRTOS task
 * @param pvParameters Unused
 */
void ui_task(void *pvParameters);

/**
 * Ask the user to compare the session passkey.
 *
 * Called from the protocol task when a handshake begins. The UI task picks it
 * up on its next pass rather than switching screens from another task.
 */
void ui_request_session_confirm(void);

/**
 * Ask the user to unlock, on behalf of a host request.
 *
 * The PIN is entered on the device and never travels. The host polls
 * `getStatus` to learn whether it worked.
 */
void ui_request_unlock(void);

/** Lock on behalf of a host request. */
void ui_request_lock(void);

#endif /* UI_H */
