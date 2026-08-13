/**
 * Stand-in for components/leek-wallet, for host UI tests.
 *
 * The real wallet drags in BIP32, secp256k1 and the encrypted vault. None of
 * that decides what appears on screen, and all of it makes a UI test slow and
 * noisy. What the UI actually needs from the wallet is a status struct, a seed
 * phrase, and an address string - so that is what this provides, deterministic
 * and instant.
 *
 * The one place it is not a lie: wallet_validate_mnemonic() runs the real BIP39
 * checksum, because "the device accepted a phrase it should have rejected" is
 * exactly the sort of thing a UI test is here to catch.
 */

#include "fake_wallet.h"
#include "leek-wallet.h"

#include "bip39.h"
#include "memzero.h"

#include <stdio.h>
#include <string.h>

#define FAKE_MAX_WALLETS 8
#define FAKE_MNEMONIC_LEN 256

static struct {
    bool initialized;
    bool password_set;
    bool unlocked;
    uint8_t count;
    uint8_t active;                     /* 1-based, 0 = none */
    char mnemonics[FAKE_MAX_WALLETS][FAKE_MNEMONIC_LEN];
    bool verified[FAKE_MAX_WALLETS];
    char passphrase[64];
    bool has_passphrase;
} w;

/* Valid phrases from the BIP39 test vectors, so the checksum path is genuine. */
static const char *FAKE_12 =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
static const char *FAKE_24 =
    "legal winner thank year wave sausage worth useful legal winner thank year "
    "wave sausage worth useful legal winner thank year wave sausage worth title";

void fake_wallet_reset(void)
{
    memset(&w, 0, sizeof(w));
    fake_wallet_fail_derivation(false);
}

uint8_t fake_wallet_preload(const char *mnemonic)
{
    if (w.count >= FAKE_MAX_WALLETS) {
        return 0;
    }
    snprintf(w.mnemonics[w.count], FAKE_MNEMONIC_LEN, "%s", mnemonic);
    w.count++;
    w.active = w.count;
    return w.count;
}

bool fake_wallet_backup_verified(uint8_t index)
{
    return (index >= 1 && index <= w.count) ? w.verified[index - 1] : false;
}

/* --------------------------------------------------------- leek-wallet.h */

WalletError wallet_init(void)
{
    w.initialized = true;
    return WALLET_OK;
}

WalletStatus wallet_get_status(void)
{
    WalletStatus s = {
        .initialized = w.initialized,
        .password_set = w.password_set,
        .unlocked = w.unlocked,
        .has_mnemonic = w.count > 0,
        .active_wallet_index = w.active,
        .wallet_count = w.count,
    };
    return s;
}

WalletError wallet_set_password(const char *password, size_t length)
{
    (void)password;
    if (length == 0) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }
    w.password_set = true;
    return WALLET_OK;
}

WalletError wallet_unlock(const char *password, size_t length)
{
    (void)password;
    if (length == 0) {
        return WALLET_ERROR_WRONG_PASSWORD;
    }
    w.initialized = true;
    w.password_set = true;
    w.unlocked = true;
    return WALLET_OK;
}

void wallet_lock(void)
{
    w.unlocked = false;
    wallet_clear_passphrase();
}

WalletError wallet_set_passphrase(const char *passphrase, size_t length)
{
    if (!passphrase || length == 0) {
        wallet_clear_passphrase();
        return WALLET_OK;
    }
    snprintf(w.passphrase, sizeof(w.passphrase), "%.*s", (int)length, passphrase);
    w.has_passphrase = true;
    return WALLET_OK;
}

void wallet_clear_passphrase(void)
{
    memzero(w.passphrase, sizeof(w.passphrase));
    w.has_passphrase = false;
}

bool wallet_has_passphrase(void) { return w.has_passphrase; }

WalletError wallet_create_mnemonic(int word_count, char *mnemonic_out, size_t max_length)
{
    if (!mnemonic_out) {
        return WALLET_ERROR_INVALID_MNEMONIC;
    }
    snprintf(mnemonic_out, max_length, "%s", word_count == 24 ? FAKE_24 : FAKE_12);
    return WALLET_OK;
}

WalletError wallet_get_mnemonic(char *mnemonic_out, size_t max_length)
{
    if (!mnemonic_out || w.active == 0 || !w.unlocked) {
        return WALLET_ERROR_NO_MNEMONIC;
    }
    snprintf(mnemonic_out, max_length, "%s", w.mnemonics[w.active - 1]);
    return WALLET_OK;
}

bool wallet_validate_mnemonic(const char *mnemonic)
{
    return mnemonic && mnemonic_check(mnemonic) != 0;
}

uint8_t wallet_add_mnemonic(const char *mnemonic)
{
    return mnemonic ? fake_wallet_preload(mnemonic) : 0;
}

WalletError wallet_select_wallet(uint8_t index)
{
    if (index < 1 || index > w.count) {
        return WALLET_ERROR_NO_MNEMONIC;
    }
    w.active = index;
    return WALLET_OK;
}

void wallet_mark_backup_verified(uint8_t index)
{
    if (index >= 1 && index <= w.count) {
        w.verified[index - 1] = true;
    }
}

uint8_t wallet_unverified_count(void)
{
    uint8_t n = 0;
    for (uint8_t i = 0; i < w.count; i++) {
        if (!w.verified[i]) {
            n++;
        }
    }
    return n;
}

WalletError wallet_wipe(void)
{
    fake_wallet_reset();
    return WALLET_OK;
}

/* Derived from the wallet and the path index only, so a test can say exactly
 * which address should be on screen without doing any elliptic curve maths. */
static bool fail_derivation = false;

void fake_wallet_fail_derivation(bool fail)
{
    fail_derivation = fail;
}

WalletError wallet_get_address_at_path(const HDPath *path, EthAddress *address_out)
{
    if (!path || !address_out) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }
    if (fail_derivation) {
        return WALLET_ERROR_DERIVATION_FAILED;
    }
    if (!w.unlocked || w.active == 0) {
        return WALLET_ERROR_LOCKED;
    }
    /* A full 42-character address: "0x" and 40 hex digits, exactly what the
     * real derivation returns.
     *
     * The first four digits vary by wallet and index so tests can tell two
     * addresses apart; the rest is filler. Emitting a shorter string would
     * make the fake produce something no device ever produces, and would hide
     * every bug about telling a real address from something that is not one
     * (AUDIT S8a). */
    snprintf(address_out->hex, sizeof(address_out->hex),
             "0x%02x%02x%s", w.active, (unsigned)(path->address_index & 0xFF),
             "aaaaaaaabbbbbbbbccccccccddddddddeeee");
    return WALLET_OK;
}
