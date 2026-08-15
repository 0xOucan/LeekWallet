#!/usr/bin/env node
/**
 * Which registry endpoints answer eth_simulateV1? (opt-in, needs network)
 *
 *   node scripts/check-rpc-simulate.mjs [--chain 11155111]
 *
 * Like check-rpc-liveness.mjs, this is deliberately outside the hermetic
 * `check.sh` run. Run it before building on simulation, and again when a
 * provider changes its plans.
 *
 * ---------------------------------------------------------------------------
 * Why this exists rather than an assumption
 *
 * `eth_simulateV1` is a standard execution-api method (Geth 1.14+), not a
 * vendor feature, and it is what turns a transaction into the list of balance
 * changes a user can actually read: with `traceTransfers`, what leaves and what
 * arrives, computed by the endpoint the user already chose. That is the whole
 * of the "pre-sign" panel other wallets buy from a third-party scanner, without
 * telling a third party which addresses somebody is about to touch.
 *
 * The reason to measure rather than assume is that this project's first guess
 * -- "support is uneven across public endpoints, do not build on it" -- was
 * wrong. Every publicnode endpoint answers it, and those are the first choice
 * on most chains. A five-minute probe replaced a plausible assumption that
 * would have cancelled a feature.
 *
 * ---------------------------------------------------------------------------
 * Reading the results, which is where the first probe went wrong
 *
 * A method that exists still rejects a badly-formed call, and those rejections
 * look like refusals if you squint:
 *
 *   -32601 "does not exist"        the method is genuinely absent
 *   "not available on free plan"   present, but paywalled for this key
 *   "intrinsic gas too high"       PRESENT -- it parsed the params and ran
 *   "max fee per gas less than.."  PRESENT -- ditto, a validation failure
 *
 * The last two are execution errors from a working implementation. The probe
 * therefore sends `validation: false`, which is what a wallet previewing an
 * unsigned transaction wants anyway: the question is what the call would do,
 * not whether a fee field that has not been filled in yet clears the base fee.
 */

import { readFileSync } from "node:fs";

const TIMEOUT_MS = 12_000;

/** A minimal, side-effect-free simulation: one block, one zero-value call. */
const PROBE = [
  {
    blockStateCalls: [
      {
        calls: [
          {
            from: "0x0000000000000000000000000000000000000001",
            to: "0x0000000000000000000000000000000000000002",
            value: "0x0",
          },
        ],
      },
    ],
    // See the note above: a wallet previews before the fee fields are final.
    validation: false,
    traceTransfers: true,
  },
  "latest",
];

async function rpc(url, method, params) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      /* Not JSON at all. The registry holds explorer URLs beside RPC ones and
       * an explorer answers HTML to everything, so this must never be mistaken
       * for a method that ran -- the first version of this script reported
       * every block explorer as SUPPORTED. */
      return { error: { code: 0, message: "not a JSON-RPC endpoint" }, fatal: true };
    }
    if (body.error) return { error: body.error };
    return { result: body.result };
  } catch (e) {
    return { error: { code: 0, message: e.name === "AbortError" ? "timeout" : e.message } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Absent, paywalled, or working?
 *
 * Split out because the distinction decides behaviour in the app: an absent
 * method means fall through to the next operator, and a working one that
 * happens to reject these particular params does not.
 */
function classify(error, fatal) {
  if (!error) return "SUPPORTED";
  if (fatal) return "not an RPC endpoint";
  const message = String(error.message ?? "");
  if (error.code === -32601 || /does not exist|not supported|method not found/i.test(message)) {
    return "absent";
  }
  if (/free plan|upgrade to paid|payment required/i.test(message)) return "paywalled";
  if (/rate limit|too many requests/i.test(message)) return "rate-limited (inconclusive)";
  // Anything else came out of an implementation that ran: report it, but as a
  // working method, because that is what it is.
  return `SUPPORTED (rejected probe: ${message.slice(0, 48)})`;
}

const chainsSource = readFileSync(
  new URL("../app/packages/core/src/chains.ts", import.meta.url),
  "utf8",
);
const wanted = process.argv.includes("--chain")
  ? process.argv[process.argv.indexOf("--chain") + 1]
  : null;

/* The registry is TypeScript, so the URLs are lifted out textually rather than
 * imported: this script must run under plain node with no build step, the same
 * property that makes the liveness check usable when something is on fire. */
const urls = [...new Set(chainsSource.match(/https:\/\/[a-z0-9.\-/]+/gi) ?? [])].filter(
  (u) => !u.includes("github") && !u.includes("chainlist") && !u.includes("eips."),
);

console.log(`Probing ${urls.length} endpoints for eth_simulateV1\n`);
let supported = 0;
let probed = 0;
for (const url of urls) {
  if (wanted && !url.includes(wanted)) continue;
  /* Establish it is an RPC endpoint at all before asking what it supports:
   * "cannot simulate" and "is a block explorer" are different answers. */
  const identity = await rpc(url, "eth_chainId", []);
  if (identity.error) {
    console.log(`${new URL(url).host.padEnd(40)} skipped (${classify(identity.error, identity.fatal)})`);
    continue;
  }
  probed += 1;
  const { error, fatal } = await rpc(url, "eth_simulateV1", PROBE);
  const verdict = classify(error, fatal);
  if (verdict.startsWith("SUPPORTED")) supported += 1;
  console.log(`${new URL(url).host.padEnd(40)} ${verdict}`);
}
console.log(`\n${supported}/${probed} live RPC endpoints can simulate.`);
console.log(
  "Simulation is advisory: the device still refuses what it cannot render,\n" +
    "and an endpoint that cannot simulate is a stated absence, never a spinner.",
);
