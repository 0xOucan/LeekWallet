/**
 * The assembled read: positions plus the approval that bounds them.
 *
 * What is under test is mostly one claim — **a zero and an unavailable are
 * never the same value** — asserted at each of the three places it could be
 * broken independently: the log scan, the registry read, and the token's
 * `allowance`. Each is failed on its own, with the other two healthy, because a
 * blanket outage would pass a version of this code that conflates them.
 *
 * The second claim is the one that makes the app worth building: exposure is
 * the approval, not the position. A tiny strategy behind an unlimited approval
 * must summarise as dangerous, and a large strategy behind a zero approval must
 * summarise as harmless, because that is what is actually true of the wallet.
 */

import { fetchPortfolio, portfolioSummary, verdictFor } from "../src/portfolio.ts";
import { encodeAggregate3Return, fakeNode, pushedLog, shippedLog, w } from "./fixtures.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const APP = "0x2222222222222222222222222222222222222222";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const HASH = `0x${"ab".repeat(32)}`;
const POLYGON = 137;

const UNLIMITED = (1n << 256n) - 1n;

/** One position in USDC, with whatever registry slot and allowance are given. */
const scene = (slot: string | null, allowance: string | null, extra: {
  failing?: string[];
} = {}) => fakeNode({
  head: 100n,
  logs: [shippedLog(MAKER, APP, HASH, "0xbeef"), pushedLog(MAKER, APP, HASH, USDC, 1000n)],
  calls: [
    slot === null
      ? encodeAggregate3Return([{ success: false, returnData: "0x" }])
      : encodeAggregate3Return([{ success: true, returnData: slot }]),
    allowance === null
      ? encodeAggregate3Return([{ success: false, returnData: "0x" }])
      : encodeAggregate3Return([{ success: true, returnData: allowance }]),
  ],
  ...(extra.failing ? { failing: extra.failing } : {}),
});

const active = (amount: bigint) => `0x${w(amount)}${w(1n)}`;
const DOCKED_SLOT = `0x${w(0n)}${w(0xffn)}`;

/* ------------------------------------------------------------------------ */

group("a healthy read reports the position and the approval");
{
  const portfolio = await fetchPortfolio(
    scene(active(1000n), `0x${w(5000n)}`).request, POLYGON, MAKER, { fromBlock: 0n },
  );
  check(portfolio.discovery.ok, "discovery failed on a healthy node");
  check(portfolio.positions.length === 1, "the position was not found");
  check(portfolio.exposures.length === 1, "no exposure was computed");
  const exposure = portfolio.exposures[0]!;
  check(exposure.committed === 1000n, `committed is ${exposure.committed}`);
  check(exposure.committedComplete, "a complete sum was marked incomplete");
  const verdict = verdictFor(exposure);
  check(verdict.kind === "capped", `verdict is ${verdict.kind}`);
  // Headroom is what could still be pulled beyond what was shipped. It is the
  // number that says the approval is not bounded by the strategy.
  check(verdict.kind === "capped" && verdict.headroom === 4000n, "headroom is wrong");
  check(portfolioSummary(portfolio).kind === "ok", "a healthy portfolio did not summarise ok");
}

group("zero and unavailable are different at every layer");
{
  // 1. The registry says the strategy holds nothing. A real, knowable zero.
  const zero = await fetchPortfolio(scene(active(0n), `0x${w(1n)}`).request, POLYGON, MAKER, { fromBlock: 0n });
  const zeroLeg = zero.positions[0]!.legs[0]!;
  check(zeroLeg.ok === true, "a real zero was reported as unreadable");
  check(zeroLeg.ok === true && zeroLeg.state === "active" && zeroLeg.amount === 0n,
    "a drained active position lost its state");
  check(zero.exposures[0]!.committedComplete, "a known zero made the sum incomplete");
  check(portfolioSummary(zero).kind === "ok", "a knowable zero summarised as a problem");

  // 2. The registry did not answer. Same visible amount, entirely different
  //    meaning, and the summary must escalate rather than say "ok".
  const dead = await fetchPortfolio(scene(null, `0x${w(1n)}`).request, POLYGON, MAKER, { fromBlock: 0n });
  const deadLeg = dead.positions[0]!.legs[0]!;
  check(deadLeg.ok === false, "an unreadable slot was reported as read");
  check(!("amount" in deadLeg), "an unreadable slot carried an amount");
  check(dead.exposures[0]!.committedComplete === false,
    "a sum missing a term claimed to be complete");
  check(dead.exposures[0]!.unreadableLegs === 1, "the unreadable leg was not counted");
  check(portfolioSummary(dead).kind === "partial",
    `an unreadable position summarised as ${portfolioSummary(dead).kind}`);

  // 3. The token did not answer `allowance`. The exposure is unknown, and
  //    "unknown" must not decay into "none".
  const noAllowance = await fetchPortfolio(scene(active(1000n), null).request, POLYGON, MAKER, { fromBlock: 0n });
  const verdict = verdictFor(noAllowance.exposures[0]!);
  check(verdict.kind === "unknown", `an unreadable allowance gave verdict ${verdict.kind}`);
  check(portfolioSummary(noAllowance).kind === "partial",
    "an unreadable allowance summarised as ok");

  // A genuine zero allowance is a different verdict from an unreadable one.
  const noApproval = await fetchPortfolio(scene(active(1000n), `0x${w(0n)}`).request, POLYGON, MAKER, { fromBlock: 0n });
  check(verdictFor(noApproval.exposures[0]!).kind === "none",
    "a zero approval was not distinguished from an unreadable one");
}

group("an empty portfolio is empty, an unreachable one is not");
{
  const none = await fetchPortfolio(
    fakeNode({ head: 100n, logs: [] }).request, POLYGON, MAKER, { fromBlock: 0n },
  );
  check(portfolioSummary(none).kind === "empty", "no positions did not summarise as empty");
  check(none.discovery.ok, "an empty scan was reported as a failed one");

  const unreachable = await fetchPortfolio(
    fakeNode({ failing: ["eth_getLogs"] }).request, POLYGON, MAKER, { fromBlock: 0n },
  );
  const summary = portfolioSummary(unreachable);
  check(summary.kind === "unavailable", `an unreachable node summarised as ${summary.kind}`);
  check(summary.kind !== "empty", "an unreachable node summarised as having no positions");
  // No allowance is read either: with no position list there is nothing to be
  // exposed through, and asking anyway would produce a confident "no exposure".
  check(unreachable.exposures.length === 0, "exposures were invented for a failed scan");
}

group("docked is its own state, not a zero and not a failure");
{
  const docked = await fetchPortfolio(scene(DOCKED_SLOT, `0x${w(1n)}`).request, POLYGON, MAKER, { fromBlock: 0n });
  const leg = docked.positions[0]!.legs[0]!;
  check(leg.ok === true && leg.state === "docked", "a docked slot did not read as docked");
  // Docked contributes nothing to the sum but does not make it incomplete:
  // nothing can be pulled from it, and that is knowledge, not ignorance.
  check(docked.exposures[0]!.committed === 0n, "a docked position contributed to committed");
  check(docked.exposures[0]!.committedComplete, "a docked position was treated as unreadable");
}

group("exposure is the approval, not the position");
{
  // A tiny strategy behind an unlimited approval. The registry number is
  // reassuring and irrelevant; what can leave the wallet is everything.
  const dangerous = await fetchPortfolio(
    scene(active(1n), `0x${w(UNLIMITED)}`).request, POLYGON, MAKER, { fromBlock: 0n },
  );
  check(verdictFor(dangerous.exposures[0]!).kind === "unlimited",
    "an unlimited approval was not flagged");
  const summary = portfolioSummary(dangerous);
  check(summary.kind === "unlimited-approval",
    `a 1-unit strategy behind an unlimited approval summarised as ${summary.kind}`);
  check(summary.kind === "unlimited-approval" && summary.tokens[0] === USDC,
    "the dangerous token was not named");

  // An unknown outranks a danger: "we do not know" must never be quietly
  // downgraded to a specific finding, in either direction.
  const both = await fetchPortfolio(
    scene(null, `0x${w(UNLIMITED)}`).request, POLYGON, MAKER, { fromBlock: 0n },
  );
  check(portfolioSummary(both).kind === "partial",
    "an unreadable position was overwritten by an approval verdict");
}

group("a chain Aqua is not on is refused, not answered emptily");
{
  let refused = false;
  try {
    await fetchPortfolio(fakeNode().request, 31337, MAKER, { fromBlock: 0n });
  } catch { refused = true; }
  check(refused, "a portfolio was produced for a chain with no Aqua deployment");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
