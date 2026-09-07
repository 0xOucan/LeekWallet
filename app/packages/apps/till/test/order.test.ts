/**
 * Tip arithmetic and the payable amount.
 *
 * The properties worth pinning are the ones a float would break: base + tip
 * equals the total exactly, a tip rounds once and predictably, and cents scale
 * into raw units by the token's own decimals — 6 for USDC and EURC everywhere,
 * including Arc's ERC-20 face, whose native unit has 18.
 */

import { buildOrder, formatCents, newMarker, parseCents, payableUnits, tipCents } from "../src/order.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

group("parsing an amount");
{
  const cases: [string, bigint][] = [
    ["284.53", 28453n], ["0.01", 1n], ["10", 1000n], ["1.5", 150n], [" 1,234.50 ", 123450n],
  ];
  for (const [text, cents] of cases) {
    const r = parseCents(text);
    check(r.ok && r.cents === cents, `parseCents(${text}) should be ${cents}`);
  }
  for (const bad of ["", "abc", "1.234", "-5", "1e3"]) {
    check(!parseCents(bad).ok, `parseCents(${JSON.stringify(bad)}) should refuse`);
  }
  // A third decimal is refused, not truncated: a silently dropped tenth of a
  // cent is somebody's money going missing from the books.
  const three = parseCents("1.239");
  check(!three.ok && /decimal/.test(three.reason), "a third decimal place should say so");
}

group("formatting is exact");
{
  eq(formatCents(28453n), "284.53", "284.53");
  eq(formatCents(5n), "0.05", "0.05");
  eq(formatCents(0n), "0.00", "zero");
}

group("tips round once, half-up, and always add up");
{
  // 284.53 * 1.15 is 327.20949999999996 as a float. Integer arithmetic gives
  // the tip as 42.68 and the total as exactly base + tip.
  const order = buildOrder(28453n, { kind: "percent", percent: 15 });
  eq(order.tip, 4268n, "15% of 284.53");
  eq(order.total, 32721n, "total");
  eq(order.base + order.tip, order.total, "base + tip must equal total");

  eq(tipCents(28453n, { kind: "percent", percent: 10 }), 2845n, "10% of 284.53 (2845.3 -> 2845)");
  eq(tipCents(1n, { kind: "percent", percent: 50 }), 1n, "half a cent rounds up");
  eq(tipCents(1n, { kind: "percent", percent: 49 }), 0n, "just under half rounds down");
  eq(tipCents(1000n, { kind: "percent", percent: 0 }), 0n, "no tip");
  eq(tipCents(1000n, { kind: "amount", cents: 375n }), 375n, "a typed tip is used as typed");

  // Every whole-cent bill up to $100 at every preset: total is always the sum.
  for (let cents = 0n; cents <= 10_000n; cents++) {
    for (const percent of [10, 15, 18, 22]) {
      const o = buildOrder(cents, { kind: "percent", percent });
      if (o.base + o.tip !== o.total) { check(false, `sum broke at ${cents}/${percent}`); cents = 10_001n; break; }
    }
  }
}

group("cents become raw units, with sub-cent entropy");
{
  // USDC/EURC are 6 decimals on all nine chains, Arc's ERC-20 face included.
  eq(payableUnits(28453n, 6, 17), 284_531_700n, "284.53 + marker 17 -> 284.5317");
  eq(payableUnits(28453n, 6, 0), 284_530_000n, "marker 0 leaves the figure round");
  eq(payableUnits(100n, 6, 99), 1_009_900n, "$1.00 + marker 99");

  // The marker is under the cent: it never changes the printed price.
  for (const marker of [0, 1, 50, 99]) {
    const units = payableUnits(28453n, 6, marker);
    eq(units / 10_000n, 28453n, `marker ${marker} must not disturb the cents`);
  }

  // Two different markers are two different amounts. That is the whole point:
  // it is what lets the C3 watcher tell two open tables apart.
  const seen = new Set<string>();
  for (let m = 0; m < 100; m++) seen.add(payableUnits(28453n, 6, m).toString());
  eq(seen.size, 100, "100 markers must give 100 distinct amounts");

  // A token too coarse to carry a marker gets the round figure, not a mangled
  // one. No such token is on the rails today; the guard is for the day one is.
  eq(payableUnits(28453n, 2, 17), 28453n, "2 decimals: no room under the cent");

  let threw = false;
  try { payableUnits(1n, 6, 100); } catch { threw = true; }
  check(threw, "a marker out of range must throw rather than overflow into cents");
}

group("markers stay in range");
{
  for (const r of [0, 0.999999, 0.5]) eq(newMarker(() => r) < 100, true, `marker for ${r}`);
  eq(newMarker(() => 0), 0, "lowest marker");
  eq(newMarker(() => 0.999999), 99, "highest marker");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
