/**
 * Everything this app reads, and the rule it follows when a read fails.
 *
 * `null` means "not read", never "zero". The mini-app contract is explicit
 * that rendering an empty state because a lookup failed is not allowed, and
 * this is the file where that is either honoured or quietly broken: a vault
 * whose `price()` reverted because the oracle went stale must not render as a
 * share worth nothing. Each field is independently nullable for that reason.
 *
 * Reads go through `AppContext.request`, which is the shell's failover client.
 * An app must not build its own - doing so would route around the endpoint the
 * user chose and the CSP allowlist with it.
 */

import type { EthRequest } from "@leekwallet/core/balances.ts";
import { decodeFunctionResult, encodeFunctionData, type Abi } from "viem";

import { INDICES, MEZO, MUSD, STAKING, type IndexDeployment } from "./addresses.ts";

/* Signatures are the constants; viem derives the selectors. A hardcoded
   four-byte selector is a constant nothing checks. */
const VAULT_ABI = [
  { name: "price", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "reserves", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "liabilities", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "feesAccrued", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "share", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "staking", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "musd", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "feeBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  {
    name: "effectiveFeeBps", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint16" }],
  },
] as const satisfies Abi;

const ERC20_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

const STAKING_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalDistributed", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "pending", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    name: "coolingUntil", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    name: "discountBpsFor", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint16" }],
  },
  { name: "mezo", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const satisfies Abi;

/** One eth_call, decoded, or null if it reverted or answered nonsense. */
async function readOne<T>(
  request: EthRequest,
  to: string,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T | null> {
  try {
    const data = encodeFunctionData({ abi, functionName, args: args as never });
    const raw = await request({ method: "eth_call", params: [{ to, data }, "latest"] });
    if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
    // A revert with no data comes back as "0x" on some nodes rather than an
    // error, and decoding that throws. Treated as not-read, like any revert.
    if (raw === "0x") return null;
    return decodeFunctionResult({ abi, functionName, data: raw as `0x${string}` }) as T;
  } catch {
    /* Deliberately swallowed into null. The caller renders "not read"; what it
       must never do is render a zero it did not read. */
    return null;
  }
}

/** What one index looks like right now. Every figure independently nullable. */
export interface IndexState {
  readonly symbol: string;
  readonly vault: string;
  /** The share token the vault itself names. Null means the vault did not answer. */
  readonly share: string | null;
  /** Whether the vault's own share matches what this build expected. */
  readonly shareMatchesExpectation: boolean | null;
  /** MUSD per share, 18 decimals. Null when the oracle is stale or unreadable. */
  readonly price: bigint | null;
  readonly reserves: bigint | null;
  /** Null when price() reverted: liabilities() calls price(). */
  readonly liabilities: bigint | null;
  readonly feesAccrued: bigint | null;
  /** The fee this address pays, discount already applied by the contract. */
  readonly effectiveFeeBps: number | null;
  readonly baseFeeBps: number | null;
  /** This address's share balance. */
  readonly shares: bigint | null;
  /** MUSD this address has approved to the vault. */
  readonly allowance: bigint | null;
  /**
   * Shares this address has approved to the vault.
   *
   * `redeem` ends in `share.burnFrom(msg.sender, shares)`, and burnFrom spends
   * an allowance, so a redeem without this reverts. Read rather than assumed
   * so the panel can offer the approval instead of letting the device sign a
   * transaction that fails.
   */
  readonly shareAllowance: bigint | null;
  /** Total shares in existence, so "no shares yet" can be told from "unreadable". */
  readonly shareSupply: bigint | null;
}

/** The staking contract, and this address's position in it. */
export interface StakingState {
  readonly totalStaked: bigint | null;
  readonly totalDistributed: bigint | null;
  readonly yourStake: bigint | null;
  readonly yourRewards: bigint | null;
  readonly discountBps: number | null;
  /** Unix seconds until the discount applies, or 0 when it already does. */
  readonly coolingUntil: bigint | null;
  readonly yourMezo: bigint | null;
  readonly mezoAllowance: bigint | null;
}

export interface LeekDefiState {
  readonly indices: readonly IndexState[];
  readonly staking: StakingState;
  readonly musd: bigint | null;
}

async function readIndex(
  request: EthRequest,
  address: string,
  index: IndexDeployment,
): Promise<IndexState> {
  // The share token is asked for rather than assumed, so a stale vault address
  // in this build fails loudly instead of pricing against the wrong token.
  const share = await readOne<string>(request, index.vault, VAULT_ABI, "share");
  const shareToRead = share ?? index.share;

  const [
    price, reserves, liabilities, feesAccrued, effectiveFeeBps, baseFeeBps,
    shares, allowance, shareSupply, shareAllowance,
  ] = await Promise.all([
    readOne<bigint>(request, index.vault, VAULT_ABI, "price"),
    readOne<bigint>(request, index.vault, VAULT_ABI, "reserves"),
    readOne<bigint>(request, index.vault, VAULT_ABI, "liabilities"),
    readOne<bigint>(request, index.vault, VAULT_ABI, "feesAccrued"),
    readOne<number>(request, index.vault, VAULT_ABI, "effectiveFeeBps", [address]),
    readOne<number>(request, index.vault, VAULT_ABI, "feeBps"),
    readOne<bigint>(request, shareToRead, ERC20_ABI, "balanceOf", [address]),
    readOne<bigint>(request, MUSD, ERC20_ABI, "allowance", [address, index.vault]),
    readOne<bigint>(request, shareToRead, ERC20_ABI, "totalSupply"),
    readOne<bigint>(request, shareToRead, ERC20_ABI, "allowance", [address, index.vault]),
  ]);

  return {
    symbol: index.symbol,
    vault: index.vault,
    share,
    shareMatchesExpectation:
      share === null ? null : share.toLowerCase() === index.share.toLowerCase(),
    price, reserves, liabilities, feesAccrued,
    effectiveFeeBps, baseFeeBps, shares, allowance, shareSupply, shareAllowance,
  };
}

/** Read the whole app's state for one address. */
export async function readAll(request: EthRequest, address: string): Promise<LeekDefiState> {
  const [indices, staking, musd] = await Promise.all([
    Promise.all(INDICES.map((index) => readIndex(request, address, index))),
    (async (): Promise<StakingState> => {
      /* Asked for once, before the batch, and used for both MEZO reads. The
         contract is the authority on which token it takes - the constant in
         addresses.ts is only the fallback for a staking contract that did not
         answer, and a wrong answer there would read the wrong balance. */
      const mezo = (await readOne<string>(request, STAKING, STAKING_ABI, "mezo")) ?? MEZO;
      const [
        totalStaked, totalDistributed, yourStake, yourRewards,
        discountBps, coolingUntil, yourMezo, mezoAllowance,
      ] = await Promise.all([
        readOne<bigint>(request, STAKING, STAKING_ABI, "totalSupply"),
        readOne<bigint>(request, STAKING, STAKING_ABI, "totalDistributed"),
        readOne<bigint>(request, STAKING, ERC20_ABI, "balanceOf", [address]),
        readOne<bigint>(request, STAKING, STAKING_ABI, "pending", [address]),
        readOne<number>(request, STAKING, STAKING_ABI, "discountBpsFor", [address]),
        readOne<bigint>(request, STAKING, STAKING_ABI, "coolingUntil", [address]),
        readOne<bigint>(request, mezo, ERC20_ABI, "balanceOf", [address]),
        readOne<bigint>(request, mezo, ERC20_ABI, "allowance", [address, STAKING]),
      ]);
      return {
        totalStaked, totalDistributed, yourStake, yourRewards,
        discountBps, coolingUntil, yourMezo, mezoAllowance,
      };
    })(),
    readOne<bigint>(request, MUSD, ERC20_ABI, "balanceOf", [address]),
  ]);
  return { indices, staking, musd };
}

/** Calldata for the four writes this app proposes. Encoding only; no signing. */
export const encode = {
  approve: (spender: string, amount: bigint) =>
    encodeFunctionData({
      abi: [{
        name: "approve", type: "function", stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }],
      }],
      functionName: "approve",
      args: [spender as `0x${string}`, amount],
    }),
  buy: (musdAmount: bigint, minShares: bigint) =>
    encodeFunctionData({
      abi: [{
        name: "buy", type: "function", stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }],
      }],
      functionName: "buy",
      args: [musdAmount, minShares],
    }),
  redeem: (shares: bigint, minMusd: bigint) =>
    encodeFunctionData({
      abi: [{
        name: "redeem", type: "function", stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }],
      }],
      functionName: "redeem",
      args: [shares, minMusd],
    }),
  stake: (amount: bigint) =>
    encodeFunctionData({
      abi: [{
        name: "stake", type: "function", stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }], outputs: [],
      }],
      functionName: "stake",
      args: [amount],
    }),
  unstake: (amount: bigint) =>
    encodeFunctionData({
      abi: [{
        name: "unstake", type: "function", stateMutability: "nonpayable",
        inputs: [{ type: "uint256" }], outputs: [],
      }],
      functionName: "unstake",
      args: [amount],
    }),
};
