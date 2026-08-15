/**
 * Uniswap-format token lists, validated into the *advisory* shape this app
 * already has.
 *
 * ---------------------------------------------------------------------------
 * The one rule
 *
 * chains.ts says it plainly, next to `TokenHint`:
 *
 *   "If a Uniswap-format list is ever fetched at runtime, it feeds exactly
 *    this structure and inherits exactly this marking. There is no path by
 *    which a symbol becomes verified on the host."
 *
 * This file is that path, and it inherits that marking. Everything leaving
 * here is a `TokenHint` with `verified: false` — a literal type, not a
 * boolean, so there is no expression anyone can write in this module that
 * produces a token claiming to have been checked. A list is a popularity
 * artefact maintained by strangers; being in one is not evidence of anything.
 *
 * What is a fact, and what is not:
 *
 *   - the contract ADDRESS is the fact. It is what the device shows, what the
 *     user compares, and what decides where the money goes.
 *   - symbol and decimals are guesses. A list entry is somebody's assertion
 *     that address X is called "USDC"; nothing here can check that, and a
 *     list that is compromised or merely wrong relabels a contract for free.
 *
 * So callers must render `TOKEN_HINT_NOTICE` (chains.ts) or
 * `TOKEN_SCALE_NOTICE` (balances.ts) beside anything derived from these, and
 * must show the address regardless of what the lookup returned.
 *
 * ---------------------------------------------------------------------------
 * Why there is no `fetch` in this file
 *
 * `refreshTokenList()` takes the JSON, or a callback that produces it. It
 * never opens a socket. This app routes HTTP through the Rust proxy and a
 * CSP connect-src allowlist that is a reviewed boundary (see chains.ts
 * `rpcOrigins` and its hand-duplicated copy in tauri.conf.json). A module
 * that called `fetch` directly would be a second, unreviewed egress path
 * hiding inside a package that otherwise touches no network — and it would
 * work in dev and silently fail, or silently bypass, elsewhere. The app layer
 * owns egress; this file owns parsing. Keep it that way.
 *
 * ---------------------------------------------------------------------------
 * Parsing posture
 *
 * The input is untrusted JSON that may have arrived over the network from
 * whoever won a DNS race. It is parsed defensively and *skipped per entry*
 * rather than rejected wholesale: one malformed token should not deny the
 * user the other four hundred, but a malformed token must never emerge as a
 * usable one. Every skip is counted so a caller can notice a list that is
 * mostly garbage.
 */

import { MAX_PLAUSIBLE_DECIMALS, sanitiseSymbol } from "./balances.ts";
import { tokenHint, type TokenHint } from "./chains.ts";

/* ------------------------------------------------------------------ bounds
 *
 * Bounds, not policy. They cap the damage a hostile document can do to this
 * process before any of its content is looked at: an array of ten million
 * entries is a denial of service, not a token list.
 */

/** Entries considered from one document. Beyond this the list is not a list. */
export const MAX_LIST_ENTRIES = 100_000;

/** Tokens kept per chain in a bundled snapshot. See `scripts/fetch-token-lists.mjs`. */
export const MAX_TOKENS_PER_CHAIN = 64;

/** Longest list *name* rendered. Free text from the document, so capped. */
const MAX_LIST_NAME = 64;

/**
 * The all-zero address. Some lists use it as a stand-in for the chain's native
 * coin. Accepting it would let a list attach a symbol to "not a contract",
 * and native-coin naming belongs to the curated chain table, not here.
 */
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** Said next to anything sourced from a list. Distinct from a hand-typed hint. */
/**
 * The published lists, in precedence order, as fetchable URLs.
 *
 * One definition, three consumers: `scripts/fetch-token-lists.mjs` regenerates
 * the bundled snapshot from it, the app fetches it for the opt-in refresh, and
 * chains.test.ts derives the CSP origins that must therefore be allowlisted.
 * They used to be written out separately, and the provenance strings in the
 * generated snapshot are prose ("name - url") rather than URLs — parsing those
 * back into origins is what a second copy tempts you into.
 *
 * Earlier wins on a duplicate address, so the smaller curated list goes first:
 * Uniswap's default list has a governance process behind it, CoinGecko's is an
 * index of everything that exists and is only here to fill gaps.
 *
 * Adding an entry here means adding its origin to the CSP allowlist. That
 * pairing is asserted by a test, not left to memory.
 */
export const TOKEN_LIST_URLS: readonly { label: string; url: string }[] = [
  { label: "Uniswap Labs Default", url: "https://tokens.uniswap.org" },
  { label: "CoinGecko", url: "https://tokens.coingecko.com/uniswap/all.json" },
];

export const TOKEN_LIST_NOTICE =
  "This name came from a token list downloaded by this app. Being on a list is " +
  "not a check — the list's authors can be wrong or compromised, and nothing " +
  "here verified that this contract is what it is called. The contract address " +
  "is what the device shows and what you are signing.";

export class TokenListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenListError";
  }
}

/* ------------------------------------------------------------------ shapes */

export interface TokenListVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * A validated list.
 *
 * `tokens` are already deduplicated by (chainId, lower-cased address) and
 * already carry `verified: false`. `skipped` is how many entries did not
 * survive validation — a number worth showing, because "we imported 3 of
 * 5090" is a fact about the list the user should be able to see.
 *
 * Note what is absent: the entries' `name` and `logoURI` fields are parsed and
 * then dropped. A `TokenHint` has no room for them, and that is the right
 * shape — a long free-text name is a strictly larger spoofing surface than a
 * 16-character ticker ("USD Coin (official, verified by Ledger)"), and a logo
 * URL is a per-token beacon telling a server which contract is on screen.
 */
export interface ParsedTokenList {
  /** The document's own name, sanitised. Advisory, like everything here. */
  name: string;
  version: TokenListVersion;
  tokens: readonly TokenHint[];
  skipped: number;
}

/* -------------------------------------------------------------- validation */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One list entry → a hint, or undefined.
 *
 * Exported because the generator script validates through *this* function.
 * One validator, no drift: a build-time parser that is laxer than the runtime
 * one bakes entries into the bundle that the runtime would have refused.
 */
export function validateTokenEntry(entry: unknown): TokenHint | undefined {
  if (!isRecord(entry)) return undefined;

  const { chainId, address, symbol, decimals } = entry;

  // A missing or non-integer chainId is not "probably mainnet". An entry that
  // does not say which chain it is for cannot be matched against one.
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return undefined;
  }

  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const lower = address.toLowerCase();
  if (lower === ZERO_ADDRESS) return undefined;

  // Bounded by MAX_PLAUSIBLE_DECIMALS for the reason balances.ts gives: an
  // absurd divisor renders every balance as "0.000…", which reads as an empty
  // wallet rather than as a lying entry.
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_PLAUSIBLE_DECIMALS
  ) {
    return undefined;
  }

  // sanitiseSymbol() is balances.ts's, deliberately not a second copy: it is
  // the same threat (control characters, RTL overrides, lookalike padding on
  // a confirmation screen) and two filters would drift. It drops anything
  // outside printable ASCII entirely rather than showing it mangled.
  if (typeof symbol !== "string") return undefined;
  const clean = sanitiseSymbol(symbol);
  if (clean === undefined) return undefined;

  return { chainId, address: lower, symbol: clean, decimals, verified: false };
}

function sanitiseListName(value: unknown): string {
  if (typeof value !== "string") return "unnamed list";
  // Same hazard as a symbol, different bound: this is a heading, not a ticker.
  const flat = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, MAX_LIST_NAME);
  return flat.length === 0 ? "unnamed list" : flat;
}

function parseVersion(value: unknown): TokenListVersion {
  const part = (v: unknown): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  if (!isRecord(value)) return { major: 0, minor: 0, patch: 0 };
  return { major: part(value["major"]), minor: part(value["minor"]), patch: part(value["patch"]) };
}

/**
 * A whole document → validated hints.
 *
 * Throws only for a document that is not a token list at all; individual bad
 * entries are skipped and counted. `chainIds`, when given, filters to the
 * chains this app supports before anything is retained — there is no point
 * carrying tokens for a network the user cannot select.
 */
export function parseTokenList(
  document: unknown,
  options: { chainIds?: readonly number[] } = {},
): ParsedTokenList {
  if (!isRecord(document)) throw new TokenListError("not a token list object");
  const raw = document["tokens"];
  if (!Array.isArray(raw)) throw new TokenListError("token list has no tokens array");
  if (raw.length > MAX_LIST_ENTRIES) {
    throw new TokenListError(`token list has ${raw.length} entries, refusing`);
  }

  const wanted = options.chainIds === undefined ? undefined : new Set(options.chainIds);
  const tokens: TokenHint[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const entry of raw) {
    const hint = validateTokenEntry(entry);
    if (hint === undefined) {
      skipped++;
      continue;
    }
    if (wanted !== undefined && !wanted.has(hint.chainId)) continue;
    // Dedup on (chainId, lower-cased address). First occurrence wins, so
    // list order is precedence — a later duplicate cannot relabel an earlier
    // entry by appearing twice.
    const key = `${hint.chainId}:${hint.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(hint);
  }

  return { name: sanitiseListName(document["name"]), version: parseVersion(document["version"]), tokens, skipped };
}

/* ------------------------------------------------------------------- index */

const indexKey = (chainId: number, address: string): string =>
  `${chainId}:${address.toLowerCase()}`;

/**
 * Lookup over one or more lists.
 *
 * Merge policy, and it is the important part: the hand-typed `TOKEN_HINTS`
 * table in chains.ts WINS over any list entry for the same (chainId,
 * address). Hand-curated beats bulk — someone in this repo looked at those
 * eight addresses and a reviewer can check all of them in a minute, which is
 * not true of a thousand entries from a URL. So every lookup consults
 * `tokenHint()` first and only falls through to the list. That also means a
 * compromised or merely stale list cannot rename USDC.
 *
 * Between lists, earlier wins, same as within one.
 */
export interface TokenIndex {
  /** A guess for a contract, or undefined. Render the address regardless. */
  lookup(chainId: number | bigint, address: string): TokenHint | undefined;
  /** Every token known for a chain, hand-typed entries overlaid. For discovery. */
  forChain(chainId: number | bigint): readonly TokenHint[];
  /** How many list entries are indexed (excluding hand-typed overlays). */
  readonly size: number;
}

export function buildTokenIndex(lists: readonly (readonly TokenHint[])[]): TokenIndex {
  const byKey = new Map<string, TokenHint>();
  const byChain = new Map<number, TokenHint[]>();

  for (const list of lists) {
    for (const token of list) {
      const key = indexKey(token.chainId, token.address);
      if (byKey.has(key)) continue;
      byKey.set(key, token);
      const bucket = byChain.get(token.chainId);
      if (bucket === undefined) byChain.set(token.chainId, [token]);
      else bucket.push(token);
    }
  }

  return {
    lookup(chainId, address) {
      const id = Number(chainId);
      // Hand-typed first. This is the merge policy, in one line, on the one
      // path everything goes through.
      return tokenHint(id, address) ?? byKey.get(indexKey(id, address));
    },
    forChain(chainId) {
      const id = Number(chainId);
      const bucket = byChain.get(id) ?? [];
      // Overlay rather than concatenate: an address present in both appears
      // once, with the hand-typed symbol and decimals.
      return bucket.map((t) => tokenHint(id, t.address) ?? t);
    },
    get size() {
      return byKey.size;
    },
  };
}

/* --------------------------------------------------------- runtime refresh */

/**
 * The opt-in "update token list" entry point.
 *
 * Takes already-fetched JSON, or a callback that produces it — the app layer
 * supplies egress (see the header: CSP allowlist and the Rust proxy own that
 * decision, not this package). What comes back has been through exactly the
 * same validator as the bundled snapshot, so an updated list cannot express
 * anything a bundled one could not.
 *
 * Refreshing is a disclosure: asking a server for a token list tells it this
 * app is running and roughly when. That is why it is opt-in and why this
 * function does not schedule itself.
 */
export async function refreshTokenList(
  source: unknown | (() => Promise<unknown>),
  options: { chainIds?: readonly number[] } = {},
): Promise<ParsedTokenList> {
  const document = typeof source === "function"
    ? await (source as () => Promise<unknown>)()
    : source;
  return parseTokenList(document, options);
}
