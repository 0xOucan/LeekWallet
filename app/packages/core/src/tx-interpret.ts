/**
 * Host-side transaction interpretation (T48) — a preview, never a verdict.
 *
 * This turns a signing request into something a person can read, the way Rabby
 * does. It is worth building because a hex blob is unreadable and most drains
 * are approvals nobody understood. It is *not* a safety check: everything here
 * runs on the machine we are trying not to trust, so a compromised app can
 * produce a friendly and entirely false summary. The device re-serialises the
 * fields, renders what it computed, and signs only that — see
 * docs/PROTOCOL.md section 6c.
 *
 * So this module deliberately has no `safe`, `verified` or `ok` anywhere in it.
 * The only judgements it makes are negative ones (warnings), because being
 * wrong about a warning costs a second look, and being wrong about an
 * all-clear costs the wallet.
 *
 * Decoding is not repeated here: eth-decode.ts mirrors the firmware, and a
 * second decoder would drift from it.
 */

import { keccak_256 } from "@noble/hashes/sha3";

import { chainName as lookupChainName } from "./chains.ts";
import { CallKind, decodeCall, describeCall, isDecodable } from "./eth-decode.ts";

/** The subset of a signing request that changes what the user is agreeing to. */
export interface TxRequest {
  chainId?: number | bigint;
  /** Absent means contract creation, which the device refuses. */
  to?: string | Uint8Array | undefined;
  value?: bigint | undefined;
  data?: string | Uint8Array | undefined;
  gas?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  /** Pre-1559 fee field; used only when maxFeePerGas is absent. */
  gasPrice?: bigint | undefined;
}

export const WarningCode = {
  UnlimitedApproval: "unlimited-approval",
  DeviceWillRefuse: "device-will-refuse",
  ZeroAddress: "zero-address",
  UnknownChain: "unknown-chain",
} as const;

export type WarningCode = (typeof WarningCode)[keyof typeof WarningCode];

export const WarningSeverity = {
  /** Loses funds if the user is wrong about it. */
  High: "high",
  /** Worth reading before walking to the device. */
  Info: "info",
} as const;

export type WarningSeverity = (typeof WarningSeverity)[keyof typeof WarningSeverity];

export interface TxWarning {
  code: WarningCode;
  severity: WarningSeverity;
  /** One line, plain language, no jargon the user has to look up. */
  message: string;
}

export interface TxInterpretation {
  /** Always true. Present so a caller cannot render this without meeting it. */
  advisory: true;
  kind: CallKind;
  /** Short label: "transfer", "token approval", … */
  action: string;
  /** One line naming the whole transaction, for a heading. */
  summary: string;
  /** Who receives the value or the allowance. Lower-case hex, or undefined. */
  recipient?: string;
  /** The token contract, when the recipient above came out of calldata. */
  contract?: string;
  /** Native value in wei; exact. */
  valueWei: bigint;
  /** Native value in ether as an exact decimal string — no floating point. */
  valueEther: string;
  /** Raw token units. Decimals are not knowable without calling the contract. */
  tokenAmountRaw?: bigint;
  unlimited: boolean;
  chainId: number;
  /** Undefined rather than guessed: a wrong chain name is worse than none. */
  chainName?: string;
  /** gas * maxFeePerGas — a ceiling, not a prediction. Undefined if unknown. */
  maxFeeWei?: bigint;
  maxFeeEther?: string;
  /** The device refuses this before showing a confirmation screen. */
  deviceWillRefuse: boolean;
  warnings: TxWarning[];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const WEI_PER_ETHER = 10n ** 18n;

/**
 * Exact wei → ether. Integer arithmetic throughout: Number cannot hold 18
 * significant digits, so any float here silently changes the amount.
 */
export function formatEther(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_ETHER;
  const frac = (abs % WEI_PER_ETHER).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/**
 * EIP-55 checksum casing — the same rendering `eth_format_address()` produces
 * on the device.
 *
 * Matching it is the point. The user is asked to compare this summary against
 * the device screen, and two strings that differ only in case do not compare
 * equal at a glance; showing a lowercase address here would teach them that
 * case is noise, which is the exact habit EIP-55 exists to prevent.
 */
export function checksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = i % 2 === 0 ? (hash[i >> 1] as number) >> 4 : (hash[i >> 1] as number) & 0x0f;
    const c = lower[i] as string;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

function normaliseAddress(to: string | Uint8Array | undefined): string | undefined {
  if (to instanceof Uint8Array) {
    if (to.length !== 20) return undefined;
    return checksumAddress([...to].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  if (typeof to === "string" && /^0x[0-9a-fA-F]{40}$/.test(to)) {
    return checksumAddress(to.slice(2));
  }
  return undefined;
}

const isZero = (addr: string | undefined) => addr !== undefined && addr === ZERO_ADDRESS;

/**
 * Interpret a transaction for display. Pure: no network, no clock, no ABI
 * lookup. A remote selector registry would leak what you are about to sign to
 * whoever runs it (section 6c), so anything not bundled stays undecoded.
 */
export function interpretTransaction(tx: TxRequest): TxInterpretation {
  const chainId = Number(tx.chainId ?? 0);
  // Names come from the shared registry (chains.ts) so the preview and the
  // chain selector can never disagree about what an ID means.
  const chainName = lookupChainName(chainId);

  const gate = isDecodable({ to: tx.to, data: tx.data });
  // decodeCall on its own so calldata is still labelled when `to` is absent.
  const call = gate.ok ? gate.call : decodeCall(tx.data);

  const valueWei = tx.value ?? 0n;
  const toAddress = normaliseAddress(tx.to);
  const decoded = normaliseAddress(call.address);

  const isToken =
    call.kind === CallKind.Erc20Transfer || call.kind === CallKind.Erc20Approve;

  const recipient = isToken ? decoded : toAddress;
  const unlimited = call.unlimited === true;

  const fee = tx.maxFeePerGas ?? tx.gasPrice;
  const maxFeeWei = tx.gas !== undefined && fee !== undefined ? tx.gas * fee : undefined;

  const warnings: TxWarning[] = [];

  /* Ordered by what costs the most to miss. Unlimited approval first: it is
   * the pattern behind most drain incidents and the one warning that is worth
   * more than everything else in this list combined. */
  if (unlimited) {
    warnings.push({
      code: WarningCode.UnlimitedApproval,
      severity: WarningSeverity.High,
      message:
        `Unlimited approval: ${recipient ?? "a spender"} could move every one of ` +
        `these tokens from this address, at any time in the future, until you revoke it.`,
    });
  }

  /* Said here so the user learns it before walking to the device and being
   * refused there. It is not a warning about the transaction so much as about
   * the next thirty seconds of their life. */
  if (!gate.ok) {
    warnings.push({
      code: WarningCode.DeviceWillRefuse,
      severity: WarningSeverity.High,
      message:
        toAddress === undefined && tx.to === undefined
          ? "Contract creation: the device cannot describe deployed code, so it will refuse to sign this."
          : "The device cannot decode this call, so it will refuse to sign it rather than show you a hash that means nothing.",
    });
  }

  if (isZero(recipient) || (isToken && isZero(toAddress))) {
    warnings.push({
      code: WarningCode.ZeroAddress,
      severity: WarningSeverity.High,
      message: "The recipient is the zero address. Anything sent there is destroyed permanently.",
    });
  }

  if (chainName === undefined) {
    warnings.push({
      code: WarningCode.UnknownChain,
      severity: WarningSeverity.Info,
      message:
        `This app has no name for chain ${chainId}, so it cannot tell you which ` +
        `network this signature would be valid on. Check the number on the device.`,
    });
  }

  const action = describeCall(call);
  const where = chainName ?? `chain ${chainId}`;
  const summary = isToken
    ? call.kind === CallKind.Erc20Approve
      ? unlimited
        ? `Approve UNLIMITED tokens to ${recipient ?? "an unknown spender"} on ${where}`
        : `Approve ${call.amount ?? 0n} raw token units to ${recipient ?? "an unknown spender"} on ${where}`
      : `Send ${call.amount ?? 0n} raw token units to ${recipient ?? "an unknown recipient"} on ${where}`
    : call.kind === CallKind.Empty
      ? `Send ${formatEther(valueWei)} ETH to ${recipient ?? "an unknown address"} on ${where}`
      : `Call ${toAddress ?? "new contract"} on ${where} with calldata this app cannot read`;

  const result: TxInterpretation = {
    advisory: true,
    kind: call.kind,
    action,
    summary,
    valueWei,
    valueEther: formatEther(valueWei),
    unlimited,
    chainId,
    deviceWillRefuse: !gate.ok,
    warnings,
  };

  // exactOptionalPropertyTypes: assign only what exists rather than undefined.
  if (recipient !== undefined) result.recipient = recipient;
  if (isToken && toAddress !== undefined) result.contract = toAddress;
  if (isToken && call.amount !== undefined) result.tokenAmountRaw = call.amount;
  if (chainName !== undefined) result.chainName = chainName;
  if (maxFeeWei !== undefined) {
    result.maxFeeWei = maxFeeWei;
    result.maxFeeEther = formatEther(maxFeeWei);
  }
  return result;
}

/**
 * The sentence that must appear next to any rendering of the above.
 *
 * Exported as a constant so it cannot drift between screens, and so a reviewer
 * can grep for whether it is actually being shown.
 */
export const ADVISORY_NOTICE =
  "This summary is produced by this app, which is not trusted. " +
  "Only what the device shows on its own screen is what gets signed.";
