/**
 * Drive the Aqua app's own encoders against the real deployed registry, on a
 * fork. Not part of `pnpm test`: it needs a node at $RPC (an `anvil --fork-url`
 * of Sepolia or a mainnet, per docs/apps/AQUA-1INCH.md's testing table) and a
 * suite that goes red because a fork is not running is a suite people learn to
 * ignore.
 *
 * What it proves that the unit tests cannot: the CONTRACT accepts the calldata
 * this app builds. Every test in packages/apps/aqua/test asserts that our
 * encoder and our decoder agree with each other, which is worth having and is
 * not the same claim. Here the bytes go to 0x1111113ccf… itself, and the ship
 * either lands and emits `Shipped` with the hash we computed, or it does not.
 *
 *   pnpm --dir app exec node scripts/aqua-fork-check.mjs
 *
 * Reads $RPC (default http://127.0.0.1:8545) and $MAKER (an account the fork
 * will impersonate; defaults to a maker observed shipping on Sepolia).
 */

import { encodeDock, strategyHash } from "../packages/apps/aqua/src/registry.ts";
import { planDeployment } from "../packages/apps/aqua/src/deploy.ts";
import { revokeOffer } from "../packages/apps/aqua/src/withdraw.ts";
import { encodeStrategy, readStrategy } from "../packages/apps/aqua/src/strategy.ts";
import { decodeShipped, TOPIC_SHIPPED, AQUA_REGISTRY } from "../packages/apps/aqua/src/registry.ts";
import { decodeCall, CallKind } from "../packages/core/src/eth-decode.ts";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const MAKER = (process.env.MAKER ?? "0x39d2bae5eaeda9283535ddc98f1991c81ed5cd7e").toLowerCase();
/* The app 0x228e… is the one seen shipping on Sepolia; the token is arbitrary
 * because `ship` records virtual balances and moves nothing. That is the whole
 * point of Aqua and it is also why this check needs no funded ERC-20. */
const APP = process.env.AQUA_APP ?? "0x228e82831afac5dd9ebde3489e9e18ae9c7bcbf4";
const TOKEN = process.env.TOKEN ?? "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/* Anvil auto-mines, but the receipt is not always there on the very next call.
 * Polling rather than sleeping: a fixed delay is either too short on a loaded
 * machine or wasted on every run. */
async function receipt(tx) {
  for (let i = 0; i < 50; i++) {
    const r = await rpc("eth_getTransactionReceipt", [tx]);
    if (r) return r;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`no receipt for ${tx}`);
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};

/* A fresh salt per run, so the strategy hash is new every time. Aqua refuses to
 * ship a strategy that is already shipped, which would otherwise make the
 * second run of this script fail for a reason that has nothing to do with the
 * encoding -- exactly the kind of false red that teaches people to skip a
 * check. It is also the honest shape: a real strategy carries a salt for the
 * same reason, since the hash is not per-user. */
const salt = process.env.SALT ?? Date.now().toString(16).padStart(64, "0");
const strategy = encodeStrategy(MAKER, `0x${salt.slice(-64)}`, "0x1726");
const hash = strategyHash(strategy);
const AMOUNT = 1_000_000n;

console.log(`== against ${RPC}, block ${Number(await rpc("eth_blockNumber", []))}`);

/* The registry is actually there. A fork of the wrong chain would otherwise
 * produce a confident "the call reverted" that means something else entirely. */
const code = await rpc("eth_getCode", [AQUA_REGISTRY, "latest"]);
check(code.length > 2, `the registry has code at ${AQUA_REGISTRY}`);

/* The whole plan, from the app's own planner, rather than a hand-built ship.
 * What is under test here is the thing a user would actually cause. */
const plan = planDeployment({
  maker: MAKER, app: APP, strategy, legs: [{ token: TOKEN, amount: AMOUNT, allowance: 0n }],
});
if (!plan.ok) throw new Error(`the planner refused: ${plan.refusal.kind}`);
check(plan.steps.length === 2, `${plan.steps.length} steps, expected approve then ship`);
const approveStep = plan.steps[0];
const shipData = plan.steps[1].data;

/* Our own decoder first: if the firmware mirror cannot read what we built, the
 * device would refuse it and there is no point asking the chain. */
const decoded = decodeCall(shipData);
check(decoded.kind === CallKind.AquaShip, "the ship calldata decodes as a ship");
check(decoded.aqua?.maker === MAKER, `the decoded maker is ${decoded.aqua?.maker}`);
check(decoded.aqua?.strategyHash === hash, "the decoded hash matches strategyHash()");
check(readStrategy(strategy).maker === MAKER, "readStrategy agrees");

await rpc("anvil_impersonateAccount", [MAKER]);
await rpc("anvil_setBalance", [MAKER, "0xde0b6b3a7640000"]);

/* The approve half. A real ERC-20 on the forked chain, the capped amount, and
 * the allowance read back off the TOKEN rather than off our own plan -- what
 * bounds the exposure is what the token contract stores, not what we intended
 * it to store. */
const approveTx = await rpc("eth_sendTransaction", [
  { from: MAKER, to: approveStep.to, data: approveStep.data, gas: "0x2dc6c0" },
]);
check((await receipt(approveTx)).status === "0x1", "the capped approve() executed");

const allowanceCall = {
  to: TOKEN,
  data: "0xdd62ed3e" + MAKER.slice(2).padStart(64, "0") +
    AQUA_REGISTRY.slice(2).padStart(64, "0"),
};
const allowance = BigInt(await rpc("eth_call", [allowanceCall, "latest"]));
check(allowance === AMOUNT, `the token reports an allowance of ${allowance}, capped at ${AMOUNT}`);
check(allowance < (1n << 255n), "the allowance on chain is not unlimited");

const shipTx = await rpc("eth_sendTransaction", [
  { from: MAKER, to: AQUA_REGISTRY, data: shipData, gas: "0x2dc6c0" },
]);
const shipReceipt = await receipt(shipTx);
check(shipReceipt.status === "0x1", `ship() executed (status ${shipReceipt.status})`);

const shipped = (shipReceipt.logs ?? [])
  .filter((l) => (l.topics?.[0] ?? "").toLowerCase() === TOPIC_SHIPPED)
  .map((l) => decodeShipped(l))
  .filter(Boolean);
check(shipped.length === 1, `${shipped.length} Shipped events`);
check(shipped[0]?.maker === MAKER, `Shipped names maker ${shipped[0]?.maker}`);
check(shipped[0]?.strategyHash === hash,
  `the registry filed it under ${shipped[0]?.strategyHash}, we computed ${hash}`);
check(shipped[0]?.strategy === strategy.toLowerCase(),
  "the strategy bytes came back verbatim");

/* And Q1's reader sees it: this is the milestone's actual acceptance test,
 * "a position shipped from the app appears in the portfolio view". */
const slot = await rpc("eth_call", [{
  to: AQUA_REGISTRY,
  data: "0x6d58b4cc" +
    MAKER.slice(2).padStart(64, "0") +
    APP.slice(2).toLowerCase().padStart(64, "0") +
    hash.slice(2) +
    TOKEN.slice(2).toLowerCase().padStart(64, "0"),
}, "latest"]);
const amount = BigInt("0x" + slot.slice(2, 66));
const tokensCount = Number(BigInt("0x" + slot.slice(66, 130)));
check(amount === AMOUNT, `rawBalances reports ${amount}, shipped ${AMOUNT}`);
check(tokensCount === 1, `tokensCount is ${tokensCount}, expected 1`);

/* Dock it back, and check the slot says "docked" rather than "absent" -- the
 * distinction Q1 exists to keep and Q2 must not collapse. */
const dockTx = await rpc("eth_sendTransaction", [
  { from: MAKER, to: AQUA_REGISTRY, data: encodeDock(APP, hash, [TOKEN]), gas: "0x2dc6c0" },
]);
const dockReceipt = await receipt(dockTx);
check(dockReceipt.status === "0x1", `dock() executed (status ${dockReceipt.status})`);

const after = await rpc("eth_call", [{
  to: AQUA_REGISTRY,
  data: "0x6d58b4cc" +
    MAKER.slice(2).padStart(64, "0") +
    APP.slice(2).toLowerCase().padStart(64, "0") +
    hash.slice(2) +
    TOKEN.slice(2).toLowerCase().padStart(64, "0"),
}, "latest"]);
const afterCount = Number(BigInt("0x" + after.slice(66, 130)));
check(afterCount === 0xff, `after docking tokensCount is ${afterCount}, expected 0xff (docked)`);

/* And the offer that has to follow a full dock: with no position left, the
 * standing allowance is exposure with no upside. Sent, and read back as zero. */
const offer = revokeOffer({ token: TOKEN, allowance, remainingPositions: 0 });
check(offer.kind === "offer", `the revoke offer was ${offer.kind}`);
if (offer.kind === "offer") {
  const revokeTx = await rpc("eth_sendTransaction", [
    { from: MAKER, to: offer.step.to, data: offer.step.data, gas: "0x2dc6c0" },
  ]);
  check((await receipt(revokeTx)).status === "0x1", "the revoke executed");
  const left = BigInt(await rpc("eth_call", [allowanceCall, "latest"]));
  check(left === 0n, `the allowance after revoking is ${left}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
process.exit(failures ? 1 : 0);
