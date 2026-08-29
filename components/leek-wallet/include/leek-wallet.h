/**
 * Colibri Wallet - HD Wallet functionality for Pixie
 * Provides BIP39/BIP32 mnemonic and key management
 */
#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// Wallet status
typedef enum {
    WALLET_OK = 0,
    WALLET_ERROR_NOT_INITIALIZED,
    WALLET_ERROR_LOCKED,
    WALLET_ERROR_WRONG_PASSWORD,
    WALLET_ERROR_NO_MNEMONIC,
    WALLET_ERROR_INVALID_MNEMONIC,
    WALLET_ERROR_STORAGE_FULL,
    WALLET_ERROR_STORAGE_FAILED,
    WALLET_ERROR_DERIVATION_FAILED,
    WALLET_ERROR_SIGNING_FAILED,
} WalletError;

// Wallet state
typedef struct {
    bool initialized;
    bool password_set;
    bool unlocked;
    bool has_mnemonic;
    uint8_t active_wallet_index;
    uint8_t wallet_count;
} WalletStatus;

// HD Wallet path (BIP44 compatible)
typedef struct {
    uint32_t purpose;    // e.g., 44 (BIP44) or 84 (BIP84)
    uint32_t coin_type;  // e.g., 60 (ETH) or 0 (BTC)
    uint32_t account;
    uint32_t change;
    uint32_t address_index;
} HDPath;

// Default Ethereum path: m/44'/60'/0'/0/0
#define HDPATH_ETH_DEFAULT { .purpose = 44, .coin_type = 60, .account = 0, .change = 0, .address_index = 0 }

// Ethereum address (20 bytes + null)
typedef struct {
    char hex[43];  // "0x" + 40 hex chars + null
} EthAddress;

// Ethereum signature
typedef struct {
    uint8_t r[32];
    uint8_t s[32];
    uint8_t v;
} EthSignature;

// Public key (uncompressed, 65 bytes)
typedef struct {
    uint8_t data[65];
} PublicKey;

// ========== Initialization ========== //

/**
 * Initialize the wallet system
 * Must be called before any other wallet functions
 */
WalletError wallet_init(void);

/**
 * Get current wallet status
 */
WalletStatus wallet_get_status(void);

// ========== Password Management ========== //

/**
 * Set the wallet password (required before creating/importing mnemonic)
 * @param password Password string (min 8 chars)
 * @param length Password length
 */
WalletError wallet_set_password(const char *password, size_t length);

/**
 * Unlock the wallet with password
 * @param password Password string
 * @param length Password length
 */
WalletError wallet_unlock(const char *password, size_t length);

/**
 * Lock the wallet (clears keys from memory)
 */
void wallet_lock(void);

/**
 * Check if password is correct without unlocking
 */
bool wallet_verify_password(const char *password, size_t length);

/** Progress during a re-encryption, so the UI can show something moving. */
typedef void (*WalletProgressFn)(uint8_t done, uint8_t total);

/**
 * Change the vault password, re-encrypting every stored mnemonic.
 *
 * The encryption key is derived from the password, so a new password means new
 * ciphertext for every wallet. Both passwords are required because that is the
 * only moment both keys can be derived; there is no way to finish this later.
 *
 * Atomic: the vault either opens entirely with the new password or entirely
 * with the old one, whatever happens to the power. Every wallet is proved
 * readable before anything is written, so a corrupt slot aborts the change
 * with the vault untouched (WALLET_ERROR_STORAGE_FAILED).
 *
 * There is one verifier for one secret, and it is the salted PBKDF2 hash
 * inside this record. src/pin.c used to hand a second, cheaper one down to be
 * stored alongside it; that verifier is gone, so nothing rides along here any
 * more.
 *
 * @param progress       Optional; called as slots are verified and rewritten.
 * @return WALLET_OK, or WALLET_ERROR_WRONG_PASSWORD if the old password is
 *         wrong or the new one is too short.
 */
WalletError wallet_change_password(const char *old_password, size_t old_length,
                                   const char *new_password, size_t new_length,
                                   WalletProgressFn progress);

// ========== BIP39 Passphrase ========== //

/**
 * Set BIP39 passphrase (25th word)
 * @param passphrase Passphrase string (empty string to clear)
 * @param length Passphrase length (0 to clear)
 * @return WALLET_OK on success
 *
 * Note: Passphrase is NOT stored persistently - only in RAM.
 * Cleared automatically on lock/wipe. Setting invalidates cached seed.
 * Call before selectWallet to derive keys with passphrase.
 */
WalletError wallet_set_passphrase(const char *passphrase, size_t length);

/**
 * Clear BIP39 passphrase
 * Equivalent to wallet_set_passphrase("", 0)
 */
void wallet_clear_passphrase(void);

/**
 * Check if passphrase is set
 */
bool wallet_has_passphrase(void);

// ========== Temporary (session-only) seed ========== //

/**
 * Adopt a seed phrase for this session only, storing nothing.
 *
 * The seed lives in the same .bss struct, under the same lifetime, as the
 * BIP39 passphrase: it is cleared by wallet_lock(), by wallet_select_wallet(),
 * by wallet_wipe(), and by power going away. No NVS key is written on this
 * path - not the mnemonic, not a fingerprint, not a check value, not a flag
 * saying the mode was ever used. That is the entire point of the mode: a flash
 * dump of a device that was using a temporary seed contains nothing about it,
 * because a device that is not powered is not using one.
 *
 * The corollary the caller has to put on screen: locking, rebooting, or losing
 * power destroys this seed, and the PIN protects nothing at rest while it is
 * in use, because nothing is at rest.
 *
 * Requires an unlocked vault - the device still has a PIN gate, and this does
 * not open it. Rejects a phrase that fails its BIP39 checksum.
 */
WalletError wallet_use_temporary_mnemonic(const char *mnemonic);

/**
 * True while the seed in use was typed for this session and is stored nowhere.
 *
 * Screens are expected to ask, and to say so: a user who believes their seed
 * was saved and then reboots has lost it.
 */
bool wallet_has_temporary_mnemonic(void);

/**
 * Master key fingerprint (BIP32 "XFP"): the first four bytes of
 * hash160(master public key).
 *
 * Eight hex characters instead of forty-two. Coldcard shows it because it is
 * short enough that people actually write it down and compare it, which is the
 * whole point of showing an identifier at all - an address nobody checks
 * protects nobody.
 *
 * It also identifies the *seed*, not one address, so it is the cheapest way to
 * tell whether a passphrase produced the wallet you meant: change the
 * passphrase and this changes with it.
 *
 * NOT a secret, but it is a linkable identifier - the same seed shows the same
 * XFP everywhere - so treat it as pseudonymous rather than public.
 */
WalletError wallet_get_master_fingerprint(uint32_t *fingerprint_out);

// ========== Mnemonic Management ========== //

/**
 * Generate a new random mnemonic (12 or 24 words)
 * @param word_count 12 or 24
 * @param mnemonic_out Buffer to receive mnemonic (at least 256 bytes)
 * @param max_length Size of output buffer
 * Wallet must be unlocked
 */
WalletError wallet_create_mnemonic(int word_count, char *mnemonic_out, size_t max_length);

/**
 * Import an existing mnemonic
 * @param mnemonic Space-separated word list
 * Wallet must be unlocked
 */
WalletError wallet_import_mnemonic(const char *mnemonic);

/**
 * Get the current mnemonic (for backup display)
 * @param mnemonic_out Buffer to receive mnemonic
 * @param max_length Size of output buffer
 * Wallet must be unlocked
 */
WalletError wallet_get_mnemonic(char *mnemonic_out, size_t max_length);

/**
 * Check if a mnemonic is valid
 */
bool wallet_validate_mnemonic(const char *mnemonic);

// ========== HD Path Parsing ========== //

/**
 * Parse HD path string into HDPath struct
 * @param path_str Path string like "m/44'/60'/0'/0/0"
 * @param path_out Parsed path structure
 * @return true on success, false on invalid path
 *
 * Supported formats:
 * - Standard BIP44: "m/44'/60'/0'/0/0"
 * - With or without 'm/' prefix
 * - Hardened notation: ' or h suffix
 * - Max 5 levels (purpose/coin/account/change/index)
 */
bool wallet_parse_path(const char *path_str, HDPath *path_out);

/**
 * Format HDPath struct as path string
 * @param path Path structure
 * @param out Buffer to receive string (min 32 bytes)
 * @param out_size Size of output buffer
 * @return true on success
 */
bool wallet_format_path(const HDPath *path, char *out, size_t out_size);

// ========== Key Derivation ========== //

/**
 * Select active wallet by HD path
 * @param path HD derivation path
 */
WalletError wallet_select_path(const HDPath *path);

/**
 * Get the current HD path
 * @param path_out Path structure to fill
 * @return true if path is set, false if no wallet selected
 */
bool wallet_get_current_path(HDPath *path_out);

/**
 * Get the Ethereum address for the current path
 * @param address_out Address structure to fill
 */
WalletError wallet_get_eth_address(EthAddress *address_out);

/**
 * Get public key for the current path
 * @param pubkey_out Public key structure to fill
 */
WalletError wallet_get_public_key(PublicKey *pubkey_out);

// ========== Signing ========== //

/**
 * Sign a message hash (32 bytes)
 * @param hash 32-byte message hash
 * @param signature_out Signature structure to fill
 */
WalletError wallet_sign_hash(const uint8_t hash[32], EthSignature *signature_out);

/**
 * Select a path and sign under one lock.
 *
 * Prefer this over select-then-sign. Those are two calls sharing mutable
 * derivation state, and the UI task preempts the protocol task, so anything
 * between them can change which key signs.
 */
WalletError wallet_sign_hash_at_path(const HDPath *path, const uint8_t hash[32],
                                     EthSignature *signature_out);

/** Derive an address at a path under the same lock. */
WalletError wallet_get_address_at_path(const HDPath *path, EthAddress *address_out);

/**
 * Sign an Ethereum message (EIP-191 personal_sign)
 * @param message Message bytes
 * @param length Message length
 * @param signature_out Signature structure to fill
 */
WalletError wallet_sign_message(const uint8_t *message, size_t length, EthSignature *signature_out);

/**
 * Sign typed data (EIP-712)
 * Signs: keccak256("\x19\x01" + domain_separator + message_hash)
 * @param domain_separator 32-byte domain separator hash
 * @param message_hash 32-byte typed struct hash
 * @param signature_out Signature structure to fill
 */
WalletError wallet_sign_typed_data(const uint8_t domain_separator[32],
                                    const uint8_t message_hash[32],
                                    EthSignature *signature_out);

/**
 * Sign a raw Ethereum transaction (EIP-1559 or legacy)
 * Hashes the serialized unsigned transaction and signs
 * @param tx_bytes Serialized unsigned transaction (RLP encoded)
 * @param tx_length Length of transaction bytes
 * @param signature_out Signature structure to fill
 * @note For EIP-1559 (type 2), tx_bytes should start with 0x02
 * @note Signature v will be 0/1 for EIP-1559, 27/28 for legacy
 */
WalletError wallet_sign_transaction(const uint8_t *tx_bytes, size_t tx_length,
                                     EthSignature *signature_out);

// ========== Multi-Wallet Storage ========== //

/**
 * Maximum number of wallets that can be stored
 */
#define MAX_WALLETS 30

/**
 * Backup verification tracking.
 *
 * Records whether a wallet's seed phrase has been read back correctly by the
 * user. This is not an access control - it exists so destructive actions can
 * warn about the case that actually loses funds: erasing a wallet whose backup
 * was never confirmed. Asking for a PIN would not catch that.
 */
void wallet_mark_backup_verified(uint8_t index);
bool wallet_is_backup_verified(uint8_t index);

/** How many stored wallets have never had their backup verified. */
uint8_t wallet_unverified_count(void);

/**
 * Get the number of stored wallets
 */
uint8_t wallet_get_count(void);

/**
 * Get the currently active wallet index (1-based, 0 = none)
 */
uint8_t wallet_get_active_index(void);

/**
 * Select a wallet by index (1-based)
 * @param index Wallet index (1 to wallet_count)
 * @return WALLET_OK on success
 */
WalletError wallet_select_wallet(uint8_t index);

/**
 * Add a new mnemonic as a new wallet slot
 * @param mnemonic Space-separated word list
 * @return Wallet index (1-based) on success, 0 on error
 */
uint8_t wallet_add_mnemonic(const char *mnemonic);

/**
 * Delete a wallet by index
 * @param index Wallet index (1 to wallet_count)
 * @return WALLET_OK on success
 */
WalletError wallet_delete_mnemonic(uint8_t index);

/**
 * Wipe all wallet data (factory reset)
 * Clears all stored mnemonics and settings
 */
WalletError wallet_wipe(void);

#ifdef __cplusplus
}
#endif
