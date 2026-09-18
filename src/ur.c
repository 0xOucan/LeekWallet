/* Uniform Resources (BC-UR) encoding. See ur.h for the shape of this. */

#include "ur.h"

#include <string.h>

/*
 * The 256 Bytewords, concatenated, four characters each.
 *
 * Data from Blockchain Commons' bc-ur (BSD-2-Clause Plus Patent). Copied
 * verbatim rather than retyped: the first and last letters of each word are the
 * encoding, so a single transposed letter here would produce output that other
 * wallets decode to different bytes, and the CRC would not catch it because we
 * would have computed the CRC over the same wrong understanding.
 */
static const char BYTEWORDS[] =
    "ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabias"
    "bluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcost"
    "cruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdull"
    "dutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfish"
    "fizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglow"
    "goodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhope"
    "hornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowl"
    "judojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamb"
    "lavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmany"
    "mathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnote"
    "numbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolpose"
    "puffpumapurrquadquizraceramprealredorichroadrockroofrubyruinruns"
    "rustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotask"
    "taxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuser"
    "vastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebs"
    "whatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom";

/* Reflected CRC-32, computed a nibble at a time: the 16-entry table costs 64
   bytes of flash against 1 KB for the byte-wise one, and nothing here is in a
   hot loop. */
static const uint32_t CRC32_NIBBLE[16] = {
    0x00000000, 0x1DB71064, 0x3B6E20C8, 0x26D930AC,
    0x76DC4190, 0x6B6B51F4, 0x4DB26158, 0x5005713C,
    0xEDB88320, 0xF00F9344, 0xD6D6A3E8, 0xCB61B38C,
    0x9B64C2B0, 0x86D3D2D4, 0xA00AE278, 0xBDBDF21C,
};

uint32_t ur_crc32(const uint8_t *data, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        crc = (crc >> 4) ^ CRC32_NIBBLE[crc & 0x0F];
        crc = (crc >> 4) ^ CRC32_NIBBLE[crc & 0x0F];
    }
    return crc ^ 0xFFFFFFFFu;
}

static char lower(char c)
{
    return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
}

/* Byte value for a first/last letter pair, or -1 if no word has that pair.
   Linear over 256 words: a decode of a full frame is a few tens of thousands of
   character compares, which is nothing beside the QR decode that produced it,
   and it costs no table and no lazy initialisation. */
static int byteword_lookup(char first, char last)
{
    first = lower(first);
    last = lower(last);
    for (int i = 0; i < 256; i++) {
        if (BYTEWORDS[i * 4] == first && BYTEWORDS[i * 4 + 3] == last) {
            return i;
        }
    }
    return -1;
}

static size_t encode_minimal(const uint8_t *data, size_t len, char *out)
{
    for (size_t i = 0; i < len; i++) {
        out[i * 2]     = BYTEWORDS[data[i] * 4];
        out[i * 2 + 1] = BYTEWORDS[data[i] * 4 + 3];
    }
    return len * 2;
}

size_t ur_bytewords_encode(const uint8_t *data, size_t len,
                           char *out, size_t out_size)
{
    const size_t need = UR_BYTEWORDS_LEN(len);
    if (out == NULL || out_size < need + 1) {
        return 0;
    }
    if (len > 0 && data == NULL) {
        return 0;
    }

    size_t n = encode_minimal(data, len, out);

    /* The CRC is appended big-endian and encoded the same way as the payload,
       so a decoder never needs to know where the payload stopped. */
    const uint32_t crc = ur_crc32(data, len);
    const uint8_t tail[4] = {
        (uint8_t)(crc >> 24), (uint8_t)(crc >> 16),
        (uint8_t)(crc >> 8),  (uint8_t)crc,
    };
    n += encode_minimal(tail, sizeof tail, out + n);

    out[n] = '\0';
    return n;
}

bool ur_bytewords_decode(const char *text, size_t text_len,
                         uint8_t *out, size_t out_size, size_t *out_len)
{
    if (text == NULL || out_len == NULL) {
        return false;
    }
    /* Two characters per byte, and at least the four CRC bytes must be there. */
    if ((text_len % 2) != 0 || text_len < 8) {
        return false;
    }

    const size_t total = text_len / 2;
    const size_t payload = total - 4;
    if (payload > out_size) {
        return false;
    }

    uint8_t crc_bytes[4];
    for (size_t i = 0; i < total; i++) {
        const int v = byteword_lookup(text[i * 2], text[i * 2 + 1]);
        if (v < 0) {
            return false;
        }
        if (i < payload) {
            out[i] = (uint8_t)v;
        } else {
            crc_bytes[i - payload] = (uint8_t)v;
        }
    }

    const uint32_t want = ((uint32_t)crc_bytes[0] << 24) |
                          ((uint32_t)crc_bytes[1] << 16) |
                          ((uint32_t)crc_bytes[2] << 8)  |
                          (uint32_t)crc_bytes[3];
    if (ur_crc32(out, payload) != want) {
        return false;
    }

    *out_len = payload;
    return true;
}

/* UR types are lowercase letters, digits and hyphens, and may not start or end
   with a hyphen. Checked rather than assumed, because the type is echoed into
   whatever the caller does next. */
static bool valid_type(const char *type, size_t len)
{
    if (len == 0 || len > UR_TYPE_MAX) {
        return false;
    }
    if (type[0] == '-' || type[len - 1] == '-') {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        const char c = lower(type[i]);
        const bool ok = (c >= 'a' && c <= 'z') ||
                        (c >= '0' && c <= '9') || c == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

size_t ur_encode(const char *type, const uint8_t *payload, size_t payload_len,
                 char *out, size_t out_size)
{
    if (type == NULL || out == NULL) {
        return 0;
    }
    const size_t type_len = strlen(type);
    if (!valid_type(type, type_len)) {
        return 0;
    }

    /* "ur:" + type + "/" + body + NUL */
    const size_t need = 3 + type_len + 1 + UR_BYTEWORDS_LEN(payload_len);
    if (out_size < need + 1) {
        return 0;
    }

    memcpy(out, "ur:", 3);
    for (size_t i = 0; i < type_len; i++) {
        out[3 + i] = lower(type[i]);
    }
    out[3 + type_len] = '/';

    const size_t body = ur_bytewords_encode(payload, payload_len,
                                            out + 4 + type_len,
                                            out_size - 4 - type_len);
    if (body == 0) {
        return 0;
    }
    return 4 + type_len + body;
}

/* Split a UR into its parts without copying. Returns false unless the string
   starts with the scheme and has exactly one '/'. */
static bool split(const char *ur, size_t ur_len,
                  const char **type, size_t *type_len,
                  const char **body, size_t *body_len)
{
    if (ur == NULL || ur_len < 4) {
        return false;
    }
    if (lower(ur[0]) != 'u' || lower(ur[1]) != 'r' || ur[2] != ':') {
        return false;
    }

    const char *slash = NULL;
    for (size_t i = 3; i < ur_len; i++) {
        if (ur[i] == '/') {
            if (slash != NULL) {
                return false;   /* a second '/' means multi-part */
            }
            slash = ur + i;
        }
    }
    if (slash == NULL) {
        return false;
    }

    *type = ur + 3;
    *type_len = (size_t)(slash - (ur + 3));
    *body = slash + 1;
    *body_len = (size_t)((ur + ur_len) - (slash + 1));
    return true;
}

bool ur_is_multipart(const char *ur, size_t ur_len)
{
    if (ur == NULL) {
        return false;
    }
    size_t slashes = 0;
    for (size_t i = 0; i < ur_len; i++) {
        if (ur[i] == '/') {
            slashes++;
        }
    }
    return slashes > 1;
}

bool ur_decode(const char *ur, size_t ur_len,
               char *type_out, size_t type_size,
               uint8_t *out, size_t out_size, size_t *out_len)
{
    const char *type, *body;
    size_t type_len, body_len;

    if (type_out == NULL || type_size == 0) {
        return false;
    }
    if (!split(ur, ur_len, &type, &type_len, &body, &body_len)) {
        return false;
    }
    if (!valid_type(type, type_len) || type_len + 1 > type_size) {
        return false;
    }
    if (!ur_bytewords_decode(body, body_len, out, out_size, out_len)) {
        return false;
    }

    for (size_t i = 0; i < type_len; i++) {
        type_out[i] = lower(type[i]);
    }
    type_out[type_len] = '\0';
    return true;
}
