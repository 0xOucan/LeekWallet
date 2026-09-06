#!/usr/bin/env node
/**
 * Are the registry's RPC endpoints actually usable? (opt-in, needs network)
 *
 *   node scripts/check-rpc-liveness.mjs [--wait 45]
 *
 * Not part of the default `check.sh` run, which is hermetic on purpose: a suite
 * that fails because somebody's wifi is down teaches people to ignore it. Run
 * it deliberately — before a release, or when a chain misbehaves — with
 * `./scripts/check.sh rpc`.
 *
 * ---------------------------------------------------------------------------
 * Why this checks block HEIGHT and not just whether the endpoint replies
 *
 * chains.test.ts asserts two independent RPC operators per chain. It counts
 * table entries, which is all an offline test can do — so the rule passed for
 * months on chains where one of the two operators had quietly retired, and the
 * redundancy it was protecting did not exist.
 *
 * Worse, "does it answer" is not the same as "does it work". When Holesky was
 * shut down in September 2025, one endpoint kept answering eth_chainId and
 * eth_blockNumber correctly and would have passed any responsiveness check
 * indefinitely. What gave it away was the block number: frozen at 5765077
 * across samples 45 seconds apart, while every live chain advanced. A dead
 * chain that still serves reads is the failure mode that matters here, because
 * the app would happily let someone sign and broadcast into it.
 *
 * So: two samples, separated in time, and a chain whose height does not move is
 * reported as dead however politely it answers.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHAINS_TS = resolve(ROOT, "app/packages/core/src/chains.ts");
const CONF = resolve(ROOT, "app/src-tauri/tauri.conf.json");

/* Chains where only one RPC operator exists, so "one working operator" is the
 * designed state rather than an outage. Mirrors the set of the same name in
 * app/packages/core/test/chains.test.ts; both are named lists rather than a
 * relaxed rule so that adding a chain to either is a visible diff.
 *
 * 5042002 (Arc Testnet): Circle publishes one endpoint. */
const SINGLE_OPERATOR = new Set([5042002]);

if (!process.features.typescript) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning",
     fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const { CHAINS } = await import(CHAINS_TS);

const waitArg = process.argv.indexOf("--wait");
/* Long enough for the slowest curated chain to produce a block. Ethereum is
 * ~12 s and the L2s are far quicker, so 45 s is several blocks of margin
 * everywhere; too short and a live chain looks frozen, which is the one false
 * alarm that would get this check switched off. */
const WAIT_MS = (waitArg > -1 ? Number(process.argv[waitArg + 1]) : 45) * 1000;
const TIMEOUT_MS = 12_000;
/* Multicall3's canonical deterministic deployment. The token-discovery path
 * batches every balanceOf through it, so an endpoint that cannot see it is not
 * fully usable even when it answers everything else. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

async function call(url, method, params = []) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
    });
    if (res.status === 429) { const e = new Error("rate limited (HTTP 429)"); e.rateLimited = true; throw e; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  } finally { clearTimeout(timer); }
}

const problems = [];
const warnings = [];

/* ------------------------------------------------------------ first sample */

console.log(`Probing ${CHAINS.reduce((n, c) => n + c.rpcUrls.length, 0)} endpoints across ${CHAINS.length} chains…`);

const state = new Map();   // url -> {chain, chainIdOk, height, error}
await Promise.all(CHAINS.flatMap((chain) => chain.rpcUrls.map(async (url) => {
  try {
    const seen = Number(BigInt(await call(url, "eth_chainId")));
    if (seen !== chain.id) {
      state.set(url, { chain, error: `reports chain ${seen}, registry says ${chain.id}` });
      return;
    }
    const height = Number(BigInt(await call(url, "eth_blockNumber")));
    state.set(url, { chain, height });
  } catch (e) {
    state.set(url, { chain, error: e.message, rateLimited: e.rateLimited === true });
  }
})));

console.log(`Waiting ${WAIT_MS / 1000}s to see whether heights advance…`);
await new Promise((r) => setTimeout(r, WAIT_MS));

/* ----------------------------------------------------------- second sample */

await Promise.all([...state.entries()].map(async ([url, s]) => {
  if (s.error !== undefined) return;
  try {
    s.height2 = Number(BigInt(await call(url, "eth_blockNumber")));
    const code = await call(url, "eth_getCode", [MULTICALL3, "latest"]);
    s.multicall = typeof code === "string" && code.length > 4;
  } catch (e) {
    s.error = `second sample failed: ${e.message}`;
  }
}));

/* One retry for anything that failed, before calling an operator down.
 *
 * Public endpoints drop the occasional request, and a check that fails the
 * build on a single dropped packet is one people learn to re-run rather than
 * read. A genuinely dead endpoint fails twice; a blip does not. Frozen chains
 * are NOT retried here - a height that did not move is already two samples. */
const retries = [...state.entries()].filter(([, s]) => s.error !== undefined && !s.rateLimited);
if (retries.length > 0) {
  console.log(`\nRetrying ${retries.length} endpoint(s) that failed once…`);
  await Promise.all(retries.map(async ([url, s]) => {
    try {
      const seen = Number(BigInt(await call(url, "eth_chainId")));
      if (seen !== s.chain.id) return;
      const h1 = Number(BigInt(await call(url, "eth_blockNumber")));
      await new Promise((r) => setTimeout(r, 8000));
      const h2 = Number(BigInt(await call(url, "eth_blockNumber")));
      const code = await call(url, "eth_getCode", [MULTICALL3, "latest"]);
      if (h2 > h1) {
        delete s.error;
        s.height = h1; s.height2 = h2;
        s.multicall = typeof code === "string" && code.length > 4;
      }
    } catch { /* stays failed, reported below */ }
  }));
}

/* ------------------------------------------------------------------ report */

for (const chain of CHAINS) {
  const rows = chain.rpcUrls.map((u) => [u, state.get(u)]);
  const usable = [];
  const busy = [];
  const lines = [];
  for (const [url, s] of rows) {
    const host = new URL(url).host;
    if (s.error !== undefined) {
      /* A 429 is the operator declining this request, not the endpoint being
       * gone -- and the failover client's whole job is to move on to the next
       * one. Counting it as a dead operator makes this check cry wolf on a busy
       * afternoon, and a check that cries wolf is a check that gets switched
       * off. Reported, not failed. */
      if (s.rateLimited) {
        lines.push(`    busy ${host}: ${s.error}`);
        warnings.push(`${chain.name}: ${host} rate limited`);
        busy.push(url);
        continue;
      }
      lines.push(`    DOWN ${host}: ${s.error}`);
      continue;
    }
    const advanced = s.height2 > s.height;
    if (!advanced) {
      lines.push(`    FROZEN ${host}: block ${s.height} unchanged after ${WAIT_MS / 1000}s`);
      continue;
    }
    usable.push(url);
    lines.push(`    ok ${host}: +${s.height2 - s.height} blocks${s.multicall ? "" : "  (no Multicall3!)"}`);
    if (!s.multicall) warnings.push(`${chain.name}: ${host} cannot see Multicall3`);
  }

  // Every endpoint frozen means the chain itself is dead, not the operator.
  const anyAlive = usable.length > 0;
  const operators = new Set([...usable, ...busy].map((u) => new URL(u).host.split(".").slice(-2).join(".")));
  const status = !anyAlive ? "DEAD" : operators.size < 2 ? "SINGLE OPERATOR" : "ok";
  console.log(`\n${chain.name} (${chain.id})${chain.testnet ? " [testnet]" : ""} — ${status}`);
  for (const l of lines) console.log(l);

  if (!anyAlive) {
    problems.push(`${chain.name} (${chain.id}) has no live endpoint — the chain may be shut down`);
  } else if (operators.size < 2 && !SINGLE_OPERATOR.has(chain.id)) {
    problems.push(`${chain.name} (${chain.id}) is down to ${operators.size} working operator; the two-operator rule is not actually met`);
  } else if (operators.size < 2) {
    /* Known to have one operator by construction, so this is not news. Still
     * said out loud every run: the chain goes away entirely when that operator
     * does, and the difference between "expected" and "fine" is worth keeping
     * visible. */
    warnings.push(`${chain.name} (${chain.id}) has one operator by design — no failover exists`);
  }
}

/* The CSP must still cover exactly what the registry asks for. Checked here
 * too because a removed chain leaves a stale allowlist entry behind, and a
 * stale entry outlives the review that justified it. */
const csp = JSON.parse(readFileSync(CONF, "utf8")).app.security.csp;
for (const chain of CHAINS) {
  for (const url of chain.rpcUrls) {
    const origin = new URL(url).origin;
    if (!csp.includes(origin)) {
      problems.push(`CSP is missing ${origin} (needed by ${chain.name})`);
    }
  }
}

console.log("\n" + "-".repeat(60));
for (const w of warnings) console.log(`warning: ${w}`);
if (problems.length === 0) {
  console.log("All chains are producing blocks, with two working operators except where noted.");
  process.exit(0);
}
for (const p of problems) console.log(`PROBLEM: ${p}`);
process.exit(1);
