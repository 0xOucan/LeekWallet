/**
 * eth_simulateV1 tests.
 *
 * The property worth the file: an endpoint that cannot simulate produces a
 * value the UI has to render, never a promise that never settles. Every test
 * below that ends in `kind === "unavailable"` is guarding that, because the
 * failure this replaces — a spinner that means silence — cost this project a
 * week (see `withDeadline` in rpc.ts).
 *
 * In order:
 *
 * 1. The params are what the probe script proved works: validation off,
 *    traceTransfers on. Getting `validation` wrong makes every preview of an
 *    unfilled transaction fail with a fee error instead of showing anything.
 * 2. Transfers come out of the logs with the right parties and amounts, and
 *    anything half-readable is dropped rather than half-rendered.
 * 3. -32601 and a paywall are per-endpoint refusals: cached, and fallen
 *    through. An error about the transaction is not, and is not shopped around
 *    to a second operator.
 * 4. Every path settles, including the deadline.
 */

import {
  isCapabilityRefusal, markSimulationUnsupported, resetSimulationCapability,
  simulateParams, simulateTransaction, SIMULATION_NOTICE, simulationUnsupportedReason,
  transfersFromLogs, TRANSFER_TOPIC, type SimulatorFactory, type SimulatorRpc,
} from "../src/simulate.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const BOB = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";
const A = "https://a.example";
const B = "https://b.example";

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const dataWord = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

/** One successful simulation reply carrying the given logs. */
const reply = (logs: unknown[], status = "0x1") =>
  [{ calls: [{ status, gasUsed: "0x5208", returnData: "0x", logs }] }];

/** A client bound to a list of endpoints, answering from a script. */
function fakeRpc(answers: Record<string, () => unknown>): SimulatorFactory {
  return (urls) => {
    const url = urls[0] as string;
    const rpc: SimulatorRpc = {
      lastUrl: url,
      async request() {
        const answer = answers[url];
        if (!answer) throw new Error(`no script for ${url}`);
        return answer();
      },
    };
    return rpc;
  };
}

/** rpc.ts's RpcResponseError, in the only two properties this module reads. */
const rpcError = (message: string, code: number, url: string): Error => {
  const e = new Error(message) as Error & { code: number; url: string };
  e.code = code;
  e.url = url;
  return e;
};

/* ------------------------------------------------------------------------ */

group("the params are the ones the probe proved");
{
  const [body, block] = simulateParams({ from: ALICE, to: BOB, value: 10n }) as [Record<string, unknown>, string];
  check(block === "latest", "the simulation is not against latest");
  check(body["validation"] === false,
    "validation is not off — a wallet previews before the fee fields are final");
  check(body["traceTransfers"] === true, "traceTransfers is off, so there is nothing to show");
  const calls = (body["blockStateCalls"] as { calls: Record<string, unknown>[] }[])[0]?.calls ?? [];
  check(calls.length === 1, "the probe did not carry exactly one call");
  check(calls[0]?.["value"] === "0xa", "the value is not a hex quantity");
  check(!("gas" in (calls[0] ?? {})) && !("maxFeePerGas" in (calls[0] ?? {})),
    "fee fields were sent with validation off");
  // Empty calldata is left out rather than sent as "0x".
  check(!("input" in (calls[0] ?? {})), "empty calldata was sent as a field");
}

group("transfers out of logs, or nothing");
{
  const logs = [
    { address: USDC, topics: [TRANSFER_TOPIC, topic(ALICE), topic(BOB)], data: dataWord(1500n) },
    { address: `0x${"0".repeat(40)}`, topics: [TRANSFER_TOPIC, topic(BOB), topic(ALICE)], data: dataWord(7n) },
  ];
  const found = transfersFromLogs(logs);
  check(found.length === 2, "a well-formed pair of transfers did not decode");
  check(found[0]?.asset === "token" && found[0]?.amount === 1500n, "the token transfer decoded wrongly");
  check(found[1]?.asset === "native", "a native transfer was reported as a token");

  // Half-readable is dropped: a transfer with a guessed party answers "does
  // more leave than I expect" wrongly.
  check(transfersFromLogs([{ address: USDC, topics: [TRANSFER_TOPIC, topic(ALICE)], data: dataWord(1n) }]).length === 0,
    "a log with a missing party was decoded anyway");
  check(transfersFromLogs([{ address: USDC, topics: [TRANSFER_TOPIC, topic(ALICE), topic(BOB)], data: "0x01" }]).length === 0,
    "a short amount word was decoded anyway");
  check(transfersFromLogs([{ address: USDC, topics: [`0x${"11".repeat(32)}`, topic(ALICE), topic(BOB)], data: dataWord(1n) }]).length === 0,
    "a non-Transfer event was read as a transfer");
  // Non-zero padding in a topic is not an address.
  check(transfersFromLogs([{ address: USDC, topics: [TRANSFER_TOPIC, `0x${"ff".repeat(32)}`, topic(BOB)], data: dataWord(1n) }]).length === 0,
    "a padded topic that is not an address became a party to a transfer");
  check(transfersFromLogs("not a list").length === 0, "a non-list of logs did not decode to nothing");
}

group("a working simulation");
await (async () => {
  resetSimulationCapability();
  const logs = [{ address: USDC, topics: [TRANSFER_TOPIC, topic(ALICE), topic(BOB)], data: dataWord(9n) }];
  const outcome = await simulateTransaction(
    fakeRpc({ [A]: () => reply(logs) }),
    { rpcUrls: [A], call: { from: ALICE, to: USDC } },
  );
  check(outcome.kind === "ok", `a good reply did not simulate: ${outcome.kind}`);
  if (outcome.kind === "ok") {
    check(outcome.leaving.length === 1 && outcome.arriving.length === 0,
      "what leaves and what arrives were not separated by the from address");
    check(outcome.gasUsed === 21000n, "gasUsed did not decode");
    check(outcome.endpoint === A, "the endpoint that learned the transaction was not reported");
  }

  const reverted = await simulateTransaction(
    fakeRpc({ [A]: () => [{ calls: [{ status: "0x0", error: { message: "execution reverted" } }] }] }),
    { rpcUrls: [A], call: { from: ALICE, to: USDC } },
  );
  check(reverted.kind === "reverted", "a reverting transaction was not reported as such");

  // A reply with no status is not a success. "It worked" is the one thing this
  // module must never assume on incomplete evidence.
  const noStatus = await simulateTransaction(
    fakeRpc({ [A]: () => [{ calls: [{ logs: [] }] }] }),
    { rpcUrls: [A], call: { from: ALICE } },
  );
  check(noStatus.kind === "unavailable", "a result with no status was treated as a success");
})();

group("capability: cached, and fallen through");
await (async () => {
  resetSimulationCapability();
  let askedA = 0;
  const factory = fakeRpc({
    [A]: () => { askedA++; throw rpcError("the method eth_simulateV1 does not exist", -32601, A); },
    [B]: () => reply([]),
  });

  const first = await simulateTransaction(factory, { rpcUrls: [A, B], call: { from: ALICE } });
  check(first.kind === "ok", "a -32601 from the first endpoint did not fall through to the second");
  check(simulationUnsupportedReason(A) !== undefined, "the refusing endpoint was not remembered");

  const second = await simulateTransaction(factory, { rpcUrls: [A, B], call: { from: ALICE } });
  check(second.kind === "ok", "the second run did not simulate");
  check(askedA === 1, "the endpoint that cannot simulate was asked again");

  // A paywalled endpoint is the same kind of refusal, by message not by code.
  check(isCapabilityRefusal(0, "eth_simulateV1 is not available on the free plan"),
    "a paywall message was not read as a capability refusal");
  check(isCapabilityRefusal(-32601, "anything"), "-32601 was not read as a capability refusal");
  // And the one the probe script got backwards the first time.
  check(!isCapabilityRefusal(-32000, "intrinsic gas too high"),
    "an execution error from a WORKING implementation was read as an absent method");
})();

group("stated absence, never a spinner");
await (async () => {
  resetSimulationCapability();

  const nowhere = await simulateTransaction(fakeRpc({}), { rpcUrls: [], call: { from: ALICE } });
  check(nowhere.kind === "unavailable", "no endpoints did not produce a stated absence");

  markSimulationUnsupported(A, "tested");
  const allRefused = await simulateTransaction(fakeRpc({}), { rpcUrls: [A], call: { from: ALICE } });
  check(allRefused.kind === "unavailable" && /every endpoint/.test(allRefused.why),
    "an all-unsupported chain did not say simulation is unavailable");

  resetSimulationCapability();
  // An error about the transaction is a working node's answer. It is reported,
  // not shopped around to a second operator that would say the same thing.
  let askedB = 0;
  const answered = await simulateTransaction(
    fakeRpc({
      [A]: () => { throw rpcError("execution reverted", -32000, A); },
      [B]: () => { askedB++; return reply([]); },
    }),
    { rpcUrls: [A, B], call: { from: ALICE } },
  );
  check(answered.kind === "unavailable", "an RPC error did not produce a stated absence");
  check(askedB === 0, "a transaction-level error was disclosed to a second operator");

  // The deadline. A transport that never settles must not wedge the preview.
  const hung: SimulatorFactory = () => ({
    lastUrl: A,
    request: () => new Promise<never>(() => { /* never settles, deliberately */ }),
  });
  const started = Date.now();
  const timedOut = await simulateTransaction(hung, { rpcUrls: [A], call: { from: ALICE }, deadlineMs: 50 });
  check(timedOut.kind === "unavailable" && /timeout/.test(timedOut.why),
    "a transport that never answered did not produce a timeout");
  check(Date.now() - started < 2000, "the deadline did not fire promptly");

  check(/not a safety check/.test(SIMULATION_NOTICE),
    "the notice no longer says a clean simulation is not a safety check");
})();

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
