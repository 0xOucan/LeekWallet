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

static const uint8_t SEL_TRANSFER[4] = {0xa9, 0x05, 0x9c, 0xbb};
static const uint8_t SEL_APPROVE[4]  = {0x09, 0x5e, 0xa7, 0xb3};

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

    /* An unknown selector. transferFrom(), which is not in the set. */
    const uint8_t sel_transfer_from[4] = {0x23, 0xb8, 0x72, 0xdd};
    build_call(data, sel_transfer_from, SPENDER, amount);
    CHECK(eth_decode_call(data, 68, &call) == ETH_CALL_UNKNOWN,
          "transferFrom accepted");

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
}

int main(void)
{
    test_empty_is_native();
    test_transfer();
    test_approve_bounded();
    test_approve_unlimited();
    test_refusals();
    test_tx_level();

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all decode tests passed\n");
    return 0;
}
