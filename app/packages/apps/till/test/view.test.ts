/**
 * The view model, asserted as text, in node, with no DOM.
 *
 * Two properties are being defended and both are properties of the model
 * rather than of the CSS:
 *
 *  - an unpayable chain+token combination is `selectable: false` and carries a
 *    reason, so the button is disabled rather than offered and then refused;
 *  - nothing that is not a real, complete charge ever produces a URI. "No
 *    amount typed yet" and "EURC is not on this chain" are sentences, not an
 *    empty QR the waiter would hold up at a customer.
 */

import { tillView, type TillState } from "../src/view.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";
const state = (over: Partial<TillState> = {}): TillState => ({
  merchant: "Tacos del Parque",
  recipient: MERCHANT,
  base: 28453n,
  tip: { kind: "percent", percent: 15 },
  token: "USDC",
  chainId: 84532,
  marker: 17,
  ...over,
});

group("a priced bill");
{
  const view = tillView(state());
  eq(view.lines.length, 3, "bill, tip, total");
  eq(view.lines[0]?.value, "284.53 USDC", "bill");
  eq(view.lines[1]?.label, "Tip 15%", "the tip line names the rate the waiter chose");
  eq(view.lines[1]?.value, "42.68 USDC", "tip");
  eq(view.lines[2]?.value, "327.21 USDC", "total");
  check(view.charge.ok, "a complete bill charges");
  if (view.charge.ok) {
    eq(view.charge.unitsText, "327.2117", "the marker shows in the payable figure");
    check(view.charge.uri.startsWith("ethereum:0x036CbD"), view.charge.uri);
    check(view.charge.whatsapp.startsWith("https://wa.me/"), "a WhatsApp link, because that is how a bill travels");
  }
}

group("rails are cheapest first, and L1 is marked on a small bill");
{
  const view = tillView(state({ base: 1000n, tip: { kind: "percent", percent: 10 } }));
  eq(view.rails[0]?.chainId, 5042002, "Arc first");
  eq(view.rails.length, 9, "all nine offered as USDC");
  for (const rail of view.rails) check(rail.selectable, `USDC must be selectable on ${rail.name}`);
  const l1 = view.rails.find((r) => r.chainId === 11155111);
  check(l1?.warning !== undefined, "an $11 bill on L1 must be marked as costing more than a card");
  check(/49\.27/.test(l1?.warning ?? ""), "the warning must name the break-even it is derived from");
  const l2 = view.rails.find((r) => r.chainId === 84532);
  eq(l2?.warning, undefined, "an L2 is never worse than a card");

  const big = tillView(state({ base: 30000n }));
  eq(big.rails.find((r) => r.chainId === 11155111)?.warning, undefined, "a $300 bill on L1 is fine");
}

group("EURC on a chain without it is unselectable, not offered and then failed");
{
  const view = tillView(state({ token: "EURC", chainId: 80002 }));
  const amoy = view.rails.find((r) => r.chainId === 80002);
  eq(amoy?.selectable, false, "Polygon Amoy has no EURC");
  check(/not deployed/.test(amoy?.reason ?? ""), "and it says so");
  check(!view.charge.ok, "no URI may be produced for a combination that cannot receive it");

  const selectable = view.rails.filter((r) => r.selectable).map((r) => r.chainId).sort((a, b) => a - b);
  eq(selectable.join(","), "43113,84532,5042002,11155111".split(",").map(Number).sort((a, b) => a - b).join(","),
    "EURC is selectable on exactly four rails");

  const base = tillView(state({ token: "EURC", chainId: 84532 }));
  check(base.charge.ok, "EURC on Base Sepolia is payable");
}

group("an incomplete bill states itself and charges nothing");
{
  const empty = tillView(state({ base: null }));
  eq(empty.charge.ok, false, "nothing to charge");
  check(!empty.charge.ok && /Enter the bill total/.test(empty.charge.reason), "and it says what is missing");
  // The one substitution this codebase forbids: an absent amount rendering as
  // a figure. "waiting" is a sentence, not a zero.
  eq(empty.lines[0]?.value, "waiting for an amount", "no amount must not read as 0.00");
  eq(empty.lines[0]?.tone, "muted", "and it is toned differently from a real figure");

  const zero = tillView(state({ base: 0n, tip: { kind: "percent", percent: 0 } }));
  eq(zero.charge.ok, false, "a zero bill charges nothing");
  eq(zero.lines[2]?.value, "0.00 USDC", "but a real zero does print as one");

  const noAddress = tillView(state({ recipient: "" }));
  eq(noAddress.charge.ok, false, "no merchant address, no QR");
}

group("the notices say what the terminal is");
{
  const view = tillView(state());
  check(view.notices.some((n) => /holds no key/.test(n)), "the key claim is on the screen, not only in a comment");
  check(view.notices.some((n) => /marker, not a fee/.test(n)), "the odd sub-cent total is explained where it is seen");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
