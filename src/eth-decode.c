/**
 * Calldata decoding - see eth-decode.h
 */

#include "eth-decode.h"

#include <string.h>

#include "memzero.h"

/* keccak256("transfer(address,uint256)")[0:4] */
static const uint8_t SEL_TRANSFER[4] = {0xa9, 0x05, 0x9c, 0xbb};
/* keccak256("approve(address,uint256)")[0:4] */
static const uint8_t SEL_APPROVE[4]  = {0x09, 0x5e, 0xa7, 0xb3};

/* selector + two 32-byte words. Exactly this, not "at least": trailing bytes
 * mean the host encoded something the device is not reading. */
#define ABI_CALL_LEN (4 + 32 + 32)

/* An ABI address is left-padded to 32 bytes. Non-zero padding is not an
 * address, and accepting it would let a host smuggle bytes past the screen. */
static bool word_is_address(const uint8_t word[32])
{
    for (int i = 0; i < 12; i++) {
        if (word[i] != 0) {
            return false;
        }
    }
    return true;
}

/* Treat anything from 2^255 up as unlimited.
 *
 * Not just 2^256-1: the other common max is 2^255-1, and several token UIs
 * emit values in between. All of them are far beyond any real supply, so the
 * user needs the same warning for each. */
static bool amount_is_unlimited(const uint8_t word[32])
{
    return (word[0] & 0x80) != 0;
}

EthCallKind eth_decode_call(const uint8_t *data, size_t len, EthCall *out)
{
    EthCall call;
    memzero(&call, sizeof(call));

    if (len == 0) {
        call.kind = ETH_CALL_EMPTY;
        goto done;
    }

    call.kind = ETH_CALL_UNKNOWN;

    if (!data || len != ABI_CALL_LEN) {
        goto done;
    }

    EthCallKind kind;
    if (memcmp(data, SEL_TRANSFER, sizeof(SEL_TRANSFER)) == 0) {
        kind = ETH_CALL_ERC20_TRANSFER;
    } else if (memcmp(data, SEL_APPROVE, sizeof(SEL_APPROVE)) == 0) {
        kind = ETH_CALL_ERC20_APPROVE;
    } else {
        goto done;
    }

    const uint8_t *arg0 = data + 4;
    const uint8_t *arg1 = data + 4 + 32;

    if (!word_is_address(arg0)) {
        goto done;
    }

    memcpy(call.address, arg0 + 12, sizeof(call.address));
    if (!eth_quantity_set(&call.amount, arg1, 32)) {
        goto done;
    }

    call.unlimited = (kind == ETH_CALL_ERC20_APPROVE) && amount_is_unlimited(arg1);
    call.kind = kind;

done:
    if (out) {
        *out = call;
    }
    return call.kind;
}

const char *eth_call_name(EthCallKind kind)
{
    switch (kind) {
        case ETH_CALL_EMPTY:           return "transfer";
        case ETH_CALL_ERC20_TRANSFER:  return "token transfer";
        case ETH_CALL_ERC20_APPROVE:   return "token approval";
        default:                       return "unknown call";
    }
}

bool eth_tx_is_decodable(const EthTx *tx, EthCall *out)
{
    EthCall call;
    memzero(&call, sizeof(call));

    if (!tx) {
        if (out) *out = call;
        return false;
    }

    /* Contract creation has no recipient to name and no code the device can
     * describe. Refusing it costs a use case nobody has asked for. */
    if (!tx->has_to) {
        call.kind = ETH_CALL_UNKNOWN;
        if (out) *out = call;
        return false;
    }

    EthCallKind kind = eth_decode_call(tx->data, tx->data_length, &call);
    if (out) {
        *out = call;
    }
    return kind != ETH_CALL_UNKNOWN;
}
