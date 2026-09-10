/**
 * What the payroll screen says, and what it refuses to say.
 *
 * The assertions are about words rather than about a DOM, because the failure
 * being defended against is a person approving something they misread. Three
 * of them are load-bearing:
 *
 *   - the total is present, is the sum, and never appears without the notice
 *     that says nobody verified the token's decimals;
 *   - every row shows the ADDRESS as well as the name, because the name is
 *     host-side text out of a file and the address is what the device will
 *     draw;
 *   - a refusal from the parser or the planner replaces the total instead of
 *     sitting beside a stale one.
 *
 * The mount is exercised too, with a context that has no `propose` — the
 * no-device case, which must be a sentence rather than a screen full of
 * controls that lead nowhere.
 */

import { TILL_PAYROLL_APP, duplicateNotice, payrollView, type PayrollState } from "../src/payroll-view.ts";
import { importStaffCsv, staffFromFields, type StaffMember } from "../src/staff.ts";

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

const person = (address: string, salary: string, name = "Ana", tips = ""): StaffMember => {
  const made = staffFromFields({ name, role: "waiter", address, salary, tips });
  if (!made.ok) throw new Error(made.reason);
  return made.member;
};
const state = (staff: StaffMember[], over: Partial<PayrollState> = {}): PayrollState => ({
  staff, token: "USDC", chainId: BASE_SEPOLIA, from: MERCHANT,
  progress: undefined, running: false, ...over,
});

group("the total is the prominent figure, and it carries its caveat");
{
  const view = payrollView(state([person(ANA, "500"), person(BEN, "1250.5", "Ben")]));
  eq(view.count, 2, "two people");
  eq(view.totalText, "1750.5 USDC", "the total");
  eq(view.totalRawText, "1750500000", "and its raw units, which are the only fact");
  eq(view.problem, undefined, "no problem");
  check(view.armable, "a plannable payroll can be armed");
  check(view.notices.some((n) => /not.*checked|unverified|guess/i.test(n)),
    `the decimals notice must be on the screen: ${view.notices.join(" / ")}`);
}

group("a row shows the address, not just the name");
{
  const view = payrollView(state([person(ANA, "500")]));
  const row = view.rows[0];
  eq(row?.address, ANA, "the address is on the row");
  eq(row?.salaryText, "500 USDC", "the salary");
  check(view.notices.some((n) => /ADDRESS/.test(n)),
    "the screen must say the device shows the address rather than the name");
}

group("a label out of a file is never presented as attested");
{
  /* The name and role are whatever the file said. The view must carry them as
   * text beside an address and nothing more — no formatting that would read as
   * a verified identity, and no row where the name replaces the address. */
  const view = payrollView(state([person(ANA, "1", "Circle Treasury")]));
  eq(view.rows[0]?.name, "Circle Treasury", "the label is shown as given");
  eq(view.rows[0]?.address, ANA, "beside the address, always");
}

group("a problem replaces the total instead of standing beside it");
{
  // 7 decimal places in a 6-decimal token: plannable in cirBTC, not here.
  const view = payrollView(state([person(ANA, "0.0000001")]));
  eq(view.totalText, "", "no total when there is no plan");
  check(view.problem !== undefined && /Ana/.test(view.problem), `the problem names the row: ${view.problem}`);
  check(!view.armable, "and nothing can be armed");
  // The rows are still listed, so the person can see what they loaded.
  eq(view.rows.length, 1, "the rows stay on screen");
}

group("a confirmed duplicate is counted out loud");
{
  const csv = [
    "name,role,address,amount",
    `Ana,waiter,${ANA},1`,
    `Ben,chef,${BEN},2`,
    `Ana,waiter,${ANA},3`,
  ].join("\n");
  const imported = importStaffCsv(csv, { allowDuplicates: true });
  check(imported.ok, "the confirmed import succeeds");
  if (imported.ok) {
    const view = payrollView(state([...imported.staff]));
    check(view.notices.some((n) => /paid more than\s+once/.test(n)),
      `the duplicate notice must be first: ${view.notices[0]}`);
    check(duplicateNotice(imported.duplicates).includes("1 recipient"),
      "and it says how many");
    eq(view.totalText, "6 USDC", "the total counts both payments to the same address");
  }
}

group("a run in progress is reported per row, and never as more than it is");
{
  const staff = [person(ANA, "1"), person(BEN, "2", "Ben")];
  const view = payrollView(state(staff, {
    running: true,
    progress: {
      states: [{ kind: "sent", result: "0xabcdef0123456789" }, { kind: "proposed" }],
      active: 1,
      done: false,
    },
  }));
  check(/^sent/.test(view.rows[0]?.salaryState ?? ""), `the first row: ${view.rows[0]?.salaryState}`);
  /* "sent", never "paid". This app proposes and reports a hash; it does not
   * watch for inclusion, and the cashier's side has a whole module about the
   * difference. */
  check(!/paid/i.test(view.rows.map((r) => `${r.salaryState} ${r.tipsState}`).join(" ")),
    "no row may claim to be paid");
  check(!view.armable, "a run under way cannot be armed again");
}

group("a finished run cannot be started again over the same rows");
{
  /* Pressing send twice is the cheapest way to pay everybody twice, and since
     a run is not atomic, "it stopped half way" and "it finished" look alike on
     a screen. The view says so, and the mount refuses — clearing the payroll
     is the deliberate act that makes a second run possible. */
  const staff = [person(ANA, "1")];
  const after = payrollView(state(staff, {
    progress: { states: [{ kind: "sent", result: "0xabc" }], active: -1, done: true },
  }));
  check(!after.armable, "a completed run leaves nothing armable");
  check(payrollView(state(staff)).armable, "and a fresh registry is armable");
}

group("with no device, the app says so instead of drawing a payroll");
{
  /* A minimal DOM: enough to record what was appended and what listeners were
   * attached, so "there is nothing to press" is checked rather than assumed. */
  interface Node {
    tagName: string; className: string; children: Node[]; listeners: string[];
    textContent: string; value: string; type: string; accept: string; checked: boolean;
    placeholder: string; files: undefined;
    append(...kids: (Node | string)[]): void;
    replaceChildren(...kids: Node[]): void;
    addEventListener(event: string, fn: () => void): void;
    setAttribute(key: string, value: string): void;
  }
  const nodes: Node[] = [];
  const makeNode = (tagName: string): Node => {
    const node: Node = {
      tagName, className: "", children: [], listeners: [], textContent: "", value: "",
      type: "", accept: "", checked: false, placeholder: "", files: undefined,
      append(...kids) { for (const k of kids) if (typeof k !== "string") node.children.push(k); },
      replaceChildren(...kids) { node.children = kids; },
      addEventListener(event) { node.listeners.push(event); },
      setAttribute() {},
    };
    nodes.push(node);
    return node;
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => text,
  };

  let requests = 0;
  const root = makeNode("div");
  await TILL_PAYROLL_APP.mount(root as unknown as HTMLElement, {
    chainId: BASE_SEPOLIA,
    address: MERCHANT,
    request: async (method: string) => { requests++; throw new Error(method); },
  } as never);

  const text = nodes.map((n) => n.textContent).join(" ");
  check(/device/i.test(text), `the refusal must name the device: ${text.slice(0, 120)}`);
  eq(nodes.filter((n) => n.tagName === "input").length, 0, "no inputs are drawn without a device");
  eq(nodes.filter((n) => n.tagName === "button").length, 0, "and no buttons");
  eq(requests, 0, "and nothing is read from a chain");
}

group("with a device, the screen is drawn and still reads nothing from a chain");
{
  let requests = 0;
  const nodes: { tagName: string; listeners: [string, () => void][]; value: string; textContent: string }[] = [];
  const makeNode = (tagName: string) => {
    const node = {
      tagName, className: "", children: [] as unknown[], listeners: [] as [string, () => void][],
      textContent: "", value: "", type: "", accept: "", checked: false, placeholder: "",
      files: undefined,
      append(...kids: unknown[]) { for (const k of kids) if (typeof k !== "string") node.children.push(k); },
      replaceChildren(...kids: unknown[]) { node.children = kids; },
      addEventListener(event: string, fn: () => void) { node.listeners.push([event, fn]); },
      setAttribute() {},
    };
    nodes.push(node);
    return node;
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => text,
  };

  let proposals = 0;
  const root = makeNode("div");
  await TILL_PAYROLL_APP.mount(root as unknown as HTMLElement, {
    chainId: BASE_SEPOLIA,
    address: MERCHANT,
    request: async (method: string) => { requests++; throw new Error(method); },
    propose: async () => { proposals++; return { ok: false, text: "The wallet declined this request." }; },
  } as never);

  /* Drive every listener with an empty registry: nothing may be proposed by
   * merely opening the screen or pressing things on an empty payroll. */
  for (const node of [...nodes]) {
    for (const [, fn] of node.listeners) fn();
  }
  eq(requests, 0, "the payroll screen reads nothing from a chain");
  eq(proposals, 0, "and proposes nothing until there is a payroll to send");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
