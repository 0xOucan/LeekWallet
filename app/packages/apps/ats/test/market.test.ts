/**
 * The market's two HBAR units, and the descriptors that let the calls be signed.
 *
 * The load-bearing group is the first one. `priceTotal` is tinybar because it
 * is compared against `msg.value`; the transaction's value field is weibar
 * because the relay divides by 1e10 before the contract sees it. Both halves
 * cost a failed transaction to discover, and the check below is the arithmetic
 * one — a wrong ratio here is a plausible number that either reverts
 * `WrongPayment` or is refused by the relay before it arrives.
 *
 * The second group is the one that decides whether any of this can be signed at
 * all: a call with no ERC-7730 descriptor is refused by `screenProposal`, so
 * every call this app builds is put through the real gate here rather than
 * discovered on a device.
 */

import {
  ATS_MARKET, LISTING_WALK_LIMIT, PAYMENT_DECIMALS, TINYBAR_PER_HBAR, WEIBAR_PER_TINYBAR,
  decodeListing, encodeCancel, encodeFill, encodeList, encodeSecurityApprove,
  formatTinybar, hbarText, hbarToTinybar, marketDescriptors, securityApproveDescriptors,
  type Listing,
} from "../src/market.ts";
import { KNOWN_SECURITIES, RETIRED_SECURITIES, retiredAt, securityAt } from "../src/securities.ts";
import { FIXTURE_ADDRESS } from "../src/fixtures.ts";
import { word, addressWord } from "../src/abi.ts";
import { screenProposal } from "@leekwallet/core/app-proposal.ts";
import { DEFAULT_DESCRIPTORS } from "@leekwallet/core/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);
const threw = (fn: () => unknown, pattern: RegExp): boolean => {
  try { fn(); return false; } catch (e) { return pattern.test(String(e)); }
};

const CHAIN = 296;
const SELLER = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const BUYER = "0x9c77c6fafc1eb0821f1de12972ef0199c97c6e45";
const SECURITY = KNOWN_SECURITIES[0]?.address as string;

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: 3n, seller: SELLER, security: SECURITY,
  amount: 100_000_000n, priceTotal: 2_500_000_000n, status: "open", ...over,
});

group("the two HBAR units");
{
  check(TINYBAR_PER_HBAR === 100_000_000n, "1 HBAR is not 1e8 tinybar");
  check(WEIBAR_PER_TINYBAR === 10_000_000_000n, "1 tinybar is not 1e10 weibar");
  check(PAYMENT_DECIMALS === 8, "PAYMENT_DECIMALS is not the contract's 8");

  check(hbarToTinybar("25") === 2_500_000_000n, "25 HBAR is not 2.5e9 tinybar");
  check(hbarToTinybar("0.00000001") === 1n, "one tinybar did not round-trip");
  check(hbarToTinybar("2.5") === 250_000_000n, "2.5 HBAR is not 2.5e8 tinybar");
  check(threw(() => hbarToTinybar("0"), /at least 1 tinybar/), "a zero price was accepted");
  check(threw(() => hbarToTinybar("0.000000001"), /8/),
    "a price below one tinybar was rounded instead of refused");
  check(threw(() => hbarToTinybar("-1"), /decimal/), "a negative price was accepted");

  check(formatTinybar(2_500_000_000n) === "25", "25 HBAR did not format back");
  check(formatTinybar(1n) === "0.00000001", "one tinybar did not format back");

  /* The exact pair of numbers the contract reported in the failure that pinned
   * this down: WrongPayment(2500000000, 25000000000000000000). The first is
   * what msg.value became; the second is what was signed. */
  const call = encodeFill(listing({ priceTotal: 2_500_000_000n }));
  check(call.value === 25_000_000_000_000_000_000n,
    `a fill of 2.5e9 tinybar signs ${call.value}, not 2.5e19 weibar`);
  check(call.value / WEIBAR_PER_TINYBAR === 2_500_000_000n,
    "the value does not divide back to priceTotal");

  /* And the relay's floor: the smallest payable listing must still sign a
   * value of at least one tinybar's worth of weibar. */
  check(encodeFill(listing({ priceTotal: 1n })).value === 10_000_000_000n,
    "the smallest fill is below the relay's floor of 1e10 wei");
}

group("a price is never shown in one unit");
{
  const text = hbarText(2_500_000_000n);
  check(/25 HBAR/.test(text), `no HBAR figure: ${text}`);
  check(/2500000000 tinybar/.test(text), `no tinybar figure: ${text}`);
  check(/25000000000000000000 weibar/.test(text), `no weibar figure: ${text}`);
}

group("a caller cannot choose a fill's value");
{
  /* The defence is structural: encodeFill takes the listing as read from the
   * chain, so there is no argument through which a weibar figure of somebody's
   * own can arrive. This asserts the shape of the function rather than a
   * behaviour, which is the point. */
  check(encodeFill.length === 1, "encodeFill takes something besides the listing");
  check(threw(() => encodeFill(listing({ status: "filled" })), /filled/),
    "a filled listing could be paid for");
  check(threw(() => encodeFill(listing({ status: "cancelled" })), /cancelled/),
    "a cancelled listing could be paid for");
  check(threw(() => encodeFill(listing({ priceTotal: 0n, status: "open" })), /price/),
    "a listing with no price could be paid for");
}

group("calldata");
{
  const l = encodeList(SECURITY, 100n, 2_500_000_000n);
  check(l.to === ATS_MARKET, "list is not aimed at the market");
  check(l.value === 0n, "list carries a transaction value");
  check(l.data.endsWith(word(100n) + word(2_500_000_000n)),
    "list's amount and price are not the last two words");
  check(l.data.includes(addressWord(SECURITY)), "list does not name the security");
  check(encodeCancel(4n).value === 0n, "cancel carries a value");
  check(threw(() => encodeCancel(0n), /start at 1/), "listing id 0 was accepted");
  const a = encodeSecurityApprove(SECURITY, 100n);
  check(a.to === SECURITY, "the approval is not aimed at the security");
  check(a.data.includes(addressWord(ATS_MARKET)), "the approval does not name the market");
  check(a.data.endsWith(word(100n)), "the approval is not sized to the lot");
  check(threw(() => encodeSecurityApprove(SECURITY, 0n), /nothing/),
    "an empty approval was encoded");
}

group("getListing decodes, and a malformed answer is refused whole");
{
  const encoded = "0x" + addressWord(SELLER) + addressWord(SECURITY)
    + word(100n) + word(2_500_000_000n) + word(1n);
  const decoded = decodeListing(3n, encoded);
  check(decoded.seller === SELLER, "the seller did not decode");
  check(decoded.security === SECURITY, "the security did not decode");
  check(decoded.amount === 100n, "the amount did not decode");
  check(decoded.priceTotal === 2_500_000_000n, "the price did not decode");
  check(decoded.status === "open", `status decoded as ${decoded.status}`);
  check(threw(() => decodeListing(1n, "0x" + word(1n)), /five words/),
    "a truncated answer was read as far as it parsed");
  check(threw(() => decodeListing(1n, encoded.slice(0, -64) + word(9n)), /status/),
    "an unknown status was rendered as a state");
  check(LISTING_WALK_LIMIT > 0, "the listing walk is unbounded");
}

group("every market call this app builds can actually be signed");
{
  const calls = [
    encodeList(SECURITY, 100n, 2_500_000_000n),
    encodeCancel(3n),
    encodeFill(listing()),
    encodeSecurityApprove(SECURITY, 100n),
  ];
  for (const call of calls) {
    const proposal = {
      kind: "call" as const, to: call.to, data: call.data, value: call.value, reason: "test",
    };
    const bare = screenProposal(proposal, { chainId: CHAIN, from: BUYER });
    check(bare.kind === "refused", `core already describes ${call.label} — check this test`);

    const offered = call.to === ATS_MARKET
      ? marketDescriptors(CHAIN, call.to)
      : securityApproveDescriptors(CHAIN, call.to);
    check(offered.length === 1, `no descriptor offered for ${call.label}`);
    const screened = screenProposal(proposal, {
      chainId: CHAIN, from: BUYER, descriptors: [...DEFAULT_DESCRIPTORS, ...offered],
    });
    check(screened.kind === "ok",
      `${call.label} is refused: ${screened.kind === "refused" ? screened.why : ""}`);
    if (screened.kind === "ok" && screened.screened.kind === "call") {
      const d = screened.screened.descriptor;
      check(d?.omittedFields === 0, `${call.label}: an argument is not rendered`);
      check((d?.conflicts.length ?? 1) === 0,
        `${call.label}: descriptor and decoder disagree: ${d?.conflicts[0]}`);
      check(screened.screened.value === call.value,
        `${call.label}: the screened value is not the one computed`);
    }
  }
}

group("descriptors are offered for nothing else");
{
  check(marketDescriptors(CHAIN, SECURITY).length === 0,
    "the market's descriptors were offered for a security");
}

group("the securities table");
{
  check(KNOWN_SECURITIES.length === 4, `${KNOWN_SECURITIES.length} securities, expected 4`);
  for (const s of KNOWN_SECURITIES) {
    check(/^0x[0-9a-f]{40}$/.test(s.address), `${s.symbol}: not a lower-case address`);
    check(s.decimals === 6, `${s.symbol}: decimals are not 6`);
    check(securityAt(s.address.toUpperCase())?.symbol === s.symbol,
      `${s.symbol}: lookup is case-sensitive`);
    check(retiredAt(s.address) === undefined, `${s.symbol} is listed as retired`);
  }
  /* The pilot must not be offered as usable, and must not be silently absent
   * either — an address nobody names is an address somebody pastes. */
  check(RETIRED_SECURITIES.length === 1, "the retired pilot is not listed");
  const dead = RETIRED_SECURITIES[0];
  check(dead?.address === "0x651e73ebcf18ef7e050c90af0461d91d640635bb",
    "the retired pilot is not the one that cannot be minted");
  check(/mint/i.test(dead?.why ?? ""), "the retired pilot does not say why it cannot be used");
  check(securityAt(dead?.address as string) === undefined,
    "the retired pilot is offered as a usable security");
  check(securityAt(FIXTURE_ADDRESS) === undefined,
    "the fixture is listed as a real security");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
