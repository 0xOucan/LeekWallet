/**
 * Calldata decoding - see eth-decode.h
 */

#include "eth-decode.h"

#include <stdio.h>
#include <string.h>

#include "memzero.h"
#include "sha3.h"

/* The argument shapes the decoder knows how to read. Each kind names exactly
 * how many 32-byte words follow the selector and what they mean, and the
 * length check below is on that total and nothing else: trailing bytes mean
 * the host encoded something the device is not reading. */
typedef enum {
    ARGS_NONE = 0,      /* deposit()                                    */
    ARGS_ADDR_UINT,     /* transfer / approve / mint(address,uint256)   */
    ARGS_ADDR_ADDR_UINT,/* transferFrom                                 */
    ARGS_ADDR_BOOL,     /* setApprovalForAll                            */
    ARGS_UINT,          /* withdraw(uint256) / mint(uint256)            */
    ARGS_FROM_SIGNATURE,/* read the types out of `sig` itself           */
    ARGS_AQUA_SHIP,     /* Aqua ship: see aqua_decode_ship()            */
    ARGS_AQUA_DOCK,     /* Aqua dock: see aqua_decode_dock()            */
    ARGS_TWO_STRINGS,   /* ATS deployEquity/deployBond: ats_decode()     */
    ARGS_DISPERSE       /* disperseToken: disperse_decode_token()        */
} ArgShape;

/* One row of the table.
 *
 * `sig` is the canonical ABI signature — no parameter names, no spaces — and
 * is the ONLY thing a selector is ever derived from, at match time, by
 * hashing. `names` are the human names of those same parameters in the same
 * order, used for nothing but labelling a screen: they sit outside the hash by
 * construction, so a wrong name can mislabel a page but can never make the
 * device decode a call it was not given. The types can, which is exactly why
 * they live in the half keccak covers.
 *
 * A row whose `names` do not match its arity is a bug the host suite catches
 * (test_signature_table_is_well_formed) rather than a runtime concern. */
struct EthAbiEntry {
    const char *sig;
    const char *names;
    EthCallKind kind;
    ArgShape    shape;
};

static const struct EthAbiEntry KNOWN[] = {
    /* The kinds that predate the generic path. They keep their bespoke shapes,
     * and their screens, because those screens say what the call MEANS —
     * "Approve spending", "UNLIMITED amount" — which is more than the generic
     * renderer is entitled to claim about a name it merely read. */
    { "transfer(address,uint256)",              "to,amount",
      ETH_CALL_ERC20_TRANSFER,      ARGS_ADDR_UINT      },
    { "approve(address,uint256)",               "spender,amount",
      ETH_CALL_ERC20_APPROVE,       ARGS_ADDR_UINT      },
    { "transferFrom(address,address,uint256)",  "from,to,amount",
      ETH_CALL_ERC20_TRANSFER_FROM, ARGS_ADDR_ADDR_UINT },
    { "setApprovalForAll(address,bool)",        "operator,approved",
      ETH_CALL_SET_APPROVAL_ALL,    ARGS_ADDR_BOOL      },
    { "deposit()",                              "",
      ETH_CALL_WETH_DEPOSIT,        ARGS_NONE           },
    { "withdraw(uint256)",                      "amount",
      ETH_CALL_WETH_WITHDRAW,       ARGS_UINT           },
    { "mint(address,uint256)",                  "to,amount",
      ETH_CALL_MINT_TO,             ARGS_ADDR_UINT      },
    { "mint(uint256)",                          "amount",
      ETH_CALL_MINT,                ARGS_UINT           },
    { "mint(address,address,uint256)",          "token,to,amount",
      ETH_CALL_MINT_TOKEN_TO,       ARGS_ADDR_ADDR_UINT },

    /* Decoded from their own declared types. The batch is chosen for what it
     * unblocks and for what it exposes: the four Aave V3 entry points are the
     * main action of essentially every lending flow, and until this landed the
     * device refused all of them while happily signing the two approvals that
     * make them dangerous — the worst possible half of that pair to
     * understand. */
    { "supply(address,uint256,address,uint16)", "asset,amount,onBehalfOf,referral",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    { "withdraw(address,uint256,address)",      "asset,amount,to",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    { "borrow(address,uint256,uint256,uint16,address)",
      "asset,amount,rateMode,referral,onBehalfOf",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    { "repay(address,uint256,uint256,address)", "asset,amount,rateMode,onBehalfOf",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    /* ERC-721's safe transfer. The three-argument overload only: the
     * four-argument one ends in `bytes`, which this decoder does not read. */
    { "safeTransferFrom(address,address,uint256)", "from,to,tokenId",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    /* Permit2. The same English word as ERC-20's approve and a different
     * function entirely: different arity, different selector, and an expiry
     * the ERC-20 one has no concept of. */
    { "approve(address,address,uint160,uint48)", "token,spender,amount,expiration",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },

    /* Aqua. Both signatures carry dynamic arguments, which the generic path
     * refuses on principle, so each gets a hand-written decoder — see
     * aqua_decode_ship() and aqua_decode_dock(). They are in this table anyway
     * because the table is what derives selectors by hashing, and a selector
     * written down anywhere else would be a constant nothing checks.
     *
     * Why these two and not "dynamic arguments in general": a general decoder
     * for `bytes` and arrays would have to lay out an arbitrary tail chosen by
     * the host, and every offset it followed would be one more place to be
     * quietly wrong on a screen somebody is about to trust. These two layouts
     * are fixed, short, and checked against the canonical encoding exactly;
     * anything that is merely a valid ABI encoding of the same values, but not
     * the canonical one, is refused rather than normalised. */
    { "ship(address,bytes,address[],uint256[])", "app,strategy,tokens,amounts",
      ETH_CALL_AQUA_SHIP, ARGS_AQUA_SHIP },
    { "dock(address,bytes32,address[])",         "app,strategyHash,tokens",
      ETH_CALL_AQUA_DOCK, ARGS_AQUA_DOCK },

    /* The ATS escrow market's three calls.
     *
     * Every argument is static, so the generic signature path reads them and
     * the screen draws one page each -- no bespoke decoder, unlike Aqua's or
     * the issuance above. They are here because without them the DEVICE
     * refuses a fill outright ("cannot display this request"), which is the
     * correct behaviour for a call it cannot read and a dead end for a market
     * meant to be used from the wallet. A host-side ERC-7730 descriptor does
     * not help: it satisfies the companion's own gate, and the device still
     * has to decode what it is being asked to sign.
     *
     * `fill` is the one that moves value: it carries HBAR in the transaction
     * value, and the amount page for that comes from the transaction itself,
     * not from these arguments. */
    { "fill(uint256)",                   "listingId",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    { "cancel(uint256)",                 "listingId",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },
    { "list(address,uint256,uint256)",   "security,amount,priceTotal",
      ETH_CALL_GENERIC, ARGS_FROM_SIGNATURE },

    /* ATS issuance, through LeekSecurityFactory.
     *
     * `string` is a dynamic type, so the generic path refuses these on the
     * same principle it refuses every dynamic signature, and they get a
     * hand-written decoder for the same reason Aqua's two did.
     *
     * What makes these safe to draw where the ATS factory's own
     * `deployEquity` is not: that one takes a seventeen-field nested struct
     * and 3,748 bytes of calldata, far past ETH_MAX_DATA and far past what a
     * 240x240 screen can put in front of a person honestly. The wrapper
     * freezes that whole template in verified on-chain code, so these two
     * strings are the complete set of things that vary. The screen showing
     * name and symbol is therefore showing ALL of the decision, not a summary
     * of it -- which is the only condition under which drawing a call is not
     * a polite form of blind signing. */
    { "deployEquity(string,string)", "name,symbol",
      ETH_CALL_ATS_DEPLOY_EQUITY, ARGS_TWO_STRINGS },
    { "deployBond(string,string)",   "name,symbol",
      ETH_CALL_ATS_DEPLOY_BOND,   ARGS_TWO_STRINGS },

    /* Disperse: many ERC-20 transfers in one transaction.
     *
     * Two dynamic arrays, so the generic path refuses it and it gets a
     * hand-written decoder like Aqua's ship. What makes it drawable is that
     * the arrays are the WHOLE payload: a recipient and an amount each, and
     * the device draws one page per pair. There is nothing summarised.
     *
     * This is the one place a device screen can drift furthest from what a
     * user believes: a batch is easy to read as "one payment" when it is nine.
     * The page count is therefore the recipient count, never a total. */
    { "disperseToken(address,address[],uint256[])", "token,recipients,values",
      ETH_CALL_DISPERSE_TOKEN, ARGS_DISPERSE },
};
#define KNOWN_COUNT (sizeof(KNOWN) / sizeof(KNOWN[0]))

/**
 * Does keccak256(entry->sig)[0:4] equal the four bytes about to be signed?
 *
 * This is the whole security argument for the table, so it is a function on
 * the matching path rather than an assertion beside it — an assertion can be
 * compiled out and this must not be. Nothing else selects a row. A signature
 * string that is wrong in any way (a mistyped type, a bit flipped in flash, a
 * hostile edit to the binary) hashes somewhere else, matches nothing, and the
 * call falls through to the refusal. There is therefore no trusted party
 * behind the mapping: not the host, not a signed descriptor, not whoever typed
 * the table.
 */
static bool signature_matches(const struct EthAbiEntry *entry,
                              const uint8_t selector[4])
{
    uint8_t digest[32];
    keccak_256((const uint8_t *)entry->sig, strlen(entry->sig), digest);
    bool ok = memcmp(digest, selector, 4) == 0;
    memzero(digest, sizeof(digest));
    return ok;
}

/* The span of the signature before '(' — the function's name. */
static size_t signature_name_length(const char *sig)
{
    const char *paren = strchr(sig, '(');
    return paren ? (size_t)(paren - sig) : strlen(sig);
}

/* Parse one ABI type name into an argument descriptor.
 *
 * Only the types that occupy exactly one word are accepted. `bytes`, `string`,
 * arrays and tuples are each an offset into a tail, and reading one means
 * bounds-checking a layout the host chose; that is where a decoder starts
 * showing something other than what will execute, so they are refused here and
 * the whole call goes back to being undecodable. */
static bool parse_arg_type(const char *type, size_t len, EthArg *out)
{
    /* Bit widths are parsed rather than pattern-matched so `uint7` or
     * `uint264` cannot slip through as something the validator then reads with
     * the wrong mask. */
    size_t i = 0;
    unsigned bits = 0;

    if (len == 7 && memcmp(type, "address", 7) == 0) {
        out->type = ETH_ARG_ADDRESS;
        out->bits = 160;
        return true;
    }
    if (len == 4 && memcmp(type, "bool", 4) == 0) {
        out->type = ETH_ARG_BOOL;
        out->bits = 8;
        return true;
    }

    if (len > 4 && memcmp(type, "uint", 4) == 0) {
        out->type = ETH_ARG_UINT;
        i = 4;
    } else if (len > 3 && memcmp(type, "int", 3) == 0) {
        out->type = ETH_ARG_INT;
        i = 3;
    } else if (len > 5 && memcmp(type, "bytes", 5) == 0) {
        out->type = ETH_ARG_BYTESN;
        i = 5;
    } else {
        return false;
    }

    for (; i < len; i++) {
        if (type[i] < '0' || type[i] > '9') {
            return false;
        }
        bits = bits * 10 + (unsigned)(type[i] - '0');
        if (bits > 256) {
            return false;
        }
    }

    if (out->type == ETH_ARG_BYTESN) {
        /* bytesN counts bytes; everything downstream speaks bits. */
        if (bits < 1 || bits > 32) {
            return false;
        }
        bits *= 8;
    } else {
        if (bits < 8 || bits > 256 || bits % 8 != 0) {
            return false;
        }
    }
    out->bits = (uint8_t)(bits == 256 ? 0 : bits);
    /* 256 does not fit a uint8_t and 0 is not a legal width, so 0 is the
     * in-band spelling of "full word". arg_bits() is the only reader. */
    return true;
}

static unsigned arg_bits(const EthArg *arg)
{
    return arg->bits == 0 ? 256u : (unsigned)arg->bits;
}

/**
 * Fill in `out->args` from the types declared in `entry->sig`.
 *
 * Returns false — meaning the whole call is refused — for a signature this
 * decoder cannot read in full. Refusing the call rather than skipping the
 * argument is the point: a page that silently omits one of five arguments is a
 * confirmation screen that lies by omission, which is the failure this module
 * exists to prevent.
 */
static bool parse_signature_args(const struct EthAbiEntry *entry, EthCall *out)
{
    const char *p = strchr(entry->sig, '(');
    if (!p) {
        return false;
    }
    p++;

    out->arg_count = 0;
    if (*p == ')') {
        return p[1] == '\0';
    }

    for (;;) {
        const char *start = p;
        while (*p && *p != ',' && *p != ')') {
            p++;
        }
        if (*p == '\0') {
            return false;
        }
        if (out->arg_count >= ETH_MAX_ARGS) {
            return false;
        }

        EthArg *arg = &out->args[out->arg_count];
        if (!parse_arg_type(start, (size_t)(p - start), arg)) {
            return false;
        }
        arg->offset = (uint16_t)(4 + out->arg_count * 32);
        out->arg_count++;

        if (*p == ')') {
            return p[1] == '\0';
        }
        p++;
    }
}

static size_t shape_word_count(ArgShape shape)
{
    switch (shape) {
        case ARGS_NONE:           return 0;
        case ARGS_UINT:           return 1;
        case ARGS_ADDR_UINT:      return 2;
        case ARGS_ADDR_BOOL:      return 2;
        case ARGS_ADDR_ADDR_UINT: return 3;
        default:                  return 0;   /* ARGS_FROM_SIGNATURE counts
                                               * its own; see the decoder */
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

/* Is this word a legal encoding of the declared type?
 *
 * Every one of these checks is the same check in a different costume: the bits
 * outside the declared width must be exactly what the ABI says they are,
 * because anything else is a word the device would have to render as one value
 * while the contract reads it as another.
 *
 * address and bool defer to the checks the older decoders already use rather
 * than repeating them. Two spellings of "is this a bool" is two places for the
 * answer to drift, and the drift would be invisible: both would still refuse
 * the obvious cases. */
static bool word_matches_type(const EthArg *arg, const uint8_t word[32])
{
    unsigned bits = arg_bits(arg);
    size_t   used = bits / 8;

    switch ((EthArgType)arg->type) {
        case ETH_ARG_ADDRESS:
            return word_is_address(word);

        case ETH_ARG_BOOL: {
            bool ignored;
            return word_is_bool(word, &ignored);
        }

        case ETH_ARG_UINT:
            for (size_t i = 0; i < 32 - used; i++) {
                if (word[i] != 0) return false;
            }
            return true;

        case ETH_ARG_INT: {
            /* Sign-extended, so the padding is all zeros or all ones and which
             * one is decided by the top bit of the value itself. */
            uint8_t fill = (word[32 - used] & 0x80) ? 0xFF : 0x00;
            for (size_t i = 0; i < 32 - used; i++) {
                if (word[i] != fill) return false;
            }
            return true;
        }

        case ETH_ARG_BYTESN:
            /* Left-aligned: the padding is at the other end. */
            for (size_t i = used; i < 32; i++) {
                if (word[i] != 0) return false;
            }
            return true;

        default:
            return false;
    }
}

/* ------------------------------------------------------------ Aqua (Q2)
 *
 * Aqua's ship() and dock() are the first calls in the decodable set with
 * dynamic arguments, and they are decoded here by hand rather than by teaching
 * parse_signature_args() about `bytes` and `T[]`.
 *
 * That was the tempting shortcut and it is the wrong one. A general dynamic
 * decoder has to follow offsets the host chose, into a tail whose shape it
 * cannot predict, and every offset it follows is another chance to draw one
 * value while the contract executes another. The two layouts below are fixed
 * and short, so they are checked against the CANONICAL encoding exactly: each
 * head offset must be the value solc would have emitted, each element block
 * must abut the next, and the calldata must end where the last element ends.
 * An encoding that is merely legal ABI for the same arguments -- a gap between
 * arrays, a tail in a different order, trailing bytes -- is refused rather than
 * normalised, because "we read it differently than the contract will" is the
 * only failure mode that matters here, and equality with one exact layout is
 * the cheapest way to have none of it.
 *
 * Bounds are checked before every read and computed in size_t from words that
 * have first been proved to fit, so nothing below can wrap.
 */

/* A 32-byte word as a length or offset, refusing anything that could not be a
 * real one. `limit` is the argument block's length: an offset past it is not a
 * large number to clamp, it is a malformed call. */
static bool word_as_size(const uint8_t word[32], size_t limit, size_t *out)
{
    for (int i = 0; i < 28; i++) {
        if (word[i] != 0) return false;
    }
    uint32_t v = ((uint32_t)word[28] << 24) | ((uint32_t)word[29] << 16) |
                 ((uint32_t)word[30] << 8)  | (uint32_t)word[31];
    if ((size_t)v > limit) return false;
    *out = (size_t)v;
    return true;
}

/* Bytes a `bytes` body of this length occupies, padded up to a word. */
static bool padded_length(size_t len, size_t limit, size_t *out)
{
    size_t padded = (len + 31u) & ~(size_t)31u;
    if (padded < len || padded > limit) return false;   /* wrapped, or absurd */
    *out = padded;
    return true;
}

/**
 * The maker named inside the strategy, and the hash of the whole thing.
 *
 * The strategy is opaque to Aqua itself -- the registry hashes it and hands it
 * to the app -- so there is no ABI here to appeal to. What every deployment
 * observed on chain has in common is that it is `abi.encode(struct)` for a
 * struct with at least one dynamic member, which puts a 0x20 head word first
 * and the struct's own first field, an address, immediately after it.
 *
 * Requiring exactly that is a real restriction and the honest one: a strategy
 * this device cannot locate a maker in is a strategy it cannot tell the user
 * whose position they are about to create, and that question is the whole
 * reason this page exists. The registry keys balances by msg.sender and hashes
 * the strategy WITHOUT the sender, so the maker named in the struct and the
 * address doing the signing are two different things a screen has to be able to
 * show side by side. Refusing is what happens when it cannot.
 */
static bool aqua_strategy_maker(const uint8_t *body, size_t len, uint8_t out[20])
{
    if (len < 64) return false;
    for (int i = 0; i < 31; i++) {
        if (body[i] != 0) return false;
    }
    if (body[31] != 0x20) return false;          /* not a dynamic tuple head */
    if (!word_is_address(body + 32)) return false;
    memcpy(out, body + 32 + 12, 20);
    return true;
}

/* ---------------------------------------------------- SwapVM program (B3)
 *
 * The pinned router this table is valid for. If the deployment's commit or
 * address ever changes, this must be re-extracted from the source actually
 * deployed before it is trusted again -- see docs/AQUA-B3-SPEC.md §3a/§11.
 * Kept as bytes, not a string to parse, for the same reason the rest of this
 * file avoids hex literals it would have to decode at runtime. */
static const uint8_t AQUA_SWAPVM_ROUTER[20] = {
    0x11, 0x11, 0x11, 0x33, 0x8c, 0x50, 0x91, 0xe8, 0x44, 0x0b,
    0x67, 0xb1, 0x68, 0xba, 0xe1, 0x6a, 0x66, 0x8a, 0xc0, 0xde,
};

/* One row of the closed opcode allowlist -- the SAME names, the SAME fixed
 * widths, as app/packages/apps/aqua/src/program.ts's OPCODES table.
 * `args_len < 0` means "any length is understood" (salt: `exec()` never reads
 * its args, so there is no field being interpreted).
 *
 * These are the DENSE INDICES the deployed AquaSwapVMRouter v1.0.2 dispatches
 * on, not the `Opcode` enum (`XYCSwap = 0x50`) an earlier version of this
 * table shipped -- that enum belongs to a different version and refused every
 * real Aqua strategy. Settled against two live Base mainnet strategies read
 * back from `Shipped` events, both of which walk as 18/64, 21/4, 17/0, 20/8;
 * both are in the shared calldata vectors. See docs/AQUA-B3-SPEC.md §3 and
 * program.ts's header for where each width comes from. */
typedef struct {
    uint8_t     opcode;
    int16_t     args_len;   /* -1 = any length */
    const char *name;
} AquaOpSpec;

static const AquaOpSpec AQUA_OPCODES[] = {
    { 13,   5, "deadline" },
    { 14,  20, "onlyTakerTokenBalanceNonZero" },
    { 15,  52, "onlyTakerTokenBalanceGte" },
    { 16,  28, "onlyTakerTokenSupplyShareGte" },
    { 17,   0, "xycSwapXD" },
    { 18,  64, "xycConcentrateGrowLiquidity2D" },
    { 19,   2, "decayXD" },
    { 20,  -1, "salt" },
    { 21,   4, "flatFeeAmountInXD" },
    { 31, 160, "peggedSwapGrowPriceRange2D" },
    { 33,  20, "onlyTxOriginTokenBalanceNonZero" },
};
#define AQUA_OPCODES_COUNT (sizeof(AQUA_OPCODES) / sizeof(AQUA_OPCODES[0]))

/* Real Aqua-dispatched opcodes, deliberately refused rather than added to the
 * table above -- jump(10), jumpIfTokenIn(11), jumpIfTokenOut(12) and
 * extruction(32), spec §6.3. A jump means the linear list this walker would
 * produce is not the list the router executes; extruction hands the swap
 * registers to arbitrary maker-chosen bytecode this walker cannot read by
 * construction. */
static bool aqua_is_control_flow(uint8_t opcode)
{
    return opcode == 10 || opcode == 11 || opcode == 12 || opcode == 32;
}

static const AquaOpSpec *aqua_opcode_spec(uint8_t opcode)
{
    for (size_t i = 0; i < AQUA_OPCODES_COUNT; i++) {
        if (AQUA_OPCODES[i].opcode == opcode) {
            return &AQUA_OPCODES[i];
        }
    }
    return NULL;
}

/**
 * Walk a SwapVM program -- `[opcode][args_len][args]` repeated -- exactly as
 * `ContextLib.runLoop` does (spec §2), and refuse the WHOLE program (return
 * false) the moment any instruction is not understood. No allocation: each
 * accepted instruction records only the byte offset of its opcode into the
 * SAME calldata buffer `aqua_token_off[]` already points into; nothing is
 * copied and nothing outlives this call except those offsets.
 *
 * There is no partial result. A caller that gets `false` back has an `out`
 * whose aqua_instr_* fields must not be trusted -- the same rule
 * program.ts's readProgram() documents as "either every instruction or none".
 */
static bool aqua_program_walk(const uint8_t *data, size_t prog_off,
                              size_t prog_len, EthCall *out)
{
    if (prog_len == 0) {
        return false;                       /* `empty` */
    }

    size_t  pc = 0;
    uint8_t count = 0;

    while (pc < prog_len) {
        if (pc + 2 > prog_len) {
            return false;                    /* `truncated`: mid-header */
        }
        uint8_t opcode   = data[prog_off + pc];
        uint8_t args_len = data[prog_off + pc + 1];
        size_t  inst_off = prog_off + pc;
        pc += 2;

        if (aqua_is_control_flow(opcode)) {
            return false;                    /* `has-control-flow` */
        }
        const AquaOpSpec *spec = aqua_opcode_spec(opcode);
        if (!spec) {
            return false;                    /* `unknown-opcode` */
        }
        if (spec->args_len >= 0 && args_len != (uint8_t)spec->args_len) {
            return false;                    /* `bad-args-length` */
        }
        if (pc + args_len > prog_len) {
            return false;                    /* `truncated`: tail runs past end */
        }
        pc += args_len;

        if (count >= ETH_AQUA_MAX_INSTRUCTIONS) {
            return false;                    /* `too-long` */
        }
        out->aqua_instr_off[count++] = (uint16_t)inst_off;
    }

    out->aqua_instr_count = count;
    return true;
}

/**
 * Locate and walk the program inside a SwapVM `Order`'s strategy bytes.
 *
 * `strategy_off`/`strategy_len` describe the SAME strategy bytes
 * aqua_strategy_maker() already validated (0x20 head, maker at word 1) --
 * this reaches past that point exactly as program.ts's readStrategyData()
 * does, spec §4:
 *
 *   word 2 (byte 0x40)  traits, a packed uint256 -- only bits 208..223 matter
 *                       here (programStart), which land in the big-endian
 *                       traits word's bytes 4 and 5.
 *   word 3 (byte 0x60)  in-struct offset of `data`, always 0x60 for this shape
 *   word 4 (byte 0x80)  data.length
 *   byte 0xa0..         data, then program = data[programStart..]
 */
static bool aqua_swapvm_program(const uint8_t *data, size_t strategy_off,
                                size_t strategy_len, EthCall *out)
{
    if (strategy_len < 0xa0) {
        return false;                        /* too short to hold the struct */
    }
    if (data[strategy_off + 0x60 + 31] != 0x60) {
        return false;
    }
    for (int i = 0; i < 31; i++) {
        if (data[strategy_off + 0x60 + i] != 0) {
            return false;                    /* dirty high bytes: not 0x60 */
        }
    }

    size_t data_len;
    if (!word_as_size(data + strategy_off + 0x80, strategy_len - 0xa0,
                      &data_len)) {
        return false;
    }
    size_t data_off = strategy_off + 0xa0;

    /* programStart = (traits >> 208) & 0xffff -- bits 208..223 of a 256-bit
     * big-endian word are exactly bytes 4 and 5 of that word, counting from
     * the most significant byte. */
    size_t program_start = ((size_t)data[strategy_off + 0x40 + 4] << 8) |
                           (size_t)data[strategy_off + 0x40 + 5];
    if (program_start > data_len) {
        return false;                        /* programStart past data's end */
    }

    return aqua_program_walk(data, data_off + program_start,
                             data_len - program_start, out);
}

/* ------------------------------------------------------------- disperse */

/**
 * disperseToken(address,address[],uint256[]) -- canonical encoding only.
 *
 * Head is three words: the token, then offsets to the two arrays. The
 * recipients tail sits immediately after the head, the values tail immediately
 * after it, both lengths equal, nothing trailing. Anything that merely encodes
 * the same payload differently is refused rather than normalised -- the same
 * rule the Aqua and ATS decoders apply, and for the same reason: a second
 * encoding of "the same" call is a second thing to reason about on a screen
 * somebody is about to trust.
 *
 * Unequal array lengths are refused rather than truncated to the shorter. The
 * contract would revert on them anyway, but the screen is the point: drawing
 * three recipients for a call carrying four amounts is a lie about where the
 * money goes.
 */
static bool disperse_decode_token(const uint8_t *data, size_t len, EthCall *out)
{
    if (len < 4 + 3 * 32) return false;
    const uint8_t *args = data + 4;
    size_t         span = len - 4;

    if (!word_is_address(args)) return false;
    memcpy(out->disperse_token, args + 12, 20);

    size_t off_r, off_v;
    if (!word_as_size(args + 32, span, &off_r) ||
        !word_as_size(args + 64, span, &off_v)) {
        return false;
    }
    /* Where solc puts the first tail, and nowhere else. */
    if (off_r != 3 * 32) return false;

    if (off_r + 32 > span) return false;
    size_t n;
    if (!word_as_size(args + off_r, span, &n)) return false;
    if (n == 0 || n > ETH_DISPERSE_MAX_RECIPIENTS) return false;
    if (off_r + 32 + n * 32 > span) return false;

    /* The values array must begin exactly where the recipients array ended. */
    if (off_v != off_r + 32 + n * 32) return false;
    if (off_v + 32 > span) return false;
    size_t m;
    if (!word_as_size(args + off_v, span, &m)) return false;
    if (m != n) return false;                       /* never truncate to the shorter */
    if (off_v + 32 + m * 32 != span) return false;  /* nothing may follow */

    for (size_t i = 0; i < n; i++) {
        const uint8_t *r = args + off_r + 32 + i * 32;
        if (!word_is_address(r)) return false;
        out->disperse_to_off[i]     = (uint16_t)((r + 12) - data);
        out->disperse_amount_off[i] = (uint16_t)((args + off_v + 32 + i * 32) - data);
    }
    out->disperse_count = (uint8_t)n;
    return true;
}

bool eth_disperse_to(const EthCall *call, const uint8_t *data, size_t len,
                     int i, uint8_t out[20])
{
    if (!call || !data || !out) return false;
    if (call->kind != ETH_CALL_DISPERSE_TOKEN) return false;
    if (i < 0 || i >= (int)call->disperse_count) return false;
    size_t off = call->disperse_to_off[i];
    if (off > len || len - off < 20) return false;
    memcpy(out, data + off, 20);
    return true;
}

bool eth_disperse_amount(const EthCall *call, const uint8_t *data, size_t len,
                         int i, EthQuantity *out)
{
    if (!call || !data || !out) return false;
    if (call->kind != ETH_CALL_DISPERSE_TOKEN) return false;
    if (i < 0 || i >= (int)call->disperse_count) return false;
    size_t off = call->disperse_amount_off[i];
    if (off > len || len - off < 32) return false;
    return eth_quantity_set(out, data + off, 32);
}

/* ---------------------------------------------------------- ATS issuance */

bool eth_ats_string(const EthCall *call, const uint8_t *data, size_t len,
                    EthAtsString which, char *out, size_t out_size)
{
    if (out && out_size) out[0] = '\0';
    if (!call || !data || !out || out_size == 0) return false;
    if (call->kind != ETH_CALL_ATS_DEPLOY_EQUITY &&
        call->kind != ETH_CALL_ATS_DEPLOY_BOND) {
        return false;
    }

    size_t off = (which == ETH_ATS_NAME) ? call->ats_name_off
                                         : call->ats_symbol_off;
    size_t n   = (which == ETH_ATS_NAME) ? call->ats_name_len
                                         : call->ats_symbol_len;
    if (n == 0) return false;
    if (off > len || n > len - off) return false;   /* no overflow in the sum */
    if (n + 1 > out_size) return false;

    memcpy(out, data + off, n);
    out[n] = '\0';
    return true;
}


/**
 * Is every byte of this string one a 240x240 screen draws faithfully?
 *
 * Printable ASCII only: 0x20 (space) to 0x7E (~). Not a style rule -- it is
 * the difference between the string in the calldata and the string a person
 * reads off the glass. A control character can blank or reposition what
 * follows; a UTF-8 sequence can carry a right-to-left override that reverses
 * a symbol; a byte the font has no glyph for draws as nothing at all and
 * silently shortens the name being approved. Any of those makes the screen
 * disagree with what is signed, which is the one failure this device exists
 * to prevent, so the whole call is refused rather than the string cleaned.
 *
 * A leading or trailing space is refused for the same reason: it is invisible
 * on screen and is part of the name on chain.
 */
static bool ats_string_is_drawable(const uint8_t *p, size_t len)
{
    if (len == 0) return false;
    if (p[0] == ' ' || p[len - 1] == ' ') return false;
    for (size_t i = 0; i < len; i++) {
        if (p[i] < 0x20 || p[i] > 0x7E) return false;
    }
    return true;
}

/**
 * deployEquity(string,string) / deployBond(string,string).
 *
 * Canonical encoding only, exactly as the Aqua decoders insist: the head is
 * two offsets, the first tail sits immediately after the head, the second
 * immediately after the first, and every pad byte is zero. Anything that is
 * merely a valid ABI encoding of the same two strings -- reordered tails,
 * surplus padding, a gap between them -- is refused rather than normalised,
 * because a second encoding of "the same" call is a second thing to have to
 * reason about on a screen.
 */
static bool ats_decode_two_strings(const uint8_t *data, size_t len, EthCall *out)
{
    if (len < 4 + 2 * 32) return false;
    const uint8_t *args = data + 4;
    size_t         span = len - 4;

    size_t off_n, off_s;
    if (!word_as_size(args, span, &off_n) ||
        !word_as_size(args + 32, span, &off_s)) {
        return false;
    }
    /* Where solc puts the first tail, and nowhere else. */
    if (off_n != 2 * 32) return false;

    /* name */
    if (off_n + 32 > span) return false;
    size_t len_n, padded_n;
    if (!word_as_size(args + off_n, span, &len_n)) return false;
    if (len_n == 0 || len_n > ETH_ATS_MAX_NAME) return false;
    if (!padded_length(len_n, span, &padded_n)) return false;
    if (off_n + 32 + padded_n > span) return false;
    const uint8_t *name = args + off_n + 32;
    for (size_t i = len_n; i < padded_n; i++) {
        if (name[i] != 0) return false;
    }
    if (!ats_string_is_drawable(name, len_n)) return false;

    /* symbol, which must begin exactly where the name's tail ended */
    if (off_s != off_n + 32 + padded_n) return false;
    if (off_s + 32 > span) return false;
    size_t len_s, padded_s;
    if (!word_as_size(args + off_s, span, &len_s)) return false;
    if (len_s == 0 || len_s > ETH_ATS_MAX_SYMBOL) return false;
    if (!padded_length(len_s, span, &padded_s)) return false;
    if (off_s + 32 + padded_s > span) return false;
    const uint8_t *symbol = args + off_s + 32;
    for (size_t i = len_s; i < padded_s; i++) {
        if (symbol[i] != 0) return false;
    }
    if (!ats_string_is_drawable(symbol, len_s)) return false;

    /* Nothing may follow. Trailing bytes are data somebody put there for a
     * reader other than this one. */
    if (off_s + 32 + padded_s != span) return false;

    out->ats_name_off   = (uint16_t)(name - data);
    out->ats_name_len   = (uint8_t)len_n;
    out->ats_symbol_off = (uint16_t)(symbol - data);
    out->ats_symbol_len = (uint8_t)len_s;
    return true;
}

/* ship(address,bytes,address[],uint256[]) -- canonical encoding only. */
static bool aqua_decode_ship(const uint8_t *data, size_t len, EthCall *out)
{
    if (len < 4 + 4 * 32) return false;
    const uint8_t *args = data + 4;
    size_t         span = len - 4;

    if (!word_is_address(args)) return false;
    memcpy(out->aqua_app, args + 12, 20);

    size_t off_s, off_t, off_a;
    if (!word_as_size(args + 32, span, &off_s) ||
        !word_as_size(args + 64, span, &off_t) ||
        !word_as_size(args + 96, span, &off_a)) {
        return false;
    }
    /* Where solc would have put the first tail element, and nowhere else. */
    if (off_s != 4 * 32) return false;

    /* strategy */
    if (off_s + 32 > span) return false;
    size_t len_s, padded_s;
    if (!word_as_size(args + off_s, span, &len_s)) return false;
    if (!padded_length(len_s, span, &padded_s)) return false;
    if (off_s + 32 + padded_s > span) return false;
    if (off_t != off_s + 32 + padded_s) return false;
    const uint8_t *strategy = args + off_s + 32;
    /* The padding a shorter-than-a-word tail carries must be zero. A host that
     * can put bytes there can change nothing the app reads and nothing the
     * screen shows, but it changes keccak256(strategy) -- which is the key the
     * position is filed under, and the figure the portfolio matches on. */
    for (size_t i = len_s; i < padded_s; i++) {
        if (strategy[i] != 0) return false;
    }
    if (!aqua_strategy_maker(strategy, len_s, out->aqua_maker)) return false;
    out->has_aqua_maker = true;
    keccak_256(strategy, len_s, out->aqua_hash);

    /* B3: only when `app` is the pinned SwapVM router is a program even
     * present to read -- for any other app this strategy's bytes are that
     * app's own business, unchanged since before this milestone (spec §6.6).
     * When it IS the router, a program this device cannot read in full
     * refuses the WHOLE ship, not just the program pages: there is no state
     * where the legs above are shown next to a program the device gave up
     * on. */
    if (memcmp(out->aqua_app, AQUA_SWAPVM_ROUTER, 20) == 0) {
        out->aqua_is_swapvm = true;
        size_t strategy_off = (size_t)(strategy - data);
        if (!aqua_swapvm_program(data, strategy_off, len_s, out)) {
            return false;
        }
    }

    /* tokens */
    if (off_t + 32 > span) return false;
    size_t legs;
    if (!word_as_size(args + off_t, span, &legs)) return false;
    if (legs == 0 || legs > ETH_AQUA_MAX_LEGS) return false;
    if (off_t + 32 + legs * 32 > span) return false;
    if (off_a != off_t + 32 + legs * 32) return false;

    /* amounts */
    if (off_a + 32 > span) return false;
    size_t amounts;
    if (!word_as_size(args + off_a, span, &amounts)) return false;
    /* One amount per token. Aqua reads them pairwise; a mismatch would mean
     * either a leg with no amount on screen or an amount with no leg. */
    if (amounts != legs) return false;
    if (span != off_a + 32 + legs * 32) return false;   /* ends exactly here */

    for (size_t i = 0; i < legs; i++) {
        const uint8_t *token = args + off_t + 32 + i * 32;
        if (!word_is_address(token)) return false;
        out->aqua_token_off[i]  = (uint16_t)(4 + off_t + 32 + i * 32);
        out->aqua_amount_off[i] = (uint16_t)(4 + off_a + 32 + i * 32);
    }
    out->aqua_legs = (uint8_t)legs;
    out->has_aqua_amounts = true;
    memcpy(out->address, out->aqua_app, sizeof(out->address));
    return true;
}

/* dock(address,bytes32,address[]) -- canonical encoding only. */
static bool aqua_decode_dock(const uint8_t *data, size_t len, EthCall *out)
{
    if (len < 4 + 3 * 32) return false;
    const uint8_t *args = data + 4;
    size_t         span = len - 4;

    if (!word_is_address(args)) return false;
    memcpy(out->aqua_app, args + 12, 20);
    /* A bytes32 is 32 bytes of anything: no padding rule to check and nothing
     * to reject. The hash is not verified against a strategy either -- the
     * device has never seen the strategy it refers to. The screen prints it and
     * lets the user compare it against the portfolio, which is the only party
     * in this system that has both halves. */
    memcpy(out->aqua_hash, args + 32, 32);

    size_t off_t;
    if (!word_as_size(args + 64, span, &off_t)) return false;
    if (off_t != 3 * 32) return false;
    if (off_t + 32 > span) return false;

    size_t legs;
    if (!word_as_size(args + off_t, span, &legs)) return false;
    if (legs == 0 || legs > ETH_AQUA_MAX_LEGS) return false;
    if (span != off_t + 32 + legs * 32) return false;

    for (size_t i = 0; i < legs; i++) {
        const uint8_t *token = args + off_t + 32 + i * 32;
        if (!word_is_address(token)) return false;
        out->aqua_token_off[i] = (uint16_t)(4 + off_t + 32 + i * 32);
    }
    out->aqua_legs = (uint8_t)legs;
    out->has_aqua_amounts = false;
    memcpy(out->address, out->aqua_app, sizeof(out->address));
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

    /* Matching IS verification: the selector on the wire is compared against
     * the hash of each candidate signature, and a row that does not hash to it
     * is not a candidate at all. See signature_matches(). */
    const struct EthAbiEntry *known = NULL;
    for (size_t i = 0; i < KNOWN_COUNT; i++) {
        if (signature_matches(&KNOWN[i], data)) {
            known = &KNOWN[i];
            break;
        }
    }
    if (!known) {
        goto done;
    }

    if (known->shape == ARGS_DISPERSE) {
        if (!disperse_decode_token(data, len, &call)) {
            memzero(&call, sizeof(call));
            call.kind = ETH_CALL_UNKNOWN;
            goto done;
        }
        call.entry = known;
        call.kind  = known->kind;
        goto done;
    }

    if (known->shape == ARGS_TWO_STRINGS) {
        if (!ats_decode_two_strings(data, len, &call)) {
            /* Same rule as Aqua's: half a decode is nothing. */
            memzero(&call, sizeof(call));
            call.kind = ETH_CALL_UNKNOWN;
            goto done;
        }
        call.entry = known;
        call.kind  = known->kind;
        goto done;
    }

    if (known->shape == ARGS_AQUA_SHIP || known->shape == ARGS_AQUA_DOCK) {
        bool ok = (known->shape == ARGS_AQUA_SHIP)
                      ? aqua_decode_ship(data, len, &call)
                      : aqua_decode_dock(data, len, &call);
        if (!ok) {
            /* Half a decode is nothing. Clearing it is what stops a screen
             * reading a field out of a call that was refused. */
            memzero(&call, sizeof(call));
            call.kind = ETH_CALL_UNKNOWN;
            goto done;
        }
        call.entry = known;
        call.kind  = known->kind;
        goto done;
    }

    if (known->shape == ARGS_FROM_SIGNATURE) {
        if (!parse_signature_args(known, &call)) {
            /* A dynamic type, or more arguments than fit. Refused, and the
             * reason is worth keeping straight: this is not "unknown
             * function", it is "known function the device cannot read in
             * full", and both must end in the same refusal or the screen would
             * be showing a subset of what gets signed. */
            call.arg_count = 0;
            goto done;
        }
        if (len != 4 + (size_t)call.arg_count * 32) {
            call.arg_count = 0;
            goto done;
        }
        for (int i = 0; i < call.arg_count; i++) {
            if (!word_matches_type(&call.args[i], data + call.args[i].offset)) {
                call.arg_count = 0;
                goto done;
            }
        }
        call.entry = known;
        call.kind  = ETH_CALL_GENERIC;
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
        case ETH_CALL_MINT_TOKEN_TO:        return "mint token to";
        case ETH_CALL_MINT:                 return "mint";
        case ETH_CALL_GENERIC:              return "contract call";
        case ETH_CALL_DISPERSE_TOKEN:       return "Disperse";
        case ETH_CALL_ATS_DEPLOY_EQUITY:    return "Issue equity";
        case ETH_CALL_ATS_DEPLOY_BOND:      return "Issue bond";
        case ETH_CALL_AQUA_SHIP:            return "Aqua ship";
        case ETH_CALL_AQUA_DOCK:            return "Aqua dock";
        default:                            return "unknown call";
    }
}

/* ------------------------------------------------- generic calls (T12c) */

void eth_call_function_name(const EthCall *call, char *out, size_t out_size)
{
    if (!out || out_size == 0) {
        return;
    }
    out[0] = '\0';
    if (!call || call->kind != ETH_CALL_GENERIC || !call->entry) {
        return;
    }

    size_t n = signature_name_length(call->entry->sig);
    if (n > out_size - 1) {
        n = out_size - 1;
    }
    memcpy(out, call->entry->sig, n);
    out[n] = '\0';
}

void eth_call_arg_name(const EthCall *call, int i, char *out, size_t out_size)
{
    if (!out || out_size == 0) {
        return;
    }
    out[0] = '\0';
    if (!call || call->kind != ETH_CALL_GENERIC || !call->entry ||
        i < 0 || i >= call->arg_count) {
        return;
    }

    /* The i-th comma-separated field of the names string. Nothing validates it
     * here beyond staying in bounds: a name is a label on a screen, never a
     * decision about bytes, so a short names list costs a label and not a
     * misread argument. */
    const char *p = call->entry->names;
    for (int skip = 0; skip < i && p; skip++) {
        p = strchr(p, ',');
        if (p) p++;
    }
    if (!p || *p == '\0') {
        return;
    }
    const char *end = strchr(p, ',');
    size_t n = end ? (size_t)(end - p) : strlen(p);
    if (n > out_size - 1) {
        n = out_size - 1;
    }
    memcpy(out, p, n);
    out[n] = '\0';
}

const uint8_t *eth_arg_word(const EthCall *call, const uint8_t *data,
                            size_t len, int i)
{
    if (!call || !data || call->kind != ETH_CALL_GENERIC ||
        i < 0 || i >= call->arg_count) {
        return NULL;
    }
    /* Re-checked against the caller's length rather than trusted from the
     * decode: this is read at render time, from a buffer the renderer owns,
     * and the two have been out of step before. */
    size_t off = call->args[i].offset;
    if (off + 32 > len) {
        return NULL;
    }
    return data + off;
}

bool eth_arg_address(const EthCall *call, const uint8_t *data, size_t len,
                     int i, uint8_t out[20])
{
    const uint8_t *word = eth_arg_word(call, data, len, i);
    if (!word || call->args[i].type != ETH_ARG_ADDRESS) {
        return false;
    }
    memcpy(out, word + 12, 20);
    return true;
}

bool eth_arg_quantity(const EthCall *call, const uint8_t *data, size_t len,
                      int i, EthQuantity *out)
{
    const uint8_t *word = eth_arg_word(call, data, len, i);
    if (!word || !out) {
        return false;
    }
    EthArgType type = (EthArgType)call->args[i].type;
    if (type != ETH_ARG_UINT && type != ETH_ARG_INT && type != ETH_ARG_BYTESN) {
        return false;
    }
    return eth_quantity_set(out, word, 32);
}

bool eth_arg_unlimited(const EthCall *call, const uint8_t *data, size_t len,
                       int i)
{
    const uint8_t *word = eth_arg_word(call, data, len, i);
    if (!word || call->args[i].type != ETH_ARG_UINT) {
        return false;
    }
    unsigned bits = arg_bits(&call->args[i]);
    if (bits < 64) {
        return false;
    }
    /* The top bit of the DECLARED width, which for a uint256 is the same
     * 2^255 threshold the ERC-20 approve screen uses and for Permit2's uint160
     * is 2^159 — both far past any supply, and both the thing a user needs the
     * same warning about. */
    size_t top_byte = 32 - bits / 8;
    return (word[top_byte] & 0x80) != 0;
}

/* ------------------------------------------------------------ Aqua (Q2) */

static bool aqua_leg_word(const EthCall *call, const uint8_t *data, size_t len,
                          int i, bool amount, const uint8_t **out)
{
    if (!call || !data || i < 0 || i >= call->aqua_legs) {
        return false;
    }
    if (call->kind != ETH_CALL_AQUA_SHIP && call->kind != ETH_CALL_AQUA_DOCK) {
        return false;
    }
    if (amount && !call->has_aqua_amounts) {
        return false;
    }
    size_t off = amount ? call->aqua_amount_off[i] : call->aqua_token_off[i];
    /* Re-checked against the caller's length, not trusted from the decode:
     * this runs at render time, from a buffer the renderer owns. */
    if (off + 32 > len) {
        return false;
    }
    *out = data + off;
    return true;
}

bool eth_aqua_token(const EthCall *call, const uint8_t *data, size_t len,
                    int i, uint8_t out[20])
{
    const uint8_t *word;
    if (!out || !aqua_leg_word(call, data, len, i, false, &word)) {
        return false;
    }
    if (!word_is_address(word)) {
        return false;
    }
    memcpy(out, word + 12, 20);
    return true;
}

bool eth_aqua_amount(const EthCall *call, const uint8_t *data, size_t len,
                     int i, EthQuantity *out)
{
    const uint8_t *word;
    if (!out || !aqua_leg_word(call, data, len, i, true, &word)) {
        return false;
    }
    return eth_quantity_set(out, word, 32);
}

/* Re-bounds-check instruction `i`'s opcode byte against the caller's `len`
 * and hand back its offset and the spec row it decoded against at record
 * time -- same discipline as aqua_leg_word() above and eth_arg_word(): this
 * runs at render time, from a buffer the renderer owns, not from a copy the
 * decoder trusted itself to have taken correctly. */
static bool aqua_instr_lookup(const EthCall *call, const uint8_t *data,
                              size_t len, int i, size_t *off,
                              const AquaOpSpec **spec)
{
    if (!call || !data || !call->aqua_is_swapvm ||
        i < 0 || i >= call->aqua_instr_count) {
        return false;
    }
    size_t o = call->aqua_instr_off[i];
    if (o + 2 > len) {
        return false;
    }
    uint8_t opcode = data[o];
    if (aqua_is_control_flow(opcode)) {
        return false;
    }
    const AquaOpSpec *s = aqua_opcode_spec(opcode);
    if (!s) {
        return false;
    }
    if (off)  *off  = o;
    if (spec) *spec = s;
    return true;
}

void eth_aqua_instr_name(const EthCall *call, const uint8_t *data, size_t len,
                         int i, char *out, size_t out_size)
{
    if (!out || out_size == 0) {
        return;
    }
    out[0] = '\0';
    size_t off;
    const AquaOpSpec *spec;
    if (!aqua_instr_lookup(call, data, len, i, &off, &spec)) {
        return;
    }
    snprintf(out, out_size, "%s", spec->name);
}

bool eth_aqua_instr_value(const EthCall *call, const uint8_t *data, size_t len,
                          int i, char *out, size_t out_size)
{
    if (!out || out_size == 0) {
        return false;
    }
    out[0] = '\0';
    size_t off;
    const AquaOpSpec *spec;
    if (!aqua_instr_lookup(call, data, len, i, &off, &spec)) {
        return false;
    }
    /* args start right after the two-byte header, and their length was
     * already proven exact by the walker that accepted this program -- but
     * re-derive it from the byte on the wire rather than trust that, for the
     * same re-check-at-render-time reason as everywhere else in this file. */
    uint8_t args_len = data[off + 1];
    const uint8_t *args = data + off + 2;
    if (off + 2 + (size_t)args_len > len) {
        return false;
    }

    if (strcmp(spec->name, "deadline") == 0) {
        EthQuantity q;
        if (!eth_quantity_set(&q, args, 5)) return false;
        return eth_format_integer(&q, out, out_size);
    }
    if (strcmp(spec->name, "flatFeeAmountInXD") == 0) {
        /* A raw uint32 against a denominator of 1e9, where 1e9 is 100%. It is
         * shown as that integer, never converted to "bps": a 1e9-base number
         * labelled bps is wrong by five orders of magnitude, and a wrong fee
         * on an authoritative screen is the failure this decoder exists to
         * avoid. The page's own label carries the base. */
        EthQuantity q;
        if (!eth_quantity_set(&q, args, 4)) return false;
        return eth_format_integer(&q, out, out_size);
    }
    if (strcmp(spec->name, "decayXD") == 0) {
        EthQuantity q;
        if (!eth_quantity_set(&q, args, 2)) return false;
        return eth_format_integer(&q, out, out_size);
    }
    if (strcmp(spec->name, "onlyTakerTokenBalanceNonZero") == 0 ||
        strcmp(spec->name, "onlyTxOriginTokenBalanceNonZero") == 0) {
        /* The wire layout here is a bare 20-byte address (args_len == 20 was
         * already proven exact by the walker), not a left-padded word, so it
         * is passed to eth_format_address() directly. */
        char addr[43];
        if (!eth_format_address(args, addr, sizeof(addr))) return false;
        snprintf(out, out_size, "%s", addr);
        return true;
    }
    /* xycSwapXD (no args), salt, the two Gte guards, and the two 2D curve
     * opcodes: no single figure summarises these honestly, so the page shows
     * the opcode name only and this stays empty -- never a truncated guess at
     * one of several wide fields. */
    return false;
}

bool eth_decode_table_entry(size_t i, const char **sig, const char **names)
{
    if (i >= KNOWN_COUNT) {
        return false;
    }
    if (sig)   *sig   = KNOWN[i].sig;
    if (names) *names = KNOWN[i].names;
    return true;
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
