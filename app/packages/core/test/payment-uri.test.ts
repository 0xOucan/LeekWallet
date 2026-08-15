/**
 * Recipient-scanning tests.
 *
 * The parser's whole job is to refuse, so most of this file is refusals. Four
 * properties in rising order of cost:
 *
 * 1. The three accepted shapes produce the right recipient — in particular the
 *    ERC-20 transfer form, where the recipient is a query parameter and the
 *    path target is the token. Read backwards, that form sends the payment to
 *    the token contract and it is gone.
 * 2. A mixed-case address with a broken EIP-55 checksum is REJECTED. That is
 *    the only defence against a scan that misread a character, and a lenient
 *    parser here loses money silently.
 * 3. Amounts are exact. `1e18` is 10^18 and nothing near it; anything that
 *    cannot be read exactly is refused rather than approximated.
 * 4. Anything else — other schemes, names, other contract calls — is refused
 *    with a reason a user can act on, and nothing throws.
 */

import { parsePaymentUri, type Payment } from "../src/payment-uri.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

/** Parse and assert success, or record the failure and hand back undefined. */
const good = (input: string): Payment | undefined => {
  const r = parsePaymentUri(input);
  if (!r.ok) { check(false, `expected to parse: ${input} (${r.reason})`); return undefined; }
  return r.payment;
};
/** Parse and assert refusal, checking the reason is a sentence, not a code. */
const bad = (input: string, why: string, mentions?: RegExp) => {
  const r = parsePaymentUri(input);
  if (r.ok) { check(false, `accepted and should not have — ${why}: ${input}`); return; }
  check(r.reason.length > 20, `reason for "${input}" is too terse to help: ${r.reason}`);
  if (mentions) check(mentions.test(r.reason), `reason for "${input}" does not explain: ${r.reason}`);
};

const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

group("a bare address parses and comes back checksummed");
{
  const p = good(VITALIK);
  check(p?.kind === "address", `kind: ${p?.kind}`);
  check(p?.recipient === VITALIK, `recipient: ${p?.recipient}`);
  // Single-case carries no checksum information — accepted, and normalised.
  check(good(VITALIK.toLowerCase())?.recipient === VITALIK, "all-lower-case address rejected or not normalised");
  check(
    good("0x" + VITALIK.slice(2).toUpperCase())?.recipient === VITALIK,
    "all-upper-case address rejected or not normalised",
  );
  check(good(`  ${VITALIK}  `)?.recipient === VITALIK, "surrounding whitespace not trimmed");
}

group("EIP-681 native payments");
{
  const plain = good(`ethereum:${VITALIK}`);
  check(plain?.kind === "native", `kind: ${plain?.kind}`);
  check(plain?.recipient === VITALIK, "recipient lost");
  check(plain?.kind === "native" && plain.chainId === undefined, "a chain id was invented");
  check(plain?.kind === "native" && plain.value === undefined, "an amount was invented");

  const chained = good(`ethereum:${VITALIK}@1`);
  check(chained?.kind === "native" && chained.chainId === 1, `chain id: ${JSON.stringify(chained)}`);
  const optimism = good(`ethereum:${VITALIK}@10?value=1`);
  check(optimism?.kind === "native" && optimism.chainId === 10 && optimism.value === 1n, "chain 10 payment");

  // The `pay-` prefix is the same thing spelled longer.
  const prefixed = good(`ethereum:pay-${VITALIK}@1?value=1e18`);
  check(prefixed?.kind === "native", "pay- prefix not understood");
  check(prefixed?.recipient === VITALIK, "pay- prefix ate part of the address");
  check(prefixed?.kind === "native" && prefixed.value === 10n ** 18n, "pay- form lost the value");
  check(good(`ETHEREUM:PAY-${VITALIK.toLowerCase()}`)?.recipient === VITALIK, "upper-case scheme rejected");
}

group("the ERC-20 transfer form: recipient is the parameter, NOT the path target");
{
  // The single most expensive thing this module can get wrong. Reading the
  // path target as the recipient sends USDC to the USDC contract.
  const p = good(`ethereum:${USDC}@1/transfer?address=${VITALIK}&uint256=5000000`);
  check(p?.kind === "token-transfer", `kind: ${p?.kind}`);
  check(p?.recipient === VITALIK, `recipient must be the address= parameter, got ${p?.recipient}`);
  check(p?.kind === "token-transfer" && p.token === USDC, `token must be the path target, got ${p?.kind === "token-transfer" ? p.token : "-"}`);
  check(p?.recipient !== (p?.kind === "token-transfer" ? p.token : ""), "recipient and token are the same address");
  check(p?.kind === "token-transfer" && p.chainId === 1, "chain id lost on the transfer form");
  check(p?.kind === "token-transfer" && p.amount === 5000000n, "raw amount lost");

  // No chain, no amount: still unambiguous about who gets paid.
  const bare = good(`ethereum:${USDC}/transfer?address=${VITALIK}`);
  check(bare?.recipient === VITALIK, "recipient lost without a chain id");
  check(bare?.kind === "token-transfer" && bare.amount === undefined, "an amount was invented");

  // Parameter order must not matter.
  const swapped = good(`ethereum:${USDC}@1/transfer?uint256=1&address=${VITALIK}`);
  check(swapped?.recipient === VITALIK, "parameter order changed the recipient");

  bad(`ethereum:${USDC}@1/transfer?uint256=5000000`, "no recipient at all", /recipient|truncat/i);
  bad(`ethereum:${USDC}@1/transfer?address=vitalik.eth`, "a name as the recipient", /name/i);
  bad(`ethereum:${USDC}@1/transfer?address=0x1234`, "a short recipient", /truncat|40/i);
  // Other functions are refused rather than reinterpreted: an approve scanned
  // as a payment grants an allowance while the user thinks they are sending.
  bad(`ethereum:${USDC}@1/approve?address=${VITALIK}&uint256=1`, "an approve", /approve|transfer/i);
  bad(`ethereum:${USDC}@1/transferFrom?address=${VITALIK}`, "a transferFrom", /transferFrom|transfer/i);
}

group("a broken EIP-55 checksum is refused, everywhere it can appear");
{
  // One character's case flipped: valid hex, valid length, wrong address as
  // far as anything that checks can tell. This is what a misread scan looks
  // like, and it is the only error the format itself can catch.
  const broken: string = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  check(broken !== VITALIK && broken.toLowerCase() === VITALIK.toLowerCase(), "test fixture is not a case flip");
  bad(broken, "a mixed-case address with a bad checksum", /checksum|EIP-55/i);
  bad(`ethereum:${broken}`, "a bad checksum inside an ethereum: URI", /checksum|EIP-55/i);
  bad(`ethereum:${broken}@1?value=1`, "a bad checksum with a chain and value", /checksum/i);
  bad(`ethereum:${USDC}@1/transfer?address=${broken}`, "a bad-checksum token recipient", /checksum/i);
  const brokenToken = "0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  bad(`ethereum:${brokenToken}@1/transfer?address=${VITALIK}`, "a bad-checksum token contract", /checksum/i);
  // The correct one still passes, so the check is not simply rejecting mixed
  // case wholesale.
  check(good(VITALIK)?.recipient === VITALIK, "a correctly checksummed address was refused");
  check(good(USDC)?.recipient === USDC, "a correctly checksummed contract was refused");
}

group("amounts are exact, by integer arithmetic only");
{
  const valueOf = (uri: string): bigint | undefined => {
    const p = good(uri);
    return p?.kind === "native" ? p.value : undefined;
  };
  check(valueOf(`ethereum:${VITALIK}?value=0`) === 0n, "zero value");
  check(valueOf(`ethereum:${VITALIK}?value=1`) === 1n, "one wei");
  // The headline case: 1e18 is one ether to the wei, not 1.0000000000000000e18.
  check(valueOf(`ethereum:${VITALIK}?value=1e18`) === 10n ** 18n, "1e18 is not exactly 10^18");
  check(valueOf(`ethereum:${VITALIK}?value=1000000000000000000`) === 10n ** 18n, "plain wei literal");
  check(valueOf(`ethereum:${VITALIK}?value=2.014e18`) === 2014000000000000000n, "2.014e18");
  // Past 2^53, where a float has already stopped counting in ones.
  check(
    valueOf(`ethereum:${VITALIK}?value=9007199254740993`) === 9007199254740993n,
    "the 2^53 boundary was rounded",
  );
  check(
    valueOf(`ethereum:${VITALIK}?value=1.000000000000000001e18`) === 1000000000000000001n,
    "an exponent form lost its last wei",
  );
  check(valueOf(`ethereum:${VITALIK}?value=123456789012345678901234567890`) === 123456789012345678901234567890n, "a 30-digit amount");

  // Anything that cannot be read exactly is refused, not approximated.
  bad(`ethereum:${VITALIK}?value=1.5`, "fractional wei", /amount|hand/i);
  bad(`ethereum:${VITALIK}?value=-1`, "a negative amount", /amount/i);
  bad(`ethereum:${VITALIK}?value=0x10`, "a hex amount", /amount/i);
  bad(`ethereum:${VITALIK}?value=1e999`, "an absurd exponent", /amount/i);
  bad(`ethereum:${VITALIK}?value=abc`, "a non-numeric amount", /amount/i);
  bad(`ethereum:${VITALIK}?value=`, "an empty amount", /amount/i);
  bad(`ethereum:${USDC}@1/transfer?address=${VITALIK}&uint256=1.5`, "fractional token units", /amount|hand/i);
  check(
    (() => { const p = good(`ethereum:${USDC}@1/transfer?address=${VITALIK}&uint256=1e6`); return p?.kind === "token-transfer" && p.amount === 1000000n; })(),
    "1e6 raw token units",
  );
}

group("names are refused by name, because nothing here could check one");
{
  for (const name of ["vitalik.eth", "ethereum:vitalik.eth", "foo.xyz", "ethereum:pay-alice.eth"]) {
    bad(name, "an ENS-style name", /name|resolution|could not check/i);
  }
  // And the reason must say why rather than just "invalid".
  const r = parsePaymentUri("vitalik.eth");
  check(!r.ok && /0x/.test(r.reason), "the name refusal does not say what to do instead");
}

group("every other scheme, and every malformed address, is refused");
{
  bad("bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "a bitcoin invoice", /Bitcoin|Ethereum/i);
  bad("https://app.uniswap.org", "a web address", /web|address/i);
  bad("wc:abc123@2?relay-protocol=irn&symKey=ff", "a WalletConnect link", /WalletConnect|Connect/i);
  bad("solana:9xQeWv…", "some other chain", /scheme|understand/i);
  bad("", "an empty scan", /Nothing|camera/i);
  bad("   ", "whitespace only", /Nothing|camera/i);
  bad("0x", "a bare 0x", /truncat|hex|40/i);
  bad("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "an address with no 0x", /0x/);
  bad(`${VITALIK}00`, "an over-long address", /too long|42|40/i);
  bad(VITALIK.slice(0, -2), "a truncated address", /truncat|40/i);
  bad("0xZZdA6BF26964aF9D7eEd9e03E53415D37aA96045", "non-hex characters", /hex|damaged/i);
  bad(`ethereum:${VITALIK}@mainnet`, "a chain name instead of a number", /chain/i);
  bad(`ethereum:${VITALIK}@`, "an empty chain id", /chain/i);
  bad("ethereum:", "an empty ethereum URI", /address|0x/i);

  // Nothing above may throw: a camera feeding junk must not take the app down.
  for (const junk of ["ethereum:@@@", "::::", "ethereum:0x/transfer?address=", "ethereum:" + "0".repeat(500), " "]) {
    let threw = false;
    try { parsePaymentUri(junk); } catch { threw = true; }
    check(!threw, `parsing threw on junk input: ${junk.slice(0, 20)}`);
  }
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
