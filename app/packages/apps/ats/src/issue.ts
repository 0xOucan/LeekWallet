/**
 * Issuing a security from the device: `LeekSecurityFactory`.
 *
 * ---------------------------------------------------------------------------
 * What this file is for
 *
 * The ATS factory's own `deployEquity` takes a seventeen-field nested struct
 * and 3,748 bytes of calldata. The device holds `ETH_MAX_DATA` (768) and
 * refuses anything longer, so that call cannot be signed here and raising the
 * limit would not help: a screen that says "deploy equity?" over 3.7KB nobody
 * held is blind signing with a costume on. `contracts/src/LeekSecurityFactory.sol`
 * moves the template on chain and leaves `deployEquity(string,string)` — the
 * two things that actually vary — and this file is the calldata for it.
 *
 * ---------------------------------------------------------------------------
 * Two refusals, and neither of them is a bug to be worked around
 *
 * **1. There may be no factory.** `LEEK_SECURITY_FACTORY` is now set — the
 * contract was broadcast and verified, see the constant — but the refusal path
 * it used to take is kept exactly as it was, and `planIssue` still takes the
 * address as an argument so a test can drive the unset case. The alternative to
 * an explicit refusal — a default of `0x0000…0000` — produces calldata that
 * encodes perfectly, previews perfectly, and sends a transaction to the zero
 * address. That refusal should now never fire in this build; a refusal that
 * only fires when something is wrong is not dead code, it is the thing that
 * makes clearing the constant a safe edit.
 *
 * **2. The wallet will decline this call, today, and that is structural.**
 * `screenProposal` (core/app-proposal.ts) signs a call only if a bundled
 * ERC-7730 descriptor renders every argument, or the FIRMWARE draws the call
 * itself (`DEVICE_DRAWN_KINDS`, currently Aqua's two). `deployEquity(string,
 * string)` can have neither: `parseSignature` in erc7730.ts refuses any
 * signature containing a dynamic type — correctly, for every descriptor set in
 * this app — and no firmware decoder exists for this selector. So the gate
 * refuses, before the device is reached, and no press is spent.
 *
 * That is written down here rather than discovered on a device. `planIssue`
 * returns the whole plan *and* `deviceWillDecline`, so the panel can show the
 * user what the call is, what it would cost, and the exact reason it will not
 * be signed yet. It is not routed around. The way past it is firmware work —
 * a decoder in `src/eth-decode.c`, a mirror in `eth-decode.ts`, a page in
 * `ui.c`, and this selector added to `DEVICE_DRAWN_KINDS` — which is a change
 * to what a mini-app may ask for and is not this file's to make.
 *
 * Both refusals are values, never throws, for the reason the rest of this app
 * gives: a refusal a caller can read is a refusal a screen can print.
 *
 * ---------------------------------------------------------------------------
 * What the name and the symbol are allowed to be
 *
 * The contract bounds them (1..64 and 1..12 bytes) and reverts outside that.
 * This file bounds them identically — the same numbers, copied from the
 * Solidity, so a refusal happens here rather than after a press — and then
 * narrows further to printable ASCII. The contract has no opinion about that;
 * the SCREEN does. A symbol carrying a bidi override renders as one string on
 * this console and a different one on the device, and the register reader
 * already strips exactly this class of character out of `symbol()` on the way
 * back (`sanitiseText` in abi.ts). Refusing it going out is the same rule
 * pointed the other way.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { selectorOf } from "./abi.ts";

/* ------------------------------------------------------------- the address */

/**
 * The deployed `LeekSecurityFactory` on Hedera testnet (chain 296).
 *
 * Deployed and verified 2026-09-11 by
 * `contracts/script/DeployLeekSecurityFactory.s.sol`:
 *
 *   address   0x3a56974075d734afa5bf7f63e34f9c3237408aed
 *   tx        0x15ec3da4b3601a4e11ef58210991b33e1773961254b1d150f8623c01186e0353
 *   block     40,397,299
 *   sourcify  exact_match, runtime exact_match
 *
 * Confirmed live by `eth_call` on the same day rather than taken from the
 * broadcast file: `FACTORY()` is the ATS factory at
 * `0x00000000000000000000000000000000008c95cf`, `RESOLVER()` is
 * `0xba2d5fc2083a0b8f164c50e65d782087fba18e0a`, `MAX_SUPPLY_SHARES()` is
 * 1,000,000, `MAX_BOND_NOTES()` is 100,000 and `BOND_TERM()` is 31,536,000
 * seconds — the template this file's header describes, as the chain holds it.
 *
 * Lower-case, because every address in this app is compared lower-case and a
 * checksummed constant is one `.toLowerCase()` away from a silent mismatch.
 * `test/issue.test.ts` accepts either this shape or the empty string and
 * nothing in between, so a half-typed edit fails a test rather than a
 * transaction — and clearing it back to `""` puts the panel into its refusal
 * path rather than into the zero address.
 */
export const LEEK_SECURITY_FACTORY = "0x3a56974075d734afa5bf7f63e34f9c3237408aed";

export const FACTORY_UNSET_NOTICE =
  "This build has no address for LeekSecurityFactory, so this console has " +
  "nothing to call and will not build a transaction. Deploy it with " +
  "contracts/script/DeployLeekSecurityFactory.s.sol and put the address in " +
  "LEEK_SECURITY_FACTORY in app/packages/apps/ats/src/issue.ts. Nothing here " +
  "falls back to the zero address: calldata aimed at 0x0000…0000 encodes and " +
  "previews exactly like the real thing, and that is the mistake this refusal " +
  "exists to make impossible.";

/**
 * What the device will show, and the one board state that still refuses.
 *
 * This notice used to say a deploy could not be signed at all. That was true
 * until 2026-09-11, when the firmware gained a decoder for this selector, a
 * mirror in core and three pages on the device; `CallKind.AtsDeployEquity` and
 * `AtsDeployBond` are now in `DEVICE_DRAWN_KINDS`.
 *
 * What has NOT changed is that the preview below is this app's own reading of
 * the bytes it built. It is not a device screen and it is not an approval —
 * the only screen that decides is the one on the device.
 */
export const DEVICE_CANNOT_DRAW_NOTICE =
  "The device draws this call itself: what it creates and that you become " +
  "the issuer holding every role, then the name in full, then the symbol in " +
  "full. Both strings must be printable ASCII, without a leading or trailing " +
  "space, and within the factory's own bounds — anything else is refused " +
  "whole rather than cleaned, because a name that does not read on screen " +
  "the way it reads in the calldata defeats the point of a hardware wallet. " +
  "A board flashed before 2026-09-11 has no decoder for this selector and " +
  "will refuse it; there is no version string in the protocol, so the only " +
  "check is to try. The preview below is this app's own reading of the bytes " +
  "it built; it is not a device screen and it is not an approval.";

/**
 * `ETH_MAX_DATA` from the firmware's `src/eth-tx.h`, mirrored.
 *
 * Copied rather than imported: core keeps its own copy private inside
 * mock-device.ts, and an app reaching into another package's internals to get
 * a number is how two copies drift without either being wrong at the time.
 * The consequence of a stale value here is a plan this app calls acceptable
 * and the device refuses, which is visible; the consequence of not checking at
 * all is the same refusal with nothing on screen explaining it.
 */
export const ETH_MAX_DATA = 768;

/* ------------------------------------------------------------- signatures */

export const ISSUE_SIG = {
  deployEquity: "deployEquity(string,string)",
  deployBond: "deployBond(string,string)",
} as const;

export type IssueKind = keyof typeof ISSUE_SIG;

/** Derived, never typed. A hand-written selector is a call to another function. */
export const ISSUE_SELECTOR: Readonly<Record<IssueKind, string>> = Object.fromEntries(
  Object.entries(ISSUE_SIG).map(([k, v]) => [k, selectorOf(v)]),
) as Record<IssueKind, string>;

/** The two events, and the topic0 each is filtered by. Derived the same way. */
export const ISSUE_EVENT_SIG = {
  deployEquity: "EquityDeployed(address,address,string,string)",
  deployBond: "BondDeployed(address,address,string,string)",
} as const;

const topicOf = (canonical: string): string =>
  `0x${[...keccak_256(new TextEncoder().encode(canonical))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

export const ISSUE_TOPIC: Readonly<Record<IssueKind, string>> = Object.fromEntries(
  Object.entries(ISSUE_EVENT_SIG).map(([k, v]) => [k, topicOf(v)]),
) as Record<IssueKind, string>;

/* ----------------------------------------------------------------- bounds */

/** `MAX_NAME_BYTES` in the Solidity. Bytes, not characters — the contract counts bytes. */
export const MAX_NAME_BYTES = 64;
/** `MAX_SYMBOL_BYTES` in the Solidity. */
export const MAX_SYMBOL_BYTES = 12;

/**
 * Printable ASCII, space included, with the string trimmed of its ends.
 *
 * Narrower than the contract on purpose; see the header. The refusal names
 * what was wrong rather than saying "invalid", because a user who typed a
 * curly quote out of a word processor has no way to see it otherwise.
 */
function checkText(what: string, text: string, maxBytes: number): string | undefined {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes === 0) return `the ${what} is empty, and the contract refuses an empty one`;
  if (bytes > maxBytes) {
    return `the ${what} is ${bytes} bytes; the contract's limit is ${maxBytes}`;
  }
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || c > 0x7e) {
      return (
        `the ${what} contains a character this wallet will not put on a screen ` +
        `(U+${c.toString(16).toUpperCase().padStart(4, "0")}). Names and symbols ` +
        "here are printable ASCII, because a character that renders differently " +
        "on two screens is the one a reader cannot check."
      );
    }
  }
  return undefined;
}

/* --------------------------------------------------------------- encoding */

/** One dynamic `string` argument's tail: length word, then padded bytes. */
function stringTail(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return bytes.length.toString(16).padStart(64, "0") + padded;
}

const offsetWord = (bytes: number): string => bytes.toString(16).padStart(64, "0");

/**
 * `deployEquity(string,string)` / `deployBond(string,string)` calldata.
 *
 * Written out rather than delegated to `encode()` in abi.ts, which handles
 * static arguments only and says so. Two heads of one word each, so the first
 * tail starts at 0x40 and the second starts after it — computed from the first
 * string's padded length, not assumed.
 *
 * Pure, and exported, so `test/issue.test.ts` can check the layout against a
 * decoder rather than against another copy of this arithmetic.
 */
export function encodeDeploy(kind: IssueKind, name: string, symbol: string): string {
  const nameTail = stringTail(name);
  const symbolTail = stringTail(symbol);
  const head = offsetWord(0x40) + offsetWord(0x40 + nameTail.length / 2);
  return `0x${ISSUE_SELECTOR[kind]}${head}${nameTail}${symbolTail}`;
}

/**
 * Read back what `encodeDeploy` wrote, byte for byte, refusing anything else.
 *
 * The preview is decoded from the calldata rather than printed from the form,
 * which is the only version of a preview worth showing: a panel that echoes
 * the input tells you what you typed, not what was encoded. The layout is
 * required to be exactly canonical — offsets where an encoder must have put
 * them, padding zeroed, nothing trailing — for the reason `decodeDynamicTail`
 * in action.ts gives: a tail that merely parses is not a tail the device will
 * agree with.
 */
export function decodeDeploy(
  data: string,
): { kind: IssueKind; name: string; symbol: string } | { ok: false; reason: string } {
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return no("that is not whole-byte hex");
  const body = data.slice(2).toLowerCase();
  const selector = body.slice(0, 8);
  const kind = (Object.keys(ISSUE_SELECTOR) as IssueKind[])
    .find((k) => ISSUE_SELECTOR[k] === selector);
  if (kind === undefined) return no(`selector 0x${selector} is not a deploy call`);

  const args = body.slice(8);
  if (args.length < 128) return no("a deploy call carries two head words");
  const at = (i: number): number => Number(BigInt(`0x${args.slice(i * 64, (i + 1) * 64)}`));

  const readString = (offset: number, what: string): string | { ok: false; reason: string } => {
    if (offset % 32 !== 0) return no(`the ${what} offset is not word-aligned`);
    const start = offset * 2;
    if (start + 64 > args.length) return no(`the ${what} offset is past the calldata`);
    const length = Number(BigInt(`0x${args.slice(start, start + 64)}`));
    const padded = Math.ceil(length / 32) * 32;
    if (start + 64 + padded * 2 > args.length) return no(`the ${what} is truncated`);
    const hex = args.slice(start + 64, start + 64 + length * 2);
    const tail = args.slice(start + 64 + length * 2, start + 64 + padded * 2);
    if (/[^0]/.test(tail)) return no(`the ${what}'s padding is not zero`);
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  };

  if (at(0) !== 0x40) return no("the name is not where a canonical encoder puts it");
  const name = readString(at(0), "name");
  if (typeof name !== "string") return name;
  const expectedSecond = 0x40 + 32 + Math.ceil(new TextEncoder().encode(name).length / 32) * 32;
  if (at(1) !== expectedSecond) {
    return no("the symbol is not where a canonical encoder puts it");
  }
  const symbol = readString(at(1), "symbol");
  if (typeof symbol !== "string") return symbol;

  const consumed = 8 + 128 + (stringTail(name).length + stringTail(symbol).length);
  if (body.length !== consumed) return no("the calldata has bytes after the last argument");
  return { kind, name, symbol };
}

/* ------------------------------------------------------------------ plans */

export interface IssueRequest {
  kind: IssueKind;
  name: string;
  symbol: string;
}

/** What the console would send, and what it already knows about sending it. */
export interface IssuePlan {
  ok: true;
  kind: IssueKind;
  to: string;
  data: string;
  /** Calldata length in bytes, so the ETH_MAX_DATA headroom is visible. */
  dataBytes: number;
  /** The two arguments as DECODED BACK from `data`, never as typed. */
  decoded: { name: string; symbol: string };
  /**
   * False since 2026-09-11: the firmware decodes this selector and draws it.
   *
   * Kept in the shape rather than deleted because it is the honest answer to
   * "will the wallet refuse this before the device sees it?", and a board
   * older than the decoder still refuses — just at the device, with a press
   * spent, rather than at the seam. A caller that stops rendering the notice
   * because this is false would drop the one sentence that explains that.
   */
  deviceWillDecline: false;
  label: string;
}

export interface IssueRefusal {
  ok: false;
  reason: string;
}

/**
 * Turn a form into a plan, or into a sentence saying why there is none.
 *
 * Never throws. The factory address is checked first, because a name that is
 * also too long is a second thing to fix and the user should be told the one
 * that no amount of retyping will solve.
 */
export function planIssue(
  request: IssueRequest,
  factory: string = LEEK_SECURITY_FACTORY,
): IssuePlan | IssueRefusal {
  if (factory.trim() === "") return { ok: false, reason: FACTORY_UNSET_NOTICE };
  if (!/^0x[0-9a-fA-F]{40}$/.test(factory.trim())) {
    return { ok: false, reason: `LEEK_SECURITY_FACTORY is not a 20-byte address: ${factory}` };
  }
  if (/^0x0{40}$/.test(factory.trim())) {
    return {
      ok: false,
      reason:
        "LEEK_SECURITY_FACTORY is the zero address. That is not a deployment, " +
        "and a transaction sent there burns the gas and creates nothing.",
    };
  }

  const name = request.name.trim();
  const symbol = request.symbol.trim();
  const badName = checkText("name", name, MAX_NAME_BYTES);
  if (badName !== undefined) return { ok: false, reason: badName };
  const badSymbol = checkText("symbol", symbol, MAX_SYMBOL_BYTES);
  if (badSymbol !== undefined) return { ok: false, reason: badSymbol };

  const data = encodeDeploy(request.kind, name, symbol);
  const dataBytes = (data.length - 2) / 2;
  if (dataBytes > ETH_MAX_DATA) {
    /* Unreachable at the bounds above — 64 + 12 bytes of text is 228 bytes of
     * calldata — and checked anyway, because the bounds are the contract's and
     * could be raised there without anyone rereading this file. */
    return {
      ok: false,
      reason:
        `this call is ${dataBytes} bytes of calldata and the device holds ` +
        `${ETH_MAX_DATA}. It would be refused after the press rather than before it.`,
    };
  }

  /* Decoded back out of the bytes, so the preview is a reading and not an
   * echo. A disagreement here would be a bug in this file's own encoder, which
   * is exactly the thing a test cannot catch by calling the encoder twice. */
  const read = decodeDeploy(data);
  if ("ok" in read) return { ok: false, reason: `this app could not read back its own calldata: ${read.reason}` };
  if (read.name !== name || read.symbol !== symbol) {
    return {
      ok: false,
      reason: "the calldata this app built does not decode back to what was typed",
    };
  }

  return {
    ok: true,
    kind: request.kind,
    to: factory.trim().toLowerCase(),
    data,
    dataBytes,
    decoded: { name: read.name, symbol: read.symbol },
    deviceWillDecline: false,
    label: `${request.kind === "deployEquity" ? "equity" : "bond"} ${symbol} — ${name}`,
  };
}

/* ----------------------------------------------------------------- asking */

/** What one attempted issuance did. Same vocabulary as act.ts and market.ts. */
export type IssueOutcome =
  /** Signed and broadcast. `result` is the transaction hash. */
  | { kind: "sent"; result: string; plan: IssuePlan }
  /** This console refused. Nothing was asked for; retrying refuses again. */
  | { kind: "refused"; reason: string }
  /** The wallet said no, for a reason it will not tell an app. */
  | { kind: "declined"; notice: string; plan: IssuePlan }
  /** No `propose` at all: no device connected, or a test harness. */
  | { kind: "cannot-ask"; notice: string };

export const ISSUE_NO_DEVICE_NOTICE =
  "Nothing was asked for and nothing was signed: this build has no way to " +
  "reach a device. Connect one and try again.";

export const ISSUE_DECLINED_NOTICE =
  "The wallet did not sign this. Today that is expected rather than a fault — " +
  "see the notice above — and it also covers a rejection on the device and a " +
  "device that is no longer connected. An app is not told which, and the " +
  "reason is in the wallet's own log. Nothing was sent.";

/**
 * Ask for one deployment. One press, no retry — act.ts's rule, same reasons.
 *
 * The attempt is still made rather than short-circuited on `deviceWillDecline`,
 * because that flag is this app's belief about another package's policy, and an
 * app that refuses on its own belief would keep refusing after the policy
 * changed. The gate is core's; this asks it.
 */
export async function runIssue(
  context: AppContext,
  plan: IssuePlan | IssueRefusal,
): Promise<IssueOutcome> {
  if (!plan.ok) return { kind: "refused", reason: plan.reason };
  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", notice: ISSUE_NO_DEVICE_NOTICE };

  const outcome = await propose({
    kind: "call",
    to: plan.to,
    data: plan.data,
    reason: `issue a security: ${plan.label}`.slice(0, 120),
  });
  if (!outcome.ok || outcome.kind !== "call") {
    return { kind: "declined", notice: ISSUE_DECLINED_NOTICE, plan };
  }
  return { kind: "sent", result: outcome.result, plan };
}
