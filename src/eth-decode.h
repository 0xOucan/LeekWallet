/**
 * Calldata decoding — the decodable set (T50).
 *
 * A hardware wallet that renders a hash and asks for a signature is asking the
 * user to approve something they cannot read. The answer is not a better hash
 * display; it is to refuse. This module defines exactly what the device can
 * explain in words, and everything outside that set is rejected before the
 * confirmation screen is ever shown.
 *
 * The set today:
 *   - no calldata at all, a native transfer
 *   - ERC-20 transfer(address,uint256)
 *   - ERC-20 approve(address,uint256)
 *
 * Growing it means adding a decoder AND a screen that says what the call does.
 * A selector recognised but not rendered is worse than one refused, because it
 * looks like the device understood.
 *
 * No ESP-IDF dependency, so the host suite drives it directly.
 */

#ifndef ETH_DECODE_H
#define ETH_DECODE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "eth-tx.h"

typedef enum {
    ETH_CALL_EMPTY = 0,        /* no calldata: a plain value transfer */
    ETH_CALL_ERC20_TRANSFER,   /* transfer(address to, uint256 amount)   */
    ETH_CALL_ERC20_APPROVE,    /* approve(address spender, uint256 amount) */
    ETH_CALL_UNKNOWN           /* not in the decodable set — refuse it */
} EthCallKind;

typedef struct {
    EthCallKind kind;
    uint8_t     address[20];   /* recipient for transfer, spender for approve */
    EthQuantity amount;        /* raw token units — decimals are not knowable
                                * on-device, see eth_decode_call() */
    bool        unlimited;     /* approve only: an allowance nobody can spend
                                * through in practice, which is the pattern
                                * behind most drain incidents */
} EthCall;

/**
 * Decode `len` bytes of calldata.
 *
 * Returns the kind, also written to *out. Anything malformed — a short
 * argument block, trailing bytes, a padded address whose high 12 bytes are not
 * zero — is ETH_CALL_UNKNOWN rather than a best guess. A best guess here is a
 * lie told to someone about to sign.
 *
 * Token amounts are raw units. The device cannot call decimals() on the
 * contract, so it must not imply a scale it does not know; the screen says so.
 */
EthCallKind eth_decode_call(const uint8_t *data, size_t len, EthCall *out);

/** Short human label for a kind, for logs and screens. */
const char *eth_call_name(EthCallKind kind);

/**
 * Whether a transaction as a whole can be shown honestly and so may be signed.
 *
 * Contract creation is refused too: there is nothing to name, and the device
 * cannot tell the user what code they are deploying.
 */
bool eth_tx_is_decodable(const EthTx *tx, EthCall *out);

#endif /* ETH_DECODE_H */
