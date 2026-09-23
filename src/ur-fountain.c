/* BC-UR fountain fragment selection. See ur-fountain.h. */

#include "ur-fountain.h"

#include <string.h>

#include "sha2.h"

static uint64_t rotl(uint64_t x, int k)
{
    return (x << k) | (x >> (64 - k));
}

void ur_rng_seed(UrRng *rng, const uint8_t digest[32])
{
    for (int i = 0; i < 4; i++) {
        uint64_t v = 0;
        for (int n = 0; n < 8; n++) {
            v <<= 8;
            v |= digest[i * 8 + n];
        }
        rng->s[i] = v;
    }
}

uint64_t ur_rng_next(UrRng *rng)
{
    uint64_t *s = rng->s;
    const uint64_t result = rotl(s[1] * 5, 7) * 9;
    const uint64_t t = s[1] << 17;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45);

    return result;
}

double ur_rng_next_double(UrRng *rng)
{
    /* 2^64 exactly, written so the compiler cannot be tempted to fold this
       differently from the reference. */
    const double m = 18446744073709551616.0;
    return (double)ur_rng_next(rng) / m;
}

uint64_t ur_rng_next_int(UrRng *rng, uint64_t low, uint64_t high)
{
    return (uint64_t)(ur_rng_next_double(rng) * (double)(high - low + 1)) + low;
}

/*
 * Walker's alias method over the degree distribution 1/1, 1/2 ... 1/seq_len.
 *
 * Built exactly as bc-ur builds it, including the reversed index order it
 * notes as a variance from Schwarz, because the table it produces is part of
 * the wire behaviour: a different but equally valid alias table would pick
 * different fragments and the two ends would stop agreeing.
 */
static size_t choose_degree(uint32_t seq_len, UrRng *rng,
                            UrFountainScratch *sc)
{
    const int n = (int)seq_len;

    double sum = 0.0;
    for (int i = 1; i <= n; i++) {
        sum += 1.0 / (double)i;
    }

    /* P[i] = p_i * n / sum, the scaled probabilities the method works over. */
    double *P = sc->probs;
    for (int i = 0; i < n; i++) {
        P[i] = (1.0 / (double)(i + 1)) * (double)n / sum;
    }

    int16_t *small = sc->remaining;       /* reused as the "small" stack */
    int16_t *large = sc->aliases;         /* and this as the "large" stack */
    int n_small = 0, n_large = 0;

    for (int i = n - 1; i >= 0; i--) {
        if (P[i] < 1.0) {
            small[n_small++] = (int16_t)i;
        } else {
            large[n_large++] = (int16_t)i;
        }
    }

    double probs[UR_MAX_PARTS];
    int16_t aliases[UR_MAX_PARTS];
    for (int i = 0; i < n; i++) {
        probs[i] = 0.0;
        aliases[i] = 0;
    }

    while (n_small > 0 && n_large > 0) {
        const int a = small[--n_small];
        const int g = large[--n_large];
        probs[a] = P[a];
        aliases[a] = (int16_t)g;
        P[g] += P[a] - 1.0;
        if (P[g] < 1.0) {
            small[n_small++] = (int16_t)g;
        } else {
            large[n_large++] = (int16_t)g;
        }
    }
    while (n_large > 0) {
        probs[large[--n_large]] = 1.0;
    }
    while (n_small > 0) {
        /* Reachable only through numeric instability, per the reference. */
        probs[small[--n_small]] = 1.0;
    }

    const double r1 = ur_rng_next_double(rng);
    const double r2 = ur_rng_next_double(rng);
    const int i = (int)((double)n * r1);
    const int chosen = (r2 < probs[i]) ? i : aliases[i];

    return (size_t)chosen + 1;
}

bool ur_fountain_fragments(uint32_t seq_num, uint32_t seq_len, uint32_t checksum,
                           uint8_t mask[UR_PART_MASK_BYTES],
                           UrFountainScratch *scratch)
{
    if (mask == NULL || scratch == NULL) {
        return false;
    }
    if (seq_num == 0 || seq_len == 0 || seq_len > UR_MAX_PARTS) {
        return false;
    }

    /* The first seq_len parts are the plain fragments. Generating only those
       is a complete, non-fountain encoding, which is what a sender with a big
       screen and a cooperative receiver can get away with. */
    if (seq_num <= seq_len) {
        memset(mask, 0, UR_PART_MASK_BYTES);
        const uint32_t idx = seq_num - 1;
        mask[idx / 8] |= (uint8_t)(1u << (idx % 8));
        return true;
    }

    const uint8_t seed_in[8] = {
        (uint8_t)(seq_num >> 24), (uint8_t)(seq_num >> 16),
        (uint8_t)(seq_num >> 8),  (uint8_t)seq_num,
        (uint8_t)(checksum >> 24), (uint8_t)(checksum >> 16),
        (uint8_t)(checksum >> 8),  (uint8_t)checksum,
    };
    uint8_t digest[32];
    sha256_Raw(seed_in, sizeof seed_in, digest);

    UrRng rng;
    ur_rng_seed(&rng, digest);

    const size_t degree = choose_degree(seq_len, &rng, scratch);

    /* Fisher-Yates by removal, exactly as the reference shuffles: draw an
       index from what is left, take it, close the gap. Only the first `degree`
       draws matter, but the draws themselves must match. */
    int16_t *remaining = scratch->remaining;
    for (uint32_t i = 0; i < seq_len; i++) {
        remaining[i] = (int16_t)i;
    }

    memset(mask, 0, UR_PART_MASK_BYTES);
    size_t left = seq_len;
    for (size_t taken = 0; taken < degree && left > 0; taken++) {
        const uint64_t index = ur_rng_next_int(&rng, 0, (uint64_t)left - 1);
        const int16_t item = remaining[index];
        for (size_t j = (size_t)index; j + 1 < left; j++) {
            remaining[j] = remaining[j + 1];
        }
        left--;
        mask[item / 8] |= (uint8_t)(1u << (item % 8));
    }

    return true;
}

uint32_t ur_mask_count(const uint8_t mask[UR_PART_MASK_BYTES], uint32_t seq_len)
{
    uint32_t n = 0;
    for (uint32_t i = 0; i < seq_len && i < UR_MAX_PARTS; i++) {
        if (mask[i / 8] & (1u << (i % 8))) {
            n++;
        }
    }
    return n;
}
