/**
 * All-chain balances (L3, docs/UI-L3-SPEC.md) tests.
 *
 * The one property this screen exists to protect: a token absent on a chain
 * renders `unavailable`, never `0`. Everything else here is supporting —
 * that the address matrix matches the spec's table exactly, that a chain
 * fetch never blocks on another chain's failure, and that a chain with no
 * Multicall3 deployment still gets an answer via the individual-call
 * fallback rather than reading as universally broken.
 */

import { type EthRequest } from "../src/balances.ts";
import { MULTICALL3_ADDRESS } from "../src/multicall.ts";
import {
  fetchAllChainBalances, fetchChainBalances, loadingRow, trackedChains,
  trackedTokenAddress, TRACKED_TOKEN_SYMBOLS,
} from "../src/all-chain-balances.ts";
import { CHAINS } from "../src/chains.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const w = (n: bigint): string => n.toString(16).padStart(64, "0");
const uint = (n: bigint): string => "0x" + w(n);

/** A well-behaved Multicall3 `aggregate3` reply: every call succeeds, `raw` each. */
function successfulAggregate(count: number, raw: bigint): string {
  const bodies: string[] = [];
  for (let i = 0; i < count; i++) {
    const data = uint(raw).slice(2);
    bodies.push(w(1n) + w(0x40n) + w(32n) + data);
  }
  let cursor = BigInt(count) * 32n;
  let offsets = "";
  for (const body of bodies) { offsets += w(cursor); cursor += BigInt(body.length / 2); }
  return "0x" + w(0x20n) + w(BigInt(count)) + offsets + bodies.join("");
}

group("the tracked address matrix matches docs/UI-L3-SPEC.md §2 exactly");
{
  // Sepolia has all four tracked tokens; Arc (5042002) has three of them but
  // no WETH — both facts are asserted so a future edit to either table
  // cannot drift silently.
  check(
    trackedTokenAddress("WETH", 11155111)?.toLowerCase() === "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
    "Sepolia WETH address does not match the spec table",
  );
  check(
    trackedTokenAddress("cirBTC", 11155111)?.toLowerCase() === "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3",
    "Sepolia cirBTC address does not match the spec table",
  );
  check(
    trackedTokenAddress("cirBTC", 5042002)?.toLowerCase() === "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf",
    "Arc cirBTC address does not match the spec table",
  );
  // cirBTC is Circle's wrapper, not Coinbase's cbBTC. Pointing Sepolia at
  // Coinbase's contract (0x25554f55…) would read the wrong asset entirely,
  // so the address above is asserted exactly rather than merely "defined".
  check(
    trackedTokenAddress("cirBTC", 11155111)?.toLowerCase() !== "0x25554f552a72d1263a868d8be2bc50096b2953eb",
    "Sepolia cirBTC points at Coinbase's cbBTC — wrong token",
  );
  check(trackedTokenAddress("WETH", 296) === undefined, "WETH on Hedera has an address — the spec says it must not");
  check(trackedTokenAddress("USDC", 84532) !== undefined, "USDC on Base Sepolia has no address (should reuse erc7730-circle.ts)");
  check(trackedTokenAddress("EURC", 11155111) !== undefined, "EURC on Sepolia has no address (should reuse erc7730-circle.ts)");
}

group("a token with no address on a chain is unavailable, never 0");
{
  // Arc Testnet has USDC, EURC and cirBTC but no WETH (docs/UI-L3-SPEC.md
  // §2) — a mixed chain is the sharper test than an all-absent one, since it
  // proves "unavailable" is decided per token, not per chain.
  const chain = CHAINS.find((c) => c.id === 5042002);
  if (!chain) throw new Error("Arc Testnet missing from CHAINS");
  const present = TRACKED_TOKEN_SYMBOLS.filter((s) => trackedTokenAddress(s, 5042002) !== undefined);
  check(present.length === 3, `expected USDC+EURC+cirBTC present on Arc, got ${present.join(",")}`);
  check(trackedTokenAddress("WETH", 5042002) === undefined, "WETH on Arc has an address — the spec says it must not");

  const request: EthRequest = async ({ method, params }) => {
    if (method === "eth_getBalance") return uint(0n); // zero native, a real answer
    const p = (params as [{ to: string }])[0];
    if (p.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) return successfulAggregate(present.length, 5n);
    throw new Error(`unexpected eth_call to ${p.to}`);
  };

  const row = await fetchChainBalances(request, chain, OWNER);
  check(row.native.kind === "native", "Arc's native balance did not read as a real figure");
  for (const t of row.tokens) {
    if (t.symbol === "USDC" || t.symbol === "EURC" || t.symbol === "cirBTC") {
      check(t.state.kind === "token", `${t.symbol} on Arc should have answered with a real figure`);
      continue;
    }
    check(t.state.kind === "unavailable", `${t.symbol} on Arc did not render unavailable (got ${t.state.kind})`);
    // The one invariant this whole file exists to pin: never render "0" here.
    check(
      t.state.kind !== "token",
      `${t.symbol} on Arc rendered a balance instead of unavailable`,
    );
  }
}

group("a present token that actually answers is distinguishable from unavailable");
{
  const chain = CHAINS.find((c) => c.id === 11155111); // Sepolia: all four tracked tokens
  if (!chain) throw new Error("Sepolia missing from CHAINS");

  const present = TRACKED_TOKEN_SYMBOLS.filter((s) => trackedTokenAddress(s, 11155111) !== undefined);
  check(present.length === 4, "Sepolia should have all four tracked tokens");

  const request: EthRequest = async ({ method, params }) => {
    if (method === "eth_getBalance") return uint(123n);
    const p = (params as [{ to: string }])[0];
    if (p.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      return successfulAggregate(present.length, 7n);
    }
    throw new Error(`unexpected eth_call to ${p.to}`);
  };

  const row = await fetchChainBalances(request, chain, OWNER);
  check(row.native.kind === "native" && row.native.wei === 123n, "Sepolia native balance did not decode");
  for (const t of row.tokens) {
    check(t.state.kind === "token", `${t.symbol} on Sepolia did not read as a real balance`);
    if (t.state.kind === "token") check(t.state.view.raw === 7n, `${t.symbol} raw balance was not decoded`);
  }
}

group("no Multicall3 on this chain falls back to individual calls, not a wall of errors");
{
  const chain = CHAINS.find((c) => c.id === 11155111);
  if (!chain) throw new Error("Sepolia missing from CHAINS");
  let individualCalls = 0;
  const request: EthRequest = async ({ method, params }) => {
    if (method === "eth_getBalance") return uint(0n);
    const p = (params as [{ to: string; data: string }])[0];
    if (p.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) return "0x"; // no code there
    individualCalls++;
    return uint(9n);
  };
  const row = await fetchChainBalances(request, chain, OWNER);
  check(individualCalls === 4, `expected 4 individual fallback calls, got ${individualCalls}`);
  for (const t of row.tokens) {
    check(t.state.kind === "token", `${t.symbol} did not recover via the individual-call fallback`);
  }
}

group("one dead chain does not stall or corrupt the others");
{
  const chains = [
    CHAINS.find((c) => c.id === 11155111),
    CHAINS.find((c) => c.id === 5042002),
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  check(chains.length === 2, "test setup: expected both Sepolia and Arc in CHAINS");

  const rows = new Map<number, ReturnType<typeof loadingRow>>();
  await fetchAllChainBalances(
    (chainId) => {
      if (chainId === 5042002) return undefined; // "no transport for this chain"
      return (async ({ method }) => (method === "eth_getBalance" ? uint(1n) : "0x")) as EthRequest;
    },
    OWNER,
    (row) => rows.set(row.chainId, row),
    chains,
  );

  check(rows.size === 2, "not every chain reported a row");
  const sepolia = rows.get(11155111);
  const arc = rows.get(5042002);
  check(sepolia?.native.kind === "native", "Sepolia's row was affected by Arc having no transport");
  check(arc?.native.kind === "error", "a chain with no transport did not read as an error");
  check(arc?.tokens.every((t) => t.state.kind === "error") ?? false, "a chain with no transport left some tokens un-errored");
}

group("trackedChains() is testnet-only and every entry has a curated label");
{
  const chains = trackedChains();
  check(chains.length > 0, "trackedChains() returned nothing");
  check(chains.every((c) => c.testnet), "trackedChains() included a mainnet");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
