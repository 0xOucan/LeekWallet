/**
 * Chain registry tests (T51).
 *
 * Three things are being pinned down. First, that the table is internally
 * consistent — a duplicate chain ID or a malformed RPC URL turns into either a
 * blocked request or, worse, signing against the wrong network. Second, that
 * tx-interpret still names known chains and still refuses to name unknown ones
 * now that it reads from here instead of its own copy. Third, and most
 * important, that no token symbol anywhere in this module is presented as
 * something that was checked: the host cannot verify a symbol, and a symbol
 * that looks verified is the attack section 6d describes.
 */

import { readFileSync } from "node:fs";

import {
  CHAINS, chainLabel, chainName, formatUnits, getChain, rpcOrigins,
  TOKEN_HINT_NOTICE, tokenHint,
} from "../src/chains.ts";
import { interpretTransaction, WarningCode } from "../src/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

group("the table is internally consistent");
{
  const ids = CHAINS.map((c) => c.id);
  check(new Set(ids).size === ids.length, `duplicate chain ids in: ${ids.join(",")}`);
  const names = CHAINS.map((c) => c.name);
  check(new Set(names).size === names.length, `duplicate chain names in: ${names.join(",")}`);

  for (const c of CHAINS) {
    const at = `chain ${c.id}`;
    check(Number.isInteger(c.id) && c.id > 0, `${at}: id is not a positive integer`);
    check(c.name.trim().length > 0, `${at}: empty name`);
    check(c.nativeCurrency.symbol.trim().length > 0, `${at}: empty native symbol`);
    check(c.nativeCurrency.name.trim().length > 0, `${at}: empty native currency name`);
    // 18 for every EVM gas token in practice; the bound catches a typo that
    // would silently move a decimal point by an order of magnitude.
    check(
      Number.isInteger(c.nativeCurrency.decimals) &&
        c.nativeCurrency.decimals > 0 && c.nativeCurrency.decimals <= 18,
      `${at}: implausible decimals ${c.nativeCurrency.decimals}`,
    );
    check(c.rpcUrls.length > 0, `${at}: no RPC endpoints`);
    for (const url of c.rpcUrls) {
      check(url.startsWith("https://"), `${at}: non-https RPC ${url}`);
      let parsed: URL | undefined;
      try { parsed = new URL(url); } catch { /* reported below */ }
      check(parsed !== undefined, `${at}: unparseable RPC ${url}`);
    }
    check(new Set(c.rpcUrls).size === c.rpcUrls.length, `${at}: duplicate RPC urls`);
    check(c.explorerUrl.startsWith("https://"), `${at}: non-https explorer`);
    check(!c.explorerUrl.endsWith("/"), `${at}: explorer has a trailing slash`);
    check(typeof c.testnet === "boolean", `${at}: testnet is not a boolean`);
  }
}

group("the chains the task asks for are present");
for (const [id, name] of [
  [1, "Ethereum"], [11155111, "Sepolia"], [8453, "Base"], [84532, "Base Sepolia"],
  [10, "OP Mainnet"], [42161, "Arbitrum One"], [137, "Polygon"],
] as const) {
  check(getChain(id)?.name === name, `chain ${id} missing or misnamed: ${getChain(id)?.name}`);
}

group("lookups do not invent anything");
{
  check(chainName(1) === "Ethereum", `mainnet: ${chainName(1)}`);
  check(chainName(424242) === undefined, `invented a name: ${chainName(424242)}`);
  check(chainLabel(424242) === "chain 424242", `label: ${chainLabel(424242)}`);
  check(chainName(8453n) === "Base", "bigint chain id not accepted");
  // 0 is what an absent chainId becomes; it must not resolve to anything.
  check(getChain(0) === undefined, "chain 0 resolved");
}

group("rpc origins are enumerable for the CSP review");
{
  const origins = rpcOrigins();
  check(origins.length > 0, "no origins");
  check(origins.every((o) => o.startsWith("https://")), `non-https origin: ${origins.join(" ")}`);
  check(origins.every((o) => !o.includes("*")), "a wildcard reached the origin list");
  check([...origins].sort().join() === origins.join(), "origins are not sorted");
}

group("the CSP allowlist covers the registry, by exact origin");
{
  /* The CSP is a hand-maintained security boundary, so it is not generated
   * from the registry — but a chain whose RPC is missing from it fails at
   * runtime with a blocked request, and a wildcard would quietly undo the
   * boundary. Both are worth catching here rather than in the field. */
  const conf = JSON.parse(
    readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { app: { security: { csp: string } } };
  const csp = conf.app.security.csp;
  const connect = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";
  check(connect.length > 0, "no connect-src directive found");
  check(!connect.includes("*"), `connect-src contains a wildcard: ${connect}`);
  check(!/https:(\s|$)/.test(connect), "connect-src allows any https origin");
  const allowed = new Set(connect.trim().split(/\s+/));
  for (const origin of rpcOrigins()) {
    check(allowed.has(origin), `RPC origin not in the CSP allowlist: ${origin}`);
  }
}

group("tx-interpret still reads chains through the registry");
{
  const known = interpretTransaction({ chainId: 8453, to: "0x" + "11".repeat(20) });
  check(known.chainName === "Base", `known chain: ${known.chainName}`);
  check(
    !known.warnings.some((w) => w.code === WarningCode.UnknownChain),
    "a registered chain warned as unknown",
  );

  const unknown = interpretTransaction({ chainId: 424242, to: "0x" + "11".repeat(20) });
  check(unknown.chainId === 424242, `unknown chain id: ${unknown.chainId}`);
  check(unknown.chainName === undefined, `invented a name: ${unknown.chainName}`);
  check(unknown.summary.includes("chain 424242"), `summary hides it: ${unknown.summary}`);
  check(
    unknown.warnings.some((w) => w.code === WarningCode.UnknownChain),
    "unknown chain not warned about",
  );
}

group("token hints exist but are never verified");
{
  const usdc = tokenHint(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  check(usdc !== undefined, "case-insensitive lookup failed");
  check(usdc?.symbol === "USDC", `symbol: ${usdc?.symbol}`);
  // The field is typed `false`, so this is really a check that nobody widened
  // it to boolean and started setting it.
  check(usdc?.verified === false, "a token hint claims to be verified");
  check(tokenHint(1, "0x" + "22".repeat(20)) === undefined, "invented a token");
  // Same address, different chain: a token list is per-chain and conflating
  // them would label an unrelated contract.
  check(
    tokenHint(56, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") === undefined,
    "a hint leaked across chains",
  );

  // Not one entry, anywhere, may assert verification.
  for (const c of CHAINS) {
    const t = tokenHint(c.id, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    check(t === undefined || t.verified === false, `chain ${c.id}: verified hint`);
  }

  check(TOKEN_HINT_NOTICE.toLowerCase().includes("guess"), "the notice does not say it is a guess");
  check(
    TOKEN_HINT_NOTICE.toLowerCase().includes("contract address"),
    "the notice does not point at the contract address",
  );
}

group("the interpretation itself carries no symbol at all");
{
  // A token transfer must come back with the contract and raw units. If a
  // symbol or a scaled amount ever appears in this object it would be rendered
  // as if the device had agreed to it.
  const data =
    "0x" + "a9059cbb" + "0".repeat(24) + "d8da6bf26964af9d7eed9e03e53415d37aa96045" +
    (1000000n).toString(16).padStart(64, "0");
  const i = interpretTransaction({
    chainId: 1, to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", data,
  });
  check(i.contract !== undefined, "token contract not reported");
  check(i.tokenAmountRaw === 1000000n, `raw amount: ${i.tokenAmountRaw}`);
  const blob = JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  check(!blob.includes("USDC"), "a token symbol reached the interpretation");
  check(!/verified|trusted/i.test(blob), "the interpretation claims verification");
  // 1000000 raw units is "1 USDC" only if the guessed decimals are right, and
  // the summary must not present that guess next to the signature fields.
  check(!/\bUSDC\b/.test(i.summary), `summary scaled the amount: ${i.summary}`);
  check(i.summary.includes("raw token units"), `summary hides rawness: ${i.summary}`);
}

group("raw units scale exactly, with no floating point");
{
  check(formatUnits(1000000n, 6) === "1", `usdc one: ${formatUnits(1000000n, 6)}`);
  check(formatUnits(1n, 6) === "0.000001", `usdc dust: ${formatUnits(1n, 6)}`);
  check(formatUnits(1500000n, 6) === "1.5", `usdc 1.5: ${formatUnits(1500000n, 6)}`);
  check(formatUnits(1234n, 0) === "1234", `zero decimals: ${formatUnits(1234n, 0)}`);
  check(
    formatUnits(9007199254740993n, 18) === "0.009007199254740993",
    `precision boundary: ${formatUnits(9007199254740993n, 18)}`,
  );
  check(formatUnits(-1500000n, 6) === "-1.5", `negative: ${formatUnits(-1500000n, 6)}`);
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
