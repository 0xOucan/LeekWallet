/**
 * LeekWallet SLIP-0039 — Shamir's Secret-Sharing for Mnemonic Codes
 *
 * Splits a master secret into shares such that a threshold of them recovers
 * it, and recombines them. Implements the SatoshiLabs SLIP-0039 specification
 * (Final), including the two-level group scheme, the Feistel encryption layer
 * over the master secret, RS1024 checksums and the 1024-word SLIP-39 list.
 *
 * WHY A PUBLISHED STANDARD AND NOT OUR OWN SPLIT: a backup exists to survive
 * the device, the vendor and the firmware. A proprietary share format couples
 * the backup's survival to this project's survival, which is exactly the
 * coupling a backup is supposed to break. SLIP-39 is implemented by Trezor and
 * by python-shamir-mnemonic, so shares written on paper today can be recovered
 * by software that has never heard of LeekWallet. That interoperability is the
 * whole point, and it is why this file is tested against the official vectors
 * rather than only against itself — a format that round-trips only with its own
 * encoder is worthless as a backup.
 *
 * SECRETS: every share value, group share and intermediate is key material. All
 * of them are memzero()'d before their buffer goes out of scope, and none of
 * them is ever logged. Callers must do the same with the mnemonics they receive.
 *
 * Interoperability note on `ext`: shares generated here always set the
 * extendable backup flag (ext = 1), as the specification's GenerateShares
 * mandates. Both values are accepted on recovery.
 */

#ifndef SLIP39_BACKUP_H
#define SLIP39_BACKUP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Spec limits. Groups and members are 4-bit fields, hence 16. */
#define SLIP39_MAX_GROUPS      16
#define SLIP39_MAX_MEMBERS     16
#define SLIP39_MAX_SHARES      (SLIP39_MAX_GROUPS * SLIP39_MAX_MEMBERS)

/* Master secret: at least 128 bits, a multiple of 16 bits. 256 bits is the
 * largest we accept, which is also the largest trezor-crypto's shamir.c
 * supports (SHAMIR_MAX_LEN). */
#define SLIP39_MIN_SECRET_LEN  16
#define SLIP39_MAX_SECRET_LEN  32

/* 33 words for a 256-bit secret; longest word is 8 letters, plus separators. */
#define SLIP39_MAX_WORDS       33
#define SLIP39_MNEMONIC_BUF    (SLIP39_MAX_WORDS * 9)

typedef enum {
    SLIP39_OK = 0,
    SLIP39_ERR_PARAM,           /* caller passed nonsense (null, bad T/N, ...) */
    SLIP39_ERR_WORD,            /* a word is not in the SLIP-39 wordlist */
    SLIP39_ERR_WORD_COUNT,      /* too few words, or not a whole number of them */
    SLIP39_ERR_CHECKSUM,        /* RS1024 checksum failed */
    SLIP39_ERR_PADDING,         /* padding too long or padding bits set */
    SLIP39_ERR_SECRET_LEN,      /* share value shorter than 128 bits, or odd */
    SLIP39_ERR_MISMATCH,        /* shares do not belong to the same set */
    SLIP39_ERR_DUPLICATE,       /* the same share index appears twice */
    SLIP39_ERR_THRESHOLD,       /* wrong number of shares/groups supplied */
    SLIP39_ERR_DIGEST,          /* shares combined, but the digest check failed */
    SLIP39_ERR_ENTROPY,         /* the entropy gate refused to produce material */
    SLIP39_ERR_BUFFER,          /* caller's output buffer is too small */
} slip39_error;

/** One decoded share mnemonic. The value is key material. */
typedef struct {
    uint16_t id;                /* 15-bit set identifier */
    uint8_t  ext;               /* extendable backup flag, 0 or 1 */
    uint8_t  iteration_exponent;/* 4 bits; PBKDF2 rounds = 2500 << e */
    uint8_t  group_index;
    uint8_t  group_threshold;   /* actual GT, not the encoded GT-1 */
    uint8_t  group_count;       /* actual G */
    uint8_t  member_index;
    uint8_t  member_threshold;  /* actual T */
    uint8_t  value[SLIP39_MAX_SECRET_LEN];
    uint8_t  value_len;
} slip39_share;

/** One group's (threshold, member count) in a generation request. */
typedef struct {
    uint8_t threshold;
    uint8_t count;
} slip39_group;

/* ------------------------------------------------------------- mnemonics */

/** Decode one mnemonic into a share. Verifies checksum, padding and lengths. */
slip39_error slip39_decode_mnemonic(const char *mnemonic, slip39_share *out);

/** Encode a share as a mnemonic string (words separated by single spaces). */
slip39_error slip39_encode_mnemonic(const slip39_share *share, char *out,
                                    size_t out_len);

/* ------------------------------------------------------- generate/combine */

/**
 * Split `ms` into shares.
 *
 * `groups[group_count]` gives each group's threshold and size; a plain
 * T-of-N backup is group_threshold = 1 with a single group {T, N}.
 * Mnemonics are written to `out` in group order, member order, one per row;
 * `out_capacity` is the number of rows available and `*out_count` receives the
 * number written.
 *
 * Randomness comes from entropy.c's entropy_fill(), never from a bare
 * esp_random(): share values are as much key material as the seed itself
 * (T-1 of them plus the digest reveal the secret), so they must pass the same
 * health checks and the same fail-closed rule that seed generation does. On
 * the host, entropy_fill() deliberately refuses, so tests inject a source with
 * slip39_set_random_source().
 */
slip39_error slip39_generate(uint8_t group_threshold,
                             const slip39_group *groups, uint8_t group_count,
                             const uint8_t *ms, size_t ms_len,
                             const char *passphrase, uint8_t iteration_exponent,
                             char (*out)[SLIP39_MNEMONIC_BUF],
                             size_t out_capacity, size_t *out_count);

/**
 * Recombine mnemonics into the master secret.
 *
 * Applies every validity check the specification lists, so an incomplete or
 * mismatched set is rejected rather than silently producing a wrong secret.
 * The digest embedded at f(254) is verified, which is what distinguishes
 * "wrong shares" from "wrong passphrase" — a wrong passphrase still recovers a
 * valid (different) master secret, by design.
 */
slip39_error slip39_combine(const char *const *mnemonics, size_t count,
                            const char *passphrase,
                            uint8_t *ms, size_t ms_capacity, size_t *ms_len);

/* ------------------------------------------------------------------ test */

/**
 * Override the randomness source. TEST ONLY — production code must leave this
 * unset so generation goes through the entropy gate. Pass NULL to restore.
 */
void slip39_set_random_source(bool (*fn)(uint8_t *buf, size_t len));

#endif /* SLIP39_BACKUP_H */
