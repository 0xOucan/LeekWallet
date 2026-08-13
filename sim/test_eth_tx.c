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
#include "sha3.h"

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

/* EIP-191 personal_sign: what may be signed, and what it hashes to.
 *
 * The bound and the printability rule live here rather than only in the
 * protocol endpoint, because "this device can render that message" is a fact
 * about the display, not about the wire. Duplicated on purpose - and therefore
 * worth testing on its own, or the copy that matters silently stops applying. */
static void test_message_displayability(void)
{
    printf("== a message is signable only if it can be rendered in full\n");

    CHECK(eth_message_is_displayable((const uint8_t *)"hello", 5),
          "plain ASCII was refused");
    CHECK(eth_message_is_displayable((const uint8_t *)"", 0),
          "an empty message was refused");

    /* The bound is the screen, not the buffer: what cannot be read cannot be
     * approved. */
    uint8_t big[ETH_MAX_MESSAGE + 1];
    memset(big, 'A', sizeof(big));
    CHECK(eth_message_is_displayable(big, ETH_MAX_MESSAGE),
          "a message exactly at the limit was refused");
    CHECK(!eth_message_is_displayable(big, ETH_MAX_MESSAGE + 1),
          "a message one byte over the limit was accepted");

    /* No glyph, no honest rendering. Showing a mangled message while signing
     * the real one is blind signing with better lighting. */
    CHECK(!eth_message_is_displayable((const uint8_t *)"a\nb", 3),
          "a newline was accepted");
    CHECK(!eth_message_is_displayable((const uint8_t *)"a\tb", 3),
          "a tab was accepted");
    CHECK(!eth_message_is_displayable((const uint8_t *)"a\x01""b", 3),
          "a control byte was accepted");
    CHECK(!eth_message_is_displayable((const uint8_t *)"caf\xc3\xa9", 5),
          "a UTF-8 sequence was accepted");

    /* Hashing refuses the same bound, so nothing can be signed past it even if
     * a caller forgets to ask. */
    uint8_t digest[32];
    CHECK(!eth_message_hash(big, ETH_MAX_MESSAGE + 1, digest),
          "an over-long message was hashed anyway");
}

static void test_message_hash_prefix(void)
{
    printf("== the personal_sign preimage carries the prefix and a byte count\n");

    /* Two messages differing only in length must differ in the prefix as well
     * as the content: a length that is ignored or padded makes distinct
     * messages collide, which is the whole reason EIP-191 has one. */
    uint8_t a[32], b[32], c[32];
    CHECK(eth_message_hash((const uint8_t *)"abc", 3, a), "hashing 'abc' failed");
    CHECK(eth_message_hash((const uint8_t *)"abcd", 4, b), "hashing 'abcd' failed");
    CHECK(memcmp(a, b, 32) != 0, "two messages of different lengths hashed alike");

    CHECK(eth_message_hash((const uint8_t *)"abc", 3, c), "hashing is not deterministic");
    CHECK(memcmp(a, c, 32) == 0, "the same message hashed two ways");

    /* The preimage in full, written out here rather than asked of the code
     * under test.
     *
     * Every half-right version of this - no prefix, no length, the length in
     * the wrong place - still produces a 32-byte digest that signs cleanly and
     * verifies against nothing the user agreed to. A host that gets to choose
     * an unprefixed preimage can choose one that is a valid RLP transaction,
     * turning a message prompt into a transfer. So the expectation is spelled
     * out byte for byte. */
    static const char PREIMAGE[] = "\x19" "Ethereum Signed Message:\n3abc";
    uint8_t want[32];
    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    sha3_Update(&ctx, (const uint8_t *)PREIMAGE, sizeof(PREIMAGE) - 1);
    keccak_Final(&ctx, want);
    CHECK(memcmp(a, want, 32) == 0,
          "the personal_sign preimage is not \\x19Ethereum Signed "
          "Message:\\n<len><message>");

    /* The empty message is legal and has a definite answer; it is also where a
     * length written as "" instead of "0" would go unnoticed. */
    uint8_t empty[32], zero_text[32];
    CHECK(eth_message_hash(NULL, 0, empty), "the empty message would not hash");
    CHECK(eth_message_hash((const uint8_t *)"0", 1, zero_text), "hashing '0' failed");
    CHECK(memcmp(empty, zero_text, 32) != 0,
          "the empty message hashes like the message \"0\" - the length is "
          "being written where the content should be");
}

int main(void)
{
    test_message_displayability();
    test_message_hash_prefix();
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
