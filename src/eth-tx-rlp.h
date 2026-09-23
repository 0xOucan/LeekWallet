/**
 * Reading an unsigned EIP-1559 transaction off the air gap.
 *
 * USB and BLE hand the device a transaction as named CBOR fields; EIP-4527's
 * `sign-data` hands it the serialised transaction itself,
 *
 *   0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas,
 *                to, value, data, accessList])
 *
 * This turns those bytes into the same `EthTx` the USB path builds, so from
 * here on both entrances run one decision path (ARCHITECTURE.md, "a second
 * entrance, not a third transport"). eth-decode.c is not touched.
 *
 * ---------------------------------------------------------------------------
 * Canonical or refused
 *
 * After parsing, the transaction is re-encoded with eth_tx_encode() - the
 * function whose output is hashed and signed - and the result must equal the
 * input byte for byte. So a leading zero, a long-form length, a one-byte
 * string that should have been a bare byte, or anything else the parser was
 * lenient about is refused, and "the bytes signed are the bytes that were
 * scanned" holds by construction rather than by the parser being perfect.
 *
 * A non-empty access list is refused: EthTx cannot represent one, and dropping
 * it would sign a different transaction.
 */

#ifndef LEEK_ETH_TX_RLP_H
#define LEEK_ETH_TX_RLP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "eth-tx.h"

/** Parse `raw` into `out`. On false, `out` is zeroed and must not be used. */
bool eth_tx_from_rlp(const uint8_t *raw, size_t len, EthTx *out);

#endif /* LEEK_ETH_TX_RLP_H */
