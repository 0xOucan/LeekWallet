/**
 * LeekWallet PIN Management
 * Secure PIN storage and verification
 */

#ifndef PIN_H
#define PIN_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#include "leek-wallet.h"   /* WalletProgressFn */

/* PIN configuration */
#define PIN_MIN_LENGTH      4
#define PIN_MAX_LENGTH      8
#define PIN_MAX_ATTEMPTS    3

/**
 * Initialize PIN subsystem
 * Must be called before using other PIN functions
 * @return true on success
 */
bool pin_init(void);

/**
 * Check if a PIN has been set
 * @return true if PIN is configured
 */
bool pin_is_set(void);

/**
 * Set a new PIN
 * @param pin The PIN string (digits only)
 * @return true on success
 */
bool pin_set(const char *pin);

/**
 * Verify PIN attempt
 * Decrements remaining attempts on failure
 * @param pin The PIN to verify
 * @return true if PIN is correct
 */
bool pin_verify(const char *pin);

/**
 * Get remaining PIN attempts before wipe
 * @return Number of attempts remaining (0-3)
 */
uint8_t pin_get_remaining_attempts(void);

/**
 * Check if device should be wiped (0 attempts remaining)
 * @return true if no attempts remain
 */
bool pin_should_wipe(void);

/**
 * Reset attempt counter (call after successful unlock)
 */
void pin_reset_attempts(void);

/**
 * Wipe all PIN data from storage
 */
void pin_wipe(void);

/**
 * Change the PIN, re-encrypting the vault under it.
 *
 * The PIN is the vault password, so this is not a hash swap: every stored
 * mnemonic is re-encrypted under the new key first, and only then does the
 * stored PIN hash move. See wallet_change_password() for the atomicity.
 *
 * Costs one PIN attempt, refunded when the current PIN is correct. Returns
 * false with nothing changed if the current PIN is wrong, the new PIN is
 * malformed, or any wallet could not be read back.
 *
 * @param current_pin Current PIN
 * @param new_pin New PIN to set
 * @return true on success
 */
bool pin_change(const char *current_pin, const char *new_pin);

/**
 * Install a progress callback for the re-encryption inside pin_change().
 * Optional; NULL disables it. Called from the changing thread.
 */
void pin_set_change_progress(WalletProgressFn fn);

/**
 * Adopt the PIN verifier stored in the vault's atomic record, if it disagrees.
 *
 * Recovers a PIN change interrupted between the vault flip and the PIN hash
 * write. Called automatically from pin_init() and pin_verify(); exposed for
 * tests and for callers that init NVS late.
 */
void pin_reconcile_with_vault(void);

/**
 * Validate PIN format (correct length, digits only)
 * @param pin PIN string to validate
 * @return true if valid format
 */
bool pin_is_valid_format(const char *pin);

/**
 * Get the current PIN for wallet encryption
 * Only valid after successful pin_verify()
 * @param pin Buffer to receive PIN
 * @param max_len Buffer size
 * @return true if PIN is available
 */
bool pin_get_current(char *pin, size_t max_len);

/**
 * Check if PIN has been verified this session
 * @return true if PIN was successfully verified
 */
bool pin_is_unlocked(void);

/**
 * Lock the device (clear verified state)
 */
void pin_lock(void);

#endif /* PIN_H */
