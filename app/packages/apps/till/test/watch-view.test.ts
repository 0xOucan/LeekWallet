/**
 * Unavailable versus unpaid, asserted on the text a person actually reads.
 *
 * The model is checked first, and then the same two states are rendered
 * through `renderWatch` into a stub DOM and compared as strings — because the
 * claim this milestone makes is not "the union has two members", it is "the
 * waiter can tell them apart on the screen". A renderer that mapped both to
 * "no payment" would pass every test written against the union alone.
 *
 * The stub DOM is deliberately tiny (the same trick no-signing.test.ts uses):
 * proving a property of rendered text should not require a browser.
 */

import { watchRow, watchView, renderWatch } from "../src/watch-view.ts";
import type { ChainReport, WatchSnapshot, WatchTarget } from "../src/watch.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";
const BASE = 84532;
const BASE_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const target: WatchTarget = { recipient: MERCHANT, token: "USDC", total: 32721n, marker: 17 };

const payment = (over: Partial<{ confirmations: bigint; blockNumber: bigint }> = {}) => ({
  chainId: BASE, token: BASE_USDC, from: "0x1111111111111111111111111111111111111111",
  amount: 327211700n, blockNumber: 198n, txHash: `0x${"ab".repeat(32)}`, logIndex: 3,
  confirmations: 4n, ...over,
});

const OUTAGE: ChainReport = {
  kind: "unknown", chainId: BASE, reason: "logs-unavailable",
  window: { fromBlock: 100n, toBlock: 200n },
};
const EMPTY: ChainReport = {
  kind: "searched", chainId: BASE, window: { fromBlock: 100n, toBlock: 200n },
};
const PAID: ChainReport = {
  kind: "matched", chainId: BASE, window: { fromBlock: 100n, toBlock: 200n }, payments: [payment()],
};

const snapshot = (reports: ChainReport[], polls = 1): WatchSnapshot =>
  ({ reports, polls, updatedAt: 0, stopped: false });

group("THE PROPERTY, in the model: the two states are different sentences");
{
  const outage = watchRow(target, OUTAGE);
  const empty = watchRow(target, EMPTY);
  check(outage.text !== empty.text, "an outage and an empty chain must not read alike");
  eq(outage.tone, "unknown", "outage tone");
  eq(empty.tone, "none", "empty tone");
  check(/could not check/i.test(outage.text), `outage says we could not look: ${outage.text}`);
  check(/not the same as unpaid/i.test(outage.text), "and says what that means");
  check(!/no payment/i.test(outage.text), `an outage must never say "no payment": ${outage.text}`);
  check(/no payment yet/i.test(empty.text), `an empty chain says so plainly: ${empty.text}`);
  check(/blocks 100–200/.test(empty.detail ?? ""), "and names the blocks it checked");
}

group("a chain with no endpoint is unknown too, not skipped and not empty");
{
  const row = watchRow(target, { kind: "unknown", chainId: 80002, reason: "no-endpoint" });
  eq(row.tone, "unknown", "no endpoint means we did not look");
  check(/no endpoint/i.test(row.text), row.text);
  check(!/no payment/i.test(row.text), "and still never says no payment");
}

group("a chain that never took this token is a third state again");
{
  const row = watchRow(target, { kind: "unpayable", chainId: 80002, reason: "EURC is not deployed on Polygon Amoy." });
  eq(row.tone, "unpayable", "nobody could have paid here");
  check(/not offered here/i.test(row.text), row.text);
}

group("paid, and seen-but-shallow, are different sentences as well");
{
  const paid = watchRow(target, PAID);
  eq(paid.tone, "paid", "four confirmations on Base is paid");
  check(/^PAID — 327\.2117 USDC/.test(paid.text), paid.text);
  check((paid.detail ?? "").includes("0xabab"), "the transaction is shown, so it can be checked");

  const shallow = watchRow(target, { ...PAID, payments: [payment({ confirmations: 1n })] } as ChainReport);
  eq(shallow.tone, "seen", "one confirmation is not a promise");
  check(/Payment seen/.test(shallow.text) && /waiting for 2 confirmations/.test(shallow.text), shallow.text);
  check(!/PAID/.test(shallow.text), "and must not read as PAID");
}

group("an amount that is not this bill is reported, not hidden");
{
  const row = watchRow(target, { ...EMPTY, unmatched: [payment({ confirmations: 2n })] } as ChainReport);
  check(/other transfer/i.test(row.detail ?? ""), `a wrong-amount arrival is visible: ${row.detail}`);
}

group("THE HEADLINE: 'not paid' is unsayable while any chain is unknown");
{
  const mixed = watchView(target, snapshot([EMPTY, OUTAGE]));
  eq(mixed.headlineTone, "unknown", "one outage makes the whole answer unknown");
  check(/could not be checked/.test(mixed.headline), mixed.headline);
  check(/Do not tell the customer the payment failed/.test(mixed.headline), mixed.headline);

  const clean = watchView(target, snapshot([EMPTY, { ...EMPTY, chainId: 80002 }]));
  eq(clean.headlineTone, "none", "every chain checked: now we may say it");
  check(/No payment yet on any of the 2 chain/.test(clean.headline), clean.headline);
  check(clean.headline !== mixed.headline, "and the two headlines differ");

  const paid = watchView(target, snapshot([PAID, OUTAGE]));
  eq(paid.headlineTone, "paid", "a payment on one chain is a payment");
  check(/^PAID on /.test(paid.headline), paid.headline);

  const fresh = watchView(target, snapshot([EMPTY], 0));
  eq(fresh.headlineTone, "unknown", "before the first poll nothing has been checked");
  check(!/no payment/i.test(fresh.headline), fresh.headline);
}

group("THE PROPERTY, on rendered text: force an outage and read the screen");
{
  /* A DOM small enough to read, with textContent that recurses like the real
   * one — the assertion below is on the string a waiter would see. */
  interface Node {
    tagName: string; className: string; kids: Node[]; own: string;
    readonly textContent: string;
    append(...kids: Node[]): void;
    replaceChildren(...kids: Node[]): void;
  }
  const make = (tagName: string): Node => {
    const node = {
      tagName, className: "", kids: [] as Node[], own: "",
      get textContent(): string { return node.own + node.kids.map((k) => k.textContent).join(" "); },
      set textContent(v: string) { node.own = v; node.kids = []; },
      append(...kids: Node[]) { node.kids.push(...kids); },
      replaceChildren(...kids: Node[]) { node.kids = kids; },
    } as Node;
    return node;
  };
  (globalThis as Record<string, unknown>).document = { createElement: (t: string) => make(t) };

  const render = (reports: ChainReport[]): string => {
    const root = make("div");
    renderWatch(root as unknown as HTMLElement, watchView(target, snapshot(reports)));
    return root.textContent;
  };

  const outageText = render([OUTAGE]);
  const emptyText = render([EMPTY]);
  const paidText = render([PAID]);

  check(outageText !== emptyText, "the rendered outage and the rendered empty chain must differ");
  check(/could not check this chain/.test(outageText), `outage screen: ${outageText.slice(0, 160)}`);
  check(/not the same as unpaid/.test(outageText), "the screen says what unknown means");
  check(!/No payment yet/.test(outageText),
    `the rendered outage must never contain "No payment yet": ${outageText.slice(0, 200)}`);
  check(/No payment yet/.test(emptyText), "a genuinely empty chain does say it");
  check(/PAID/.test(paidText) && !/PAID/.test(emptyText), "and PAID is its own screen again");

  // The tone reaches the DOM too, so the colour agrees with the words. The
  // words are the guarantee; the class is the second line of defence.
  const root = make("div");
  renderWatch(root as unknown as HTMLElement, watchView(target, snapshot([OUTAGE])));
  const classes = JSON.stringify(root.kids.map((k) => [k.className, k.kids.map((g) => g.className)]));
  check(/till-watch-unknown/.test(classes), `the unknown tone reaches the DOM: ${classes.slice(0, 120)}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
