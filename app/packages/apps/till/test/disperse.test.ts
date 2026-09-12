/**
 * The disperse encoder, checked against the DEVICE's own decoder.
 *
 * Not against a second copy of the same arithmetic: `decodeCall` from core is
 * the mirror of `disperse_decode_token()` in src/eth-decode.c, held to it by 60
 * shared vectors. So a round trip here is evidence the bytes are what the
 * firmware will accept and draw — which is the only property that matters,
 * since a call the device refuses is a payroll that stops after the approval.
 */

import { CallKind, decodeCall } from "@leekwallet/core/eth-decode.ts";
import {
  DISPERSE, DISPERSE_MAX_RECIPIENTS, encodeDisperse, encodeDisperseApproval, planDisperse,
} from "../src/disperse.ts";
import { disperseFor, planPayroll } from "../src/payroll.ts";
import { staffFromFields } from "../src/staff.ts";
import { screenProposal } from "@leekwallet/core/app-proposal.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const group = (name: string): void => console.log(`== ${name}`);

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const A = "0xa17c4e2f9b0d3856c1e74af20b93d6851fc0a2e7";
const B = "0x4d8b91f3c027ae56d1904b7fe238ca6019b5d34c";
const bytesOf = (hex: string): Uint8Array =>
  new Uint8Array((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

group("the encoder produces what the device decodes");
{
  const call = encodeDisperse(TOKEN, [
    { to: A, units: 1_100_000n },
    { to: B, units: 2_500_000n },
  ], "Salaries");

  check(call.to === DISPERSE, `the call does not go to Disperse: ${call.to}`);
  check(call.value === 0n, "a token disperse must carry no native value");

  const d = decodeCall(bytesOf(call.data));
  check(d.kind === CallKind.DisperseToken, `the device would not read this: ${d.kind}`);
  check(d.disperse?.token === TOKEN, `token ${d.disperse?.token} != ${TOKEN}`);
  check(d.disperse?.legs.length === 2, `${d.disperse?.legs.length} legs, expected 2`);
  check(d.disperse?.legs[0]?.to === A, "leg 0 recipient is wrong");
  check(d.disperse?.legs[0]?.amount === 1_100_000n, "leg 0 amount is wrong");
  check(d.disperse?.legs[1]?.to === B, "leg 1 recipient is wrong");
  check(d.disperse?.legs[1]?.amount === 2_500_000n, "leg 1 amount is wrong");
}

group("it fits the device at the bound, and is refused past it");
{
  const legs = Array.from({ length: DISPERSE_MAX_RECIPIENTS }, (_, i) => ({
    to: A, units: BigInt(i + 1),
  }));
  const call = encodeDisperse(TOKEN, legs, "Salaries");
  const bytes = (call.data.length - 2) / 2;
  /* 164 + 64N. ETH_MAX_DATA is 768, so the bound is where it stops fitting. */
  check(bytes === 164 + 64 * DISPERSE_MAX_RECIPIENTS, `${bytes} bytes, expected ${164 + 64 * 9}`);
  check(bytes <= 768, `${bytes} bytes exceeds ETH_MAX_DATA`);
  check(decodeCall(bytesOf(call.data)).kind === CallKind.DisperseToken,
    "a full batch is not decodable by the device");

  let refused = false;
  try { encodeDisperse(TOKEN, [...legs, { to: B, units: 1n }], "Salaries"); }
  catch { refused = true; }
  check(refused, "a tenth recipient was encoded rather than refused");
}

group("salaries and tips are never merged");
{
  const plan = planDisperse(
    TOKEN,
    [{ to: A, units: 1_100_000n }, { to: B, units: 2_100_000n }],
    [{ to: A, units: 162_500n }],
  );
  check("approval" in plan, "a well-formed run was refused");
  if (!("approval" in plan)) throw new Error("unreachable");

  check(plan.salaries !== undefined && plan.tips !== undefined,
    "salaries and tips did not both produce a call");
  check(plan.salaries?.data !== plan.tips?.data,
    "salaries and tips produced the same transaction");

  /* Beto has no tips, so he is absent from the tips batch rather than present
   * with a zero: a zero transfer says a payment happened when none did. */
  const tips = decodeCall(bytesOf(plan.tips?.data ?? "0x"));
  check(tips.disperse?.legs.length === 1, "the tips batch carries a zero-value leg");
  check(tips.disperse?.legs[0]?.to === A, "the tips batch pays the wrong person");

  /* The approval is the real ceiling on what Disperse can take, so it must
   * cover both batches exactly and never more. */
  const approval = plan.approval;
  check(approval.to === TOKEN, "the approval is not against the token");
  check(plan.totalUnits === 1_100_000n + 2_100_000n + 162_500n, "the total is wrong");
  check(approval.data.endsWith((1_100_000n + 2_100_000n + 162_500n).toString(16).padStart(64, "0")),
    "the approval is not capped at exactly the batch total");
}

group("what it refuses");
{
  let threw = false;
  try { encodeDisperse(TOKEN, [], "Salaries"); } catch { threw = true; }
  check(threw, "an empty batch was encoded");

  threw = false;
  try { encodeDisperse(TOKEN, [{ to: A, units: 0n }], "Salaries"); } catch { threw = true; }
  check(threw, "a zero payment was encoded");

  threw = false;
  try { encodeDisperse(TOKEN, [{ to: "0xnope", units: 1n }], "Salaries"); } catch { threw = true; }
  check(threw, "a malformed address was encoded");

  threw = false;
  try { encodeDisperseApproval(TOKEN, 0n); } catch { threw = true; }
  check(threw, "an approval for nothing was encoded");

  const nothing = planDisperse(TOKEN, [], []);
  check("ok" in nothing && nothing.ok === false, "a run with no payments was planned");
}

group("the batch pays exactly what the per-payment route would");
{
  /* The two routes must never disagree about who is owed what. Built from the
   * same plan, so a divergence here is a bug in grouping, not in arithmetic. */
  const staff = [
    { line: 2, name: "Ana", role: "waiter", address: A,
      salary: { text: "1.10", scale: 2 }, tips: { text: "0.50", scale: 2 } },
    { line: 3, name: "Beto", role: "chef", address: B,
      salary: { text: "2.10", scale: 2 } },
  ] as never;
  /* A distinct payer: planPayroll refuses a payroll that pays its own payer,
   * and using a recipient as `from` refused the whole plan. */
  const PAYER = "0x9c77c6fafc1eb0821f1de12972ef0199c97c6e45";
  const planned = planPayroll(staff, 5042002, "USDC", PAYER);
  check(planned.ok === true,
    `the payroll did not plan: ${planned.ok ? "" : planned.reason}`);
  if (!planned.ok) throw new Error("unreachable");

  const batch = disperseFor(planned.plan);
  check("approval" in batch, "the batch was refused for a payroll of two");
  if (!("approval" in batch)) throw new Error("unreachable");

  const perPayment = planned.plan.payments.reduce((a, p) => a + p.units, 0n);
  check(batch.totalUnits === perPayment,
    `batch total ${batch.totalUnits} != per-payment total ${perPayment}`);

  const sal = decodeCall(bytesOf(batch.salaries?.data ?? "0x"));
  const tip = decodeCall(bytesOf(batch.tips?.data ?? "0x"));
  check(sal.disperse?.legs.length === 2, "both salaries are not in the batch");
  check(tip.disperse?.legs.length === 1, "the tips batch is not just the one who earned them");
  check(tip.disperse?.legs[0]?.to === A, "the tips went to the wrong person");
}

{
  /* THE PROPERTY: every call the batched run proposes survives the gate.
   *
   * This is the test that was missing. The encoders were covered and the
   * decode round trip was covered, but nothing screened a proposal built the
   * way the view builds it — and the view passed `label` where the gate reads
   * `reason`, so every batched run died at the approval with "the app gave no
   * reason for the request" and the device was never asked. An `as never` cast
   * at the call site is what hid it from the compiler.
   *
   * So this walks the same three steps runBatched walks, in the same order,
   * proposing the same shape, and insists the gate says yes to all of them. */
  console.log("\n== every batched proposal passes the app gate");

  const staff = [
    { name: "Ana Diaz", role: "waiter", address: A, salary: 1_100_000n, tips: 1_100_000n },
    { name: "Beto Ruiz", role: "chef", address: B, salary: 1_100_000n, tips: 1_100_000n },
  ].map((m) => {
    const made = staffFromFields({
      name: m.name, role: m.role, address: m.address,
      salary: "1.1", tips: "1.1",
    });
    if (!made.ok) throw new Error(made.reason);
    return made.member;
  });

  const PAYER2 = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
  const planned = planPayroll(staff, 5042002, "USDC", PAYER2);
  check(planned.ok === true, "the two-person payroll did not plan");
  if (!planned.ok) throw new Error("unreachable");

  const built = disperseFor(planned.plan);
  check("approval" in built, "the batch was refused");
  if (!("approval" in built)) throw new Error("unreachable");

  const steps = [
    { what: "approval", call: built.approval },
    ...(built.salaries ? [{ what: "salaries", call: built.salaries }] : []),
    ...(built.tips ? [{ what: "tips", call: built.tips }] : []),
  ];
  check(steps.length === 3, `expected three confirmations, got ${steps.length}`);

  for (const step of steps) {
    /* The exact object literal runBatched sends. If those two drift apart this
     * test stops meaning anything, which is why it is written out in full
     * rather than imported from a shared helper. */
    const outcome = screenProposal(
      {
        kind: "call",
        to: step.call.to,
        data: step.call.data,
        value: step.call.value,
        reason: step.call.label,
      },
      { chainId: 5042002, from: PAYER2 },
    );
    check(outcome.kind === "ok",
      `the gate refused the ${step.what}: ` +
      `${outcome.kind === "refused" ? outcome.why : ""}`);
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
