/**
 * The watcher, driven by a fake transport that replays real log shapes.
 *
 * No live chain is contacted here and none was contacted to produce these
 * fixtures' shapes beyond copying the layout an `eth_getLogs` response has:
 * a `Transfer` log with three topics, a one-word `data`, hex-quantity block
 * number and log index. What is asserted is therefore the decoding, the
 * matching and the failure behaviour — not that any particular testnet
 * endpoint answers.
 *
 * The properties, in order of how badly they would hurt if broken:
 *
 *  1. an unreachable chain is `unknown`, never `searched`;
 *  2. a confirmed payment survives every later failure;
 *  3. the poller stops dead and leaks no timer.
 */

import {
  decodeTransfer, expectedUnits, isConfirmed, mergeReport, PaymentWatcher, scanChain,
  TOPIC_TRANSFER, type ChainReport, type ChainRequest, type WatchTarget,
} from "../src/watch.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const MERCHANT = "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3";
const CUSTOMER = "0x1111111111111111111111111111111111111111";
const BASE_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const BASE = 84532;

/** $284.53 + 15% = $327.21, charged as 327.2117 → 327211700 raw units. */
const target: WatchTarget = { recipient: MERCHANT, token: "USDC", total: 32721n, marker: 17 };

const word = (hex: string) => `0x${hex.replace(/^0x/, "").padStart(64, "0")}`;
const transferLog = (opts: {
  amount: bigint; block: bigint; token?: string; to?: string; removed?: boolean;
}) => ({
  address: opts.token ?? BASE_USDC,
  topics: [TOPIC_TRANSFER, word(CUSTOMER), word(opts.to ?? MERCHANT)],
  data: word(opts.amount.toString(16)),
  blockNumber: `0x${opts.block.toString(16)}`,
  transactionHash: `0x${"ab".repeat(32)}`,
  logIndex: "0x3",
  ...(opts.removed === undefined ? {} : { removed: opts.removed }),
});

/** A channel that answers from a script. `null` in the script means throw. */
function fakeChannel(script: {
  head?: bigint | null;
  logs?: unknown | null;
  onGetLogs?: (params: Record<string, unknown>) => void;
}): ChainRequest {
  return {
    request: async ({ method, params }) => {
      if (method === "eth_blockNumber") {
        if (script.head === null || script.head === undefined) throw new Error("endpoint down");
        return `0x${script.head.toString(16)}`;
      }
      if (method === "eth_getLogs") {
        script.onGetLogs?.((params as unknown[])[0] as Record<string, unknown>);
        if (script.logs === null || script.logs === undefined) throw new Error("endpoint down");
        return script.logs;
      }
      throw new Error(`the watcher must only read; it asked ${method}`);
    },
    endpointHost: () => "example.invalid",
  };
}

group("the figure watched for is the figure the QR asks for");
{
  eq(expectedUnits(target, BASE), 327211700n, "USDC on Base Sepolia, six decimals, marker 17");
  eq(expectedUnits(target, 80002), 327211700n, "same figure on Polygon Amoy");
  eq(expectedUnits({ ...target, token: "EURC" }, 80002), undefined, "EURC is not on Amoy");
}

group("a Transfer log decodes, and anything else refuses");
{
  const decoded = decodeTransfer(transferLog({ amount: 327211700n, block: 100n }));
  eq(decoded.amount, 327211700n, "amount");
  eq(decoded.from, CUSTOMER, "sender");
  eq(decoded.blockNumber, 100n, "block");
  for (const [bad, why] of [
    [{ ...transferLog({ amount: 1n, block: 1n }), topics: [TOPIC_TRANSFER] }, "two topics missing"],
    [{ ...transferLog({ amount: 1n, block: 1n }), data: "0x00" }, "data is not one word"],
    [{ ...transferLog({ amount: 1n, block: 1n }), topics: [word("0x1"), word(CUSTOMER), word(MERCHANT)] }, "another event"],
  ] as const) {
    let threw = false;
    try { decodeTransfer(bad as never); } catch { threw = true; }
    check(threw, `must refuse: ${why}`);
  }
}

group("a payment is matched by its exact amount");
{
  const channel = fakeChannel({ head: 200n, logs: [transferLog({ amount: 327211700n, block: 198n })] });
  const report = await scanChain(BASE, target, channel, {});
  eq(report.kind, "matched", "the marker amount matches this bill");
  if (report.kind === "matched") {
    eq(report.payments.length, 1, "one payment");
    eq(report.payments[0]?.confirmations, 3n, "head 200, block 198");
    check(isConfirmed(report.payments[0]!), "three deep on an L2 is confirmed");
  }
}

group("a transfer for a different amount does not settle the bill");
{
  // The customer retyped "327.21" and dropped the marker. Real money arrived;
  // it is not this bill and it must not read as nothing having happened.
  const channel = fakeChannel({ head: 200n, logs: [transferLog({ amount: 327210000n, block: 199n })] });
  const report = await scanChain(BASE, target, channel, {});
  eq(report.kind, "searched", "not a match");
  check(report.kind === "searched" && report.unmatched?.length === 1, "but the arrival is reported");
}

group("a log the node marks as reorged out is not a payment");
{
  const channel = fakeChannel({
    head: 200n,
    logs: [transferLog({ amount: 327211700n, block: 198n, removed: true })],
  });
  const report = await scanChain(BASE, target, channel, {});
  eq(report.kind, "searched", "a removed log is not a payment");
}

group("a shallow payment is seen, not paid");
{
  const channel = fakeChannel({ head: 200n, logs: [transferLog({ amount: 327211700n, block: 200n })] });
  const report = await scanChain(BASE, target, channel, {});
  check(report.kind === "matched" && !isConfirmed(report.payments[0]!),
    "one confirmation on an L2 that wants two is not yet PAID");
}

group("THE PROPERTY: an unreachable chain is unknown, never searched");
{
  const cases: [ChainRequest | undefined, string][] = [
    [fakeChannel({ head: null }), "head-unreadable"],
    [fakeChannel({ head: 200n, logs: null }), "logs-unavailable"],
    [fakeChannel({ head: 200n, logs: { not: "an array" } }), "undecodable"],
    [fakeChannel({ head: 200n, logs: [{ topics: ["0x00"] }] }), "undecodable"],
    [undefined, "no-endpoint"],
  ];
  for (const [channel, reason] of cases) {
    const report = await scanChain(BASE, target, channel, {});
    eq(report.kind, "unknown", `${reason} must be unknown`);
    check(report.kind === "unknown" && report.reason === reason,
      `${reason}: got ${report.kind === "unknown" ? report.reason : report.kind}`);
  }
}

group("a chain that cannot take the token is unpayable, which is a third thing");
{
  const report = await scanChain(80002, { ...target, token: "EURC" }, fakeChannel({ head: 1n, logs: [] }), {});
  eq(report.kind, "unpayable", "EURC on Amoy was never offered, so nothing was missed");
}

group("the block cursor advances only on a scan that completed");
{
  const cursor: { scannedTo?: bigint } = {};
  await scanChain(BASE, target, fakeChannel({ head: 200n, logs: null }), cursor);
  eq(cursor.scannedTo, undefined, "a failed scan re-reads its range next time");
  let asked: Record<string, unknown> = {};
  await scanChain(BASE, target, fakeChannel({ head: 200n, logs: [], onGetLogs: (p) => { asked = p; } }), cursor);
  eq(cursor.scannedTo, 200n, "a completed scan advances");
  eq(asked["fromBlock"], "0x96", "first poll looks 50 blocks back");
  await scanChain(BASE, target, fakeChannel({ head: 210n, logs: [], onGetLogs: (p) => { asked = p; } }), cursor);
  eq(asked["fromBlock"], "0xbd", "later polls re-read the last 12 blocks (201 - 12 + 1 = 189)");
  eq(asked["toBlock"], "0xd2", "up to the head");
}

group("the filter asks only about transfers into the merchant");
{
  let asked: Record<string, unknown> = {};
  await scanChain(BASE, target, fakeChannel({ head: 20n, logs: [], onGetLogs: (p) => { asked = p; } }), {});
  eq(asked["address"], BASE_USDC, "the token contract, from rails.ts");
  const topics = asked["topics"] as unknown[];
  eq(topics[0], TOPIC_TRANSFER, "the Transfer event");
  eq(topics[1], null, "any sender");
  eq(topics[2], word(MERCHANT), "this recipient");
}

group("THE PROPERTY: once seen, seen — a failed poll never unpays a bill");
{
  const paid: ChainReport = {
    kind: "matched", chainId: BASE, window: { fromBlock: 1n, toBlock: 200n },
    payments: [{
      chainId: BASE, token: BASE_USDC, from: CUSTOMER, amount: 327211700n,
      blockNumber: 198n, txHash: `0x${"ab".repeat(32)}`, logIndex: 3, confirmations: 3n,
    }],
  };
  for (const later of [
    { kind: "unknown", chainId: BASE, reason: "logs-unavailable" },
    { kind: "searched", chainId: BASE, window: { fromBlock: 300n, toBlock: 400n } },
  ] as ChainReport[]) {
    eq(mergeReport(paid, later).kind, "matched", `a later ${later.kind} must not unpay`);
  }
  const deeper = mergeReport(paid, {
    ...paid,
    payments: [{ ...paid.payments[0]!, confirmations: 40n }],
  } as ChainReport);
  check(deeper.kind === "matched" && deeper.payments[0]?.confirmations === 40n, "confirmations rise");
  const shallower = mergeReport(paid, {
    ...paid,
    payments: [{ ...paid.payments[0]!, confirmations: 1n }],
  } as ChainReport);
  check(shallower.kind === "matched" && shallower.payments[0]?.confirmations === 3n,
    "an endpoint serving a stale head must not walk confirmations backwards");
}

/* ------------------------------------------------------------------ poller */

/** A timer table we control, so a poll loop is steppable and countable. */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    outstanding: () => pending.size,
    set: (fn: () => void, _ms: number) => { const id = next++; pending.set(id, fn); return id; },
    clear: (handle: unknown) => { pending.delete(handle as number); },
    async run() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, fn] of due) fn();
      // Let the polls started by those callbacks settle.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

group("the poller reads every chain, and unreachable ones stay unknown");
{
  const timers = fakeTimers();
  let last: ChainReport[] = [];
  const watcher = new PaymentWatcher({
    chains: [BASE, 80002, 11155111],
    channelFor: (chainId) =>
      chainId === BASE
        ? fakeChannel({ head: 200n, logs: [transferLog({ amount: 327211700n, block: 190n })] })
        : chainId === 80002
          ? fakeChannel({ head: 200n, logs: [] })
          : fakeChannel({ head: null }),
    target,
    onUpdate: (snapshot) => { last = snapshot.reports; },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  watcher.start();
  eq(last.length, 0, "start() makes no request synchronously");
  await timers.run();
  eq(last.length, 3, "one report per chain");
  eq(last[0]?.kind, "matched", "Base paid");
  eq(last[1]?.kind, "searched", "Amoy checked and empty");
  eq(last[2]?.kind, "unknown", "Sepolia unreachable — unknown, not unpaid");
  watcher.stop();
  eq(timers.outstanding(), 0, "stop() leaves no timer behind");
}

group("polling is cancellable and leaks no timer");
{
  const timers = fakeTimers();
  let updates = 0;
  const watcher = new PaymentWatcher({
    chains: [BASE],
    channelFor: () => fakeChannel({ head: 200n, logs: [] }),
    target,
    onUpdate: () => { updates++; },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  watcher.start();
  await timers.run();
  eq(updates, 1, "one poll");
  eq(timers.outstanding(), 1, "the next poll is scheduled");
  watcher.stop();
  eq(timers.outstanding(), 0, "and cancelled");
  await timers.run();
  eq(updates, 1, "a stopped watcher never polls again");
  let threw = false;
  try { watcher.start(); } catch { threw = true; }
  check(threw, "and cannot be restarted into the same leak");
}

group("a detached root stops the loop, because MiniApp has no unmount hook");
{
  const timers = fakeTimers();
  let alive = true;
  let updates = 0;
  const watcher = new PaymentWatcher({
    chains: [BASE],
    channelFor: () => fakeChannel({ head: 200n, logs: [] }),
    target,
    alive: () => alive,
    onUpdate: () => { updates++; },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  watcher.start();
  await timers.run();
  eq(updates, 1, "polled while on screen");
  alive = false;
  await timers.run();
  eq(updates, 1, "the panel is gone, so nothing is drawn");
  eq(timers.outstanding(), 0, "and nothing is scheduled — no leak past the screen");
}

group("a payment that arrives after an outage is still found");
{
  const timers = fakeTimers();
  let down = true;
  let last: ChainReport[] = [];
  const watcher = new PaymentWatcher({
    chains: [BASE],
    channelFor: () => (down
      ? fakeChannel({ head: 200n, logs: null })
      : fakeChannel({ head: 202n, logs: [transferLog({ amount: 327211700n, block: 199n })] })),
    target,
    onUpdate: (snapshot) => { last = snapshot.reports; },
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  watcher.start();
  await timers.run();
  eq(last[0]?.kind, "unknown", "down");
  down = false;
  await timers.run();
  /* The cursor did not advance during the outage, so the range covering block
   * 199 is asked for again rather than skipped past. */
  eq(last[0]?.kind, "matched", "the payment made during the outage is picked up");
  watcher.stop();
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
