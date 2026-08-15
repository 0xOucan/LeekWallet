/**
 * EIP-712 typed data as the DEVICE sees it — the mirror of src/eip712.c.
 *
 * The mock device has to refuse exactly what the firmware refuses, and never
 * less. A mock that is more permissive certifies host code the real device then
 * rejects; that has happened twice in this project already (see mock-device.ts),
 * and typed data is the worst place for it, because the refusal is the feature.
 * So this file is a deliberate reimplementation of one function: which
 * documents the device can hash, which of those it can also put on its screen,
 * and what those screens say.
 *
 * What it deliberately does NOT do is compute the digest.
 *
 * That is not laziness. The mock's signatures are fabricated bytes — nothing
 * verifies them — so a keccak implementation here would be a second hashing
 * path that nobody signs with, checked against nothing, free to drift. The
 * digest is pinned where it can be wrong in a way that matters: sim/
 * test_eip712.c runs the real firmware C against EIP-712's own worked example,
 * and test/eip712.test.ts recomputes the same three vectors with viem so the
 * two implementations have to agree. Duplicating it a third time here would add
 * a place to be wrong, not a place to be caught.
 *
 * Values arrive in the wire encoding from cbor.ts, which is the same encoding
 * protocol.c parses: addresses and big integers as byte strings, small integers
 * and booleans as numbers, strings as text, structs as maps. See eip712.h for
 * the table and for why each type has exactly one spelling.
 */

import type { CborValue } from "./cbor.ts";
import { checksumAddress } from "./tx-interpret.ts";

/** EIP712_MAX_DEPTH — Permit2's nesting is two, the EIP's Mail is two. */
const MAX_DEPTH = 3;
/** EIP712_MAX_FIELDS / EIP712_MAX_TYPES. */
const MAX_FIELDS = 12;
const MAX_TYPES = 8;
/** EIP712_MAX_RENDER_FIELDS — pages the confirmation screen will page through. */
const MAX_RENDER_FIELDS = 6;
/** EIP712_MAX_LABEL / EIP712_MAX_VALUE, less their NUL terminators. */
const MAX_LABEL = 20;
const MAX_VALUE = 79;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export interface TypedField {
  label: string;
  value: string;
  isAddress: boolean;
  /** An allowance beyond any real supply — the field a Permit drainer sets. */
  unlimited: boolean;
  /** A deadline or expiry: raw seconds, and a signature that lives that long. */
  isDeadline: boolean;
}

export interface TypedRender {
  primaryType: string;
  domainName?: string;
  chainId?: bigint;
  verifyingContract?: string;
  fields: TypedField[];
}

export type TypedDataVerdict =
  /** Hashable and fully showable: the device signs this by default. */
  | { kind: "ok"; render: TypedRender }
  /**
   * Hashable, not showable in full. The digest would be real, so blind signing
   * may take it — the caller decides, exactly as protocol.c does.
   */
  | { kind: "unrenderable"; render: TypedRender; why: string }
  /**
   * No digest at all: arrays, an undefined type, a value contradicting its
   * declared type, nesting too deep. Refused whatever the settings say, for the
   * same reason contract creation is — the only way past would be to take a
   * digest from the host.
   */
  | { kind: "unhashable"; why: string }
  /** Not shaped like a typed-data request. A protocol error, not a policy one. */
  | { kind: "malformed"; why: string };

interface TypeField {
  name: string;
  type: string;
}

/* A refusal thrown from inside the walk and caught at the top, so the recursion
 * reads as the encoding it mirrors rather than as error plumbing. */
class Unhashable extends Error {}

const isMap = (v: unknown): v is Record<string, CborValue> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

/** Big-endian bytes, or a small unsigned integer, to a bigint. */
function toBig(v: CborValue): bigint | undefined {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (v instanceof Uint8Array) {
    if (v.length > 32) return undefined;
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return n;
  }
  return undefined;
}

/**
 * The same "beyond any real supply" rule eth-decode.ts applies to an ERC-20
 * approve, generalised to the field's declared width: 2^(N-1) and up. Permit2
 * spells unlimited as type(uint160).max and ERC-2612 as type(uint256).max.
 * Narrow fields are left alone — a uint32 at 2^31 is a plausible number.
 */
function isUnlimited(value: bigint, bits: number): boolean {
  if (bits < 64) return false;
  return value >= 1n << BigInt(bits - 1);
}

const DEADLINE_HINTS = ["deadline", "expir", "validuntil", "validbefore"];
const looksLikeDeadline = (name: string) =>
  DEADLINE_HINTS.some((h) => name.toLowerCase().includes(h));

/** `uint256` → 256, and undefined for anything that is not exactly a number. */
function trailingNumber(s: string, prefix: string): number | undefined {
  const tail = s.slice(prefix.length);
  if (tail === "" || !/^\d+$/.test(tail)) return undefined;
  const n = Number(tail);
  return n > 256 ? undefined : n;
}

/**
 * Inspect a `signTypedData` request the way the firmware does.
 *
 * `params` is the decoded request map — `types`, `primaryType`, `domain` and
 * `message`, read from the top level exactly as protocol.c reads them.
 */
export function inspectTypedData(params: Record<string, CborValue>): TypedDataVerdict {
  const rawTypes = params["types"];
  const primaryType = params["primaryType"];
  const domain = params["domain"];
  const message = params["message"];

  if (!isMap(rawTypes)) return { kind: "malformed", why: "no types" };
  if (typeof primaryType !== "string") return { kind: "malformed", why: "no primaryType" };
  if (!isMap(domain)) return { kind: "malformed", why: "no domain" };
  if (!isMap(message)) return { kind: "malformed", why: "no message" };

  const types = new Map<string, TypeField[]>();
  for (const [name, defn] of Object.entries(rawTypes)) {
    if (!Array.isArray(defn)) return { kind: "malformed", why: `type ${name} is not a list` };
    if (defn.length > MAX_FIELDS || types.size >= MAX_TYPES) {
      return { kind: "malformed", why: "more types or fields than the device holds" };
    }
    const fields: TypeField[] = [];
    for (const entry of defn) {
      if (!isMap(entry) || typeof entry["name"] !== "string" || typeof entry["type"] !== "string") {
        return { kind: "malformed", why: `type ${name} has a malformed field` };
      }
      fields.push({ name: entry["name"], type: entry["type"] });
    }
    types.set(name, fields);
  }

  if (!types.has("EIP712Domain") || !types.has(primaryType)) {
    return { kind: "unhashable", why: "a type the document uses is never defined" };
  }

  const render: TypedRender = { primaryType, fields: [] };
  /* Sticky, like the C: the walk runs to the end even after the first
   * unshowable leaf, because the blind path still needs to know the document
   * would have hashed. */
  let unshowable: string | undefined;

  const claim = (prefix: string, name: string): TypedField | undefined => {
    const label = prefix ? `${prefix}.${name}` : name;
    if (render.fields.length >= MAX_RENDER_FIELDS) {
      unshowable ??= "more fields than the device screen can page through";
      return undefined;
    }
    if (label.length > MAX_LABEL) {
      unshowable ??= `the field name ${label} does not fit a row`;
      return undefined;
    }
    const field: TypedField = {
      label, value: "", isAddress: false, unlimited: false, isDeadline: false,
    };
    render.fields.push(field);
    return field;
  };

  /* One traversal, hashing and rendering together — or rather, mirroring the
   * hashing decisions and rendering. Every `throw new Unhashable` here marks a
   * point where src/eip712.c returns EIP712_UNHASHABLE. */
  const walk = (typeName: string, value: Record<string, CborValue>,
                depth: number, prefix: string, collect: boolean): void => {
    if (depth > MAX_DEPTH) throw new Unhashable("nested too deep");
    const fields = types.get(typeName);
    if (!fields) throw new Unhashable(`type ${typeName} is not defined`);

    for (const f of fields) {
      if (f.type.includes("[")) {
        /* Arrays would need an array encoding to hash and an array screen to
         * show, and until both exist the honest answer is that this device
         * cannot sign that document at all. */
        throw new Unhashable(`${f.name} is an array`);
      }
      const v = value[f.name];
      if (v === undefined) throw new Unhashable(`${f.name} is missing from the message`);

      /* Structs before anything else, because they are the one field kind that
       * takes no page of its own — its leaves take the pages. */
      if (types.has(f.type)) {
        if (!isMap(v)) throw new Unhashable(`${f.name} is not a struct`);
        /* Flattened under a dotted label. A page reading "details: (a struct)"
         * would hide exactly the number a Permit2 signature is about. */
        const nested = prefix ? `${prefix}.${f.name}` : f.name;
        if (collect && nested.length > MAX_LABEL) {
          unshowable ??= `the field name ${nested} does not fit a row`;
        }
        walk(f.type, v, depth + 1, nested, collect);
        continue;
      }

      const target = collect ? claim(prefix, f.name) : undefined;

      if (f.type === "address") {
        if (!(v instanceof Uint8Array) || v.length !== 20) {
          throw new Unhashable(`${f.name} is not a 20-byte address`);
        }
        if (target) {
          target.isAddress = true;
          target.value = checksumAddress(hex(v));
        }
        continue;
      }
      if (f.type === "bool") {
        if (typeof v !== "number" || (v !== 0 && v !== 1)) {
          throw new Unhashable(`${f.name} is not a bool`);
        }
        if (target) target.value = v ? "true" : "false";
        continue;
      }
      if (f.type === "string") {
        if (typeof v !== "string") throw new Unhashable(`${f.name} is not text`);
        if (target) {
          if (v.length > MAX_VALUE || !PRINTABLE_ASCII.test(v)) {
            unshowable ??= `${f.name} is text the device screen cannot draw`;
          } else {
            target.value = v;
          }
        }
        continue;
      }
      if (f.type === "bytes") {
        if (!(v instanceof Uint8Array)) throw new Unhashable(`${f.name} is not bytes`);
        if (target) {
          if (2 * v.length + 2 > MAX_VALUE) {
            unshowable ??= `${f.name} is too long to show whole`;
          } else {
            target.value = "0x" + hex(v);
          }
        }
        continue;
      }
      const bytesN = f.type.startsWith("bytes") ? trailingNumber(f.type, "bytes") : undefined;
      if (bytesN !== undefined) {
        if (bytesN < 1 || bytesN > 32) throw new Unhashable(`${f.name} has no such width`);
        if (!(v instanceof Uint8Array) || v.length !== bytesN) {
          throw new Unhashable(`${f.name} is not ${bytesN} bytes`);
        }
        if (target) target.value = "0x" + hex(v);
        continue;
      }
      const isUint = f.type.startsWith("uint");
      const bits = isUint
        ? trailingNumber(f.type, "uint")
        : f.type.startsWith("int") ? trailingNumber(f.type, "int") : undefined;
      if (bits !== undefined) {
        if (bits < 8 || bits > 256 || bits % 8 !== 0) {
          throw new Unhashable(`${f.name} has no such width`);
        }
        const n = toBig(v);
        /* Wider than the field it was declared for is a value the document is
         * lying about. Masking it would sign a different number. */
        if (n === undefined || n >= 1n << BigInt(bits)) {
          throw new Unhashable(`${f.name} does not fit its declared type`);
        }
        if (target) {
          target.isDeadline = looksLikeDeadline(f.name);
          target.unlimited = !target.isDeadline && isUint && isUnlimited(n, bits);
          target.value = n.toString(10);
        }
        continue;
      }

      throw new Unhashable(`${f.name} has type ${f.type}, which this device does not know`);
    }
  };

  try {
    walk("EIP712Domain", domain, 0, "", false);
    walk(primaryType, message, 0, "", true);
  } catch (e) {
    if (e instanceof Unhashable) return { kind: "unhashable", why: e.message };
    throw e;
  }

  /* Read for display only; the walk above already covered the same map through
   * the declared type, so nothing here changes what would be signed. */
  const dName = domain["name"];
  if (typeof dName === "string" && PRINTABLE_ASCII.test(dName) && dName.length <= 23) {
    render.domainName = dName;
  }
  const chain = domain["chainId"] === undefined ? undefined : toBig(domain["chainId"]);
  if (chain !== undefined) render.chainId = chain;
  const contract = domain["verifyingContract"];
  if (contract instanceof Uint8Array && contract.length === 20) {
    render.verifyingContract = checksumAddress(hex(contract));
  }

  /* A struct with no leaves renders as nothing, and a confirmation showing
   * nothing is a confirmation that means nothing. */
  if (render.fields.length === 0) {
    return { kind: "unrenderable", render, why: "the message has no fields to show" };
  }
  if (unshowable) return { kind: "unrenderable", render, why: unshowable };
  return { kind: "ok", render };
}

/**
 * The one-line summary a test can assert on, in the device's own vocabulary.
 *
 * Deliberately not prose from the dapp: the domain name is the only string here
 * that the host supplied, and it is quoted rather than asserted. See
 * PROTOCOL.md 6c.
 */
export function describeTypedData(render: TypedRender): string {
  const parts = [`${render.primaryType}`];
  if (render.domainName) parts.push(`for "${render.domainName}"`);
  if (render.verifyingContract) parts.push(`at ${render.verifyingContract}`);
  if (render.chainId !== undefined) parts.push(`on chain ${render.chainId}`);
  const unlimited = render.fields.find((f) => f.unlimited);
  /* Named, not printed. Seventy-eight digits scrolling past is not a number
   * anybody reads, and this is the field that empties the wallet. */
  if (unlimited) parts.push(`UNLIMITED ${unlimited.label}`);
  return parts.join(" ");
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/* ------------------------------------------------- dapp JSON → device wire */

/**
 * A dapp's `eth_signTypedData_v4` payload, converted to the request the device
 * parses.
 *
 * A dapp sends JSON, where an address is a string, a uint256 is a decimal
 * string that would lose precision as a JavaScript number, and a `bytes32` is
 * `0x…`. The device's CBOR subset has none of those spellings and, crucially,
 * exactly one spelling per ABI type (see eip712.h): the conversion has to be
 * driven by the DECLARED type of each field, not by guessing from the value's
 * shape. Guessing is how a `bytes32` that happens to look like a number gets
 * hashed as one.
 *
 * Throws on anything it cannot convert faithfully. The caller turns that into
 * an invalid-params refusal, which is the honest answer: a request this
 * function had to guess about is one the device would hash differently from
 * what the dapp meant.
 *
 * The device re-derives everything that matters from the result — this is a
 * transcription, not a source of truth, and nothing it produces is trusted by
 * the device any further than the CBOR it decodes.
 */
export function toDeviceTypedData(doc: unknown): Record<string, CborValue> {
  if (!isPlain(doc)) throw new Error("typed data is not an object");
  const types = doc["types"];
  const primaryType = doc["primaryType"];
  const domain = doc["domain"] ?? {};
  const message = doc["message"];
  if (!isPlain(types)) throw new Error("typed data has no types");
  if (typeof primaryType !== "string") throw new Error("typed data has no primaryType");
  if (!isPlain(domain)) throw new Error("typed data has no domain");
  if (!isPlain(message)) throw new Error("typed data has no message");

  const table = new Map<string, TypeField[]>();
  for (const [name, defn] of Object.entries(types)) {
    if (!Array.isArray(defn)) throw new Error(`type ${name} is not a list`);
    table.set(name, defn.map((f) => {
      if (!isPlain(f) || typeof f["name"] !== "string" || typeof f["type"] !== "string") {
        throw new Error(`type ${name} has a malformed field`);
      }
      return { name: f["name"], type: f["type"] };
    }));
  }
  if (!table.has("EIP712Domain")) throw new Error("typed data does not define EIP712Domain");
  if (!table.has(primaryType)) throw new Error(`typed data does not define ${primaryType}`);

  const convertStruct = (typeName: string, value: unknown): Record<string, CborValue> => {
    if (!isPlain(value)) throw new Error(`${typeName} value is not an object`);
    const fields = table.get(typeName);
    if (!fields) throw new Error(`${typeName} is not defined`);
    const out: Record<string, CborValue> = {};
    for (const f of fields) {
      /* A domain field the dapp left out is left out here too. EIP-712 lets a
       * domain carry any subset — Permit2's has no `version` — and inventing
       * one would compute a separator the contract never agrees with. */
      if (typeName === "EIP712Domain" && value[f.name] === undefined) continue;
      out[f.name] = convert(f.type, value[f.name], f.name);
    }
    return out;
  };

  const convert = (type: string, value: unknown, where: string): CborValue => {
    if (type.includes("[")) {
      // Refused rather than transcribed: the device cannot hash an array, so a
      // faithful conversion would produce a request it can only reject.
      throw new Error(`${where} is an array, which this device cannot hash`);
    }
    if (table.has(type)) return convertStruct(type, value);

    if (type === "address") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`${where} is not an address`);
      }
      return bytesFromHex(value);
    }
    if (type === "bool") {
      if (typeof value !== "boolean") throw new Error(`${where} is not a bool`);
      // The CBOR subset has no booleans; 0 and 1 are the device's spelling.
      return value ? 1 : 0;
    }
    if (type === "string") {
      if (typeof value !== "string") throw new Error(`${where} is not a string`);
      return value;
    }
    if (type === "bytes") {
      if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error(`${where} is not a hex byte string`);
      }
      return bytesFromHex(value);
    }
    const bytesN = type.startsWith("bytes") ? trailingNumber(type, "bytes") : undefined;
    if (bytesN !== undefined) {
      if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
        throw new Error(`${where} is not a hex byte string`);
      }
      const b = bytesFromHex(value);
      if (b.length !== bytesN) throw new Error(`${where} is not ${bytesN} bytes`);
      return b;
    }
    const isUint = type.startsWith("uint");
    const bits = isUint
      ? trailingNumber(type, "uint")
      : type.startsWith("int") ? trailingNumber(type, "int") : undefined;
    if (bits !== undefined) {
      let n: bigint;
      try {
        if (typeof value === "bigint") n = value;
        else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
        else if (typeof value === "string") n = BigInt(value.trim());
        else throw new Error("not a number");
      } catch {
        throw new Error(`${where} is not an integer`);
      }
      if (n < 0n) {
        /* Negative integers are outside the wire subset, so there is no
         * spelling for one. Refusing beats sending a two's-complement blob the
         * device would render with the wrong sign. */
        throw new Error(`${where} is negative, which this device cannot show`);
      }
      if (n >= 1n << BigInt(bits)) throw new Error(`${where} does not fit ${type}`);
      /* Small values as integers, large ones as big-endian bytes. Both are the
       * device's spelling for uintN; a value past 2^32 has no CBOR integer
       * form in this subset at all. */
      if (n <= 0xffffffffn) return Number(n);
      let h = n.toString(16);
      if (h.length % 2) h = "0" + h;
      return bytesFromHex("0x" + h);
    }

    throw new Error(`${where} has type ${type}, which this device does not know`);
  };

  return {
    types: types as unknown as CborValue,
    primaryType,
    domain: convertStruct("EIP712Domain", domain),
    message: convertStruct(primaryType, message),
  };
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function bytesFromHex(s: string): Uint8Array {
  return new Uint8Array((s.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
}
