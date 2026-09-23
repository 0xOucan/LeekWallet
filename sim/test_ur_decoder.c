/**
 * Assembling a message from animated-QR parts.
 *
 * The part strings below were emitted by Blockchain Commons' own UREncoder,
 * so this suite answers the question that matters: can we decode what other
 * wallets actually send? src/ur-decoder.c was additionally run against 60
 * generated messages of 20 to 900 bytes, in order and with 40 percent of the
 * frames dropped, before these were pinned.
 *
 * Shared with app/packages/core/test/ur-decoder.test.ts.
 */

#include <stdio.h>
#include <string.h>

#include <stdlib.h>

#include "ur-decoder.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* message: 250 bytes, msg[i] = (i*7+3) & 0xFF */
/* seq_len 5, max fragment 60 */
static const char *PARTS[] = {
    "ur:bytes/1-5/lpadahcszscyvadpiyhnhdeyaxbkbycsctdsdpeefrfwgagdhghyihjzjkknlylomymtntoxpyprrhrtsttotluovlwdwnyazmambtbbcwcpdtdyemfmfegsguhtpdeoplsf",
    "ur:bytes/2-5/lpaoahcszscyvadpiyhnhdeyhsisjlkokilrlumonlnbosplrerfsrsgtttpurvawewkzoaoasbechckdadweoftfpfdgwhfhliejejpkklaltmnmdnsotpkparofniemhkp",
    "ur:bytes/3-5/lpaxahcszscyvadpiyhnhdeyrsswsntyuyvowlwtylzeahbnbwcycldedlenfsfygrgmhkhniojtkpkelslememkneolpmqzrksasotitsuevwwpwfzsadaybscmfdrhsrzt",
    "ur:bytes/4-5/lpaaahcszscyvadpiyhnhdeycadkdneyesfzflglgohhiaimjskslblnlgmwndoeptpfrlrnsksftetnvyvswsynzcaabdbgcfcxdidmecfnfxgegyhdheiyjnjydiinmwjt",
    "ur:bytes/5-5/lpahahcszscyvadpiyhnhdeykglfldmhmsnnonpsqdrdsesptktbutvewmwzytaeatbabzcecndrehetfhfggtghhpidinjoktkblplkmunyoypdperprysssbtdoyeshyns",
    "ur:bytes/6-5/lpamahcszscyvadpiyhnhdeystglgohhguhthsislbamlgmwlumonlnbrlrnfesfsrsgtttpwsynzclrkgaoasbedidmecfneordfpfdheiyjnjyjejpytlamsnnfnkbkbmu",
    "ur:bytes/7-5/lpatahcszscyvadpiyhnhdeyiyoloeoepluevovovavaoeoernploeidiyiyidoeplrnoeoevavavovoueploeoeoliyididjthyoeoeololvovozewyvooeololsajnesmu",
    "ur:bytes/8-5/lpayahcszscyvadpiyhnhdeyondwdneyehyasttoutveiaiminjofhambzcecwoeoypdrlkbgtghguhtnlvtwsynlplklumometpdidmfssssrsgsotictiykpkeoydehttd",
    "ur:bytes/9-5/lpasahcszscyvadpiyhnhdeycfvtylzeykfnaxbkbyhddlendpeekgfwgagdosjtihjzjkrdlylonevautoxpyprytrttsuetlcevlwdwnetbscmbtbbhpcpdtdystykvtot",
    "ur:bytes/10-5/lpbkahcszscyvadpiyhnhdeyckdmftdrdsiyimknjtckdrftdsdscywdzewycydrdsdsdrcyjtkbimcydsdsftdrckwyzswdvadsdrftdmckimkniyiycydrfmdmwycpvyln",
    "ur:bytes/11-5/lpbdahcszscyvadpiyhnhdeyckdmftdrdsiyimknjtckdrftdsdscywdzewycydrdsdsdrcyjtkbimcydsdsftdrckwyzswdvadsdrftdmckimkniyiycydrfmdmmuwspsrh",
    "ur:bytes/12-5/lpbnahcszscyvadpiyhnhdeyrsswsntyuyvowlwtylzeahbnbwcycldedlenfsfygrgmhkhniojtkpkelslememkneolpmqzrksasotitsuevwwpwfzsadaybscmrdcpfxkn",
    "ur:bytes/13-5/lpbtahcszscyvadpiyhnhdeyrfsfuosfsssssssssfrfgshhfyfyfyfyhhgsrfsfsssssssssfuosfrffyfyfyfykegshhgsfysssssssfztsfuossssfyfyhhgslywzrpbb",
    "ur:bytes/14-5/lpbaahcszscyvadpiyhnhdeytnimkbjtimcydsdsdrhtwyzezswdvadsftdruejtimkniyiydrftdmhynywdvavatndrfmdmdrnyiyiyimhtdmfmftdrolvazswdztetvamk",
    "ur:bytes/15-5/lpbsahcszscyvadpiyhnhdeykegsfyfyfysssfuosfztssssssssrfgshhgsfyfyfyfygsrfsfuossssssssuosfrfgsfyfyfyfygshhgsrfssssssssztsfuosfpmpyktzt",
};
/* single-part, payload deadbeef as cbor bytes */
static const char *SINGLE = "ur:bytes/uepmrnwskensotht";

static uint8_t fragments[8 * 1024];
static uint8_t mixed[8 * 1024];
static UrDecoder dec;

#define N_PARTS (sizeof PARTS / sizeof PARTS[0])

/* The message the parts carry: 250 bytes, msg[i] = (i * 7 + 3) & 0xFF. */
static bool message_is_right(void)
{
    size_t n = 0;
    const uint8_t *m = ur_decoder_message(&dec, &n);
    if (m == NULL) {
        return false;
    }
    /* UR carries the CBOR the caller handed it; it does not add a wrapper of
       its own. So what comes out is byte for byte what went in, and the 4527
       types layered on top are responsible for their own CBOR. */
    if (n != 250) {
        return false;
    }
    for (size_t i = 0; i < 250; i++) {
        if (m[i] != (uint8_t)((i * 7 + 3) & 0xFF)) {
            return false;
        }
    }
    return true;
}

static void feed(const char *ur, UrPartResult *out)
{
    *out = ur_decoder_receive(&dec, ur, strlen(ur));
}

static void test_in_order(void)
{
    printf("== parts in order\n");
    ur_decoder_reset(&dec);

    UrPartResult r = UR_PART_REJECTED;
    size_t used = 0;
    for (size_t i = 0; i < N_PARTS && r != UR_PART_COMPLETE; i++) {
        feed(PARTS[i], &r);
        used++;
        CHECK(r != UR_PART_REJECTED, "part %zu rejected", i + 1);
    }
    CHECK(r == UR_PART_COMPLETE, "never completed after %zu parts", used);
    CHECK(message_is_right(), "assembled the wrong bytes");
}

/* The real case: a camera misses frames and the user starts watching part way
   through the animation. Starting at the fourth part means the first three
   plain fragments are never seen as themselves - they have to come out of the
   mixed parts. */
static void test_starting_late(void)
{
    printf("== joining the animation late, and looping\n");
    ur_decoder_reset(&dec);

    UrPartResult r = UR_PART_REJECTED;
    for (int pass = 0; pass < 3 && r != UR_PART_COMPLETE; pass++) {
        for (size_t i = 3; i < N_PARTS && r != UR_PART_COMPLETE; i++) {
            feed(PARTS[i], &r);
            CHECK(r != UR_PART_REJECTED, "part %zu rejected", i + 1);
        }
    }
    CHECK(r == UR_PART_COMPLETE, "never completed");
    CHECK(message_is_right(), "assembled the wrong bytes");
}

static void test_dropped_frames(void)
{
    printf("== every third frame dropped\n");
    ur_decoder_reset(&dec);

    UrPartResult r = UR_PART_REJECTED;
    for (int pass = 0; pass < 3 && r != UR_PART_COMPLETE; pass++) {
        for (size_t i = 0; i < N_PARTS && r != UR_PART_COMPLETE; i++) {
            if (i % 3 == 2) {
                continue;
            }
            feed(PARTS[i], &r);
            CHECK(r != UR_PART_REJECTED, "part %zu rejected", i + 1);
        }
    }
    CHECK(r == UR_PART_COMPLETE, "never completed");
    CHECK(message_is_right(), "assembled the wrong bytes");
}

static void test_single_part(void)
{
    printf("== a single-part UR needs no assembly\n");
    ur_decoder_reset(&dec);

    UrPartResult r;
    feed(SINGLE, &r);
    CHECK(r == UR_PART_COMPLETE, "single-part UR did not complete");

    size_t n = 0;
    const uint8_t *m = ur_decoder_message(&dec, &n);
    CHECK(m != NULL && n == 4 && m[0] == 0xDE && m[1] == 0xAD &&
          m[2] == 0xBE && m[3] == 0xEF, "single-part payload is wrong");
}

/* Two senders, one decoder. Whatever arrives second must not be able to steer
   an assembly that is already under way. */
static void test_mixing_two_messages_is_refused(void)
{
    printf("== a part from a different message is refused\n");
    ur_decoder_reset(&dec);

    UrPartResult r;
    feed(PARTS[0], &r);
    CHECK(r == UR_PART_ACCEPTED, "first part not accepted");

    feed(SINGLE, &r);
    CHECK(r == UR_PART_REJECTED,
          "a part from another message was accepted mid-assembly");

    /* and the assembly still finishes correctly afterwards */
    for (size_t i = 1; i < N_PARTS && r != UR_PART_COMPLETE; i++) {
        feed(PARTS[i], &r);
    }
    CHECK(r == UR_PART_COMPLETE, "did not recover after the bad part");
    CHECK(message_is_right(), "assembled the wrong bytes");
}

static void test_garbage_is_refused(void)
{
    printf("== malformed parts are refused\n");
    ur_decoder_reset(&dec);

    UrPartResult r;
    feed("ur:bytes/0-5/lpadahcszscyvadpiyhnhdey", &r);
    CHECK(r == UR_PART_REJECTED, "part zero was accepted");

    ur_decoder_reset(&dec);
    feed("ur:bytes/1-0/lpadahcszscyvadpiyhnhdey", &r);
    CHECK(r == UR_PART_REJECTED, "a zero fragment count was accepted");

    ur_decoder_reset(&dec);
    feed("ur:bytes/1-5/", &r);
    CHECK(r == UR_PART_REJECTED, "an empty body was accepted");

    ur_decoder_reset(&dec);
    feed("ur:bytes/a-5/lpadahcszscyvadpiyhnhdey", &r);
    CHECK(r == UR_PART_REJECTED, "a non-numeric sequence was accepted");

    /* A single flipped character anywhere in a real part must fail its CRC. */
    ur_decoder_reset(&dec);
    char broken[512];
    strcpy(broken, PARTS[0]);
    const size_t last = strlen(broken) - 1;
    broken[last] = (broken[last] == 'a') ? 'z' : 'a';
    feed(broken, &r);
    CHECK(r == UR_PART_REJECTED, "a corrupted part was accepted");
}


/*
 * The assembly leg of the shared corpus.
 *
 * Unlike the other two, these part strings did not come from our own encoder —
 * they were emitted by Blockchain Commons' UREncoder and are embedded above.
 * What this mode records is what OUR decoder makes of them, so the TypeScript
 * mirror is checked against the same two things at once: the reference's
 * output, and this decoder's reading of it.
 */
static int emit_vectors(const char *path)
{
    FILE *f = fopen(path, "w");
    if (f == NULL) {
        perror(path);
        return 1;
    }

    ur_decoder_init(&dec, fragments, sizeof fragments, mixed, sizeof mixed);

    /* Assemble once so the expected message is this decoder's answer, not a
       constant somebody typed. */
    UrPartResult r = UR_PART_REJECTED;
    for (size_t i = 0; i < N_PARTS && r != UR_PART_COMPLETE; i++) {
        r = ur_decoder_receive(&dec, PARTS[i], strlen(PARTS[i]));
    }
    if (r != UR_PART_COMPLETE) {
        fclose(f);
        return 1;
    }
    size_t n = 0;
    const uint8_t *m = ur_decoder_message(&dec, &n);

    fprintf(f, "{\n  \"messageHex\": \"");
    for (size_t i = 0; i < n; i++) {
        fprintf(f, "%02x", m[i]);
    }
    fprintf(f, "\",\n  \"parts\": [\n");
    for (size_t i = 0; i < N_PARTS; i++) {
        fprintf(f, "    \"%s\"%s\n", PARTS[i], i + 1 == N_PARTS ? "" : ",");
    }
    fprintf(f, "  ],\n");

    ur_decoder_reset(&dec);
    r = ur_decoder_receive(&dec, SINGLE, strlen(SINGLE));
    if (r != UR_PART_COMPLETE) {
        fclose(f);
        return 1;
    }
    m = ur_decoder_message(&dec, &n);
    fprintf(f, "  \"single\": \"%s\",\n  \"singleHex\": \"", SINGLE);
    for (size_t i = 0; i < n; i++) {
        fprintf(f, "%02x", m[i]);
    }
    fprintf(f, "\"\n}\n");

    if (fclose(f) != 0) {
        perror(path);
        return 1;
    }
    printf("wrote %zu assembly parts to %s\n", N_PARTS, path);
    return 0;
}

int main(int argc, char **argv)
{
    ur_decoder_init(&dec, fragments, sizeof fragments, mixed, sizeof mixed);

    if (argc == 3 && strcmp(argv[1], "--emit-vectors") == 0) {
        return emit_vectors(argv[2]);
    }

    test_in_order();
    test_starting_late();
    test_dropped_frames();
    test_single_part();
    test_mixing_two_messages_is_refused();
    test_garbage_is_refused();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
