/**
 * Ethereum transaction encoding and rendering.
 *
 * The device builds the signing payload itself from structured fields, hashes
 * what it built, and displays what it hashed. The host never supplies bytes to
 * sign — see docs/PROTOCOL.md section 1. That is the whole difference between
 * a hardware wallet and a very careful USB key.
 *
 * EIP-1559 (type 2) only. Legacy transactions would mean a second encoding and
 * a second thing to get right, and nothing needs them.
 *
 * No ESP-IDF dependency, so the host suite drives it against known vectors.
 */

#ifndef ETH_TX_H
#define ETH_TX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Big-endian, minimal-length integers as they appear on the wire. Ethereum
 * quantities are up to 32 bytes and RLP rejects leading zeros. */
typedef struct {
    uint8_t bytes[32];
    size_t  length;
} EthQuantity;

/* The longest calldata this device will hold.
 *
 * It was 256, which covered every static-argument call the decoder knew: six
 * words plus a selector is 196 bytes and nothing came close. It is 640 because
 * Aqua's `ship` does not fit in 256 and cannot be made to — its arguments are
 * a strategy blob plus two arrays, and the strategy alone is 256 bytes in the
 * deployments observed on chain. A limit that refuses a call the device can
 * otherwise read in full and draw is a capacity limit standing in for a
 * comprehension one, which is the confusion PROTOCOL.md 6bis exists to keep
 * apart.
 *
 * The ceiling above it is PROTOCOL_MAX_FRAME (1024): a signTransaction request
 * carrying 640 bytes of calldata plus its other fields is about 760 bytes of
 * CBOR, so the frame still bounds this rather than the other way round. Raising
 * it further means raising that first, and then the two RLP buffers in
 * eth-tx.c, which are stack locals on the protocol task.
 *
 * Refusing anything longer stays the honest answer: the device never held those
 * bytes, so it could not hash or display what it would be signing. */
#define ETH_MAX_DATA 640

typedef struct {
    uint64_t     chain_id;
    EthQuantity  nonce;
    EthQuantity  max_priority_fee;
    EthQuantity  max_fee;
    EthQuantity  gas_limit;
    uint8_t      to[20];
    bool         has_to;          /* false means contract creation */
    EthQuantity  value;
    uint8_t      data[ETH_MAX_DATA];
    size_t       data_length;
} EthTx;

/** Set a quantity from a big-endian byte string, stripping leading zeros. */
bool eth_quantity_set(EthQuantity *q, const uint8_t *bytes, size_t length);

/** Set a quantity from a 64-bit value. */
void eth_quantity_set_u64(EthQuantity *q, uint64_t value);

/**
 * Build the EIP-1559 signing payload: 0x02 || rlp([chainId, nonce, ...]).
 * Returns the length written, or 0 if it does not fit.
 */
size_t eth_tx_encode(const EthTx *tx, uint8_t *out, size_t out_capacity);

/** keccak256 of the signing payload — the digest that gets signed. */
bool eth_tx_hash(const EthTx *tx, uint8_t hash_out[32]);

/* ------------------------------------------------------ personal_sign */

/* The longest message this device will sign.
 *
 * Bounded by what the confirmation screen can render in full — six rows of
 * twenty characters — not by what the buffer could hold. A message the user
 * cannot read on the device is a message they cannot approve, and scrolling
 * past an unread remainder is the habit this whole design is trying not to
 * teach. */
#define ETH_MAX_MESSAGE 120

/**
 * True if the message can be rendered honestly on the device's display:
 * printable ASCII, no control bytes, and short enough to fit on screen.
 *
 * Anything else is refused rather than mangled — see the note in the .c.
 */
bool eth_message_is_displayable(const uint8_t *message, size_t length);

/**
 * EIP-191 personal_sign digest:
 *   keccak256("\x19Ethereum Signed Message:\n" || decimal_length || message)
 *
 * The decimal length is the byte count in ASCII. A wrong prefix yields a valid
 * signature over something the user never saw, so this is deliberately the
 * only place it is constructed.
 */
bool eth_message_hash(const uint8_t *message, size_t length, uint8_t hash_out[32]);

/* ------------------------------------------------------------- rendering */

/**
 * Format a value in ether with up to `max_decimals` places, trailing zeros
 * trimmed.
 *
 * Rendering matters as much as hashing here: a user approving "0.5" when the
 * transaction says 5 has approved the wrong thing, and the signature will be
 * perfectly valid.
 */
bool eth_format_value(const EthQuantity *wei, char *out, size_t out_size,
                      int max_decimals);

/**
 * Format a quantity as a plain decimal integer, no scaling.
 *
 * For raw token units, where the device has no way to learn the contract's
 * decimals and must not imply a scale it does not know. Fails rather than
 * truncates — a shortened number is a different number.
 */
bool eth_format_integer(const EthQuantity *q, char *out, size_t out_size);

/** "0x1234…ABCD" for a 20-byte address, EIP-55 checksummed. */
bool eth_format_address(const uint8_t address[20], char *out, size_t out_size);

/** Human-readable chain name, or the number when unknown. */
const char *eth_chain_name(uint64_t chain_id, char *scratch, size_t scratch_size);

#endif /* ETH_TX_H */
