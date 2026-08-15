/**
 * EIP-712 typed data: hash it here, or refuse it here — see eip712.h.
 *
 * The whole file is a single-pass walk over one CBOR document, taking nothing
 * from the host but structure. It never allocates and it never copies the
 * document: the type table holds borrowed pointers and byte offsets into the
 * caller's buffer, so a request that is 4 KB of nested maps costs the same
 * memory as one that is 400 bytes, and a hostile length cannot become a
 * hostile allocation.
 */

#include "eip712.h"

#include <stdio.h>
#include <string.h>

#include "cbor.h"
#include "eth-tx.h"
#include "memzero.h"
#include "sha3.h"

/* A borrowed slice of the document. Not NUL-terminated and deliberately so:
 * NUL-terminating would mean copying, and every string here is either compared
 * or hashed in place. */
typedef struct {
    const char *p;
    size_t      n;
} Str;

typedef struct {
    Str      name;
    size_t   fields_pos;   /* offset of the first field map, past the array header */
    uint32_t field_count;
} TypeDef;

typedef struct {
    const uint8_t *buf;
    size_t         len;
    TypeDef        types[EIP712_MAX_TYPES];
    int            type_count;
} Ctx;

/* Where the rendering accumulates while the hash is being computed.
 *
 * `overflow` is the "can hash, cannot show" flag, and it is sticky on purpose:
 * hashing continues to completion so the caller still gets a real digest to put
 * in front of a user who has blind signing on. Stopping at the first
 * unrenderable leaf would leave them with neither a rendering nor a hash. */
typedef struct {
    Eip712Render *out;
    bool          overflow;
} Collector;

static bool str_eq_cstr(Str s, const char *c)
{
    size_t n = strlen(c);
    return s.n == n && memcmp(s.p, c, n) == 0;
}

/* Copy a borrowed slice into a fixed buffer, refusing rather than truncating.
 * Every caller here is deciding what to hash or what to show, and a truncated
 * type name would hash as a different type while looking like the right one. */
static bool str_copy(Str s, char *out, size_t out_size)
{
    if (s.n + 1 > out_size) {
        return false;
    }
    memcpy(out, s.p, s.n);
    out[s.n] = '\0';
    return true;
}

/* ------------------------------------------------------------- CBOR walking */

/**
 * Find `key` in the map whose header sits at `pos`.
 *
 * Returns the value's own header in *out and its offset in *val_pos. The offset
 * is the point of this over cbor_map_find(): a nested struct has to be walked
 * again later, field by field in the order its *type* declares rather than the
 * order the host happened to serialise, so the position has to survive the
 * lookup.
 */
static bool map_find_at(const Ctx *c, size_t pos, Str key,
                        size_t *val_pos, CborItem *out)
{
    CborReader r;
    cbor_reader_init(&r, c->buf, c->len);
    r.pos = pos;

    CborItem head;
    if (!cbor_read(&r, &head) || head.type != CBOR_MAP) {
        return false;
    }

    for (uint32_t i = 0; i < head.value; i++) {
        CborItem k;
        if (!cbor_read(&r, &k) || k.type != CBOR_TEXT) {
            return false;
        }
        if (k.value == key.n && memcmp(k.data, key.p, key.n) == 0) {
            if (val_pos) *val_pos = r.pos;
            return cbor_read(&r, out);
        }
        if (!cbor_skip(&r)) {
            return false;
        }
    }
    return false;
}

static bool map_find_cstr(const Ctx *c, size_t pos, const char *key,
                          size_t *val_pos, CborItem *out)
{
    Str k = {key, strlen(key)};
    return map_find_at(c, pos, k, val_pos, out);
}

/* ------------------------------------------------------------- type table */

/**
 * Read `types` into the table.
 *
 * Types are recorded, not validated: a definition that is never reached by the
 * primary type is never checked, which is correct. Only the types the document
 * actually uses affect the digest, and refusing a request over an unused
 * definition would be refusing something that is fine.
 */
static bool parse_types(Ctx *c)
{
    size_t   types_pos;
    CborItem item;
    if (!map_find_cstr(c, 0, "types", &types_pos, &item) || item.type != CBOR_MAP) {
        return false;
    }

    CborReader r;
    cbor_reader_init(&r, c->buf, c->len);
    r.pos = types_pos;

    CborItem head;
    if (!cbor_read(&r, &head) || head.type != CBOR_MAP) {
        return false;
    }

    for (uint32_t i = 0; i < head.value; i++) {
        CborItem k;
        if (!cbor_read(&r, &k) || k.type != CBOR_TEXT) {
            return false;
        }
        CborItem v;
        if (!cbor_read(&r, &v) || v.type != CBOR_ARRAY) {
            return false;
        }
        if (v.value > EIP712_MAX_FIELDS) {
            return false;
        }

        if (c->type_count >= EIP712_MAX_TYPES) {
            return false;
        }
        TypeDef *t = &c->types[c->type_count++];
        t->name.p = (const char *)k.data;
        t->name.n = k.value;
        t->fields_pos = r.pos;
        t->field_count = v.value;

        /* The reader is on the first field map; step over the whole array so
         * the next key is where the next iteration expects it. */
        for (uint32_t f = 0; f < v.value; f++) {
            if (!cbor_skip(&r)) {
                return false;
            }
        }
    }
    return true;
}

static int find_type(const Ctx *c, Str name)
{
    for (int i = 0; i < c->type_count; i++) {
        if (c->types[i].name.n == name.n &&
            memcmp(c->types[i].name.p, name.p, name.n) == 0) {
            return i;
        }
    }
    return -1;
}

/**
 * The `index`-th declared field of type `t`: its name and its ABI type.
 *
 * Re-walks the array from the start each time. That is quadratic in the field
 * count, which is bounded at twelve — a position cache would be more state to
 * keep correct than the loop it saves.
 */
static bool type_field(const Ctx *c, int t, uint32_t index, Str *name, Str *type)
{
    if (t < 0 || index >= c->types[t].field_count) {
        return false;
    }

    CborReader r;
    cbor_reader_init(&r, c->buf, c->len);
    r.pos = c->types[t].fields_pos;
    for (uint32_t i = 0; i < index; i++) {
        if (!cbor_skip(&r)) return false;
    }

    size_t   field_pos = r.pos;
    CborItem item;
    if (!map_find_cstr(c, field_pos, "name", NULL, &item) || item.type != CBOR_TEXT) {
        return false;
    }
    name->p = (const char *)item.data;
    name->n = item.value;

    if (!map_find_cstr(c, field_pos, "type", NULL, &item) || item.type != CBOR_TEXT) {
        return false;
    }
    type->p = (const char *)item.data;
    type->n = item.value;
    return true;
}

/* ------------------------------------------------------------- encodeType */

/* `Name(type name,type name)`, appended. Returns false if it does not fit. */
static bool append_fragment(const Ctx *c, int t, char *out, size_t out_size, size_t *used)
{
    size_t w = *used;

    #define PUT(ptr, n) do {                            \
        if (w + (n) >= out_size) return false;          \
        memcpy(out + w, (ptr), (n));                    \
        w += (n);                                       \
    } while (0)

    PUT(c->types[t].name.p, c->types[t].name.n);
    PUT("(", 1);
    for (uint32_t i = 0; i < c->types[t].field_count; i++) {
        Str fname, ftype;
        if (!type_field(c, t, i, &fname, &ftype)) return false;
        if (i) PUT(",", 1);
        PUT(ftype.p, ftype.n);
        PUT(" ", 1);
        PUT(fname.p, fname.n);
    }
    PUT(")", 1);
    #undef PUT

    out[w] = '\0';
    *used = w;
    return true;
}

/**
 * Every struct type `t` refers to, transitively, excluding `t` itself.
 *
 * Arrays are refused right here rather than deeper down. `Person[]` would need
 * an array encoding to hash and an array screen to show, and until both exist
 * the honest answer is that this device cannot sign that document at all.
 */
static bool collect_refs(const Ctx *c, int t, int root, int *deps, int *ndeps, int depth)
{
    if (depth > EIP712_MAX_DEPTH) {
        return false;
    }

    for (uint32_t i = 0; i < c->types[t].field_count; i++) {
        Str fname, ftype;
        if (!type_field(c, t, i, &fname, &ftype)) return false;
        if (memchr(ftype.p, '[', ftype.n) != NULL) return false;

        int r = find_type(c, ftype);
        if (r < 0 || r == root) {
            continue;
        }
        bool seen = false;
        for (int j = 0; j < *ndeps; j++) {
            if (deps[j] == r) { seen = true; break; }
        }
        if (seen) {
            continue;
        }
        if (*ndeps >= EIP712_MAX_TYPES) return false;
        deps[(*ndeps)++] = r;
        if (!collect_refs(c, r, root, deps, ndeps, depth + 1)) return false;
    }
    return true;
}

/* EIP-712 orders referenced types by name, and the sort is over the raw type
 * name — so `Aa` sorts before `Ab` and shorter-is-first on a common prefix. An
 * insertion sort over at most eight entries; getting the order wrong changes
 * the typeHash and so the whole digest, silently. */
static void sort_types(const Ctx *c, int *deps, int ndeps)
{
    for (int i = 1; i < ndeps; i++) {
        int key = deps[i];
        int j = i - 1;
        while (j >= 0) {
            Str a = c->types[deps[j]].name, b = c->types[key].name;
            size_t n = a.n < b.n ? a.n : b.n;
            int cmp = memcmp(a.p, b.p, n);
            if (cmp == 0) cmp = (a.n < b.n) ? -1 : (a.n > b.n) ? 1 : 0;
            if (cmp <= 0) break;
            deps[j + 1] = deps[j];
            j--;
        }
        deps[j + 1] = key;
    }
}

static bool encode_type_at(const Ctx *c, int t, char *out, size_t out_size, size_t *len_out)
{
    int deps[EIP712_MAX_TYPES];
    int ndeps = 0;
    if (!collect_refs(c, t, t, deps, &ndeps, 0)) {
        return false;
    }
    sort_types(c, deps, ndeps);

    size_t used = 0;
    if (!append_fragment(c, t, out, out_size, &used)) return false;
    for (int i = 0; i < ndeps; i++) {
        if (!append_fragment(c, deps[i], out, out_size, &used)) return false;
    }
    *len_out = used;
    return true;
}

size_t eip712_encode_type(const uint8_t *payload, size_t len,
                          const char *type_name, char *out, size_t out_size)
{
    Ctx c;
    memset(&c, 0, sizeof(c));
    c.buf = payload;
    c.len = len;
    if (!parse_types(&c)) {
        return 0;
    }

    Str want = {type_name, strlen(type_name)};
    int t = find_type(&c, want);
    if (t < 0) {
        return 0;
    }

    size_t written = 0;
    if (!encode_type_at(&c, t, out, out_size, &written)) {
        return 0;
    }
    return written;
}

static bool type_hash(const Ctx *c, int t, uint8_t out[32])
{
    /* One buffer, sized for the longest encodeType a document within the field
     * and type bounds above can produce. Local rather than shared: hashStruct
     * recurses, and a shared scratch would be overwritten by the child. */
    char   encoded[512];
    size_t n;
    if (!encode_type_at(c, t, encoded, sizeof(encoded), &n)) {
        return false;
    }
    keccak_256((const uint8_t *)encoded, n, out);
    return true;
}

/* -------------------------------------------------------------- ABI types */

typedef enum {
    ABI_ADDRESS,
    ABI_BOOL,
    ABI_STRING,
    ABI_BYTES,      /* dynamic */
    ABI_BYTES_N,
    ABI_UINT,
    ABI_INT,
    ABI_STRUCT,
    ABI_UNSUPPORTED
} AbiKind;

typedef struct {
    AbiKind kind;
    int     bits;      /* uintN/intN */
    int     size;      /* bytesN */
    int     struct_id;
} AbiType;

/* Parse a trailing decimal, e.g. the 256 of uint256. Returns -1 for anything
 * that is not exactly a number, which includes the empty tail: bare `uint` is a
 * legal Solidity alias for uint256 but it is *not* what canonicalises into a
 * typeHash, and accepting it would let one document have two digests. */
static int trailing_number(Str s, size_t prefix)
{
    if (s.n <= prefix) return -1;
    int value = 0;
    for (size_t i = prefix; i < s.n; i++) {
        char ch = s.p[i];
        if (ch < '0' || ch > '9') return -1;
        value = value * 10 + (ch - '0');
        if (value > 256) return -1;
    }
    return value;
}

static bool starts_with(Str s, const char *prefix)
{
    size_t n = strlen(prefix);
    return s.n >= n && memcmp(s.p, prefix, n) == 0;
}

static AbiType classify(const Ctx *c, Str type)
{
    AbiType t = {ABI_UNSUPPORTED, 0, 0, -1};

    if (memchr(type.p, '[', type.n) != NULL) {
        return t;   /* arrays: refused, see collect_refs() */
    }
    if (str_eq_cstr(type, "address")) { t.kind = ABI_ADDRESS; return t; }
    if (str_eq_cstr(type, "bool"))    { t.kind = ABI_BOOL;    return t; }
    if (str_eq_cstr(type, "string"))  { t.kind = ABI_STRING;  return t; }
    if (str_eq_cstr(type, "bytes"))   { t.kind = ABI_BYTES;   return t; }

    if (starts_with(type, "bytes")) {
        int n = trailing_number(type, 5);
        if (n >= 1 && n <= 32) { t.kind = ABI_BYTES_N; t.size = n; return t; }
        return t;
    }
    if (starts_with(type, "uint") || starts_with(type, "int")) {
        bool is_uint = starts_with(type, "uint");
        int  bits = trailing_number(type, is_uint ? 4 : 3);
        if (bits >= 8 && bits <= 256 && bits % 8 == 0) {
            t.kind = is_uint ? ABI_UINT : ABI_INT;
            t.bits = bits;
            return t;
        }
        return t;
    }

    int s = find_type(c, type);
    if (s >= 0) { t.kind = ABI_STRUCT; t.struct_id = s; return t; }
    return t;
}

/* ---------------------------------------------------------------- values */

/**
 * A uintN/intN value from the wire into a left-padded 32-byte word.
 *
 * Two spellings, one meaning: a small value as a CBOR unsigned integer, a large
 * one as a big-endian byte string. Anything wider than the declared type is
 * refused rather than masked — a value that does not fit the field is a value
 * the document is lying about, and silently truncating it would sign a
 * different number than the one that was sent.
 */
static bool word_from_int(const CborItem *item, int bits, uint8_t word[32])
{
    memset(word, 0, 32);

    if (item->type == CBOR_UINT) {
        word[28] = (uint8_t)(item->value >> 24);
        word[29] = (uint8_t)(item->value >> 16);
        word[30] = (uint8_t)(item->value >> 8);
        word[31] = (uint8_t)(item->value);
    } else if (item->type == CBOR_BYTES) {
        if (item->value > 32) return false;
        memcpy(word + (32 - item->value), item->data, item->value);
    } else {
        return false;
    }

    int spare_bits = 256 - bits;
    for (int i = 0; i < spare_bits / 8; i++) {
        if (word[i] != 0) return false;
    }
    return true;
}

/* Whether a value is the "forever" allowance for its own width.
 *
 * The same rule eth-decode.c applies to an ERC-20 approve, generalised to the
 * declared width: 2^(N-1) and up. Permit2 spells unlimited as type(uint160).max
 * and ERC-2612 Permits as type(uint256).max, and several front ends emit values
 * in between; all of them are beyond any real supply and all of them need the
 * same warning. Narrow fields are left alone — a uint32 at 2^31 is a plausible
 * number, not an infinity. */
static bool word_is_unlimited(const uint8_t word[32], int bits)
{
    if (bits < 64) {
        return false;
    }
    int top_byte = 32 - bits / 8;
    return (word[top_byte] & 0x80) != 0;
}

/* ------------------------------------------------------------- rendering */

static bool printable_ascii(const char *s, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if ((unsigned char)s[i] < 0x20 || (unsigned char)s[i] > 0x7e) return false;
    }
    return true;
}

static bool name_hints(Str name, const char *needle)
{
    size_t n = strlen(needle);
    if (name.n < n) return false;
    for (size_t i = 0; i + n <= name.n; i++) {
        size_t j = 0;
        while (j < n) {
            char a = name.p[i + j];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (a != needle[j]) break;
            j++;
        }
        if (j == n) return true;
    }
    return false;
}

/* `0x…` for a byte string, or false if the row cannot hold it.
 *
 * Byte fields are shown whole or not at all. A truncated `bytes32` compares
 * equal to one that is not the same, which is the entire failure mode a user
 * checking a value against a second source is trying to avoid. */
static bool hex_into(const uint8_t *data, size_t n, char *out, size_t out_size)
{
    static const char digits[] = "0123456789abcdef";
    if (2 * n + 3 > out_size) {
        return false;
    }
    out[0] = '0';
    out[1] = 'x';
    for (size_t i = 0; i < n; i++) {
        out[2 + 2 * i]     = digits[data[i] >> 4];
        out[2 + 2 * i + 1] = digits[data[i] & 0x0f];
    }
    out[2 + 2 * n] = '\0';
    return true;
}

/* Claim the next render slot, or mark the document unshowable.
 *
 * Returning NULL is not an error the hash cares about: the caller carries on
 * hashing and the sticky `overflow` decides the outcome at the end. */
static Eip712Field *claim(Collector *col, const char *prefix, Str name)
{
    if (!col) {
        return NULL;
    }
    if (col->out->field_count >= EIP712_MAX_RENDER_FIELDS) {
        col->overflow = true;
        return NULL;
    }

    Eip712Field *f = &col->out->fields[col->out->field_count];
    memzero(f, sizeof(*f));

    int written;
    if (prefix && prefix[0]) {
        written = snprintf(f->label, sizeof(f->label), "%s.%.*s",
                           prefix, (int)name.n, name.p);
    } else {
        written = snprintf(f->label, sizeof(f->label), "%.*s", (int)name.n, name.p);
    }
    /* A label the row cannot hold is the same failure as a value it cannot
     * hold: the user would be reading something other than the field that was
     * hashed. snprintf reports what it *would* have written, so this catches
     * the truncation rather than shipping it. */
    if (written < 0 || (size_t)written >= sizeof(f->label)) {
        col->overflow = true;
        return NULL;
    }

    col->out->field_count++;
    return f;
}

/* ---------------------------------------------------------- encodeData */

static bool hash_struct(const Ctx *c, int t, size_t map_pos, int depth,
                        Collector *col, const char *prefix, uint8_t out[32]);

/**
 * One field of one struct: 32 bytes into the hash, and a page onto the screen.
 *
 * Both come from the same read of the same value. That is the invariant the
 * whole design rests on — there is no path here that renders one thing and
 * hashes another, because there is only one traversal.
 */
static bool encode_field(const Ctx *c, AbiType type, Str name, size_t val_pos,
                         const CborItem *item, int depth, Collector *col,
                         const char *prefix, uint8_t word[32])
{
    Eip712Field *f;

    switch (type.kind) {
        case ABI_ADDRESS: {
            if (item->type != CBOR_BYTES || item->value != 20) return false;
            memset(word, 0, 32);
            memcpy(word + 12, item->data, 20);
            f = claim(col, prefix, name);
            if (f) {
                f->is_address = true;
                memcpy(f->address, item->data, 20);
                if (!eth_format_address(item->data, f->value, sizeof(f->value))) {
                    col->overflow = true;
                }
            }
            return true;
        }

        case ABI_BOOL: {
            if (item->type != CBOR_UINT || item->value > 1) return false;
            memset(word, 0, 32);
            word[31] = (uint8_t)item->value;
            f = claim(col, prefix, name);
            if (f) snprintf(f->value, sizeof(f->value), "%s",
                            item->value ? "true" : "false");
            return true;
        }

        case ABI_UINT:
        case ABI_INT: {
            if (!word_from_int(item, type.bits, word)) return false;
            f = claim(col, prefix, name);
            if (f) {
                /* Deadlines are checked before the unlimited rule, because a
                 * far-future expiry and an infinite allowance are different
                 * warnings and a timestamp is not an amount. */
                f->is_deadline = name_hints(name, "deadline") ||
                                 name_hints(name, "expir") ||
                                 name_hints(name, "validuntil") ||
                                 name_hints(name, "validbefore");
                f->unlimited = !f->is_deadline && type.kind == ABI_UINT &&
                               word_is_unlimited(word, type.bits);

                EthQuantity q;
                if (eth_quantity_set(&q, word, 32) &&
                    eth_format_integer(&q, f->value, sizeof(f->value))) {
                    /* fits */
                } else {
                    col->overflow = true;
                }
            }
            return true;
        }

        case ABI_STRING: {
            if (item->type != CBOR_TEXT) return false;
            keccak_256(item->data, item->value, word);
            f = claim(col, prefix, name);
            if (f) {
                /* The screen holds printable ASCII and one row of it. A string
                 * outside that hashes correctly and cannot be shown, which is
                 * the blind-signing case, not a malformed one. */
                if (item->value + 1 > sizeof(f->value) ||
                    !printable_ascii((const char *)item->data, item->value)) {
                    col->overflow = true;
                } else {
                    memcpy(f->value, item->data, item->value);
                    f->value[item->value] = '\0';
                }
            }
            return true;
        }

        case ABI_BYTES: {
            if (item->type != CBOR_BYTES) return false;
            keccak_256(item->data, item->value, word);
            f = claim(col, prefix, name);
            if (f && !hex_into(item->data, item->value, f->value, sizeof(f->value))) {
                col->overflow = true;
            }
            return true;
        }

        case ABI_BYTES_N: {
            if (item->type != CBOR_BYTES || (int)item->value != type.size) return false;
            /* Right-padded, unlike every other type here. bytesN is the one
             * ABI type that aligns left, and getting it backwards produces a
             * digest that is wrong only for short values. */
            memset(word, 0, 32);
            memcpy(word, item->data, type.size);
            f = claim(col, prefix, name);
            if (f && !hex_into(item->data, item->value, f->value, sizeof(f->value))) {
                col->overflow = true;
            }
            return true;
        }

        case ABI_STRUCT: {
            if (item->type != CBOR_MAP) return false;
            if (depth + 1 > EIP712_MAX_DEPTH) return false;

            /* The nested struct's leaves are flattened into the same page list
             * under a dotted label, so `details.amount` is a page of its own.
             * A page reading "details: (a struct)" would hide precisely the
             * number a Permit2 signature is about. */
            char nested[EIP712_MAX_LABEL];
            int  written;
            if (prefix && prefix[0]) {
                written = snprintf(nested, sizeof(nested), "%s.%.*s", prefix,
                                   (int)name.n, name.p);
            } else {
                written = snprintf(nested, sizeof(nested), "%.*s", (int)name.n, name.p);
            }
            if (written < 0 || (size_t)written >= sizeof(nested)) {
                if (col) col->overflow = true;
                nested[0] = '\0';
            }
            return hash_struct(c, type.struct_id, val_pos, depth + 1, col, nested, word);
        }

        default:
            return false;
    }
}

static bool hash_struct(const Ctx *c, int t, size_t map_pos, int depth,
                        Collector *col, const char *prefix, uint8_t out[32])
{
    if (depth > EIP712_MAX_DEPTH) {
        return false;
    }

    /* Streamed rather than assembled. encodeData is typeHash followed by one
     * 32-byte word per field, and feeding each word to keccak as it is produced
     * keeps a nested document's stack cost at one SHA3 context per level
     * instead of a 32-byte-per-field buffer per level. */
    SHA3_CTX ctx;
    keccak_256_Init(&ctx);

    uint8_t word[32];
    if (!type_hash(c, t, word)) {
        return false;
    }
    keccak_Update(&ctx, word, 32);

    for (uint32_t i = 0; i < c->types[t].field_count; i++) {
        Str fname, ftype;
        if (!type_field(c, t, i, &fname, &ftype)) return false;

        AbiType kind = classify(c, ftype);
        if (kind.kind == ABI_UNSUPPORTED) return false;

        /* Looked up by declared name, in declared order. The host's key order
         * is its own business; EIP-712 hashes fields in the order the type
         * lists them, and a host that reorders its map must not move the
         * digest. */
        size_t   val_pos;
        CborItem item;
        if (!map_find_at(c, map_pos, fname, &val_pos, &item)) {
            return false;
        }

        if (!encode_field(c, kind, fname, val_pos, &item, depth, col, prefix, word)) {
            return false;
        }
        keccak_Update(&ctx, word, 32);
    }

    keccak_Final(&ctx, out);
    memzero(&ctx, sizeof(ctx));
    return true;
}

/* ----------------------------------------------------------------- domain */

/**
 * Pull the three domain fields worth showing out of the domain map.
 *
 * Read for display only — the hash above already walked the same map through
 * the declared EIP712Domain type, so nothing here can change what gets signed.
 * Read separately because the domain is *not* flattened into the field pages:
 * `chainId`, `verifyingContract` and `name` answer "which contract, on which
 * chain, calling itself what", and that question deserves its own screen ahead
 * of the message.
 */
static void read_domain(const Ctx *c, size_t domain_pos, Eip712Render *out)
{
    CborItem item;

    if (map_find_cstr(c, domain_pos, "name", NULL, &item) && item.type == CBOR_TEXT &&
        item.value + 1 <= sizeof(out->domain_name) &&
        printable_ascii((const char *)item.data, item.value)) {
        memcpy(out->domain_name, item.data, item.value);
        out->domain_name[item.value] = '\0';
        out->has_domain_name = true;
    }

    if (map_find_cstr(c, domain_pos, "chainId", NULL, &item)) {
        if (item.type == CBOR_UINT) {
            out->chain_id = item.value;
            out->has_chain_id = true;
        } else if (item.type == CBOR_BYTES && item.value <= 8) {
            uint64_t v = 0;
            for (uint32_t i = 0; i < item.value; i++) {
                v = (v << 8) | item.data[i];
            }
            out->chain_id = v;
            out->has_chain_id = true;
        }
    }

    if (map_find_cstr(c, domain_pos, "verifyingContract", NULL, &item) &&
        item.type == CBOR_BYTES && item.value == 20) {
        memcpy(out->verifying_contract, item.data, 20);
        out->has_verifying_contract = true;
    }
}

/* ---------------------------------------------------------------- public */

Eip712Result eip712_prepare(const uint8_t *payload, size_t len,
                            uint8_t digest[32], Eip712Render *render)
{
    Ctx c;
    memset(&c, 0, sizeof(c));
    c.buf = payload;
    c.len = len;

    memzero(render, sizeof(*render));

    if (!parse_types(&c)) {
        return EIP712_MALFORMED;
    }

    CborItem item;

    if (!map_find_cstr(&c, 0, "primaryType", NULL, &item) || item.type != CBOR_TEXT) {
        return EIP712_MALFORMED;
    }
    Str primary = {(const char *)item.data, item.value};
    if (!str_copy(primary, render->primary_type, sizeof(render->primary_type))) {
        return EIP712_MALFORMED;
    }

    size_t domain_pos, message_pos;
    if (!map_find_cstr(&c, 0, "domain", &domain_pos, &item) || item.type != CBOR_MAP) {
        return EIP712_MALFORMED;
    }
    if (!map_find_cstr(&c, 0, "message", &message_pos, &item) || item.type != CBOR_MAP) {
        return EIP712_MALFORMED;
    }

    Str domain_type = {"EIP712Domain", 12};
    int domain_t = find_type(&c, domain_type);
    int primary_t = find_type(&c, primary);
    if (domain_t < 0 || primary_t < 0) {
        /* A type the document uses but never defines. Not a policy refusal: the
         * digest is undefined, so there is nothing to sign either way. */
        return EIP712_UNHASHABLE;
    }

    Collector col = {render, false};

    uint8_t domain_sep[32];
    if (!hash_struct(&c, domain_t, domain_pos, 0, NULL, NULL, domain_sep)) {
        return EIP712_UNHASHABLE;
    }

    uint8_t message_hash[32];
    if (!hash_struct(&c, primary_t, message_pos, 0, &col, NULL, message_hash)) {
        return EIP712_UNHASHABLE;
    }

    read_domain(&c, domain_pos, render);

    /* keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)).
     *
     * The 0x19 prefix is what keeps a typed-data digest from ever colliding
     * with an RLP-encoded transaction: no valid RLP payload starts with it, so
     * a signature over this can never be replayed as one over a transfer. That
     * is the single most important byte in the file. */
    uint8_t preimage[66];
    preimage[0] = 0x19;
    preimage[1] = 0x01;
    memcpy(preimage + 2, domain_sep, 32);
    memcpy(preimage + 34, message_hash, 32);
    keccak_256(preimage, sizeof(preimage), digest);

    memzero(preimage, sizeof(preimage));
    memzero(domain_sep, sizeof(domain_sep));
    memzero(message_hash, sizeof(message_hash));

    /* A struct with no leaves at all renders as nothing, and a confirmation
     * screen showing nothing is a confirmation that means nothing. */
    if (col.overflow || render->field_count == 0) {
        return EIP712_UNRENDERABLE;
    }
    return EIP712_OK;
}
