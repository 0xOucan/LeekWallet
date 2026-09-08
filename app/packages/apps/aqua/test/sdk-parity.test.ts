/**
 * @1inch/aqua-sdk as a witness: everything this app builds, built again by the
 * sponsor's own SDK, and compared.
 *
 * ---------------------------------------------------------------------------
 * Why the SDK is a devDependency and not a dependency
 *
 * docs/SDK-POLICY.md says to use `AquaProtocolContract` for `ship`/`dock`
 * encoding, `calculateStrategyHash`, and the event decoders. That was the plan
 * here too, and the code was written. It is not what shipped, and the reason is
 * the licence rather than anything technical:
 *
 * `@1inch/aqua-sdk` is `LicenseRef-Degensoft-Aqua-Source-1.1` — source
 * available, not open source. AQUA-1INCH.md already noted that *calling the
 * deployed contracts* is unaffected by it, which is true. Adding the package to
 * a signed release binary is a different act, and the licence answers it
 * differently:
 *
 * - §2.1 grants distribution of **unmodified** source or object forms. A Vite
 *   bundle tree-shakes, transpiles and minifies; §1.7 then defines Modification
 *   to include "static/dynamic linking" and "artifacts shipped/deployed
 *   together as one product". A bundled companion is both.
 * - §5 requires a separate commercial agreement for commercial use, §6 permits
 *   an annual audit, and §11.3 forbids assignment without written consent.
 *   Those are obligations. Apache-2.0 is how this project licenses its
 *   releases, and it tells every recipient they have none.
 * - §7.1's patent grant terminates on ceasing use, and §9 terminates the whole
 *   licence on uncured breach. Apache-2.0 §2–3 are irrevocable. We cannot
 *   convey rights we do not hold, and we cannot bind whoever downloads a
 *   release to terms they never saw.
 * - §5.3's waiver is revocable "at any time in its sole discretion, including
 *   with respect to existing users", on ten days' notice. A binary already in
 *   users' hands cannot be cured in ten days.
 * - §3.1 C requires the designation "Powered by Aqua" in README and UI, and
 *   §7.2 grants no right to use that designation. The licence mandates a mark
 *   it declines to license.
 *
 * So the SDK cannot be in a release build. It can be in the test suite: a
 * devDependency is never bundled, never conveyed to a recipient, and §4 covers
 * non-commercial experimentation and hackathon use squarely.
 *
 * ---------------------------------------------------------------------------
 * What this file therefore is
 *
 * Not a fallback. A differential test, which is a better use of the SDK than
 * calling it would have been: `src/registry.ts` and `AquaProtocolContract` are
 * two independent implementations of the same ABI, written by different people
 * from the same contract, and every byte either produces is compared against
 * the other here. Importing the SDK would have collapsed them into one
 * implementation and proved nothing.
 *
 * And the assertion that matters most is the last step of that chain: SDK-built
 * calldata, decoded by **the device's own decoder**. `aqua_decode_ship` and
 * `aqua_decode_dock` in src/eth-decode.c read the calldata themselves and draw
 * the screen from what they find; `packages/core/src/eth-decode.ts` is a
 * line-for-line mirror of them, kept so the host can predict what the device
 * will show. Neither knows the SDK exists. Running the sponsor's bytes through
 * it proves the device would display exactly the transaction the SDK was asked
 * to build — which is the only thing that would have made letting a dependency
 * build signable bytes safe in the first place, and is worth having whether or
 * not that dependency ships.
 */

import { AquaProtocolContract, AQUA_CONTRACT_ADDRESSES, Address, DockedEvent, HexString, PushedEvent, ShippedEvent } from "@1inch/aqua-sdk";
import { readdirSync, readFileSync } from "node:fs";
import { CallKind, decodeCall } from "@leekwallet/core/eth-decode.ts";
import {
  AQUA_CHAIN_IDS, AQUA_REGISTRY, encodeDock, encodeShip, strategyHash,
  TOPIC_DOCKED, TOPIC_PUSHED, TOPIC_SHIPPED,
} from "../src/registry.ts";
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

group("the SDK stays out of everything that ships");
{
  /* The licence argument at the top of this file is only true while no module
   * under src/ imports the SDK — a devDependency that something in src/ pulls
   * in is a runtime dependency with a misleading label, and Vite would bundle
   * it into the release. Checked here rather than described, because this is
   * the assumption the whole licence position rests on.
   *
   * This lives in the app's own suite so it is deleted along with the app,
   * which is the rule the mini-app boundary is built on (src/index.ts). */
  const offenders = readdirSync(new URL("../src/", import.meta.url))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /^\s*(?:import|export)\b[^;]*?["']@1inch\/|\brequire\(\s*["']@1inch\//m.test(
      readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"),
    ));
  check(offenders.length === 0,
    `these ship to users and import the SDK: ${offenders.join(", ")}`);
}

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

  const decoded = decodeCall(bytes(sdkShip(APP, strategy, legs)));

  check(decoded.kind === CallKind.AquaShip,
    `the mirror read SDK ship calldata as ${decoded.kind}`);
  check(decoded.aqua?.app === APP, `app is ${decoded.aqua?.app}`);
  check(decoded.aqua?.maker === ME, `maker is ${decoded.aqua?.maker}`);
  check(decoded.aqua?.strategy === strategy, "the strategy did not survive the round trip");
  /* The hash the mirror computes is the key the position files under. It is
   * recomputed from the bytes it decoded rather than carried in the calldata,
   * so this compares two derivations of it: the SDK's and the device's. */
  check(decoded.aqua?.strategyHash === strategyHash(strategy),
    `strategyHash is ${decoded.aqua?.strategyHash}`);
  check(decoded.aqua?.legs.length === 2, `legs is ${decoded.aqua?.legs.length}`);
  check(decoded.aqua?.legs[0]?.token === USDC && decoded.aqua?.legs[0]?.amount === 1_000_000n,
    "leg 0 does not match what the SDK was handed");
  /* A wide amount, because a uint256 whose top was dropped somewhere in either
   * path would still look like a plausible number on the screen. */
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

group("our encoders and the SDK's agree byte for byte, at every leg count");
{
  /* Every leg count the device will draw, because the layout's offsets move
   * with the count and a one-leg parity result says nothing about four. This is
   * the assertion that makes registry.ts's hand-written encoders trustworthy:
   * they are not merely self-consistent, they match the protocol authors'. */
  const strategy = encodeStrategy(ME, CONFIG, "0x1726");
  const all = [USDC, DAI, ME, APP];
  const hash = strategyHash(strategy);
  for (let n = 1; n <= 4; n++) {
    const legs = all.slice(0, n).map((token, i) => ({ token, amount: BigInt(i + 1) * 7n }));
    check(encodeShip(APP, strategy, legs) === sdkShip(APP, strategy, legs),
      `ship with ${n} leg(s) differs from the SDK's encoding`);
    check(encodeDock(APP, hash, all.slice(0, n)) === sdkDock(APP, hash, all.slice(0, n)),
      `dock with ${n} token(s) differs from the SDK's encoding`);
    /* And the whole point: whatever those identical bytes are, the device can
     * read them. Two encoders agreeing on something the device refuses would
     * pass and mean nothing. */
    check(decodeCall(bytes(encodeShip(APP, strategy, legs))).kind === CallKind.AquaShip,
      `a ${n}-leg ship is not decodable by the device`);
  }
}

group("our strategy hash is the SDK's, and the device's");
{
  for (const program of ["0x", "0x17", `0x${"26".repeat(256)}`]) {
    const strategy = encodeStrategy(ME, CONFIG, program);
    const sdk = AquaProtocolContract
      .calculateStrategyHash(new HexString(strategy)).toString().toLowerCase();
    check(strategyHash(strategy) === sdk, `hash differs for a ${program.length}-char program`);

    if (program !== `0x${"26".repeat(256)}`) {   // a ship of this would exceed ETH_MAX_DATA
      const decoded = decodeCall(bytes(sdkShip(APP, strategy, [{ token: USDC, amount: 1n }])));
      check(decoded.aqua?.strategyHash === sdk,
        "the device would file this position under a different hash than the SDK says");
    }
  }
}

group("our topics and registry address are the SDK's");
{
  /* registry.ts derives these by hashing signature strings typed out by hand,
   * which proves only that the hashing is right. The SDK's constants are
   * published by the protocol's authors, so this is what actually establishes
   * that the signature strings are the deployed contract's. */
  check(TOPIC_SHIPPED === ShippedEvent.TOPIC.toString().toLowerCase(),
    `Shipped topic is ${TOPIC_SHIPPED}`);
  check(TOPIC_DOCKED === DockedEvent.TOPIC.toString().toLowerCase(),
    `Docked topic is ${TOPIC_DOCKED}`);
  check(TOPIC_PUSHED === PushedEvent.TOPIC.toString().toLowerCase(),
    `Pushed topic is ${TOPIC_PUSHED}`);

  check(AQUA_CONTRACT_ADDRESSES[1]?.toString().toLowerCase() === AQUA_REGISTRY,
    "the SDK names a different Ethereum registry than registry.ts does");
}

group("the SDK's chain list omits the only chain this app can be tested on");
{
  /* Not a defect being reported — a reason AQUA_CHAIN_IDS is hand-written.
   * The SDK's NetworkEnum contains no testnet at all, so AQUA_CONTRACT_ADDRESSES
   * has no key for Ethereum Sepolia (11155111), where the registry demonstrably
   * is: eth_getCode returns runtime bytecode hashing identical to Polygon's and
   * Gnosis's. Deriving our chain list from the SDK would delete the only chain
   * ship and dock can be exercised on without mainnet funds. Pinned so that if
   * a later release adds Sepolia, this goes red and the comment gets revisited
   * rather than quietly becoming false. */
  const sdkChains = Object.keys(AQUA_CONTRACT_ADDRESSES).map(Number);
  check(!sdkChains.includes(11155111),
    "the SDK now lists Sepolia — registry.ts's comment about it is out of date");
  check(AQUA_CHAIN_IDS.includes(11155111), "we dropped the one testable chain");

  /* Where they overlap they must agree, and ours must never claim a chain the
   * SDK does not deploy to. Sepolia is the sole documented exception. */
  const extra = AQUA_CHAIN_IDS.filter((id) => id !== 11155111 && !sdkChains.includes(id));
  check(extra.length === 0, `we offer chains the SDK does not deploy to: ${extra.join(", ")}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
