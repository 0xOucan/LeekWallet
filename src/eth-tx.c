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

/* ------------------------------------------------------ personal_sign */

bool eth_message_is_displayable(const uint8_t *message, size_t length)
{
    if (length > ETH_MAX_MESSAGE) {
        return false;
    }
    /* Printable ASCII only, and no newlines or tabs either: the OLED renders a
     * fixed 5x7 glyph per byte and has no notion of a line break, so anything
     * outside this range would be drawn as some other character - or as
     * nothing. Signing a message while showing a mangled version of it is the
     * same bargain as signing a bare hash (PROTOCOL.md 6bis), so the device
     * refuses instead. */
    for (size_t i = 0; i < length; i++) {
        if (message[i] < 0x20 || message[i] > 0x7E) {
            return false;
        }
    }
    return true;
}

bool eth_message_hash(const uint8_t *message, size_t length, uint8_t hash_out[32])
{
    if (!message && length) {
        return false;
    }
    if (length > ETH_MAX_MESSAGE) {
        return false;
    }

    /* EIP-191 version 0x45: keccak256("\x19Ethereum Signed Message:\n" ||
     * decimal_length || message).
     *
     * The length is the *byte* count in ASCII decimal, with no padding and no
     * separator. Getting this wrong does not fail loudly - it produces a
     * perfectly valid signature over a different message, which the user
     * cannot detect and cannot revoke. Hence the explicit construction rather
     * than a printf into a shared buffer. */
    static const char PREFIX[] = "\x19" "Ethereum Signed Message:\n";
    char decimal[8];
    int  dlen = snprintf(decimal, sizeof(decimal), "%zu", length);
    if (dlen <= 0 || (size_t)dlen >= sizeof(decimal)) {
        return false;
    }

    SHA3_CTX ctx;
    keccak_256_Init(&ctx);
    sha3_Update(&ctx, (const uint8_t *)PREFIX, sizeof(PREFIX) - 1);
    sha3_Update(&ctx, (const uint8_t *)decimal, (size_t)dlen);
    if (length) {
        sha3_Update(&ctx, message, length);
    }
    keccak_Final(&ctx, hash_out);

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

bool eth_format_integer(const EthQuantity *q, char *out, size_t out_size)
{
    if (!q || !out || out_size < 2) {
        return false;
    }

    uint8_t work[32];
    memzero(work, sizeof(work));
    memcpy(work + (sizeof(work) - q->length), q->bytes, q->length);

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

    if ((size_t)n + 1 > out_size) {
        return false;   /* never a truncated number: see eth_format_value */
    }
    for (int i = 0; i < n; i++) {
        out[i] = digits[n - 1 - i];
    }
    out[n] = '\0';
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

/* The chains this device can name, and what their gas is called.
 *
 * One row per chain rather than a second table, because the name and the
 * ticker are the same fact and two tables are two places to forget one. Mezo
 * is what proved that: the companion carried BTC as the gas token for 31611
 * while this file still printed the literal "ETH" over the amount, so the one
 * screen the host cannot write to named the wrong asset (T-MEZO-3). BNB Chain
 * and Polygon were wrong the same way and are fixed by the same row.
 *
 * Deliberately shorter than app/packages/core/src/chains.ts, which carries the
 * per-chain verification note: a chain missing here renders as its number with
 * no ticker, which is honest, where a guessed row would not be. */
/*
 * Chain id -> name and gas ticker.
 *
 * Both facts for a chain in one row, because they are the same fact: a chain
 * named on one screen and its gas named on another must not be able to
 * disagree, and two tables were how Mezo reached the companion while this file
 * still said ETH.
 *
 * Every row was verified on 2026-10-16 by calling eth_chainId against that
 * chain's own RPC through the companion's table and checking the answer
 * matched the declared id; all 32 answered. The tickers are each chain's own
 * gas token, which is not ether on nine of them - BNB, POL, XDAI, MON, S,
 * HBAR, MNT, CELO, AVAX, BTC on Mezo, and USDC on Arc, where the gas token is
 * a dollar.
 *
 * Names are at most 21 characters, which is what a panel row fits; a longer
 * name would be truncated into something that reads like a different chain.
 * This mirrors CHAINS in app/packages/core/src/chains.ts, and a chain absent
 * from either side renders as its number with no ticker.
 */
static const struct {
    uint64_t    id;
    const char *name;
    const char *gas;
} CHAIN_TABLE[] = {
    { 1,        "Ethereum",          "ETH"   },
    { 10,       "OP Mainnet",        "ETH"   },
    { 56,       "BNB Chain",         "BNB"   },
    { 97,       "BNB Testnet",       "tBNB"  },
    { 100,      "Gnosis",            "XDAI"  },
    { 130,      "Unichain",          "ETH"   },
    { 137,      "Polygon",           "POL"   },
    { 143,      "Monad",             "MON"   },
    { 146,      "Sonic",             "S"     },
    { 296,      "Hedera Testnet",    "HBAR"  },
    { 324,      "zkSync Era",        "ETH"   },
    { 1301,     "Unichain Sepolia",  "ETH"   },
    { 5000,     "Mantle",            "MNT"   },
    { 8453,     "Base",              "ETH"   },
    { 10143,    "Monad Testnet",     "MON"   },
    { 31611,    "Mezo Testnet",      "BTC"   },
    { 31612,    "Mezo",              "BTC"   },
    { 42161,    "Arbitrum One",      "ETH"   },
    { 42220,    "Celo",              "CELO"  },
    { 43113,    "Avalanche Fuji",    "AVAX"  },
    { 43114,    "Avalanche",         "AVAX"  },
    { 59141,    "Linea Sepolia",     "ETH"   },
    { 59144,    "Linea",             "ETH"   },
    { 80002,    "Polygon Amoy",      "POL"   },
    { 81457,    "Blast",             "ETH"   },
    { 84532,    "Base Sepolia",      "ETH"   },
    { 421614,   "Arbitrum Sepolia",  "ETH"   },
    { 534352,   "Scroll",            "ETH"   },
    { 560048,   "Hoodi",             "ETH"   },
    { 5042002,  "Arc Testnet",       "USDC"  },
    { 11155111, "Sepolia",           "ETH"   },
    { 11155420, "OP Sepolia",        "ETH"   },
};


const char *eth_chain_name(uint64_t chain_id, char *scratch, size_t scratch_size)
{
    for (size_t i = 0; i < sizeof(CHAIN_TABLE) / sizeof(CHAIN_TABLE[0]); i++) {
        if (CHAIN_TABLE[i].id == chain_id) {
            return CHAIN_TABLE[i].name;
        }
    }

    /* Never guess. A wrong name is worse than a number, because a user who
     * reads "Ethereum" stops checking. */
    snprintf(scratch, scratch_size, "chain %llu", (unsigned long long)chain_id);
    return scratch;
}

const char *eth_gas_symbol(uint64_t chain_id)
{
    for (size_t i = 0; i < sizeof(CHAIN_TABLE) / sizeof(CHAIN_TABLE[0]); i++) {
        if (CHAIN_TABLE[i].id == chain_id) {
            return CHAIN_TABLE[i].gas;
        }
    }

    /* NULL, and the caller draws the bare number.
     *
     * The tempting fallback is "ETH", because most EVM chains pay gas in
     * ether and the string was there already. It is the one answer that must
     * not be given: a user signing on an unnamed chain whose gas is BTC would
     * read ETH and approve an amount of something else entirely, and they
     * would read it off the screen that exists precisely so the host cannot
     * lie to them. An unlabelled number asks the reader to check which chain
     * they are on, which is the question they should be asking; a wrong label
     * stops them asking it. */
    return NULL;
}
