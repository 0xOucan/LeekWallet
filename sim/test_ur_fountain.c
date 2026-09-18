/**
 * BC-UR fountain fragment selection.
 *
 * The sender and the receiver never transmit which fragments a mixed part
 * carries; both derive it. So this is not a test that our code is
 * self-consistent - it is a test that it agrees with everyone else's. Every
 * vector below was printed by Blockchain Commons' own implementation, and
 * src/ur-fountain.c was checked against 4000 generated cases, 3606 of them on
 * the mixed-degree path, before these were written down.
 *
 * Shared with app/packages/core/test/ur-fountain.test.ts.
 */

#include <stdio.h>
#include <string.h>

#include "ur-fountain.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

static UrFountainScratch scratch;

/* seq_num, seq_len, checksum, the fragments, how many. */
static const struct {
    uint32_t seq_num;
    uint32_t seq_len;
    uint32_t checksum;
    uint8_t  fragments[64];
    uint8_t  count;
} VECTORS[] = {
    { 57, 27, 4028598851u, { 4,12,22,24,25 }, 5 },
    { 117, 21, 3497374364u, { 1 }, 1 },
    { 26, 22, 2190517599u, { 0,3,8,9,10,11,12,20 }, 8 },
    { 96, 23, 488569490u, { 1 }, 1 },
    { 122, 26, 1718302842u, { 1,2,3,4,5,6,7,8,9,10,12,13,14,15,16,18,20,23,24,25 }, 20 },
    { 121, 9, 444168848u, { 0,1,2,7,8 }, 5 },
    { 92, 14, 2683032657u, { 0 }, 1 },
    { 68, 31, 1869109322u, { 5,7,10,17 }, 4 },
    { 81, 23, 802285917u, { 2,4,9,12,17 }, 5 },
    { 57, 4, 2492479599u, { 1,2 }, 2 },
    { 190, 11, 4001014798u, { 1,2,4,5,10 }, 5 },
    { 188, 18, 1427127210u, { 2,3,11,15 }, 4 },
    { 109, 22, 1975533222u, { 0,11,15,16,17,19 }, 6 },
    { 200, 11, 1829874048u, { 10 }, 1 },
    { 124, 23, 1656962311u, { 0,2,4,5,6,7,8,9,10,11,12,13,14,15,16,19,20,21 }, 18 },
    { 133, 7, 2599367404u, { 6 }, 1 },
    { 44, 15, 1065972909u, { 1,4,6,9,10,11,13,14 }, 8 },
    { 171, 23, 1834386779u, { 1,8,19,20 }, 4 },
    { 136, 27, 4116007325u, { 14,18,21 }, 3 },
    { 171, 11, 3967405648u, { 1,4,5,8,10 }, 5 },
    { 71, 11, 3613393352u, { 0,5,6,7,8 }, 5 },
    { 136, 8, 435750050u, { 7 }, 1 },
    { 139, 33, 1038598893u, { 32 }, 1 },
    { 175, 39, 3217535714u, { 2,19,24,37 }, 4 },
    { 162, 40, 3215555077u, { 3,7 }, 2 },
    { 168, 11, 1963896687u, { 0,1,3,4,6,7,8,9,10 }, 9 },
    { 31, 23, 4149498734u, { 5,12,13 }, 3 },
    { 123, 11, 2978015453u, { 1,3,5,6,8,10 }, 6 },
    { 74, 38, 1382970450u, { 16 }, 1 },
    { 94, 35, 3135476136u, { 0,25 }, 2 },
    { 88, 30, 384071525u, { 19 }, 1 },
    { 128, 15, 191638886u, { 3,4,5,6,7,8,9,10 }, 8 },
    { 123, 8, 3690170541u, { 5 }, 1 },
    { 54, 9, 692671622u, { 2 }, 1 },
    { 26, 19, 3850135735u, { 2,7,9,11,13,16,18 }, 7 },
    { 189, 6, 1685299764u, { 1,2 }, 2 },
    { 24, 34, 362108625u, { 23 }, 1 },
    { 16, 30, 2118464404u, { 15 }, 1 },
    { 25, 27, 1359574103u, { 24 }, 1 },
    { 3, 13, 911483070u, { 2 }, 1 },
    { 191, 39, 3887965474u, { 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38 }, 39 },
    { 65, 40, 1160062737u, { 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39 }, 39 },
    { 138, 39, 3195783563u, { 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,27,28,29,30,31,32,33,34,35,36,37,38 }, 37 },
    { 144, 40, 1244686035u, { 0,1,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23,24,26,27,28,29,30,31,32,33,34,35,36,37,38,39 }, 37 },
};

static void test_reference_vectors(void)
{
    printf("== fragment selection, against the reference implementation\n");

    for (size_t i = 0; i < sizeof VECTORS / sizeof VECTORS[0]; i++) {
        uint8_t mask[UR_PART_MASK_BYTES];
        const bool ok = ur_fountain_fragments(VECTORS[i].seq_num,
                                              VECTORS[i].seq_len,
                                              VECTORS[i].checksum,
                                              mask, &scratch);
        CHECK(ok, "part %u of %u was refused",
              VECTORS[i].seq_num, VECTORS[i].seq_len);
        if (!ok) {
            continue;
        }

        uint8_t want[UR_PART_MASK_BYTES];
        memset(want, 0, sizeof want);
        for (uint8_t f = 0; f < VECTORS[i].count; f++) {
            const uint8_t idx = VECTORS[i].fragments[f];
            want[idx / 8] |= (uint8_t)(1u << (idx % 8));
        }

        CHECK(memcmp(mask, want, sizeof want) == 0,
              "part %u of %u (crc %u) chose the wrong fragments",
              VECTORS[i].seq_num, VECTORS[i].seq_len, VECTORS[i].checksum);
        CHECK(ur_mask_count(mask, VECTORS[i].seq_len) == VECTORS[i].count,
              "part %u of %u: degree %u, want %u",
              VECTORS[i].seq_num, VECTORS[i].seq_len,
              ur_mask_count(mask, VECTORS[i].seq_len), VECTORS[i].count);
    }
}

/* The first seq_len parts must be the plain fragments in order. A sender that
   emits only those has sent a complete message, and a receiver that collects
   only those never has to XOR anything. */
static void test_pure_parts_are_in_order(void)
{
    printf("== parts 1..seq_len are the plain fragments\n");

    for (uint32_t seq_len = 1; seq_len <= 24; seq_len++) {
        for (uint32_t n = 1; n <= seq_len; n++) {
            uint8_t mask[UR_PART_MASK_BYTES];
            CHECK(ur_fountain_fragments(n, seq_len, 0xDEADBEEF, mask, &scratch),
                  "part %u of %u refused", n, seq_len);
            CHECK(ur_mask_count(mask, seq_len) == 1,
                  "part %u of %u is not a single fragment", n, seq_len);
            const uint32_t idx = n - 1;
            CHECK((mask[idx / 8] & (1u << (idx % 8))) != 0,
                  "part %u of %u is not fragment %u", n, seq_len, idx);
        }
    }
}

/* A mixed part must always name at least one fragment and never more than
   there are. A degree of zero would be a part carrying nothing; a degree above
   seq_len would index past the fragments. */
static void test_degree_is_in_range(void)
{
    printf("== mixed parts have a usable degree\n");

    for (uint32_t seq_len = 1; seq_len <= 32; seq_len++) {
        for (uint32_t n = seq_len + 1; n <= seq_len + 60; n++) {
            uint8_t mask[UR_PART_MASK_BYTES];
            if (!ur_fountain_fragments(n, seq_len, 0x01020304u, mask,
                                       &scratch)) {
                CHECK(false, "part %u of %u refused", n, seq_len);
                continue;
            }
            const uint32_t d = ur_mask_count(mask, seq_len);
            CHECK(d >= 1 && d <= seq_len,
                  "part %u of %u has degree %u", n, seq_len, d);
        }
    }
}

/* The scratch struct is sized by UR_MAX_PARTS, so a message claiming more
   parts than that has to be refused rather than trusted. */
static void test_bounds(void)
{
    printf("== out-of-range inputs are refused\n");

    uint8_t mask[UR_PART_MASK_BYTES];
    CHECK(!ur_fountain_fragments(1, 0, 0, mask, &scratch),
          "a zero fragment count was accepted");
    CHECK(!ur_fountain_fragments(0, 4, 0, mask, &scratch),
          "part zero was accepted; parts are 1-based on the wire");
    CHECK(!ur_fountain_fragments(1, UR_MAX_PARTS + 1, 0, mask, &scratch),
          "a fragment count above UR_MAX_PARTS was accepted");
    CHECK(ur_fountain_fragments(1, UR_MAX_PARTS, 0, mask, &scratch),
          "exactly UR_MAX_PARTS was refused");
}

int main(void)
{
    test_reference_vectors();
    test_pure_parts_are_in_order();
    test_degree_is_in_range();
    test_bounds();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
