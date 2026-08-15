#!/usr/bin/env node
//
// Regenerate app/packages/core/src/token-list-bundled.ts from published
// Uniswap-format token lists.
//
// Run:  node scripts/fetch-token-lists.mjs [--dry-run]
//
// ---------------------------------------------------------------------------
// Why this is a build-time fetch and not a runtime one
//
// Same trade erc7730-bundled.ts documents. Fetching a list while the user is
// looking at a transaction tells whoever serves it that somebody is about to
// sign; fetching it at build time tells them nothing about any user, and the
// reviewable artefact is a diff in a pull request that a human reads. The app
// still offers an opt-in runtime refresh (token-list.ts `refreshTokenList`),
// but the default path ships bytes that were reviewed.
//
// ---------------------------------------------------------------------------
// Two properties this script must keep
//
// 1. ONE VALIDATOR. Entries are validated by importing `parseTokenList` from
//    token-list.ts — the very function the app runs at runtime. A second
//    parser here would drift and would bake in entries the app would refuse.
// 2. DETERMINISM. Same inputs must produce a byte-identical file: no
//    timestamps, no Map iteration order leaking through, stable sort by
//    (chainId, address). This repo checks reproducibility (scripts/repro-check.sh)
//    and a generated file that churns on every run makes every diff unreadable.
//
// No dependencies: plain `node`, global fetch. If this Node build does not
// strip TypeScript types natively it re-executes itself with the flag, because
// the import above is a .ts file and that is not negotiable (see property 1).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHAINS_TS = resolve(ROOT, "app/packages/core/src/chains.ts");
const TOKEN_LIST_TS = resolve(ROOT, "app/packages/core/src/token-list.ts");
const OUT = resolve(ROOT, "app/packages/core/src/token-list-bundled.ts");

// Re-exec with type stripping when the running Node cannot import .ts itself.
if (!process.features.typescript) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning",
     fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const { parseTokenList, MAX_TOKENS_PER_CHAIN, TOKEN_LIST_URLS } = await import(TOKEN_LIST_TS);

/**
 * The lists, in precedence order. Earlier wins on a duplicate address, so the
 * smaller and more curated list goes first: Uniswap's default list is the one
 * with a governance process behind it, CoinGecko's is an index of everything
 * that exists and is only here to fill gaps.
 */
const SOURCES = TOKEN_LIST_URLS;

/* ------------------------------------------------- what chains.ts supports
 *
 * Read out of the source text rather than imported, for one reason: chains.ts
 * does not export TOKEN_HINTS, and this script must not be the reason it
 * starts to. Text extraction is brittle by nature, so both extractors below
 * assert a plausible result and abort rather than silently produce an empty
 * set — an empty chain filter would drop every token and an empty hint set
 * would silently lose the curated addresses.
 */

const chainsSource = readFileSync(CHAINS_TS, "utf8");

const chainIds = [...chainsSource.matchAll(/^\s{4}id:\s*(\d+),\s*$/gm)]
  .map((m) => Number(m[1]));
if (chainIds.length < 5) {
  console.error(`could not read chain ids from ${CHAINS_TS} (got ${chainIds.length})`);
  process.exit(2);
}
const supported = [...new Set(chainIds)].sort((a, b) => a - b);

// The hand-typed table. Never rewritten by this script — it is copied into the
// snapshot only so that `forChain()` can enumerate those contracts, and the
// runtime overlay in token-list.ts makes the chains.ts row win regardless of
// what lands here.
const handHints = [...chainsSource.matchAll(
  /\{\s*chainId:\s*(\d+),\s*address:\s*"(0x[0-9a-fA-F]{40})",\s*symbol:\s*"([^"]{1,16})",\s*decimals:\s*(\d+),\s*verified:\s*false\s*\}/g,
)].map((m) => ({
  chainId: Number(m[1]), address: m[2].toLowerCase(),
  symbol: m[3], decimals: Number(m[4]), verified: false,
}));
if (handHints.length === 0) {
  console.error(`could not read TOKEN_HINTS from ${CHAINS_TS}`);
  process.exit(2);
}

/* ----------------------------------------------------------------- fetch */

const dryRun = process.argv.includes("--dry-run");
const fetched = [];

for (const source of SOURCES) {
  let document;
  try {
    const res = await fetch(source.url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    document = await res.json();
  } catch (err) {
    console.error(`fetch failed for ${source.url}: ${err.message}`);
    process.exit(2);
  }
  const parsed = parseTokenList(document, { chainIds: supported });
  const v = parsed.version;
  console.log(
    `${source.url}\n  ${parsed.name} v${v.major}.${v.minor}.${v.patch} — ` +
    `kept ${parsed.tokens.length}, skipped ${parsed.skipped} invalid`,
  );
  fetched.push({ url: source.url, parsed });
}

/* ----------------------------------------------------- select and order */

// Precedence: hand-typed addresses are always in, then list order (which is
// the closest thing these documents have to a ranking), then the cap. Cutting
// by list order rather than alphabetically keeps the well-known tokens; the
// output is sorted afterwards so the file itself is stable.
const perChain = new Map(supported.map((id) => [id, []]));
const taken = new Set();

const offer = (token) => {
  const bucket = perChain.get(token.chainId);
  if (bucket === undefined) return false;
  const key = `${token.chainId}:${token.address}`;
  if (taken.has(key)) return false;
  if (bucket.length >= MAX_TOKENS_PER_CHAIN) return false;
  taken.add(key);
  bucket.push(token);
  return true;
};

for (const h of handHints) offer(h);
for (const { parsed } of fetched) for (const t of parsed.tokens) offer(t);

const tokens = [...perChain.values()].flat()
  .sort((a, b) => a.chainId - b.chainId || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

/* ------------------------------------------------------------ emit file */

const sourceLines = fetched.map(({ url, parsed }) => {
  const v = parsed.version;
  return ` *   ${url}\n *     ${parsed.name} v${v.major}.${v.minor}.${v.patch}`;
}).join("\n");

const chainCounts = supported
  .map((id) => [id, perChain.get(id).length])
  .filter(([, n]) => n > 0)
  .map(([id, n]) => ` *   chain ${id}: ${n}`)
  .join("\n");

const body = tokens.map((t) =>
  `  { chainId: ${t.chainId}, address: "${t.address}", symbol: ${JSON.stringify(t.symbol)}, ` +
  `decimals: ${t.decimals}, verified: false },`
).join("\n");

const file = `/**
 * The bundled token-list snapshot. GENERATED — do not hand-edit.
 *
 * Regenerate with:  node scripts/fetch-token-lists.mjs
 *
 * ---------------------------------------------------------------------------
 * What seeded this file
 *
 * It was produced by that script from the published lists below, filtered to
 * the chain IDs in chains.ts, capped at ${MAX_TOKENS_PER_CHAIN} tokens per chain, and validated
 * through \`parseTokenList()\` in token-list.ts — the same validator the app
 * runs at runtime, so nothing here is an entry the app would have refused.
 *
${sourceLines}
 *
 * Addresses were never typed by hand. A mistyped token address in a bundled
 * list sends money to a contract that does not exist, and no amount of review
 * catches a transposed hex digit reliably; so the only two permitted origins
 * for a row here are this generator, and the hand-typed \`TOKEN_HINTS\` table in
 * chains.ts (copied across programmatically by the same script).
 *
 * ---------------------------------------------------------------------------
 * What this is NOT
 *
 * Not verification. Every row is \`verified: false\`, the literal type, because
 * being on a list is not a check — see the header of token-list.ts and
 * \`TOKEN_HINT_NOTICE\` in chains.ts. The contract address is the fact; symbol
 * and decimals are guesses that must never be rendered without the notice.
 *
 * The hand-typed rows in chains.ts WIN over anything here for the same
 * (chainId, address); \`buildTokenIndex()\` enforces that on every lookup, so a
 * bad row in this file cannot rename a curated contract.
 *
 * Coverage:
${chainCounts}
 */

import type { TokenHint } from "./chains.ts";
import { buildTokenIndex, type TokenIndex } from "./token-list.ts";

/** Where the rows came from, so a reviewer can re-fetch and diff. */
export const BUNDLED_TOKEN_LIST_SOURCES: readonly string[] = [
${fetched.map(({ url, parsed }) => `  ${JSON.stringify(`${parsed.name} v${parsed.version.major}.${parsed.version.minor}.${parsed.version.patch} — ${url}`)},`).join("\n")}
];

/** Sorted by (chainId, address) so a regeneration diffs cleanly. */
export const BUNDLED_TOKENS: readonly TokenHint[] = [
${body}
];

/**
 * The snapshot as a lookup, with the chains.ts hand-typed table overlaid.
 * Built once: the array is immutable and the index is pure.
 */
export const bundledTokenIndex: TokenIndex = buildTokenIndex([BUNDLED_TOKENS]);
`;

if (dryRun) {
  const current = readFileSync(OUT, "utf8");
  console.log(current === file ? "\nno change" : "\nWOULD CHANGE (run without --dry-run)");
  process.exit(current === file ? 0 : 1);
}

let previous = "";
try { previous = readFileSync(OUT, "utf8"); } catch { /* first run */ }
const before = new Set([...previous.matchAll(/chainId: (\d+), address: "(0x[0-9a-f]{40})"/g)].map((m) => `${m[1]}:${m[2]}`));
const after = new Set(tokens.map((t) => `${t.chainId}:${t.address}`));

writeFileSync(OUT, file);

const added = [...after].filter((k) => !before.has(k)).length;
const removed = [...before].filter((k) => !after.has(k)).length;
console.log(
  `\nwrote ${OUT}\n  ${tokens.length} tokens across ${[...perChain.values()].filter((b) => b.length).length} chains` +
  `\n  +${added} added, -${removed} removed` +
  (previous === file ? "\n  (file unchanged)" : ""),
);
