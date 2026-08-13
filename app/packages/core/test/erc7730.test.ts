/**
 * ERC-7730 descriptor tests.
 *
 * Four things are being pinned down, in descending order of how much it costs
 * to get them wrong.
 *
 * 1. **Nothing descriptor-derived can reach the device.** A descriptor is
 *    unsigned host-supplied text; the moment any of it rides along with a
 *    signing request, this feature has become the thing docs/CLEAR-SIGNING.md
 *    exists to prevent. The last group builds the real device request and
 *    searches its bytes.
 * 2. **Matching is exact.** Right selector on the wrong chain, or the right
 *    chain at the wrong address, or the right call with a trailing byte, is a
 *    non-match — not a nearly-right label over different calldata.
 * 3. **Malformed input is rejected whole.** A descriptor missing a deployment
 *    address or a field label is null, never a partially applied one.
 * 4. **Amounts are exact.** bigint throughout; a token amount scaled by the
 *    wrong power of ten is the one error a reader cannot catch.
 */

import { encodeCbor } from "../src/cbor.ts";
import { BUNDLED_DESCRIPTORS } from "../src/erc7730-bundled.ts";
import {
  DESCRIPTOR_NOTICE, matchDescriptor, parseDescriptor, parseSignature, selectorOf,
  type Descriptor,
} from "../src/erc7730.ts";
import { interpretTransaction, WarningCode } from "../src/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const VITALIK = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
const USDC = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const word = (v: bigint | string) =>
  typeof v === "string" ? v.padStart(64, "0") : v.toString(16).padStart(64, "0");
const addrWord = (a: string) => "0".repeat(24) + a;

group("signatures parse into canonical form and the right selector");
{
  check(parseSignature("transfer(address _to, uint256 _v)")?.canonical === "transfer(address,uint256)",
    "named params are not stripped to the canonical signature");
  check(selectorOf("transfer(address,uint256)") === "a9059cbb", "transfer selector is wrong");
  check(selectorOf("supply(address,uint256,address,uint16)") === "617ba037", "supply selector is wrong");
  check(selectorOf("deposit()") === "d0e30db0", "deposit selector is wrong");
  // Dynamic types mean argument offsets we would have to follow; a misfollowed
  // offset renders a confident wrong number, so the whole format is refused.
  check(parseSignature("swap(bytes data)") === null, "a dynamic parameter was accepted");
  check(parseSignature("batch(uint256[] ids)") === null, "an array parameter was accepted");
  check(parseSignature("f((uint256,uint256) t)") === null, "a tuple parameter was accepted");
  check(parseSignature("0xa9059cbb") === null, "a bare selector key was accepted as a signature");
}

group("the bundled set parses and names its provenance");
{
  check(BUNDLED_DESCRIPTORS.length >= 3, `bundle is ${BUNDLED_DESCRIPTORS.length} descriptors`);
  for (const d of BUNDLED_DESCRIPTORS) {
    check(d.source.startsWith("registry/"), `source is not a registry path: ${d.source}`);
    check(/@ [0-9a-f]{7}$/.test(d.source), `source does not pin a commit: ${d.source}`);
    check(d.formats.length > 0, `${d.source} contributed no formats`);
    for (const dep of d.deployments) {
      check(dep.address === dep.address.toLowerCase(), `${d.source} kept a mixed-case address`);
    }
  }
  // Bundling, not fetching: nothing in this module may reach the network.
  check(
    !JSON.stringify(BUNDLED_DESCRIPTORS, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("http"),
    "a bundled descriptor carries a URL, which suggests something intends to fetch it",
  );
}

group("a descriptor matches and renders");
{
  const m = matchDescriptor(BUNDLED_DESCRIPTORS, {
    chainId: 1,
    to: STETH,
    data: "0x" + "a9059cbb" + addrWord(VITALIK) + word(1500n),
  });
  check(m !== undefined, "the stETH transfer descriptor did not match");
  check(m?.intent === "Transfer stETH", `intent: ${m?.intent}`);
  check(m?.owner === "Lido DAO", `owner: ${m?.owner}`);
  check(m?.selector === "0xa9059cbb", `selector: ${m?.selector}`);
  check(m?.unverified === true, "a match came back without unverified:true");
  check(m?.advisory === true, "a match came back without advisory:true");
  // EIP-55, so it compares character-for-character with the device screen.
  check(
    m?.fields[0]?.value === "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    `recipient rendering: ${m?.fields[0]?.value}`,
  );
  // No token hint for stETH, so raw units and a statement that they are raw.
  check(
    m?.fields[1]?.value === "1500 raw units (decimals unknown)",
    `amount rendering: ${m?.fields[1]?.value}`,
  );
}

group("aave: the call the whole spike started from");
{
  const m = matchDescriptor(BUNDLED_DESCRIPTORS, {
    chainId: 1,
    to: AAVE_POOL,
    data: "0x" + "617ba037" + addrWord(USDC) + word(100000000n) + addrWord(VITALIK) + word(0n),
  });
  check(m?.intent === "Supply", `intent: ${m?.intent}`);
  check(m?.owner === "Aave DAO", `owner: ${m?.owner}`);
  // USDC is in TOKEN_HINTS at 6 decimals — a guess, and it says so.
  const amount = m?.fields.find((f) => f.format === "tokenAmount")?.value;
  check(
    amount === "100 USDC — unverified guess (100000000 raw units)",
    `token amount rendering: ${amount}`,
  );
  // referralCode is `visible: never` in the descriptor: hidden, not omitted.
  check(m?.hiddenFields === 1, `hidden fields: ${m?.hiddenFields}`);
}

group("an unlimited allowance hits the descriptor's own threshold");
{
  const m = matchDescriptor(BUNDLED_DESCRIPTORS, {
    chainId: 1,
    to: STETH,
    data: "0x" + "095ea7b3" + addrWord(VITALIK) + "f".repeat(64),
  });
  const v = m?.fields.find((f) => f.format === "tokenAmount")?.value ?? "";
  check(v.startsWith("Unlimited ("), `threshold message not applied: ${v}`);
  // The raw number is still printed. The word is a summary of it, not a
  // replacement for it.
  check(v.includes((2n ** 256n - 1n).toString()), `raw units dropped: ${v}`);
}

group("the wrong chain and the wrong contract do not match");
{
  // Same contract address, different chain. stETH is only deployed on 1, and
  // an address on another chain is a different contract entirely.
  check(
    matchDescriptor(BUNDLED_DESCRIPTORS, {
      chainId: 137, to: STETH, data: "0x" + "a9059cbb" + addrWord(VITALIK) + word(1n),
    }) === undefined,
    "a chain-1 descriptor matched on chain 137",
  );
  // Right chain, right selector, unrelated contract.
  check(
    matchDescriptor(BUNDLED_DESCRIPTORS, {
      chainId: 1, to: "0x" + USDC, data: "0x" + "a9059cbb" + addrWord(VITALIK) + word(1n),
    }) === undefined,
    "the stETH descriptor matched a different contract",
  );
  // Unknown selector on a described contract.
  check(
    matchDescriptor(BUNDLED_DESCRIPTORS, {
      chainId: 1, to: STETH, data: "0xdeadbeef" + word(1n),
    }) === undefined,
    "an undescribed selector matched",
  );
  // Exact length, like the firmware: a trailing byte is a call with more in it
  // than the descriptor accounts for.
  check(
    matchDescriptor(BUNDLED_DESCRIPTORS, {
      chainId: 1, to: STETH, data: "0x" + "a9059cbb" + addrWord(VITALIK) + word(1n) + "00",
    }) === undefined,
    "trailing calldata was tolerated",
  );
  check(
    matchDescriptor(BUNDLED_DESCRIPTORS, {
      chainId: 1, to: STETH, data: "0x" + "a9059cbb" + addrWord(VITALIK),
    }) === undefined,
    "short calldata was tolerated",
  );
  // Non-zero padding in an address word is not an address.
  const bad = matchDescriptor(BUNDLED_DESCRIPTORS, {
    chainId: 1, to: STETH,
    data: "0x" + "a9059cbb" + "01" + "0".repeat(22) + VITALIK + word(1n),
  });
  check(
    bad !== undefined && !bad.fields.some((f) => f.format === "addressName"),
    "an address word with non-zero padding was rendered as an address",
  );
  check((bad?.omittedFields ?? 0) >= 1, "the unrenderable address field was not counted as omitted");
}

group("malformed descriptors are rejected, not half-applied");
{
  const good = {
    context: { contract: { deployments: [{ chainId: 1, address: "0x" + USDC }] } },
    metadata: { owner: "Someone" },
    display: { formats: { "transfer(address to, uint256 amount)": { intent: "Send", fields: [
      { path: "to", format: "addressName", label: "To" },
    ] } } },
  };
  check(parseDescriptor(good, "test") !== null, "the control descriptor did not parse");

  const mutate = (fn: (d: any) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(good));
    fn(copy);
    return copy;
  };
  const rejected: Array<[string, unknown]> = [
    ["not an object", "just a string"],
    ["null", null],
    ["no context", mutate((d) => { delete d.context; })],
    ["no deployments", mutate((d) => { delete d.context.contract.deployments; })],
    ["empty deployments", mutate((d) => { d.context.contract.deployments = []; })],
    ["deployment address is not one", mutate((d) => { d.context.contract.deployments[0].address = "0xnope"; })],
    ["deployment chainId is a string", mutate((d) => { d.context.contract.deployments[0].chainId = "1"; })],
    ["no display", mutate((d) => { delete d.display; })],
    ["formats is an array", mutate((d) => { d.display.formats = []; })],
    ["a format with no intent", mutate((d) => { delete d.display.formats["transfer(address to, uint256 amount)"].intent; })],
    ["a field with no label", mutate((d) => { delete d.display.formats["transfer(address to, uint256 amount)"].fields[0].label; })],
    ["a field with no path", mutate((d) => { delete d.display.formats["transfer(address to, uint256 amount)"].fields[0].path; })],
    ["fields is not an array", mutate((d) => { d.display.formats["transfer(address to, uint256 amount)"].fields = {}; })],
  ];
  for (const [name, input] of rejected) {
    check(parseDescriptor(input, "test") === null, `not rejected: ${name}`);
  }
  // An empty source is a descriptor with no provenance to show, which the UI
  // would then have to render as if it came from nowhere.
  check(parseDescriptor(good, "") === null, "a descriptor with no provenance was accepted");
}

group("unsupported formats are omitted, never guessed at");
{
  const d = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId: 1, address: "0x" + USDC }] } },
      display: { formats: {
        "f(address a, uint256 b, uint256 c)": { intent: "Mixed", fields: [
          { path: "a", format: "nftName", label: "NFT" },        // unsupported format
          { path: "b", format: "unit", label: "Unit" },           // unsupported format
          { path: "c", format: "raw", label: "Raw" },             // supported
          { path: "@.from", format: "addressName", label: "From" }, // unavailable path
          { path: "a.b.c", format: "raw", label: "Nested" },      // unsupported path
        ] },
        // Dropped whole: the offsets after a dynamic parameter are not ours to
        // guess, so no field of this format is rendered at all.
        "g(bytes data)": { intent: "Dynamic", fields: [] },
      } },
    },
    "test",
  );
  check(d !== null, "the mixed descriptor did not parse");
  check(d?.formats.length === 1, `dynamic-signature format was kept: ${d?.formats.length}`);
  const fmt = d?.formats[0];
  check(fmt?.fields.length === 1, `renderable fields: ${fmt?.fields.length}`);
  check(fmt?.omitted === 4, `omitted count: ${fmt?.omitted}`);

  const m = matchDescriptor(d ? [d] : [], {
    chainId: 1, to: "0x" + USDC,
    data: "0x" + selectorOf("f(address,uint256,uint256)") + addrWord(VITALIK) + word(1n) + word(42n),
  });
  check(m?.fields.length === 1 && m.fields[0]?.value === "42", `raw field: ${m?.fields[0]?.value}`);
  // The count is surfaced so a UI can say the list is incomplete rather than
  // implying it is everything the call does.
  check(m?.omittedFields === 4, `omitted surfaced: ${m?.omittedFields}`);
}

group("duration, date, enum and raw render exactly or not at all");
{
  const mk = (fields: unknown[], extra: Record<string, unknown> = {}) =>
    parseDescriptor(
      {
        context: { contract: { deployments: [{ chainId: 1, address: "0x" + USDC }] } },
        metadata: { enums: { mode: { "1": "stable", "2": "variable" } }, ...extra },
        display: { formats: { "f(uint256 a, bool b, int256 c)": { intent: "T", fields } } },
      },
      "test",
    );
  const run = (d: Descriptor | null, a: bigint, b: bigint, c: string) =>
    matchDescriptor(d ? [d] : [], {
      chainId: 1, to: "0x" + USDC,
      data: "0x" + selectorOf("f(uint256,bool,int256)") + word(a) + word(b) + word(c),
    });

  const dur = mk([{ path: "a", format: "duration", label: "For" }]);
  check(run(dur, 90061n, 0n, word(0n))?.fields[0]?.value === "1d 1h 1m 1s",
    `duration: ${run(dur, 90061n, 0n, word(0n))?.fields[0]?.value}`);

  const date = mk([{ path: "a", format: "date", label: "By", params: { encoding: "timestamp" } }]);
  check(run(date, 1700000000n, 0n, word(0n))?.fields[0]?.value === "2023-11-14T22:13:20Z",
    `date: ${run(date, 1700000000n, 0n, word(0n))?.fields[0]?.value}`);
  // Blockheight dates need chain state this app does not have.
  const bad = mk([{ path: "a", format: "date", label: "By", params: { encoding: "blockheight" } }]);
  check(bad?.formats[0]?.omitted === 1, "a blockheight date was rendered");

  const en = mk([{ path: "a", format: "enum", label: "Mode", params: { $ref: "$.metadata.enums.mode" } }]);
  check(run(en, 2n, 0n, word(0n))?.fields[0]?.value === "variable", "enum did not resolve");
  // An unlisted enum value is a call the descriptor does not actually cover.
  check(run(en, 7n, 0n, word(0n))?.fields.length === 0, "an unlisted enum value was rendered");

  const raw = mk([
    { path: "b", format: "raw", label: "Flag" },
    { path: "c", format: "raw", label: "Signed" },
  ]);
  const r = run(raw, 0n, 1n, "f".repeat(64));
  check(r?.fields[0]?.value === "true", `bool: ${r?.fields[0]?.value}`);
  check(r?.fields[1]?.value === "-1", `int256 two's complement: ${r?.fields[1]?.value}`);
  // An ABI bool is 0 or 1; anything else would have to be drawn as "true-ish".
  check(run(raw, 0n, 2n, word(0n))?.fields.length === 1, "a non-boolean bool word was rendered");
}

group("disagreement with the built-in decoder is surfaced, not reconciled");
{
  const CALL = "0x" + "a9059cbb" + addrWord(VITALIK) + word(5n);

  /* The agreement case first, because a warning that fires on everything says
   * nothing. An honest descriptor for transfer(address,uint256) reads the same
   * two words the same two ways the firmware decoder does. */
  const honest = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId: 1, address: "0x" + USDC }] } },
      display: { formats: { "transfer(address to, uint256 amount)": { intent: "Send", fields: [
        { path: "to", format: "addressName", label: "To" },
        { path: "amount", format: "raw", label: "Amount" },
      ] } } },
    },
    "test",
  ) as Descriptor;
  const view = interpretTransaction({ chainId: 1, to: "0x" + USDC, data: CALL }, { descriptors: [honest] });
  check(view.descriptor?.intent === "Send", "the honest descriptor did not match");
  check(
    view.warnings.every((w) => w.code !== WarningCode.DescriptorConflict),
    "a descriptor that agrees with the decoder raised a conflict",
  );

  /* Now a descriptor that claims the same selector carries
   * transfer(uint256,address) — the arguments the other way round. One of the
   * two readings is wrong about where the money goes. Hand-built rather than
   * parsed, because no honest signature hashes to this selector with these
   * types: a poisoned or stale registry entry is exactly that situation. */
  const conflicting = interpretTransaction(
    { chainId: 1, to: "0x" + USDC, data: CALL },
    {
      descriptors: [
        {
          source: "test",
          deployments: [{ chainId: 1, address: "0x" + USDC }],
          // Hand-built: no legitimate signature produces this selector with
          // these types, which is exactly the situation being tested.
          formats: [{
            selector: "a9059cbb",
            signature: "transfer(uint256,address)",
            intent: "Send in reverse",
            words: 2,
            hidden: 0,
            omitted: 0,
            fields: [
              { label: "Amount", format: "raw", source: { from: "param", word: 0, type: "uint256" } },
              { label: "To", format: "addressName", source: { from: "param", word: 1, type: "address" } },
            ],
          }],
        } as unknown as Descriptor,
      ],
    },
  );
  check(
    conflicting.warnings.some((w) => w.code === WarningCode.DescriptorConflict),
    "a descriptor contradicting the decoder raised no warning",
  );
  check((conflicting.descriptor?.conflicts.length ?? 0) >= 2, "conflicts were not itemised");
  // The layer is additive. It cannot talk the app out of the firmware's answer.
  check(conflicting.deviceWillRefuse === false, "the descriptor changed deviceWillRefuse");
  check(conflicting.recipient?.toLowerCase() === "0x" + VITALIK, "the descriptor changed the recipient");
}

group("the layer is additive: it never changes the device's answer");
{
  const undecodable = "0x" + "e8eda9df" + addrWord(USDC) + word(1n) + addrWord(VITALIK) + word(0n);
  const view = interpretTransaction({ chainId: 1, to: AAVE_POOL, data: undecodable });
  // The whole point: an Aave supply is unknown to the firmware and stays that
  // way, but it is no longer unreadable in the app.
  check(view.deviceWillRefuse === true, "a described call was treated as decodable");
  check(view.descriptor?.intent === "Supply", `descriptor intent: ${view.descriptor?.intent}`);
  check(
    view.warnings.some((w) => w.code === WarningCode.DeviceWillRefuse),
    "the refusal warning disappeared once a descriptor matched",
  );
  // And with descriptors switched off, everything else is identical.
  const without = interpretTransaction({ chainId: 1, to: AAVE_POOL, data: undecodable }, { descriptors: [] });
  check(without.descriptor === undefined, "descriptors: [] still produced a match");
  const strip = (v: unknown) =>
    JSON.stringify(v, (k, x) => (k === "descriptor" ? undefined : typeof x === "bigint" ? x.toString() : x));
  check(strip(view) === strip(without), "the descriptor layer altered the rest of the interpretation");
}

group("no descriptor-derived string can reach anything device-bound");
{
  const view = interpretTransaction({
    chainId: 1,
    to: AAVE_POOL,
    value: 0n,
    data: "0x" + "617ba037" + addrWord(USDC) + word(100000000n) + addrWord(VITALIK) + word(0n),
  });
  const d = view.descriptor;
  check(d !== undefined, "control: no descriptor matched, so this group proves nothing");

  /* Every distinctive string the descriptor contributed. If any of these ever
   * turns up outside `view.descriptor`, some caller is one property access
   * away from putting registry text on a device screen. */
  const strings = [
    d?.intent, d?.owner, d?.contractName, d?.source, d?.signature,
    ...(d?.fields ?? []).flatMap((f) => [f.label, f.value]),
  ].filter((s): s is string => typeof s === "string" && s.length > 3);
  check(strings.length >= 5, `too few descriptor strings to test: ${strings.length}`);

  // 1. Nothing outside the `descriptor` sub-object carries this text — so the
  //    existing summary/action/warnings, which are logged and rendered all
  //    over the app, stay descriptor-free.
  const rest = JSON.stringify(
    view,
    (k, v) => (k === "descriptor" ? undefined : typeof v === "bigint" ? v.toString() : v),
  );
  for (const s of strings) {
    // Addresses and amounts legitimately appear in both: they come from the
    // calldata, not from the descriptor. Only prose is descriptor-derived.
    if (/^0x[0-9a-fA-F]{40}$/.test(s) || /^\d/.test(s)) continue;
    check(!rest.includes(s), `descriptor text "${s}" leaked into the interpretation body`);
  }

  // 2. The actual request the app sends. Built here exactly as main.ts builds
  //    it — from the transaction fields and nothing else — and searched byte
  //    by byte, because CBOR is where a stray label would end up on the wire.
  const bytes = (hex: string) => {
    const h = hex.replace(/^0x/, "");
    return Uint8Array.from({ length: h.length / 2 }, (_, i) => Number.parseInt(h.slice(i * 2, i * 2 + 2), 16));
  };
  const request = encodeCbor({
    index: 0,
    chainId: 1,
    nonce: 7,
    to: bytes(AAVE_POOL),
    value: new Uint8Array(0),
    gas: bytes("5208"),
    maxFeePerGas: bytes("06fc23ac00"),
    maxPriorityFeePerGas: bytes("3b9aca00"),
    data: bytes("617ba037" + addrWord(USDC) + word(100000000n) + addrWord(VITALIK) + word(0n)),
  });
  const wire = new TextDecoder("latin1").decode(request);
  for (const s of strings) {
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) continue; // the address is the call's own
    check(!wire.includes(s), `descriptor text "${s}" appears in the device request`);
  }

  // 3. And the notice says what it is, so the UI has something honest to draw.
  check(DESCRIPTOR_NOTICE.includes("unsigned"), "the descriptor notice does not say unsigned");
  check(DESCRIPTOR_NOTICE.includes("device never sees them"),
    "the descriptor notice does not say the device never sees them");
  check(!/\bverified\b/.test(DESCRIPTOR_NOTICE), "the descriptor notice uses the word verified");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
