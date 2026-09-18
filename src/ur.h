/**
 * Uniform Resources (BC-UR): the wire format for the QR air gap.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what sits on top of it
 *
 * BC-UR is Blockchain Commons' encoding for putting binary data through QR
 * codes: CBOR payload, CRC-32 checksum, Bytewords text, and an optional
 * fountain code for splitting a payload across animated frames.
 *
 * EIP-4527 is a *profile* on top of it - it names the CBOR structures
 * (`crypto-hdkey`, `eth-sign-request`, `eth-signature`) and says nothing about
 * the encoding. Keeping the two apart in the code is deliberate: EIP-4527 is
 * marked Stagnant while BC-UR is what the wallets actually interoperate over,
 * and a chain-agnostic profile later should be an addition rather than a
 * rewrite. See docs/RESEARCH-AIRGAP-VAULT.md section 19.
 *
 * This file is the encoding only. No allocation, no globals, caller owns every
 * buffer - the same constraints as the rest of the firmware.
 *
 * ---------------------------------------------------------------------------
 * Bytewords
 *
 * 256 four-letter English words, chosen so the first and last letters of each
 * are a unique pair. "Minimal" style keeps only those two letters, so one byte
 * becomes two characters. A CRC-32 of the payload is appended before encoding,
 * which is why a decode can reject a misread frame rather than hand back
 * plausible rubbish.
 *
 * The word list is data from Blockchain Commons' bc-ur, BSD-2-Clause Plus
 * Patent. The implementation here is our own.
 */

#ifndef LEEK_UR_H
#define LEEK_UR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** Characters of Bytewords-minimal text for `len` bytes, excluding the NUL.
 *  Two per payload byte plus eight for the appended CRC-32. */
#define UR_BYTEWORDS_LEN(len)   (((len) + 4) * 2)

/** Standard CRC-32 (IEEE 802.3: reflected, init and final xor 0xFFFFFFFF). */
uint32_t ur_crc32(const uint8_t *data, size_t len);

/**
 * Encode `len` bytes as Bytewords-minimal, appending the CRC-32.
 *
 * Returns the number of characters written, excluding the NUL, or 0 if `out`
 * is too small. `out_size` must be at least UR_BYTEWORDS_LEN(len) + 1.
 */
size_t ur_bytewords_encode(const uint8_t *data, size_t len,
                           char *out, size_t out_size);

/**
 * Decode Bytewords-minimal text and verify its CRC-32.
 *
 * `text` need not be NUL-terminated; `text_len` decides. Returns false on an
 * odd length, an unknown letter pair, a payload larger than `out_size`, or a
 * CRC mismatch - in every case `*out_len` is left untouched and nothing in
 * `out` should be trusted.
 */
bool ur_bytewords_decode(const char *text, size_t text_len,
                         uint8_t *out, size_t out_size, size_t *out_len);

/** Longest UR type we accept, e.g. "eth-sign-request". */
#define UR_TYPE_MAX 32

/**
 * Encode a single-part UR: `ur:<type>/<bytewords>`.
 *
 * Returns characters written excluding the NUL, or 0 if `out` is too small or
 * `type` is not a valid UR type.
 */
size_t ur_encode(const char *type, const uint8_t *payload, size_t payload_len,
                 char *out, size_t out_size);

/**
 * Decode a single-part UR.
 *
 * Accepts the `ur:` scheme in any case, since QR readers and some wallets
 * uppercase the whole string to reach the QR alphanumeric mode. The type and
 * the Bytewords body are lowercased into `type_out` and decoded respectively.
 *
 * Returns false for a multi-part UR (`ur:<type>/<seq>-<count>/...`), which this
 * function deliberately does not handle; see ur_is_multipart().
 */
bool ur_decode(const char *ur, size_t ur_len,
               char *type_out, size_t type_size,
               uint8_t *out, size_t out_size, size_t *out_len);

/** True if `ur` carries a sequence component and so needs the fountain decoder. */
bool ur_is_multipart(const char *ur, size_t ur_len);

#endif /* LEEK_UR_H */
