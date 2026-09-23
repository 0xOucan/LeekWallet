/**
 * Animated-QR part production, checked two ways.
 *
 * Against the reference: the parts below were printed by Blockchain Commons'
 * bc-ur for a known message (the same set test_ur_decoder.c reads), and this
 * encoder has to reproduce them character for character - plain parts and
 * fountain parts both. A companion running bc-ur, Keystone's ur-registry or
 * Hummingbird then sees exactly what it would see from any other wallet.
 *
 * Against our own reader: every message goes out through ur-encoder.c and
 * back through ur-decoder.c, including with frames dropped, because a camera
 * pointed at a 128x64 panel will miss some and the fountain parts are the
 * whole reason that is survivable.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ur-decoder.h"
#include "ur-encoder.h"

static int failures = 0;

#define CHECK(cond, ...) do {                        \
    if (!(cond)) {                                   \
        printf("  FAIL: "); printf(__VA_ARGS__);     \
        printf("\n"); failures++;                    \
    }                                                \
} while (0)

/* message: 250 bytes, msg[i] = (i*7+3) & 0xFF; max fragment 60 */
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

#define N_PARTS (sizeof PARTS / sizeof PARTS[0])

static UrEncoder enc;
static UrDecoder dec;
static uint8_t fragments[8 * 1024];
static uint8_t mixed[8 * 1024];

static void test_matches_the_reference(void)
{
    printf("== parts are byte-identical to bc-ur's, plain and fountain\n");

    uint8_t msg[250];
    for (size_t i = 0; i < sizeof msg; i++) {
        msg[i] = (uint8_t)((i * 7 + 3) & 0xFF);
    }
    CHECK(ur_encoder_init(&enc, "bytes", msg, sizeof msg, 60), "init refused");
    CHECK(enc.seq_len == 5 && enc.fragment_len == 50,
          "nominal fragment length is %u x %u, bc-ur says 5 x 50",
          enc.seq_len, enc.fragment_len);

    for (size_t i = 0; i < N_PARTS; i++) {
        char part[512];
        const size_t n = ur_encoder_next_part(&enc, part, sizeof part);
        CHECK(n == strlen(PARTS[i]) && strcmp(part, PARTS[i]) == 0,
              "part %zu differs:\n    got  %s\n    want %s", i + 1, part, PARTS[i]);
    }
}

/* Deterministic, so a failing drop pattern reproduces. */
static uint32_t lcg(uint32_t *s)
{
    *s = *s * 1103515245u + 12345u;
    return *s >> 16;
}

/* Send until the decoder completes, dropping roughly `drop_pct` of frames.
   Returns the number of parts it took, or 0 if it never finished. */
static uint32_t transmit(const uint8_t *msg, size_t len, size_t max_frag,
                         unsigned drop_pct, uint32_t seed, bool upper)
{
    if (!ur_encoder_init(&enc, "eth-signature", msg, len, max_frag)) {
        return 0;
    }
    ur_decoder_init(&dec, fragments, sizeof fragments, mixed, sizeof mixed);

    for (uint32_t sent = 1; sent <= 2000; sent++) {
        char part[1200];
        const size_t n = ur_encoder_next_part(&enc, part, sizeof part);
        if (n == 0 || n + 1 > ur_encoder_part_max(&enc)) {
            return 0;
        }
        if (lcg(&seed) % 100 < drop_pct) {
            continue;
        }
        if (upper) {
            ur_to_upper(part);
        }
        const UrPartResult r = ur_decoder_receive(&dec, part, n);
        if (r == UR_PART_REJECTED) {
            return 0;
        }
        if (r == UR_PART_COMPLETE) {
            size_t out_len = 0;
            const uint8_t *out = ur_decoder_message(&dec, &out_len);
            return (out != NULL && out_len == len && memcmp(out, msg, len) == 0)
                   ? sent : 0;
        }
    }
    return 0;
}

static void test_round_trip(void)
{
    printf("== everything sent is read back by ur-decoder.c\n");

    static const size_t LENGTHS[] = { 1, 9, 10, 11, 59, 60, 61, 90, 91, 250, 777, 1100 };
    static const size_t FRAGS[] = { 10, 11, 60, 70, 200 };

    uint8_t msg[1100];
    for (size_t i = 0; i < sizeof msg; i++) {
        msg[i] = (uint8_t)(i * 13 + 5);
    }
    for (size_t a = 0; a < sizeof LENGTHS / sizeof LENGTHS[0]; a++) {
        for (size_t b = 0; b < sizeof FRAGS / sizeof FRAGS[0]; b++) {
            const size_t len = LENGTHS[a], frag = FRAGS[b];
            if ((len + frag - 1) / frag > UR_MAX_PARTS) {
                continue;
            }
            const uint32_t took = transmit(msg, len, frag, 0, 1, false);
            CHECK(took != 0, "%zu bytes at fragment %zu did not round-trip", len, frag);
            /* With nothing lost, the plain parts alone must suffice. */
            if (ur_encoder_init(&enc, "eth-signature", msg, len, frag)) {
                CHECK(took == enc.seq_len, "%zu bytes took %u parts, not %u",
                      len, took, enc.seq_len);
            }
        }
    }
}

static void test_lossy(void)
{
    printf("== dropped frames are recovered from fountain parts\n");

    uint8_t msg[1024];
    for (size_t i = 0; i < sizeof msg; i++) {
        msg[i] = (uint8_t)(i ^ (i >> 3) ^ 0x5A);
    }
    for (uint32_t seed = 1; seed <= 40; seed++) {
        const uint32_t took = transmit(msg, 900, 60, 35, seed, seed & 1);
        CHECK(took != 0, "a 35%% lossy run with seed %u never completed", seed);
    }
    /* Losing every plain part is the extreme: only mixed parts get through. */
    if (ur_encoder_init(&enc, "eth-signature", msg, 300, 60)) {
        ur_decoder_init(&dec, fragments, sizeof fragments, mixed, sizeof mixed);
        enc.seq_num = enc.seq_len;
        bool done = false;
        for (int i = 0; i < 500 && !done; i++) {
            char part[600];
            const size_t n = ur_encoder_next_part(&enc, part, sizeof part);
            done = ur_decoder_receive(&dec, part, n) == UR_PART_COMPLETE;
        }
        CHECK(done, "fountain parts alone never assembled the message");
    }
}

static void test_single_part_and_refusals(void)
{
    printf("== a small message is one static UR; bad input is refused\n");

    const uint8_t sig[] = { 0xde, 0xad, 0xbe, 0xef };
    CHECK(ur_encoder_init(&enc, "bytes", sig, sizeof sig, 60), "init refused");
    CHECK(ur_encoder_is_single_part(&enc), "four bytes became a multi-part UR");
    char part[128];
    const size_t n = ur_encoder_next_part(&enc, part, sizeof part);
    char plain[128];
    ur_encode("bytes", sig, sizeof sig, plain, sizeof plain);
    CHECK(n > 0 && strcmp(part, plain) == 0, "single part is not ur_encode's output");

    uint8_t big[UR_MAX_PARTS * UR_MIN_FRAGMENT_LEN + 1];
    memset(big, 1, sizeof big);
    CHECK(!ur_encoder_init(&enc, "bytes", big, sizeof big, UR_MIN_FRAGMENT_LEN),
          "a message needing more than UR_MAX_PARTS fragments was accepted");
    CHECK(!ur_encoder_init(&enc, "Bytes", sig, sizeof sig, 60),
          "an uppercase type was accepted for encoding");
    CHECK(!ur_encoder_init(&enc, "bytes", sig, 0, 60), "an empty message was accepted");

    uint8_t msg[250] = {0};
    ur_encoder_init(&enc, "bytes", msg, sizeof msg, 60);
    const size_t full = ur_encoder_part(&enc, 1, part, sizeof part);
    for (size_t cap = 1; cap <= full; cap++) {
        CHECK(ur_encoder_part(&enc, 1, part, cap) == 0,
              "a %zu-byte buffer produced a truncated part", cap);
    }
    CHECK(ur_encoder_part(&enc, 0, part, sizeof part) == 0, "part 0 was produced");

    char up[] = "ur:eth-signature/1-3/lpadax";
    ur_to_upper(up);
    CHECK(strcmp(up, "UR:ETH-SIGNATURE/1-3/LPADAX") == 0, "uppercase gave %s", up);
}

int main(void)
{
    test_matches_the_reference();
    test_round_trip();
    test_lossy();
    test_single_part_and_refusals();

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED",
           failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
