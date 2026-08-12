/**
 * C CBOR tests, deliberately sharing vectors with the TypeScript side.
 *
 * The RFC 8949 appendix A cases below are the same list asserted in
 * app/packages/core/test/cbor.test.ts. Two implementations of one protocol
 * drift unless something forces them to agree, and the cheapest forcing
 * function is a shared set of known answers.
 */

#include <stdio.h>
#include <string.h>

#include "cbor.h"

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

/* Same vectors as the TypeScript suite. If these two lists ever disagree, the
 * device and the app have stopped speaking the same language. */
static void test_rfc_vectors(void)
{
    printf("== RFC 8949 appendix A vectors (shared with the TS suite)\n");

    struct { int32_t value; const char *hex; } ints[] = {
        {0, "00"}, {1, "01"}, {10, "0a"}, {23, "17"}, {24, "1818"},
        {25, "1819"}, {100, "1864"}, {1000, "1903e8"}, {1000000, "1a000f4240"},
        {-1, "20"}, {-10, "29"}, {-100, "3863"}, {-1000, "3903e7"},
    };

    for (size_t i = 0; i < sizeof(ints) / sizeof(ints[0]); i++) {
        uint8_t buf[16];
        char got[33];
        CborWriter w;
        cbor_writer_init(&w, buf, sizeof(buf));
        cbor_write_int(&w, ints[i].value);
        CHECK(cbor_writer_ok(&w), "writer overflowed on %d", (int)ints[i].value);
        to_hex(buf, w.length, got);
        CHECK(strcmp(got, ints[i].hex) == 0,
              "encode %d: want %s, got %s", (int)ints[i].value, ints[i].hex, got);
    }

    struct { const char *text; const char *hex; } texts[] = {
        {"", "60"}, {"a", "6161"}, {"IETF", "6449455446"},
    };

    for (size_t i = 0; i < sizeof(texts) / sizeof(texts[0]); i++) {
        uint8_t buf[16];
        char got[33];
        CborWriter w;
        cbor_writer_init(&w, buf, sizeof(buf));
        cbor_write_text(&w, texts[i].text);
        to_hex(buf, w.length, got);
        CHECK(strcmp(got, texts[i].hex) == 0,
              "encode \"%s\": want %s, got %s", texts[i].text, texts[i].hex, got);
    }

    /* [] and [1,2,3] */
    uint8_t buf[16];
    char got[33];
    CborWriter w;

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_array(&w, 0);
    to_hex(buf, w.length, got);
    CHECK(strcmp(got, "80") == 0, "encode []: got %s", got);

    cbor_writer_init(&w, buf, sizeof(buf));
    cbor_write_array(&w, 3);
    cbor_write_uint(&w, 1);
    cbor_write_uint(&w, 2);
    cbor_write_uint(&w, 3);
    to_hex(buf, w.length, got);
    CHECK(strcmp(got, "83010203") == 0, "encode [1,2,3]: got %s", got);
}

static void test_roundtrip(void)
{
    printf("== round trip through a request-shaped map\n");

    uint8_t buf[128];
    CborWriter w;
    cbor_writer_init(&w, buf, sizeof(buf));

    /* {"method": "getStatus", "id": 7} - keys sorted, as the canonical form
     * requires and as the TypeScript encoder emits. */
    cbor_write_map(&w, 2);
    cbor_write_text(&w, "id");
    cbor_write_uint(&w, 7);
    cbor_write_text(&w, "method");
    cbor_write_text(&w, "getStatus");
    CHECK(cbor_writer_ok(&w), "writer overflowed");

    CborItem item;
    CHECK(cbor_map_find(buf, w.length, "method", &item), "method not found");
    char method[32];
    CHECK(cbor_text_copy(&item, method, sizeof(method)), "method not copyable");
    CHECK(strcmp(method, "getStatus") == 0, "method is \"%s\"", method);

    CHECK(cbor_map_find(buf, w.length, "id", &item), "id not found");
    CHECK(item.type == CBOR_UINT && item.value == 7, "id is %u", (unsigned)item.value);

    CHECK(!cbor_map_find(buf, w.length, "absent", &item), "found a key that is not there");
}

static void test_nested_skip(void)
{
    printf("== finding a key after a nested value\n");

    uint8_t buf[128];
    CborWriter w;
    cbor_writer_init(&w, buf, sizeof(buf));

    /* {"a": [1,2,3], "b": {"c": 9}, "z": 42} - the walker must skip over the
     * array and the inner map to reach "z". */
    cbor_write_map(&w, 3);
    cbor_write_text(&w, "a");
    cbor_write_array(&w, 3);
    cbor_write_uint(&w, 1); cbor_write_uint(&w, 2); cbor_write_uint(&w, 3);
    cbor_write_text(&w, "b");
    cbor_write_map(&w, 1);
    cbor_write_text(&w, "c"); cbor_write_uint(&w, 9);
    cbor_write_text(&w, "z");
    cbor_write_uint(&w, 42);
    CHECK(cbor_writer_ok(&w), "writer overflowed");

    CborItem item;
    CHECK(cbor_map_find(buf, w.length, "z", &item), "z not found past nested values");
    CHECK(item.type == CBOR_UINT && item.value == 42, "z is %u", (unsigned)item.value);
}

static void test_rejects(void)
{
    printf("== malformed and out-of-subset input is rejected\n");

    struct { const char *label; uint8_t bytes[10]; size_t len; } cases[] = {
        {"truncated head",        {0x18}, 1},
        {"truncated text",        {0x64, 0x61}, 2},
        {"indefinite array",      {0x9f, 0x01, 0xff}, 3},
        {"64-bit argument",       {0x1b, 0, 0, 0, 0, 0, 0, 0, 1}, 9},
        {"tag (major 6)",         {0xc0, 0x01}, 2},
        {"float/simple (major 7)",{0xf5}, 1},
        {"length beyond buffer",  {0x58, 0x40, 0x01}, 3},
    };

    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        CborReader r;
        CborItem item;
        cbor_reader_init(&r, cases[i].bytes, cases[i].len);
        CHECK(!cbor_read(&r, &item), "%s was accepted", cases[i].label);
    }

    /* A map with a non-text key is outside the subset. */
    const uint8_t int_key[] = {0xa1, 0x01, 0x02};
    CborItem item;
    CHECK(!cbor_map_find(int_key, sizeof(int_key), "x", &item),
          "map with an integer key was walked");
}

static void test_writer_overflow(void)
{
    printf("== the writer reports overflow rather than scribbling\n");

    uint8_t small[4];
    CborWriter w;
    cbor_writer_init(&w, small, sizeof(small));

    cbor_write_text(&w, "this is far longer than four bytes");
    CHECK(!cbor_writer_ok(&w), "overflow was not reported");
    CHECK(w.length <= sizeof(small), "wrote %zu bytes into a %zu byte buffer",
          w.length, sizeof(small));
}

int main(void)
{
    test_rfc_vectors();
    test_roundtrip();
    test_nested_skip();
    test_rejects();
    test_writer_overflow();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
