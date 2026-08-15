/**
 * Layer A: host-side scam rules — advisory, defeasible, and never a verdict.
 *
 * docs/ANTI-SCAM.md is the argument; this is the implementation of the half of
 * it that runs before a signature exists. Read the framing there before adding
 * a rule, because the framing is what keeps this file from becoming harmful:
 *
 *   - Every finding is a NEGATIVE judgement. There is no rule in here that
 *     returns "this looks fine", and there is no code path that produces a
 *     positive result at all. An empty finding list means this app's rules had
 *     no opinion, which is not the same statement as "safe" and must never be
 *     rendered as one. Being wrong about a warning costs a second look; being
 *     wrong about an all-clear costs the wallet. Same rule tx-interpret.ts
 *     already lives by.
 *   - None of this gates anything. The device refuses what it cannot render
 *     (PROTOCOL.md 6bis) and that refusal is the actual security boundary. A
 *     finding here is a sentence on a screen the attacker may well control.
 *
 * ---------------------------------------------------------------------------
 * Why the pure/impure split is a hard line in this file
 *
 * Everything above the "network-dependent enrichment" heading is a pure
 * function of its arguments: no `fetch`, no `Date.now()`, no module state, no
 * storage. That is not stylistic. A rule that reaches the network turns "is
 * this transaction suspicious" into a question whose answer depends on who
 * answered the RPC, and it discloses the address under inspection to an
 * operator at the exact moment the user is deciding. It also makes the rule
 * untestable without mocking, and a security rule nobody can test exhaustively
 * is a rule nobody should trust.
 *
 * The clock is injected (`nowSeconds`) for the same reason: a deadline rule
 * that reads the wall clock has a different answer every time it runs, so its
 * test either freezes time globally or asserts something weaker than the rule.
 *
 * Exactly one check needs the chain — "is the recipient a contract" needs
 * `eth_getCode` — and it lives at the bottom, async, taking an injected
 * request function, producing findings in the same shape so the UI cannot tell
 * which half it is drawing.
 *
 * ---------------------------------------------------------------------------
 * The one rule the device cannot replace
 *
 * `ruleDomainChainId`. Every other rule here duplicates, in weaker form,
 * something the device also shows on its own screen — the device names an
 * unlimited approval, shows the deadline, shows the verifying contract. The
 * domain `chainId` is different: the device can *display* it, but it has no
 * reference to compare it against. It does not know which network the user
 * believes they are on; only the app's chain selector knows that. So a
 * `chainId` in an EIP-712 domain that does not match the chain the app is
 * pointed at is a cross-check that can only happen here, and a mismatch is a
 * replay setup (ANTI-SCAM.md, "chainId cross-check"). That makes it the one
 * finding in this file that is not merely a convenience.
 */

import { CallKind, decodeCall } from "./eth-decode.ts";
import type { TypedRender } from "./eip712.ts";
import { checksumAddress } from "./tx-interpret.ts";

/* ------------------------------------------------------------- vocabulary */

export const FindingCode = {
  /** `approve` (or a Permit amount) at or beyond any real supply. */
  UnlimitedApproval: "unlimited-approval",
  /** The EIP-712 domain names a different chain than the app is on. */
  DomainChainMismatch: "domain-chain-mismatch",
  /** A signature that stays usable for years. */
  FarFutureDeadline: "far-future-deadline",
  /** A permit-shaped document with no expiry field at all. */
  MissingDeadline: "missing-deadline",
  /** Permit2 is the verifying contract: the spender is the field that matters. */
  Permit2Spender: "permit2-spender",
  /** The recipient has code. Needs `eth_getCode` — see the async section. */
  RecipientIsContract: "recipient-is-contract",
  /** Tokens sent to a token contract, where they are almost always stuck. */
  TokenToTokenContract: "token-to-token-contract",
  /** The recipient resembles an address seen before, but is not it. */
  AddressPoisoning: "address-poisoning",
} as const;

export type FindingCode = (typeof FindingCode)[keyof typeof FindingCode];

export const Severity = {
  /** Loses funds if the user is wrong about it. */
  High: "high",
  /** Changes what the signature means. Read it before walking to the device. */
  Medium: "medium",
  /** Context, not alarm. */
  Info: "info",
} as const;

export type Severity = (typeof Severity)[keyof typeof Severity];

export interface Finding {
  code: FindingCode;
  severity: Severity;
  /** One line, plain language. Never contains text supplied by a dapp. */
  message: string;
  /**
   * The address the finding is about, EIP-55 checksummed, when there is one.
   *
   * Separate from `message` so the UI can give it the prominence a transfer
   * recipient gets rather than burying it mid-sentence — which is the whole
   * point of the Permit2 spender rule.
   */
  subject?: string;
}

/**
 * What the rules are allowed to look at.
 *
 * Deliberately a plain data bag with no methods and no handles to anything
 * live. If a rule needs something not in here, either it belongs in the async
 * section or the caller has to fetch it and put it in the bag — there is no
 * third option where a rule quietly grows a dependency.
 */
export interface RuleContext {
  /** The chain the APP is pointed at. The reference for the domain check. */
  chainId: number;
  /** A transaction about to be signed, in the shape tx-interpret.ts takes. */
  tx?: {
    to?: string | undefined;
    value?: bigint | undefined;
    data?: string | undefined;
  };
  /** Typed data, already inspected by the device's own mirror (eip712.ts). */
  typed?: TypedRender;
  /**
   * Unix seconds. Injected, never read from the clock — see the header.
   * Deadline rules are skipped entirely when it is absent rather than guessed.
   */
  nowSeconds?: number;
  /**
   * Addresses this wallet has interacted with before, in any casing.
   *
   * The poisoning rule's whole basis. It is a *local* history — what this app
   * has seen this user do — not a reputation feed, because a reputation feed
   * would mean sending every address the user touches to a stranger, which is
   * the privacy cost ANTI-SCAM.md rules out.
   */
  knownAddresses?: readonly string[];
  /**
   * Token contract addresses known for this chain, in any casing.
   *
   * From the curated/bundled token list, which is advisory (chains.ts,
   * `TokenHint.verified` is literally `false`). Being in the list is not
   * evidence the address is a token; it is only evidence that somebody listed
   * it, which is enough to raise a warning and not enough to suppress one.
   */
  knownTokens?: readonly string[];
}

/* --------------------------------------------------------------- constants */

/**
 * Uniswap's Permit2, at the same address on every chain it is deployed to.
 *
 * Hardcoded rather than configurable: this is a well-known singleton, and a
 * setting that let it be changed would let a compromised config point the
 * "spender is the field that matters" rule at the wrong contract, which is
 * exactly backwards from what the rule is for.
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * A deadline further out than this is called out.
 *
 * 30 days. Chosen from what legitimate flows actually ask for: a swap's
 * deadline is minutes, a subscription-style permit is weeks, and Permit2's own
 * default expiration is 30 days. Anything past that is a signature that
 * outlives the user's memory of having signed it, which is precisely the
 * property that makes a phished permit fire long after the site is gone.
 */
export const FAR_FUTURE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Leading and trailing hex characters compared for the poisoning rule.
 *
 * Four and four, because that is what wallet UIs truncate to and therefore
 * what a user actually compares — "0x1234…abcd". A poisoning address is mined
 * to match exactly those characters and differ in the forty-eight in between,
 * so matching on fewer would fire on coincidence and matching on more would
 * miss the attack it exists for. Four leading + four trailing is a 1-in-2^32
 * coincidence and a few minutes of GPU time to forge deliberately.
 */
export const POISON_PREFIX = 4;
export const POISON_SUFFIX = 4;

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

const lower = (a: string): string => a.toLowerCase();

/** Checksummed, or undefined if it is not an address at all. */
function normalise(address: string | undefined): string | undefined {
  if (address === undefined || !HEX40.test(address)) return undefined;
  return checksumAddress(address.slice(2));
}

/** Field labels a deadline could live under, matching eip712.ts's own hints. */
const isDeadlineField = (label: string): boolean =>
  ["deadline", "expir", "validuntil", "validbefore"].some((h) =>
    label.toLowerCase().includes(h));

/**
 * Whether a typed-data document is the shape a drainer uses.
 *
 * Permit, PermitSingle, PermitBatch, PermitTransferFrom — everything whose
 * primary type starts with "Permit". Matched on the primary type rather than
 * on the verifying contract because ERC-2612 permits live on the token itself,
 * so there is no single contract to check against; the type name is what the
 * document declares it is, and a document that lies about it hashes to
 * something the contract will not accept.
 */
const isPermitShaped = (render: TypedRender): boolean =>
  /^permit/i.test(render.primaryType);

/* ------------------------------------------------------------- pure rules
 *
 * Each one takes the whole context and returns the findings it has, so they
 * compose by concatenation and each can be called on its own from a test with
 * nothing mocked. A rule that has nothing to say returns an empty array — it
 * never returns a "pass", because there is no such thing here.
 */

/**
 * An allowance beyond any plausible supply, on either path.
 *
 * Both paths, because the two are the same attack wearing different clothes:
 * an on-chain `approve(spender, uint256.max)` and an off-chain Permit for
 * `type(uint160).max` end with the same spender able to move the same tokens.
 * The threshold itself is not re-derived here — eth-decode.ts (mirroring the
 * firmware) decides it for calldata and eip712.ts decides it per declared
 * field width for typed data, and a third opinion in this file would be a
 * third thing to drift.
 */
export function ruleUnlimitedApproval(ctx: RuleContext): Finding[] {
  const out: Finding[] = [];

  if (ctx.tx?.data !== undefined) {
    const call = decodeCall(ctx.tx.data);
    if (call.kind === CallKind.Erc20Approve && call.unlimited === true) {
      const spender = normalise(call.address);
      out.push({
        code: FindingCode.UnlimitedApproval,
        severity: Severity.High,
        message:
          "Unlimited approval: this spender could move every one of these tokens " +
          "from this address, at any time, until you revoke it.",
        ...(spender !== undefined ? { subject: spender } : {}),
      });
    }
  }

  for (const field of ctx.typed?.fields ?? []) {
    if (!field.unlimited) continue;
    out.push({
      code: FindingCode.UnlimitedApproval,
      severity: Severity.High,
      message:
        `Unlimited amount in "${field.label}": this signature would place no ` +
        "limit on how much can be taken.",
    });
  }

  return out;
}

/**
 * The domain `chainId` against the chain the app is on.
 *
 * The one check the device cannot make for itself — see the file header. A
 * mismatch means the signature would be valid somewhere other than where the
 * user thinks they are transacting, which is either a dapp bug or a deliberate
 * replay setup, and the user cannot tell which from the device screen alone.
 *
 * A domain with no `chainId` is not flagged: EIP-712 makes every domain field
 * optional and plenty of legitimate documents omit it. That is a weaker
 * signature (it is valid on every chain) but it is not a mismatch, and
 * inventing a finding for it would train the user to dismiss this one.
 */
export function ruleDomainChainId(ctx: RuleContext): Finding[] {
  const declared = ctx.typed?.chainId;
  if (declared === undefined) return [];
  if (declared === BigInt(ctx.chainId)) return [];
  return [{
    code: FindingCode.DomainChainMismatch,
    severity: Severity.High,
    message:
      `This signature is for chain ${declared}, but this app is on chain ` +
      `${ctx.chainId}. The device shows the chain but has nothing to compare ` +
      "it against, so this mismatch can only be caught here. It is what a " +
      "replay onto another network looks like.",
  }];
}

/**
 * How long the signature stays usable, and whether it says at all.
 *
 * "Valid for 50 years" is the signature of a drainer, not of a swap
 * (ANTI-SCAM.md). Deadlines are read from the fields eip712.ts already marked
 * as deadlines, so this rule and the device's own screen are looking at the
 * same fields.
 *
 * Requires `nowSeconds`. Without a clock the rule produces nothing rather than
 * guessing, because a wrong "expired" or a wrong "far future" on a legitimate
 * permit is how a user learns to ignore the row.
 */
export function ruleDeadline(ctx: RuleContext): Finding[] {
  const render = ctx.typed;
  if (render === undefined) return [];

  const deadlines = render.fields.filter(
    (f) => f.isDeadline && /^\d+$/.test(f.value));

  /* A permit with no expiry at all is worse than one with a distant expiry: it
   * is a signature that never stops being spendable. Only raised for
   * permit-shaped documents, because most typed data legitimately has no
   * deadline and there is nothing suspicious about an order that lacks one. */
  if (deadlines.length === 0) {
    if (!isPermitShaped(render)) return [];
    return [{
      code: FindingCode.MissingDeadline,
      severity: Severity.High,
      message:
        `${render.primaryType} carries no expiry this app can find, so a ` +
        "signature given now could still be submitted years from now.",
    }];
  }

  const now = ctx.nowSeconds;
  if (now === undefined) return [];

  const out: Finding[] = [];
  for (const field of deadlines) {
    const seconds = BigInt(field.value);
    /* Zero is Permit2's spelling for "no expiry" in some fields and a
     * long-expired timestamp in others. Either way it is not a live deadline,
     * and it is reported as an absent one rather than as a date in 1970. */
    if (seconds === 0n) {
      out.push({
        code: FindingCode.MissingDeadline,
        severity: Severity.High,
        message: `"${field.label}" is zero, which is not a limit on how long this signature lasts.`,
      });
      continue;
    }
    const ahead = seconds - BigInt(now);
    if (ahead <= BigInt(FAR_FUTURE_SECONDS)) continue;
    const days = ahead / 86400n;
    out.push({
      code: FindingCode.FarFutureDeadline,
      severity: Severity.Medium,
      message:
        `"${field.label}" keeps this signature usable for about ${days} more ` +
        "days. A swap needs minutes. A signature that lives this long can be " +
        "submitted long after you have forgotten giving it.",
    });
  }
  return out;
}

/**
 * Permit2: name the spender, loudly.
 *
 * With Permit2 the verifying contract is the same singleton for every dapp, so
 * it carries no information about who is being trusted — and the token is not
 * the answer either, because Permit2 already holds allowances for every token
 * the user has ever approved to it. The address that ends up holding the power
 * is the *spender*, and it deserves the prominence a transfer recipient gets
 * (ANTI-SCAM.md, "Permit2 fields specifically"). That is why this returns a
 * finding with `subject` set rather than a line of prose: `subject` is what the
 * UI renders big.
 *
 * Severity is Info by design. Signing a Permit2 permit is a normal thing to do
 * and marking every one of them High would be the boy who cried wolf; what is
 * abnormal is *which* spender, and only the user can judge that.
 */
export function rulePermit2Spender(ctx: RuleContext): Finding[] {
  const render = ctx.typed;
  if (render === undefined) return [];
  if (lower(render.verifyingContract ?? "") !== lower(PERMIT2_ADDRESS)) return [];

  /* "spender" exactly, and dotted forms like "details.spender", because
   * eip712.ts flattens nested structs under a dotted label. */
  const spender = render.fields.find(
    (f) => f.isAddress && /(^|\.)spender$/i.test(f.label));

  const subject = normalise(spender?.value);
  return [{
    code: FindingCode.Permit2Spender,
    severity: Severity.Info,
    message:
      "This is a Permit2 signature. Permit2 holds allowances for every token " +
      "you have ever approved to it, so the spender below — not the contract " +
      "you are signing to — is the address that ends up able to move them.",
    ...(subject !== undefined ? { subject } : {}),
  }];
}

/**
 * Tokens sent to a token contract.
 *
 * A common and expensive mistake rather than an attack: pasting a token's own
 * address into the recipient field, usually because it was the last address on
 * the clipboard. ERC-20 contracts have no obligation to implement a recovery
 * path and most do not, so the tokens are simply gone — same outcome as the
 * zero address, without the honesty of looking like a burn.
 *
 * Two shapes are caught. Sending token X to token X's own contract is decided
 * from the transaction alone and is certain. Sending token X to some *other*
 * listed token contract relies on the advisory token list, so it is worded as
 * "is listed as" rather than "is".
 */
export function ruleTokenToTokenContract(ctx: RuleContext): Finding[] {
  const tx = ctx.tx;
  if (tx?.data === undefined) return [];
  const call = decodeCall(tx.data);
  if (call.kind !== CallKind.Erc20Transfer) return [];

  const recipient = normalise(call.address);
  const contract = normalise(tx.to);
  if (recipient === undefined) return [];

  if (contract !== undefined && lower(recipient) === lower(contract)) {
    return [{
      code: FindingCode.TokenToTokenContract,
      severity: Severity.High,
      message:
        "The recipient is the token contract itself. Tokens sent to their own " +
        "contract are almost never recoverable — most have no way to send them back.",
      subject: recipient,
    }];
  }

  const known = (ctx.knownTokens ?? []).map(lower);
  if (!known.includes(lower(recipient))) return [];
  return [{
    code: FindingCode.TokenToTokenContract,
    severity: Severity.High,
    message:
      "The recipient is listed as a token contract, not a wallet. Tokens sent " +
      "to a token contract are usually unrecoverable. (The list this comes " +
      "from is advisory and unverified.)",
    subject: recipient,
  }];
}

/**
 * Address poisoning: nearly an address you have used, and therefore not one.
 *
 * The attack is a dusting transaction from an address mined to share the first
 * and last few hex characters of one the victim really transacts with. Later,
 * the victim copies the recipient out of their own transaction history,
 * glances at "0x1234…abcd", and pays the attacker.
 *
 * The property that makes this catchable is that the addresses are *near
 * misses by construction*: a match on the truncated form combined with a
 * mismatch in full is not a coincidence anyone reaches by accident. So this
 * rule fires only on the near miss — an exact match is the ordinary case and
 * produces nothing.
 */
export function ruleAddressPoisoning(ctx: RuleContext): Finding[] {
  const tx = ctx.tx;
  if (tx === undefined) return [];

  const call = tx.data === undefined ? undefined : decodeCall(tx.data);
  const target = normalise(
    call?.kind === CallKind.Erc20Transfer ? call.address : tx.to);
  if (target === undefined) return [];

  const key = lower(target).slice(2);
  const head = key.slice(0, POISON_PREFIX);
  const tail = key.slice(-POISON_SUFFIX);

  for (const candidate of ctx.knownAddresses ?? []) {
    if (!HEX40.test(candidate)) continue;
    const other = lower(candidate).slice(2);
    if (other === key) return [];        // it IS the known address. Nothing to say.
    if (other.slice(0, POISON_PREFIX) !== head) continue;
    if (other.slice(-POISON_SUFFIX) !== tail) continue;
    return [{
      code: FindingCode.AddressPoisoning,
      severity: Severity.High,
      message:
        "This address begins and ends like one you have used before " +
        `(${checksumAddress(other)}) but is a different address. That is what ` +
        "address poisoning looks like: an attacker mines a lookalike, dusts " +
        "your history with it, and waits for it to be copied out. Compare all " +
        "forty characters on the device.",
      subject: target,
    }];
  }
  return [];
}

/**
 * Every pure rule, in the order they should be read.
 *
 * Ordered by what costs most to miss, not by code order, because the UI draws
 * the list top-down and a hurried user reads the first line. The list is
 * fixed rather than a registry a caller can extend: a rule set that differs
 * between two screens means two users of the same app are told different
 * things about the same transaction.
 */
export function evaluateRules(ctx: RuleContext): Finding[] {
  return [
    ...ruleUnlimitedApproval(ctx),
    ...ruleDomainChainId(ctx),
    ...ruleTokenToTokenContract(ctx),
    ...ruleAddressPoisoning(ctx),
    ...ruleDeadline(ctx),
    ...rulePermit2Spender(ctx),
  ];
}

/**
 * The sentence that must be shown wherever findings are, including — and
 * especially — when there are none.
 *
 * A constant rather than prose typed at each call site, so a reviewer can grep
 * for whether it is actually rendered, and so no screen can quietly soften it.
 */
export const RULES_NOTICE =
  "These checks run on this computer, which is not the trusted part. They can " +
  "be wrong, and they can be defeated by anything that has already compromised " +
  "this app. An empty list means these rules had no opinion — it is not a " +
  "statement that the transaction is safe.";

/* ------------------------------------- network-dependent enrichment (async)
 *
 * Below this line, functions touch the chain. They are kept apart from the
 * pure rules for the reasons in the header, and they are additive: a caller
 * that never runs them still gets every pure finding, and a failure here
 * returns no findings rather than a wrong one.
 */

/** The same injected-request shape balances.ts and multicall.ts already use. */
export type EthRequest = (args: { method: string; params?: unknown }) => Promise<unknown>;

/**
 * Whether the recipient of a plain value transfer has code.
 *
 * Sending ETH to a contract is normal (that is what a deposit is) and sending
 * it to a contract *by accident* is how it gets lost, because a contract
 * without a payable fallback either reverts — the harmless case — or accepts
 * the value into something with no way to get it out. The user is the only one
 * who can tell those apart, so this states the fact and stops.
 *
 * Only for calls with no calldata. A transaction *with* calldata is by
 * definition addressed to a contract, and saying so would be noise on every
 * token transfer the user ever makes.
 *
 * Failure is silence, deliberately. `eth_getCode` failing means an operator
 * did not answer; it does not mean the address is an EOA, and emitting either
 * a finding or an all-clear from a failed lookup would be inventing a fact.
 * Note the disclosure: asking this tells the operator which address is about
 * to be paid, which is why it is opt-in at the call site rather than part of
 * `evaluateRules`.
 */
export async function enrichRecipientIsContract(
  request: EthRequest,
  ctx: RuleContext,
): Promise<Finding[]> {
  const tx = ctx.tx;
  if (tx === undefined) return [];
  if (tx.data !== undefined && tx.data !== "0x" && tx.data !== "") return [];
  const to = normalise(tx.to);
  if (to === undefined) return [];

  let code: unknown;
  try {
    code = await request({ method: "eth_getCode", params: [to.toLowerCase(), "latest"] });
  } catch {
    return [];
  }
  // Anything that is not whole-byte hex is not an answer about code, and a
  // node that replies with something else has told us nothing.
  if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) return [];
  if (code.length <= 2) return [];

  return [{
    code: FindingCode.RecipientIsContract,
    severity: Severity.Medium,
    message:
      "This address is a contract, not a personal wallet. A plain transfer to " +
      "a contract does whatever its code says — which may be to reject it, or " +
      "to keep it with no way to send it back.",
    subject: to,
  }];
}
