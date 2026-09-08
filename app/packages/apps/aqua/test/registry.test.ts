/**
 * Aqua registry codec tests.
 *
 * Three things carry the file.
 *
 * The selectors and topics are DERIVED from signature strings, so what is
 * really under test is whether those strings match the deployed contract. This
 * file cannot answer that on its own — hashing the wrong string correctly still
 * passes — so the answer lives in sdk-parity.test.ts, where every topic and
 * every encoded byte is compared against @1inch/aqua-sdk's. That is the whole
 * job of the SDK in this repository, and the reason it is a devDependency
 * rather than a dependency is set out there.
 *
 * `rawBalances` decoding must produce three distinguishable states from two
 * words, and the sentinel that means "docked" must never be read as a token
 * count. Getting that backwards would report a maker's deliberate withdrawal as
 * an active strategy holding nothing.
 *
 * Log decoding is bounds-checked against attacker-supplied data: the operator
 * is unverified, the contract at that address was never checked, and a
 * half-decoded `Shipped` would attach one maker's strategy bytes to another's
 * hash.
 */

import {
  AQUA_REGISTRY, decodePushed, decodeRawBalances, decodeShipped, DOCKED,
  encodeRawBalances, isAquaChain, SELECTOR_RAW_BALANCES, SELECTOR_SAFE_BALANCES,
  strategyHash, TOPIC_DOCKED, TOPIC_PUSHED, TOPIC_SHIPPED,
} from "../src/registry.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

const MAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const APP = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}`;

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const aw = (a: string) => "0".repeat(24) + a.slice(2).toLowerCase();

/* ------------------------------------------------------------------------ */

group("selectors and topics derive from the right signatures");
{
  check(SELECTOR_RAW_BALANCES.length === 8, "rawBalances selector is not four bytes");
  check(SELECTOR_RAW_BALANCES !== SELECTOR_SAFE_BALANCES,
    "rawBalances and safeBalances selectors collided");

  // Published by @1inch/aqua-sdk (ShippedEvent.TOPIC). An independent witness
  // that the signature string above is the deployed event's.
  check(TOPIC_SHIPPED === "0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0",
    `Shipped topic is ${TOPIC_SHIPPED}`);
  check(new Set([TOPIC_SHIPPED, TOPIC_DOCKED, TOPIC_PUSHED]).size === 3,
    "two event topics collided");
}

group("strategyHash is keccak of the strategy bytes");
{
  // keccak256("") — the canonical empty hash, so this pins the hasher itself.
  check(strategyHash("0x") ===
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    `keccak256(empty) is ${strategyHash("0x")}`);
  check(strategyHash("0x1234") !== strategyHash("0x1235"), "different bytes hashed alike");
  check(threw(() => strategyHash("0x123")), "odd-length strategy hex was accepted");
}

group("rawBalances encodes four static words");
{
  const data = encodeRawBalances(MAKER, APP, HASH, TOKEN);
  check(data === `0x${SELECTOR_RAW_BALANCES}${aw(MAKER)}${aw(APP)}${HASH.slice(2)}${aw(TOKEN)}`,
    "rawBalances calldata layout is wrong");
  check(data.length === 2 + 8 + 4 * 64, "rawBalances calldata is not selector + four words");
  check(threw(() => encodeRawBalances("0xdead", APP, HASH, TOKEN)), "a short maker was accepted");
  check(threw(() => encodeRawBalances(MAKER, APP, "0xab", TOKEN)),
    "a short strategy hash was accepted");
}

group("the three registry states are distinguishable");
{
  const active = decodeRawBalances(`0x${w(1000n)}${w(2n)}`);
  check(active.state === "active", "an active slot did not decode as active");
  check(active.state === "active" && active.amount === 1000n, "active amount is wrong");
  check(active.state === "active" && active.tokensCount === 2, "active tokensCount is wrong");

  // The case that matters most: an active strategy that has been fully pulled.
  // It is NOT absent and NOT docked, and reading it as either would be a lie
  // about whether the maker still has a position.
  const drained = decodeRawBalances(`0x${w(0n)}${w(2n)}`);
  check(drained.state === "active", "a drained active slot decoded as something else");
  check(drained.state === "active" && drained.amount === 0n, "a drained slot lost its zero");

  check(decodeRawBalances(`0x${w(0n)}${w(0n)}`).state === "absent",
    "tokensCount 0 did not decode as absent");
  check(decodeRawBalances(`0x${w(0n)}${w(BigInt(DOCKED))}`).state === "docked",
    "the docked sentinel did not decode as docked");
  // 0xff is a sentinel, not a count. A strategy of 255 tokens cannot exist.
  check(decodeRawBalances(`0x${w(5n)}${w(0xffn)}`).state === "docked",
    "0xff was read as a token count");

  check(threw(() => decodeRawBalances("0x")), "an empty return was decoded");
  check(threw(() => decodeRawBalances(`0x${w(0n)}`)), "a one-word return was decoded");
  check(threw(() => decodeRawBalances(`0x${w(1n << 250n)}${w(1n)}`)),
    "an amount overflowing uint248 was accepted");
  check(threw(() => decodeRawBalances(`0x${w(0n)}${w(0x100n)}`)),
    "a tokensCount overflowing uint8 was accepted");
}

group("Shipped decodes, and refuses what it cannot trust");
{
  const strategy = "0xdeadbeef";
  const body = aw(MAKER) + aw(APP) + HASH.slice(2) + w(0x80n) + w(4n) +
    "deadbeef".padEnd(64, "0");
  const log = { address: AQUA_REGISTRY, topics: [TOPIC_SHIPPED], data: `0x${body}` };

  const decoded = decodeShipped(log);
  check(decoded !== undefined, "a well-formed Shipped log did not decode");
  check(decoded?.maker === MAKER.toLowerCase(), "Shipped maker is wrong");
  check(decoded?.app === APP.toLowerCase(), "Shipped app is wrong");
  check(decoded?.strategyHash === HASH, "Shipped strategyHash is wrong");
  check(decoded?.strategy === strategy, `Shipped strategy is ${decoded?.strategy}`);

  // A different event is not an error, it is not-this-event.
  check(decodeShipped({ ...log, topics: [TOPIC_DOCKED] }) === undefined,
    "a Docked log decoded as Shipped");
  check(decodeShipped({ topics: [], data: "0x" }) === undefined, "a topicless log decoded");

  // An offset past the end of the data would otherwise read whatever follows.
  check(threw(() => decodeShipped({ ...log, data: `0x${aw(MAKER)}${aw(APP)}${HASH.slice(2)}${w(0xffffn)}` })),
    "an out-of-range strategy offset was accepted");
  // A length past the end is the same bug wearing the other hat.
  check(threw(() => decodeShipped({
    ...log, data: `0x${aw(MAKER)}${aw(APP)}${HASH.slice(2)}${w(0x80n)}${w(0xffffn)}`,
  })), "an out-of-range strategy length was accepted");
  check(threw(() => decodeShipped({ ...log, data: `0x${aw(MAKER)}` })),
    "a truncated Shipped log was accepted");
  // Aqua indexes nothing. Extra topics mean this is not the layout assumed.
  check(threw(() => decodeShipped({ ...log, topics: [TOPIC_SHIPPED, HASH] })),
    "a Shipped log with an indexed topic was accepted");
  // A dirty high word is either a different ABI or a forged log.
  check(threw(() => decodeShipped({
    ...log, data: `0x${"1".repeat(24)}${MAKER.slice(2).toLowerCase()}${aw(APP)}${HASH.slice(2)}${w(0x80n)}${w(0n)}`,
  })), "an address word with dirty high bytes was accepted");
}

group("Pushed decodes exactly five words");
{
  const log = {
    topics: [TOPIC_PUSHED],
    data: `0x${aw(MAKER)}${aw(APP)}${HASH.slice(2)}${aw(TOKEN)}${w(777n)}`,
  };
  const decoded = decodePushed(log);
  check(decoded?.token === TOKEN.toLowerCase(), "Pushed token is wrong");
  check(decoded?.amount === 777n, "Pushed amount is wrong");
  check(decodePushed({ ...log, topics: [TOPIC_SHIPPED] }) === undefined,
    "a Shipped log decoded as Pushed");
  check(threw(() => decodePushed({ ...log, data: `${log.data}${w(1n)}` })),
    "a six-word Pushed log was accepted");
}

group("the chain list is an intersection, not a wish");
{
  check(isAquaChain(137) && isAquaChain(10) && isAquaChain(100), "a live Aqua chain is missing");
  // Chains the SDK lists but chains.ts has no vetted RPC for. Offering them
  // would mean inventing endpoints — chains.ts's header forbids exactly that.
  check(!isAquaChain(143) && !isAquaChain(25), "a chain with no vetted RPC is offered");
  check(AQUA_REGISTRY === AQUA_REGISTRY.toLowerCase(), "the registry address is not lower-case");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
