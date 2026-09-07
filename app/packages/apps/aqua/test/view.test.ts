/**
 * What ends up on the screen.
 *
 * portfolio.test.ts proves the data model keeps zero and unavailable apart. It
 * would still be possible to lose that in the renderer — a formatter that takes
 * `bigint | undefined` and prints `?? 0n` undoes the whole thing one line
 * before the user reads it. So this asserts on the rendered *text*: no field
 * derived from an unreadable value may contain a digit that could be read as an
 * amount, and its tone must differ from the tone a real zero gets.
 *
 * Deliberately no DOM. The property is a property of the strings, and a test
 * that needed jsdom to reach it would be a test nobody runs.
 */

import { fetchPortfolio } from "../src/portfolio.ts";
import { portfolioView, type Field, type PortfolioView } from "../src/view.ts";
import { encodeAggregate3Return, fakeNode, pushedLog, shippedLog, w } from "./fixtures.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const APP = "0x2222222222222222222222222222222222222222";
/** USDC on Polygon: chains.ts has a hint for it, so decimals are applied. */
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const HASH = `0x${"ab".repeat(32)}`;
const POLYGON = 137;

const scene = (slot: string | null, allowance: string | null) => fakeNode({
  head: 100n,
  logs: [shippedLog(MAKER, APP, HASH, "0xbeef"), pushedLog(MAKER, APP, HASH, USDC, 1000n)],
  calls: [
    encodeAggregate3Return([slot === null
      ? { success: false, returnData: "0x" }
      : { success: true, returnData: slot }]),
    encodeAggregate3Return([allowance === null
      ? { success: false, returnData: "0x" }
      : { success: true, returnData: allowance }]),
  ],
});

const active = (amount: bigint) => `0x${w(amount)}${w(1n)}`;

const view = async (slot: string | null, allowance: string | null): Promise<PortfolioView> =>
  portfolioView(await fetchPortfolio(scene(slot, allowance).request, POLYGON, MAKER, { fromBlock: 0n }));

const allFields = (v: PortfolioView): Field[] => [
  v.headline,
  ...v.exposures.flatMap((e) => [e.approval, e.committed, e.headroom]),
  ...v.positions.flatMap((p) => p.legs),
];

/* ------------------------------------------------------------------------ */

group("a real zero reads as a zero");
{
  const v = await view(active(0n), `0x${w(1_000_000n)}`);
  const leg = v.positions[0]!.legs[0]!;
  check(leg.value === "0 USDC", `a drained position renders as "${leg.value}"`);
  check(leg.tone === "zero", `a real zero got tone ${leg.tone}`);
  check(v.exposures[0]!.committed.value === "0 USDC", "committed lost its known zero");
  check(v.headline.tone === "normal", "a healthy portfolio got an alarming headline");
}

group("an unreachable registry does not read as a zero");
{
  const v = await view(null, `0x${w(1_000_000n)}`);
  const leg = v.positions[0]!.legs[0]!;
  check(leg.tone === "unavailable", `an unread position got tone ${leg.tone}`);
  check(leg.tone !== "zero", "an unread position was given the tone of a real zero");
  // The assertion that would fail if a formatter defaulted to 0n anywhere.
  check(!/\d/.test(leg.value), `an unread position rendered the digits "${leg.value}"`);
  check(/unavailable/i.test(leg.value), `an unread position said "${leg.value}"`);

  const committed = v.exposures[0]!.committed;
  check(committed.tone === "unavailable", "an incomplete sum was rendered as a figure");
  check(!/USDC/.test(committed.value), `an incomplete sum rendered an amount: "${committed.value}"`);
  check(v.exposures[0]!.headroom.tone === "unavailable",
    "headroom was computed from an incomplete sum");
  check(v.headline.tone === "unavailable", "the headline hid an unreadable position");
}

group("an unreachable token does not read as no approval");
{
  const unread = await view(active(1000n), null);
  check(unread.exposures[0]!.approval.tone === "unavailable",
    "an unread allowance got a value tone");
  check(!/\d/.test(unread.exposures[0]!.approval.value.replace(/[^0-9]/g, "")),
    "an unread allowance rendered digits");

  const none = await view(active(1000n), `0x${w(0n)}`);
  check(none.exposures[0]!.approval.tone === "zero", "a genuine zero approval got the wrong tone");
  check(none.exposures[0]!.approval.value !== unread.exposures[0]!.approval.value,
    "a zero approval and an unreadable one render identically");
  check(/nothing can be pulled/i.test(none.exposures[0]!.approval.value),
    "a zero approval did not say what it means");
}

group("an unlimited approval is the loudest thing on the screen");
{
  const v = await view(active(1n), `0x${w((1n << 256n) - 1n)}`);
  check(v.exposures[0]!.approval.tone === "danger", "an unlimited approval was not marked danger");
  check(/UNLIMITED/.test(v.exposures[0]!.approval.value), "an unlimited approval was not named");
  check(v.headline.tone === "danger", "the headline did not carry the unlimited approval");
  // The approval section precedes the positions section in the view object,
  // and the renderer walks it in order. The approval is the number that
  // decides what the positions can cost, so it goes first.
  check(v.exposures.length > 0 && Object.keys(v).indexOf("exposures") < Object.keys(v).indexOf("positions"),
    "positions are ordered above exposures");
}

group("an empty portfolio says so, and an unreachable one says something else");
{
  const empty = portfolioView(await fetchPortfolio(
    fakeNode({ head: 100n, logs: [] }).request, POLYGON, MAKER, { fromBlock: 0n },
  ));
  check(empty.headline.tone === "zero", "an empty portfolio got an alarming tone");
  check(/no aqua positions found/i.test(empty.headline.value),
    `an empty portfolio said "${empty.headline.value}"`);
  check(empty.positions.length === 0 && empty.exposures.length === 0,
    "an empty portfolio rendered rows");
  // Not a spinner and not silence: it names the window it looked in.
  check(/^Blocks \d+–\d+$/.test(empty.scanned), `scanned window reads "${empty.scanned}"`);

  const down = portfolioView(await fetchPortfolio(
    fakeNode({ failing: ["eth_getLogs"] }).request, POLYGON, MAKER, { fromBlock: 0n },
  ));
  check(down.headline.tone === "unavailable", "an unreachable node got a value tone");
  check(!/no aqua positions/i.test(down.headline.value),
    `an unreachable node claimed "${down.headline.value}"`);
  check(/not the same as having none/i.test(down.headline.value),
    "an unreachable node did not disclaim the empty reading");
  check(down.headline.value !== empty.headline.value,
    "empty and unavailable render the same headline");
}

group("nothing is rendered as a symbol without its address");
{
  const v = await view(active(1000n), `0x${w(5000n)}`);
  const exposure = v.exposures[0]!;
  check(exposure.label === "USDC", "the token hint was not used");
  check(exposure.token === USDC, "the exposure row lost the contract address");
  check(v.positions[0]!.legs[0]!.detail === USDC,
    "a leg showed a guessed symbol with no address behind it");
  // chains.ts's TOKEN_HINT_NOTICE, allowances.ts's ALLOWANCE_NOTICE and this
  // app's two are all present: each is a claim the screen has to disclaim.
  check(v.notices.length === 4, `got ${v.notices.length} notices`);
  check(v.notices.some((n) => /approval/i.test(n) && /unlimited/i.test(n)),
    "the exposure notice is missing");
  check(v.notices.some((n) => /not that you have none/i.test(n)),
    "the discovery notice is missing");
}

group("a token with no hint shows raw units rather than a guess");
{
  const UNKNOWN = "0x9999999999999999999999999999999999999999";
  const node = fakeNode({
    head: 100n,
    logs: [pushedLog(MAKER, APP, HASH, UNKNOWN, 1n)],
    calls: [
      encodeAggregate3Return([{ success: true, returnData: active(1234n) }]),
      encodeAggregate3Return([{ success: true, returnData: `0x${w(5000n)}` }]),
    ],
  });
  const v = portfolioView(await fetchPortfolio(node.request, POLYGON, MAKER, { fromBlock: 0n }));
  check(v.positions[0]!.legs[0]!.value === "1234 (raw units)",
    `an unhinted token rendered "${v.positions[0]!.legs[0]!.value}"`);
  check(v.exposures[0]!.label === UNKNOWN, "an unhinted token was given a symbol");
}

group("a position whose Shipped fell outside the window says so");
{
  const node = fakeNode({
    head: 100n,
    logs: [pushedLog(MAKER, APP, HASH, USDC, 1n)],
    calls: [
      encodeAggregate3Return([{ success: true, returnData: active(1n) }]),
      encodeAggregate3Return([{ success: true, returnData: `0x${w(1n)}` }]),
    ],
  });
  const v = portfolioView(await fetchPortfolio(node.request, POLYGON, MAKER, { fromBlock: 0n }));
  check(v.positions[0]!.strategyBytes === undefined, "strategy bytes were invented");
}

group("no field ever carries an unavailable tone and a plain number");
{
  // A sweep, so a field added later cannot quietly break the rule the file is
  // about. An unavailable field may name a COUNT of things that failed, so
  // what is forbidden is a token amount: a digit next to a symbol or "raw".
  for (const [name, v] of [
    ["registry down", await view(null, `0x${w(5n)}`)],
    ["token down", await view(active(1n), null)],
    ["both down", await view(null, null)],
  ] as const) {
    for (const field of allFields(v)) {
      if (field.tone !== "unavailable") continue;
      check(!/\d[\d,.]*\s*(USDC|\(raw units\))/.test(field.value),
        `${name}: unavailable field "${field.label}" rendered an amount: "${field.value}"`);
    }
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
