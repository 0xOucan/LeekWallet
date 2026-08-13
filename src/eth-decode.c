/**
 * Calldata decoding - see eth-decode.h
 */

#include "eth-decode.h"

#include <string.h>

#include "memzero.h"

/* Every selector is keccak256(signature)[0:4]. They are written out rather
 * than computed because the device has no reason to hash a constant at boot,
 * and sim/test_eth_decode.c pins each one against its signature. */

/* keccak256("transfer(address,uint256)")[0:4] */
static const uint8_t SEL_TRANSFER[4]      = {0xa9, 0x05, 0x9c, 0xbb};
/* keccak256("approve(address,uint256)")[0:4] */
static const uint8_t SEL_APPROVE[4]       = {0x09, 0x5e, 0xa7, 0xb3};
/* keccak256("transferFrom(address,address,uint256)")[0:4] */
static const uint8_t SEL_TRANSFER_FROM[4] = {0x23, 0xb8, 0x72, 0xdd};
/* keccak256("setApprovalForAll(address,bool)")[0:4] */
static const uint8_t SEL_APPROVAL_ALL[4]  = {0xa2, 0x2c, 0xb4, 0x65};
/* keccak256("deposit()")[0:4] */
static const uint8_t SEL_DEPOSIT[4]       = {0xd0, 0xe3, 0x0d, 0xb0};
/* keccak256("withdraw(uint256)")[0:4] */
static const uint8_t SEL_WITHDRAW[4]      = {0x2e, 0x1a, 0x7d, 0x4d};
/* keccak256("mint(address,uint256)")[0:4] */
static const uint8_t SEL_MINT_TO[4]       = {0x40, 0xc1, 0x0f, 0x19};
/* keccak256("mint(uint256)")[0:4] */
static const uint8_t SEL_MINT[4]          = {0xa0, 0x71, 0x2d, 0x68};

/* The argument shapes the decoder knows how to read. Each kind names exactly
 * how many 32-byte words follow the selector and what they mean, and the
 * length check below is on that total and nothing else: trailing bytes mean
 * the host encoded something the device is not reading. */
typedef enum {
    ARGS_NONE = 0,      /* deposit()                                    */
    ARGS_ADDR_UINT,     /* transfer / approve / mint(address,uint256)   */
    ARGS_ADDR_ADDR_UINT,/* transferFrom                                 */
    ARGS_ADDR_BOOL,     /* setApprovalForAll                            */
    ARGS_UINT           /* withdraw(uint256) / mint(uint256)            */
} ArgShape;

typedef struct {
    const uint8_t *selector;
    EthCallKind    kind;
    ArgShape       shape;
} KnownCall;

static const KnownCall KNOWN[] = {
    { SEL_TRANSFER,      ETH_CALL_ERC20_TRANSFER,      ARGS_ADDR_UINT      },
    { SEL_APPROVE,       ETH_CALL_ERC20_APPROVE,       ARGS_ADDR_UINT      },
    { SEL_TRANSFER_FROM, ETH_CALL_ERC20_TRANSFER_FROM, ARGS_ADDR_ADDR_UINT },
    { SEL_APPROVAL_ALL,  ETH_CALL_SET_APPROVAL_ALL,    ARGS_ADDR_BOOL      },
    { SEL_DEPOSIT,       ETH_CALL_WETH_DEPOSIT,        ARGS_NONE           },
    { SEL_WITHDRAW,      ETH_CALL_WETH_WITHDRAW,       ARGS_UINT           },
    { SEL_MINT_TO,       ETH_CALL_MINT_TO,             ARGS_ADDR_UINT      },
    { SEL_MINT,          ETH_CALL_MINT,                ARGS_UINT           },
};
#define KNOWN_COUNT (sizeof(KNOWN) / sizeof(KNOWN[0]))

static size_t shape_word_count(ArgShape shape)
{
    switch (shape) {
        case ARGS_NONE:           return 0;
        case ARGS_UINT:           return 1;
        case ARGS_ADDR_UINT:      return 2;
        case ARGS_ADDR_BOOL:      return 2;
        case ARGS_ADDR_ADDR_UINT: return 3;
        default:                  return 0;
    }
}

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

/* An ABI bool is 0 or 1 and nothing else. Anything else is a word the device
 * would have to render as "true-ish", and there is no honest way to draw that:
 * a contract may well read the raw word rather than the canonical bool. */
static bool word_is_bool(const uint8_t word[32], bool *out)
{
    for (int i = 0; i < 31; i++) {
        if (word[i] != 0) {
            return false;
        }
    }
    if (word[31] > 1) {
        return false;
    }
    *out = (word[31] == 1);
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

    if (!data || len < 4) {
        goto done;
    }

    const KnownCall *known = NULL;
    for (size_t i = 0; i < KNOWN_COUNT; i++) {
        if (memcmp(data, KNOWN[i].selector, 4) == 0) {
            known = &KNOWN[i];
            break;
        }
    }
    if (!known) {
        goto done;
    }

    /* Exact, not "at least". A recognised selector with anything extra behind
     * it is a call the device is only half reading. */
    size_t words = shape_word_count(known->shape);
    if (len != 4 + words * 32) {
        goto done;
    }

    const uint8_t *w0 = data + 4;
    const uint8_t *w1 = data + 4 + 32;
    const uint8_t *w2 = data + 4 + 64;

    switch (known->shape) {
        case ARGS_NONE:
            break;

        case ARGS_UINT:
            if (!eth_quantity_set(&call.amount, w0, 32)) goto done;
            call.has_amount = true;
            break;

        case ARGS_ADDR_UINT:
            if (!word_is_address(w0)) goto done;
            memcpy(call.address, w0 + 12, sizeof(call.address));
            if (!eth_quantity_set(&call.amount, w1, 32)) goto done;
            call.has_amount = true;
            /* Only an allowance can be unlimited. A transfer of 2^255 tokens
             * is absurd but it is still a specific number, and calling it
             * "unlimited" would describe the wrong risk. */
            call.unlimited = (known->kind == ETH_CALL_ERC20_APPROVE) &&
                             amount_is_unlimited(w1);
            break;

        case ARGS_ADDR_BOOL:
            if (!word_is_address(w0)) goto done;
            memcpy(call.address, w0 + 12, sizeof(call.address));
            if (!word_is_bool(w1, &call.flag)) goto done;
            break;

        case ARGS_ADDR_ADDR_UINT:
            if (!word_is_address(w0) || !word_is_address(w1)) goto done;
            memcpy(call.address, w0 + 12, sizeof(call.address));
            memcpy(call.second,  w1 + 12, sizeof(call.second));
            call.has_second = true;
            if (!eth_quantity_set(&call.amount, w2, 32)) goto done;
            call.has_amount = true;
            break;

        default:
            goto done;
    }

    call.kind = known->kind;

done:
    if (out) {
        *out = call;
    }
    return call.kind;
}

const char *eth_call_name(EthCallKind kind)
{
    switch (kind) {
        case ETH_CALL_EMPTY:                return "transfer";
        case ETH_CALL_ERC20_TRANSFER:       return "token transfer";
        case ETH_CALL_ERC20_APPROVE:        return "token approval";
        case ETH_CALL_ERC20_TRANSFER_FROM:  return "token transferFrom";
        case ETH_CALL_SET_APPROVAL_ALL:     return "approval for all";
        case ETH_CALL_WETH_DEPOSIT:         return "wrap";
        case ETH_CALL_WETH_WITHDRAW:        return "unwrap";
        case ETH_CALL_MINT_TO:              return "mint to";
        case ETH_CALL_MINT:                 return "mint";
        default:                            return "unknown call";
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
     * describe. Refusing it costs a use case nobody has asked for.
     *
     * Deliberately checked before the calldata: this is not the case blind
     * signing reopens. A blind confirmation is honest only because it can
     * still name who is being paid; with no recipient there is nothing true
     * left to put on the screen (PROTOCOL.md 6bis). */
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
