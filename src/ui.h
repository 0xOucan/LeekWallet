/**
 * LeekWallet UI Framework
 * Screen state machine and rendering
 */

#ifndef UI_H
#define UI_H

#include <stdbool.h>
#include <stdint.h>
#include "button.h"
#include "eth-tx.h"

/**
 * Screen identifiers
 */
typedef enum {
    SCREEN_BOOT,
    SCREEN_PIN_SETUP,
    SCREEN_PIN_UNLOCK,
    SCREEN_PIN_CHANGE,
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
    SCREEN_SIGN_CONFIRM,
    SCREEN_HOST_PASSPHRASE_CONFIRM,
    SCREEN_SIGN_RESULT,
    /* Turning blind signing on (T16). Its own screen rather than a toggle in
     * the settings list, because switching off a protection should cost more
     * than one press and should not be possible without reading why. */
    SCREEN_BLIND_WARN,
    SCREEN_COUNT
} screen_id_t;

/**
 * Screen interface - each screen implements these callbacks
 */
typedef struct {
    void (*enter)(void);                    /* Called when screen becomes active */
    void (*render)(void);                   /* Called to draw the screen */
    void (*on_button)(button_id_t btn);     /* Called on button press */
    /* Called when leaving the screen, with the screen being moved to.
     *
     * The destination is passed because the decision this hook exists for -
     * whether a secret in a static buffer is still needed - depends on it.
     * The seed display and the seed verification screen share
     * `mnemonic_buffer` and hand off to each other in both directions, so a
     * hook that zeroed unconditionally would break wallet creation rather
     * than secure it (AUDIT S5). */
    void (*exit)(screen_id_t next);
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

/**
 * Show a transaction and ask the user to approve it.
 *
 * The fields come from the device's own parse, never from a string the host
 * supplied, and the payload that gets signed is the one rendered here.
 *
 * `from` is the checksummed source address, derived by the caller at the same
 * path the signature will be taken at. It is passed in rather than looked up
 * on the UI task, which shares derivation state with the protocol task (T47).
 *
 * Returns immediately. The protocol task polls ui_sign_outcome().
 */
void ui_request_sign(const EthTx *tx, uint32_t address_index, const char *from);

/**
 * Show a message and ask the user to approve signing it (EIP-191).
 *
 * Same machinery as ui_request_sign(): one pending request at a time, one
 * outcome, polled by the protocol task. The message is rendered in full — the
 * caller has already refused anything that could not be (eth_message_is_
 * displayable), because a message shown mangled is a message signed blind.
 *
 * `from` is the checksummed source address, derived by the caller at the same
 * path the signature will be taken at (T47).
 */
void ui_request_sign_message(const char *message, size_t length,
                             uint32_t address_index, const char *from);

/**
 * Show the wallet a host-supplied passphrase produced, and ask the user to
 * confirm it is theirs (PROTOCOL.md 5).
 *
 * A mistyped or substituted passphrase does not error — it derives a different,
 * perfectly valid wallet — so recognising this address is the only thing that
 * catches it. Rejection is the recoverable path: the caller clears the
 * passphrase.
 */
void ui_request_passphrase_confirm(const char *address);

typedef enum {
    SIGN_PENDING,
    SIGN_APPROVED,
    SIGN_REJECTED,
} SignOutcome;

/**
 * Tell the user what became of the thing they approved.
 *
 * Called by the task that actually produced the signature, not at the moment
 * of approval - the device should not claim to have signed something before it
 * has. Without this the screen dropped straight back to the address list and
 * an approval looked identical to a press that never registered.
 *
 * The device cannot know whether the transaction was broadcast; that happens on
 * the host. It knows only that it signed, and says only that.
 */
void ui_sign_report(bool ok);

SignOutcome ui_sign_outcome(void);
void ui_sign_clear(void);

#endif /* UI_H */
