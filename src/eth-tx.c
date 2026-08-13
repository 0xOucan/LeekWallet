/**
 * Ethereum transaction encoding and rendering - see eth-tx.h
 */

#include "eth-tx.h"

#include <stdio.h>
#include <string.h>

#include "sha3.h"
#include "memzero.h"

/* ---------------------------------------------------------- quantities */

bool eth_quantity_set(EthQuantity *q, const uint8_t *bytes, size_t length)
{
    if (!q) {
        return false;
    }
    memzero(q, sizeof(*q));

    if (!bytes || length == 0) {
        return true;   /* zero, encoded as the empty string */
    }

    /* RLP integers carry no leading zeros, and 0 is the empty string rather
     * than a zero byte. Encoding 0x00 instead produces a different hash and a
     * signature for a transaction nobody meant. */
    size_t start = 0;
    while (start < length && bytes[start] == 0) {
        start++;
    }

    size_t used = length - start;
    if (used > sizeof(q->bytes)) {
        return false;
    }

    memcpy(q->bytes, bytes + start, used);
    q->length = used;
    return true;
}

void eth_quantity_set_u64(EthQuantity *q, uint64_t value)
{
    uint8_t be[8];
    for (int i = 7; i >= 0; i--) {
        be[i] = (uint8_t)(value & 0xFF);
        value >>= 8;
    }
    eth_quantity_set(q, be, sizeof(be));
}

/* ----------------------------------------------------------------- RLP */

typedef struct {
    uint8_t *buf;
    size_t   capacity;
    size_t   length;
    bool     overflow;
} Rlp;

static void rlp_byte(Rlp *r, uint8_t b)
{
    if (r->length >= r->capacity) {
        r->overflow = true;
        return;
    }
    r->buf[r->length++] = b;
}

static void rlp_raw(Rlp *r, const uint8_t *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        rlp_byte(r, data[i]);
    }
}

/* Length prefix. `offset` is 0x80 for strings and 0xC0 for lists. */
static void rlp_header(Rlp *r, size_t len, uint8_t offset)
{
    if (len <= 55) {
        rlp_byte(r, (uint8_t)(offset + len));
        return;
    }

    uint8_t be[8];
    size_t n = 0;
    size_t v = len;
    while (v) {
        be[n++] = (uint8_t)(v & 0xFF);
        v >>= 8;
    }
    rlp_byte(r, (uint8_t)(offset + 55 + n));
    for (size_t i = n; i > 0; i--) {
        rlp_byte(r, be[i - 1]);
    }
}

static void rlp_string(Rlp *r, const uint8_t *data, size_t len)
{
    /* A single byte below 0x80 encodes as itself, with no prefix. Adding one
     * would change the hash. */
    if (len == 1 && data[0] < 0x80) {
        rlp_byte(r, data[0]);
        return;
    }
    rlp_header(r, len, 0x80);
    rlp_raw(r, data, len);
}

static void rlp_quantity(Rlp *r, const EthQuantity *q)
{
    rlp_string(r, q->bytes, q->length);
}

/* --------------------------------------------------------------- encode */

size_t eth_tx_encode(const EthTx *tx, uint8_t *out, size_t out_capacity)
{
    if (!tx || !out || out_capacity < 2) {
        return 0;
    }

    /* Encode the body first so its length is known for the list header. */
    uint8_t body[ETH_MAX_DATA + 160];
    Rlp b = { body, sizeof(body), 0, false };

    EthQuantity chain;
    eth_quantity_set_u64(&chain, tx->chain_id);

    rlp_quantity(&b, &chain);
    rlp_quantity(&b, &tx->nonce);
    rlp_quantity(&b, &tx->max_priority_fee);
    rlp_quantity(&b, &tx->max_fee);
    rlp_quantity(&b, &tx->gas_limit);

    if (tx->has_to) {
        rlp_string(&b, tx->to, sizeof(tx->to));
    } else {
        rlp_string(&b, NULL, 0);   /* contract creation */
    }

    rlp_quantity(&b, &tx->value);
    rlp_string(&b, tx->data, tx->data_length);

    /* Empty access list. Present in the encoding whether used or not. */
    rlp_header(&b, 0, 0xC0);

    if (b.overflow) {
        return 0;
    }

    Rlp o = { out, out_capacity, 0, false };
    rlp_byte(&o, 0x02);            /* EIP-2718 transaction type */
    rlp_header(&o, b.length, 0xC0);
    rlp_raw(&o, body, b.length);

    memzero(body, sizeof(body));
    return o.overflow ? 0 : o.length;
}

bool eth_tx_hash(const EthTx *tx, uint8_t hash_out[32])
{
    uint8_t payload[ETH_MAX_DATA + 192];
    size_t len = eth_tx_encode(tx, payload, sizeof(payload));
    if (len == 0) {
        return false;
    }

    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    sha3_Update(&ctx, payload, len);
    keccak_Final(&ctx, hash_out);

    memzero(payload, sizeof(payload));
    memzero(&ctx, sizeof(ctx));
    return true;
}

/* ------------------------------------------------------------ rendering */

/* Divide a big-endian byte string by a small number, in place. Returns the
 * remainder. Enough arithmetic to turn wei into a decimal string without
 * pulling in a bignum library for one screen. */
static uint32_t divmod_small(uint8_t *value, size_t len, uint32_t divisor)
{
    uint64_t carry = 0;
    for (size_t i = 0; i < len; i++) {
        uint64_t cur = (carry << 8) | value[i];
        value[i] = (uint8_t)(cur / divisor);
        carry = cur % divisor;
    }
    return (uint32_t)carry;
}

static bool is_zero(const uint8_t *v, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        if (v[i]) return false;
    }
    return true;
}

bool eth_format_value(const EthQuantity *wei, char *out, size_t out_size,
                      int max_decimals)
{
    if (!wei || !out || out_size < 8) {
        return false;
    }
    if (max_decimals < 0 || max_decimals > 18) {
        max_decimals = 6;
    }

    /* Long division by 10 into a decimal string, least significant first. */
    uint8_t work[32];
    memzero(work, sizeof(work));
    memcpy(work + (sizeof(work) - wei->length), wei->bytes, wei->length);

    char digits[80];
    int n = 0;
    if (is_zero(work, sizeof(work))) {
        digits[n++] = '0';
    } else {
        while (!is_zero(work, sizeof(work)) && n < (int)sizeof(digits)) {
            digits[n++] = (char)('0' + divmod_small(work, sizeof(work), 10));
        }
    }
    memzero(work, sizeof(work));

    /* Split at 10^18. Values below one ether have no integer digits at all,
     * so the integer part is written as "0". */
    int int_digits = n - 18;
    size_t pos = 0;

    if (int_digits <= 0) {
        if (pos + 1 >= out_size) return false;
        out[pos++] = '0';
    } else {
        for (int i = 0; i < int_digits; i++) {
            if (pos + 1 >= out_size) return false;
            out[pos++] = digits[n - 1 - i];
        }
    }

    /* Fractional digits, trailing zeros trimmed. */
    char frac[19];
    int fn = 0;
    for (int i = 0; i < 18 && fn < max_decimals; i++) {
        int idx = n - int_digits - 1 - i;
        frac[fn++] = (idx >= 0 && idx < n) ? digits[idx] : '0';
    }
    while (fn > 0 && frac[fn - 1] == '0') {
        fn--;
    }

    if (fn > 0) {
        if (pos + 1 >= out_size) return false;
        out[pos++] = '.';
        for (int i = 0; i < fn; i++) {
            if (pos + 1 >= out_size) return false;
            out[pos++] = frac[i];
        }
    }

    out[pos] = '\0';
    return true;
}

bool eth_format_address(const uint8_t address[20], char *out, size_t out_size)
{
    if (!address || !out || out_size < 43) {
        return false;
    }

    static const char *lower = "0123456789abcdef";
    char hex[41];
    for (int i = 0; i < 20; i++) {
        hex[i * 2]     = lower[address[i] >> 4];
        hex[i * 2 + 1] = lower[address[i] & 0x0F];
    }
    hex[40] = '\0';

    /* EIP-55: the case of each letter encodes a checksum, so a mistyped
     * address usually fails to validate somewhere rather than silently
     * addressing a different account. */
    uint8_t digest[32];
    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    sha3_Update(&ctx, (const uint8_t *)hex, 40);
    keccak_Final(&ctx, digest);

    out[0] = '0';
    out[1] = 'x';
    for (int i = 0; i < 40; i++) {
        char c = hex[i];
        if (c >= 'a' && c <= 'f') {
            uint8_t nibble = (i % 2 == 0) ? (digest[i / 2] >> 4)
                                          : (digest[i / 2] & 0x0F);
            if (nibble >= 8) {
                c = (char)(c - 'a' + 'A');
            }
        }
        out[2 + i] = c;
    }
    out[42] = '\0';
    return true;
}

const char *eth_chain_name(uint64_t chain_id, char *scratch, size_t scratch_size)
{
    switch (chain_id) {
        case 1:        return "Ethereum";
        case 10:       return "Optimism";
        case 56:       return "BNB Chain";
        case 137:      return "Polygon";
        case 8453:     return "Base";
        case 42161:    return "Arbitrum";
        case 11155111: return "Sepolia";
        case 84532:    return "Base Sepolia";
        default:
            /* Never guess. A wrong name is worse than a number, because a user
             * who reads "Ethereum" stops checking. */
            snprintf(scratch, scratch_size, "chain %llu", (unsigned long long)chain_id);
            return scratch;
    }
}
