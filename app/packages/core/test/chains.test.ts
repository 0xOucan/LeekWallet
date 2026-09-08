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

import { TOKEN_LIST_URLS } from "../src/token-list.ts";
import { readFileSync } from "node:fs";

import {
  addCustomChain, allChains, CHAINS, chainLabel, chainLabelDetailed, chainName,
  CUSTOM_CHAIN_NOTICE, CUSTOM_CHAINS_KEY, formatUnits, getChain, loadCustomChains,
  removeCustomChain, resolveChain, rpcOrigins, TOKEN_HINT_NOTICE, tokenHint,
  validateCustomChain,
} from "../src/chains.ts";
import type { ChainStore, CustomChainInput } from "../src/chains.ts";
import { interpretTransaction, WarningCode } from "../src/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

/**
 * Chains for which only one RPC operator exists, named one at a time.
 *
 * The two-operator rule is not weakened for these; the exception is recorded
 * so that adding one is a visible diff and a decision, the same shape as
 * NON_RPC_ALLOWED below. A chain here is a chain that goes away entirely when
 * its single operator does, and the UI has no way to soften that.
 *
 * 5042002 (Arc Testnet): Circle publishes one endpoint for the testnet. The
 * alternative to the exception was either not listing a chain people are being
 * asked to take payments on, or inventing a mirror. Remove this entry the day
 * a second operator exists.
 */
const SINGLE_OPERATOR = new Set([5042002]);

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
    check(c.source === "curated", `${at}: a curated entry is not marked curated`);
    // Two operators minimum, so one of them being down does not remove the
    // chain from the app entirely.
    check(
      new Set(c.rpcUrls.map((u) => new URL(u).origin)).size >= 2 || SINGLE_OPERATOR.has(c.id),
      `${at}: fewer than two independent RPC operators`,
    );
  }
}

group("Arc's two decimal scales, and its single operator");
{
  /* Arc is the one curated chain where the gas token and an ERC-20 are the
   * same asset at different scales: the native unit has 18 decimals, the
   * ERC-20 interface at 0x3600…0000 has 6. Both were read off the chain. This
   * pins the pair together, because the failure mode is not a wrong name — it
   * is a payment rendered 10^12 out, which nobody reading the screen can
   * catch. */
  const arc = getChain(5042002);
  check(arc?.name === "Arc Testnet", `arc name: ${arc?.name}`);
  check(arc?.testnet === true, "Arc is not marked testnet");
  check(arc?.nativeCurrency.symbol === "USDC", `arc gas token: ${arc?.nativeCurrency.symbol}`);
  check(arc?.nativeCurrency.decimals === 18, `arc native decimals: ${arc?.nativeCurrency.decimals}`);
  const erc20 = tokenHint(5042002, "0x3600000000000000000000000000000000000000");
  check(erc20?.symbol === "USDC", "Arc's USDC predeploy is not hinted");
  check(erc20?.decimals === 6, `arc erc-20 decimals: ${erc20?.decimals}`);
  check(erc20?.decimals !== arc?.nativeCurrency.decimals,
    "the two Arc scales collapsed into one, which is the 10^12 bug");
}

group("the chains the task asks for are present");
for (const [id, name] of [
  [1, "Ethereum"], [11155111, "Sepolia"], [8453, "Base"], [84532, "Base Sepolia"],
  [10, "OP Mainnet"], [42161, "Arbitrum One"], [137, "Polygon"], [56, "BNB Smart Chain"],
  [43114, "Avalanche C-Chain"], [100, "Gnosis"], [59144, "Linea"], [534352, "Scroll"],
  [324, "zkSync Era"], [5000, "Mantle"], [81457, "Blast"], [42220, "Celo"],
  [11155420, "OP Sepolia"], [421614, "Arbitrum Sepolia"], [80002, "Polygon Amoy"],
] as const) {
  check(getChain(id)?.name === name, `chain ${id} missing or misnamed: ${getChain(id)?.name}`);
}
{
  // The point of the expansion: enough mainnets to cover where people keep
  // funds, and a testnet for the majors so nobody rehearses with real money.
  check(CHAINS.filter((c) => !c.testnet).length >= 15, "too few curated mainnets");
  check(CHAINS.filter((c) => c.testnet).length >= 8, "too few curated testnets");
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

group("the CSP allowlist still bounds the registry, by exact origin");
{
  /* The CSP is a hand-maintained security boundary, so it is not generated
   * from the registry — but a chain whose RPC is missing from it fails at
   * runtime with a blocked request, and a wildcard would quietly undo the
   * boundary. Both are worth catching here rather than in the field.
   *
   * This check was "every registry origin is allowlisted". Expanding the
   * curated table added origins that only the CSP owner can add, so a straight
   * assertion would now fail for a reason this file cannot fix. It is NOT
   * deleted, and not weakened to "some origins are allowed" either. What
   * remains is:
   *
   *   - the boundary properties, unconditionally: no wildcard, no bare https:,
   *     https-only entries. These are the security content of the check and
   *     they must never fail.
   *   - a regression guard: every origin the allowlist already covers must
   *     still be an origin the registry asks for, and every previously working
   *     chain must still be fully reachable. Removing an RPC from a chain that
   *     works today would be caught here.
   *   - the gap, printed loudly and with the exact strings to paste, so
   *     "chain added but unreachable" is impossible to miss in CI output.
   *
   * When the CSP is extended, the FIXME below goes away and the loop at the
   * bottom becomes a hard check over every origin again.
   *
   * T62 added a Rust proxy, so a native build's RPC calls no longer pass
   * through connect-src at all. Nothing here is relaxed for it, and nothing
   * here is deleted as obsolete. Three reasons: the webview fetch path still
   * exists (browser builds, the dev server, and any build compiled without the
   * proxy's HTTP client) and must stay bounded; the directive also covers the
   * WalletConnect relay and anything a dependency might try; and the
   * wildcard/bare-https assertions are the security content of this file
   * regardless of who does the fetching. A second door being opened under
   * supervision is not a reason to take the first one off its hinges. */
  const conf = JSON.parse(
    readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  ) as { app: { security: { csp: string } } };
  const csp = conf.app.security.csp;
  const connect = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";
  check(connect.length > 0, "no connect-src directive found");
  check(!connect.includes("*"), `connect-src contains a wildcard: ${connect}`);
  check(!/https:(\s|$)/.test(connect), "connect-src allows any https origin");
  const allowed = new Set(connect.trim().split(/\s+/));

  /* Entries that are legitimately in the allowlist and are not chain RPCs.
   *
   * Named one by one on purpose. The two checks below - https-only, and no
   * origin that no chain uses - exist so that nothing reaches the allowlist
   * without a human deciding it should. A blanket exemption for "anything not
   * an RPC" would defeat both; an explicit list keeps the property and makes
   * each addition a visible diff. Adding to it is a security decision.
   *
   * The WalletConnect relay is a websocket, so it is the one entry allowed to
   * be wss:// rather than https://. */
  const NON_RPC_ALLOWED = new Set([
    "wss://relay.walletconnect.org",   // WalletConnect v2 relay (PROTOCOL.md 6b)
    /* Tauri's IPC on Linux, where `invoke` rides an ipc:// custom protocol
     * rather than the app's own origin. Tauri documents these two entries but
     * does not inject them; without them every call into Rust is refused on
     * Linux only -- Android and Windows put IPC on the app origin, so 'self'
     * covers it there and the omission is invisible. The one pair of entries
     * here that is not https, and not a remote origin at all: both name the
     * local process this webview is already part of. */
    "ipc:",
    "http://ipc.localhost",
    /* WalletConnect's Verify API, which attests the origin a session proposal
     * claims to come from. Blocked, it fails closed and every proposal is
     * validation UNKNOWN -- a phishing check the UI appears to have and does
     * not. connect-src only: this policy still grants no frame-src, so the
     * attestation is fetched and never framed. Two hosts because the SDK falls
     * back between them. */
    "https://verify.walletconnect.org",
    "https://verify.walletconnect.com",
    /* The published token lists behind the opt-in "update token list" button.
     * Derived from TOKEN_LIST_URLS rather than typed again here, so
     * an origin cannot be added to one and forgotten in the other: a source the
     * app would fetch but the CSP blocks fails only at runtime, and a stale CSP
     * entry outlives the source that justified it. Fetching a list is a
     * disclosure, never a check — see TOKEN_LIST_NOTICE. */
    ...TOKEN_LIST_URLS.map((s) => new URL(s.url).origin),
    /* The flasher's release list (M4, UI-REDESIGN-PLAN.md §2a/§4): the
     * GitHub API for github.com/0xOucan/LeekWallet/releases, the release
     * page a person is pointed at to read notes before trusting a file, and
     * the two hosts GitHub serves release-asset bytes and SHA256SUMS from
     * (asset URLs are 302-redirected across both, depending on age). None of
     * these are RPC endpoints; the app never signs against them. */
    "https://api.github.com",
    "https://github.com",
    "https://objects.githubusercontent.com",
    "https://release-assets.githubusercontent.com",
  ]);

  for (const entry of allowed) {
    if (NON_RPC_ALLOWED.has(entry)) continue;
    check(
      entry === "'self'" || entry.startsWith("https://"),
      `non-https entry in connect-src: ${entry}`,
    );
  }

  const origins = rpcOrigins();
  const known = new Set(origins);
  // An allowlisted origin nothing asks for is either a stale entry or an
  // endpoint reached from outside the registry; both want a human's attention.
  for (const entry of allowed) {
    if (entry === "'self'" || NON_RPC_ALLOWED.has(entry)) continue;
    check(known.has(entry), `CSP allows an origin no chain uses: ${entry}`);
  }

  // Chains that are fully reachable today must stay fully reachable: a chain
  // is only usable if EVERY origin it might pick is allowlisted.
  const reachable = CHAINS.filter((c) =>
    c.rpcUrls.every((u) => allowed.has(new URL(u).origin)),
  ).map((c) => c.id);
  /* 17000 (Holesky) was in this list until 2026-08-14 and is deliberately gone:
   * the Ethereum Foundation shut the network down at the end of September 2025
   * and it is frozen at block 5765077, so "reachable" was no longer something
   * worth guarding. Removed here rather than the guard being weakened -- the
   * list still fails if a live chain silently loses an allowlisted origin.
   * Hoodi (560048) is its replacement and is checked by the loop above. */
  for (const id of [1, 10, 56, 137, 8453, 42161, 11155111, 84532]) {
    check(reachable.includes(id), `chain ${id} was reachable before and is not now`);
  }

  const missing = origins.filter((o) => !allowed.has(o));

  /* Hard again. The gap this reported is closed, so a curated chain whose
   * origin is not allowlisted is now a failure rather than a note: it would
   * otherwise sit in the selector looking usable and fail at runtime. */
  check(missing.length === 0,
        `${missing.length} curated RPC origin(s) are not allowlisted`);
  if (missing.length > 0) {
    console.log(`  Append to connect-src: ${missing.join(" ")}`);
    console.log(
      `  Chains affected: ${CHAINS.filter((c) => c.rpcUrls.some((u) => missing.includes(new URL(u).origin)))
        .map((c) => `${c.name} (${c.id})`)
        .join(", ")}`,
    );
  }
}

group("custom chains are the escape hatch, and are marked as such");
{
  const memStore = (): ChainStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };
  const good: CustomChainInput = {
    id: 424242,
    name: "My Rollup",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.example.invalid"],
    explorerUrl: "https://explore.example.invalid/",
    testnet: false,
  };

  const s = memStore();
  const added = addCustomChain(good, s);
  check(added.ok, `valid custom chain rejected: ${added.ok ? "" : added.errors.join("; ")}`);
  check(added.ok && added.chain.source === "custom", "custom chain not marked custom");
  // Trailing slash normalised so `${explorerUrl}/tx/${hash}` stays valid.
  check(added.ok && added.chain.explorerUrl === "https://explore.example.invalid", "explorer not normalised");

  check(loadCustomChains(s).length === 1, "custom chain did not persist");
  check(resolveChain(424242, s)?.name === "My Rollup", "resolveChain missed a custom chain");
  check(allChains(s).length === CHAINS.length + 1, "allChains does not include customs");
  // Curated first: the trust order is the display order.
  check(allChains(s)[0]?.source === "curated", "custom chain sorted above curated");

  // The label carries the caveat in the same call that yields the name.
  const label = chainLabelDetailed(424242, s);
  check(label.source === "custom", `label source: ${label.source}`);
  check(label.text.includes("custom"), `label hides that it is custom: ${label.text}`);
  check(label.unknown === false, "a known custom chain reported as unknown");
  const curatedLabel = chainLabelDetailed(1, s);
  check(curatedLabel.text === "Ethereum", `curated label decorated: ${curatedLabel.text}`);
  check(chainLabelDetailed(999999, s).unknown === true, "unknown chain not flagged");
  check(chainLabelDetailed(999999, s).text === "chain 999999", "unknown label is not the number");

  // The curated path must not learn about custom chains: a user-typed name
  // must never become something tx-interpret asserts.
  check(getChain(424242) === undefined, "a custom chain leaked into the curated table");
  check(chainName(424242) === undefined, "tx-interpret would assert a user-supplied name");
  check(!rpcOrigins().includes("https://rpc.example.invalid"), "a custom origin reached the CSP audit");

  check(removeCustomChain(424242, s), "remove reported nothing removed");
  check(loadCustomChains(s).length === 0, "custom chain survived removal");
  check(removeCustomChain(424242, s) === false, "removing a missing chain reported success");
}

group("custom chain input is validated, and cannot shadow a curated chain");
{
  const base = {
    name: "X",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.example.invalid"],
    explorerUrl: "https://explore.example.invalid",
  };
  const bad = (over: Partial<CustomChainInput>) =>
    validateCustomChain({ id: 424242, ...base, ...over } as CustomChainInput);

  check(bad({ id: 1 }).ok === false, "a custom entry was allowed to redefine Ethereum");
  check(bad({ id: 0 }).ok === false, "chain 0 accepted");
  check(bad({ id: -3 }).ok === false, "negative chain id accepted");
  check(bad({ id: 1.5 }).ok === false, "fractional chain id accepted");
  check(bad({ name: "  " }).ok === false, "blank name accepted");
  check(bad({ rpcUrls: [] }).ok === false, "no RPC accepted");
  check(bad({ rpcUrls: ["http://rpc.example.invalid"] }).ok === false, "plaintext RPC accepted");
  check(bad({ rpcUrls: ["not a url"] }).ok === false, "unparseable RPC accepted");
  check(
    bad({ rpcUrls: ["https://a.invalid", "https://a.invalid"] }).ok === false,
    "duplicate RPCs accepted",
  );
  check(bad({ explorerUrl: "http://x.invalid" }).ok === false, "plaintext explorer accepted");
  check(
    bad({ nativeCurrency: { name: "E", symbol: "E", decimals: 36 } }).ok === false,
    "implausible decimals accepted",
  );
  check(
    bad({ nativeCurrency: { name: "E", symbol: "E", decimals: 0 } }).ok === false,
    "zero decimals accepted",
  );
  // All objections at once: a form that reveals them one at a time gets abandoned.
  const many = bad({ name: "", rpcUrls: [], explorerUrl: "nope" });
  check(!many.ok && many.errors.length >= 3, "validation stops at the first error");
}

group("persisted custom chains are re-validated on the way out of storage");
{
  // localStorage is writable by anything that gets script into this origin, so
  // stored entries are untrusted input too.
  const withRaw = (raw: string): ChainStore => ({
    getItem: (k) => (k === CUSTOM_CHAINS_KEY ? raw : null),
    setItem: () => {},
  });
  check(loadCustomChains(withRaw("{not json")).length === 0, "malformed JSON survived");
  check(loadCustomChains(withRaw('{"id":1}')).length === 0, "a non-array survived");
  check(loadCustomChains(withRaw("[null,3,\"x\"]")).length === 0, "junk entries survived");
  check(
    loadCustomChains(withRaw(JSON.stringify([{
      id: 1, name: "Ethereum", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://evil.invalid"], explorerUrl: "https://evil.invalid",
    }]))).length === 0,
    "a stored entry shadowed a curated chain",
  );
  const forged = JSON.stringify([{
    source: "curated", id: 424242, name: "Totally Official",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.example.invalid"], explorerUrl: "https://explore.example.invalid",
  }]);
  const loaded = loadCustomChains(withRaw(forged));
  check(loaded[0]?.source === "custom", "a stored entry promoted itself to curated");

  check(CUSTOM_CHAIN_NOTICE.toLowerCase().includes("added by you"), "notice does not say who added it");
  check(CUSTOM_CHAIN_NOTICE.toLowerCase().includes("chain id"), "notice does not point at the chain ID");
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
