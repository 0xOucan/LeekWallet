/**
 * Mezo's own borrow market, where the MUSD this market settles in comes from.
 *
 * This panel exists because the wallet could buy a share and not obtain the
 * MUSD to buy it with. On Mezo testnet the settlement token is the real MUSD,
 * minted only by locking BTC in Mezo's own market, so a faucet link is not an
 * answer: there is nothing to faucet. Without this the mini-app was a market
 * you could only use if you had already borrowed somewhere else.
 *
 * It is a loan, not a swap. The BTC comes back when the debt is repaid, and it
 * can be liquidated if the collateral ratio falls far enough - which is why
 * the ratio is on screen beside the debt rather than behind a disclosure.
 *
 * Nothing here is a constant that could drift: `troveManager` and `priceFeed`
 * are asked of BorrowerOperations, and `MCR` and `minNetDebt` are read rather
 * than assumed, the same discipline the website uses and the same reason the
 * vault is asked for its own share token. A hardcoded liquidation threshold
 * that the protocol later changed would be a number on a screen that is
 * quietly wrong about when somebody loses their Bitcoin.
 */

import type { EthRequest } from "@leekwallet/core/balances.ts";
import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";

import { BORROWER_OPERATIONS } from "./addresses.ts";

const BORROWER_OPERATIONS_ABI = [
  { name: "minNetDebt", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "MCR", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "troveManager", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "priceFeed", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  /* The liquidation reserve, held back from every loan and returned when the
     position closes. Read, not written down as 200: it is a protocol constant
     today and a number on a screen that is wrong tomorrow if it changes. */
  { name: "MUSD_GAS_COMPENSATION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const TROVE_MANAGER_ABI = [
  {
    name: "getTroveStatus", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    name: "getTroveDebt", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    name: "getTroveColl", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

const PRICE_FEED_ABI = [
  { name: "fetchPrice", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

async function readOne<T>(
  request: EthRequest,
  to: string,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T | null> {
  if (to === "") return null;
  try {
    const data = encodeFunctionData({ abi, functionName, args: args as never });
    const raw = await request({ method: "eth_call", params: [{ to, data }, "latest"] });
    if (typeof raw !== "string" || !raw.startsWith("0x") || raw === "0x") return null;
    return decodeFunctionResult({ abi, functionName, data: raw as `0x${string}` }) as T;
  } catch {
    return null;
  }
}

export interface BorrowState {
  /** 1 means an active position. 0 is none; 2 and up are closed or liquidated. */
  readonly status: bigint | null;
  /** BTC held as collateral, 18 decimals. */
  readonly collateral: bigint | null;
  /** MUSD owed, including the 200 MUSD liquidation reserve. */
  readonly debt: bigint | null;
  /** BTC/USD from Mezo's own feed, 18 decimals. */
  readonly price: bigint | null;
  /** The minimum collateral ratio, 18-decimal fixed point: 1.1e18 is 110%. */
  readonly mcr: bigint | null;
  /** The smallest debt the protocol will open a position with. */
  readonly minNetDebt: bigint | null;
  /**
   * The liquidation reserve, added on top of what you borrow.
   *
   * It is part of the DEBT but not part of what reaches your wallet, which is
   * why the ratio has to be computed against debt plus this and not against
   * the figure typed into the form. Getting that wrong makes the preview more
   * optimistic than the protocol and sends the device a transaction that
   * reverts.
   */
  readonly reserve: bigint | null;
}

/** Read the signer's position in Mezo's borrow market. */
export async function readBorrow(request: EthRequest, address: string): Promise<BorrowState> {
  const [minNetDebt, mcr, troveManager, priceFeed, reserve] = await Promise.all([
    readOne<bigint>(request, BORROWER_OPERATIONS, BORROWER_OPERATIONS_ABI, "minNetDebt"),
    readOne<bigint>(request, BORROWER_OPERATIONS, BORROWER_OPERATIONS_ABI, "MCR"),
    readOne<string>(request, BORROWER_OPERATIONS, BORROWER_OPERATIONS_ABI, "troveManager"),
    readOne<string>(request, BORROWER_OPERATIONS, BORROWER_OPERATIONS_ABI, "priceFeed"),
    readOne<bigint>(request, BORROWER_OPERATIONS, BORROWER_OPERATIONS_ABI, "MUSD_GAS_COMPENSATION"),
  ]);

  const [status, debt, collateral, price] = await Promise.all([
    readOne<bigint>(request, troveManager ?? "", TROVE_MANAGER_ABI, "getTroveStatus", [address]),
    readOne<bigint>(request, troveManager ?? "", TROVE_MANAGER_ABI, "getTroveDebt", [address]),
    readOne<bigint>(request, troveManager ?? "", TROVE_MANAGER_ABI, "getTroveColl", [address]),
    readOne<bigint>(request, priceFeed ?? "", PRICE_FEED_ABI, "fetchPrice"),
  ]);

  return { status, collateral, debt, price, mcr, minNetDebt, reserve };
}

/**
 * The collateral ratio in basis points, or null when it cannot be computed.
 *
 * Null rather than a large number when there is no debt: a position owing
 * nothing has no ratio, and infinity rendered as a figure is the same mistake
 * as a vault's backing rendered as 0% because nothing was owed.
 */
export function collateralRatioBps(state: BorrowState): number | null {
  const { collateral, debt, price } = state;
  if (collateral === null || debt === null || price === null) return null;
  if (debt === 0n) return null;
  return Number((collateral * price * 10_000n) / (debt * 10n ** 18n));
}

/** True when a position exists and is open. */
export const hasPosition = (state: BorrowState): boolean =>
  state.status === 1n && (state.debt ?? 0n) > 0n;

/** Calldata for the four borrow writes. Encoding only; no signing. */
const HINTS = [
  { type: "uint256" }, { type: "address" }, { type: "address" },
] as const;

/**
 * Both hints are the zero address.
 *
 * They are a list-insertion optimisation: supplying the neighbours of where a
 * trove lands saves gas walking the sorted list. Zero means "start from the
 * head", which costs more gas and is always correct. Computing real hints
 * needs a full read of the sorted list, and getting them wrong costs gas
 * rather than correctness - so the cheap-to-verify option wins here, on a
 * testnet where gas is a faucet away.
 */
const ZERO = "0x0000000000000000000000000000000000000000" as const;

export const encodeBorrow = {
  openTrove: (debtAmount: bigint) =>
    encodeFunctionData({
      abi: [{ name: "openTrove", type: "function", stateMutability: "payable", inputs: HINTS, outputs: [] }],
      functionName: "openTrove",
      args: [debtAmount, ZERO, ZERO],
    }),
  withdrawMUSD: (amount: bigint) =>
    encodeFunctionData({
      abi: [{ name: "withdrawMUSD", type: "function", stateMutability: "nonpayable", inputs: HINTS, outputs: [] }],
      functionName: "withdrawMUSD",
      args: [amount, ZERO, ZERO],
    }),
  repayMUSD: (amount: bigint) =>
    encodeFunctionData({
      abi: [{ name: "repayMUSD", type: "function", stateMutability: "nonpayable", inputs: HINTS, outputs: [] }],
      functionName: "repayMUSD",
      args: [amount, ZERO, ZERO],
    }),
  closeTrove: () =>
    encodeFunctionData({
      abi: [{ name: "closeTrove", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] }],
      functionName: "closeTrove",
      args: [],
    }),
};
