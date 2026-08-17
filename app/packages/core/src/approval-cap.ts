/**
 * Capping an approval before it reaches the device.
 *
 * "My balance is 20k of USDT but I want to supply only 500, so I should be able
 * to approve only 500." Until now a dapp's `approve(spender, uint256.max)`
 * arrived as a take-it-or-leave-it: sign the unlimited allowance or refuse the
 * request and go without the dapp. docs/ANTI-SCAM.md is blunt about the cost of
 * the first option — the unlimited allowance is the standing permission every
 * later drain is spent through, and it outlives the session that granted it by
 * years. This module builds the third answer: same request, smaller number.
 *
 * ---------------------------------------------------------------------------
 * What this does NOT do
 *
 * It does not make an approval safe, and no string in here says it does. A
 * capped approval to a malicious spender loses exactly the capped amount, which
 * is a smaller loss and not a prevented one. And every number produced here is
 * still host-side: what makes the figure real is that it is re-encoded into
 * calldata the DEVICE decodes and draws on its own screen, so the user confirms
 * the capped amount against hardware and not against this app's arithmetic. If
 * the app were compromised and re-encoded something else, the device screen
 * would say so. That property is the whole reason the edit is allowed to exist
 * here at all.
 *
 * ---------------------------------------------------------------------------
 * The USDT problem, which is the whole reason this file has a planner
 *
 * Tether's `approve` requires the current allowance to be zero before it will
 * accept a non-zero one — a mitigation for the old approve-race, kept by a
 * long tail of tokens that copied it. That is precisely the token the request
 * above names. Sending one capped `approve` against a live non-zero allowance
 * on such a token produces a revert: gas spent, allowance unchanged, and a user
 * who was told the cap had been applied. So a cap over an existing non-zero
 * allowance is planned as TWO transactions — set to zero, then set to the cap —
 * each one signed on the device on its own. The zero-first sequence is planned
 * from a *reading of the current allowance*, not from a list of token addresses
 * known to behave this way: a list is a thing to be missing from, and the
 * sequence is harmless on tokens that did not need it.
 *
 * Pure: no network, no clock, no DOM. The allowance reading is passed in.
 */

import {
  encodeErc20Approve, encodePermit2Approve, isUnlimited, SELECTOR_PERMIT2_APPROVE,
} from "./allowances.ts";
import { AbiError, parseUnits } from "./balances.ts";
import { CallKind, decodeCall } from "./eth-decode.ts";
import { PERMIT2_ADDRESS } from "./rules.ts";

/* --------------------------------------------------------------- inspection */

/** Which of the two approval shapes a request turned out to be. */
export type ApprovalStandard = "erc20" | "permit2";

/** An approval this app knows how to re-encode with a different amount. */
export interface ApprovalCall {
  standard: ApprovalStandard;
  /** The token whose allowance is being granted. */
  token: string;
  /** The address that ends up holding the power. */
  spender: string;
  /** As requested by the dapp, in raw units. */
  amount: bigint;
  /** The dapp's amount is beyond any real supply. Same word used everywhere. */
  unlimited: boolean;
  /** The width of the amount field, which bounds any replacement. */
  bits: 256 | 160;
  /** Permit2 only: carried through an edit untouched. */
  expiration?: bigint;
}

const UINT48_MAX = (1n << 48n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;

/**
 * Permit2's `approve(address,address,uint160,uint48)`, decoded strictly.
 *
 * Strictly meaning: exact length, zero padding on both addresses, and each
 * narrow field actually inside its declared width. The reasons are the ones
 * eth-decode.ts gives for the ERC-20 shapes — a call that is only half read is
 * a call whose edit would be applied to bytes nobody looked at — and the
 * consequence of being lax here is worse than a bad label, because this
 * decoding decides what gets re-encoded.
 */
function decodePermit2Approve(data: string): Omit<ApprovalCall, "standard" | "bits"> | undefined {
  const body = data.slice(10);
  if (body.length !== 4 * 64) return undefined;
  const wordAt = (i: number): string => body.slice(i * 64, (i + 1) * 64);
  const addressAt = (i: number): string | undefined => {
    const w = wordAt(i);
    return /^0{24}[0-9a-fA-F]{40}$/.test(w) ? `0x${w.slice(24).toLowerCase()}` : undefined;
  };
  const token = addressAt(0);
  const spender = addressAt(1);
  if (token === undefined || spender === undefined) return undefined;
  const amount = BigInt(`0x${wordAt(2)}`);
  const expiration = BigInt(`0x${wordAt(3)}`);
  if (amount > UINT160_MAX || expiration > UINT48_MAX) return undefined;
  return { token, spender, amount, unlimited: isUnlimited(amount, 160), expiration };
}

/* Derived from the signature by allowances.ts, not typed in as four bytes —
 * see that file's header on why a copied selector is a bug with no symptom. */
const SELECTOR_PERMIT2_APPROVE_HEX = `0x${SELECTOR_PERMIT2_APPROVE}`;

/**
 * Is this transaction an approval whose amount the user may cap?
 *
 * The ERC-20 case defers to `decodeCall` — the mirror of the firmware's own
 * decoder — for both the parse and the unlimited verdict. Deciding here whether
 * a number counts as unlimited would be a third opinion on a threshold that
 * already exists in two places that must agree, and the one that would be shown
 * on the device is not this one.
 */
export function inspectApproval(
  tx: { to?: string | undefined; data?: string | undefined },
): ApprovalCall | undefined {
  const to = tx.to;
  const data = tx.data ?? "0x";
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) return undefined;
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return undefined;

  if (data.toLowerCase().startsWith(SELECTOR_PERMIT2_APPROVE_HEX)) {
    /* Only at Permit2 itself. The same four bytes on some other contract are a
     * function this app has never read, and the device would refuse it anyway;
     * offering an amount box for it would be this app claiming to know a shape
     * it does not. */
    if (to.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) return undefined;
    const decoded = decodePermit2Approve(data.toLowerCase());
    return decoded === undefined ? undefined : { standard: "permit2", bits: 160, ...decoded };
  }

  const call = decodeCall(data);
  if (call.kind !== CallKind.Erc20Approve || call.address === undefined) return undefined;
  return {
    standard: "erc20",
    /* For an ERC-20 approval the token is the contract being called; the
     * spender is the argument. Getting these the wrong way round would read the
     * allowance of the wrong pair and mis-plan the zero-first step. */
    token: to.toLowerCase(),
    spender: call.address,
    amount: call.amount ?? 0n,
    unlimited: call.unlimited === true,
    bits: 256,
  };
}

/* ------------------------------------------------------------ the new amount */

/**
 * Token units in, raw units out — or a refusal, never a guess.
 *
 * `parseUnits` from balances.ts does the arithmetic, and it already refuses
 * more fractional digits than the token claims rather than truncating, which is
 * the behaviour this needs: "500.1234567" against a 6-decimal token is an
 * amount the user has in mind and this app cannot represent, and silently
 * dropping the last digit would approve a number nobody typed.
 *
 * `decimals` is the token's own self-declared value or an unchecked list entry
 * (PROTOCOL.md 6d) — it is never evidence, which is why the caller must show
 * the raw result and the contract address beside whatever it renders.
 */
export function parseCapAmount(text: string, decimals: number, bits: 256 | 160): bigint {
  const raw = parseUnits(text, decimals);
  const max = (1n << BigInt(bits)) - 1n;
  if (raw > max) throw new AbiError(`that amount does not fit this approval's uint${bits}`);
  return raw;
}

/* ------------------------------------------------------------- the sentences
 *
 * Constants, not inline strings: these are the three claims the feature turns
 * on, a reviewer should be able to grep for whether each one is actually drawn,
 * and none of them may drift into a softer version on one screen.
 */

/**
 * Said at the point of edit, every time, before anything is sent.
 *
 * The failure this names is real and costs money: a swap that quoted against a
 * 1000-token allowance reverts at 500, on chain, at the user's expense, and the
 * dapp has no idea because nothing tells it the number changed.
 */
export const APPROVAL_EDIT_NOTICE =
  "Changing this amount changes what the dapp asked for, and the dapp is not " +
  "told. If it needs more than you approve, its next transaction will fail on " +
  "chain and you will pay the gas for that failure. Capping does not make an " +
  "approval safe either — a capped approval to a thief loses the capped " +
  "amount. What makes it real is the device: check the amount on its screen " +
  "before you approve there.";

/** Said whenever the zero-first sequence is planned. Names the token class. */
export const ZERO_FIRST_NOTICE =
  "This token already has a non-zero allowance for this spender, and tokens of " +
  "the USDT kind refuse to move from one non-zero allowance straight to " +
  "another — that approval would revert and cost gas for nothing. So the cap " +
  "goes as two transactions: set the allowance to zero, then set it to your " +
  "amount. You approve each one separately on the device, and if you stop " +
  "after the first the allowance is zero and the dapp will not work.";

/**
 * Said when the sequence is needed and this app is not the one broadcasting.
 *
 * `eth_signTransaction` hands the signed bytes back to the dapp, which decides
 * whether and when to send them — so a two-transaction sequence cannot be
 * ordered from here at all. Handing the dapp a capped approval that will revert
 * against its live allowance would be the silent failure this file exists to
 * avoid, so the cap is declined with the reason rather than half-applied.
 */
export const SEQUENCE_NEEDS_BROADCAST_NOTICE =
  "This token needs its allowance set to zero first, and this dapp asked for a " +
  "signature it will broadcast itself — so this app cannot order the two " +
  "transactions. Set the allowance to zero from the approvals list first, then " +
  "ask the dapp again, or let it request the amount you want.";

/** Said when the current allowance could not be read at all. */
export const ALLOWANCE_UNREADABLE_NOTICE =
  "This app could not read the current allowance, so it cannot tell whether " +
  "this token needs the allowance set to zero first. The single approval below " +
  "is what will be sent; on a USDT-style token with an allowance already set, " +
  "it will revert on chain.";

/* --------------------------------------------------------------- the planner */

/** One transaction in a cap, already encoded. */
export interface CapStep {
  /** Re-encoded calldata. The device decodes this itself and draws it. */
  data: string;
  /** Raw units this step sets the allowance to. */
  amount: bigint;
  /** This app's own words for what the step does. Nothing dapp-authored. */
  label: string;
}

export interface CapPlan {
  steps: CapStep[];
  /** True when the plan is the two-transaction sequence. */
  zeroFirst: boolean;
  /** Everything the UI must say, in order. Always contains the edit notice. */
  notices: string[];
}

/**
 * Build the transaction (or the pair) that applies a cap.
 *
 * `current` is the allowance read off chain, or undefined when nobody could
 * read it. Undefined is deliberately *not* treated as zero: assuming zero is
 * what produces the silent revert this file exists to avoid, so the caller is
 * handed `ALLOWANCE_UNREADABLE_NOTICE` and the honest single transaction.
 *
 * Permit2 never gets the sequence. Its `approve` overwrites the stored amount
 * unconditionally — the zero-first dance is an ERC-20 token behaviour and
 * Permit2 is one contract whose source says otherwise.
 */
export function planCap(
  call: ApprovalCall,
  newAmount: bigint,
  current: bigint | undefined,
): CapPlan {
  if (newAmount < 0n) throw new AbiError("an allowance cannot be negative");
  const max = (1n << BigInt(call.bits)) - 1n;
  if (newAmount > max) throw new AbiError(`that amount does not fit a uint${call.bits}`);

  const encode = (amount: bigint): string =>
    call.standard === "permit2"
      ? encodePermit2Approve(call.token, call.spender, amount, call.expiration ?? 0n)
      : encodeErc20Approve(call.spender, amount);

  const notices = [APPROVAL_EDIT_NOTICE];

  /* Zero is its own answer: setting an allowance to zero is a revoke, and a
   * revoke never needs the zero-first step because it *is* the zero step. */
  const needsSequence =
    call.standard === "erc20" && newAmount > 0n && current !== undefined && current > 0n;

  if (call.standard === "erc20" && newAmount > 0n && current === undefined) {
    notices.push(ALLOWANCE_UNREADABLE_NOTICE);
  }

  if (!needsSequence) {
    return {
      steps: [{ data: encode(newAmount), amount: newAmount, label: capLabel(newAmount) }],
      zeroFirst: false,
      notices,
    };
  }

  notices.push(ZERO_FIRST_NOTICE);
  return {
    steps: [
      { data: encode(0n), amount: 0n, label: "Step 1 of 2: set the allowance to zero" },
      {
        data: encode(newAmount),
        amount: newAmount,
        label: `Step 2 of 2: ${capLabel(newAmount)}`,
      },
    ],
    zeroFirst: true,
    notices,
  };
}

const capLabel = (amount: bigint): string =>
  amount === 0n
    ? "set the allowance to zero"
    : `set the allowance to ${amount} raw units`;
