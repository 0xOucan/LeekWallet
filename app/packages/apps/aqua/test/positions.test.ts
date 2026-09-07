/**
 * Discovery and reading.
 *
 * The scan is the layer where "we could not look" and "there is nothing there"
 * are hardest to keep apart, because a failure produces an absence of rows
 * rather than a wrong row — there is no cell left on the screen to mark. So the
 * rule is all-or-nothing, and these tests exist mostly to hold it: a failing
 * chunk must not yield the positions the other chunks found.
 *
 * The reads are the opposite: per-leg unions, where a failure is a row that can
 * say so. Those are checked to fail *narrowly* — one dead call must not erase
 * the legs around it.
 */

import { discoverPositions, readPositions } from "../src/positions.ts";
import { encodeAggregate3Return, fakeNode, pushedLog, shippedLog, w } from "./fixtures.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const OTHER = "0x1111111111111111111111111111111111111111";
const APP = "0x2222222222222222222222222222222222222222";
const USDC = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
const DAI = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063";
const HASH = `0x${"ab".repeat(32)}`;
const HASH2 = `0x${"cd".repeat(32)}`;

const POLYGON = 137;

/* ------------------------------------------------------------------------ */

group("a scan finds this maker's positions and nobody else's");
{
  const node = fakeNode({
    head: 100_000n,
    logs: [
      shippedLog(MAKER, APP, HASH, "0xdeadbeef"),
      pushedLog(MAKER, APP, HASH, USDC, 1000n),
      pushedLog(MAKER, APP, HASH, DAI, 2000n),
      // Another maker's position, in the same unfiltered log response. Aqua
      // indexes nothing, so this is what a node really returns and dropping it
      // is this code's job, not the node's.
      shippedLog(OTHER, APP, HASH2, "0xcafe"),
      pushedLog(OTHER, APP, HASH2, USDC, 9n),
    ],
  });
  const result = await discoverPositions(node.request, MAKER, { fromBlock: 90_000n });
  check(result.ok, "a clean scan failed");
  if (result.ok) {
    check(result.positions.length === 1, `found ${result.positions.length} positions, expected 1`);
    const position = result.positions[0]!;
    check(position.strategyHash === HASH, "the wrong strategy hash was kept");
    check(position.strategy === "0xdeadbeef", "the strategy bytes were lost");
    check(position.tokens.length === 2 && position.tokens.includes(USDC) &&
      position.tokens.includes(DAI), `tokens are ${position.tokens.join()}`);
    check(result.window.fromBlock === 90_000n && result.window.toBlock === 100_000n,
      "the reported window is not the window scanned");
  }
}

group("tokens come from Pushed, so a Shipped outside the window is not fatal");
{
  // Ship was before the window; only the pushes are visible. The position is
  // still real and its balances are still readable — dropping it would hide a
  // live position, which is the same harm as reporting zero.
  const node = fakeNode({
    head: 100_000n,
    logs: [pushedLog(MAKER, APP, HASH, USDC, 1000n)],
  });
  const result = await discoverPositions(node.request, MAKER, { fromBlock: 99_000n });
  check(result.ok && result.positions.length === 1, "a push-only position was dropped");
  check(result.ok && result.positions[0]!.strategy === undefined,
    "strategy bytes were invented for a position whose Shipped was not seen");
}

group("a failed scan is not an empty scan");
{
  for (const [failing, reason] of [
    [["eth_blockNumber"], "head-unreadable"],
    [["eth_getLogs"], "logs-unavailable"],
  ] as const) {
    const node = fakeNode({ failing, logs: [pushedLog(MAKER, APP, HASH, USDC, 1n)] });
    const result = await discoverPositions(node.request, MAKER);
    check(!result.ok, `${failing[0]} failing still produced an ok discovery`);
    check(!result.ok && result.reason === reason,
      `${failing[0]} gave reason ${result.ok ? "ok" : result.reason}`);
    // The distinction the whole milestone is about, at its source.
    check(!("positions" in result), "a failed discovery carried a positions array");
  }
}

group("one failed chunk fails the whole scan");
{
  // Two chunks. The first answers with a real position; the second dies. If
  // the first chunk's find were returned, the user would see one position and
  // no indication that a second window was never read.
  let call = 0;
  const request = async ({ method }: { method: string }) => {
    if (method === "eth_blockNumber") return "0x30d40";
    if (method === "eth_getLogs") {
      if (call++ === 0) return [pushedLog(MAKER, APP, HASH, USDC, 1n)];
      throw new Error("chunk two is unreachable");
    }
    throw new Error(`unexpected ${method}`);
  };
  const result = await discoverPositions(request, MAKER, {
    fromBlock: 0n, toBlock: 19_999n, chunkBlocks: 10_000n,
  });
  check(!result.ok, "a partial scan was returned as a complete one");
  check(!result.ok && result.window?.toBlock === 19_999n,
    "a failed scan did not report the window it was attempting");
}

group("a malformed log fails the scan rather than shortening it");
{
  const node = fakeNode({
    head: 100n,
    logs: [
      pushedLog(MAKER, APP, HASH, USDC, 1n),
      { topics: [(pushedLog(MAKER, APP, HASH, USDC, 1n) as { topics: string[] }).topics[0]], data: "0x1234" },
    ],
  });
  const result = await discoverPositions(node.request, MAKER, { fromBlock: 0n });
  check(!result.ok && result.reason === "undecodable",
    "a log that did not decode as Aqua's was skipped instead of refused");
}

group("an absurd block range is refused before it becomes a flood");
{
  const node = fakeNode({ head: 100_000_000n });
  const result = await discoverPositions(node.request, MAKER, { fromBlock: 0n });
  check(!result.ok && result.reason === "range-too-large",
    "a 100M-block scan was attempted");
  check(node.seen.filter((m) => m === "eth_getLogs").length === 0,
    "the node was asked for logs anyway");
}

group("reads keep failures narrow and keep order");
{
  const positions = [{ app: APP, strategyHash: HASH, tokens: [USDC, DAI] }];
  const node = fakeNode({
    calls: [encodeAggregate3Return([
      { success: true, returnData: `0x${w(1000n)}${w(2n)}` },
      // This one reverted. It is not a zero balance and must not become one.
      { success: false, returnData: "0x" },
    ])],
  });
  const readings = await readPositions(node.request, POLYGON, MAKER, positions);
  check(readings.length === 1, "a position was lost");
  const legs = readings[0]!.legs;
  check(legs.length === 2, `got ${legs.length} legs, expected 2`);
  check(legs[0]!.token === USDC && legs[1]!.token === DAI, "legs came back out of order");
  check(legs[0]!.ok === true, "a good leg was marked failed");
  check(legs[1]!.ok === false, "a reverted leg was reported as read");
  check(legs[1]!.ok === false && legs[1]!.reason === "call-failed", "wrong failure reason");
}

group("a dead batch marks every leg in it, and nothing else");
{
  const positions = [{ app: APP, strategyHash: HASH, tokens: [USDC, DAI] }];
  const node = fakeNode({ failing: ["eth_call"] });
  const readings = await readPositions(node.request, POLYGON, MAKER, positions);
  check(readings[0]!.legs.every((l) => !l.ok), "a dead batch produced readable legs");
  check(readings[0]!.legs.every((l) => !l.ok && l.reason === "batch-failed"),
    "a dead batch did not say so");
}

group("no positions means no calls at all");
{
  const node = fakeNode();
  const readings = await readPositions(node.request, POLYGON, MAKER, []);
  check(readings.length === 0, "an empty position list produced readings");
  check(node.seen.length === 0, "an empty position list still hit the node");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
