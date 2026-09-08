/**
 * Calldata decoding - see eth-decode.h
 */

#include "eth-decode.h"

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
    ARGS_AQUA_DOCK      /* Aqua dock: see aqua_decode_dock()            */
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
