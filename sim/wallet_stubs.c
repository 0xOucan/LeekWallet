/**
 * Minimal wallet surface for host suites that link src/pin.c without the real
 * vault.
 *
 * pin.c now depends on the wallet because the PIN *is* the vault password: a
 * PIN change has to re-encrypt every mnemonic. Suites that test the attempt
 * counter or the wipe do not care about that, so here it is a device with no
 * vault at all - wallet_get_status() reports no password, and pin_change()
 * skips straight to the hash. The re-encryption itself is tested against the
 * real leek-wallet.c in test_pin_change.c.
 */

#include "leek-wallet.h"

#include <stddef.h>

WalletStatus wallet_get_status(void)
{
    WalletStatus s = {0};
    return s;
}

WalletError wallet_change_password(const char *old_password, size_t old_length,
                                   const char *new_password, size_t new_length,
                                   const uint8_t companion_hash[32],
                                   WalletProgressFn progress)
{
    (void)old_password; (void)old_length; (void)new_password;
    (void)new_length; (void)companion_hash; (void)progress;
    return WALLET_ERROR_NOT_INITIALIZED;
}

bool wallet_get_companion_hash(uint8_t hash_out[32])
{
    (void)hash_out;
    return false;
}
