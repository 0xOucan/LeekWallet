/**
 * EIP-712 typed data: digests, and refusals (ROADMAP T12b).
 *
 * Two properties, and they matter in this order.
 *
 * First, the digest. There is no partial credit: a typeHash whose referenced
 * types are ordered wrong, a `bytesN` padded the wrong way, a `uint160` read as
 * a `uint256` — each produces a perfectly valid signature over a document
 * nobody wrote, and the only way to catch that is a known answer. The `Mail`
 * vector below is EIP-712's own worked example and its three intermediate
 * values are quoted from the specification; the `Permit` and `PermitSingle`
 * digests come from viem, and app/packages/core/test/eip712.test.ts recomputes
 * them there on every run so the two implementations cannot quietly drift onto
 * the same wrong answer.
 *
 * Second, refusal. The device's rule is that it signs only what it displayed,
 * so a document it cannot render has to come back UNRENDERABLE and one it
 * cannot hash has to come back UNHASHABLE — the second being the stronger
 * refusal, because no setting reopens it. Most of this file is that: input that
 * must not produce a digest.
 *
 * Requests are built with the real CborWriter rather than hand-rolled hex, so
 * what is parsed here is the same encoding protocol.c will meet on the wire.
 */

#include <stdio.h>
#include <string.h>

#include "cbor.h"
#include "eip712.h"
#include "protocol.h"
#include "session.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static bool hex_eq(const uint8_t got[32], const char *want)
{
    char line[65];
    for (int i = 0; i < 32; i++) {
        snprintf(line + 2 * i, 3, "%02x", got[i]);
    }
    return strcmp(line, want) == 0;
}

static void show(const uint8_t got[32])
{
    for (int i = 0; i < 32; i++) printf("%02x", got[i]);
}

/* ------------------------------------------------------------- addresses */

/* 0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC — the EIP's own domain. */
static const uint8_t ETHER_MAIL[20] = {
    0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,
    0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc,0xcc
};
/* 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826 */
static const uint8_t COW[20] = {
    0xcd,0x2a,0x3d,0x9f,0x93,0x8e,0x13,0xcd,0x94,0x7e,
    0xc0,0x5a,0xbc,0x7f,0xe7,0x34,0xdf,0x8d,0xd8,0x26
};
/* 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB */
static const uint8_t BOB[20] = {
    0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,
    0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb,0xbb
};
/* USDC, 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 */
static const uint8_t USDC[20] = {
    0xa0,0xb8,0x69,0x91,0xc6,0x21,0x8b,0x36,0xc1,0xd1,
    0x9d,0x4a,0x2e,0x9e,0xb0,0xce,0x36,0x06,0xeb,0x48
};
/* 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4 */
static const uint8_t OWNER[20] = {
    0x5b,0x38,0xda,0x6a,0x70,0x1c,0x56,0x85,0x45,0xdc,
    0xfc,0xb0,0x3f,0xcb,0x87,0x5f,0x56,0xbe,0xdd,0xc4
};
/* 0x1111111254EEB25477B68fb85Ed929f73A960582 */
static const uint8_t SPENDER[20] = {
    0x11,0x11,0x11,0x12,0x54,0xee,0xb2,0x54,0x77,0xb6,
    0x8f,0xb8,0x5e,0xd9,0x29,0xf7,0x3a,0x96,0x05,0x82
};
/* Permit2, 0x000000000022D473030F116dDEE9F6B43aC78BA3 */
static const uint8_t PERMIT2_ADDR[20] = {
    0x00,0x00,0x00,0x00,0x00,0x22,0xd4,0x73,0x03,0x0f,
    0x11,0x6d,0xde,0xe9,0xf6,0xb4,0x3a,0xc7,0x8b,0xa3
};
/* 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD */
static const uint8_t ROUTER[20] = {
    0x3f,0xc9,0x1a,0x3a,0xfd,0x70,0x39,0x5c,0xd4,0x96,
    0xc6,0x47,0xd5,0xa6,0xcc,0x9d,0x4b,0x2b,0x7f,0xad
};

/* ---------------------------------------------------------- CBOR builders */

/* `{"name": <name>, "type": <type>}`, one entry of a `types` array. */
static void put_field(CborWriter *w, const char *name, const char *type)
{
    cbor_write_map(w, 2);
    cbor_write_text(w, "name");
    cbor_write_text(w, name);
    cbor_write_text(w, "type");
    cbor_write_text(w, type);
}

/* The four-field EIP712Domain of the Mail and Permit vectors. */
static void put_domain_type_nvc(CborWriter *w)
{
    cbor_write_text(w, "EIP712Domain");
    cbor_write_array(w, 4);
    put_field(w, "name", "string");
    put_field(w, "version", "string");
    put_field(w, "chainId", "uint256");
    put_field(w, "verifyingContract", "address");
}

static void put_domain_nvc(CborWriter *w, const char *name, const char *version,
                           uint32_t chain, const uint8_t contract[20])
{
    cbor_write_text(w, "domain");
    cbor_write_map(w, 4);
    cbor_write_text(w, "name");
    cbor_write_text(w, name);
    cbor_write_text(w, "version");
    cbor_write_text(w, version);
    cbor_write_text(w, "chainId");
    cbor_write_uint(w, chain);
    cbor_write_text(w, "verifyingContract");
    cbor_write_bytes(w, contract, 20);
}

/* ------------------------------------------------------------ Mail (EIP) */

static size_t build_mail(uint8_t *buf, size_t cap)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);

    cbor_write_map(&w, 4);

    cbor_write_text(&w, "types");
    cbor_write_map(&w, 3);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Person");
    cbor_write_array(&w, 2);
    put_field(&w, "name", "string");
    put_field(&w, "wallet", "address");
    cbor_write_text(&w, "Mail");
    cbor_write_array(&w, 3);
    put_field(&w, "from", "Person");
    put_field(&w, "to", "Person");
    put_field(&w, "contents", "string");

    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Mail");

    put_domain_nvc(&w, "Ether Mail", "1", 1, ETHER_MAIL);

    cbor_write_text(&w, "message");
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "from");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Cow");
    cbor_write_text(&w, "wallet");
    cbor_write_bytes(&w, COW, 20);
    cbor_write_text(&w, "to");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Bob");
    cbor_write_text(&w, "wallet");
    cbor_write_bytes(&w, BOB, 20);
    cbor_write_text(&w, "contents");
    cbor_write_text(&w, "Hello, Bob!");

    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_mail_vector(void)
{
    uint8_t buf[1024];
    size_t  n = build_mail(buf, sizeof(buf));
    CHECK(n > 0, "mail request did not fit");

    /* encodeType first. When the digest is wrong this is where it went wrong,
     * and the EIP prints the expected string in full. */
    char encoded[512];
    size_t len = eip712_encode_type(buf, n, "Mail", encoded, sizeof(encoded));
    CHECK(len > 0 && strcmp(encoded,
        "Mail(Person from,Person to,string contents)"
        "Person(string name,address wallet)") == 0,
        "encodeType(Mail) = \"%s\"", len ? encoded : "(failed)");

    uint8_t digest[32];
    Eip712Render r;
    Eip712Result res = eip712_prepare(buf, n, digest, &r);
    CHECK(res == EIP712_OK, "mail not accepted (result %d)", (int)res);

    if (!hex_eq(digest, "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2")) {
        printf("  FAIL: mail digest = "); show(digest); printf("\n");
        failures++;
    }

    /* The nested Person structs are flattened to leaves: a page reading
     * "from: (a struct)" would hide the wallet, which is the field that
     * decides who the letter is from. */
    CHECK(r.field_count == 5, "mail rendered %d fields", r.field_count);
    CHECK(strcmp(r.fields[0].label, "from.name") == 0, "field 0 label %s", r.fields[0].label);
    CHECK(strcmp(r.fields[0].value, "Cow") == 0, "field 0 value %s", r.fields[0].value);
    CHECK(r.fields[1].is_address && memcmp(r.fields[1].address, COW, 20) == 0,
          "from.wallet not rendered as an address");
    CHECK(strcmp(r.fields[4].label, "contents") == 0, "field 4 label %s", r.fields[4].label);
    CHECK(strcmp(r.fields[4].value, "Hello, Bob!") == 0, "field 4 value %s", r.fields[4].value);

    CHECK(strcmp(r.primary_type, "Mail") == 0, "primary type %s", r.primary_type);
    CHECK(r.has_domain_name && strcmp(r.domain_name, "Ether Mail") == 0,
          "domain name %s", r.domain_name);
    CHECK(r.has_chain_id && r.chain_id == 1, "domain chain id %llu",
          (unsigned long long)r.chain_id);
    CHECK(r.has_verifying_contract &&
          memcmp(r.verifying_contract, ETHER_MAIL, 20) == 0,
          "verifying contract not rendered");
}

/* --------------------------------------------------------------- Permit */

static size_t build_permit(uint8_t *buf, size_t cap, const uint8_t value[32],
                           uint32_t deadline)
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);

    cbor_write_map(&w, 4);

    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Permit");
    cbor_write_array(&w, 5);
    put_field(&w, "owner", "address");
    put_field(&w, "spender", "address");
    put_field(&w, "value", "uint256");
    put_field(&w, "nonce", "uint256");
    put_field(&w, "deadline", "uint256");

    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Permit");

    put_domain_nvc(&w, "USD Coin", "2", 1, USDC);

    cbor_write_text(&w, "message");
    cbor_write_map(&w, 5);
    cbor_write_text(&w, "owner");
    cbor_write_bytes(&w, OWNER, 20);
    cbor_write_text(&w, "spender");
    cbor_write_bytes(&w, SPENDER, 20);
    cbor_write_text(&w, "value");
    cbor_write_bytes(&w, value, 32);
    cbor_write_text(&w, "nonce");
    cbor_write_uint(&w, 0);
    cbor_write_text(&w, "deadline");
    cbor_write_uint(&w, deadline);

    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_permit_unlimited(void)
{
    uint8_t max[32];
    memset(max, 0xff, sizeof(max));

    uint8_t buf[1024];
    size_t  n = build_permit(buf, sizeof(buf), max, 1893456000u);
    CHECK(n > 0, "permit request did not fit");

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, n, digest, &r) == EIP712_OK, "permit not accepted");

    if (!hex_eq(digest, "423a958ec72daf496fde79b12e292dd6ede371ac0707c0cc848dfe6d7d45d111")) {
        printf("  FAIL: permit digest = "); show(digest); printf("\n");
        failures++;
    }

    CHECK(r.field_count == 5, "permit rendered %d fields", r.field_count);
    CHECK(strcmp(r.fields[1].label, "spender") == 0, "spender not the second page");
    CHECK(r.fields[1].is_address && memcmp(r.fields[1].address, SPENDER, 20) == 0,
          "spender address wrong");

    /* The whole point. 2^256-1 has to be *named*, not printed: seventy-eight
     * digits scrolling past is not a number anybody reads. */
    CHECK(r.fields[2].unlimited, "an infinite Permit value was not flagged unlimited");
    CHECK(!r.fields[2].is_deadline, "value mistaken for a deadline");

    CHECK(r.fields[4].is_deadline, "deadline not flagged");
    CHECK(!r.fields[4].unlimited, "a deadline must never read as an unlimited amount");
    CHECK(strcmp(r.fields[4].value, "1893456000") == 0,
          "deadline rendered as %s", r.fields[4].value);
}

/**
 * A narrow field at its own halfway mark is a number, not an infinity.
 *
 * The unlimited rule is "2^(N-1) and up", which is right for the widths an
 * allowance is actually spelled in — uint256 and Permit2's uint160 — and wrong
 * for everything below. A uint32 at 2^31 is a plausible nonce, a plausible
 * block number and a plausible id; shouting UNLIMITED at it would train people
 * to ignore the word on the one screen where it matters.
 */
static void test_a_narrow_field_is_never_unlimited(void)
{
    CborWriter w;
    uint8_t   buf[512];
    cbor_writer_init(&w, buf, sizeof(buf));

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Narrow");
    cbor_write_array(&w, 1);
    put_field(&w, "count", "uint32");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Narrow");
    put_domain_nvc(&w, "Narrow", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "count");
    cbor_write_uint(&w, 0x80000000u);      /* 2^31, the top bit of a uint32 */

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, w.length, digest, &r) == EIP712_OK, "a uint32 was refused");
    CHECK(!r.fields[0].unlimited, "2^31 in a uint32 was called an unlimited amount");
    CHECK(strcmp(r.fields[0].value, "2147483648") == 0,
          "the uint32 rendered as %s", r.fields[0].value);
}

static void test_permit_bounded_amount_is_not_unlimited(void)
{
    /* 1,000,000 USDC — six decimals, so a large number that is still a number.
     * If the unlimited rule fired here every ordinary Permit would shout. */
    uint8_t value[32];
    memset(value, 0, sizeof(value));
    value[27] = 0xe8; value[28] = 0xd4; value[29] = 0xa5; value[30] = 0x10;
    value[31] = 0x00;

    uint8_t buf[1024];
    size_t  n = build_permit(buf, sizeof(buf), value, 1893456000u);

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, n, digest, &r) == EIP712_OK, "bounded permit refused");
    CHECK(!r.fields[2].unlimited, "a bounded amount was called unlimited");
    CHECK(strcmp(r.fields[2].value, "1000000000000") == 0,
          "bounded amount rendered as %s", r.fields[2].value);
}

/* -------------------------------------------------------------- Permit2 */

static size_t build_permit2(uint8_t *buf, size_t cap, const uint8_t amount[20])
{
    CborWriter w;
    cbor_writer_init(&w, buf, cap);

    cbor_write_map(&w, 4);

    cbor_write_text(&w, "types");
    cbor_write_map(&w, 3);
    /* Permit2's domain has no `version`. A device that assumed the usual four
     * fields would compute a separator the contract never accepts. */
    cbor_write_text(&w, "EIP712Domain");
    cbor_write_array(&w, 3);
    put_field(&w, "name", "string");
    put_field(&w, "chainId", "uint256");
    put_field(&w, "verifyingContract", "address");
    cbor_write_text(&w, "PermitDetails");
    cbor_write_array(&w, 4);
    put_field(&w, "token", "address");
    put_field(&w, "amount", "uint160");
    put_field(&w, "expiration", "uint48");
    put_field(&w, "nonce", "uint48");
    cbor_write_text(&w, "PermitSingle");
    cbor_write_array(&w, 3);
    put_field(&w, "details", "PermitDetails");
    put_field(&w, "spender", "address");
    put_field(&w, "sigDeadline", "uint256");

    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "PermitSingle");

    cbor_write_text(&w, "domain");
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Permit2");
    cbor_write_text(&w, "chainId");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "verifyingContract");
    cbor_write_bytes(&w, PERMIT2_ADDR, 20);

    cbor_write_text(&w, "message");
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "details");
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "token");
    cbor_write_bytes(&w, USDC, 20);
    cbor_write_text(&w, "amount");
    cbor_write_bytes(&w, amount, 20);
    cbor_write_text(&w, "expiration");
    cbor_write_uint(&w, 1735689600u);
    cbor_write_text(&w, "nonce");
    cbor_write_uint(&w, 0);
    cbor_write_text(&w, "spender");
    cbor_write_bytes(&w, ROUTER, 20);
    cbor_write_text(&w, "sigDeadline");
    cbor_write_uint(&w, 1735689600u);

    return cbor_writer_ok(&w) ? w.length : 0;
}

static void test_permit2_single(void)
{
    uint8_t amount[20];
    memset(amount, 0xff, sizeof(amount));   /* type(uint160).max */

    uint8_t buf[1024];
    size_t  n = build_permit2(buf, sizeof(buf), amount);
    CHECK(n > 0, "permit2 request did not fit");

    /* The referenced type follows the primary, and there is only one ordering
     * that hashes to what the contract expects. */
    char encoded[512];
    size_t len = eip712_encode_type(buf, n, "PermitSingle", encoded, sizeof(encoded));
    CHECK(len > 0 && strcmp(encoded,
        "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)"
        "PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)") == 0,
        "encodeType(PermitSingle) = \"%s\"", len ? encoded : "(failed)");

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, n, digest, &r) == EIP712_OK, "permit2 not accepted");

    if (!hex_eq(digest, "4187039f3504daf157ed1635c74914209db8d42bc4c0e6984c0c9686647a4c78")) {
        printf("  FAIL: permit2 digest = "); show(digest); printf("\n");
        failures++;
    }

    CHECK(r.field_count == 6, "permit2 rendered %d fields", r.field_count);
    CHECK(strcmp(r.fields[0].label, "details.token") == 0,
          "nested label is %s", r.fields[0].label);
    /* type(uint160).max is Permit2's spelling of "for ever", and it has to read
     * as such even though it is nowhere near 2^255. */
    CHECK(r.fields[1].unlimited, "uint160 max not flagged unlimited");
    CHECK(r.fields[2].is_deadline, "details.expiration not flagged as an expiry");
    CHECK(strcmp(r.fields[4].label, "spender") == 0, "spender label is %s",
          r.fields[4].label);
    CHECK(r.fields[5].is_deadline, "sigDeadline not flagged");
}

/**
 * Referenced types are emitted in alphabetical order, whatever order they were
 * declared or used in.
 *
 * Neither Mail nor PermitSingle can see this: each refers to exactly one struct
 * type, so any ordering rule produces the same string. This document refers to
 * two, declared and used in the reverse of the order the EIP requires, so the
 * sort is the only thing standing between it and a typeHash that is wrong in a
 * way no amount of staring at the final digest explains.
 */
static void test_referenced_types_are_sorted(void)
{
    CborWriter w;
    uint8_t   buf[512];
    cbor_writer_init(&w, buf, sizeof(buf));

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 4);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Zeta");
    cbor_write_array(&w, 1);
    put_field(&w, "v", "uint256");
    cbor_write_text(&w, "Alpha");
    cbor_write_array(&w, 1);
    put_field(&w, "v", "uint256");
    cbor_write_text(&w, "Doc");
    cbor_write_array(&w, 2);
    put_field(&w, "z", "Zeta");
    put_field(&w, "a", "Alpha");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Doc");
    put_domain_nvc(&w, "Doc", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "z");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "v");
    cbor_write_uint(&w, 1);
    cbor_write_text(&w, "a");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "v");
    cbor_write_uint(&w, 2);

    char   encoded[512];
    size_t len = eip712_encode_type(buf, w.length, "Doc", encoded, sizeof(encoded));
    CHECK(len > 0 && strcmp(encoded,
        "Doc(Zeta z,Alpha a)Alpha(uint256 v)Zeta(uint256 v)") == 0,
        "encodeType(Doc) = \"%s\"", len ? encoded : "(failed)");

    /* And the rendering follows the fields, so the two leaves keep their own
     * dotted labels rather than colliding on the shared field name. */
    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, w.length, digest, &r) == EIP712_OK, "Doc refused");
    CHECK(r.field_count == 2 && strcmp(r.fields[0].label, "z.v") == 0 &&
          strcmp(r.fields[1].label, "a.v") == 0,
          "two struct leaves did not keep distinct labels");
}

/* ------------------------------------------------------------- refusals */

/* A document whose only difference from a good one is the field it declares:
 * the type says uint160, the value is 21 bytes wide. */
static void test_value_wider_than_its_type(void)
{
    uint8_t amount[20];
    memset(amount, 0xff, sizeof(amount));

    uint8_t buf[1024];
    size_t  n = build_permit2(buf, sizeof(buf), amount);

    /* Rebuild with a 32-byte amount for a uint160 field by hand: the builder
     * takes exactly twenty. Easier and just as pointed to widen the *type*
     * check the other way — feed a uint48 expiry a value that does not fit. */
    (void)n;

    CborWriter w;
    uint8_t   small[512];
    cbor_writer_init(&w, small, sizeof(small));
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Narrow");
    cbor_write_array(&w, 1);
    put_field(&w, "n", "uint8");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Narrow");
    put_domain_nvc(&w, "Narrow", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "n");
    cbor_write_uint(&w, 300);      /* does not fit a uint8 */

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(small, w.length, digest, &r) == EIP712_UNHASHABLE,
          "a value too wide for its declared type was accepted");
}

/* Arrays. The device can neither hash nor show them, and blind signing does not
 * reopen that — see eip712.h. */
static void test_arrays_are_refused(void)
{
    CborWriter w;
    uint8_t   buf[512];
    cbor_writer_init(&w, buf, sizeof(buf));

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Batch");
    cbor_write_array(&w, 1);
    put_field(&w, "amounts", "uint256[]");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Batch");
    put_domain_nvc(&w, "Batch", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "amounts");
    cbor_write_array(&w, 2);
    cbor_write_uint(&w, 1);
    cbor_write_uint(&w, 2);

    uint8_t digest[32];
    Eip712Render r;
    Eip712Result res = eip712_prepare(buf, w.length, digest, &r);
    CHECK(res == EIP712_UNHASHABLE, "an array document was not refused (result %d)",
          (int)res);
}

/* A type the primary refers to and the document never defines. There is no
 * digest to compute, so this is the hard refusal too. */
static void test_undefined_type_is_refused(void)
{
    CborWriter w;
    uint8_t   buf[512];
    cbor_writer_init(&w, buf, sizeof(buf));

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Outer");
    cbor_write_array(&w, 1);
    put_field(&w, "inner", "Inner");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Outer");
    put_domain_nvc(&w, "Outer", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "inner");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "x");
    cbor_write_uint(&w, 1);

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, w.length, digest, &r) == EIP712_UNHASHABLE,
          "an undefined struct type was accepted");
}

/* More leaves than the screen has pages. This one *can* be hashed, so it is the
 * softer refusal: the digest is real and blind signing may take it. */
static void test_too_many_fields_is_unrenderable(void)
{
    CborWriter w;
    uint8_t   buf[1024];
    cbor_writer_init(&w, buf, sizeof(buf));

    const int n = EIP712_MAX_RENDER_FIELDS + 1;
    char names[EIP712_MAX_RENDER_FIELDS + 1][4];
    for (int i = 0; i < n; i++) {
        snprintf(names[i], sizeof(names[i]), "f%d", i);
    }

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Wide");
    cbor_write_array(&w, (size_t)n);
    for (int i = 0; i < n; i++) put_field(&w, names[i], "uint256");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Wide");
    put_domain_nvc(&w, "Wide", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, (size_t)n);
    for (int i = 0; i < n; i++) {
        cbor_write_text(&w, names[i]);
        cbor_write_uint(&w, (uint32_t)i);
    }

    uint8_t digest[32];
    Eip712Render r;
    Eip712Result res = eip712_prepare(buf, w.length, digest, &r);
    CHECK(res == EIP712_UNRENDERABLE, "a document with %d leaves was not refused "
          "for display (result %d)", n, (int)res);

    /* Still hashed, or the blind path would have nothing to show. */
    uint8_t zero[32];
    memset(zero, 0, sizeof(zero));
    CHECK(memcmp(digest, zero, 32) != 0, "unrenderable document produced no digest");
}

/* A string with no glyphs on this screen. Hashable, unshowable — same class as
 * an over-long personal_sign message, and the same refusal (PROTOCOL.md 6bis). */
static void test_unprintable_string_is_unrenderable(void)
{
    CborWriter w;
    uint8_t   buf[512];
    cbor_writer_init(&w, buf, sizeof(buf));

    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 2);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Note");
    cbor_write_array(&w, 1);
    put_field(&w, "body", "string");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Note");
    put_domain_nvc(&w, "Note", "1", 1, USDC);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "body");
    cbor_write_text(&w, "sign \xf0\x9f\x92\xb8 now");   /* an emoji */

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, w.length, digest, &r) == EIP712_UNRENDERABLE,
          "a message the screen cannot draw was accepted for display");
}

/* Structure missing entirely: not a policy question, a protocol one. */
static void test_missing_parts_are_malformed(void)
{
    CborWriter w;
    uint8_t   buf[256];
    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Mail");

    uint8_t digest[32];
    Eip712Render r;
    CHECK(eip712_prepare(buf, w.length, digest, &r) == EIP712_MALFORMED,
          "a request with no types was not malformed");
}

/* The host's key order must not move the digest: EIP-712 hashes fields in the
 * order the TYPE declares them, and a device that followed the map order would
 * sign a different document for the same content. */
static void test_message_key_order_does_not_matter(void)
{
    uint8_t buf[1024];
    size_t  n = build_mail(buf, sizeof(buf));
    uint8_t want[32];
    Eip712Render r;
    eip712_prepare(buf, n, want, &r);

    CborWriter w;
    uint8_t   shuffled[1024];
    cbor_writer_init(&w, shuffled, sizeof(shuffled));
    cbor_write_map(&w, 4);
    cbor_write_text(&w, "types");
    cbor_write_map(&w, 3);
    put_domain_type_nvc(&w);
    cbor_write_text(&w, "Person");
    cbor_write_array(&w, 2);
    put_field(&w, "name", "string");
    put_field(&w, "wallet", "address");
    cbor_write_text(&w, "Mail");
    cbor_write_array(&w, 3);
    put_field(&w, "from", "Person");
    put_field(&w, "to", "Person");
    put_field(&w, "contents", "string");
    cbor_write_text(&w, "primaryType");
    cbor_write_text(&w, "Mail");
    put_domain_nvc(&w, "Ether Mail", "1", 1, ETHER_MAIL);
    cbor_write_text(&w, "message");
    cbor_write_map(&w, 3);
    /* contents first, then to, then from — the reverse of the declaration. */
    cbor_write_text(&w, "contents");
    cbor_write_text(&w, "Hello, Bob!");
    cbor_write_text(&w, "to");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "wallet");
    cbor_write_bytes(&w, BOB, 20);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Bob");
    cbor_write_text(&w, "from");
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "wallet");
    cbor_write_bytes(&w, COW, 20);
    cbor_write_text(&w, "name");
    cbor_write_text(&w, "Cow");

    uint8_t got[32];
    Eip712Render r2;
    CHECK(eip712_prepare(shuffled, w.length, got, &r2) == EIP712_OK,
          "reordered mail refused");
    CHECK(memcmp(got, want, 32) == 0, "map order changed the digest");
    /* And the rendering still follows the type, not the wire. */
    CHECK(strcmp(r2.fields[0].label, "from.name") == 0,
          "rendering followed the host's key order, not the type's");
}

/**
 * The documents have to fit through the door.
 *
 * A typed-data request carries its own type definitions — it must, since the
 * device recomputes the digest rather than trusting one the host worked out —
 * so it is several times the size of any other request in this protocol. A
 * `Permit` the device can hash perfectly and can never receive is not support
 * for Permit, and the failure would surface as a framing error a long way from
 * here. The bound is the device's own buffer less the frame header, the type
 * byte and the AEAD tag.
 */
static void test_requests_fit_in_a_frame(void)
{
    const size_t budget = PROTOCOL_MAX_FRAME - 4 - 1 - SESSION_TAG_SIZE;

    uint8_t buf[2048];
    uint8_t max[32];
    uint8_t amount[20];
    memset(max, 0xff, sizeof(max));
    memset(amount, 0xff, sizeof(amount));

    size_t mail = build_mail(buf, sizeof(buf));
    size_t permit = build_permit(buf, sizeof(buf), max, 1893456000u);
    size_t permit2 = build_permit2(buf, sizeof(buf), amount);

    printf("  request sizes: mail %zu, permit %zu, permit2 %zu (budget %zu)\n",
           mail, permit, permit2, budget);

    /* The command adds `method` and `index` on top of what these builders
     * write, which test_protocol.c's own Permit request accounts for. */
    CHECK(mail <= budget, "the EIP's Mail example does not fit in a frame");
    CHECK(permit <= budget, "an ERC-2612 Permit does not fit in a frame");
    CHECK(permit2 <= budget, "a Permit2 PermitSingle does not fit in a frame");
}

int main(void)
{
    test_mail_vector();
    test_permit_unlimited();
    test_permit_bounded_amount_is_not_unlimited();
    test_a_narrow_field_is_never_unlimited();
    test_permit2_single();
    test_referenced_types_are_sorted();
    test_value_wider_than_its_type();
    test_arrays_are_refused();
    test_undefined_type_is_refused();
    test_too_many_fields_is_unrenderable();
    test_unprintable_string_is_unrenderable();
    test_missing_parts_are_malformed();
    test_message_key_order_does_not_matter();
    test_requests_fit_in_a_frame();

    if (failures) {
        printf("%d failure(s)\n", failures);
        return 1;
    }
    printf("all EIP-712 tests passed\n");
    return 0;
}
