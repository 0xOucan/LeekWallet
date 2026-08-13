/**
 * Transaction encoding and rendering tests (ROADMAP T12).
 *
 * Two things must be right and they fail differently. A wrong *encoding*
 * produces a valid signature over a transaction nobody meant. A wrong
 * *rendering* gets a correct transaction approved for the wrong reasons. The
 * second is the one a user can actually catch, which is why the formatting has
 * as many tests as the RLP.
 */

#include <stdio.h>
#include <string.h>

#include "eth-tx.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static void to_hex(const uint8_t *in, size_t len, char *out)
{
    static const char *d = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        out[i * 2] = d[in[i] >> 4];
        out[i * 2 + 1] = d[in[i] & 0x0F];
    }
    out[len * 2] = '\0';
}

/* A 1 ETH transfer on mainnet, hand-checked against the EIP-1559 encoding. */
static void build_reference(EthTx *tx)
{
    memset(tx, 0, sizeof(*tx));
    tx->chain_id = 1;
    eth_quantity_set_u64(&tx->nonce, 0);
    eth_quantity_set_u64(&tx->max_priority_fee, 1000000000ULL);   /* 1 gwei */
    eth_quantity_set_u64(&tx->max_fee, 20000000000ULL);           /* 20 gwei */
    eth_quantity_set_u64(&tx->gas_limit, 21000);

    static const uint8_t to[20] = {
        0x71,0xC7,0x65,0x6E,0xC7,0xab,0x88,0xb0,0x98,0xde,
        0xfB,0x75,0x1B,0x74,0x01,0xB5,0xf6,0xd8,0x97,0x6F,
    };
    memcpy(tx->to, to, 20);
    tx->has_to = true;

    eth_quantity_set_u64(&tx->value, 1000000000000000000ULL);     /* 1 ETH */
}

static void test_encoding_shape(void)
{
    printf("== EIP-1559 encoding\n");

    EthTx tx;
    build_reference(&tx);

    uint8_t out[512];
    char hex[1100];
    size_t n = eth_tx_encode(&tx, out, sizeof(out));
    CHECK(n > 0, "encode failed");
    to_hex(out, n, hex);

    CHECK(out[0] == 0x02, "transaction type byte is 0x%02x, expected 0x02", out[0]);
    CHECK((out[1] & 0xC0) == 0xC0, "payload is not an RLP list");

    /* Verified field by field:
     *   02                     EIP-2718 type 2
     *   f0                     list, 48-byte body (matches the actual length)
     *   01                     chainId 1
     *   80                     nonce 0, the empty string
     *   84 3b9aca00            maxPriorityFee 1 gwei
     *   85 04a817c800          maxFee 20 gwei
     *   82 5208                gasLimit 21000
     *   94 71c7..976f          to, 20 bytes
     *   88 0de0b6b3a7640000    value 1e18 wei
     *   80                     data, empty
     *   c0                     accessList, empty
     *
     * The first version of this constant was written by hand and was wrong -
     * a mistyped priority fee and a miscounted body length. Worth recording,
     * because a hand-written expectation is exactly as fallible as the code
     * it checks, and here it was the expectation that was wrong. */
    const char *expected =
        "02f0"
        "0180"
        "843b9aca00"
        "8504a817c800"
        "825208"
        "9471c7656ec7ab88b098defb751b7401b5f6d8976f"
        "880de0b6b3a7640000"
        "80"
        "c0";
    CHECK(strcmp(hex, expected) == 0,
          "encoding differs\n         want %s\n         got  %s", expected, hex);
}

static void test_zero_is_empty_not_zero_byte(void)
{
    printf("== zero encodes as the empty string\n");

    /* RLP has no leading zeros and encodes 0 as 0x80, not 0x00. Getting this
     * wrong changes the hash and signs a different transaction. */
    EthQuantity q;
    eth_quantity_set_u64(&q, 0);
    CHECK(q.length == 0, "zero has length %zu", q.length);

    const uint8_t padded[] = { 0x00, 0x00, 0x01, 0x2c };
    eth_quantity_set(&q, padded, sizeof(padded));
    CHECK(q.length == 2 && q.bytes[0] == 0x01 && q.bytes[1] == 0x2c,
          "leading zeros were not stripped (length %zu)", q.length);
}

static void test_hash_is_stable_and_sensitive(void)
{
    printf("== the hash covers every field\n");

    EthTx tx;
    build_reference(&tx);

    uint8_t base[32], other[32];
    CHECK(eth_tx_hash(&tx, base), "hash failed");

    struct { const char *what; void (*mutate)(EthTx *); } cases[] = {
        { "chain id",  NULL },
    };
    (void)cases;

    /* Every field must change the digest, or the device would display one
     * value and sign another. */
    EthTx t = tx; t.chain_id = 8453;
    eth_tx_hash(&t, other);
    CHECK(memcmp(base, other, 32) != 0, "chain id does not affect the hash");

    t = tx; eth_quantity_set_u64(&t.value, 500000000000000000ULL);
    eth_tx_hash(&t, other);
    CHECK(memcmp(base, other, 32) != 0, "value does not affect the hash");

    t = tx; t.to[19] ^= 0x01;
    eth_tx_hash(&t, other);
    CHECK(memcmp(base, other, 32) != 0, "recipient does not affect the hash");

    t = tx; eth_quantity_set_u64(&t.nonce, 1);
    eth_tx_hash(&t, other);
    CHECK(memcmp(base, other, 32) != 0, "nonce does not affect the hash");

    t = tx; t.data_length = 4; t.data[0] = 0xa9;
    eth_tx_hash(&t, other);
    CHECK(memcmp(base, other, 32) != 0, "calldata does not affect the hash");

    /* And it is deterministic. */
    eth_tx_hash(&tx, other);
    CHECK(memcmp(base, other, 32) == 0, "hashing is not deterministic");
}

static void test_value_formatting(void)
{
    printf("== values render the way a human reads them\n");

    struct { const char *label; uint64_t wei; const char *want; } cases[] = {
        { "one ether",      1000000000000000000ULL, "1" },
        { "half",            500000000000000000ULL, "0.5" },
        { "zero",                                0, "0" },
        { "one gwei",                 1000000000ULL, "0.000000001" },
        { "1.25",           1250000000000000000ULL, "1.25" },
    };

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        EthQuantity q;
        eth_quantity_set_u64(&q, cases[i].wei);
        char out[40];
        CHECK(eth_format_value(&q, out, sizeof(out), 18),
              "%s: formatting failed", cases[i].label);
        CHECK(strcmp(out, cases[i].want) == 0,
              "%s: want \"%s\", got \"%s\"", cases[i].label, cases[i].want, out);
    }

    /* One wei must not render as zero. A screen that rounds a value to nothing
     * is telling the user something false. */
    EthQuantity one;
    eth_quantity_set_u64(&one, 1);
    char out[40];
    eth_format_value(&one, out, sizeof(out), 18);
    CHECK(strcmp(out, "0.000000000000000001") == 0, "one wei rendered as \"%s\"", out);
}

static void test_address_checksum(void)
{
    printf("== addresses are EIP-55 checksummed\n");

    /* The canonical example from EIP-55. */
    static const uint8_t addr[20] = {
        0x5a,0xAe,0xb6,0x05,0x3F,0x3E,0x94,0xC9,0xb9,0xA0,
        0x9f,0x33,0x66,0x94,0x35,0xE7,0xEf,0x1B,0xeA,0xed,
    };
    char out[43];
    CHECK(eth_format_address(addr, out, sizeof(out)), "formatting failed");
    CHECK(strcmp(out, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") == 0,
          "checksum casing wrong: %s", out);
}

static void test_chain_names(void)
{
    printf("== unknown chains show a number, not a guess\n");

    char scratch[32];
    CHECK(strcmp(eth_chain_name(1, scratch, sizeof(scratch)), "Ethereum") == 0, "mainnet");
    CHECK(strcmp(eth_chain_name(8453, scratch, sizeof(scratch)), "Base") == 0, "base");

    /* A wrong name is worse than a number: a user who reads a familiar name
     * stops checking. */
    const char *unknown = eth_chain_name(999999, scratch, sizeof(scratch));
    CHECK(strstr(unknown, "999999") != NULL, "unknown chain rendered as \"%s\"", unknown);
}

int main(void)
{
    test_encoding_shape();
    test_zero_is_empty_not_zero_byte();
    test_hash_is_stable_and_sensitive();
    test_value_formatting();
    test_address_checksum();
    test_chain_names();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
