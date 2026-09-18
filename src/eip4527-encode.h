/**
 * EIP-4527 writer: `crypto-hdkey` and `eth-signature`.
 *
 * ---------------------------------------------------------------------------
 * Why a separate file from the reader
 *
 * `eip4527.c` is attack surface and its grammar is frozen (RESEARCH-AIRGAP-
 * VAULT.md section 34). This file only ever writes bytes the device chose, so
 * it has nothing to defend against, and keeping it apart means a change here
 * cannot touch the reader by accident.
 *
 * ---------------------------------------------------------------------------
 * Where the field numbers come from
 *
 * Keystone's ur-registry `CryptoHDKey.ts` and Blockchain Commons BCR-2020-007,
 * which agree with each other. NOT the CDDL in the ERC-4527 prose, which has
 * typos (`#3.401`, `#5.304`) that no shipping wallet follows - an encoder
 * written from the prose would be read by nobody.
 *
 *   crypto-hdkey  1 is-master  2 is-private  3 key-data  4 chain-code
 *                 5 use-info (#6.305)  6 origin (#6.304)  7 children
 *                 8 parent-fingerprint  9 name  10 note
 *
 * The top-level map is untagged, because the UR type already says what it is;
 * nested items carry their tags, because inside the map nothing else does.
 *
 * ---------------------------------------------------------------------------
 * No allocation. Every function writes into a caller buffer and returns the
 * length, or 0 if it did not fit - never a partial encoding.
 */

#ifndef LEEK_EIP4527_ENCODE_H
#define LEEK_EIP4527_ENCODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** SLIP-44 coin type for Ethereum, as `use-info` and the path both carry it. */
#define E4527_COIN_ETH 60

/**
 * Longest `crypto-hdkey` this writer produces: 33 + 32 bytes of key material,
 * a three-level keypath and two fingerprints come to well under this.
 */
#define E4527_HDKEY_MAX 128

/** Longest `eth-signature`: 16-byte id, 65-byte signature, capped origin. */
#define E4527_SIGNATURE_MAX (8 + 18 + 67 + 2 + 64)

/**
 * An account-level key, m/44'/60'/<account>'.
 *
 * Public material only. The chain code is not a secret in the sense a private
 * key is, but together with the public key it lets the holder derive every
 * address in the account, which is exactly what the handshake is for and
 * exactly why the screen says so before it is shown.
 */
typedef struct {
    uint8_t  key_data[33];          /* compressed secp256k1 public key */
    uint8_t  chain_code[32];
    uint32_t account;               /* the third, hardened, path level */
    uint32_t master_fingerprint;    /* origin source-fingerprint */
    uint32_t parent_fingerprint;    /* fingerprint of m/44'/60' */
} E4527AccountKey;

/**
 * Encode the CBOR body of a `ur:crypto-hdkey` for an account xpub.
 *
 * Returns bytes written, or 0 if `out_size` is too small or the key is not a
 * compressed point (first byte 0x02 or 0x03) or the account does not fit a
 * hardened index.
 */
size_t eip4527_encode_account_hdkey(const E4527AccountKey *key,
                                    uint8_t *out, size_t out_size);

/**
 * Encode the CBOR body of a `ur:eth-signature`.
 *
 * `request_id` is required: it is what lets the companion pair a signature
 * with the request it answers, and the reader refuses a signature without
 * one. `origin` may be NULL; otherwise it is capped at E4527_MAX_ORIGIN.
 */
size_t eip4527_encode_signature(const uint8_t request_id[16],
                                const uint8_t signature[65],
                                const char *origin,
                                uint8_t *out, size_t out_size);

#endif /* LEEK_EIP4527_ENCODE_H */
