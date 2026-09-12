/**
 * Composing a payment the device will draw.
 *
 * ---------------------------------------------------------------------------
 * What changes about this extension when it can send
 *
 * Until now this was a bridge and nothing else: a dapp composed a transaction,
 * the bytes crossed to the device, and the device decided. The extension never
 * chose a recipient or an amount, so a compromised one could only pass through
 * something a dapp had already proposed.
 *
 * A send form makes the extension the author. It picks `to`, it picks `value`,
 * it builds the ERC-20 calldata. That is a real enlargement of what a bad build
 * could attempt, and it deserves saying rather than burying.
 *
 * What does not change is who decides. The device decodes this calldata itself,
 * from the signature it hashed, and draws the recipient and the amount on its
 * own screen. `transfer(address,uint256)` is row one of its table. So the worst
 * a tampered popup can do is ASK to send somewhere else — and the device will
 * show where, in full, before anything is signed.
 *
 * That only protects a person who reads the device screen. This file is
 * therefore written to push the reader there rather than to look reassuring:
 * nothing here is a substitute for the four seconds of comparison, and the UI
 * says so at the moment of signing rather than in a footnote.
 *
 * ---------------------------------------------------------------------------
 * Everything arithmetic is core's
 *
 * `parseUnits`, `encodeErc20Transfer`, `encodeBalanceOf` and the return
 * decoders come from `@leekwallet/core`, which the companion and the firmware
 * conformance vectors already exercise. A second implementation of decimal
 * parsing is a second place for 1.1 to become 1.0999999, and the one that is
 * wrong is always the one nobody tested.
 */

import {
  encodeErc20Transfer, parseUnits,
} from "../../packages/core/src/balances.ts";

/** A 20-byte hex address. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface SendPlan {
  /** The transaction's `to`: the recipient for native, the token for ERC-20. */
  to: string;
  /** Native value in wei. Zero for an ERC-20 transfer. */
  value: bigint;
  /** Calldata, or undefined for a plain native transfer. */
  data?: string;
  /** Who is actually being paid, for the screen. Not always `to`. */
  recipient: string;
  /** Raw units, for the screen. */
  units: bigint;
}

export type SendResult =
  | { ok: true; plan: SendPlan }
  | { ok: false; reason: string };

/**
 * Build one payment, or say why not.
 *
 * Refuses rather than repairs. Every one of these is a mistake that costs
 * money if it is guessed at instead: an address with a typo, an amount with
 * more decimals than the token has, a zero payment that wastes gas proving
 * nothing.
 */
export function planSend(input: {
  recipient: string;
  amount: string;
  /** Undefined for the chain's native currency. */
  token?: { address: string; decimals: number };
}): SendResult {
  const recipient = input.recipient.trim();
  if (!ADDRESS.test(recipient)) {
    return { ok: false, reason: "That recipient is not a 20-byte address." };
  }
  /* The zero address burns. Some tokens revert on it and some do not, which is
   * worse: the ones that do not take the money and give nothing back. */
  if (/^0x0{40}$/.test(recipient)) {
    return { ok: false, reason: "That is the zero address. Money sent there is gone." };
  }

  const decimals = input.token?.decimals ?? 18;
  let units: bigint;
  try {
    units = parseUnits(input.amount, decimals);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (units <= 0n) {
    return { ok: false, reason: "Enter an amount greater than zero." };
  }

  if (input.token === undefined) {
    return { ok: true, plan: { to: recipient, value: units, recipient, units } };
  }

  const token = input.token.address.trim();
  if (!ADDRESS.test(token)) {
    return { ok: false, reason: "That token contract is not a 20-byte address." };
  }
  /* `to` is the TOKEN for an ERC-20 transfer, and the recipient lives in the
   * calldata. Sending the token's own value field would move the chain's
   * native currency to a contract instead, which is a common and unrecoverable
   * confusion — so both are carried separately and named for what they are. */
  return {
    ok: true,
    plan: {
      to: token,
      value: 0n,
      data: encodeErc20Transfer(recipient, units),
      recipient,
      units,
    },
  };
}
