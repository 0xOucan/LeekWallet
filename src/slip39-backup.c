/**
 * SLIP-0039 share generation and recovery. See slip39.h for the rationale.
 *
 * Layering, from the bottom up:
 *   - GF(256) interpolation comes from trezor-crypto's shamir.c, which is the
 *     SLIP-39 authors' own constant-time implementation. Rewriting it here
 *     would add a second place for a side-channel to live and no interop.
 *   - The 1024-word list is trezor-crypto's slip39_english.c, already vendored;
 *     a second copy would be 8 KB of flash spent on a divergence risk.
 *   - Everything above that — RS1024, the bit packing, the Feistel encryption
 *     layer, the group/member scheme and the validity rules — is here.
 */

/* Named slip39-backup to avoid colliding with trezor-crypto's slip39.h,
 * which is the wordlist header this file consumes below. */
#include "slip39-backup.h"

#include <string.h>

#include "entropy.h"
#include "hmac.h"
#include "memzero.h"
#include "pbkdf2.h"
#include "shamir.h"
#include "slip39.h" /* trezor-crypto: SLIP39_WORDLIST */

/* x coordinates reserved by the spec: f(255) is the secret, f(254) the digest.
 * Ordinary shares use 0..15, so they can never collide with these. */
#define SECRET_INDEX 255
#define DIGEST_INDEX 254
#define DIGEST_LEN   4

#define METADATA_WORDS 7 /* 4 words of header + 3 words of checksum */
#define CHECKSUM_WORDS 3

/* Bounded on purpose: a legal set can in theory be 16 groups x 16 members, but
 * this runs on a device with tens of kilobytes of stack. 32 covers every
 * realistic backup (a 16-of-16 group, or 16 groups of 2) and keeps the decode
 * table at ~1.4 KB. */
#define MAX_COMBINE_SHARES 32

/* --------------------------------------------------------------- entropy */

static bool (*rng_hook)(uint8_t *buf, size_t len);

void slip39_set_random_source(bool (*fn)(uint8_t *buf, size_t len))
{
    rng_hook = fn;
}

/*
 * All randomness in this file goes through the entropy gate, not through a
 * bare RNG call. A random share y_i is not "just padding": with T-1 of them
 * and the digest share, the secret follows by interpolation, so a predictable
 * share value is as fatal as a predictable seed. entropy_fill() is the only
 * place allowed to produce seed-grade bytes, it health-checks the hardware
 * source and it fails closed rather than degrading silently — which is the
 * exact failure mode that drained Coldcard 4.0.1 wallets. Returning false here
 * must abort generation; there is no fallback source by design.
 */
static bool slip39_random(uint8_t *buf, size_t len)
{
    if (rng_hook) {
        return rng_hook(buf, len);
    }
    return entropy_fill(buf, len);
}

/* -------------------------------------------------------------- wordlist */

/* Exact match, unlike trezor-crypto's word_index(), which matches on a prefix
 * length supplied by the caller. A backup decoder must not accept "acad" for
 * "academic": the checksum would then be validating a word the user never
 * wrote. */
static bool word_to_index(const char *word, size_t len, uint16_t *out)
{
    uint16_t lo = 0, hi = SLIP39_WORD_COUNT;

    while (lo < hi) {
        uint16_t mid = (uint16_t)((lo + hi) / 2);
        const char *w = SLIP39_WORDLIST[mid];
        int cmp = strncmp(w, word, len);
        if (cmp == 0) {
            cmp = (w[len] == '\0') ? 0 : 1;
        }
        if (cmp == 0) {
            *out = mid;
            return true;
        }
        if (cmp < 0) {
            lo = (uint16_t)(mid + 1);
        } else {
            hi = mid;
        }
    }
    return false;
}

/* -------------------------------------------------------------- checksum */

static uint32_t rs1024_polymod(const uint16_t *values, size_t count)
{
    static const uint32_t GEN[10] = {
        0x00e0e040, 0x01c1c080, 0x03838100, 0x07070200, 0x0e0e0009,
        0x1c0c2412, 0x38086c24, 0x3090fc48, 0x21b1f890, 0x03f3f120,
    };
    uint32_t chk = 1;

    for (size_t i = 0; i < count; i++) {
        uint32_t b = chk >> 20;
        chk = ((chk & 0xfffff) << 10) ^ values[i];
        for (int j = 0; j < 10; j++) {
            if ((b >> j) & 1) {
                chk ^= GEN[j];
            }
        }
    }
    return chk;
}

/* The customization string is part of the checksum's domain separation: an
 * extendable share and a non-extendable one with identical data words have
 * different checksums, so one can never be mistaken for the other. */
static const char *customization(uint8_t ext)
{
    return ext ? "shamir_extendable" : "shamir";
}

/* Feeds cs || data through the polymod. `data` is the whole word array,
 * checksum words included for verification and zeroed for creation. */
static uint32_t rs1024(uint8_t ext, const uint16_t *data, size_t count)
{
    const char *cs = customization(ext);
    uint16_t buf[SLIP39_MAX_WORDS + 17];
    size_t n = 0;

    for (const char *p = cs; *p; p++) {
        buf[n++] = (uint16_t)(uint8_t)*p;
    }
    for (size_t i = 0; i < count; i++) {
        buf[n++] = data[i];
    }
    return rs1024_polymod(buf, n);
}

/* ---------------------------------------------------------- bit shuffling */

static uint8_t value_bit(const uint8_t *value, size_t len, size_t idx, size_t pad)
{
    if (idx < pad) {
        return 0; /* leading zero padding */
    }
    size_t b = idx - pad;
    if (b >= len * 8) {
        return 0;
    }
    return (uint8_t)((value[b / 8] >> (7 - (b % 8))) & 1);
}

/* Padding is chosen so the padded share value is a whole number of 10-bit
 * words; it is always fewer than 10 bits and always zero. */
static size_t padding_bits(size_t value_len)
{
    size_t bits = value_len * 8;
    return (10 - (bits % 10)) % 10;
}

/* ------------------------------------------------------- share <-> words */

slip39_error slip39_encode_mnemonic(const slip39_share *share, char *out,
                                    size_t out_len)
{
    if (!share || !out) {
        return SLIP39_ERR_PARAM;
    }
    if (share->value_len < SLIP39_MIN_SECRET_LEN ||
        share->value_len > SLIP39_MAX_SECRET_LEN || (share->value_len % 2) != 0) {
        return SLIP39_ERR_SECRET_LEN;
    }
    if (share->group_threshold < 1 || share->group_threshold > 16 ||
        share->group_count < share->group_threshold || share->group_count > 16 ||
        share->member_threshold < 1 || share->member_threshold > 16 ||
        share->group_index > 15 || share->member_index > 15 ||
        share->iteration_exponent > 15 || share->id > 0x7fff) {
        return SLIP39_ERR_PARAM;
    }

    size_t pad = padding_bits(share->value_len);
    size_t value_words = (share->value_len * 8 + pad) / 10;
    size_t words = 4 + value_words + CHECKSUM_WORDS;

    uint16_t w[SLIP39_MAX_WORDS];

    /* Header: id(15) ext(1) e(4) GI(4) Gt(4) g(4) I(4) t(4) = 40 bits. */
    uint64_t hdr = ((uint64_t)share->id << 25) | ((uint64_t)(share->ext & 1) << 24) |
                   ((uint64_t)share->iteration_exponent << 20) |
                   ((uint64_t)share->group_index << 16) |
                   ((uint64_t)(share->group_threshold - 1) << 12) |
                   ((uint64_t)(share->group_count - 1) << 8) |
                   ((uint64_t)share->member_index << 4) |
                   ((uint64_t)(share->member_threshold - 1));
    for (size_t i = 0; i < 4; i++) {
        w[i] = (uint16_t)((hdr >> (30 - 10 * i)) & 0x3ff);
    }

    for (size_t i = 0; i < value_words; i++) {
        uint16_t v = 0;
        for (size_t b = 0; b < 10; b++) {
            v = (uint16_t)((v << 1) |
                           value_bit(share->value, share->value_len, i * 10 + b, pad));
        }
        w[4 + i] = v;
    }

    w[words - 3] = w[words - 2] = w[words - 1] = 0;
    uint32_t polymod = rs1024(share->ext, w, words) ^ 1;
    for (size_t i = 0; i < 3; i++) {
        w[words - 3 + i] = (uint16_t)((polymod >> (10 * (2 - i))) & 0x3ff);
    }

    size_t pos = 0;
    for (size_t i = 0; i < words; i++) {
        const char *word = SLIP39_WORDLIST[w[i]];
        size_t l = strlen(word);
        if (pos + l + 2 > out_len) {
            memzero(out, out_len);
            return SLIP39_ERR_BUFFER;
        }
        if (i) {
            out[pos++] = ' ';
        }
        memcpy(out + pos, word, l);
        pos += l;
    }
    out[pos] = '\0';
    return SLIP39_OK;
}

slip39_error slip39_decode_mnemonic(const char *mnemonic, slip39_share *out)
{
    if (!mnemonic || !out) {
        return SLIP39_ERR_PARAM;
    }

    uint16_t w[SLIP39_MAX_WORDS];
    size_t words = 0;
    const char *p = mnemonic;

    while (*p) {
        while (*p == ' ') {
            p++;
        }
        if (!*p) {
            break;
        }
        const char *start = p;
        while (*p && *p != ' ') {
            p++;
        }
        size_t len = (size_t)(p - start);
        if (words >= SLIP39_MAX_WORDS) {
            return SLIP39_ERR_WORD_COUNT;
        }
        if (!word_to_index(start, len, &w[words])) {
            return SLIP39_ERR_WORD;
        }
        words++;
    }

    if (words <= METADATA_WORDS) {
        return SLIP39_ERR_WORD_COUNT;
    }

    size_t value_bits = (words - METADATA_WORDS) * 10;
    /* The padding is whatever makes the value a multiple of 16 bits, and the
     * spec caps it at 8 — anything longer means the word count cannot have
     * come from a legal secret length. */
    size_t pad = value_bits % 16;
    if (pad > 8) {
        return SLIP39_ERR_PADDING;
    }
    size_t value_len = (value_bits - pad) / 8;
    if (value_len < SLIP39_MIN_SECRET_LEN) {
        return SLIP39_ERR_SECRET_LEN;
    }
    if (value_len > SLIP39_MAX_SECRET_LEN) {
        return SLIP39_ERR_SECRET_LEN;
    }

    /* The checksum's customization string depends on ext, so it has to be read
     * before the header is assembled: it is bit 24 of the 40-bit header, i.e.
     * bit 4 of the second word. */
    uint8_t ext = (uint8_t)((w[1] >> 4) & 1);
    if (rs1024(ext, w, words) != 1) {
        return SLIP39_ERR_CHECKSUM;
    }

    uint64_t hdr = 0;
    for (size_t i = 0; i < 4; i++) {
        hdr = (hdr << 10) | w[i];
    }
    memzero(out, sizeof(*out));
    out->id                 = (uint16_t)((hdr >> 25) & 0x7fff);
    out->ext                = ext;
    out->iteration_exponent = (uint8_t)((hdr >> 20) & 0xf);
    out->group_index        = (uint8_t)((hdr >> 16) & 0xf);
    out->group_threshold    = (uint8_t)(((hdr >> 12) & 0xf) + 1);
    out->group_count        = (uint8_t)(((hdr >> 8) & 0xf) + 1);
    out->member_index       = (uint8_t)((hdr >> 4) & 0xf);
    out->member_threshold   = (uint8_t)((hdr & 0xf) + 1);
    out->value_len          = (uint8_t)value_len;

    /* Padding bits carry no information, so a nonzero one means the mnemonic
     * was mangled in a way the checksum happened to accept (or was crafted). */
    for (size_t i = 0; i < pad; i++) {
        if ((w[4] >> (9 - i)) & 1) {
            memzero(out, sizeof(*out));
            return SLIP39_ERR_PADDING;
        }
    }

    for (size_t i = 0; i < value_len * 8; i++) {
        size_t bit = i + pad;
        uint8_t v = (uint8_t)((w[4 + bit / 10] >> (9 - (bit % 10))) & 1);
        out->value[i / 8] = (uint8_t)((out->value[i / 8] << 1) | v);
    }

    return SLIP39_OK;
}

/* ------------------------------------------------------ split and recover */

static void share_digest(uint8_t out[DIGEST_LEN], const uint8_t *random_part,
                         size_t random_len, const uint8_t *secret, size_t len)
{
    uint8_t mac[32];
    hmac_sha256_trezor(random_part, (uint32_t)random_len, secret, (uint32_t)len,
                       mac);
    memcpy(out, mac, DIGEST_LEN);
    memzero(mac, sizeof(mac));
}

static slip39_error split_secret(uint8_t threshold, uint8_t count,
                                 const uint8_t *secret, size_t len,
                                 uint8_t out[SLIP39_MAX_MEMBERS][SLIP39_MAX_SECRET_LEN])
{
    if (threshold < 1 || threshold > count || count > SLIP39_MAX_MEMBERS) {
        return SLIP39_ERR_PARAM;
    }
    if (len < SLIP39_MIN_SECRET_LEN || len > SLIP39_MAX_SECRET_LEN || (len % 2)) {
        return SLIP39_ERR_SECRET_LEN;
    }

    /* With threshold 1 every share is the secret itself. The spec allows this
     * only for a single-member group; slip39_generate enforces that, because
     * handing the same secret to several people is not a 1-of-N split. */
    if (threshold == 1) {
        for (uint8_t i = 0; i < count; i++) {
            memcpy(out[i], secret, len);
        }
        return SLIP39_OK;
    }

    slip39_error err = SLIP39_OK;
    uint8_t  base[SLIP39_MAX_MEMBERS + 2][SLIP39_MAX_SECRET_LEN];
    uint8_t  idx[SLIP39_MAX_MEMBERS + 2];
    const uint8_t *ptr[SLIP39_MAX_MEMBERS + 2];
    uint8_t  random_count = (uint8_t)(threshold - 2);

    memzero(base, sizeof(base));

    for (uint8_t i = 0; i < random_count; i++) {
        if (!slip39_random(base[i], len)) {
            err = SLIP39_ERR_ENTROPY;
            goto done;
        }
        idx[i] = i;
        memcpy(out[i], base[i], len);
    }

    /* Digest share: 4 bytes of HMAC over the secret, keyed by the remaining
     * n-4 random bytes. It is what lets recovery tell "these shares belong
     * together" from "these shares interpolate to garbage". */
    if (!slip39_random(base[random_count] + DIGEST_LEN, len - DIGEST_LEN)) {
        err = SLIP39_ERR_ENTROPY;
        goto done;
    }
    share_digest(base[random_count], base[random_count] + DIGEST_LEN,
                 len - DIGEST_LEN, secret, len);
    idx[random_count] = DIGEST_INDEX;

    memcpy(base[random_count + 1], secret, len);
    idx[random_count + 1] = SECRET_INDEX;

    for (uint8_t i = 0; i < threshold; i++) {
        ptr[i] = base[i];
    }

    for (uint8_t i = random_count; i < count; i++) {
        if (!shamir_interpolate(out[i], i, idx, ptr, threshold, len)) {
            err = SLIP39_ERR_PARAM;
            goto done;
        }
    }

done:
    memzero(base, sizeof(base));
    if (err != SLIP39_OK) {
        memzero(out, (size_t)SLIP39_MAX_MEMBERS * SLIP39_MAX_SECRET_LEN);
    }
    return err;
}

static slip39_error recover_secret(uint8_t threshold, const uint8_t *indices,
                                   const uint8_t **values, uint8_t count,
                                   size_t len, uint8_t *out)
{
    if (threshold == 1) {
        memcpy(out, values[0], len);
        return SLIP39_OK;
    }

    uint8_t digest[SLIP39_MAX_SECRET_LEN];
    uint8_t check[DIGEST_LEN];
    slip39_error err = SLIP39_OK;

    if (!shamir_interpolate(out, SECRET_INDEX, indices, values, count, len) ||
        !shamir_interpolate(digest, DIGEST_INDEX, indices, values, count, len)) {
        err = SLIP39_ERR_PARAM;
        goto done;
    }

    share_digest(check, digest + DIGEST_LEN, len - DIGEST_LEN, out, len);
    if (memcmp(check, digest, DIGEST_LEN) != 0) {
        memzero(out, len);
        err = SLIP39_ERR_DIGEST;
    }

done:
    memzero(digest, sizeof(digest));
    memzero(check, sizeof(check));
    return err;
}

/* ------------------------------------------------------------- encryption */

/*
 * Four-round Feistel network with PBKDF2-HMAC-SHA256 as the round function.
 * This is what makes the passphrase work without any verifier: every
 * passphrase decrypts to *some* valid master secret, so an attacker holding
 * the shares cannot tell a wrong guess from a right one, and the owner can
 * keep a plausible-deniability wallet behind a second passphrase.
 */
static void feistel(uint8_t *out, const uint8_t *in, size_t n,
                    const char *passphrase, uint8_t e, uint16_t id, uint8_t ext,
                    bool encrypt)
{
    size_t   half = n / 2;
    uint8_t  L[SLIP39_MAX_SECRET_LEN / 2];
    uint8_t  R[SLIP39_MAX_SECRET_LEN / 2];
    uint8_t  F[SLIP39_MAX_SECRET_LEN / 2];
    uint8_t  pass[1 + 128];
    uint8_t  salt[8 + SLIP39_MAX_SECRET_LEN / 2];
    size_t   pass_len, salt_prefix;
    uint32_t iterations = 2500u << e;

    memcpy(L, in, half);
    memcpy(R, in + half, half);

    const char *pw = passphrase ? passphrase : "";
    size_t pw_len = strlen(pw);
    if (pw_len > sizeof(pass) - 1) {
        pw_len = sizeof(pass) - 1;
    }
    memcpy(pass + 1, pw, pw_len);
    pass_len = pw_len + 1;

    if (ext) {
        /* Extendable backups leave the identifier out of the salt, so the same
         * master secret can later be re-split into a new set of shares that
         * still decrypt with the same passphrase. */
        salt_prefix = 0;
    } else {
        memcpy(salt, "shamir", 6);
        salt[6]     = (uint8_t)(id >> 8);
        salt[7]     = (uint8_t)(id & 0xff);
        salt_prefix = 8;
    }

    for (uint8_t k = 0; k < 4; k++) {
        pass[0] = encrypt ? k : (uint8_t)(3 - k);
        memcpy(salt + salt_prefix, R, half);
        pbkdf2_hmac_sha256(pass, (int)pass_len, salt, (int)(salt_prefix + half),
                           iterations, F, (int)half);
        for (size_t i = 0; i < half; i++) {
            F[i] ^= L[i];
        }
        memcpy(L, R, half);
        memcpy(R, F, half);
    }

    memcpy(out, R, half);
    memcpy(out + half, L, half);

    memzero(L, sizeof(L));
    memzero(R, sizeof(R));
    memzero(F, sizeof(F));
    memzero(pass, sizeof(pass));
    memzero(salt, sizeof(salt));
}

/* -------------------------------------------------------------- generate */

slip39_error slip39_generate(uint8_t group_threshold, const slip39_group *groups,
                             uint8_t group_count, const uint8_t *ms, size_t ms_len,
                             const char *passphrase, uint8_t iteration_exponent,
                             char (*out)[SLIP39_MNEMONIC_BUF], size_t out_capacity,
                             size_t *out_count)
{
    if (!groups || !ms || !out || !out_count) {
        return SLIP39_ERR_PARAM;
    }
    if (group_count < 1 || group_count > SLIP39_MAX_GROUPS ||
        group_threshold < 1 || group_threshold > group_count ||
        iteration_exponent > 15) {
        return SLIP39_ERR_PARAM;
    }
    if (ms_len < SLIP39_MIN_SECRET_LEN || ms_len > SLIP39_MAX_SECRET_LEN ||
        (ms_len % 2)) {
        return SLIP39_ERR_SECRET_LEN;
    }

    size_t total = 0;
    for (uint8_t i = 0; i < group_count; i++) {
        if (groups[i].count < 1 || groups[i].count > SLIP39_MAX_MEMBERS ||
            groups[i].threshold < 1 || groups[i].threshold > groups[i].count) {
            return SLIP39_ERR_PARAM;
        }
        /* A 1-of-N group would hand N people the identical share, which is a
         * copy, not a split. The spec forbids it; so do we. */
        if (groups[i].threshold == 1 && groups[i].count > 1) {
            return SLIP39_ERR_PARAM;
        }
        total += groups[i].count;
    }
    if (total > out_capacity) {
        return SLIP39_ERR_BUFFER;
    }

    /* Cleared before anything can fail, so no caller ever reads a stale count
     * off an aborted generation. */
    *out_count = 0;

    slip39_error err = SLIP39_OK;
    uint8_t ems[SLIP39_MAX_SECRET_LEN];
    uint8_t group_shares[SLIP39_MAX_GROUPS][SLIP39_MAX_SECRET_LEN];
    uint8_t member_shares[SLIP39_MAX_MEMBERS][SLIP39_MAX_SECRET_LEN];
    uint8_t id_bytes[2];
    slip39_share share;

    memzero(group_shares, sizeof(group_shares));
    memzero(member_shares, sizeof(member_shares));
    memzero(&share, sizeof(share));

    if (!slip39_random(id_bytes, sizeof(id_bytes))) {
        return SLIP39_ERR_ENTROPY;
    }
    uint16_t id = (uint16_t)(((id_bytes[0] << 8) | id_bytes[1]) & 0x7fff);

    /* ext = 1 always, per GenerateShares step 3. */
    feistel(ems, ms, ms_len, passphrase, iteration_exponent, id, 1, true);

    err = split_secret(group_threshold, group_count, ems, ms_len, group_shares);
    if (err != SLIP39_OK) {
        goto done;
    }

    for (uint8_t g = 0; g < group_count; g++) {
        err = split_secret(groups[g].threshold, groups[g].count, group_shares[g],
                           ms_len, member_shares);
        if (err != SLIP39_OK) {
            goto done;
        }
        for (uint8_t m = 0; m < groups[g].count; m++) {
            share.id                 = id;
            share.ext                = 1;
            share.iteration_exponent = iteration_exponent;
            share.group_index        = g;
            share.group_threshold    = group_threshold;
            share.group_count        = group_count;
            share.member_index       = m;
            share.member_threshold   = groups[g].threshold;
            share.value_len          = (uint8_t)ms_len;
            memcpy(share.value, member_shares[m], ms_len);

            err = slip39_encode_mnemonic(&share, out[*out_count],
                                         SLIP39_MNEMONIC_BUF);
            memzero(&share, sizeof(share));
            if (err != SLIP39_OK) {
                goto done;
            }
            (*out_count)++;
        }
    }

done:
    memzero(ems, sizeof(ems));
    memzero(group_shares, sizeof(group_shares));
    memzero(member_shares, sizeof(member_shares));
    memzero(&share, sizeof(share));
    if (err != SLIP39_OK) {
        for (size_t i = 0; i < out_capacity; i++) {
            memzero(out[i], SLIP39_MNEMONIC_BUF);
        }
        *out_count = 0;
    }
    return err;
}

/* --------------------------------------------------------------- combine */

slip39_error slip39_combine(const char *const *mnemonics, size_t count,
                            const char *passphrase, uint8_t *ms,
                            size_t ms_capacity, size_t *ms_len)
{
    if (!mnemonics || !ms || !ms_len || count == 0) {
        return SLIP39_ERR_PARAM;
    }
    if (count > MAX_COMBINE_SHARES) {
        return SLIP39_ERR_PARAM;
    }

    slip39_error err   = SLIP39_OK;
    slip39_share *sh   = NULL;
    slip39_share table[MAX_COMBINE_SHARES];
    uint8_t group_shares[SLIP39_MAX_GROUPS][SLIP39_MAX_SECRET_LEN];
    uint8_t group_idx[SLIP39_MAX_GROUPS];
    const uint8_t *group_ptr[SLIP39_MAX_GROUPS];
    uint8_t ems[SLIP39_MAX_SECRET_LEN];
    uint8_t out[SLIP39_MAX_SECRET_LEN];

    memzero(table, sizeof(table));
    memzero(group_shares, sizeof(group_shares));

    for (size_t i = 0; i < count; i++) {
        err = slip39_decode_mnemonic(mnemonics[i], &table[i]);
        if (err != SLIP39_OK) {
            goto done;
        }
    }
    sh = &table[0];

    /* Every share of a set agrees on the header. A mismatch means the user
     * mixed two different backups, which must never silently produce a key. */
    for (size_t i = 1; i < count; i++) {
        if (table[i].id != sh->id || table[i].ext != sh->ext ||
            table[i].iteration_exponent != sh->iteration_exponent ||
            table[i].group_threshold != sh->group_threshold ||
            table[i].group_count != sh->group_count ||
            table[i].value_len != sh->value_len) {
            err = SLIP39_ERR_MISMATCH;
            goto done;
        }
    }
    if (sh->group_count < sh->group_threshold) {
        err = SLIP39_ERR_MISMATCH;
        goto done;
    }

    size_t len = sh->value_len;
    uint8_t groups_seen = 0;

    for (size_t i = 0; i < count; i++) {
        bool known = false;
        for (uint8_t g = 0; g < groups_seen; g++) {
            if (group_idx[g] == table[i].group_index) {
                known = true;
                break;
            }
        }
        if (known) {
            continue;
        }
        if (groups_seen >= SLIP39_MAX_GROUPS) {
            err = SLIP39_ERR_PARAM;
            goto done;
        }
        group_idx[groups_seen++] = table[i].group_index;
    }

    /* Exactly the threshold number of groups: more is not "extra safety", it
     * means the user supplied shares the set does not need and we would be
     * guessing which to use. */
    if (groups_seen != sh->group_threshold) {
        err = SLIP39_ERR_THRESHOLD;
        goto done;
    }

    for (uint8_t g = 0; g < groups_seen; g++) {
        uint8_t member_idx[SLIP39_MAX_MEMBERS];
        const uint8_t *member_ptr[SLIP39_MAX_MEMBERS];
        uint8_t members   = 0;
        uint8_t threshold = 0;

        for (size_t i = 0; i < count; i++) {
            if (table[i].group_index != group_idx[g]) {
                continue;
            }
            if (members == 0) {
                threshold = table[i].member_threshold;
            } else if (table[i].member_threshold != threshold) {
                err = SLIP39_ERR_MISMATCH;
                goto done;
            }
            for (uint8_t m = 0; m < members; m++) {
                if (member_idx[m] == table[i].member_index) {
                    err = SLIP39_ERR_DUPLICATE;
                    goto done;
                }
            }
            if (members >= SLIP39_MAX_MEMBERS) {
                err = SLIP39_ERR_PARAM;
                goto done;
            }
            member_idx[members] = table[i].member_index;
            member_ptr[members] = table[i].value;
            members++;
        }

        if (members != threshold) {
            err = SLIP39_ERR_THRESHOLD;
            goto done;
        }

        err = recover_secret(threshold, member_idx, member_ptr, members, len,
                             group_shares[g]);
        if (err != SLIP39_OK) {
            goto done;
        }
        group_ptr[g] = group_shares[g];
    }

    err = recover_secret(sh->group_threshold, group_idx, group_ptr, groups_seen,
                         len, ems);
    if (err != SLIP39_OK) {
        goto done;
    }

    feistel(out, ems, len, passphrase, sh->iteration_exponent, sh->id, sh->ext,
            false);

    if (ms_capacity < len) {
        err = SLIP39_ERR_BUFFER;
        goto done;
    }
    memcpy(ms, out, len);
    *ms_len = len;

done:
    memzero(table, sizeof(table));
    memzero(group_shares, sizeof(group_shares));
    memzero(ems, sizeof(ems));
    memzero(out, sizeof(out));
    if (err != SLIP39_OK) {
        *ms_len = 0;
    }
    return err;
}
