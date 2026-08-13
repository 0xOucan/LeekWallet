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
  Erc20TransferFrom: "erc20-transfer-from",
  SetApprovalForAll: "set-approval-for-all",
  WethDeposit: "weth-deposit",
  WethWithdraw: "weth-withdraw",
  MintTo: "mint-to",
  Mint: "mint",
  Unknown: "unknown",
} as const;

export type CallKind = (typeof CallKind)[keyof typeof CallKind];

export interface DecodedCall {
  kind: CallKind;
  /**
   * The first address argument: recipient for a transfer, spender for an
   * approval, source for transferFrom, operator for setApprovalForAll.
   */
  address?: string;
  /** transferFrom's destination. Absent when the call has no second address. */
  second?: string;
  /** Raw token units — decimals are not knowable without calling the contract. */
  amount?: bigint;
  /** An allowance beyond any real supply: the pattern behind most drains. */
  unlimited?: boolean;
  /** setApprovalForAll's bool: true grants, false revokes. */
  flag?: boolean;
}

/* The same table as src/eth-decode.c, in the same order and with the same
 * argument shapes. It exists so the mock refuses exactly what the firmware
 * refuses; drifting from that C file is the bug this mirror is for. */
const SEL_TRANSFER = "a9059cbb"; // transfer(address,uint256)
const SEL_APPROVE = "095ea7b3"; // approve(address,uint256)
const SEL_TRANSFER_FROM = "23b872dd"; // transferFrom(address,address,uint256)
const SEL_APPROVAL_ALL = "a22cb465"; // setApprovalForAll(address,bool)
const SEL_DEPOSIT = "d0e30db0"; // deposit()
const SEL_WITHDRAW = "2e1a7d4d"; // withdraw(uint256)
const SEL_MINT_TO = "40c10f19"; // mint(address,uint256)
const SEL_MINT = "a0712d68"; // mint(uint256)

/** Argument shapes, mirroring ArgShape in the C decoder. */
const Shape = {
  None: 0,
  Uint: 1,
  AddrUint: 2,
  AddrBool: 3,
  AddrAddrUint: 4,
} as const;
type Shape = (typeof Shape)[keyof typeof Shape];

const WORDS: Record<Shape, number> = { 0: 0, 1: 1, 2: 2, 3: 2, 4: 3 };

const KNOWN: ReadonlyArray<{ selector: string; kind: CallKind; shape: Shape }> = [
  { selector: SEL_TRANSFER, kind: CallKind.Erc20Transfer, shape: Shape.AddrUint },
  { selector: SEL_APPROVE, kind: CallKind.Erc20Approve, shape: Shape.AddrUint },
  { selector: SEL_TRANSFER_FROM, kind: CallKind.Erc20TransferFrom, shape: Shape.AddrAddrUint },
  { selector: SEL_APPROVAL_ALL, kind: CallKind.SetApprovalForAll, shape: Shape.AddrBool },
  { selector: SEL_DEPOSIT, kind: CallKind.WethDeposit, shape: Shape.None },
  { selector: SEL_WITHDRAW, kind: CallKind.WethWithdraw, shape: Shape.Uint },
  { selector: SEL_MINT_TO, kind: CallKind.MintTo, shape: Shape.AddrUint },
  { selector: SEL_MINT, kind: CallKind.Mint, shape: Shape.Uint },
];

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
  if (bytes.length < 4) return { kind: CallKind.Unknown };

  const selector = toHex(bytes.subarray(0, 4));
  const known = KNOWN.find((k) => k.selector === selector);
  if (!known) return { kind: CallKind.Unknown };

  /* Exact, not "at least". A recognised selector with anything extra behind it
   * is a call that is only half read. */
  if (bytes.length !== 4 + WORDS[known.shape] * 32) return { kind: CallKind.Unknown };

  /* An ABI address is left-padded with zeros. Non-zero padding is not an
   * address, and accepting it lets bytes past the screen. */
  const addressAt = (word: number): string | null => {
    const off = 4 + word * 32;
    for (let i = off; i < off + 12; i++) {
      if (bytes[i] !== 0) return null;
    }
    return "0x" + toHex(bytes.subarray(off + 12, off + 32));
  };
  const uintAt = (word: number): bigint =>
    BigInt("0x" + toHex(bytes.subarray(4 + word * 32, 4 + word * 32 + 32)));

  /* An ABI bool is 0 or 1 and nothing else. Anything else would have to be
   * drawn as "true-ish", and a contract may well read the raw word. */
  const boolAt = (word: number): boolean | null => {
    const off = 4 + word * 32;
    for (let i = off; i < off + 31; i++) {
      if (bytes[i] !== 0) return null;
    }
    const last = bytes[off + 31] as number;
    return last > 1 ? null : last === 1;
  };

  switch (known.shape) {
    case Shape.None:
      return { kind: known.kind };

    case Shape.Uint:
      return { kind: known.kind, amount: uintAt(0) };

    case Shape.AddrUint: {
      const address = addressAt(0);
      if (address === null) return { kind: CallKind.Unknown };
      const amount = uintAt(1);
      return {
        kind: known.kind,
        address,
        amount,
        /* Only an allowance can be unlimited. A mint of 2^255 is absurd but it
         * is still a specific number, and calling it unlimited would name the
         * wrong risk. */
        unlimited: known.kind === CallKind.Erc20Approve && amount >= UNLIMITED_THRESHOLD,
      };
    }

    case Shape.AddrBool: {
      const address = addressAt(0);
      const flag = boolAt(1);
      if (address === null || flag === null) return { kind: CallKind.Unknown };
      return { kind: known.kind, address, flag };
    }

    case Shape.AddrAddrUint: {
      const address = addressAt(0);
      const second = addressAt(1);
      if (address === null || second === null) return { kind: CallKind.Unknown };
      return { kind: known.kind, address, second, amount: uintAt(2) };
    }

    default:
      return { kind: CallKind.Unknown };
  }
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
    case CallKind.Erc20TransferFrom:
      return "token transfer from another account";
    case CallKind.SetApprovalForAll:
      return call.flag ? "APPROVAL FOR ALL tokens" : "revoke approval for all";
    case CallKind.WethDeposit:
      return "wrap";
    case CallKind.WethWithdraw:
      return "unwrap";
    case CallKind.MintTo:
    case CallKind.Mint:
      return "mint";
    default:
      return "unknown call";
  }
}
