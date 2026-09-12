/**
 * The payroll plan and the run.
 *
 * Three properties, in the order they matter:
 *
 *  1. **The calldata pays the person on the row.** Every proposal's `to` is the
 *     TOKEN CONTRACT and the recipient is inside the calldata — the mistake in
 *     the other direction sends nothing to the token and everything to nobody.
 *     The bytes are compared against core's own encoder, which is the one the
 *     device's decoder mirrors.
 *  2. **The total is the sum of the rows**, computed here rather than read from
 *     anywhere, because the total is what a person approves.
 *  3. **A "no" stops the run.** Not "is recorded and the next eleven are
 *     proposed anyway": a decline usually means somebody read the device screen
 *     and disagreed with it.
 */

import { encodeErc20Transfer } from "@leekwallet/core/balances.ts";
import type { AppProposal, ProposalOutcome } from "@leekwallet/core/app-proposal.ts";
import { screenProposal } from "@leekwallet/core/app-proposal.ts";
import {
  PAYROLL_CSV_TEMPLATE, PAYROLL_TOKENS, payrollDeployment, planPayroll, runPayroll,
} from "../src/payroll.ts";
import { importStaffCsv } from "../src/staff.ts";
import { staffFromFields, type StaffMember } from "../src/staff.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);
/** JSON.stringify cannot serialise a bigint, and every figure here is one. */
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}` : x));

const BASE_SEPOLIA = 84532;
const ARC = 5042002;
const MERCHANT = "0x7a3f1B2C4d5e6f708192A3B4c5D6E7F809a1b2c3";
const ANA = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const BEN = "0x388C818CA8B9251b393131C08a736A67ccB19297";

const person = (address: string, salary: string, name = "Ana", tips = ""): StaffMember => {
  const made = staffFromFields({ name, role: "waiter", address, salary, tips });
  if (!made.ok) throw new Error(`fixture is invalid: ${made.reason}`);
  return made.member;
};

group("a token has to have a deployment and decimals, or nobody is paid");
{
  const usdc = payrollDeployment(BASE_SEPOLIA, "USDC");
  check(usdc.ok && usdc.decimals === 6, "USDC on Base Sepolia");
  // EURC is on four of the nine; a chain without it says so rather than
  // borrowing USDC's address by analogy.
  check(!payrollDeployment(80002, "EURC").ok, "EURC on Polygon Amoy is not a thing");
  // cirBTC — Circle Wrapped Bitcoin, 8 decimals, and NOT cbBTC.
  const cir = payrollDeployment(ARC, "cirBTC");
  check(cir.ok && cir.decimals === 8, `cirBTC on Arc: ${show(cir)}`);
  check(!payrollDeployment(BASE_SEPOLIA, "cirBTC").ok, "cirBTC on Base Sepolia is not verified");
  eq(PAYROLL_TOKENS.join(), "USDC,EURC,cirBTC", "the three tokens");
}

group("the plan pays the token contract, and the person inside the calldata");
{
  const planned = planPayroll([person(ANA, "500"), person(BEN, "1250.5", "Ben")],
    BASE_SEPOLIA, "USDC", MERCHANT);
  check(planned.ok, `the plan should build: ${show(planned)}`);
  if (!planned.ok) throw new Error("no plan");
  const { plan } = planned;

  const usdc = payrollDeployment(BASE_SEPOLIA, "USDC");
  if (usdc.ok) eq(plan.contract, usdc.address, "the contract is the token");
  for (const payment of plan.payments) {
    eq(payment.contract, plan.contract, "every payment goes to the token contract");
    /* The recipient is in the calldata and nowhere else. A proposal whose `to`
     * were the recipient would be a native transfer with a data blob attached
     * — and the descriptor gate would refuse it, but far better that it never
     * gets built. */
    check(payment.data.slice(0, 10) === "0xa9059cbb", "the selector is transfer(address,uint256)");
    check(payment.data.toLowerCase().includes(payment.member.address.slice(2).toLowerCase()),
      "the recipient is in the calldata");
    eq(payment.data, encodeErc20Transfer(payment.member.address, payment.units),
      "the bytes are core's encoding, which is what the device decodes");
    eq(payment.data.length, 2 + 8 + 64 * 2, "68 bytes exactly, or the firmware refuses it");
  }
  eq(plan.payments[0]?.units, 500_000_000n, "500 USDC in units");
  eq(plan.payments[1]?.units, 1_250_500_000n, "1250.5 USDC in units");
  eq(plan.totalUnits, 1_750_500_000n, "the total is the sum of the rows");
  eq(plan.total.scaled?.text, "1750.5", "and it scales exactly");
  eq(plan.total.scaled?.verified, false, "a scaled figure is never claimed as verified");
  check((plan.total.scaled?.notice ?? "").length > 0, "and it carries the notice");
  eq(plan.total.rawText, "1750500000", "the raw units are always available");
}

group("a row the token cannot express refuses the whole run");
{
  /* 0.0000001 is payable in cirBTC (8 decimals) and not in USDC (6). The
     refusal names the row, and no plan comes back with the other rows in it —
     a total over a subset is a total the user did not choose. */
  const staff = [person(ANA, "500"), person(BEN, "0.0000001", "Ben")];
  const usdc = planPayroll(staff, BASE_SEPOLIA, "USDC", MERCHANT);
  check(!usdc.ok, "a row with too many decimal places must fail the run");
  check(!usdc.ok && /Ben/.test(usdc.reason), `and name the person: ${show(usdc)}`);
  check(!("plan" in usdc), "a refusal carries no partial plan");

  const cir = planPayroll(staff, ARC, "cirBTC", MERCHANT);
  check(cir.ok, "the same rows are payable in an 8-decimal token");
  if (cir.ok) eq(cir.plan.payments[1]?.units, 10n, "0.0000001 cirBTC is 10 units");
}

group("a payroll does not pay itself, and an empty one is not a run");
{
  const self = planPayroll([person(MERCHANT, "500")], BASE_SEPOLIA, "USDC", MERCHANT);
  check(!self.ok, "a row paying the payer is refused");
  const cased = planPayroll([person(MERCHANT.toLowerCase(), "500")], BASE_SEPOLIA, "USDC", MERCHANT);
  check(!cased.ok, "and case is not a way around it");
  check(!planPayroll([], BASE_SEPOLIA, "USDC", MERCHANT).ok, "nobody on the payroll is not a run");
  check(!planPayroll([person(ANA, "1")], 80002, "EURC", MERCHANT).ok,
    "a token with no deployment on this chain is not a run");
}

group("the run proposes one transfer per person, in order");
{
  const planned = planPayroll([person(ANA, "500"), person(BEN, "20", "Ben")],
    BASE_SEPOLIA, "USDC", MERCHANT);
  if (!planned.ok) throw new Error("no plan");
  const seen: AppProposal[] = [];
  const progress: number[] = [];
  const final = await runPayroll(planned.plan, async (proposal) => {
    seen.push(proposal);
    return { ok: true, kind: "call", result: `0x${"ab".repeat(32)}` } as ProposalOutcome;
  }, (p) => progress.push(p.states.filter((s) => s.kind === "sent").length));

  eq(seen.length, 2, "one proposal per person");
  for (const proposal of seen) {
    eq(proposal.kind, "call", "every proposal is a call");
    // An app supplies no `from` and no `chainId`; the shell stamps both
    // (app-proposal.ts). A proposal carrying either would be this app choosing
    // whose money moves.
    check(!("from" in proposal) && !("chainId" in proposal),
      "a proposal must not carry a signer or a chain");
    check(proposal.reason.length > 0 && proposal.reason.length <= 120,
      `the reason must fit the log: ${proposal.reason.length}`);
  }
  eq(final.states.filter((s) => s.kind === "sent").length, 2, "both sent");
  eq(final.done, true, "the run reports itself done");
  check(progress.length >= 4, "progress is reported as it goes, not only at the end");
}

group("every proposal this app can build survives the wallet's own gate");
{
  /* The check that makes the rest of this file worth anything. An app may only
   * propose a payload the wallet can DESCRIBE: `screenProposal` demands an
   * ERC-7730 descriptor that matches the chain, the contract and the selector,
   * renders every argument, and does not disagree with the decoder that
   * mirrors the firmware. A payroll whose proposals were all refused at that
   * gate would look perfect here and do nothing at all on a device.
   *
   * cirBTC is the one that would have failed: core described USDC and EURC and
   * not it, so this is also the assertion that the descriptor added alongside
   * them is really in DEFAULT_DESCRIPTORS. */
  const cases: [number, "USDC" | "EURC" | "cirBTC"][] =
    [[BASE_SEPOLIA, "USDC"], [BASE_SEPOLIA, "EURC"], [ARC, "USDC"], [ARC, "cirBTC"], [11155111, "cirBTC"]];
  for (const [chainId, token] of cases) {
    const planned = planPayroll([person(ANA, "12.5")], chainId, token, MERCHANT);
    check(planned.ok, `${token} on ${chainId} should plan: ${show(planned)}`);
    if (!planned.ok) continue;
    const payment = planned.plan.payments[0];
    if (payment === undefined) continue;
    const screened = screenProposal(
      { kind: "call", to: payment.contract, data: payment.data, reason: "Payroll 1/1: waiter Ana" },
      { chainId, from: MERCHANT },
    );
    check(screened.kind === "ok",
      `${token} on ${chainId} was refused by the gate: ${screened.kind === "refused" ? screened.why : ""}`);
    if (screened.kind !== "ok" || screened.screened.kind !== "call") continue;
    /* And the description a person will read is of the row: the recipient, and
     * an amount scaled by the token's own decimals rather than guessed. */
    const fields = screened.screened.descriptor?.fields ?? [];
    const rendered = fields.map((f) => `${f.label}: ${f.value}`).join(" | ");
    check(rendered.toLowerCase().includes(ANA.slice(2, 12).toLowerCase()),
      `the descriptor should name the recipient: ${rendered}`);
    check(/12\.5/.test(rendered), `the descriptor should render the amount: ${rendered}`);
  }
}

group("a decline stops the run where it stood");
{
  const planned = planPayroll([person(ANA, "1"), person(BEN, "2", "Ben")],
    BASE_SEPOLIA, "USDC", MERCHANT);
  if (!planned.ok) throw new Error("no plan");
  let calls = 0;
  const final = await runPayroll(planned.plan, async () => {
    calls++;
    return { ok: false, text: "The wallet declined this request." } as ProposalOutcome;
  }, () => {});
  eq(calls, 1, "the second person is never proposed after a refusal");
  eq(final.states[0]?.kind, "declined", "the first is marked declined");
  eq(final.states[1]?.kind, "waiting", "and the second is still waiting, not failed");
}

group("a thrown error stops the run and is not a payment");
{
  const planned = planPayroll([person(ANA, "1"), person(BEN, "2", "Ben")],
    BASE_SEPOLIA, "USDC", MERCHANT);
  if (!planned.ok) throw new Error("no plan");
  let calls = 0;
  const final = await runPayroll(planned.plan, async () => {
    calls++;
    throw new Error("the device went away");
  }, () => {});
  eq(calls, 1, "one attempt");
  eq(final.states[0]?.kind, "failed", "a throw is a failure");
  check(final.states.every((s) => s.kind !== "sent"), "and nothing is claimed as sent");
}

group("an answer that is not a transaction is not treated as one");
{
  /* A typed-data outcome in reply to a call proposal would mean the shell
     signed something other than what was asked for. Recording that as a sent
     payment would be this app inventing a receipt. */
  const planned = planPayroll([person(ANA, "1")], BASE_SEPOLIA, "USDC", MERCHANT);
  if (!planned.ok) throw new Error("no plan");
  const final = await runPayroll(planned.plan, async () =>
    ({ ok: true, kind: "typed-data", signature: "0xdead" }) as ProposalOutcome, () => {});
  eq(final.states[0]?.kind, "failed", "a typed-data answer is not a payment");
}

group("the CSV template the app hands out actually imports");
{
  /* The first version of this template used the zero address and was refused
   * by our own parser ("the zero address cannot be paid") — a template nobody
   * could use, handed out by a button. The constant is imported here rather
   * than eyeballed so that can never be true again. */
  const parsed = importStaffCsv(PAYROLL_CSV_TEMPLATE);
  check(parsed.ok === true,
    `the template does not import: ${parsed.ok ? "" : parsed.reason}`);
  check(parsed.ok && parsed.staff.length === 2,
    "the template should carry exactly two example rows");

  /* The header is the part that must be exact; the rows are meant to be
   * replaced. If the parser's expected columns ever change, this fails here
   * rather than in somebody's payroll. */
  check(PAYROLL_CSV_TEMPLATE.startsWith("name,role,address,salary,tips\n"),
    "the template header is not the one the parser expects");

  /* A zero tip must be allowed: it means the second transaction is simply not
   * built, not that the row is invalid. */
  check(parsed.ok && parsed.staff[1]?.tips === undefined,
    "a zero tip should leave no tips leg on the row");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);

process.exit(failures === 0 ? 0 : 1);
