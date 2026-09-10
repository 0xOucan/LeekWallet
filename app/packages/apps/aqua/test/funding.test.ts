/**
 * Funding risk: does the real wallet still back what the registry says is
 * committed.
 *
 * Mirrors positions.test.ts and portfolio.test.ts in shape: the property
 * under test is again "a failed read must never present as the safe case" —
 * here the safe case is `funded`, and a dead balance or allowance call must
 * never decay into it. The other half is batching: N legs sharing a token
 * must cost one balance call and one allowance call, not N of either.
 */

import { readFunding } from "../src/funding.ts";
import type { PositionReading } from "../src/positions.ts";
import { encodeAggregate3Return, fakeNode, w } from "./fixtures.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const APP = "0x2222222222222222222222222222222222222222";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const DAI = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063";
const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;
const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const POLYGON = 137;

const okBalance = (amount: bigint) => encodeAggregate3Return([{ success: true, returnData: `0x${w(amount)}` }]);
const okAllowance = (amount: bigint) => encodeAggregate3Return([{ success: true, returnData: `0x${w(amount)}` }]);
const deadCall = encodeAggregate3Return([{ success: false, returnData: "0x" }]);

/* ------------------------------------------------------------------------ */

group("balance and allowance both cover the commitment: funded");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: true, state: "active", amount: 1000n, tokensCount: 1 }] },
  ];
  const node = fakeNode({ calls: [okBalance(1000n), okAllowance(1000n)] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding.length === 1, "a position was lost");
  check(funding[0]!.legs.length === 1, "a leg was lost");
  check(funding[0]!.legs[0]!.state === "funded", `got ${funding[0]!.legs[0]!.state}`);
}

group("balance below the virtual amount: underfunded-balance, even with plenty of allowance");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: true, state: "active", amount: 1000n, tokensCount: 1 }] },
  ];
  const node = fakeNode({ calls: [okBalance(999n), okAllowance(1_000_000n)] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding[0]!.legs[0]!.state === "underfunded-balance", `got ${funding[0]!.legs[0]!.state}`);
}

group("balance is fine, allowance is not: underfunded-allowance");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: true, state: "active", amount: 1000n, tokensCount: 1 }] },
  ];
  const node = fakeNode({ calls: [okBalance(5000n), okAllowance(999n)] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding[0]!.legs[0]!.state === "underfunded-allowance", `got ${funding[0]!.legs[0]!.state}`);
}

group("a failed read is never funded — balance side, allowance side, and both");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: true, state: "active", amount: 1000n, tokensCount: 1 }] },
  ];

  const deadBalance = await readFunding(
    fakeNode({ calls: [deadCall, okAllowance(1_000_000n)] }).request, POLYGON, MAKER, positions,
  );
  check(deadBalance[0]!.legs[0]!.state === "unknown", `dead balance read as ${deadBalance[0]!.legs[0]!.state}`);
  check(deadBalance[0]!.legs[0]!.state !== "funded", "a dead balance call was presented as funded");

  const deadAllowance = await readFunding(
    fakeNode({ calls: [okBalance(1_000_000n), deadCall] }).request, POLYGON, MAKER, positions,
  );
  check(deadAllowance[0]!.legs[0]!.state === "unknown", `dead allowance read as ${deadAllowance[0]!.legs[0]!.state}`);
  check(deadAllowance[0]!.legs[0]!.state !== "funded", "a dead allowance call was presented as funded");

  const bothDead = await readFunding(
    fakeNode({ calls: [deadCall, deadCall] }).request, POLYGON, MAKER, positions,
  );
  check(bothDead[0]!.legs[0]!.state === "unknown", `both dead read as ${bothDead[0]!.legs[0]!.state}`);

  // A node that is entirely unreachable behaves the same way: batch-failed,
  // not a zero and not "funded".
  const unreachable = await readFunding(
    fakeNode({ failing: ["eth_call"] }).request, POLYGON, MAKER, positions,
  );
  check(unreachable[0]!.legs[0]!.state === "unknown", `an unreachable node read as ${unreachable[0]!.legs[0]!.state}`);
}

group("docked and absent legs commit nothing, and are funded without a call");
{
  const positions: PositionReading[] = [
    {
      app: APP, strategyHash: HASH,
      legs: [{ token: USDC, ok: true, state: "docked" }, { token: DAI, ok: true, state: "absent" }],
    },
  ];
  const node = fakeNode({ calls: [] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding[0]!.legs[0]!.state === "funded", "a docked leg was flagged as a funding risk");
  check(funding[0]!.legs[1]!.state === "funded", "an absent leg was flagged as a funding risk");
  check(node.seen.filter((m) => m === "eth_call").length === 0,
    "a balance or allowance was fetched for a leg with nothing committed");
}

group("a leg whose registry read failed is unknown, not funded, and asks for no token");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: false, reason: "call-failed" }] },
  ];
  const node = fakeNode({ calls: [] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding[0]!.legs[0]!.state === "unknown", "an unread registry slot was given a funding verdict");
  check(node.seen.filter((m) => m === "eth_call").length === 0,
    "a leg with no known virtual amount was still asked about on chain");
}

group("legs sharing a token across positions are batched, not asked per leg");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [{ token: USDC, ok: true, state: "active", amount: 100n, tokensCount: 1 }] },
    { app: APP, strategyHash: HASH2, legs: [{ token: USDC, ok: true, state: "active", amount: 200n, tokensCount: 1 }] },
  ];
  const node = fakeNode({ calls: [okBalance(50n), okAllowance(1_000_000n)] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  // Exactly one balance call and one allowance call for the one distinct
  // token, no matter how many positions or legs reference it.
  check(node.seen.filter((m) => m === "eth_call").length === 2,
    `expected 2 eth_call requests for one distinct token, got ${node.seen.filter((m) => m === "eth_call").length}`);
  // Both legs read the *same* balance/allowance answer and each compares it
  // against its own virtual amount — 50 covers neither, so both underfund.
  check(funding[0]!.legs[0]!.state === "underfunded-balance", "the first leg's shortfall was missed");
  check(funding[1]!.legs[0]!.state === "underfunded-balance", "the second leg's shortfall was missed");
}

group("order and length always match the positions given");
{
  const positions: PositionReading[] = [
    { app: APP, strategyHash: HASH, legs: [
      { token: USDC, ok: true, state: "active", amount: 1n, tokensCount: 2 },
      { token: DAI, ok: true, state: "active", amount: 1n, tokensCount: 2 },
    ] },
  ];
  const node = fakeNode({ calls: [
    encodeAggregate3Return([{ success: true, returnData: `0x${w(10n)}` }, { success: true, returnData: `0x${w(10n)}` }]),
    encodeAggregate3Return([{ success: true, returnData: `0x${w(10n)}` }, { success: true, returnData: `0x${w(10n)}` }]),
  ] });
  const funding = await readFunding(node.request, POLYGON, MAKER, positions);
  check(funding[0]!.legs.length === 2, "leg count changed");
  check(funding[0]!.legs[0]!.token === USDC && funding[0]!.legs[1]!.token === DAI,
    "legs came back out of order");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
