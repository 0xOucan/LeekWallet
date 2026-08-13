/**
 * The decodable set, host side — a mirror of `src/eth-decode.c` (T50).
 *
 * Two jobs, and only one of them is security. The mock device uses this to
 * refuse exactly what the firmware refuses: a mock that accepts more than the
 * device certifies broken code, and has twice already. The app uses it to
 * label a transaction before sending it, which is advisory only — a compromised
 * app can render whatever it likes, and the device screen is the authority.
 *
 * Keep the two implementations in step. If this file grows a selector the
 * firmware does not have, the mock stops being a lower bound.
 */

export const CallKind = {
  Empty: "empty",
  Erc20Transfer: "erc20-transfer",
  Erc20Approve: "erc20-approve",
  Unknown: "unknown",
} as const;

export type CallKind = (typeof CallKind)[keyof typeof CallKind];

export interface DecodedCall {
  kind: CallKind;
  /** Recipient for a transfer, spender for an approval. `0x`-prefixed. */
  address?: string;
  /** Raw token units — decimals are not knowable without calling the contract. */
  amount?: bigint;
  /** An allowance beyond any real supply: the pattern behind most drains. */
  unlimited?: boolean;
}

const SEL_TRANSFER = "a9059cbb"; // transfer(address,uint256)
const SEL_APPROVE = "095ea7b3"; // approve(address,uint256)

/** Anything from 2^255 up. See the C implementation for why not just 2^256-1. */
const UNLIMITED_THRESHOLD = 1n << 255n;

function toBytes(data: unknown): Uint8Array | null {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    if (hex.length === 0) return new Uint8Array(0);
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return null;
}

const toHex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function decodeCall(data: unknown): DecodedCall {
  const bytes = toBytes(data);
  if (bytes === null) return { kind: CallKind.Unknown };
  if (bytes.length === 0) return { kind: CallKind.Empty };

  // Exactly a selector and two words. Trailing bytes mean the host encoded
  // something nobody is reading.
  if (bytes.length !== 4 + 32 + 32) return { kind: CallKind.Unknown };

  const selector = toHex(bytes.subarray(0, 4));
  const kind =
    selector === SEL_TRANSFER
      ? CallKind.Erc20Transfer
      : selector === SEL_APPROVE
        ? CallKind.Erc20Approve
        : CallKind.Unknown;
  if (kind === CallKind.Unknown) return { kind };

  // An ABI address is left-padded with zeros. Non-zero padding is not an
  // address, and accepting it lets bytes past the screen.
  for (let i = 4; i < 16; i++) {
    if (bytes[i] !== 0) return { kind: CallKind.Unknown };
  }

  const address = "0x" + toHex(bytes.subarray(16, 36));
  const amount = BigInt("0x" + toHex(bytes.subarray(36, 68)));

  return {
    kind,
    address,
    amount,
    unlimited: kind === CallKind.Erc20Approve && amount >= UNLIMITED_THRESHOLD,
  };
}

/**
 * Whether the device would agree to show this transaction at all.
 *
 * Contract creation is refused for the same reason an unknown selector is:
 * there is nothing the device can name.
 */
export function isDecodable(tx: {
  to?: unknown;
  data?: unknown;
}): { ok: boolean; call: DecodedCall } {
  const to = tx.to;
  const hasTo =
    to instanceof Uint8Array ? to.length === 20 : typeof to === "string" && to.length > 2;
  if (!hasTo) return { ok: false, call: { kind: CallKind.Unknown } };

  const call = decodeCall(tx.data);
  return { ok: call.kind !== CallKind.Unknown, call };
}

/** A short label for the call, for advisory host-side display. */
export function describeCall(call: DecodedCall): string {
  switch (call.kind) {
    case CallKind.Empty:
      return "transfer";
    case CallKind.Erc20Transfer:
      return "token transfer";
    case CallKind.Erc20Approve:
      return call.unlimited ? "UNLIMITED token approval" : "token approval";
    default:
      return "unknown call";
  }
}
