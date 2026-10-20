/**
 * The LeekDefi mini-app: both halves of the signing path, and the sentences.
 *
 * What is actually at stake here is that a mini-app may not ask for a
 * signature on a payload nothing can describe. There are two gates in front of
 * that, in different codebases, and an app is only usable if BOTH pass:
 *
 *   1. The host gate, `screenProposal`, which needs an ERC-7730 descriptor
 *      that renders every argument with no conflicts. descriptors.ts supplies
 *      it.
 *   2. The device, which decodes what it signs from its own table in
 *      src/eth-decode.c and refuses anything not in it, descriptor or no
 *      descriptor. eth-decode.ts mirrors that table, and the shared vectors
 *      recorded from the real C decoder are what prove the mirror is honest.
 *
 * It is entirely possible to satisfy one and not the other, and the failure is
 * quiet in both directions: a descriptor with no table row gives a companion
 * that happily screens a call the device then refuses, and a table row with no
 * descriptor gives a device that would draw a call the companion will not
 * send. So this file checks the same calldata through both.
 *
 * It runs without a browser: everything under test is pure.
 */

import { CallKind, decodeCall } from "../packages/core/src/eth-decode.ts";
import { screenProposal } from "../packages/core/src/app-proposal.ts";
import { DEFAULT_DESCRIPTORS } from "../packages/core/src/tx-interpret.ts";
import {
  BORROWER_OPERATIONS, INDICES, MEZO_TESTNET, MUSD, STAKING,
} from "../packages/apps/leekdefi/addresses.ts";
import { descriptorsFor } from "../packages/apps/leekdefi/descriptors.ts";
import { encode } from "../packages/apps/leekdefi/read.ts";
import { collateralRatioBps, encodeBorrow } from "../packages/apps/leekdefi/borrow.ts";
import { MEZO } from "../packages/apps/leekdefi/addresses.ts";
import { MINI_APPS, findMiniApp } from "../src/apps/registry.ts";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const SIGNER = "0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45";
const VAULT = INDICES[0]!.vault;
/* The real figures from the first live buy on Mezo testnet, 2026-10-18. */
const SPEND = 296955200743718592965n;
const FLOOR = 2970000000000000000n;

/* ------------------------------------------------------------- the app is on */

{
  group("the app is registered, and only on the chain it is deployed to");
  check(MINI_APPS.length >= 1, "no app is registered");
  const app = findMiniApp("leekdefi");
  check(app !== undefined, "leekdefi is not in the registry");
  check(app?.chainIds.includes(MEZO_TESTNET) === true, "leekdefi does not list Mezo testnet");
  /* An app offered on a chain its contracts are not on would render addresses
     with no code behind them. The app decides this, not the shell. */
  check(app?.chainIds.length === 1, "leekdefi claims a chain it is not deployed on");
  check(app?.css.includes("leekdefi-") === true, "the stylesheet is not prefixed with the app id");
  /* Unprefixed class names would style whatever else the shell has injected. */
  check(
    app?.css.match(/\.(?!leekdefi)[a-z]/) === null,
    "the stylesheet carries a class that is not prefixed with the app id",
  );
  check(app?.worksWithoutDevice !== true, "leekdefi claims to work with no device, but it proposes calls");
}

/* ----------------------------------------------------------- the host gate */

{
  group("the host gate accepts a buy, and renders both of its arguments");
  const data = encode.buy(SPEND, FLOOR);
  const result = screenProposal(
    { kind: "call", to: VAULT, data, reason: "Buy GOLOGGLE" },
    {
      chainId: MEZO_TESTNET,
      from: SIGNER,
      descriptors: [...DEFAULT_DESCRIPTORS, ...descriptorsFor(MEZO_TESTNET, VAULT)],
    },
  );
  check(result.kind === "ok", `a buy was refused: ${result.kind === "refused" ? result.why : ""}`);
  if (result.kind === "ok" && result.screened.kind === "call") {
    const d = result.screened.descriptor;
    check(d !== undefined, "the buy was screened with no descriptor");
    check(d?.omittedFields === 0, `the descriptor omitted ${d?.omittedFields} field(s)`);
    check(d?.conflicts.length === 0, `descriptor and decoder disagree: ${d?.conflicts[0]}`);
    /* THE PROPERTY: the slippage floor is on screen. A buy with a floor of
       zero is a buy at whatever price the oracle happens to publish, which is
       exactly the call an operator of a mispriced feed wants signed. A summary
       that showed only the MUSD spent would hide it. */
    const values = (d?.fields ?? []).map((f) => f.value).join(" | ");
    check(values.includes("296.955200743718592965"), `the amount spent is not shown: ${values}`);
    check(values.includes("2.97"), `the slippage floor is not shown: ${values}`);
    check(d?.hiddenFields === 0, "the descriptor hides a field of a buy");
  }
}

{
  group("the same calldata at another address is refused");
  /* Descriptors are per deployment. A vault address this app does not know is
     not describable, and must be refused rather than described by analogy. */
  const stranger = "0x00000000000000000000000000000000deadbeef";
  const result = screenProposal(
    { kind: "call", to: stranger, data: encode.buy(SPEND, FLOOR), reason: "Buy somewhere else" },
    {
      chainId: MEZO_TESTNET,
      from: SIGNER,
      descriptors: [...DEFAULT_DESCRIPTORS, ...descriptorsFor(MEZO_TESTNET, stranger)],
    },
  );
  check(result.kind === "refused", "a buy at an unknown address was screened as ok");
}

{
  group("descriptors are scoped to this app's contracts and this app's chain");
  check(descriptorsFor(MEZO_TESTNET, VAULT).length > 0, "the vault has no descriptor");
  check(descriptorsFor(MEZO_TESTNET, STAKING).length > 0, "staking has no descriptor");
  /* Narrowed by the shell's question rather than handing back everything: an
     app that answers with three other contracts' descriptors is asking the
     matcher to do its narrowing. */
  check(
    descriptorsFor(MEZO_TESTNET, VAULT).every((d) =>
      d.deployments.every((dep) => dep.address === VAULT.toLowerCase())),
    "asking about one vault returned another contract's descriptor",
  );
  /* The app lists one chain; a descriptor offered on another would be the app
     relying on the shell to enforce the app's own list. */
  check(descriptorsFor(1, VAULT).length === 0, "a descriptor was offered on Ethereum mainnet");
  for (const d of descriptorsFor(MEZO_TESTNET, VAULT)) {
    check(d.source.startsWith("local/"), `an app descriptor claims registry provenance: ${d.source}`);
  }
}

/* --------------------------------------------------------------- the device */

{
  group("the device's own decoder reads every call this app proposes");
  /* The mirror of src/eth-decode.c. A call the host screened and the device
     cannot read is a dead end that only shows up with hardware in hand. */
  const cases: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["buy", encode.buy(SPEND, FLOOR), ["musdAmount", "minShares"]],
    ["redeem", encode.redeem(1000000000000000000n, 90000000000000000000n), ["shares", "minMusd"]],
    ["stake", encode.stake(50000000000000000000n), ["amount"]],
  ];
  for (const [name, data, names] of cases) {
    const decoded = decodeCall(data);
    check(decoded.kind === CallKind.Generic, `${name} is not decoded by the device: ${decoded.kind}`);
    const args = decoded.args ?? [];
    check(args.length === names.length, `${name} decoded ${args.length} of ${names.length} arguments`);
    for (const [i, expected] of names.entries()) {
      check(args[i]?.name === expected, `${name} argument ${i} is "${args[i]?.name}", expected "${expected}"`);
    }
  }
  /* The approval that must precede a buy. Drawn by the device from its own
     pre-generic table, with a screen that says "Approve spending". */
  const approval = decodeCall(encode.approve(VAULT, SPEND));
  check(approval.kind === CallKind.Erc20Approve, `an approval is not decoded: ${approval.kind}`);
}

{
  group("the buy's slippage floor survives the round trip to the device");
  /* Not just "it decoded": the number the device would draw has to be the
     number that was encoded. A decoder that read the two words in the wrong
     order would still produce two named arguments. */
  const decoded = decodeCall(encode.buy(SPEND, FLOOR));
  const [spent, floor] = decoded.args ?? [];
  /* uint arguments come back as bigint, so this compares numbers and not the
     string shapes of numbers. */
  check(spent?.value === SPEND, `the device reads ${spent?.value} spent, not ${SPEND}`);
  check(floor?.value === FLOOR, `the device reads ${floor?.value} as the floor, not ${FLOOR}`);
}

{
  group("every write the panel offers passes both gates");
  /* Each pair is (what the button does, the calldata it proposes, the
     contract it goes to). A button whose call the host refuses or the device
     cannot read is a dead end that only shows up with hardware in hand. */
  const SHARE = INDICES[0]!.share;
  const writes: ReadonlyArray<readonly [string, string, string]> = [
    ["approve MUSD", encode.approve(VAULT, SPEND), MUSD],
    ["buy", encode.buy(SPEND, FLOOR), VAULT],
    ["approve shares", encode.approve(VAULT, FLOOR), SHARE],
    ["redeem", encode.redeem(10n ** 18n, 90n * 10n ** 18n), VAULT],
    ["approve MEZO", encode.approve(STAKING, 50n * 10n ** 18n), MEZO],
    ["stake", encode.stake(50n * 10n ** 18n), STAKING],
    ["unstake", encode.unstake(50n * 10n ** 18n), STAKING],
  ];
  for (const [what, data, to] of writes) {
    const decoded = decodeCall(data);
    check(
      decoded.kind !== CallKind.Unknown,
      `${what}: the device cannot read it (${decoded.kind})`,
    );
    const screened = screenProposal(
      { kind: "call", to, data, reason: `${what} test` },
      {
        chainId: MEZO_TESTNET,
        from: SIGNER,
        descriptors: [...DEFAULT_DESCRIPTORS, ...descriptorsFor(MEZO_TESTNET, to)],
        nativeSymbol: "BTC",
      },
    );
    check(
      screened.kind === "ok",
      `${what} was refused: ${screened.kind === "refused" ? screened.why : ""}`,
    );
    if (screened.kind === "ok" && screened.screened.kind === "call") {
      const d = screened.screened.descriptor;
      check(d?.omittedFields === 0, `${what}: ${d?.omittedFields} field(s) omitted`);
      check(d?.conflicts.length === 0, `${what}: ${d?.conflicts[0]}`);
    }
  }
}

/* ------------------------------------------------------------ mezo borrow */

{
  group("the borrow calls pass both gates, and openTrove shows the BTC");
  /* The MUSD this market settles in is minted only here, so a wallet that
     could buy a share but not borrow was a market you could only use if you
     had already borrowed somewhere else. */
  const cases: ReadonlyArray<readonly [string, string, bigint, readonly string[]]> = [
    ["openTrove", encodeBorrow.openTrove(2000n * 10n ** 18n), 10n ** 16n,
      ["debtAmount", "upperHint", "lowerHint"]],
    ["withdrawMUSD", encodeBorrow.withdrawMUSD(100n * 10n ** 18n), 0n,
      ["amount", "upperHint", "lowerHint"]],
    ["repayMUSD", encodeBorrow.repayMUSD(9209340000000000000n), 0n,
      ["amount", "upperHint", "lowerHint"]],
    ["closeTrove", encodeBorrow.closeTrove(), 0n, []],
  ];

  for (const [name, data, value, names] of cases) {
    /* The device's own decoder first: a descriptor would satisfy the host and
       leave the device refusing the call. */
    const decoded = decodeCall(data);
    check(decoded.kind === CallKind.Generic, `${name} is not decoded by the device: ${decoded.kind}`);
    const args = decoded.args ?? [];
    check(args.length === names.length, `${name} decoded ${args.length} of ${names.length} arguments`);
    for (const [i, expected] of names.entries()) {
      check(args[i]?.name === expected, `${name} argument ${i} is "${args[i]?.name}"`);
    }

    const screened = screenProposal(
      { kind: "call", to: BORROWER_OPERATIONS, data, value, reason: `${name} test` },
      { chainId: MEZO_TESTNET, from: SIGNER, descriptors: DEFAULT_DESCRIPTORS, nativeSymbol: "BTC" },
    );
    check(
      screened.kind === "ok",
      `${name} was refused: ${screened.kind === "refused" ? screened.why : ""}`,
    );
    if (screened.kind === "ok" && screened.screened.kind === "call") {
      const d = screened.screened.descriptor;
      check(d?.omittedFields === 0, `${name} omitted ${d?.omittedFields} field(s)`);
      check(d?.conflicts.length === 0, `${name}: ${d?.conflicts[0]}`);

      /* THE PROPERTY for openTrove: the BTC is the transaction's VALUE and not
         an argument, so a descriptor reading only calldata would show somebody
         taking on 2,000 MUSD of debt with no mention of the Bitcoin they are
         locking behind it. @.value is how it reaches that. */
      if (name === "openTrove") {
        const values = (d?.fields ?? []).map((f) => `${f.label}=${f.value}`).join(" | ");
        check(values.includes("0.01 BTC"), `the BTC collateral is not shown: ${values}`);
        check(values.includes("2000"), `the debt is not shown: ${values}`);
        /* BTC, not ether. Mezo is Bitcoin-backed and a screen reading "ETH"
           here would be a lie on the one screen meant to be trustworthy. */
        check(!values.includes("ETH"), `openTrove drew ETH on a Bitcoin chain: ${values}`);
      }
    }
  }
}

{
  group("every input the borrow panel shows has a label a sighted user can read");
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");
  /* The panel shipped with two boxes, one carrying only an aria-label. A
     sighted user saw an unlabelled box above a labelled one, typed the BTC
     collateral into the MUSD field, and was refused for being under the
     minimum loan - a correct answer to a question nobody meant to ask. */
  check(
    source.includes("function labelledInput("),
    "the labelled-input helper is gone",
  );
  check(
    !/setAttribute\("aria-label"/.test(source),
    "an input is labelled only for screen readers; sighted users see nothing",
  );
  /* The minimum is stated beside the field rather than only in a refusal
     after the fact. */
  check(source.includes("the protocol refuses less"), "the minimum loan is not stated by the field");
  /* The reserve is read from the chain, not written into the copy: it is a
     protocol constant today and a wrong number on a screen if it changes. */
  check(
    !/\b200 MUSD liquidation reserve\b/.test(source),
    "the liquidation reserve is hardcoded in the copy instead of read",
  );
  check(source.includes("MUSD_GAS_COMPENSATION")
    || readFileSync(new URL("../packages/apps/leekdefi/borrow.ts", import.meta.url), "utf8")
      .includes("MUSD_GAS_COMPENSATION"), "the reserve is not read from the chain");
}

{
  group("the ratio preview measures what the protocol measures");
  /* Debt PLUS the liquidation reserve. Using the typed figure alone made the
     preview more optimistic than the chain and sent the device a transaction
     that reverts. */
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");
  check(
    source.includes("const owed = debt + (state.reserve ?? 0n);"),
    "the ratio preview ignores the liquidation reserve",
  );
}

{
  group("a position owing nothing has no ratio, rather than an infinite one");
  /* Same mistake as a vault's backing rendered 0% because nothing was owed:
     infinity printed as a figure is not a measurement. */
  const base = {
    status: 1n, collateral: 10n ** 16n, price: 100_000n * 10n ** 18n,
    mcr: 11n * 10n ** 17n, minNetDebt: 1800n * 10n ** 18n, reserve: 200n * 10n ** 18n,
  };
  check(collateralRatioBps({ ...base, debt: 0n }) === null, "a debt of zero produced a ratio");
  check(collateralRatioBps({ ...base, debt: null }) === null, "an unread debt produced a ratio");
  check(
    collateralRatioBps({ ...base, debt: 500n * 10n ** 18n, price: null }) === null,
    "an unread price produced a ratio",
  );
  /* 0.01 BTC at 100,000 USD against 500 MUSD is 200%. */
  const ratio = collateralRatioBps({ ...base, debt: 500n * 10n ** 18n });
  check(ratio === 20_000, `expected 20000 bps, got ${ratio}`);
}

/* ------------------------------------------------------------- the sentences */

{
  group("the two claims the screen must not get wrong are on it");
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");
  /* `redeem` pays shares * price - fee and never reads reserves, so reserves
     growing does not change what a share is worth. An APY on shares would be a
     number with no mechanism behind it. */
  check(source.includes("Holding a share pays no income."), "the no-income sentence is gone");
  check(source.includes("there is no yield and no APY to quote"), "the no-APY sentence is gone");
  /* These track baskets of cryptoassets and are not named after companies. */
  check(source.includes("invented index names"), "the invented-names disclaimer is gone");
  check(source.includes("Testnet only"), "the testnet-only disclaimer is gone");
  /* H-1 is real and fired on the live deployment within an hour of launch. */
  check(source.includes("H-1"), "the H-1 disclosure is gone");
  /* The empty-vault state, which the website got wrong first: a null coverage
     means either an unreadable price or nothing owed, and they are opposites. */
  check(source.includes("no shares yet"), "the empty-vault state is gone");
  /* Borrowing is a loan against liquidatable collateral, and the ratio must
     sit beside the debt rather than behind a disclosure. */
  check(source.includes("It is a loan, not a swap"), "the loan-not-swap sentence is gone");
  check(source.includes("liquidatable below"), "the liquidation threshold is not shown");
  check(
    source.includes("the price is unreadable"),
    "the unreadable-price state is gone, so the two cases have collapsed again",
  );
  /* The faucet is Mezo's own, and MUSD is deliberately not faucetable. */
  check(source.includes("faucet.test.mezo.org") || readFileSync(
    new URL("../packages/apps/leekdefi/addresses.ts", import.meta.url), "utf8",
  ).includes("faucet.test.mezo.org"), "the Mezo faucet link is gone");
}

/* ------------------------------------------- state is re-read after a write */

{
  group("every write re-reads the chain, and no panel holds the raw propose");
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");
  /* The failure this guards against actually happened on the device: a borrow
     landed, the panel kept the pre-borrow state, offered to OPEN the trove
     again, and the chain answered "BorrowerOps: Trove is active". The app
     cannot tell a revert from a reject by design, so it reported a refusal.
     The cure is that a successful write re-reads before redrawing. */
  check(source.includes("if (outcome.ok) await refresh(true);"), "a successful write no longer refreshes");
  check(source.includes("const refresh = async (awaitChange = false)"), "refresh() is gone");
  /* Re-reading immediately is not enough and was its own bug: `propose`
     returns when the transaction is SENT, and Mezo includes it seconds to
     minutes later. The first version read the pre-transaction state, redrew
     with it, and showed a 150 MUSD allowance as "Nothing is approved yet" --
     after which this app's own guard refused the buy it existed to enable.
     So a write polls until the chain actually differs. */
  check(source.includes("const signature = (): string =>"), "there is no state signature to compare against");
  check(source.includes('say("Sent. Waiting for Mezo to include it…");'), "a pending write says nothing while it waits");
  check(
    source.includes("if (before === null || signature() !== before) return;"),
    "refresh no longer waits for the state to actually change",
  );
  /* Giving up must not claim the write failed. */
  check(source.includes("usually late rather than failed"), "a slow write is reported as a failure");
  /* One wrapper, not eleven call sites that might forget. Every panel must
     receive the wrapped propose; a panel given context.propose directly would
     silently stop refreshing. */
  const panelArgs = source.match(/propose(?:Stake)?\s*=\s*context\.propose\b/g) ?? [];
  check(panelArgs.length === 0, `a panel still takes context.propose directly (${panelArgs.length})`);
  check(
    !source.includes("borrowPanel(borrow, context.propose"),
    "the borrow panel bypasses the refreshing propose",
  );
  /* Mezo returns a null receipt for minutes after inclusion, so the user needs
     a way to ask again without re-signing anything. */
  check(source.includes("Re-read the chain"), "the manual re-read button is gone");
}

/* ------------------------------------------ every index can be traded, not one */

{
  group("the trade panel reaches every index, and the order matches the website");
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");
  /* Every index got a price card and only the first got a trade panel, so
     AMEZON was priced on screen and could not be bought. */
  check(source.includes("state.indices[selected] ?? state.indices[0]"), "the trade panel is pinned to one index again");
  check(source.includes("let selected = 0;"), "the selected index does not survive a redraw");
  check(!/const first = state\.indices\[0\];/.test(source), "indices[0] is still hardcoded in the trade panel");
  /* A redraw must not silently move the user to a different market than the
     one whose buttons they are about to press. */
  check(source.includes("selected = Number(pick.value);"), "changing the index does not update the selection");

  /* The website's order is indices -> borrow -> trade -> position -> staking
     -> faucet. Two screens for one product should not read in two orders. */
  const order = ["body.append(indexCard", "borrowPanel(borrow", "body.append(trade);", "body.append(position);", "body.append(staking)"];
  let at = -1;
  for (const marker of order) {
    const found = source.indexOf(marker);
    check(found > at, `panel order: ${marker} is out of sequence`);
    at = found;
  }
  /* The faucet is a prerequisite, not the headline; it read second. */
  check(
    source.indexOf("wrap.append(faucet);") > source.indexOf("wrap.append(body);"),
    "the faucet is back above the panels",
  );
}

/* ----------------------------------- no write reaches the device unguarded */

{
  group("every write checks the chain before it asks the device to sign");
  const source = readFileSync(new URL("../packages/apps/leekdefi/index.ts", import.meta.url), "utf8");

  /* An approval already given is the one the device should never be asked to
     draw twice: a spurious signature teaches approving without reading, which
     is the only defence this design has. All three approvals must consult the
     allowance that read.ts has always fetched. */
  check(source.includes("function armApproval("), "armApproval is gone");
  const armed = source.match(/armApproval\(/g) ?? [];
  check(armed.length === 4, `expected 3 wired approvals plus the definition, found ${armed.length - 1} wired`);
  check(source.includes('armApproval(approve, input, first.allowance, "MUSD")'), "the MUSD approval is unguarded");
  check(source.includes("armApproval(approveShares, input, first.shareAllowance"), "the share approval is unguarded");
  check(source.includes('armApproval(approveMezo, stakeField.input, s.mezoAllowance, "MEZO")'), "the MEZO approval is unguarded");
  /* Unreadable is not zero: a null allowance must still offer the approval. */
  check(source.includes("could not be read, so the approval is offered anyway"), "a null allowance now blocks the approval");

  /* Closing repays debt MINUS the liquidation reserve out of your own
     balance. Getting this wrong by exactly the reserve is the easy mistake,
     and it costs a signature to discover. */
  check(source.includes("Closing repays"), "closeTrove no longer checks the balance it spends");
  check(source.includes("const needed = state.debt - state.reserve;"), "close measures the gross debt, not the repayable part");
  /* Repaying past the repayable part, or down to a stub below the minimum. */
  check(source.includes("is the liquidation reserve"), "repay does not explain the reserve");
  check(source.includes("below the"), "repay does not check the minimum net debt");
  /* Borrowing more was the one borrow path with no ratio preview. */
  check(source.includes("Borrowing that much would put the ratio at"), "withdrawMUSD has no ratio preview");
  /* An allowance is permission, not money. */
  check(source.includes("An allowance is permission, not money"), "buy no longer checks the MUSD balance");
  check(source.includes("You have nothing staked."), "unstake no longer checks the staked balance");

  /* The structural claim: every click handler that proposes refuses something
     locally first. A new button with no guard fails here rather than in the
     user's hand. */
  const unguarded: string[] = [];
  for (const m of source.matchAll(/(\w+)\.addEventListener\("click", \(\) => \{/g)) {
    const name = m[1]!;
    let depth = 1, i = m.index! + m[0].length;
    while (depth > 0 && i < source.length) {
      const c = source[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = source.slice(m.index! + m[0].length, i);
    if (!body.includes("await propose")) continue;
    /* A guard is a local refusal: a say() that returns without proposing. */
    if (!/say\([^]*?\n\s*return;/.test(body)) unguarded.push(name);
  }
  check(unguarded.length === 0, `writes with no local refusal: ${unguarded.join(", ") || "none"}`);
}

console.log(failures === 0 ? "all ok" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
