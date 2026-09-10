/**
 * Salary and tips as two transactions, end to end.
 *
 * staff.test.ts owns the parser rules for the two amount columns. This file
 * owns what the split is FOR, and each group is a property somebody would
 * notice the absence of:
 *
 *  1. **Two proposals per person, never one blended one.** The legs are
 *     separate calldata to the same recipient, in a fixed order, and the tips
 *     leg is absent — not zero — where there are no tips. A blended
 *     implementation would pass every other test in this package.
 *  2. **Three totals, and none of them is the other two.** A payroll with tips
 *     is two approvals of two kinds of money, and a screen showing only the sum
 *     asks for one approval covering both.
 *  3. **Per-leg outcomes.** "Ana: salary sent, tips declined" is a state the
 *     run can genuinely end in, and the view has to be able to say it. This is
 *     the one an accountant needs and the one a per-person state cannot hold.
 *  4. **The worked example in examples/ actually imports**, with the totals its
 *     README claims. A committed example that no longer loads is worse than no
 *     example, and this is the only thing that would notice.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planPayroll, runPayroll, type PayrollPlan } from "../src/payroll.ts";
import { importStaffCsv, staffFromFields, type StaffMember } from "../src/staff.ts";
import { payrollView, type PayrollState } from "../src/payroll-view.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const BASE_SEPOLIA = 84532;
const MERCHANT = "0x7a3f1B2C4d5e6f708192A3B4c5D6E7F809a1b2c3";
const ANA = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const BEN = "0x388C818CA8B9251b393131C08a736A67ccB19297";

const person = (address: string, salary: string, tips = "", name = "Ana"): StaffMember => {
  const made = staffFromFields({ name, role: "waiter", address, salary, tips });
  if (!made.ok) throw new Error(`fixture is invalid: ${made.reason}`);
  return made.member;
};
const plan = (staff: StaffMember[]): PayrollPlan => {
  const planned = planPayroll(staff, BASE_SEPOLIA, "USDC", MERCHANT);
  if (!planned.ok) throw new Error(`fixture will not plan: ${planned.reason}`);
  return planned.plan;
};
const state = (staff: StaffMember[], over: Partial<PayrollState> = {}): PayrollState => ({
  staff, token: "USDC", chainId: BASE_SEPOLIA, from: MERCHANT,
  progress: undefined, running: false, ...over,
});

group("a person with tips is two proposals, in order, never one for the sum");
{
  const p = plan([person(ANA, "1250.00", "162.50"), person(BEN, "1800", "0", "Ben")]);
  eq(p.payments.length, 3, "two salary legs and one tips leg");
  eq(p.payments.map((x) => x.leg).join(), "salary,tips,salary", "salary first, then that person's tips");
  eq(p.payments[0]?.units, 1250000000n, "Ana's salary");
  eq(p.payments[1]?.units, 162500000n, "Ana's tips, on their own");
  /* The blended figure must appear NOWHERE in the calldata. This is the
     assertion a "helpful" refactor that summed the legs would trip. */
  check(!p.payments.some((x) => x.units === 1412500000n), "no leg carries salary + tips");
  eq(p.payments[2]?.units, 1800000000n, "Ben's salary");
  eq(p.payments.filter((x) => x.memberIndex === 1).length, 1,
    "Ben has no tips leg, because he earned no tips");

  // Both legs pay the same person, through the token contract, as transfers.
  for (const payment of p.payments.slice(0, 2)) {
    eq(payment.contract, p.contract, "every leg is addressed to the token contract");
    check(payment.data.startsWith("0xa9059cbb"), `a leg proposed ${payment.data.slice(0, 10)}`);
    eq(payment.data.length, 138, "68 bytes of transfer calldata");
    check(payment.data.toLowerCase().includes(ANA.slice(2).toLowerCase()),
      "both of Ana's legs pay Ana");
  }
}

group("the reason line names the leg, so two proposals are never one line twice");
{
  const p = plan([person(ANA, "1250.00", "162.50")]);
  const reasons: string[] = [];
  await runPayroll(p, async (proposal) => {
    reasons.push(String((proposal as { reason?: string }).reason ?? ""));
    return { ok: true, kind: "call", result: "0x" + "11".repeat(32) };
  }, () => {});
  eq(reasons.length, 2, "two proposals");
  check(/salary/.test(reasons[0] ?? ""), `the first names salary: ${reasons[0]}`);
  check(/tips/.test(reasons[1] ?? ""), `the second names tips: ${reasons[1]}`);
  check(reasons[0] !== reasons[1], "and they are not the same string");
  for (const reason of reasons) {
    // app-proposal.ts refuses a reason longer than 120 characters.
    check(reason.length <= 120, `a reason of ${reason.length} characters`);
  }
}

group("three totals, and the sum is not offered in place of the parts");
{
  const p = plan([person(ANA, "1250.00", "162.50"), person(BEN, "1800", "40.25", "Ben")]);
  eq(p.totalSalaryUnits, 3050000000n, "salary total");
  eq(p.totalTipsUnits, 202750000n, "tips total");
  eq(p.totalUnits, 3252750000n, "and the grand total is the two added");
  check(p.totalUnits === p.totalSalaryUnits + p.totalTipsUnits, "the grand total is the sum");

  const view = payrollView(state([person(ANA, "1250.00", "162.50"), person(BEN, "1800", "40.25", "Ben")]));
  eq(view.salaryTotalText, "3050 USDC", "salary on screen");
  eq(view.tipsTotalText, "202.75 USDC", "tips on screen");
  eq(view.totalText, "3252.75 USDC", "the grand total on screen");
  eq(view.salaryTotalRawText, "3050000000", "and each carries its raw units, which are the fact");
  eq(view.tipsTotalRawText, "202750000", "tips raw units");
  eq(view.count, 2, "the head-count is people");
  eq(view.legCount, 4, "and the transaction count is legs, which is not the same number");
  /* Every figure still goes through the unverified-decimals treatment: there is
     no function here returning a bare pretty number, and adding one for a
     subtotal would be the back door. */
  check(view.notices.some((n) => /not.*checked|unverified|guess/i.test(n)),
    `the decimals notice must be on the screen: ${view.notices.join(" / ")}`);
  check(view.notices.some((n) => /SEPARATE|separately/.test(n)),
    "and the screen says the two are sent separately");
}

group("no tips means no tips figure on the row, not a zero");
{
  const view = payrollView(state([person(ANA, "1250.00")]));
  eq(view.rows[0]?.salaryText, "1250 USDC", "the salary");
  eq(view.rows[0]?.tipsText, "", "and no tips text at all — a zero would imply a transaction");
  eq(view.legCount, 1, "one leg");
  eq(view.tipsTotalText, "0 USDC", "the tips total is still stated, and it is zero");
}

group("salary sent, tips declined — the state an accountant needs");
{
  const staff = [person(ANA, "1250.00", "162.50"), person(BEN, "1800", "", "Ben")];
  const p = plan(staff);
  /* The device says yes to Ana's salary and no to her tips. The run stops
     there, so Ben is never proposed at all — a decline means somebody read a
     screen and disagreed with it, and marching on is how a wallet trains
     people to press without reading. */
  let n = 0;
  const progress = await runPayroll(p, async () => {
    n++;
    return n === 1
      ? { ok: true, kind: "call", result: "0x" + "ab".repeat(32) }
      : { ok: false, text: "The wallet declined this request." as const };
  }, () => {});
  eq(n, 2, "two proposals were made and the run stopped");
  eq(progress.states[0]?.kind, "sent", "Ana's salary");
  eq(progress.states[1]?.kind, "declined", "Ana's tips");
  eq(progress.states[2]?.kind, "waiting", "and Ben was never asked");

  const view = payrollView(state(staff, { progress, running: false }));
  const ana = view.rows[0];
  check(/^sent/.test(ana?.salaryState ?? ""), `Ana's salary reads sent: ${ana?.salaryState}`);
  check(/declined/.test(ana?.tipsState ?? ""), `Ana's tips read declined: ${ana?.tipsState}`);
  check(ana?.salaryState !== ana?.tipsState, "the two legs of one row are not one state");
  eq(view.rows[1]?.salaryState, "", "Ben's row shows nothing, because nothing happened to it");
  /* Neither leg may claim to be paid: a hash is a transaction accepted for
     broadcast, and this app does not watch for inclusion. */
  check(!/paid/i.test(view.rows.map((r) => `${r.salaryState} ${r.tipsState}`).join(" ")),
    "no leg may claim to be paid");
  check(!view.armable, "and a run that happened cannot be armed again");
}

group("a tips figure this token cannot express refuses the whole plan");
{
  /* Seven decimal places in a 6-decimal token. The salary is payable and the
     tips are not, and the answer is a refusal rather than a run whose salary
     legs go out and whose tips legs quietly do not. */
  const refused = planPayroll([person(ANA, "1250.00", "0.0000001")], BASE_SEPOLIA, "USDC", MERCHANT);
  check(!refused.ok, "a tips figure past the token's decimals must refuse the plan");
  if (!refused.ok) {
    check(/tips/.test(refused.reason), `and say it was the tips: ${refused.reason}`);
    check(/Ana/.test(refused.reason), `and whose: ${refused.reason}`);
  }
  // In a token that can hold it, the same row plans.
  const cir = planPayroll([person(ANA, "0.5", "0.0000001")], 5042002, "cirBTC", MERCHANT);
  check(cir.ok, "cirBTC has 8 decimals and can pay it");

  // The unplannable screen still shows both figures as written, not one.
  const view = payrollView(state([person(ANA, "1250.00", "0.0000001")]));
  eq(view.totalText, "", "no total when there is no plan");
  eq(view.rows[0]?.salaryText, "1250.00 USDC", "the salary as written");
  eq(view.rows[0]?.tipsText, "0.0000001 USDC", "and the tips as written, still separately");
}

group("the committed example file imports, and its totals are the ones it claims");
{
  const path = fileURLToPath(new URL("../examples/payroll-example.csv", import.meta.url));
  const imported = importStaffCsv(readFileSync(path, "utf8"));
  check(imported.ok, `the example must import: ${imported.ok ? "" : imported.reason}`);
  if (imported.ok) {
    eq(imported.staff.length, 6, "six people");
    eq(imported.staff.filter((m) => m.tips !== undefined).length, 4, "four of whom earned tips");
    const p = plan([...imported.staff]);
    eq(p.payments.length, 10, "ten transactions: six salary, four tips");
    eq(p.totalSalaryUnits, 8750000000n, "8,750.00 of salary");
    eq(p.totalTipsUnits, 556000000n, "556.00 of tips");
    eq(p.totalUnits, 9306000000n, "9,306.00 in total — the figure the README states");
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
