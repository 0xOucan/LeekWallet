/**
 * ERC-7730 clear-signing descriptors, host side only (docs/CLEAR-SIGNING.md §5b).
 *
 * What this buys: today a call the firmware cannot decode reads "unknown call"
 * and the app has nothing better to say. A descriptor from the Ethereum
 * Foundation's registry turns that into "Aave: Supply — Amount 100 USDC", for
 * thousands of contracts, with no firmware change at all.
 *
 * What it does NOT buy, and the reason every type in this file says
 * `unverified: true` out loud:
 *
 *   A registry descriptor is unsigned, host-supplied data. Registry review is
 *   a quality gate run by maintainers; it is not a signature, and there is
 *   nothing in it our device could check. So descriptor output may inform the
 *   app's preview — which is advisory by construction (PROTOCOL.md 6c) — and
 *   must NEVER be sent to the device, echoed onto the device screen, or used
 *   to decide whether the device will sign. Rendering host-chosen labels on a
 *   signing device is strictly worse than rendering a hash, because the hash
 *   does not lie (CLEAR-SIGNING.md §5, "Never").
 *
 * Consequently nothing here touches eth-decode.ts's verdict. `isDecodable()`
 * still decides what the device will accept; a descriptor cannot make a
 * refused call acceptable, and a descriptor's absence cannot make an accepted
 * call suspicious.
 *
 * Design rules, all of them inherited from the firmware decoder:
 *
 * - **Exact, not best-effort.** A signature with any dynamic type (bytes,
 *   string, arrays, tuples) has argument offsets we would have to follow to
 *   read, and a misread offset produces a confident wrong number. Those
 *   formats are dropped whole rather than partly rendered.
 * - **Ignore what we cannot render.** An unsupported field format is omitted
 *   and counted, never guessed at. The count is surfaced so the UI can say
 *   "2 fields not shown" instead of implying the list is complete.
 * - **Malformed is rejected, not repaired.** `parseDescriptor` returns null
 *   for a structurally broken descriptor rather than applying the half of it
 *   that parsed — a descriptor that lost half its fields on the way in would
 *   describe a different transaction than the one being signed.
 */

import { keccak_256 } from "@noble/hashes/sha3";

import { formatUnits, tokenHint } from "./chains.ts";
import { CallKind, type DecodedCall } from "./eth-decode.ts";

/* ------------------------------------------------------------------ types */

/** One (chainId, address) pair the descriptor claims to describe. */
export interface DescriptorDeployment {
  chainId: number;
  /** Lower-case hex, 0x-prefixed. Comparison is case-insensitive. */
  address: string;
}

/** The field formats we are willing to draw. Anything else is dropped. */
export type FieldFormat =
  | "raw"
  | "amount"
  | "tokenAmount"
  | "addressName"
  | "date"
  | "duration"
  | "enum";

/** Where a field's bytes come from. */
type FieldSource =
  | { from: "param"; word: number; type: string }
  /** The transaction's own value — not calldata. ERC-7730 path `@.value`. */
  | { from: "txValue" };

/** Where a tokenAmount's decimals should be looked up. */
type TokenRef =
  | { from: "literal"; address: string }
  | { from: "param"; word: number };

interface PreparedField {
  label: string;
  format: FieldFormat;
  source: FieldSource;
  token?: TokenRef;
  /** tokenAmount `threshold`: at or above this, print `thresholdMessage`. */
  threshold?: bigint;
  thresholdMessage?: string;
  /** enum: value → label, straight out of the descriptor's metadata. */
  enumMap?: Readonly<Record<string, string>>;
}

interface PreparedFormat {
  /** Lower-case, 8 hex digits, no 0x. */
  selector: string;
  /** Canonical signature (names stripped) — what the selector was taken from. */
  signature: string;
  intent: string;
  fields: readonly PreparedField[];
  /** Total 32-byte words of arguments. Calldata length must match exactly. */
  words: number;
  /** Fields the descriptor itself marks `visible: never`. Not our omission. */
  hidden: number;
  /** Fields we refused to render because we cannot render them honestly. */
  omitted: number;
}

export interface Descriptor {
  /**
   * Provenance, shown to the user. Carried per descriptor rather than implied
   * by which array it came from, for the same reason `TokenHint.verified`
   * exists in chains.ts: no renderer can print a descriptor label without
   * having had to look straight at where it came from.
   */
  source: string;
  owner?: string;
  contractName?: string;
  deployments: readonly DescriptorDeployment[];
  formats: readonly PreparedFormat[];
}

/** One rendered line. Every string in here is descriptor-derived. */
export interface DescriptorField {
  label: string;
  value: string;
  format: FieldFormat;
}

/**
 * A descriptor's account of a transaction.
 *
 * `unverified` is `true` and never anything else — as a field rather than a
 * convention, so that a renderer has to type it out to ignore it.
 */
export interface DescriptorMatch {
  advisory: true;
  unverified: true;
  /** Registry path plus pinned commit; see erc7730-bundled.ts. */
  source: string;
  owner?: string;
  contractName?: string;
  intent: string;
  signature: string;
  /** 0x-prefixed, 8 hex digits. */
  selector: string;
  fields: readonly DescriptorField[];
  /** Fields the descriptor asked not to display. */
  hiddenFields: number;
  /** Fields we would not render. Non-zero means this list is incomplete. */
  omittedFields: number;
  /**
   * Where this descriptor and the firmware-mirroring decoder disagree about
   * the same call. Never empty for a good reason: a mismatch here means one of
   * the two is reading the calldata wrongly, and the user should be told
   * rather than shown whichever answer we happened to prefer.
   */
  conflicts: readonly string[];
}

/* -------------------------------------------------------------- signatures */

const DYNAMIC = /^(bytes|string)$/;

/** Static ABI types occupying exactly one word. Everything else is dynamic. */
function isStaticType(type: string): boolean {
  if (type === "address" || type === "bool") return true;
  if (DYNAMIC.test(type)) return false;
  let m = /^u?int(\d+)?$/.exec(type);
  if (m) {
    const bits = m[1] === undefined ? 256 : Number(m[1]);
    return bits > 0 && bits <= 256 && bits % 8 === 0;
  }
  m = /^bytes(\d+)$/.exec(type);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 32;
  }
  return false; // arrays, tuples, fixed-point: offsets we will not follow
}

interface ParsedSignature {
  canonical: string;
  params: ReadonlyArray<{ name?: string; type: string }>;
}

/**
 * Parse an ERC-7730 format key: `"repay(address asset, uint256 amount)"`.
 *
 * The key carries the parameter names, which is what makes the ABI-less
 * approach work — `#.amount` resolves against this and nothing else. Returns
 * null for anything that is not a plain, fully static signature, including a
 * bare `0x...` selector key: without types there is no honest way to read the
 * arguments, and rendering the intent alone against calldata we did not check
 * the length of would be exactly the half-understanding this module refuses.
 */
export function parseSignature(key: string): ParsedSignature | null {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/.exec(key.trim());
  if (!m) return null;
  const name = m[1] as string;
  const body = (m[2] as string).trim();
  if (body.includes("(") || body.includes(")")) return null; // tuple

  const params: Array<{ name?: string; type: string }> = [];
  if (body.length > 0) {
    for (const raw of body.split(",")) {
      const parts = raw.trim().split(/\s+/);
      const type = parts[0];
      if (type === undefined || !isStaticType(type)) return null;
      const p: { name?: string; type: string } = { type };
      // "calldata"/"memory" cannot appear on static types, so parts[1] is a name.
      if (parts.length > 1 && parts[1] !== undefined) p.name = parts[1];
      params.push(p);
    }
  }
  return { canonical: `${name}(${params.map((p) => p.type).join(",")})`, params };
}

/** keccak-256 of the canonical signature, first four bytes, lower-case hex. */
export function selectorOf(canonical: string): string {
  const h = keccak_256(new TextEncoder().encode(canonical));
  return [...h.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ parsing */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  "raw", "amount", "tokenAmount", "addressName", "date", "duration", "enum",
]);

/**
 * Resolve a `$.metadata.constants.foo` / `$.metadata.enums.foo` reference.
 * Only those two roots: a general JSON-pointer walk over host data is a lot of
 * surface for two lookups.
 */
function resolveMetadataRef(ref: unknown, metadata: Record<string, unknown>): unknown {
  if (typeof ref !== "string") return undefined;
  const m = /^\$\.metadata\.(constants|enums)\.(.+)$/.exec(ref);
  if (!m) return undefined;
  const bucket = metadata[m[1] as string];
  if (!isObject(bucket)) return undefined;
  return bucket[m[2] as string];
}

function toBigInt(v: unknown): bigint | undefined {
  try {
    if (typeof v === "string") return BigInt(v);
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  } catch {
    /* falls through to undefined: an unparseable threshold is not a threshold */
  }
  return undefined;
}

/**
 * Parse one descriptor. Returns null rather than a partial descriptor.
 *
 * The distinction that matters: *malformed* (not an object, no deployments, a
 * deployment that is not an address, a field with no label) rejects the whole
 * file, because we cannot tell which other parts are also wrong. *Unsupported*
 * (a format we do not draw, a signature with dynamic types) drops just that
 * field or that format and is counted, because there is nothing wrong with it
 * — we simply decline to render it.
 */
export function parseDescriptor(raw: unknown, source: string): Descriptor | null {
  if (!isObject(raw) || typeof source !== "string" || source.length === 0) return null;

  const context = raw["context"];
  if (!isObject(context)) return null;
  const contract = context["contract"];
  if (!isObject(contract)) return null;
  const deploymentsRaw = contract["deployments"];
  if (!Array.isArray(deploymentsRaw) || deploymentsRaw.length === 0) return null;

  const deployments: DescriptorDeployment[] = [];
  for (const d of deploymentsRaw) {
    if (!isObject(d)) return null;
    const chainId = d["chainId"];
    const address = d["address"];
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) return null;
    deployments.push({ chainId, address: address.toLowerCase() });
  }

  const metadata = isObject(raw["metadata"]) ? (raw["metadata"] as Record<string, unknown>) : {};
  const owner = typeof metadata["owner"] === "string" ? metadata["owner"] : undefined;
  const contractName =
    typeof metadata["contractName"] === "string" ? metadata["contractName"] : undefined;

  const display = raw["display"];
  if (!isObject(display)) return null;
  const formatsRaw = display["formats"];
  if (!isObject(formatsRaw)) return null;

  const formats: PreparedFormat[] = [];
  for (const [key, value] of Object.entries(formatsRaw)) {
    if (!isObject(value)) return null;
    const intent = value["intent"];
    // `interpolatedIntent` is deliberately ignored: it inlines field values
    // into a sentence, and a sentence is where a misread number hides.
    if (typeof intent !== "string" || intent.length === 0) return null;

    const sig = parseSignature(key);
    if (sig === null) continue; // unsupported shape, not a malformed file

    const fieldsRaw = value["fields"];
    if (fieldsRaw !== undefined && !Array.isArray(fieldsRaw)) return null;

    const wordOf = new Map<string, number>();
    sig.params.forEach((p, i) => {
      if (p.name !== undefined) wordOf.set(p.name, i);
    });

    const fields: PreparedField[] = [];
    let hidden = 0;
    let omitted = 0;

    for (const f of (fieldsRaw ?? []) as unknown[]) {
      if (!isObject(f)) return null;
      const label = f["label"];
      const path = f["path"];
      if (typeof label !== "string" || label.length === 0) return null;
      if (typeof path !== "string" || path.length === 0) return null;

      if (f["visible"] === "never") { hidden++; continue; }

      const fmt = f["format"];
      // A field with no format is a raw value in the spec's default reading.
      const format = fmt === undefined ? "raw" : fmt;
      if (typeof format !== "string" || !SUPPORTED_FORMATS.has(format)) { omitted++; continue; }

      const source_ = resolvePath(path, wordOf, sig.params);
      if (source_ === null) { omitted++; continue; }
      // `amount` means the chain's native currency; on a calldata word that
      // would be an 18-decimal claim about an arbitrary integer.
      if (format === "amount" && source_.from !== "txValue") { omitted++; continue; }

      const field: PreparedField = { label, format: format as FieldFormat, source: source_ };
      const params = isObject(f["params"]) ? (f["params"] as Record<string, unknown>) : {};

      if (format === "date") {
        // blockheight dates need chain state we do not have.
        if (params["encoding"] !== "timestamp") { omitted++; continue; }
      }

      if (format === "enum") {
        const map = resolveMetadataRef(params["$ref"], metadata);
        if (!isObject(map)) { omitted++; continue; }
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(map)) {
          if (typeof v !== "string") return null;
          clean[k] = v;
        }
        field.enumMap = clean;
      }

      if (format === "tokenAmount") {
        const literal = params["token"];
        const viaPath = params["tokenPath"];
        const resolved = resolveMetadataRef(literal, metadata) ?? literal;
        if (typeof resolved === "string" && ADDRESS_RE.test(resolved)) {
          field.token = { from: "literal", address: resolved.toLowerCase() };
        } else if (typeof viaPath === "string") {
          const ref = resolvePath(viaPath, wordOf, sig.params);
          if (ref !== null && ref.from === "param" && ref.type === "address") {
            field.token = { from: "param", word: ref.word };
          }
        }
        // No token reference is not fatal: raw units are still the truth.
        const threshold = toBigInt(resolveMetadataRef(params["threshold"], metadata) ?? params["threshold"]);
        const message = params["message"];
        if (threshold !== undefined && typeof message === "string") {
          field.threshold = threshold;
          field.thresholdMessage = message;
        }
      }

      fields.push(field);
    }

    formats.push({
      selector: selectorOf(sig.canonical),
      signature: sig.canonical,
      intent,
      fields,
      words: sig.params.length,
      hidden,
      omitted,
    });
  }

  if (formats.length === 0) return null;

  const out: Descriptor = { source, deployments, formats };
  if (owner !== undefined) out.owner = owner;
  if (contractName !== undefined) out.contractName = contractName;
  return out;
}

/**
 * Resolve an ERC-7730 path to a source of bytes.
 *
 * Supported: `amount`, `#.amount` (a top-level calldata parameter by name) and
 * `@.value` (the transaction's own value). `@.from`, `@.to`, nested paths and
 * array slices return null and cost the field: `@.from` in particular is the
 * *sender*, which this module is not given and would have to invent.
 */
function resolvePath(
  path: string,
  wordOf: ReadonlyMap<string, number>,
  params: ReadonlyArray<{ name?: string; type: string }>,
): FieldSource | null {
  if (path === "@.value") return { from: "txValue" };
  if (path.startsWith("@.")) return null;
  const name = path.startsWith("#.") ? path.slice(2) : path;
  if (name.includes(".") || name.includes("[")) return null;
  const word = wordOf.get(name);
  if (word === undefined) return null;
  const type = params[word]?.type;
  if (type === undefined) return null;
  return { from: "param", word, type };
}

/* ---------------------------------------------------------------- matching */

function toBytes(data: unknown): Uint8Array | null {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (typeof data !== "string") return null;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * EIP-55 casing. A local copy rather than an import from tx-interpret.ts,
 * which imports this module; the algorithm is four lines and a cycle between
 * the two files is a worse trade than the duplication.
 */
function checksum(hex40: string): string {
  const lower = hex40.toLowerCase();
  const h = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? (h[i >> 1] as number) >> 4 : (h[i >> 1] as number) & 0x0f;
    const c = lower[i] as string;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** What kind of thing a word holds, for the cross-check below. */
type Role = "address" | "amount" | "bool";

/**
 * The firmware decoder's own reading of each argument word, by call kind.
 *
 * This mirrors the argument shapes in eth-decode.ts. It exists purely so a
 * descriptor that labels word 0 as an amount, where the decoder read an
 * address, produces a visible disagreement rather than two confident and
 * incompatible summaries on the same card.
 */
const BUILTIN_ROLES: Partial<Record<CallKind, readonly Role[]>> = {
  [CallKind.Erc20Transfer]: ["address", "amount"],
  [CallKind.Erc20Approve]: ["address", "amount"],
  [CallKind.Erc20TransferFrom]: ["address", "address", "amount"],
  [CallKind.SetApprovalForAll]: ["address", "bool"],
  [CallKind.WethWithdraw]: ["amount"],
  [CallKind.MintTo]: ["address", "amount"],
  [CallKind.Mint]: ["amount"],
  [CallKind.MintTokenTo]: ["address", "address", "amount"],
};

function roleOfType(type: string): Role {
  if (type === "address") return "address";
  if (type === "bool") return "bool";
  return "amount";
}

export interface MatchInput {
  chainId: number | bigint;
  to?: string | Uint8Array | undefined;
  data?: string | Uint8Array | undefined;
  value?: bigint | undefined;
  /** The chain's gas-token ticker, for `amount` fields. From chains.ts only. */
  nativeSymbol?: string;
  /** The firmware-mirroring decoder's reading, for the disagreement check. */
  builtin?: DecodedCall;
}

/**
 * Find and render the descriptor for a call, or undefined.
 *
 * Pure: no network, no clock. Fetching a descriptor per transaction would tell
 * whoever serves it which contract you are about to sign for, which is the
 * leak PROTOCOL.md 6c warns about; see erc7730-bundled.ts for why the set is
 * bundled instead.
 */
export function matchDescriptor(
  descriptors: readonly Descriptor[],
  input: MatchInput,
): DescriptorMatch | undefined {
  const chainId = Number(input.chainId);
  const toBytes_ = input.to instanceof Uint8Array ? input.to : undefined;
  const to =
    toBytes_ !== undefined
      ? toBytes_.length === 20
        ? "0x" + hex(toBytes_)
        : undefined
      : typeof input.to === "string" && ADDRESS_RE.test(input.to)
        ? input.to.toLowerCase()
        : undefined;
  if (to === undefined) return undefined;

  const bytes = toBytes(input.data);
  if (bytes === null || bytes.length < 4) return undefined;
  const selector = hex(bytes.subarray(0, 4));

  for (const d of descriptors) {
    // Both halves must match. A descriptor for the same contract address on a
    // different chain is a different contract, and saying otherwise is how a
    // testnet faucet gets described as a mainnet vault.
    if (!d.deployments.some((dep) => dep.chainId === chainId && dep.address === to)) continue;
    const fmt = d.formats.find((f) => f.selector === selector);
    if (fmt === undefined) continue;

    // Exact length, like the firmware. Trailing bytes mean there is more to
    // this call than the descriptor accounts for.
    if (bytes.length !== 4 + fmt.words * 32) continue;

    const wordAt = (i: number) => bytes.subarray(4 + i * 32, 4 + i * 32 + 32);
    const uintAt = (i: number) => BigInt("0x" + hex(wordAt(i)));
    const addressAt = (i: number): string | null => {
      const w = wordAt(i);
      for (let j = 0; j < 12; j++) if (w[j] !== 0) return null;
      return "0x" + hex(w.subarray(12));
    };

    const fields: DescriptorField[] = [];
    let omitted = fmt.omitted;

    for (const f of fmt.fields) {
      const value = renderField(f, { uintAt, addressAt, wordAt }, input, chainId);
      if (value === null) { omitted++; continue; }
      fields.push({ label: f.label, value, format: f.format });
    }

    const conflicts: string[] = [];
    const roles = input.builtin ? BUILTIN_ROLES[input.builtin.kind] : undefined;
    if (roles !== undefined) {
      if (roles.length !== fmt.words) {
        conflicts.push(
          `This app's own decoder reads ${roles.length} argument(s) here; the ` +
            `descriptor describes ${fmt.words}.`,
        );
      }
      for (const f of fmt.fields) {
        if (f.source.from !== "param") continue;
        const mine = roles[f.source.word];
        if (mine === undefined) continue;
        const theirs = roleOfType(f.source.type);
        if (mine !== theirs) {
          conflicts.push(
            `Argument ${f.source.word + 1}: this app's own decoder reads it as ` +
              `${mine === "amount" ? "an amount" : `a ${mine}`}, the descriptor as ` +
              `${theirs === "amount" ? "an amount" : `a ${theirs}`}.`,
          );
        }
      }
    }

    const match: DescriptorMatch = {
      advisory: true,
      unverified: true,
      source: d.source,
      intent: fmt.intent,
      signature: fmt.signature,
      selector: "0x" + selector,
      fields,
      hiddenFields: fmt.hidden,
      omittedFields: omitted,
      conflicts,
    };
    if (d.owner !== undefined) match.owner = d.owner;
    if (d.contractName !== undefined) match.contractName = d.contractName;
    return match;
  }

  return undefined;
}

interface Words {
  uintAt: (i: number) => bigint;
  addressAt: (i: number) => string | null;
  wordAt: (i: number) => Uint8Array;
}

const SECONDS = [
  ["d", 86400n],
  ["h", 3600n],
  ["m", 60n],
  ["s", 1n],
] as const;

/** Render one field, or null to omit it. Never throws, never guesses. */
function renderField(
  f: PreparedField,
  w: Words,
  input: MatchInput,
  chainId: number,
): string | null {
  if (f.source.from === "txValue") {
    const wei = input.value ?? 0n;
    return `${formatUnits(wei, 18)} ${input.nativeSymbol ?? "(native token)"}`;
  }

  const { word, type } = f.source;

  if (f.format === "addressName" || (f.format === "raw" && type === "address")) {
    const a = w.addressAt(word);
    // Non-zero padding is not an address; the firmware refuses the same bytes.
    return a === null ? null : checksum(a.slice(2));
  }

  if (f.format === "enum") {
    const v = w.uintAt(word);
    // An unlisted enum value is a call the descriptor does not describe. No
    // fallback: "3" rendered where the contract means something specific is
    // worse than the field being absent.
    return f.enumMap?.[v.toString()] ?? null;
  }

  if (f.format === "duration") {
    let left = w.uintAt(word);
    if (left === 0n) return "0s";
    const parts: string[] = [];
    for (const [unit, size] of SECONDS) {
      const n = left / size;
      if (n > 0n) parts.push(`${n}${unit}`);
      left %= size;
    }
    return parts.join(" ");
  }

  if (f.format === "date") {
    const secs = w.uintAt(word);
    // Beyond year 275760 Date gives Invalid Date; a wrong date is worse than
    // none, so out-of-range is an omission.
    if (secs > 8_640_000_000_000n) return null;
    return new Date(Number(secs) * 1000).toISOString().replace(".000Z", "Z");
  }

  if (f.format === "tokenAmount") {
    const raw = w.uintAt(word);
    if (f.threshold !== undefined && raw >= f.threshold) {
      return `${f.thresholdMessage} (${raw} raw units)`;
    }
    let token: string | undefined;
    if (f.token?.from === "literal") token = f.token.address;
    else if (f.token?.from === "param") token = w.addressAt(f.token.word) ?? undefined;

    const hint = token === undefined ? undefined : tokenHint(chainId, token);
    // Decimals are never taken from the descriptor and never assumed to be 18:
    // an amount scaled by the wrong power of ten is the one error a user
    // cannot spot by reading. Raw units are always shown alongside.
    return hint === undefined
      ? `${raw} raw units (decimals unknown)`
      : `${formatUnits(raw, hint.decimals)} ${hint.symbol} — unverified guess (${raw} raw units)`;
  }

  /* raw */
  if (type === "bool") {
    const bytes = w.wordAt(word);
    for (let i = 0; i < 31; i++) if (bytes[i] !== 0) return null;
    const last = bytes[31] as number;
    return last > 1 ? null : last === 1 ? "true" : "false";
  }
  if (type.startsWith("bytes")) return "0x" + hex(w.wordAt(word));
  if (type.startsWith("int")) {
    // Two's complement over the full word; the narrow int types sign-extend.
    const v = w.uintAt(word);
    const bits = type === "int" ? 256 : Number(type.slice(3));
    const limit = 1n << BigInt(bits - 1);
    return (v >= limit ? v - (limit << 1n) : v).toString();
  }
  return w.uintAt(word).toString();
}

/**
 * The sentence that must accompany any rendering of a DescriptorMatch.
 *
 * A constant, like ADVISORY_NOTICE and TOKEN_HINT_NOTICE, so it cannot drift
 * between screens and so a reviewer can grep for whether it is shown at all.
 */
export const DESCRIPTOR_NOTICE =
  "These labels come from a public ERC-7730 descriptor bundled with this app. " +
  "They are unsigned, the device never sees them, and nothing cryptographic " +
  "ties them to the contract you are calling.";
