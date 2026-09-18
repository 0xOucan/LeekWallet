/* EIP-4527 writer. See eip4527-encode.h. */

#include "eip4527-encode.h"

#include <string.h>

#include "cbor.h"
#include "eip4527.h"

/* Tags are written here rather than added to cbor.c. That file's header says
 * its grammar has no tags, and although that sentence is about the reader, a
 * tag writer sitting next to it invites the first person who needs to read one
 * to "just add the other half". Kept local, the claim stays true. */
static void put(CborWriter *w, uint8_t b)
{
    if (w->length >= w->capacity) {
        w->overflow = true;
        return;
    }
    w->buf[w->length++] = b;
}

static void write_tag(CborWriter *w, uint32_t tag)
{
    /* Shortest form, the same rule cbor.c's head() follows. Every tag this
       file writes is below 0x10000. */
    if (tag < 24) {
        put(w, (uint8_t)(0xC0 | tag));
    } else if (tag < 0x100) {
        put(w, 0xD8);
        put(w, (uint8_t)tag);
    } else {
        put(w, 0xD9);
        put(w, (uint8_t)(tag >> 8));
        put(w, (uint8_t)tag);
    }
}

static void write_bool(CborWriter *w, bool v)
{
    put(w, v ? 0xF5 : 0xF4);
}

/* One hardened keypath component: index then `true`. */
static void write_hardened(CborWriter *w, uint32_t index)
{
    cbor_write_uint(w, index);
    write_bool(w, true);
}

size_t eip4527_encode_account_hdkey(const E4527AccountKey *key,
                                    uint8_t *out, size_t out_size)
{
    if (key == NULL || out == NULL) {
        return 0;
    }
    /* A 65-byte uncompressed key or garbage in the first byte would encode
       fine and be misread by every companion, so it is refused here instead. */
    if (key->key_data[0] != 0x02 && key->key_data[0] != 0x03) {
        return 0;
    }
    if (key->account >= 0x80000000u) {
        return 0;
    }

    CborWriter w;
    cbor_writer_init(&w, out, out_size);

    /* Keys in ascending order, which is canonical CBOR and what Keystone's
       encoder emits, so the bytes match theirs rather than merely parse. */
    cbor_write_map(&w, 5);

    cbor_write_uint(&w, 3);                         /* key-data */
    cbor_write_bytes(&w, key->key_data, 33);

    cbor_write_uint(&w, 4);                         /* chain-code */
    cbor_write_bytes(&w, key->chain_code, 32);

    /* use-info: coin type 60. Without it a companion assumes type 0, which
       is Bitcoin - harmless for the key itself but wrong for anything that
       labels accounts by coin. Network is left at its mainnet default. */
    cbor_write_uint(&w, 5);
    write_tag(&w, E4527_TAG_CRYPTO_COIN_INFO);
    cbor_write_map(&w, 1);
    cbor_write_uint(&w, 1);
    cbor_write_uint(&w, E4527_COIN_ETH);

    /* origin: m/44'/60'/<account>' and the master fingerprint. The companion
       needs the fingerprint to address a sign request back to this seed, and
       the path to know which account the key is. Depth is implied by the
       component count and not written, as Keystone does not. */
    cbor_write_uint(&w, 6);
    write_tag(&w, E4527_TAG_CRYPTO_KEYPATH);
    cbor_write_map(&w, 2);
    cbor_write_uint(&w, 1);
    cbor_write_array(&w, 6);
    write_hardened(&w, 44);
    write_hardened(&w, E4527_COIN_ETH);
    write_hardened(&w, key->account);
    cbor_write_uint(&w, 2);
    cbor_write_uint(&w, key->master_fingerprint);

    /* parent-fingerprint: what an xpub serialiser needs and cannot derive
       from the child alone. MetaMask rebuilds the xpub from it. */
    cbor_write_uint(&w, 8);
    cbor_write_uint(&w, key->parent_fingerprint);

    return cbor_writer_ok(&w) ? w.length : 0;
}

size_t eip4527_encode_signature(const uint8_t request_id[16],
                                const uint8_t signature[65],
                                const char *origin,
                                uint8_t *out, size_t out_size)
{
    if (request_id == NULL || signature == NULL || out == NULL) {
        return 0;
    }
    if (origin != NULL && strlen(origin) > E4527_MAX_ORIGIN) {
        return 0;
    }

    CborWriter w;
    cbor_writer_init(&w, out, out_size);

    cbor_write_map(&w, origin != NULL ? 3 : 2);

    cbor_write_uint(&w, 1);                         /* request-id */
    write_tag(&w, E4527_TAG_UUID);
    cbor_write_bytes(&w, request_id, 16);

    cbor_write_uint(&w, 2);                         /* signature */
    cbor_write_bytes(&w, signature, 65);

    if (origin != NULL) {
        cbor_write_uint(&w, 3);
        cbor_write_text(&w, origin);
    }

    return cbor_writer_ok(&w) ? w.length : 0;
}
