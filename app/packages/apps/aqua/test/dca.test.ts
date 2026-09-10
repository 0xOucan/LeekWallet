/**
 * Attended DCA planner tests.
 *
 * Two things are being pinned here and they are different in kind.
 *
 * The first is arithmetic: the tranches sum to the total exactly, the windows
 * do not overlap, every tranche gets distinct strategy bytes, and every
 * tranche's program still decodes. That is ordinary correctness.
 *
 * The second is the honesty surface, and it is tested as deliberately as the
 * arithmetic because it is the thing most likely to erode. `attended` is a
 * field rather than a comment; `UNPROVEN_NOTICE` is always present; the
 * uneconomic case at the user's real funding level is asserted to be flagged
 * rather than quietly planned. A future edit that made this planner sound
 * automated, or proven, or economic at 2 USDC, fails here.
 */

import {
  MAX_TRANCHES, ATTENDED_NOTICE, UNECONOMIC_NOTICE, UNPROVEN_NOTICE,
  planDca, shippableAt, remaining, type DcaRequest,
} from "../src/dca.ts";
import { readOrderProgram } from "../src/program.ts";
import { AQUA_SWAPVM_ROUTER } from "../src/registry.ts";
import type { TokenSpec } from "../src/authoring.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown, pattern: RegExp): boolean => {
  try { fn(); return false; } catch (e) { return pattern.test(String(e)); }
};

const WETH: TokenSpec = { address: "0x4200000000000000000000000000000000000006", decimals: 18 };
const USDC: TokenSpec = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 };
const MAKER = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const GATE = "0x00000000000000000000000000000000000000aa";

const req = (over: Partial<DcaRequest> = {}): DcaRequest => ({
  maker: MAKER, a: WETH, b: USDC,
  mid: { base: WETH.address, quote: USDC.address, price: "4000" },
  tier: "medium", gateToken: GATE, feePercent: "0.30",
  total: 2_000_000n,                 /* 2.000000 USDC -- the real funding */
  spendToken: USDC.address,
  tranches: 4,
  startAt: 1_800_000_000n,
  intervalSeconds: 3600,
  minTrancheOut: 1n,
  saltSeed: Uint8Array.from([1, 2, 3, 4, 5, 6, 0, 0]),
  ...over,
});

/* ---------------------------------------------------------------- honesty */

group("the plan is attended, and says so as a field rather than a comment");
{
  const p = planDca(req());
  check(p.attended === true, "attended is on the value");
  check(p.notices.includes(ATTENDED_NOTICE), "the attended sentence is carried");
  /* "automation" may appear, but only under a negation. A notice that said
   * this planner WAS an automation would be the overclaim; one that says it
   * is not is the whole point. */
  check(/not an automation/.test(ATTENDED_NOTICE), "the notice denies automation outright");
  check(/never on its own/.test(ATTENDED_NOTICE), "it says what it will not do");
}

group("every plan carries the not-proven notice, unconditionally");
{
  for (const t of [2, 4, MAX_TRANCHES]) {
    const p = planDca(req({ tranches: t, total: 2_000_000n }));
    check(p.notices.includes(UNPROVEN_NOTICE), `${t} tranches still says unproven`);
  }
  check(
    /has ever been shipped on a live chain/.test(UNPROVEN_NOTICE),
    "it says plainly what has not happened",
  );
}

group("at the user's real funding the schedule is flagged uneconomic, not hidden");
{
  /* 2 USDC over 4 tranches is 0.50 USDC each. Against a minimum a taker would
   * actually bother with on an L2 -- here 100 USDC, standing in for 1inch's
   * ~1000x-gas guidance -- every tranche is far below it. */
  const p = planDca(req({ minTrancheOut: 100_000_000n }));
  check(p.economic === false, "flagged uneconomic");
  check(p.notices.includes(UNECONOMIC_NOTICE), "the notice is attached");
  /* And it is not silently suppressed when the tranches ARE big enough. */
  const q = planDca(req({ total: 2_000_000_000n, minTrancheOut: 100_000_000n }));
  check(q.economic === true, "a funded schedule is not flagged");
  check(!q.notices.includes(UNECONOMIC_NOTICE), "no spurious notice");
}

/* ------------------------------------------------------------- arithmetic */

group("the tranches sum to the total exactly, remainder and all");
{
  /* 7 does not divide 2_000_000 evenly: 285714 x 7 = 1_999_998, so the last
   * tranche must carry 2 extra raw units rather than the schedule quietly
   * spending less than the user said. */
  const p = planDca(req({ tranches: 7 }));
  check(p.totalPlanned === 2_000_000n, `summed to ${p.totalPlanned}`);
  const last = p.tranches[p.tranches.length - 1]!;
  check(last.amount === 285_716n, `last tranche ${last.amount}`);
  check(p.tranches[0]!.amount === 285_714n, `first tranche ${p.tranches[0]!.amount}`);
  for (const t of p.tranches) check(t.amount > 0n, `tranche ${t.index} is non-zero`);
}

group("windows are contiguous, ordered, and do not overlap");
{
  const p = planDca(req({ tranches: 5, intervalSeconds: 600 }));
  for (const t of p.tranches) {
    check(t.deadline === t.shipAfter + 600n, `tranche ${t.index} window is one interval`);
    /* Each tranche's own deadline opcode must match its window, or the
     * position would expire at a time the schedule does not know about. */
    const r = readOrderProgram(t.position.strategy, AQUA_SWAPVM_ROUTER);
    check(r.ok, `tranche ${t.index} decodes`);
    if (r.ok) {
      const d = r.instructions[0]!.fields;
      check(d.name === "deadline" && d.deadline === t.deadline, `tranche ${t.index} deadline matches`);
    }
  }
  for (let i = 1; i < p.tranches.length; i++) {
    check(p.tranches[i]!.shipAfter === p.tranches[i - 1]!.deadline, `tranche ${i} follows`);
  }
}

group("every tranche gets its own strategy bytes, so registry slots cannot collide");
{
  const p = planDca(req({ tranches: MAX_TRANCHES }));
  const hashes = new Set(p.tranches.map((t) => t.position.strategy));
  check(hashes.size === MAX_TRANCHES, `${hashes.size} distinct of ${MAX_TRANCHES}`);
}

group("every tranche's program decodes in full, so the device would render it");
{
  const p = planDca(req({ tranches: 6 }));
  for (const t of p.tranches) {
    const r = readOrderProgram(t.position.strategy, AQUA_SWAPVM_ROUTER);
    check(r.ok && r.instructions.length === 6, `tranche ${t.index}`);
  }
}

/* ----------------------------------------------------------------- clock */

group("shippable is the open window, and a closed one is skipped rather than shipped late");
{
  const p = planDca(req({ tranches: 3, intervalSeconds: 100, startAt: 1000n }));
  check(shippableAt(p, 999n) === undefined, "before the start, nothing is shippable");
  check(shippableAt(p, 1000n)?.index === 0, "at the start, tranche 0");
  check(shippableAt(p, 1099n)?.index === 0, "just inside tranche 0's window");
  check(shippableAt(p, 1100n)?.index === 1, "at the boundary, tranche 1");
  check(shippableAt(p, 1300n) === undefined, "past the end, nothing");
  /* "wait" and "done" are different states and the caller must tell them
   * apart -- the same zero-versus-unavailable rule the portfolio applies. */
  check(remaining(p, 999n) === 3, "nothing has closed yet");
  check(remaining(p, 1150n) === 2, "one window has closed");
  check(remaining(p, 1300n) === 0, "all closed");
}

/* --------------------------------------------------------------- refusals */

group("a schedule that is not a schedule is refused rather than planned");
{
  check(threw(() => planDca(req({ tranches: 1 })), /at least two/), "one tranche");
  check(threw(() => planDca(req({ tranches: MAX_TRANCHES + 1 })), /at most/), "too many tranches");
  check(threw(() => planDca(req({ total: 0n })), /spends nothing/), "nothing to spend");
  check(threw(() => planDca(req({ total: 3n, tranches: 4 })), /fewer raw units/), "a zero tranche");
  check(threw(() => planDca(req({ intervalSeconds: 0 })), /positive number of seconds/), "zero interval");
  check(threw(() => planDca(req({ startAt: 0n })), /positive unix time/), "no start");
  check(threw(() => planDca(req({ saltSeed: new Uint8Array(4) })), /8 bytes/), "short seed");
  check(
    threw(() => planDca(req({ spendToken: GATE })), /not one of the pair/),
    "spending a token that is not in the pair",
  );
}

group("the tranche cap is low enough that a person can actually attend it");
{
  /* Every tranche is one press on the device. This is a design bound, not a
   * protocol one, and it is pinned so that raising it is a deliberate act. */
  check(MAX_TRANCHES === 24, `MAX_TRANCHES = ${MAX_TRANCHES}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
