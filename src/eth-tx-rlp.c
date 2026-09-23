/* EIP-1559 unsigned transaction reader. See eth-tx-rlp.h. */

#include "eth-tx-rlp.h"

#include <string.h>

#include "memzero.h"

typedef struct {
    const uint8_t *buf;
    size_t         len;
    size_t         pos;
} Cursor;

typedef struct {
    bool           list;
    const uint8_t *data;
    size_t         len;
} Item;

/* One RLP item header. Same two rules as eip4527.c: nothing is sized from the
   wire before it is compared with what is left, and the comparison is written
   so it cannot wrap. */
static bool next(Cursor *c, Item *it)
{
    if (c->pos >= c->len) {
        return false;
    }
    const uint8_t b = c->buf[c->pos++];
    size_t n;
    if (b < 0x80) {
        it->list = false;
        it->data = c->buf + c->pos - 1;
        it->len = 1;
        return true;
    }
    if (b <= 0xB7 || (b >= 0xC0 && b <= 0xF7)) {
        it->list = b >= 0xC0;
        n = (size_t)(b - (it->list ? 0xC0 : 0x80));
    } else {
        it->list = b >= 0xF8;
        const size_t lenlen = (size_t)(b - (it->list ? 0xF7 : 0xB7));
        if (lenlen > 2 || lenlen > c->len - c->pos) {
            return false;   /* nothing here is longer than 64 KB */
        }
        n = 0;
        for (size_t i = 0; i < lenlen; i++) {
            n = (n << 8) | c->buf[c->pos++];
        }
    }
    if (n > c->len - c->pos) {
        return false;
    }
    it->data = c->buf + c->pos;
    it->len = n;
    c->pos += n;
    return true;
}

static bool quantity(Cursor *c, EthQuantity *q)
{
    Item it;
    if (!next(c, &it) || it.list || it.len > sizeof q->bytes) {
        return false;
    }
    return eth_quantity_set(q, it.data, it.len);
}

bool eth_tx_from_rlp(const uint8_t *raw, size_t len, EthTx *out)
{
    if (raw == NULL || out == NULL) {
        return false;
    }
    memset(out, 0, sizeof *out);
    if (len < 2 || raw[0] != 0x02) {
        return false;   /* only EIP-1559; legacy and 2930 are not EthTx */
    }

    Cursor outer = { raw + 1, len - 1, 0 };
    Item body;
    if (!next(&outer, &body) || !body.list || outer.pos != outer.len) {
        goto refuse;
    }
    Cursor c = { body.data, body.len, 0 };

    EthQuantity chain;
    if (!quantity(&c, &chain) || chain.length > 8) {
        goto refuse;
    }
    out->chain_id = 0;
    for (size_t i = 0; i < chain.length; i++) {
        out->chain_id = (out->chain_id << 8) | chain.bytes[i];
    }

    if (!quantity(&c, &out->nonce) || !quantity(&c, &out->max_priority_fee) ||
        !quantity(&c, &out->max_fee) || !quantity(&c, &out->gas_limit)) {
        goto refuse;
    }

    Item to;
    if (!next(&c, &to) || to.list || (to.len != 0 && to.len != 20)) {
        goto refuse;
    }
    if (to.len == 20) {
        memcpy(out->to, to.data, 20);
        out->has_to = true;
    }

    if (!quantity(&c, &out->value)) {
        goto refuse;
    }

    Item data;
    if (!next(&c, &data) || data.list) {
        goto refuse;
    }
    if (data.len > ETH_MAX_DATA) {
        /* Same refusal as the USB path, same reason: the device could not
           show it, and truncating would sign something else. */
        goto refuse;
    }
    memcpy(out->data, data.data, data.len);
    out->data_length = data.len;

    Item access;
    if (!next(&c, &access) || !access.list || access.len != 0 || c.pos != c.len) {
        goto refuse;
    }

    /* The whole point: what will be hashed must be what arrived. */
    uint8_t again[ETH_MAX_DATA + 192];
    const size_t n = eth_tx_encode(out, again, sizeof again);
    const bool same = (n == len && memcmp(again, raw, len) == 0);
    memzero(again, sizeof again);
    if (!same) {
        goto refuse;
    }
    return true;

refuse:
    memzero(out, sizeof *out);
    return false;
}
