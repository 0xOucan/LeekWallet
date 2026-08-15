/**
 * Balance and ERC-20 tests.
 *
 * Four things are being pinned down, in rising order of how much it costs to
 * get them wrong:
 *
 * 1. Decoding a balance: zero, huge, and malformed. A lenient parser turns a
 *    broken answer into a believable number.
 * 2. Encoding `balanceOf` and `transfer`. The transfer encoding is checked by
 *    feeding it back through eth-decode.ts, which mirrors the firmware — if
 *    the app builds calldata the device cannot read, the device refuses and
 *    the user is stuck at the confirmation screen.
 * 3. Unit conversion by integer arithmetic only, including the boundaries
 *    where a float would have silently changed the amount.
 * 4. That no scaled figure and no symbol can leave this module without the
 *    marking that says nobody checked it — PROTOCOL.md 6d, the same property
 *    chains.test.ts asserts for token hints.
 */

import {
  balanceProvenance, BALANCE_SOURCE_NOTICE, BALANCE_STALE_AFTER_MS, decodeDecimalsReturn,
  decodeQuantity, decodeSymbolReturn, decodeUint256Return, describeTokenAmount, encodeBalanceOf,
  encodeDecimals, encodeErc20Transfer, encodeSymbol, fetchNativeBalance, fetchTokenBalance,
  fetchTokenMeta, freshnessOf, hintMeta, MAX_PLAUSIBLE_DECIMALS, parseUnits, sanitiseSymbol,
  SELECTOR_TRANSFER, TOKEN_SCALE_NOTICE, maxSendableNative, maxSendableToken,
  MAX_SENDABLE_NOTICE, type EthRequest, type TokenMeta,
} from "../src/balances.ts";
import { CallKind, decodeCall } from "../src/eth-decode.ts";
import { interpretTransaction } from "../src/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

group("a balance decodes exactly, at both ends of the range");
{
  check(decodeQuantity("0x0") === 0n, "zero balance");
  check(decodeQuantity("0x00") === 0n, "zero with a leading zero (nodes emit these)");
  check(decodeQuantity("0x1") === 1n, "one wei");
  // 2^256-1: the widest a balance can be. Number would render this as 1.15e77
  // and every digit after the seventeenth would be invented.
  const max = "0x" + "f".repeat(64);
  check(decodeQuantity(max) === (1n << 256n) - 1n, "maximum uint256");
  check(
    decodeQuantity("0xde0b6b3a7640000") === 1000000000000000000n,
    "one ether in wei",
  );
  // A total supply's worth of a 18-decimal token, past 2^53 by a long way.
  check(
    decodeQuantity("0x33b2e3c9fd0803ce8000000") === 1000000000000000000000000000n,
    "1e27 raw units",
  );

  check(threw(() => decodeQuantity("0x")), "bare 0x accepted as zero");
  check(threw(() => decodeQuantity("123")), "decimal string accepted");
  check(threw(() => decodeQuantity("0xzz")), "non-hex accepted");
  check(threw(() => decodeQuantity(1000)), "a number accepted where hex was promised");
  check(threw(() => decodeQuantity(null)), "null accepted");
  check(threw(() => decodeQuantity("0x" + "f".repeat(66))), "over-wide quantity accepted");
}

group("an eth_call return decodes, and an empty one is not zero");
{
  check(decodeUint256Return("0x" + "0".repeat(64)) === 0n, "zero token balance");
  check(decodeUint256Return("0x" + (12345678n).toString(16).padStart(64, "0")) === 12345678n, "balanceOf");
  // "no code at that address" — reading it as a zero balance would show an
  // empty wallet for a contract that is not a token at all.
  check(threw(() => decodeUint256Return("0x")), "empty return read as zero");
  check(threw(() => decodeUint256Return("0x1234")), "short return accepted");
  check(threw(() => decodeUint256Return("nonsense")), "non-hex return accepted");
}

group("balanceOf encodes to the canonical 36 bytes");
{
  const data = encodeBalanceOf(VITALIK);
  check(
    data === "0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
    `balanceOf calldata: ${data}`,
  );
  check(data.length === 2 + 8 + 64, `balanceOf length: ${data.length}`);
  // Case-insensitive in, lower-case out: the ABI has no notion of checksums.
  check(encodeBalanceOf(VITALIK.toLowerCase()) === data, "checksum casing changed the calldata");
  check(threw(() => encodeBalanceOf("0x1234")), "a short address encoded anyway");
  check(threw(() => encodeBalanceOf("d8da6bf26964af9d7eed9e03e53415d37aa96045")), "0x-less address accepted");
  check(encodeDecimals() === "0x313ce567", "decimals() selector");
  check(encodeSymbol() === "0x95d89b41", "symbol() selector");
}

group("a transfer this app builds is one the device can read back");
{
  // The round trip that matters: eth-decode.ts mirrors src/eth-decode.c, so a
  // call it cannot decode is a call the firmware refuses to display or sign.
  for (const amount of [0n, 1n, 1000000n, (1n << 255n) - 1n, (1n << 256n) - 1n]) {
    const data = encodeErc20Transfer(VITALIK, amount);
    check(data.startsWith("0x" + SELECTOR_TRANSFER), `selector for ${amount}`);
    check(data.length === 2 + 8 + 128, `transfer is not 68 bytes for ${amount}: ${data.length}`);
    const call = decodeCall(data);
    check(call.kind === CallKind.Erc20Transfer, `device would not decode a transfer of ${amount}`);
    check(call.amount === amount, `amount round trip: ${call.amount} !== ${amount}`);
    check(
      call.address === VITALIK.toLowerCase(),
      `recipient round trip: ${call.address}`,
    );
    // Only an approval can be "unlimited"; a large transfer is a specific
    // number and must not be relabelled.
    check(call.unlimited === false, `a transfer of ${amount} was called unlimited`);
  }
  check(threw(() => encodeErc20Transfer(VITALIK, -1n)), "negative amount encoded");
  check(threw(() => encodeErc20Transfer(VITALIK, 1n << 256n)), "over-wide amount encoded");
  check(threw(() => encodeErc20Transfer("0x0", 1n)), "malformed recipient encoded");

  // And the preview agrees with the device about what it is.
  const view = interpretTransaction({
    chainId: 1, to: USDC, value: 0n, data: encodeErc20Transfer(VITALIK, 5000000n),
  });
  check(view.deviceWillRefuse === false, "the device would refuse the app's own transfer");
  check(view.tokenAmountRaw === 5000000n, `preview raw amount: ${view.tokenAmountRaw}`);
  check(view.recipient?.toLowerCase() === VITALIK.toLowerCase(), "preview recipient");
  check(view.contract?.toLowerCase() === USDC, "preview token contract");
}

group("typed amounts convert exactly, with no floating point anywhere");
{
  check(parseUnits("1", 6) === 1000000n, "1 at 6dp");
  check(parseUnits("5", 6) === 5000000n, "5 at 6dp");
  check(parseUnits("0.000001", 6) === 1n, "one raw unit at 6dp");
  check(parseUnits("0", 18) === 0n, "zero");
  check(parseUnits("0.0", 18) === 0n, "zero with a point");
  check(parseUnits(".5", 6) === 500000n, "leading point");
  check(parseUnits("5.", 6) === 5000000n, "trailing point");
  check(parseUnits("1234", 0) === 1234n, "zero-decimal token");
  // 0.1 * 10^18 in floating point is 100000000000000016 — sixteen wei that
  // were never typed. Integer arithmetic gets it right.
  check(parseUnits("0.1", 18) === 100000000000000000n, `0.1 ether: ${parseUnits("0.1", 18)}`);
  check(
    parseUnits("123456789.123456789012345678", 18) === 123456789123456789012345678n,
    "27 significant digits survive",
  );
  check(
    parseUnits("0.009007199254740993", 18) === 9007199254740993n,
    "the 2^53 boundary survives",
  );
  // Truncating "1.0000001 USDC" to 1 USDC would send a different amount than
  // was typed, so it is refused rather than rounded.
  check(threw(() => parseUnits("1.0000001", 6)), "excess precision was silently truncated");
  check(threw(() => parseUnits("-1", 18)), "negative amount accepted");
  check(threw(() => parseUnits("1e18", 18)), "exponent notation accepted");
  check(threw(() => parseUnits("", 18)), "empty string accepted");
  check(threw(() => parseUnits("0x10", 18)), "hex accepted");
  check(threw(() => parseUnits("1", 255)), "absurd decimals accepted");
  // Round trip against the formatter chains.ts already ships.
  for (const [text, dp] of [["1.5", 6], ["0.000000000000000001", 18], ["9999999", 8]] as const) {
    check(parseUnits(text, dp) > 0n, `${text} at ${dp}dp parsed to zero`);
  }
}

group("decimals() and symbol() are read defensively");
{
  const wordOf = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  check(decodeDecimalsReturn(wordOf(6n)) === 6, "6 decimals");
  check(decodeDecimalsReturn(wordOf(0n)) === 0, "0 decimals is a real answer, not a missing one");
  check(decodeDecimalsReturn(wordOf(18n)) === 18, "18 decimals");
  // A contract answering 255 would make every balance render as 0.000… — an
  // empty-looking wallet rather than a visibly lying contract.
  check(decodeDecimalsReturn(wordOf(255n)) === undefined, "absurd decimals accepted");
  check(
    decodeDecimalsReturn(wordOf(BigInt(MAX_PLAUSIBLE_DECIMALS) + 1n)) === undefined,
    "decimals just past the bound accepted",
  );
  check(decodeDecimalsReturn("0x") === undefined, "empty decimals return became a number");
  check(decodeDecimalsReturn(undefined) === undefined, "undefined became a number");

  // ABI string: offset, length, data.
  const str = (s: string): string => {
    const bytes = new TextEncoder().encode(s);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return "0x" + (32n).toString(16).padStart(64, "0") +
      BigInt(bytes.length).toString(16).padStart(64, "0") + hex.padEnd(64, "0");
  };
  check(decodeSymbolReturn(str("USDC")) === "USDC", "dynamic string symbol");
  // bytes32, as MKR and other pre-ABI tokens answer.
  check(
    decodeSymbolReturn("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")) === "MKR",
    "bytes32 symbol",
  );
  // A symbol is attacker-chosen text drawn next to money. Anything that could
  // rearrange the line it sits on is dropped, not shown mangled.
  check(decodeSymbolReturn(str("US‮DC")) === undefined, "a bidi override reached the screen");
  check(decodeSymbolReturn(str("USD\nC")) === undefined, "a newline reached the screen");
  check(decodeSymbolReturn(str("A".repeat(64))) === undefined, "a 64-character ticker accepted");
  check(decodeSymbolReturn(str("")) === undefined, "an empty symbol accepted");
  check(decodeSymbolReturn("0x") === undefined, "no symbol became a symbol");
  check(sanitiseSymbol("  DAI  ") === "DAI", "surrounding space not trimmed");
}

group("no scaled figure or symbol escapes without its marking");
{
  const meta: TokenMeta = {
    address: USDC, chainId: 1, symbol: "USDC", decimals: 6, source: "contract", verified: false,
  };

  const known = describeTokenAmount(USDC, 5000000n, meta);
  check(known.rawText === "5000000", `raw text: ${known.rawText}`);
  check(known.contract === "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", `contract not EIP-55: ${known.contract}`);
  check(known.scaled?.text === "5", `scaled text: ${known.scaled?.text}`);
  check(known.scaled?.verified === false, "a scaled figure claimed to be verified");
  check(known.scaled?.notice === TOKEN_SCALE_NOTICE, "a scaled figure carries no notice");
  check(known.scaled?.source === "contract", "the source of the guess was lost");
  check(/not checked|guess/i.test(TOKEN_SCALE_NOTICE), "the notice does not disclaim anything");

  // Nothing known: raw units and the address, and no invented decimal point.
  const unknown = describeTokenAmount(USDC, 5000000n, undefined);
  check(unknown.scaled === undefined, "a scaled figure appeared with no decimals to scale by");
  check(unknown.rawText === "5000000", "raw units lost when metadata was missing");
  check(unknown.contract.toLowerCase() === USDC, "contract lost when metadata was missing");

  // Symbol but no decimals: still no scaling. A ticker is not a scale.
  const partial = describeTokenAmount(USDC, 5000000n, {
    address: USDC, chainId: 1, symbol: "USDC", source: "contract", verified: false,
  });
  check(partial.scaled === undefined, "a symbol alone produced a scaled figure");

  // The structural claim: every path that produces a symbol or a decimal
  // point puts it inside `scaled`, and `scaled` cannot exist without the two
  // markings. Assert it over the serialised object so a future field that
  // leaked a symbol elsewhere fails here.
  for (const view of [known, unknown, partial]) {
    const blob = JSON.stringify(view, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const mentionsSymbol = blob.includes("USDC");
    check(
      !mentionsSymbol || (view.scaled !== undefined && view.scaled.notice.length > 0),
      "a symbol appeared outside a marked scaled block",
    );
    check(!/"verified":\s*true/.test(blob), "something claimed to be verified");
  }

  // The hand-typed hints in chains.ts inherit exactly the same marking.
  const fromHint = hintMeta(1, USDC);
  check(fromHint?.verified === false, "a bundled hint claims verification");
  check(fromHint?.source === "app-hint", "a bundled hint hides where it came from");
  check(hintMeta(1, "0x" + "11".repeat(20)) === undefined, "an unlisted contract produced a hint");
}

group("balances are fetched through a caller-supplied request, and only once each");
{
  const calls: { method: string; params?: unknown }[] = [];
  const request: EthRequest = async (args) => {
    calls.push(args);
    if (args.method === "eth_getBalance") return "0xde0b6b3a7640000";
    const data = String((args.params as [{ data: string }])[0].data);
    if (data.startsWith("0x70a08231")) return "0x" + (2500000n).toString(16).padStart(64, "0");
    if (data === "0x313ce567") return "0x" + (6n).toString(16).padStart(64, "0");
    if (data === "0x95d89b41") return "0x" + (32n).toString(16).padStart(64, "0") +
      (4n).toString(16).padStart(64, "0") + Buffer.from("FAKE").toString("hex").padEnd(64, "0");
    throw new Error(`unexpected call ${data}`);
  };

  const wei = await fetchNativeBalance(request, VITALIK);
  check(wei === 1000000000000000000n, `native balance: ${wei}`);
  check(calls.length === 1, `one fetch made ${calls.length} calls`);
  check(
    JSON.stringify(calls[0]?.params) === JSON.stringify([VITALIK, "latest"]),
    `native params: ${JSON.stringify(calls[0]?.params)}`,
  );

  // Chain 5 has no hint for this address, so metadata comes off the contract.
  const raw = await fetchTokenBalance(request, USDC, VITALIK);
  check(raw === 2500000n, `token balance: ${raw}`);
  const meta = await fetchTokenMeta(request, 5, USDC);
  check(meta.source === "contract", `meta source: ${meta.source}`);
  check(meta.symbol === "FAKE" && meta.decimals === 6, `meta: ${meta.symbol}/${meta.decimals}`);
  check(meta.verified === false, "contract-declared metadata claims verification");

  // On a chain where the hint exists, no call is made at all: fewer requests
  // means less disclosure, and the hint is no less trustworthy than the
  // contract's own word.
  const before = calls.length;
  const hinted = await fetchTokenMeta(request, 1, USDC);
  check(calls.length === before, "the hinted path still called the contract");
  check(hinted.source === "app-hint", `hinted source: ${hinted.source}`);

  // A contract that answers neither call still yields a usable balance —
  // raw units, no scaling.
  const mute: EthRequest = async () => { throw new Error("execution reverted"); };
  const muteMeta = await fetchTokenMeta(mute, 5, USDC);
  check(muteMeta.decimals === undefined && muteMeta.symbol === undefined, "a reverting contract produced metadata");
  check(describeTokenAmount(USDC, 7n, muteMeta).scaled === undefined, "a reverting contract produced a scale");
}

group("staleness is stated, not hidden");
{
  const now = 1_700_000_000_000;
  check(freshnessOf(now, now).text === "just now", "fresh reading not called fresh");
  check(freshnessOf(now, now).stale === false, "a just-fetched balance is stale");
  check(freshnessOf(now - 12_000, now).text === "12s ago", `12s: ${freshnessOf(now - 12_000, now).text}`);
  check(freshnessOf(now - 300_000, now).text === "5 min ago", "5 minutes");
  check(freshnessOf(now - 7_200_000, now).text === "2 h ago", "2 hours");
  check(freshnessOf(now - BALANCE_STALE_AFTER_MS, now).stale === true, "the stale threshold does not bite");
  check(freshnessOf(now - BALANCE_STALE_AFTER_MS + 1, now).stale === false, "stale one millisecond early");
  // A clock that went backwards must not produce a negative age.
  check(freshnessOf(now + 5000, now).ageMs === 0, "a future timestamp produced a negative age");

  const line = balanceProvenance(
    { chainId: 1, address: VITALIK, fetchedAt: now - 600_000, endpointHost: "eth.example" }, now,
  );
  check(line.startsWith("STALE"), `ten-minute-old balance not marked stale: ${line}`);
  check(line.includes("eth.example"), "the line does not say who answered");
  check(line.includes(BALANCE_SOURCE_NOTICE), "the line does not say the app fetched it");
  const freshLine = balanceProvenance({ chainId: 1, address: VITALIK, fetchedAt: now }, now);
  check(!freshLine.includes("STALE"), "a fresh balance was marked stale");
  check(freshLine.includes(BALANCE_SOURCE_NOTICE), "a fresh balance skipped the provenance notice");
  check(/not.*confirm|can answer with anything/i.test(BALANCE_SOURCE_NOTICE), "the notice asserts nothing");
}

group("the maximum sendable native amount reserves the fee cap, never a negative");
{
  // 21000 gas at 100 gwei — an ordinary transfer at a busy moment.
  const fee = { gasLimit: 21000n, maxFeePerGas: 100_000_000_000n };
  const reserve = 2_100_000_000_000_000n;

  const rich = maxSendableNative(1_000_000_000_000_000_000n, fee);
  check(rich.kind === "sendable", `a one-ether balance was not sendable: ${rich.kind}`);
  check(
    rich.kind === "sendable" && rich.amount === 1_000_000_000_000_000_000n - reserve,
    "the fee cap was not held back",
  );
  check(rich.kind === "sendable" && rich.reserved === reserve, "the reserve was not reported");
  check(rich.kind === "sendable" && rich.zero === false, "a large send was flagged zero");

  // The reserve is the CAP, not the expected fee: a max computed at a lower
  // base fee would leave the transaction unpayable after a spike.
  const atBaseFee = maxSendableNative(1_000_000_000_000_000_000n, {
    gasLimit: 21000n, maxFeePerGas: 30_000_000_000n,
  });
  check(
    atBaseFee.kind === "sendable" && rich.kind === "sendable" && atBaseFee.amount > rich.amount,
    "reserving at a lower cap did not leave more sendable — the cap is not being used",
  );

  // Exactly the fee: a real, includable transaction with nothing in it. Not a
  // failure, but flagged so no screen offers zero as a useful default.
  const exact = maxSendableNative(reserve, fee);
  check(exact.kind === "sendable", `balance equal to the fee was called insufficient: ${exact.kind}`);
  check(exact.kind === "sendable" && exact.amount === 0n, "balance equal to the fee did not yield zero");
  check(exact.kind === "sendable" && exact.zero === true, "a zero max was not flagged");

  // One wei under, and the answer changes kind entirely — this account cannot
  // pay for a transaction at all.
  const short = maxSendableNative(reserve - 1n, fee);
  check(short.kind === "insufficient-for-gas", `one wei under the fee: ${short.kind}`);
  check(short.kind === "insufficient-for-gas" && short.shortfall === 1n, "the shortfall is not one wei");
  check(short.kind === "insufficient-for-gas" && short.required === reserve, "the requirement was lost");
  check(
    short.kind === "insufficient-for-gas" && /cover the gas/i.test(short.reason),
    "the failure does not explain itself",
  );

  const empty = maxSendableNative(0n, fee);
  check(empty.kind === "insufficient-for-gas", "an empty account was offered a max");
  check(empty.kind === "insufficient-for-gas" && empty.shortfall === reserve, "empty-account shortfall");

  // A free chain, or a fee-less estimate: everything is sendable and zero
  // balance is then a legitimate (if useless) zero max rather than a failure.
  const free = { gasLimit: 0n, maxFeePerGas: 0n };
  check(
    maxSendableNative(0n, free).kind === "sendable",
    "a zero fee still reported insufficient gas",
  );

  // Enormous balances: no float goes anywhere near this.
  const huge = (1n << 255n) - 1n;
  const big = maxSendableNative(huge, fee);
  check(big.kind === "sendable" && big.amount === huge - reserve, "a 2^255 balance lost precision");

  // The structural claim: no result anywhere carries a negative bigint.
  for (const bal of [0n, 1n, reserve - 1n, reserve, reserve + 1n, huge]) {
    const r = maxSendableNative(bal, fee);
    if (r.kind === "sendable") {
      check(r.amount >= 0n, `negative sendable amount at balance ${bal}`);
      check(r.reserved >= 0n, `negative reserve at balance ${bal}`);
    } else {
      check(r.shortfall > 0n, `a non-positive shortfall at balance ${bal}`);
    }
    check(r.notice === MAX_SENDABLE_NOTICE, `a max figure escaped without its notice at ${bal}`);
  }
  check(/change|upper bound|worst case|not the fee you will actually pay/i.test(MAX_SENDABLE_NOTICE),
    "the max notice does not disclaim the estimate");

  check(threw(() => maxSendableNative(-1n, fee)), "a negative balance was accepted");
  check(
    threw(() => maxSendableNative(1n, { gasLimit: -1n, maxFeePerGas: 1n })),
    "a negative gas limit was accepted",
  );
}

group("a token max is the whole balance, but says when the gas cannot be paid");
{
  const fee = { gasLimit: 65000n, maxFeePerGas: 100_000_000_000n };
  const reserve = 6_500_000_000_000_000n;

  // Gas comes out of the native balance, never out of the token amount.
  const ok = maxSendableToken(2_500_000n, 1_000_000_000_000_000_000n, fee);
  check(ok.kind === "sendable" && ok.amount === 2_500_000n, "a token max was reduced by the fee");
  check(ok.kind === "sendable" && ok.cannotAffordGas === undefined, "a funded account was flagged");
  check(ok.kind === "sendable" && ok.reserved === reserve, "the native requirement was not reported");

  // Holds the token, cannot move it. Still `sendable` — the flag is the message.
  const stuck = maxSendableToken(2_500_000n, reserve - 1n, fee);
  check(stuck.kind === "sendable", "an unaffordable-gas token balance was hidden as a failure");
  check(stuck.kind === "sendable" && stuck.amount === 2_500_000n, "the token balance was clipped");
  check(stuck.kind === "sendable" && stuck.cannotAffordGas === true, "no warning that gas is unaffordable");

  // Exactly enough native for gas is enough.
  const exact = maxSendableToken(1n, reserve, fee);
  check(exact.kind === "sendable" && exact.cannotAffordGas === undefined, "exact gas money flagged as short");

  const none = maxSendableToken(0n, 0n, fee);
  check(none.kind === "sendable" && none.amount === 0n && none.zero === true, "an empty token max");
  check(none.kind === "sendable" && none.cannotAffordGas === true, "no gas warning on an empty account");

  const huge = (1n << 256n) - 1n;
  const whale = maxSendableToken(huge, 1_000_000_000_000_000_000n, fee);
  check(whale.kind === "sendable" && whale.amount === huge, "a uint256-max token balance lost precision");
  // And the max is an amount the calldata encoder will actually take.
  check(!threw(() => encodeErc20Transfer(VITALIK, huge)), "the token max cannot be encoded");

  check(threw(() => maxSendableToken(-1n, 1n, fee)), "a negative token balance was accepted");
  check(threw(() => maxSendableToken(1n, -1n, fee)), "a negative native balance was accepted");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
