/**
 * Test control surface for the fake wallet. See fake_wallet.c.
 */

#ifndef FAKE_WALLET_H
#define FAKE_WALLET_H

#include <stdbool.h>
#include <stdint.h>

/** Empty device: no password, no seeds, locked. */
void fake_wallet_reset(void);

/**
 * Preload a seed as if it had been imported earlier, and select it.
 * Returns the 1-based wallet index, or 0 if there is no room.
 */
uint8_t fake_wallet_preload(const char *mnemonic);

/** True once the UI has called wallet_mark_backup_verified for `index`. */
bool fake_wallet_backup_verified(uint8_t index);

#endif /* FAKE_WALLET_H */
