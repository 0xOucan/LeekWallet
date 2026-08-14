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
#include "leek-wallet.h"

/**
 * How many BIP44 accounts the device offers on its own screens (T45).
 *
 * m/44'/60'/<account>'/0/<index>: the account level is a separate identity off
 * the same seed — separate history, separate balance — which docs/VAULT.md
 * argues should be the ordinary way to hold several wallets, rather than
 * storing several seeds and multiplying the number of things to back up.
 *
 * Ten, matching ADDRESS_INDEX_COUNT, and for the same reason: a selector on
 * four buttons has to stay a short cycle, and ten identities is already far
 * past what anyone navigates by pressing a button ten times. It is NOT a limit
 * on what the device can derive or sign — the protocol carries a full path and
 * a host may ask for any account — which is exactly why every confirmation
 * screen renders the whole path rather than an index. An account the device's
 * own menu cannot reach is legitimate; an account the user cannot SEE is not.
 */
#define HD_ACCOUNT_COUNT 10

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
    /* Renaming the device for BLE advertising (T56). */
    SCREEN_BLE_NAME,
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
 * Work the UI task owes itself, run once per loop *after* the repaint.
 *
 * Two things live here, and both are the same shape: something that must not
 * happen inside a button handler.
 *
 *   - Slow work a screen announced (AUDIT S8f). Seed generation takes long
 *     enough to need a "Generating..." frame in front of it, and the old code
 *     got that frame onto the panel by calling ui_render() from inside the
 *     button handler. That gave the screen two render paths and let a repaint
 *     re-enter a screen that was mid-transition. Now the handler only sets the
 *     text and marks the screen dirty; the loop paints it, and the generation
 *     runs here, once the frame is already on the glass.
 *
 *   - State another task changed under a screen that is already up (T42): a
 *     host clearing the passphrase while the wallet screen shows an address
 *     and a fingerprint derived from it.
 *
 * Called by ui_task(). The host tests call it directly, which is the whole
 * point of it being a function rather than a block inside the loop.
 */
void ui_poll_deferred(void);

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
 * `path` is that same path, in full. It is a path rather than an index because
 * the account level is host-selectable too (T45): "addr 0" is identical text
 * for m/44'/60'/0'/0/0 and m/44'/60'/7'/0/0, and those are different wallets.
 * A host quietly moving accounts has to be visible, and it can only be visible
 * if the screen is given the whole path.
 *
 * Returns immediately. The protocol task polls ui_sign_outcome().
 */
void ui_request_sign(const EthTx *tx, const HDPath *path, const char *from);

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
                             const HDPath *path, const char *from);

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
