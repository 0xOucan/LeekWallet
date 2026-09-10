/**
 * The tier picker's rules, without a DOM.
 *
 * The load-bearing groups are the two refusals the brief is about: a plan is
 * never produced for a pair the wallet cannot fund, and a one-sided plan is
 * never produced without the sentence that says which side is empty. Both are
 * asserted against the maker's REAL Base holdings (2.5 USDC, no WETH, no
 * cbBTC), so a change that quietly made either case renderable fails here.
 *
 * The band is checked numerically as well as structurally: the read-back is a
 * price a human is meant to recognise, and a unit error would leave it looking
 * like a number and reading like nonsense.
 */

import {
  planTierPosition, ONE_SIDED_NOTICE, BAND_READBACK_NOTICE,
} from "../src/tier-plan.ts";
import { BASE_TOKENS, PAIRS, aquaDescriptors, withSymbols } from "../src/tokens.ts";
import { AQUA_REGISTRY, AQUA_SWAPVM_ROUTER } from "../src/registry.ts";
import { screenProposal } from "@leekwallet/core/app-proposal.ts";
import { DEFAULT_DESCRIPTORS } from "@leekwallet/core/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const MAKER = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const GATE = "0x1111111111111111111111111111111111111111";
const SALT = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const DEADLINE = 1789066619n;

const base = {
  maker: MAKER,
  tier: "medium" as const,
  feePercent: "0.30",
  deadline: DEADLINE,
  gateToken: GATE,
  salt: SALT,
};

/* The maker's measured Base holdings: USDC only. */
const USDC = 2_500_000n;

group("a pair the wallet cannot fund is refused, not warned about");
{
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "weth", amount: 0n, balance: 0n },
      { tokenId: "usdc", amount: 0n, balance: USDC },
    ],
  });
  check(!r.ok, "a plan was produced for a position with nothing on either side");
  if (!r.ok) {
    check(r.refusal.kind === "nothing-to-fund", `refusal kind was ${r.refusal.kind}`);
    check(/WETH/.test(r.refusal.notice) && /USDC/.test(r.refusal.notice),
      "the refusal does not name both empty sides");
  }
}

group("a leg over the balance is refused before any calldata exists");
{
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "weth", amount: 0n, balance: 0n },
      { tokenId: "usdc", amount: USDC + 1n, balance: USDC },
    ],
  });
  check(!r.ok && r.refusal.kind === "short", "an over-balance leg produced a plan");
}

group("an unread balance is not read as zero and not read as enough");
{
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "weth", amount: 0n, balance: 0n },
      { tokenId: "usdc", amount: 1_000_000n },
    ],
  });
  check(!r.ok && r.refusal.kind === "balance-unknown",
    "a plan was built against a balance nobody read");
}

group("the real case: USDC only, on both pairs, is one-sided and says so");
{
  for (const pair of PAIRS) {
    const other = pair.a === "usdc" ? pair.b : pair.a;
    const r = planTierPosition({
      ...base, pairId: pair.id, mid: pair.midExample,
      legs: [
        { tokenId: "usdc", amount: 1_000_000n, balance: USDC, allowance: 0n },
        { tokenId: other, amount: 0n, balance: 0n },
      ],
    });
    check(r.ok, `${pair.id}: a one-sided position was refused`);
    if (!r.ok) continue;
    check(r.sides === "one-sided", `${pair.id}: not reported as one-sided`);
    check(r.emptySide?.address === BASE_TOKENS[other]?.address,
      `${pair.id}: the empty side is not named`);
    check(r.notices.includes(ONE_SIDED_NOTICE), `${pair.id}: ONE_SIDED_NOTICE is missing`);
    check(r.notices.includes(BAND_READBACK_NOTICE), `${pair.id}: the read-back notice is missing`);
    check(r.legs.length === 1, `${pair.id}: an empty leg reached the plan`);
    /* One approval only, for the side that has anything behind it, and it is
     * exactly the amount. An approval for the empty side would be an allowance
     * granted for a position that cannot use it. */
    const approvals = r.plan.steps.filter((s) => s.role === "approve");
    check(approvals.length === 1, `${pair.id}: ${approvals.length} approvals for one funded leg`);
    check(approvals[0]?.amount === 1_000_000n,
      `${pair.id}: the cap is ${approvals[0]?.amount}, not the position's amount`);
    check(approvals[0]?.token === BASE_TOKENS.usdc?.address,
      `${pair.id}: the approval is not for the funded token`);
    check(r.plan.steps.filter((s) => s.role === "ship").length === 1,
      `${pair.id}: not exactly one ship`);
  }
}

group("two funded sides make a two-sided position with two approvals");
{
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "usdc", amount: 1_000_000n, balance: USDC, allowance: 0n },
      { tokenId: "weth", amount: 200_000_000_000_000n, balance: 10n ** 15n, allowance: 0n },
    ],
  });
  check(r.ok, "a fully funded position was refused");
  if (r.ok) {
    check(r.sides === "two-sided", "not reported as two-sided");
    check(r.emptySide === undefined, "a two-sided position named an empty side");
    check(!r.notices.includes(ONE_SIDED_NOTICE), "a two-sided plan carries the one-sided notice");
    check(r.plan.steps.filter((s) => s.role === "approve").length === 2, "not two approvals");
  }
}

group("the band reads back as a price a person recognises");
{
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "usdc", amount: 1_000_000n, balance: USDC, allowance: 0n },
      { tokenId: "weth", amount: 0n, balance: 0n },
    ],
  });
  check(r.ok, "the plan failed");
  if (r.ok) {
    /* medium is 0.7x to 10/7x of the mid: 2800 to 5714.285714. Checked as
     * exact strings, because "about right" is exactly the reading that lets a
     * factor of 1e6 through. */
    check(r.loHuman === "2800", `lower edge is ${r.loHuman}`);
    check(r.hiHuman === "5714.285714", `upper edge is ${r.hiHuman}`);
    check(/USDC per WETH/.test(r.bandText), `the read-back is not in symbols: ${r.bandText}`);
    check(!/0x/.test(r.bandText), `an address survived into the read-back: ${r.bandText}`);
  }
}

group("the read-back never contains a bare hex address");
{
  check(withSymbols(`${BASE_TOKENS.usdc?.address}`) === "USDC", "withSymbols missed a token");
}

group("no tier summary projects a return, in the picker's own copy");
{
  /* The same assertion authoring.test.ts makes, repeated at the point the
   * strings actually reach a screen: a summary is only safe where it is shown,
   * and this module is what shows it. */
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "usdc", amount: 1_000_000n, balance: USDC, allowance: 0n },
      { tokenId: "weth", amount: 0n, balance: 0n },
    ],
  });
  if (r.ok) {
    check(!/yield|apr|apy|profit|guarantee/i.test(r.tierSummary),
      `the tier summary makes a projection: ${r.tierSummary}`);
    for (const text of r.notices) {
      check(!/yield|apr|apy|profit|guarantee/i.test(text), `a notice projects a return: ${text}`);
    }
  }
}

group("the approval this app builds is describable by the wallet");
{
  /* The gap this app's descriptor closes. Core ships no descriptor for any
   * Base mainnet token, so without `aquaDescriptors` the approve step of every
   * plan is declined and the picker cannot ship anything. Asserted in both
   * directions: refused without, accepted with. */
  const r = planTierPosition({
    ...base, pairId: "weth-usdc", mid: "4000",
    legs: [
      { tokenId: "usdc", amount: 1_000_000n, balance: USDC, allowance: 0n },
      { tokenId: "weth", amount: 0n, balance: 0n },
    ],
  });
  check(r.ok, "the plan failed");
  if (r.ok) {
    const approve = r.plan.steps.find((s) => s.role === "approve");
    check(approve !== undefined, "no approval step to screen");
    if (approve) {
      const proposal = {
        kind: "call" as const, to: approve.to, data: approve.data, reason: "test",
      };
      const bare = screenProposal(proposal, { chainId: 8453, from: MAKER });
      check(bare.kind === "refused", "core already describes a Base USDC approve");

      const offered = aquaDescriptors(8453, approve.to);
      check(offered.length === 1, "this app offered no descriptor for its own approval");
      const screened = screenProposal(proposal, {
        chainId: 8453, from: MAKER, descriptors: [...DEFAULT_DESCRIPTORS, ...offered],
      });
      check(screened.kind === "ok", `the approval is still refused: ${screened.kind === "refused" ? screened.why : ""}`);
      if (screened.kind === "ok" && screened.screened.kind === "call") {
        const d = screened.screened.descriptor;
        check(d?.omittedFields === 0, "the descriptor leaves an argument unrendered");
        check((d?.conflicts.length ?? 1) === 0, `descriptor and decoder disagree: ${d?.conflicts[0]}`);
        check(d?.fields.some((f) => f.value.includes(AQUA_REGISTRY.slice(2, 10))
          || f.value.toLowerCase().includes(AQUA_REGISTRY)) === true,
          "the spender on the rendered screen is not the Aqua registry");
      }
    }
  }
}

group("the descriptor is offered for nothing else");
{
  check(aquaDescriptors(8453, AQUA_SWAPVM_ROUTER).length === 0,
    "a descriptor was offered for the router");
  check(aquaDescriptors(1, BASE_TOKENS.usdc?.address as string).length === 0,
    "a Base descriptor was offered on another chain");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
