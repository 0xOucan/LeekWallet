/**
 * Calldata decoding tests (ROADMAP T50).
 *
 * The property under test is refusal, not decoding. A decoder that reads
 * transfer() correctly but also accepts something it half-understands is worse
 * than no decoder at all: it gets a confident screen in front of a user for a
 * call the device does not actually know. So most of what follows is malformed
 * input that must come back ETH_CALL_UNKNOWN.
 */

#include <stdio.h>
#include <string.h>

#include "eth-decode.h"
#include "sha3.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static const uint8_t SPENDER[20] = {
    0xd8, 0xdA, 0x6B, 0xF2, 0x69, 0x64, 0xaF, 0x9D, 0x7e, 0xEd,
    0x9e, 0x03, 0xE5, 0x34, 0x15, 0xD3, 0x7a, 0xA9, 0x60, 0x45
};

/* selector || 12 zero bytes || address || 32-byte amount */
static size_t build_call(uint8_t out[68], const uint8_t selector[4],
                         const uint8_t addr[20], const uint8_t amount[32])
{
    memset(out, 0, 68);
    memcpy(out, selector, 4);
    memcpy(out + 4 + 12, addr, 20);
    memcpy(out + 36, amount, 32);
    return 68;
}

static void amount_u64(uint8_t out[32], uint64_t v)
{
    memset(out, 0, 32);
    for (int i = 31; i >= 24; i--) {
        out[i] = (uint8_t)(v & 0xFF);
        v >>= 8;
    }
}

static const uint8_t OTHER[20] = {
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa,
    0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05
};

static const uint8_t SEL_TRANSFER[4]      = {0xa9, 0x05, 0x9c, 0xbb};
static const uint8_t SEL_APPROVE[4]       = {0x09, 0x5e, 0xa7, 0xb3};
static const uint8_t SEL_TRANSFER_FROM[4] = {0x23, 0xb8, 0x72, 0xdd};
static const uint8_t SEL_APPROVAL_ALL[4]  = {0xa2, 0x2c, 0xb4, 0x65};
static const uint8_t SEL_DEPOSIT[4]       = {0xd0, 0xe3, 0x0d, 0xb0};
static const uint8_t SEL_WITHDRAW[4]      = {0x2e, 0x1a, 0x7d, 0x4d};
static const uint8_t SEL_MINT_TO[4]       = {0x40, 0xc1, 0x0f, 0x19};
static const uint8_t SEL_MINT[4]          = {0xa0, 0x71, 0x2d, 0x68};

/* selector || 12 zeros || from || 12 zeros || to || amount */
static size_t build_transfer_from(uint8_t out[100], const uint8_t from[20],
                                  const uint8_t to[20], const uint8_t amount[32])
{
    memset(out, 0, 100);
    memcpy(out, SEL_TRANSFER_FROM, 4);
    memcpy(out + 4 + 12, from, 20);
    memcpy(out + 36 + 12, to, 20);
    memcpy(out + 68, amount, 32);
    return 100;
}

/* selector || 12 zeros || operator || bool word */
static size_t build_approval_all(uint8_t out[68], const uint8_t op[20], bool on)
{
    memset(out, 0, 68);
    memcpy(out, SEL_APPROVAL_ALL, 4);
    memcpy(out + 4 + 12, op, 20);
    out[67] = on ? 1 : 0;
    return 68;
}

/* selector || one uint word */
static size_t build_uint_call(uint8_t out[36], const uint8_t selector[4],
                              const uint8_t amount[32])
{
    memset(out, 0, 36);
    memcpy(out, selector, 4);
    memcpy(out + 4, amount, 32);
    return 36;
}

static void test_empty_is_native(void)
{
    printf("empty calldata is a native transfer\n");
    EthCall call;
    CHECK(eth_decode_call(NULL, 0, &call) == ETH_CALL_EMPTY, "NULL/0 not EMPTY");
    CHECK(call.kind == ETH_CALL_EMPTY, "out not populated");
    CHECK(!call.unlimited, "unlimited set on an empty call");
}

static void test_transfer(void)
{
    printf("erc-20 transfer decodes\n");
    uint8_t data[68], amount[32];
    amount_u64(amount, 1500000);
    build_call(data, SEL_TRANSFER, SPENDER, amount);

    EthCall call;
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_ERC20_TRANSFER,
          "transfer not recognised");
    CHECK(memcmp(call.address, SPENDER, 20) == 0, "recipient wrong");
    CHECK(!call.unlimited, "transfer flagged unlimited");

    char text[80];
    CHECK(eth_format_integer(&call.amount, text, sizeof(text)), "format failed");
    CHECK(strcmp(text, "1500000") == 0, "amount rendered as %s", text);
}

static void test_approve_bounded(void)
{
    printf("bounded approval decodes and is not flagged\n");
    uint8_t data[68], amount[32];
    amount_u64(amount, 1);
    build_call(data, SEL_APPROVE, SPENDER, amount);

    EthCall call;
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_ERC20_APPROVE,
          "approve not recognised");
    CHECK(!call.unlimited, "a 1-unit approval must not read as unlimited");
}

static void test_approve_unlimited(void)
{
    printf("unlimited approvals are flagged\n");

    /* The three shapes seen in the wild: 2^256-1, 2^255, and 2^255-1 rounded
     * up by a UI. All are beyond any real supply and all get the warning. */
    uint8_t maxu[32], half[32], mid[32];
    memset(maxu, 0xFF, 32);
    memset(half, 0, 32); half[0] = 0x80;
    memset(mid, 0xFF, 32); mid[0] = 0x80;

    const uint8_t *cases[3] = {maxu, half, mid};
    for (int i = 0; i < 3; i++) {
        uint8_t data[68];
        build_call(data, SEL_APPROVE, SPENDER, cases[i]);
        EthCall call;
        CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_ERC20_APPROVE,
              "case %d not an approval", i);
        CHECK(call.unlimited, "case %d not flagged unlimited", i);
    }

    /* Just below the threshold is a real, if enormous, allowance. */
    uint8_t below[32];
    memset(below, 0xFF, 32); below[0] = 0x7F;
    uint8_t data[68];
    build_call(data, SEL_APPROVE, SPENDER, below);
    EthCall call;
    eth_decode_call(data, sizeof(data), &call);
    CHECK(!call.unlimited, "2^255-1 flagged unlimited");
}

static void test_refusals(void)
{
    printf("anything outside the set is refused\n");
    uint8_t amount[32];
    amount_u64(amount, 1);

    uint8_t data[80];
    EthCall call;

    /* An unknown selector, with a perfectly well-formed argument block. */
    const uint8_t sel_unknown[4] = {0xde, 0xad, 0xbe, 0xef};
    build_call(data, sel_unknown, SPENDER, amount);
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_UNKNOWN,
          "an unknown selector was accepted");

    /* safeTransferFrom(address,address,uint256) is in the set now, and it is
     * still not transferFrom: same argument shape, different selector, and the
     * generic decoder names the third argument tokenId rather than an amount.
     * Kept here because it is the case that proves the decoder matches on the
     * selector and never on the length. */
    const uint8_t sel_safe[4] = {0x42, 0x84, 0x2e, 0x0e};
    uint8_t safe[100];
    build_transfer_from(safe, SPENDER, OTHER, amount);
    memcpy(safe, sel_safe, 4);
    CHECK(eth_decode_call(safe, sizeof(safe), &call) == ETH_CALL_GENERIC,
          "safeTransferFrom refused");
    CHECK(eth_decode_call(safe, 99, &call) == ETH_CALL_UNKNOWN,
          "a short safeTransferFrom was accepted");

    /* transferFrom's own selector at the wrong length is still refused. */
    build_transfer_from(safe, SPENDER, OTHER, amount);
    CHECK(eth_decode_call(safe, 68, &call) == ETH_CALL_UNKNOWN,
          "a short transferFrom was accepted");

    /* Right selector, truncated arguments. */
    build_call(data, SEL_TRANSFER, SPENDER, amount);
    CHECK(eth_decode_call(data, 67, &call) == ETH_CALL_UNKNOWN, "short call accepted");
    CHECK(eth_decode_call(data, 4, &call) == ETH_CALL_UNKNOWN, "selector-only accepted");

    /* Right selector, trailing bytes. The device would not be reading them,
     * so it must not claim to understand the call. */
    memset(data + 68, 0xAB, 12);
    CHECK(eth_decode_call(data, 80, &call) == ETH_CALL_UNKNOWN, "trailing bytes accepted");

    /* Dirty address padding: bytes hidden where the screen never looks. */
    build_call(data, SEL_TRANSFER, SPENDER, amount);
    data[4] = 0x01;
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_UNKNOWN,
          "non-zero address padding accepted");
}

/* Every selector, against keccak256 of the signature it claims to be.
 *
 * A one-byte typo in a constant here is invisible in every other test - the
 * decoder would simply refuse a call it should accept, or worse, accept one
 * signature under another's name. This is the only test that can catch it. */
static void test_selectors_are_what_they_claim(void)
{
    printf("selectors match keccak256 of their signatures\n");

    struct { const char *sig; const uint8_t *sel; } cases[] = {
        { "transfer(address,uint256)",              SEL_TRANSFER      },
        { "approve(address,uint256)",               SEL_APPROVE       },
        { "transferFrom(address,address,uint256)",  SEL_TRANSFER_FROM },
        { "setApprovalForAll(address,bool)",        SEL_APPROVAL_ALL  },
        { "deposit()",                              SEL_DEPOSIT       },
        { "withdraw(uint256)",                      SEL_WITHDRAW      },
        { "mint(address,uint256)",                  SEL_MINT_TO       },
        { "mint(uint256)",                          SEL_MINT          },
    };

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        uint8_t hash[32];
        keccak_256((const uint8_t *)cases[i].sig, strlen(cases[i].sig), hash);
        CHECK(memcmp(hash, cases[i].sel, 4) == 0,
              "%s: selector is not keccak256(sig)[0:4]", cases[i].sig);
    }
}

static void test_transfer_from(void)
{
    printf("transferFrom decodes, with both parties\n");
    uint8_t data[100], amount[32];
    amount_u64(amount, 42);
    build_transfer_from(data, SPENDER, OTHER, amount);

    EthCall call;
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_ERC20_TRANSFER_FROM,
          "transferFrom not recognised");
    /* Both addresses, and in the right order: a screen that swapped them
     * would describe the opposite transfer. */
    CHECK(memcmp(call.address, SPENDER, 20) == 0, "source address wrong");
    CHECK(call.has_second && memcmp(call.second, OTHER, 20) == 0,
          "destination address wrong or missing");
    CHECK(call.has_amount, "amount not marked present");
    CHECK(!call.unlimited, "transferFrom flagged unlimited");

    char text[80];
    CHECK(eth_format_integer(&call.amount, text, sizeof(text)), "format failed");
    CHECK(strcmp(text, "42") == 0, "amount rendered as %s", text);

    /* Malformed: trailing bytes, one word short, dirty padding on either
     * address word. */
    uint8_t big[132];
    memcpy(big, data, 100);
    memset(big + 100, 0xAB, 32);
    CHECK(eth_decode_call(big, 132, &call) == ETH_CALL_UNKNOWN,
          "trailing bytes accepted");
    CHECK(eth_decode_call(data, 99, &call) == ETH_CALL_UNKNOWN, "short call accepted");
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_UNKNOWN,
          "a two-word transferFrom accepted");

    build_transfer_from(data, SPENDER, OTHER, amount);
    data[4] = 0x01;
    CHECK(eth_decode_call(data, 100, &call) == ETH_CALL_UNKNOWN,
          "dirty padding on the source address accepted");

    build_transfer_from(data, SPENDER, OTHER, amount);
    data[36] = 0x01;
    CHECK(eth_decode_call(data, 100, &call) == ETH_CALL_UNKNOWN,
          "dirty padding on the destination address accepted");
}

static void test_set_approval_for_all(void)
{
    printf("setApprovalForAll decodes, grant and revoke\n");
    uint8_t data[68];
    EthCall call;

    build_approval_all(data, SPENDER, true);
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_SET_APPROVAL_ALL,
          "grant not recognised");
    CHECK(call.flag, "grant not flagged");
    CHECK(memcmp(call.address, SPENDER, 20) == 0, "operator wrong");
    /* There is no amount here at all, and a screen that printed one would be
     * inventing it. */
    CHECK(!call.has_amount, "an approval-for-all reported an amount");
    CHECK(!call.has_second, "an approval-for-all reported a second address");

    build_approval_all(data, SPENDER, false);
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_SET_APPROVAL_ALL,
          "revoke not recognised");
    CHECK(!call.flag, "revoke read as a grant");

    /* A bool that is neither 0 nor 1. The contract may read the raw word, and
     * "true-ish" is not something this screen can say honestly. */
    build_approval_all(data, SPENDER, true);
    data[67] = 2;
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_UNKNOWN,
          "a bool of 2 accepted");
    build_approval_all(data, SPENDER, false);
    data[36] = 0x01;      /* high bytes of the bool word */
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_UNKNOWN,
          "a bool with dirty high bytes accepted");

    build_approval_all(data, SPENDER, true);
    data[4] = 0x01;
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_UNKNOWN,
          "dirty address padding accepted");

    build_approval_all(data, SPENDER, true);
    CHECK(eth_decode_call(data, 67, &call) == ETH_CALL_UNKNOWN, "short call accepted");
    uint8_t big[80];
    build_approval_all(big, SPENDER, true);
    memset(big + 68, 0xAB, 12);
    CHECK(eth_decode_call(big, 80, &call) == ETH_CALL_UNKNOWN, "trailing bytes accepted");
}

static void test_weth(void)
{
    printf("WETH deposit and withdraw decode\n");
    EthCall call;

    /* deposit() takes no arguments, so anything after the selector is not
     * deposit(). */
    CHECK(eth_decode_call(SEL_DEPOSIT, 4, &call) == ETH_CALL_WETH_DEPOSIT,
          "deposit() not recognised");
    CHECK(!call.has_amount, "deposit() reported an amount it does not carry");

    uint8_t padded[36];
    memset(padded, 0, sizeof(padded));
    memcpy(padded, SEL_DEPOSIT, 4);
    CHECK(eth_decode_call(padded, 36, &call) == ETH_CALL_UNKNOWN,
          "deposit() with an argument word accepted");
    CHECK(eth_decode_call(SEL_DEPOSIT, 3, &call) == ETH_CALL_UNKNOWN,
          "three bytes accepted as a selector");

    uint8_t data[36], amount[32];
    amount_u64(amount, 1000000000000000000ull);
    build_uint_call(data, SEL_WITHDRAW, amount);
    CHECK(eth_decode_call(data, sizeof(data), &call) == ETH_CALL_WETH_WITHDRAW,
          "withdraw() not recognised");
    CHECK(call.has_amount, "withdraw() carries no amount");

    char text[80];
    CHECK(eth_format_integer(&call.amount, text, sizeof(text)), "format failed");
    CHECK(strcmp(text, "1000000000000000000") == 0, "amount rendered as %s", text);

    CHECK(eth_decode_call(data, 35, &call) == ETH_CALL_UNKNOWN, "short withdraw accepted");
    uint8_t big[68];
    build_uint_call(big, SEL_WITHDRAW, amount);
    memset(big + 36, 0xAB, 32);
    CHECK(eth_decode_call(big, 68, &call) == ETH_CALL_UNKNOWN,
          "withdraw with trailing bytes accepted");
}

static void test_mint(void)
{
    printf("both mint shapes decode\n");
    uint8_t data[68], amount[32];
    amount_u64(amount, 100);
    EthCall call;

    build_call(data, SEL_MINT_TO, SPENDER, amount);
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_MINT_TO,
          "mint(address,uint256) not recognised");
    CHECK(memcmp(call.address, SPENDER, 20) == 0, "mint recipient wrong");
    CHECK(call.has_amount, "mint carries no amount");
    /* Only an allowance can be "unlimited"; a huge mint is still a number. */
    uint8_t huge[32];
    memset(huge, 0xFF, 32);
    build_call(data, SEL_MINT_TO, SPENDER, huge);
    eth_decode_call(data, 68, &call);
    CHECK(!call.unlimited, "a large mint was flagged as an unlimited allowance");

    build_call(data, SEL_MINT_TO, SPENDER, amount);
    data[4] = 0x01;
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_UNKNOWN,
          "dirty address padding accepted");
    build_call(data, SEL_MINT_TO, SPENDER, amount);
    CHECK(eth_decode_call(data, 67, &call) == ETH_CALL_UNKNOWN, "short mint accepted");

    uint8_t bare[36];
    build_uint_call(bare, SEL_MINT, amount);
    CHECK(eth_decode_call(bare, 36, &call) == ETH_CALL_MINT,
          "mint(uint256) not recognised");
    CHECK(call.has_amount, "bare mint carries no amount");
    /* The two mints are different calls and must not collapse into one: one
     * names a recipient, the other does not. */
    CHECK(eth_decode_call(bare, 68, &call) == ETH_CALL_UNKNOWN,
          "mint(uint256) accepted at the two-word length");
}

static void test_tx_level(void)
{
    printf("transaction-level gate\n");
    EthTx tx;
    EthCall call;

    memset(&tx, 0, sizeof(tx));
    tx.chain_id = 1;
    tx.has_to = true;
    CHECK(eth_tx_is_decodable(&tx, &call), "plain transfer refused");
    CHECK(call.kind == ETH_CALL_EMPTY, "plain transfer not EMPTY");

    /* Contract creation: nothing to name, so nothing to approve. */
    tx.has_to = false;
    CHECK(!eth_tx_is_decodable(&tx, &call), "contract creation accepted");

    tx.has_to = true;
    uint8_t amount[32];
    amount_u64(amount, 7);
    tx.data_length = build_call(tx.data, SEL_APPROVE, SPENDER, amount);
    CHECK(eth_tx_is_decodable(&tx, &call), "approval refused");
    CHECK(call.kind == ETH_CALL_ERC20_APPROVE, "approval kind wrong");

    /* A call the device cannot describe, on an otherwise fine transaction. */
    tx.data[0] = 0x00;
    CHECK(!eth_tx_is_decodable(&tx, &call), "unknown selector accepted");
    CHECK(call.kind == ETH_CALL_UNKNOWN, "an undecodable call has a kind");

    /* Contract creation is refused ahead of the calldata, and stays refused
     * even when the calldata would have decoded perfectly. That ordering is
     * what keeps blind signing (T16) from reaching it: the protocol task only
     * consults the setting for transactions that still name a recipient. */
    tx.has_to = false;
    tx.data_length = build_call(tx.data, SEL_TRANSFER, SPENDER, amount);
    CHECK(!eth_tx_is_decodable(&tx, &call),
          "contract creation with decodable calldata accepted");

    /* One of the newly added selectors passes the transaction-level gate too,
     * so the widened set is genuinely reachable from signTransaction. */
    tx.has_to = true;
    tx.data_length = build_uint_call(tx.data, SEL_MINT, amount);
    CHECK(eth_tx_is_decodable(&tx, &call), "mint(uint256) refused at tx level");
    CHECK(call.kind == ETH_CALL_MINT, "mint kind wrong at tx level");
}

/* ------------------------------------------- the self-verifying table (T12c) */

/* Build a call to `sig` from `nwords` already-encoded 32-byte words.
 *
 * The selector is HASHED here, in the test, and never typed: a hand-copied
 * selector encodes perfectly and fails silently, which is precisely the class
 * of mistake the firmware table was restructured to make impossible. */
static size_t build_sig_call(uint8_t *out, size_t cap, const char *sig,
                             const uint8_t words[][32], size_t nwords)
{
    size_t len = 4 + nwords * 32;
    if (len > cap) return 0;
    uint8_t hash[32];
    keccak_256((const uint8_t *)sig, strlen(sig), hash);
    memcpy(out, hash, 4);
    for (size_t i = 0; i < nwords; i++) {
        memcpy(out + 4 + i * 32, words[i], 32);
    }
    return len;
}

static void word_address(uint8_t w[32], const uint8_t addr[20])
{
    memset(w, 0, 32);
    memcpy(w + 12, addr, 20);
}

static void word_u64(uint8_t w[32], uint64_t v) { amount_u64(w, v); }

/* Arity of a canonical signature: the number of types between the parens. */
static size_t sig_arity(const char *sig)
{
    const char *p = strchr(sig, '(');
    if (!p || p[1] == ')') return 0;
    size_t n = 1;
    for (p++; *p && *p != ')'; p++) {
        if (*p == ',') n++;
    }
    return n;
}

static size_t names_count(const char *names)
{
    if (!names || *names == '\0') return 0;
    size_t n = 1;
    for (const char *p = names; *p; p++) {
        if (*p == ',') n++;
    }
    return n;
}

static void test_signature_table_is_well_formed(void)
{
    printf("every table row names as many arguments as it declares\n");

    const char *sig, *names;
    uint8_t sels[64][4];
    size_t count = 0;

    for (size_t i = 0; eth_decode_table_entry(i, &sig, &names); i++) {
        CHECK(names_count(names) == sig_arity(sig),
              "%s: %zu names for %zu arguments", sig, names_count(names),
              sig_arity(sig));
        CHECK(strchr(sig, ' ') == NULL, "%s: a space in a canonical signature",
              sig);

        /* Two rows with one selector is a silent overload collision: the
         * second is unreachable and nothing else would ever say so. */
        uint8_t hash[32];
        keccak_256((const uint8_t *)sig, strlen(sig), hash);
        for (size_t j = 0; j < count; j++) {
            CHECK(memcmp(sels[j], hash, 4) != 0, "%s: duplicate selector", sig);
        }
        memcpy(sels[count++], hash, 4);
    }
    CHECK(count > 9, "the table lost its generic rows");
}

/*
 * The property the whole table rests on: the signature string IS the mapping.
 *
 * For every row, a call whose selector is keccak256(signature)[0:4] decodes,
 * and the same call with a selector taken from a signature altered by one
 * character does not. That is what makes the table self-certifying — a
 * tampered or mistyped string cannot produce the selector being signed, so it
 * matches nothing and the device refuses rather than mislabelling the call.
 */
static void test_a_tampered_signature_stops_matching(void)
{
    printf("a signature altered by one character matches nothing\n");

    const char *sig;
    for (size_t i = 0; eth_decode_table_entry(i, &sig, NULL); i++) {
        size_t arity = sig_arity(sig);
        uint8_t words[ETH_MAX_ARGS][32];
        memset(words, 0, sizeof(words));

        uint8_t data[4 + ETH_MAX_ARGS * 32];
        size_t len = build_sig_call(data, sizeof(data), sig, words, arity);
        CHECK(len > 0, "%s: could not build a call", sig);
        /* An all-zero argument block is valid for every type in the table, so
         * anything but a decode here is the row failing to match itself. */
        CHECK(eth_decode_call(data, len, NULL) != ETH_CALL_UNKNOWN,
              "%s: the row does not match its own hash", sig);

        /* Now the tamper: one character of the type list, changed. The device
         * is being handed exactly the calldata a host would send for the
         * altered signature. */
        char altered[96];
        snprintf(altered, sizeof(altered), "%s", sig);
        size_t n = strlen(altered);
        CHECK(n > 2, "%s: too short to alter", sig);
        altered[n - 2] = (altered[n - 2] == 'x') ? 'y' : 'x';

        len = build_sig_call(data, sizeof(data), altered, words, arity);
        CHECK(eth_decode_call(data, len, NULL) == ETH_CALL_UNKNOWN,
              "%s: altered to %s and still decoded", sig, altered);
    }
}

static void test_supply_decodes(void)
{
    printf("Aave supply decodes into four named arguments\n");

    uint8_t words[4][32];
    word_address(words[0], SPENDER);      /* asset      */
    word_u64(words[1], 1000000);          /* amount     */
    word_address(words[2], OTHER);        /* onBehalfOf */
    word_u64(words[3], 0);                /* referral   */

    uint8_t data[132];
    size_t len = build_sig_call(data, sizeof(data),
                                "supply(address,uint256,address,uint16)",
                                words, 4);
    EthCall call;
    CHECK(eth_decode_call(data, len, &call) == ETH_CALL_GENERIC,
          "supply refused");
    CHECK(call.arg_count == 4, "supply has %u arguments", call.arg_count);

    char name[24];
    eth_call_function_name(&call, name, sizeof(name));
    CHECK(strcmp(name, "supply") == 0, "function name is %s", name);

    eth_call_arg_name(&call, 2, name, sizeof(name));
    CHECK(strcmp(name, "onBehalfOf") == 0, "third argument named %s", name);

    uint8_t addr[20];
    CHECK(eth_arg_address(&call, data, len, 0, addr) &&
          memcmp(addr, SPENDER, 20) == 0, "asset address wrong");
    CHECK(eth_arg_address(&call, data, len, 2, addr) &&
          memcmp(addr, OTHER, 20) == 0, "onBehalfOf address wrong");
    CHECK(!eth_arg_address(&call, data, len, 1, addr),
          "an amount read back as an address");

    EthQuantity q;
    char text[80];
    CHECK(eth_arg_quantity(&call, data, len, 1, &q), "amount not readable");
    CHECK(eth_format_integer(&q, text, sizeof(text)) &&
          strcmp(text, "1000000") == 0, "amount rendered as %s", text);

    /* The selector is 0x617ba037, the one the session that prompted this work
     * refused. Pinned by hash, not typed. */
    uint8_t hash[32];
    const char *supply_sig = "supply(address,uint256,address,uint16)";
    keccak_256((const uint8_t *)supply_sig, strlen(supply_sig), hash);
    CHECK(hash[0] == 0x61 && hash[1] == 0x7b && hash[2] == 0xa0 && hash[3] == 0x37,
          "supply's selector moved");
}

static void test_generic_arguments_are_validated(void)
{
    printf("a generic argument that is not its declared type is refused\n");

    uint8_t words[4][32];
    uint8_t data[160];   /* room to append trailing bytes below */
    EthCall call;

    /* Dirty padding on an address, where the screen never looks. */
    word_address(words[0], SPENDER);
    word_u64(words[1], 1);
    word_address(words[2], OTHER);
    word_u64(words[3], 0);
    size_t len = build_sig_call(data, sizeof(data),
                                "supply(address,uint256,address,uint16)", words, 4);
    data[4 + 64] = 0x01;
    CHECK(eth_decode_call(data, len, &call) == ETH_CALL_UNKNOWN,
          "dirty padding on onBehalfOf accepted");

    /* A uint16 carrying more than sixteen bits. The contract will read the low
     * word; a device that showed the whole 256 bits would be showing a
     * different number than the one that executes, and one that masked it
     * would hide bytes the host chose to send. Refuse instead. */
    word_u64(words[3], 0x10000);
    len = build_sig_call(data, sizeof(data),
                         "supply(address,uint256,address,uint16)", words, 4);
    CHECK(eth_decode_call(data, len, &call) == ETH_CALL_UNKNOWN,
          "a uint16 wider than sixteen bits accepted");

    /* Trailing bytes behind a full argument block, as for every other kind. */
    word_u64(words[3], 0);
    len = build_sig_call(data, sizeof(data),
                         "supply(address,uint256,address,uint16)", words, 4);
    CHECK(eth_decode_call(data, len - 1, &call) == ETH_CALL_UNKNOWN,
          "a short supply accepted");
    memset(data + len, 0xAB, 4);
    CHECK(eth_decode_call(data, len + 4, &call) == ETH_CALL_UNKNOWN,
          "trailing bytes after supply accepted");
}

static void test_unlimited_follows_the_declared_width(void)
{
    printf("an unlimited allowance is judged against its own type's width\n");

    /* Permit2: approve(token, spender, uint160 amount, uint48 expiration). */
    uint8_t words[4][32];
    memset(words, 0, sizeof(words));
    word_address(words[0], SPENDER);
    word_address(words[1], OTHER);
    memset(words[2] + 12, 0xFF, 20);          /* amount = 2^160 - 1 */
    memset(words[3] + 26, 0xFF, 6);           /* expiration = 2^48 - 1 */

    uint8_t data[132];
    EthCall call;
    size_t len = build_sig_call(data, sizeof(data),
                                "approve(address,address,uint160,uint48)", words, 4);
    CHECK(eth_decode_call(data, len, &call) == ETH_CALL_GENERIC,
          "Permit2 approve refused");
    CHECK(eth_arg_unlimited(&call, data, len, 2),
          "a uint160 max allowance not flagged unlimited");
    /* A uint48 with every bit set is a far-future date, not an infinity, and
     * calling it one would name the wrong risk on the screen. */
    CHECK(!eth_arg_unlimited(&call, data, len, 3),
          "a uint48 expiration flagged unlimited");
    /* Below the halfway mark of its own width: a number, not an infinity. */
    memset(words[2], 0, 32);
    memset(words[2] + 13, 0xFF, 19);
    len = build_sig_call(data, sizeof(data),
                         "approve(address,address,uint160,uint48)", words, 4);
    eth_decode_call(data, len, &call);
    CHECK(!eth_arg_unlimited(&call, data, len, 2),
          "2^152-1 flagged unlimited");
}

static void test_dynamic_types_stay_refused(void)
{
    printf("a call carrying a dynamic argument is still refused\n");

    /* safeTransferFrom(address,address,uint256,bytes) — the four-argument
     * overload, a real function with a real selector that is deliberately NOT
     * in the table. Its head decodes to three words and an offset, so a
     * decoder that matched on shape would happily show the first three
     * arguments of a call whose fourth is arbitrary data. */
    uint8_t words[4][32];
    memset(words, 0, sizeof(words));
    word_address(words[0], SPENDER);
    word_address(words[1], OTHER);
    word_u64(words[2], 7);
    word_u64(words[3], 0x80);

    uint8_t data[132];
    size_t len = build_sig_call(data, sizeof(data),
                                "safeTransferFrom(address,address,uint256,bytes)",
                                words, 4);
    CHECK(eth_decode_call(data, len, NULL) == ETH_CALL_UNKNOWN,
          "a call with a bytes argument was decoded");

    /* Nor does the three-argument row it shadows accept the longer call: the
     * length check is exact, so an extra word cannot ride in behind a match. */
    len = build_sig_call(data, sizeof(data),
                         "safeTransferFrom(address,address,uint256)", words, 4);
    CHECK(eth_decode_call(data, len, NULL) == ETH_CALL_UNKNOWN,
          "a fourth word rode in behind safeTransferFrom");
}

int main(void)
{
    test_empty_is_native();
    test_transfer();
    test_approve_bounded();
    test_approve_unlimited();
    test_selectors_are_what_they_claim();
    test_transfer_from();
    test_set_approval_for_all();
    test_weth();
    test_mint();
    test_refusals();
    test_signature_table_is_well_formed();
    test_a_tampered_signature_stops_matching();
    test_supply_decodes();
    test_generic_arguments_are_validated();
    test_unlimited_follows_the_declared_width();
    test_dynamic_types_stay_refused();
    test_tx_level();

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all decode tests passed\n");
    return 0;
}
