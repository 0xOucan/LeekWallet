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
 *   - Aqua's ship() and dock(), each with its own decoder because each has
 *     dynamic arguments the generic path refuses on principle
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
    ETH_CALL_AQUA_SHIP,        /* Aqua ship(address app, bytes strategy,
                                * address[] tokens, uint256[] amounts) */
    /* ATS issuance through LeekSecurityFactory. Two strings and nothing else,
     * which is the entire reason these are drawable: the factory freezes the
     * 3,748-byte template on chain, so the only values that vary are the two
     * on the screen. See src/LeekSecurityFactory.sol. */
    ETH_CALL_ATS_DEPLOY_EQUITY, /* deployEquity(string name, string symbol) */
    ETH_CALL_ATS_DEPLOY_BOND,   /* deployBond(string name, string symbol)   */
    ETH_CALL_AQUA_DOCK,        /* Aqua dock(address app, bytes32 strategyHash,
                                * address[] tokens) */
    ETH_CALL_UNKNOWN           /* not in the decodable set — refuse it */
} EthCallKind;

/* Aqua legs the device will draw, and therefore the most it will accept.
 *
 * One page per leg, and a page the user has to press through: a strategy with
 * more legs than this is refused rather than summarised, for the same reason a
 * seventh generic argument is. Four covers every strategy seen on chain, whose
 * tokensCount the registry itself stores in a uint8 with 0xff reserved. */
#define ETH_AQUA_MAX_LEGS 4

/* B3: SwapVM program instructions the device will draw, and therefore the
 * most it will accept before refusing the whole ship rather than summarising
 * it (docs/AQUA-B3-SPEC.md §6.5 `too-long`, §6.6 "no partial render").
 *
 * Set equal to the host's `AQUA_MAX_INSTRUCTIONS`
 * (app/packages/apps/aqua/src/program.ts) on purpose: spec §7 requires the
 * host's accepted set to be a SUBSET of the firmware's, never wider, and the
 * simplest way to keep that true on this one axis is to make the two bounds
 * identical rather than trust two numbers to stay in the right order by hand.
 * Real strategies use at most six instructions (spec §5), so both bounds have
 * the same headroom above real usage. */
/* The factory's own bounds (MAX_NAME_BYTES / MAX_SYMBOL_BYTES). Enforcing the
 * same numbers here means a call that would revert on chain is refused before
 * a press is spent on it, and the screen never has to elide. */
#define ETH_ATS_MAX_NAME   64
#define ETH_ATS_MAX_SYMBOL 12

#define ETH_AQUA_MAX_INSTRUCTIONS 16

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

    /* ---------------------------------------------------- Aqua (ship/dock)
     *
     * The two Aqua calls are the only ones in the decodable set whose
     * arguments are dynamic, so they get a bespoke decoder and these fields
     * rather than the `args` array — see aqua_decode() in eth-decode.c, and
     * the paragraph there on why "one more shape" was not the answer.
     *
     * Every offset below is a byte offset into the SAME calldata that was
     * decoded, resolved and bounds-checked once, so a renderer reads the words
     * back out of the buffer it owns instead of the decoder copying them. */
    uint8_t     aqua_app[20];      /* the Aqua app the strategy is shipped to */
    /* The maker named INSIDE the strategy struct, which is not the same thing
     * as the sender. Aqua keys its balances by msg.sender and hashes the
     * strategy without it, so a strategy naming somebody else is shipped under
     * this device's key while instructing the app about another address. The
     * screen shows both and the host refuses the mismatch; see
     * packages/apps/aqua/src/strategy.ts. */
    uint8_t     aqua_maker[20];
    bool        has_aqua_maker;
    /* ship: keccak256(strategy), computed here from the same bytes that will
     * be signed, which is what makes it comparable against the portfolio view.
     * dock: the strategyHash argument, verbatim. */
    uint8_t     aqua_hash[32];
    uint8_t     aqua_legs;
    uint16_t    aqua_token_off[ETH_AQUA_MAX_LEGS];
    /* ship only. Meaningless when the kind is ETH_CALL_AQUA_DOCK, which takes
     * no amounts: docking returns whatever is there. */
    uint16_t    aqua_amount_off[ETH_AQUA_MAX_LEGS];
    bool        has_aqua_amounts;

    /* ------------------------------------------------- SwapVM program (B3)
     *
     * Only populated for a ship whose `app` is the pinned SwapVM router
     * (AQUA_SWAPVM_ROUTER, aqua-swapvm.h) -- for every other app this stays
     * false/zero and the ship is drawn exactly as it was before B3 (spec
     * §6.6: refusing every non-SwapVM app would break a working flow for no
     * safety gain). When the app IS the router, aqua_decode_ship() walks the
     * program with the same closed opcode table program.ts uses and REFUSES
     * THE WHOLE SHIP (returns false, so the call becomes ETH_CALL_UNKNOWN) if
     * any instruction is not fully understood -- there is no separate
     * "program-refused-but-legs-shown" state, because that would be exactly
     * the partial render spec §6.6 forbids. */
    bool        aqua_is_swapvm;
    uint8_t     aqua_instr_count;
    /* Byte offset of each instruction's opcode byte within the SAME calldata
     * buffer as aqua_token_off[] -- no allocation, no copy of the program. A
     * renderer reads the opcode and its args back out of that buffer with
     * aqua_instr_field(). */
    uint16_t    aqua_instr_off[ETH_AQUA_MAX_INSTRUCTIONS];

    /* ------------------------------------------- ATS issuance (two strings)
     *
     * Byte offsets into the SAME calldata buffer, like the Aqua fields above:
     * the decoder resolves and bounds-checks them once and the renderer reads
     * the bytes back out, so nothing is copied twice and there is one source
     * of truth for what was signed.
     *
     * Both strings are validated at decode time to be printable ASCII within
     * the bounds the factory itself enforces (64 and 12). That is stricter
     * than "it is a valid ABI string" on purpose, twice over: a name carrying
     * control characters, or right-to-left overrides, or an empty run of
     * padding, is a name that does not read on screen the way it reads in the
     * calldata -- and that is the whole attack against a device whose only job
     * is to show you what you are signing. A string this device cannot draw
     * faithfully is refused, not truncated. */
    uint16_t    ats_name_off;
    uint8_t     ats_name_len;
    uint16_t    ats_symbol_off;
    uint8_t     ats_symbol_len;
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

/* ------------------------------------------------------- ATS issuance */

/** Which of the two strings an ATS deploy call carries. */
typedef enum { ETH_ATS_NAME = 0, ETH_ATS_SYMBOL } EthAtsString;

/**
 * Copy `which` string out of `data` into `out` as a NUL-terminated C string.
 *
 * Re-bounds-checked against the caller's length, exactly as eth_aqua_token()
 * is and for the same reason: this runs at render time from a buffer the
 * renderer owns, and decode time and render time have been out of step before.
 *
 * Returns false — and writes an empty string — when the call is not an ATS
 * deploy, when the offsets do not fit `len`, or when `out_size` cannot hold
 * the string and its terminator. A renderer that gets false must print that it
 * is unavailable rather than print nothing, or the screen quietly loses a
 * field that was signed.
 */
bool eth_ats_string(const EthCall *call, const uint8_t *data, size_t len,
                    EthAtsString which, char *out, size_t out_size);

/* ------------------------------------------------------------ Aqua (Q2) */

/**
 * Argument `i`'s token address for an Aqua call, read back out of `data`.
 *
 * Re-bounds-checked against the caller's length for the same reason
 * eth_arg_word() is: this runs at render time, from a buffer the renderer
 * owns, and the two have been out of step before.
 */
bool eth_aqua_token(const EthCall *call, const uint8_t *data, size_t len,
                    int i, uint8_t out[20]);

/** Leg `i`'s amount. False for a dock, which has no amounts. */
bool eth_aqua_amount(const EthCall *call, const uint8_t *data, size_t len,
                     int i, EthQuantity *out);

/**
 * The name of SwapVM program instruction `i` ("deadline", "xycSwapXD", ...),
 * into `out`. Empty string if `i` is out of range or the opcode byte at
 * `data[call->aqua_instr_off[i]]` no longer matches one of the eleven this
 * device draws -- re-read from `data` rather than cached at decode time, for
 * the same reason every other `eth_arg_*`/`eth_aqua_*` accessor is (see
 * eth_arg_word()). Only meaningful when `call->aqua_is_swapvm` is true.
 */
void eth_aqua_instr_name(const EthCall *call, const uint8_t *data, size_t len,
                         int i, char *out, size_t out_size);

/**
 * Instruction `i`'s one headline figure, formatted for a screen: a
 * `uint40`/`uint32`/`uint16` as a decimal integer (deadline,
 * flatFeeAmountInXD -- raw, against a 1e9 = 100% base, never "bps" -- and
 * decayXD), an address (the two non-zero balance guards), or the empty string
 * for an opcode with no single figure worth a dedicated page (xycSwapXD,
 * salt, the two Gte guards, xycConcentrateGrowLiquidity2D,
 * peggedSwapGrowPriceRange2D -- their args are shown as raw hex instead,
 * see eth_aqua_instr_hex()). Re-reads `data`/`len` for the reason every other
 * `eth_arg_*`/`eth_aqua_*` accessor does: this runs at render time against a
 * buffer the renderer owns.
 */
bool eth_aqua_instr_value(const EthCall *call, const uint8_t *data, size_t len,
                          int i, char *out, size_t out_size);

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
