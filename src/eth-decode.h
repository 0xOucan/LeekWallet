/**
 * Calldata decoding — the decodable set (T50).
 *
 * A hardware wallet that renders a hash and asks for a signature is asking the
 * user to approve something they cannot read. The answer is not a better hash
 * display; it is to refuse. This module defines exactly what the device can
 * explain in words, and everything outside that set is rejected before the
 * confirmation screen is ever shown — unless the owner has turned blind
 * signing on at the device itself (T16, see blind-signing.h), which is the one
 * documented way past this gate and is off until they do.
 *
 * The set today:
 *   - no calldata at all, a native transfer
 *   - ERC-20 transfer(address,uint256)
 *   - ERC-20 approve(address,uint256)
 *   - ERC-20 transferFrom(address,address,uint256)
 *   - ERC-721/1155 setApprovalForAll(address,bool)
 *   - WETH deposit() and withdraw(uint256)
 *   - mint(address,uint256), mint(uint256) and mint(address,address,uint256),
 *     the faucet shapes
 *   - a table of further signatures decoded generically from their declared
 *     argument types (ETH_CALL_GENERIC below): Aave's supply/withdraw/borrow/
 *     repay, safeTransferFrom, Permit2's approve
 *
 * Growing it means adding a decoder AND a screen that says what the call does.
 * A selector recognised but not rendered is worse than one refused, because it
 * looks like the device understood. Every kind below has a case in ui.c's
 * sign-confirmation pages; adding one without a screen is the bug this comment
 * exists to prevent.
 *
 * Every selector this file matches is computed at match time as
 * keccak256(signature)[0:4] over the signature string in the table, and the
 * comparison against the selector on the wire is the only way an entry can be
 * chosen. There is no stored hex to be wrong: a signature string that has been
 * mistyped, corrupted in flash or swapped by an attacker hashes to a different
 * four bytes and simply stops matching, so the table certifies itself and the
 * device needs to trust neither the host nor a signed descriptor for it. That
 * property is why the check lives in the matching path rather than in an
 * assertion — an assertion can be compiled out, and this must not be.
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
    ETH_CALL_ERC20_TRANSFER_FROM, /* transferFrom(address from, address to,
                                   * uint256 amount) — spends an allowance */
    ETH_CALL_SET_APPROVAL_ALL, /* setApprovalForAll(address operator, bool) */
    ETH_CALL_WETH_DEPOSIT,     /* deposit() — wrap the attached ether */
    ETH_CALL_WETH_WITHDRAW,    /* withdraw(uint256) — unwrap */
    ETH_CALL_MINT_TO,          /* mint(address to, uint256 amount) */
    ETH_CALL_MINT_TOKEN_TO,    /* mint(address token, address to, uint256) —
                                * the shape Aave's testnet faucet uses. Same
                                * argument layout as transferFrom and a wholly
                                * different meaning, which is why the decoder
                                * matches on the selector and never the length */
    ETH_CALL_MINT,             /* mint(uint256 amount) */
    ETH_CALL_GENERIC,          /* a signature from the table, decoded from its
                                * own declared argument types. Proves what the
                                * function is NAMED and what it was PASSED —
                                * never what it does; see EthCall::entry */
    ETH_CALL_UNKNOWN           /* not in the decodable set — refuse it */
} EthCallKind;

/* The static ABI types a generic argument may have. Deliberately only the ones
 * that occupy exactly one 32-byte word: a dynamic type (`bytes`, `string`, any
 * array, any tuple) is an offset into a tail the device would then have to
 * bounds-check and lay out, and half-reading one is how a call gets displayed
 * as something other than what it is. A signature containing one is refused —
 * see eth_decode_call(). */
typedef enum {
    ETH_ARG_ADDRESS = 0,
    ETH_ARG_UINT,     /* uint<bits>  */
    ETH_ARG_INT,      /* int<bits>   */
    ETH_ARG_BOOL,
    ETH_ARG_BYTESN    /* bytes<bits/8>, left-aligned in the word */
} EthArgType;

/* Six is Aave's `borrow` plus room, and it bounds this struct — which is a
 * local on the protocol task's stack — rather than being a limit anyone wants.
 * A signature with more arguments is refused rather than truncated. */
#define ETH_MAX_ARGS 6

/* Kept deliberately tiny: type, width and where the word is, no copy of the
 * word itself and no copy of the name. The values are read back out of the
 * caller's calldata through eth_arg_* below, which costs nothing on a task
 * stack that has already overflowed once this project. */
typedef struct {
    uint8_t  type;    /* EthArgType */
    uint8_t  bits;    /* uint/int width in bits; bytesN width in bits too */
    uint16_t offset;  /* byte offset of this argument's word in the calldata */
} EthArg;

/* Opaque to callers: the table row that matched, carried so the name and the
 * argument names can be read back without a second copy. Points into rodata
 * and so outlives every EthCall. */
typedef struct EthAbiEntry EthAbiEntry;

typedef struct {
    EthCallKind kind;
    /* The first address argument: recipient for transfer, spender for approve,
     * source for transferFrom, operator for setApprovalForAll. Zero when the
     * call takes no address. */
    uint8_t     address[20];
    /* The second address, only for transferFrom's destination. `has_second`
     * says whether it means anything, so a screen can never print a zero
     * address as if it were an argument. */
    uint8_t     second[20];
    bool        has_second;
    EthQuantity amount;        /* raw token units — decimals are not knowable
                                * on-device, see eth_decode_call() */
    bool        has_amount;    /* false for deposit()/setApprovalForAll */
    bool        unlimited;     /* approve only: an allowance nobody can spend
                                * through in practice, which is the pattern
                                * behind most drain incidents */
    bool        flag;          /* setApprovalForAll's bool: true grants, false
                                * revokes. Only meaningful for that kind. */

    /* ETH_CALL_GENERIC only. `entry` is the row whose signature hashed to the
     * selector on the wire, and `args` describes the words that followed it. */
    const EthAbiEntry *entry;
    EthArg      args[ETH_MAX_ARGS];
    uint8_t     arg_count;
} EthCall;

/**
 * Decode `len` bytes of calldata.
 *
 * Returns the kind, also written to *out. Anything malformed — a short
 * argument block, trailing bytes, a padded address whose high 12 bytes are not
 * zero, a bool that is neither 0 nor 1 — is ETH_CALL_UNKNOWN rather than a best
 * guess. A best guess here is a lie told to someone about to sign.
 *
 * Token amounts are raw units. The device cannot call decimals() on the
 * contract, so it must not imply a scale it does not know; the screen says so.
 */
EthCallKind eth_decode_call(const uint8_t *data, size_t len, EthCall *out);

/** Short human label for a kind, for logs and screens. */
const char *eth_call_name(EthCallKind kind);

/* ------------------------------------------------- generic calls (T12c) */

/**
 * The function name of a generic call, without its parenthesised types, into
 * `out`. Empty string when the call is not generic.
 *
 * The name comes from the same string that was hashed to match the selector,
 * so it cannot name one function while the device signs another — the two are
 * the same bytes. What it does NOT prove is behaviour: a contract is free to
 * call a drain `supply`, and every screen built on this must say so.
 */
void eth_call_function_name(const EthCall *call, char *out, size_t out_size);

/** The declared parameter name of argument `i` ("onBehalfOf"), or "" . */
void eth_call_arg_name(const EthCall *call, int i, char *out, size_t out_size);

/** The 32-byte word of argument `i`, read out of the same calldata that was
 *  decoded. NULL if `i` is out of range or `data` is too short. */
const uint8_t *eth_arg_word(const EthCall *call, const uint8_t *data,
                            size_t len, int i);

/** Argument `i` as an address. False unless it is one. */
bool eth_arg_address(const EthCall *call, const uint8_t *data, size_t len,
                     int i, uint8_t out[20]);

/** Argument `i` as a quantity, for eth_format_integer(). False unless it is a
 *  uint/int/bytesN — i.e. something with a number to print. */
bool eth_arg_quantity(const EthCall *call, const uint8_t *data, size_t len,
                      int i, EthQuantity *out);

/**
 * Whether argument `i` is an allowance nobody can spend through in practice —
 * the top bit of its own declared width set.
 *
 * Declared width, not 256 bits: Permit2's amount is a uint160 and its
 * "infinite" is 2^160-1, which is a perfectly ordinary number in 256 bits.
 * Narrow fields (under 64 bits) are never called unlimited, for the same
 * reason eip712.c does not: a uint48 deadline with its top bit set is a date,
 * not an infinity.
 */
bool eth_arg_unlimited(const EthCall *call, const uint8_t *data, size_t len,
                       int i);

/**
 * Enumerate the table: false once `i` is past the end.
 *
 * Exported so the host suite can hash every signature itself and confirm the
 * decoder accepts a call built from that hash and refuses one built from the
 * hash of a signature altered by a single character. That is the property the
 * table rests on, and a property nothing measures is a property nobody has.
 */
bool eth_decode_table_entry(size_t i, const char **sig, const char **names);

/**
 * Whether a transaction as a whole can be shown honestly and so may be signed.
 *
 * Contract creation is refused too: there is nothing to name, and the device
 * cannot tell the user what code they are deploying. That refusal is not
 * reachable by the blind-signing setting either — see blind-signing.h.
 */
bool eth_tx_is_decodable(const EthTx *tx, EthCall *out);

#endif /* ETH_DECODE_H */
