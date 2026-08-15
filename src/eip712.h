/**
 * EIP-712 typed structured data — hashing, and the decision to refuse (T12b).
 *
 * The rule from PROTOCOL.md 6bis applies here exactly as it does to calldata:
 * the device signs only what it computed and displayed. So this module never
 * accepts a digest. It takes the *structure* — the type definitions, the
 * domain, and the message values — recomputes `keccak256(0x19 0x01 ‖
 * domainSeparator ‖ hashStruct(message))` from those fields itself, and hands
 * the caller both that digest and a flat list of labelled strings that describe
 * the very same values. A host that lies about either half is caught by the
 * other: change a value to alter the rendering and the digest moves with it.
 *
 * Typed data is where the drainers live. `Permit`, `PermitSingle` and
 * `PermitBatch` are signatures, not transactions — they cost no gas, they never
 * appear in the victim's transaction history, and one of them hands an attacker
 * a spending allowance that a later on-chain call redeems. There is no
 * recipient address in the outer envelope to inspect, which is exactly why the
 * fields that matter (spender, amount, deadline) have to be legible on the
 * device rather than summarised by the host.
 *
 * ## What is supported, and what is refused
 *
 * Two different refusals, and the difference decides whether blind signing can
 * reopen them:
 *
 *   - **Cannot hash.** Arrays of any kind, a type referenced but not defined,
 *     a value whose CBOR shape contradicts its declared type, nesting past
 *     EIP712_MAX_DEPTH. The device cannot produce the digest at all here, and
 *     the only way past would be to accept one from the host — which is
 *     `signHash` wearing a schema. Refused permanently, like contract creation.
 *   - **Can hash, cannot show.** More leaf fields than the screen has pages, a
 *     string too long or not printable ASCII, a label too long to fit. The
 *     digest is real and correct; what is missing is the user's ability to read
 *     what they are approving. This is the blind-signing case, and the caller
 *     is told so through `Eip712Result` rather than deciding for itself.
 *
 * Atomic types supported: `address`, `bool`, `string`, `bytes`, `bytesN` for
 * N in 1..32, and `uintN`/`intN` for N a multiple of 8 up to 256. Nested
 * structs are supported to EIP712_MAX_DEPTH. Negative integers are refused:
 * CBOR negints are outside the wire subset, and a signed field arriving as an
 * unsigned two's-complement blob would be rendered with the wrong sign.
 *
 * ## Wire encoding of values
 *
 * The CBOR subset (see cbor.h) has no bignums and no booleans, so each ABI type
 * gets exactly one spelling and anything else is a hashing refusal:
 *
 *   | ABI type    | CBOR                                             |
 *   |-------------|--------------------------------------------------|
 *   | address     | byte string, exactly 20 bytes                    |
 *   | uintN/intN  | unsigned integer, or byte string ≤ 32 big-endian |
 *   | bool        | unsigned integer 0 or 1                          |
 *   | string      | text string                                      |
 *   | bytes       | byte string, any length                          |
 *   | bytesN      | byte string, exactly N bytes                     |
 *   | struct      | map                                              |
 *
 * One spelling per type is deliberate. Two would mean two byte strings that
 * hash to the same digest and render differently, and the whole point of
 * recomputing on-device is that there is only one answer.
 *
 * No ESP-IDF dependency, so the host suite drives it against the EIP's own
 * published vectors — see sim/test_eip712.c.
 */

#ifndef EIP712_H
#define EIP712_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* How deep a struct may nest. Permit2's `PermitSingle{PermitDetails details}`
 * is two, and the EIP's own `Mail{Person from}` is two. Three leaves room
 * without letting a hostile document drive the stack, and every level costs a
 * 32-byte-per-field encoding buffer in the frame below it. */
#define EIP712_MAX_DEPTH 3

/* Per-struct field count and the size of the type table. Both are bounded so a
 * document cannot choose the device's memory use; both are comfortably above
 * anything a real Permit, PermitSingle or Mail needs. */
#define EIP712_MAX_FIELDS 12
#define EIP712_MAX_TYPES  8

/* The rendered form. Fields are the *leaves* of the struct, flattened, so a
 * nested `details.amount` is one page rather than a page that says "details:
 * (a struct)" and hides the number that matters.
 *
 * Six is what the confirmation screen can page through before scrolling stops
 * being reading and starts being clicking. A structure with more leaves than
 * this hashes fine and is refused for display — see the header comment. */
#define EIP712_MAX_RENDER_FIELDS 6
#define EIP712_MAX_LABEL 21     /* one OLED row, plus the terminator */
#define EIP712_MAX_VALUE 80     /* a uint256 in decimal is 78 digits */

typedef struct {
    char label[EIP712_MAX_LABEL];   /* dotted path: "details.amount" */
    char value[EIP712_MAX_VALUE];   /* decimal, text, or "0x…" */
    /* Set when the value is a 20-byte address; `address` then holds it and the
     * screen draws the EIP-55 form across three rows rather than squeezing a
     * 42-character string into one. */
    bool    is_address;
    uint8_t address[20];
    /* An allowance nobody can spend through in practice: the maximum of the
     * field's own declared width, or anything from 2^255 up for a uint256.
     * This is the field a Permit drainer sets, and it gets the same shouting
     * the ERC-20 approve screen gives (see eth-decode.c). */
    bool    unlimited;
    /* A deadline or expiry: rendered as the raw seconds it is, and flagged so
     * the screen can say the signature stays good until then. A Permit with a
     * far-future deadline is a standing authorisation, not a one-off. */
    bool    is_deadline;
} Eip712Field;

typedef struct {
    char    primary_type[32];
    /* Domain fields, each optional: EIP-712 lets a domain carry any subset, and
     * a device that invented a missing one would be describing a different
     * document than the one it hashed. */
    char    domain_name[24];
    bool    has_domain_name;
    uint64_t chain_id;
    bool    has_chain_id;
    uint8_t verifying_contract[20];
    bool    has_verifying_contract;

    Eip712Field fields[EIP712_MAX_RENDER_FIELDS];
    int         field_count;
} Eip712Render;

typedef enum {
    /* Hashed and fully renderable. The only outcome that signs by default. */
    EIP712_OK = 0,
    /* Well-formed and hashed, but the screen cannot show all of it. `digest` is
     * valid; `render` holds the domain and whatever leaves fit, and the caller
     * must refuse unless blind signing is on. */
    EIP712_UNRENDERABLE,
    /* The digest could not be computed: arrays, an undefined type, a value that
     * does not match its declared type, or nesting too deep. Nothing valid to
     * sign, and no setting reopens it. */
    EIP712_UNHASHABLE,
    /* The request is not shaped like a typed-data request at all: missing
     * `types`, `primaryType`, `domain` or `message`, or CBOR that does not
     * parse. A protocol error rather than a policy one. */
    EIP712_MALFORMED
} Eip712Result;

/**
 * Hash a typed-data request and build its rendering, from one CBOR map.
 *
 * `payload` is the whole request map — the same buffer protocol.c already
 * parsed the method name out of — and the keys read are `types`, `primaryType`,
 * `domain` and `message`. Nothing is copied except the small strings that end
 * up in `render`, so the caller's buffer must outlive the call but nothing
 * outlives the caller.
 *
 * On EIP712_OK or EIP712_UNRENDERABLE, `digest` holds the 32 bytes that would
 * be signed and `render` describes them. On the other two nothing is written to
 * `digest` — a caller that signs on a result it did not check is signing zeros,
 * and zeros are a valid secp256k1 message.
 */
Eip712Result eip712_prepare(const uint8_t *payload, size_t len,
                            uint8_t digest[32], Eip712Render *render);

/**
 * The EIP-712 encodeType string for a struct, e.g.
 * `Mail(Person from,Person to,string contents)Person(string name,address wallet)`.
 *
 * Exposed only so the host suite can check it against the EIP's own worked
 * example: getting the referenced-type ordering wrong yields a digest that is
 * wrong in a way no amount of staring at the final hash explains. Returns the
 * length written, or 0 if the type is undefined, references something
 * undefined, or does not fit.
 */
size_t eip712_encode_type(const uint8_t *payload, size_t len,
                          const char *type_name, char *out, size_t out_size);

#endif /* EIP712_H */
