/**
 * SDK-built calldata, read back by the device's own decoder.
 *
 * This is the test that makes it safe to let @1inch/aqua-sdk build bytes a
 * hardware wallet will sign, and it is worth being explicit about why, because
 * "we ran the SDK and nothing threw" would not be that test.
 *
 * The device does not trust the host. `aqua_decode_ship`/`aqua_decode_dock` in
 * src/eth-decode.c read the calldata themselves and draw the screen from what
 * they find, and `packages/core/src/eth-decode.ts` is a line-for-line mirror of
 * those, kept so the host can predict what the device will show and refuse
 * first. Neither knows the SDK exists. So there are two independent readings of
 * the same bytes in this repo, and the only thing that could make them diverge
 * silently is nobody comparing them.
 *
 * That is what happens below: `AquaProtocolContract.encodeShipCallData` builds
 * a `ship`, the firmware mirror decodes it cold, and every field the device
 * would put on screen — the app, the maker read out of the strategy, the hash
 * the position files under, each token and each amount — is compared against
 * what was asked for. A disagreement here is either the SDK encoding something
 * other than what it was handed, or the decoder reading it wrong, and both are
 * a wallet signing a transaction whose screen was a lie.
 *
 * The mirror is deliberately strict — it accepts the canonical solc layout and
 * nothing else, refusing anything merely legal ABI for the same arguments — so
 * this test also pins the claim that the SDK emits canonical encoding. If a
 * future SDK release starts, say, packing the tails differently, every ship it
 * builds would be refused at the device and this goes red first.
 *
 * `strategyMaker` is why the strategies here are built with `encodeStrategy`
 * rather than being arbitrary bytes: the decoder refuses a strategy it cannot
 * find a maker in, which is a separate refusal tested in deploy.test.ts.
 */

import { AquaProtocolContract, Address, HexString } from "@1inch/aqua-sdk";
import { CallKind, decodeCall } from "@leekwallet/core/eth-decode.ts";
import { encodeDock, encodeShip, strategyHash } from "../src/registry.ts";
import { encodeStrategy } from "../src/strategy.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const ME = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const APP = "0x228e82831afac5dd9ebde3489e9e18ae9c7bcbf4";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";
const DAI = "0x3333333333333333333333333333333333333333";
const CONFIG = `0x${"00".repeat(31)}07`;

const bytes = (hex: string) =>
  Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** Straight from the SDK, with none of this package's wrapping in the way. */
const sdkShip = (app: string, strategy: string, legs: readonly { token: string; amount: bigint }[]) =>
  AquaProtocolContract.encodeShipCallData({
    app: new Address(app),
    strategy: new HexString(strategy),
    amountsAndTokens: legs.map((l) => ({ amount: l.amount, token: new Address(l.token) })),
  }).toString().toLowerCase();

const sdkDock = (app: string, hash: string, tokens: readonly string[]) =>
  AquaProtocolContract.encodeDockCallData({
    app: new Address(app),
    strategyHash: new HexString(hash),
    tokens: tokens.map((t) => new Address(t)),
  }).toString().toLowerCase();

/* ------------------------------------------------------------------------- */

group("SDK-built ship calldata decodes through the firmware mirror");
{
  /* 256 bytes of program: the size every strategy observed on chain carries,
   * and the reason ETH_MAX_DATA went to 640. A parity test on a two-byte
   * program would not exercise the length this has to survive. */
  const strategy = encodeStrategy(ME, CONFIG, `0x${"17".repeat(200)}`);
  const legs = [
    { token: USDC, amount: 1_000_000n },
    { token: DAI, amount: 2n ** 200n },
  ];

  const data = sdkShip(APP, strategy, legs);
  const decoded = decodeCall(bytes(data));

  check(decoded.kind === CallKind.AquaShip,
    `the mirror read SDK ship calldata as ${decoded.kind}`);
  check(decoded.aqua?.app === APP, `app is ${decoded.aqua?.app}`);
  check(decoded.aqua?.maker === ME, `maker is ${decoded.aqua?.maker}`);
  check(decoded.aqua?.strategy === strategy, "the strategy did not survive the round trip");
  /* The hash the mirror computes is the key the position files under. It is
   * recomputed from the bytes it decoded, not carried in the calldata, so this
   * compares two derivations of it: the SDK's and the device's. */
  check(decoded.aqua?.strategyHash === strategyHash(strategy),
    `strategyHash is ${decoded.aqua?.strategyHash}`);
  check(decoded.aqua?.legs.length === 2, `legs is ${decoded.aqua?.legs.length}`);
  check(decoded.aqua?.legs[0]?.token === USDC && decoded.aqua?.legs[0]?.amount === 1_000_000n,
    "leg 0 does not match what the SDK was handed");
  /* A wide amount, because a uint256 the top of which is dropped somewhere in
   * either path would still look like a plausible number on the screen. */
  check(decoded.aqua?.legs[1]?.token === DAI && decoded.aqua?.legs[1]?.amount === 2n ** 200n,
    "leg 1 does not match what the SDK was handed");
}

group("SDK-built dock calldata decodes through the firmware mirror");
{
  const hash = strategyHash(encodeStrategy(ME, CONFIG, "0x1726"));
  const decoded = decodeCall(bytes(sdkDock(APP, hash, [USDC, DAI])));

  check(decoded.kind === CallKind.AquaDock,
    `the mirror read SDK dock calldata as ${decoded.kind}`);
  check(decoded.aqua?.app === APP, `app is ${decoded.aqua?.app}`);
  check(decoded.aqua?.strategyHash === hash, `strategyHash is ${decoded.aqua?.strategyHash}`);
  check(decoded.aqua?.legs.map((l) => l.token).join(",") === `${USDC},${DAI}`,
    "the dock token list does not match");
}

group("the SDK and this package encode the same bytes, at every leg count");
{
  /* The wrappers in registry.ts validate and then delegate, so this asserts
   * that the delegation is all they do — that no padding, ordering or
   * lower-casing was quietly added on the way through. Every leg count the
   * device will draw, because the layout's offsets move with the count and a
   * one-leg parity result says nothing about four. */
  const strategy = encodeStrategy(ME, CONFIG, "0x1726");
  const all = [USDC, DAI, ME, APP];
  for (let n = 1; n <= 4; n++) {
    const legs = all.slice(0, n).map((token, i) => ({ token, amount: BigInt(i + 1) * 7n }));
    check(encodeShip(APP, strategy, legs) === sdkShip(APP, strategy, legs),
      `ship with ${n} leg(s) differs from the SDK's encoding`);

    const hash = strategyHash(strategy);
    check(encodeDock(APP, hash, all.slice(0, n)) === sdkDock(APP, hash, all.slice(0, n)),
      `dock with ${n} token(s) differs from the SDK's encoding`);

    /* And the whole point: whatever those identical bytes are, the device can
     * read them. A parity test between two encoders that both produce
     * something the device refuses would pass and mean nothing. */
    check(decodeCall(bytes(encodeShip(APP, strategy, legs))).kind === CallKind.AquaShip,
      `a ${n}-leg ship is not decodable by the device`);
  }
}

group("the SDK's strategy hash is the device's strategy hash");
{
  /* The device recomputes this from the strategy bytes inside the calldata; the
   * SDK computes it from the bytes it was handed. They are the same keccak, and
   * that is exactly the kind of claim that stops being true unnoticed. */
  for (const program of ["0x", "0x17", `0x${"26".repeat(256)}`]) {
    const strategy = encodeStrategy(ME, CONFIG, program);
    const sdk = AquaProtocolContract
      .calculateStrategyHash(new HexString(strategy)).toString().toLowerCase();
    check(strategyHash(strategy) === sdk, `hash differs for a ${program.length}-char program`);

    if (program !== `0x${"26".repeat(256)}`) {   // over ETH_MAX_DATA once shipped
      const decoded = decodeCall(bytes(sdkShip(APP, strategy, [{ token: USDC, amount: 1n }])));
      check(decoded.aqua?.strategyHash === sdk,
        "the device would file this position under a different hash than the SDK says");
    }
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
