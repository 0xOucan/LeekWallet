/**
 * The property the two-role split exists for: **a waiter cannot modify the
 * request.**
 *
 * Not "the amount field is disabled" — the waiter's app has no amount field and
 * no code that builds a request. This test refuses to take that on trust in two
 * independent ways, because either alone would rot:
 *
 *  1. **Structurally** — `waiter.ts` is read as text and must not import or name
 *     any of the constructors that make a request or a bill: `sealRequest`,
 *     `buildOrder`, `parseCents`, `tipCents`, `newMarker`. A future edit that
 *     brought one in fails here, at the line that brought it.
 *  2. **Behaviourally** — the app is mounted, handed a sealed request, and then
 *     attacked: every input on the screen is filled with hostile values and
 *     every listener is fired. The payable units and the recipient in the URI it
 *     renders afterwards must be byte-identical to the ones the cashier sealed.
 *
 * Plus the two milestone requirements that are properties of what is on screen:
 * every accepted chain is shown, and the prominent figure is the exact payable
 * amount with its marker.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { payableUnits } from "../src/order.ts";
import { sealRequest, type PaymentRequest } from "../src/request.ts";
import { TILL_WAITER_APP, waiterView } from "../src/waiter.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";
const CHAINS = [5042002, 84532, 11155420, 421614, 1301, 80002, 59141, 43113, 11155111];

const request: PaymentRequest = {
  merchant: "Tacos del Parque",
  recipient: MERCHANT,
  token: "USDC",
  total: 32721n,
  marker: 17,
  chains: CHAINS,
  issuedAt: 1_789_000_000,
};
const sealed = sealRequest(request);
/** What the cashier asked for, in raw units: 327.2117 USDC. */
const EXPECTED_UNITS = payableUnits(request.total, 6, request.marker);

group("the waiter's module cannot construct a request or a bill");
{
  const source = readFileSync(
    fileURLToPath(new URL("../src/waiter.ts", import.meta.url)), "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  for (const name of ["sealRequest", "buildOrder", "parseCents", "tipCents", "newMarker", "TIP_PRESETS"]) {
    check(!new RegExp(`\\b${name}\\b`).test(source),
      `waiter.ts names ${name} — the waiter's app must only ever parse a request`);
  }
}

group("every accepted chain is on the client-facing view, not only the shown one");
{
  const view = waiterView(sealed, 84532);
  check(view.chains.length === CHAINS.length,
    `the view shows ${view.chains.length} chains, the request accepts ${CHAINS.length}`);
  for (const id of CHAINS) {
    check(view.chains.some((c) => c.chainId === id), `chain ${id} is missing from the view`);
  }
  check(view.chains.filter((c) => c.showing).length === 1, "exactly one chain's QR is showing");
  /* USDC is on all nine, so all nine carry the figure. The point is that the
   * eight not showing are still on screen WITH their amount. */
  const withAmount = view.chains.filter((c) => c.payable && c.amountText.startsWith("327.2117"));
  check(withAmount.length === CHAINS.length, `only ${withAmount.length} chains print the payable figure`);
}

group("a token missing on a chain is shown as unpayable, never as a zero");
{
  const eurc = sealRequest({ ...request, token: "EURC" });
  const view = waiterView(eurc, 84532);
  const amoy = view.chains.find((c) => c.chainId === 80002);
  check(amoy !== undefined && !amoy.payable, "EURC on Polygon Amoy must not be payable");
  check(amoy?.reason !== undefined && /not deployed/.test(amoy.reason), "and it must say why");
  check(view.chains.filter((c) => c.payable).length === 4, "EURC is on four of the nine");
}

group("the prominent figure is the exact payable amount, marker included");
{
  const view = waiterView(sealed, 84532);
  check(view.headline === "327.2117 USDC", `headline is "${view.headline}"`);
  check(!view.headline.startsWith("327.21 "), "the headline rounded away the marker");
  check(view.uri !== undefined && view.uri.endsWith(`uint256=${EXPECTED_UNITS}`),
    `the URI does not carry the sealed units: ${view.uri}`);
}

/* -------------------------------------------------------------- the attack */

interface Node {
  tagName: string; className: string; children: Node[]; listeners: [string, () => void][];
  textContent: string; value: string; disabled: boolean; href: string;
  attributes: Record<string, string>;
  append(...kids: Node[]): void;
  replaceChildren(...kids: Node[]): void;
  appendChild(kid: Node): void;
  addEventListener(event: string, fn: () => void): void;
  dispatchEvent(event: unknown): void;
  setAttribute(key: string, value: string): void;
  classList: { add(): void };
}
const nodes: Node[] = [];
const makeNode = (tagName: string): Node => {
  const node: Node = {
    tagName, className: "", children: [], listeners: [], textContent: "", value: "",
    disabled: false, href: "", attributes: {},
    append(...kids) { node.children.push(...kids); },
    replaceChildren(...kids) { node.children = kids; },
    appendChild(kid) { node.children.push(kid); },
    addEventListener(event, fn) { node.listeners.push([event, fn]); },
    dispatchEvent() { for (const [, fn] of [...node.listeners]) fn(); },
    setAttribute(key, value) { node.attributes[key] = value; },
    classList: { add() {} },
  };
  nodes.push(node);
  return node;
};
(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => makeNode(tag),
  createElementNS: (_ns: string, tag: string) => makeNode(tag),
};

const context = {
  chainId: 84532,
  address: MERCHANT,
  request: async (r: { method: string }) => {
    throw new Error(`the waiter terminal must not call ${r.method} in this test`);
  },
};

const root = makeNode("div");
await TILL_WAITER_APP.mount(root as unknown as HTMLElement, context as never);

const scanner = () => nodes.find((n) => n.attributes["aria-label"] === "Scan the cashier's request");

group("the only input on the waiter's screen is the scanner");
{
  const inputs = nodes.filter((n) => n.tagName === "input" || n.tagName === "select");
  check(inputs.length === 1, `the waiter's screen has ${inputs.length} inputs; it must have one`);
  check(inputs[0]?.attributes["aria-label"] === "Scan the cashier's request",
    "the single input is not the scanner");
}

/** Fire the scanner's listeners with `text` in the box. */
const scan = (text: string) => {
  const input = scanner() as Node;
  input.value = text;
  for (const [, fn] of input.listeners) fn();
};

group("a request naming another address is refused outright");
{
  const elsewhere = sealRequest({ ...request, recipient: "0x00112233445566778899aabbccddeeff00112233" });
  scan(elsewhere.text);
  const shown = nodes.filter((n) => n.className === "till-amount").map((n) => n.textContent);
  check(shown.length === 0, `a refused request still rendered: ${shown.join(" / ")}`);
  const errors = nodes.filter((n) => n.className === "till-error").map((n) => n.textContent);
  check(errors.some((t) => /not this restaurant's address/.test(t)),
    `no refusal was shown: ${errors.join(" / ")}`);
}

group("the waiter cannot alter the amount or the recipient of a genuine request");
{
  scan(sealed.text);
  const before = nodes.filter((n) => n.className === "till-amount").map((n) => n.textContent);
  check(before.length === 1, `expected one payable line, got ${before.length}`);
  check(before[0] === `327.2117 USDC to ${sealed.request.recipient}`, `rendered "${before[0]}"`);

  /* The attack. Every control the mounted app rendered gets hostile content and
   * every listener on it is fired.
   *
   * The listener set is snapshotted ONCE, before the first shot: firing a
   * listener redraws, a redraw builds new nodes with new listeners, and
   * re-collecting them each round makes the harness grow faster than it
   * attacks. A fixed snapshot is also the more faithful attack — it is the
   * controls a waiter can actually see and press. */
  const attackable = nodes
    .filter((n) => n.attributes["aria-label"] !== "Scan the cashier's request")
    .flatMap((n) => n.listeners.map(([, fn]) => [n, fn] as const));
  const hostile = ["0.01", "999999", "0x00112233445566778899aabbccddeeff00112233", "EURC", ""];
  for (const value of hostile) {
    for (const [node, fn] of attackable) {
      if (node.tagName === "input" || node.tagName === "select") node.value = value;
      fn();
    }
  }

  const after = nodes.filter((n) => n.className === "till-amount").map((n) => n.textContent);
  check(after.length > 0, "the bill vanished under the attack");
  for (const line of after) {
    check(line === `327.2117 USDC to ${sealed.request.recipient}`,
      `the payable line changed to "${line}"`);
  }
  /* And in the machine-readable half: every URI the screen now carries must
   * still pay the sealed units to the sealed address. */
  const uris = nodes.flatMap((n) => (n.tagName === "a" ? [n.href] : []))
    .concat(nodes.filter((n) => n.className === "till-uri").map((n) => n.textContent));
  for (const uri of uris) {
    if (!uri.includes("uint256=")) continue;
    check(uri.includes(`uint256=${EXPECTED_UNITS}`), `a rendered URI carries other units: ${uri}`);
    check(uri.toLowerCase().includes(`address=${MERCHANT.slice(2)}`.toLowerCase()),
      `a rendered URI pays somewhere else: ${uri}`);
  }
}

group("switching the chain shown changes the chain and nothing else");
{
  const chainButtons = nodes.filter((n) => n.className.startsWith("till-rail") && n.listeners.length > 0);
  check(chainButtons.length > 1, "the waiter must be able to show another chain's code");
  for (const [, fn] of chainButtons[chainButtons.length - 1]?.listeners ?? []) fn();
  const after = nodes.filter((n) => n.className === "till-amount").map((n) => n.textContent);
  for (const line of after) {
    check(line === `327.2117 USDC to ${sealed.request.recipient}`,
      `showing another chain changed the bill: "${line}"`);
  }
}

/* ------------------------------------------------- the silent-failure cases
 *
 * Both of these were real: the waiter pressed scan, the code was genuine, and
 * the screen said nothing at all. A refusal nobody can read is a bug even when
 * the refusal itself is correct. */

(globalThis as Record<string, unknown>).Event = class FakeEvent { type = ""; };

group("a terminal with no merchant address says so before anything is scanned");
{
  const from = nodes.length;
  const blank = makeNode("div");
  await TILL_WAITER_APP.mount(blank as unknown as HTMLElement,
    { ...context, address: "" } as never);
  const errors = nodes.slice(from).filter((n) => n.className === "till-error")
    .map((n) => n.textContent);
  check(errors.some((t) => /no merchant address/.test(t)),
    `a terminal with no address stayed silent: ${JSON.stringify(errors)}`);

  /* And a genuine request scanned into it is still refused — visibly. The
     refusal is the security property; only the silence was the bug. */
  const input = nodes.slice(from).find((n) => n.attributes["aria-label"] === "Scan the cashier's request") as Node;
  input.value = sealed.text;
  for (const [, fn] of input.listeners) fn();
  const after = nodes.slice(from).filter((n) => n.className === "till-error").map((n) => n.textContent);
  check(after.some((t) => t !== ""), "the refusal was not shown");
  check(nodes.slice(from).filter((n) => n.className === "till-amount").length === 0,
    "a request was displayed by a terminal with no address to check it against");
}

group("a camera code the terminal refuses is reported, not swallowed");
{
  const from = nodes.length;
  const elsewhere = sealRequest({ ...request, recipient: "0x00112233445566778899aabbccddeeff00112233" });
  let offered: ((raw: string) => unknown) | undefined;
  const camRoot = makeNode("div");
  await TILL_WAITER_APP.mount(camRoot as unknown as HTMLElement, {
    ...context,
    scanQr: (accept: (raw: string) => unknown) => {
      offered = accept;
      /* What the shell's loop does: hand the decoded text to `accept` and
         resolve with whatever it returns. */
      return Promise.resolve(accept(elsewhere.text) ?? null);
    },
  } as never);
  const button = nodes.slice(from).find((n) => n.tagName === "button" && n.textContent === "Scan with camera");
  check(button !== undefined, "the camera button is missing when the shell offers a camera");
  for (const [, fn] of button?.listeners ?? []) fn();
  await Promise.resolve();
  await Promise.resolve();
  check(offered?.(elsewhere.text) !== undefined,
    "the scan loop still rejects a decodable request, so it would never stop scanning");
  const errors = nodes.slice(from).filter((n) => n.className === "till-error").map((n) => n.textContent);
  check(errors.some((t) => /not this restaurant's address/.test(t)),
    `a camera-scanned refusal was swallowed: ${JSON.stringify(errors)}`);
  check(nodes.slice(from).filter((n) => n.className === "till-amount").length === 0,
    "a request paying somebody else reached the screen");
}

group("a camera that closes with nothing says so");
{
  const from = nodes.length;
  const quietRoot = makeNode("div");
  await TILL_WAITER_APP.mount(quietRoot as unknown as HTMLElement,
    { ...context, scanQr: () => Promise.resolve(null) } as never);
  const button = nodes.slice(from).find((n) => n.tagName === "button" && n.textContent === "Scan with camera");
  for (const [, fn] of button?.listeners ?? []) fn();
  await Promise.resolve();
  await Promise.resolve();
  const errors = nodes.slice(from).filter((n) => n.className === "till-error").map((n) => n.textContent);
  check(errors.some((t) => /camera closed without reading a request/.test(t)),
    `a camera that read nothing stayed silent: ${JSON.stringify(errors)}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
