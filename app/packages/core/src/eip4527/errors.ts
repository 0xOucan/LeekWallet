/**
 * Refusal codes for the EIP-4527 reader.
 *
 * These are shared with the firmware's `src/eip4527.h`, and the shared corpus
 * asserts that both sides refuse the same bytes with the same code. Identical
 * success is not enough: two decoders that accept the same frames but disagree
 * about which malformed ones to reject have two interpretations of the wire
 * format, and the disagreement surfaces on somebody's device rather than in
 * CI.
 *
 * The human-readable message may differ between implementations. The code may
 * not.
 */
export const E4527 = {
  /** A tag was present where a different specific tag was required. */
  WRONG_TAG: "E4527_ERR_WRONG_TAG",
  /** A byte string whose length the schema fixes was the wrong length. */
  BAD_LENGTH: "E4527_ERR_BAD_LENGTH",
  /** The same map key appeared twice. */
  DUPLICATE_FIELD: "E4527_ERR_DUPLICATE_FIELD",
  /** A map key the schema does not define. */
  UNKNOWN_FIELD: "E4527_ERR_UNKNOWN_FIELD",
  /** A field the schema requires was absent. */
  MISSING_FIELD: "E4527_ERR_MISSING_FIELD",
  /** `data-type` outside 1..4. */
  INVALID_DATA_TYPE: "E4527_ERR_INVALID_DATA_TYPE",
  /** Bytes left over after a complete item. */
  TRAILING_DATA: "E4527_ERR_TRAILING_DATA",
  /** A CBOR major type or construct this grammar does not contain. */
  MALFORMED: "E4527_ERR_MALFORMED",
} as const;

export type E4527 = (typeof E4527)[keyof typeof E4527];

export class E4527Error extends Error {
  readonly code: E4527;
  /** The schema field this happened in, for a diagnostic worth reading. */
  readonly field: string;

  constructor(code: E4527, field: string, detail: string) {
    super(`${code}: ${field}: ${detail}`);
    this.name = "E4527Error";
    this.code = code;
    this.field = field;
  }
}
