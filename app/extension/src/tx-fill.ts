/**
 * Turning a dapp's transaction request into the unsigned transaction a
 * device signs, filled in from the chain.
 *
 * One function for both signing paths. The USB path sends the fields to the
 * device as CBOR; the QR path sends the RLP as an eth-sign-request. Two
 * copies of "which nonce, which fees" would be two answers to a question
 * whose wrong answer is a stuck transaction or one that replaces another.
 */

import {
  createPublicClient, custom, defineChain,
  type Address, type Hex,
} from "viem";
import type { ChainInfo, ChainStore } from "../../packages/core/src/chains.ts";
import { FailoverRpc, fetchRpcSend, type RpcAttempt } from "../../packages/core/src/rpc.ts";
import type { UnsignedTransaction } from "../../packages/core/src/qr-signing.ts";
import type { OwnerCommand } from "./protocol.ts";

/** The request as it crosses the extension: decimal strings, no bigints. */
export type TxRequest = Extract<OwnerCommand, { cmd: "signTransaction" }>["tx"];

/** The three chain reads filling needs; viem's public client has all three. */
export interface FillRpc {
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint | undefined; maxPriorityFeePerGas?: bigint | undefined }>;
  estimateGas(args: { account: Address; to: Address; value: bigint; data?: Hex }): Promise<bigint>;
}

/**
 * A viem public client over the registry's endpoints, with failover.
 *
 * Whoever answers learns which addresses this browser is interested in and
 * what it is about to send. That is the same disclosure any wallet makes to
 * whatever node it uses, and none of these operators can move funds. It is
 * still a disclosure, and it is why the endpoint list is curated in
 * `chains.ts` rather than taken from the dapp.
 *
 * `store` is where the last good endpoint is remembered. The offscreen
 * document is a real document and uses localStorage; the service worker has
 * none and passes a throwaway.
 */
export function chainRpc(
  info: ChainInfo,
  opts: { onFailover?: (a: RpcAttempt) => void; store?: ChainStore } = {},
) {
  const failover = new FailoverRpc({
    chainId: info.id,
    rpcUrls: info.rpcUrls,
    send: fetchRpcSend(),
    ...(opts.onFailover !== undefined ? { onFailover: opts.onFailover } : {}),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  });
  const viemChain = defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [...info.rpcUrls] } },
  });
  return createPublicClient({
    chain: viemChain,
    transport: custom(
      { request: (args) => failover.request(args as { method: string; params?: unknown }) },
      { retryCount: 0 },
    ),
  });
}

/**
 * Nonce and fees are filled from the chain when the dapp left them out, and
 * honoured when it supplied them: getting either wrong costs a stuck
 * transaction, not funds, and the device still decodes and draws what it is
 * about to sign from the bytes themselves.
 *
 * EIP-1559 only. Every chain in the curated registry supports it, and
 * offering two fee models doubles the shapes the device has to render for no
 * user benefit.
 */
export async function fillTransaction(
  rpc: FillRpc,
  chainId: number,
  from: Address,
  tx: TxRequest,
): Promise<UnsignedTransaction> {
  const to = tx.to as Address;
  const value = tx.value === undefined ? 0n : BigInt(tx.value);
  const data = tx.data as Hex | undefined;

  /* `pending`, not `latest`. A dapp that sends two transactions in a row --
   * approve then swap is the commonest pair in crypto -- has the second built
   * while the first is still in the mempool, and a nonce counted from mined
   * blocks alone gives it the nonce the first one already took. The node then
   * refuses it with "nonce too low", which reads as a wallet fault. */
  const nonce = tx.nonce ?? (await rpc.getTransactionCount({ address: from, blockTag: "pending" }));

  let maxFeePerGas = tx.maxFeePerGas === undefined ? undefined : BigInt(tx.maxFeePerGas);
  let maxPriorityFeePerGas =
    tx.maxPriorityFeePerGas === undefined ? undefined : BigInt(tx.maxPriorityFeePerGas);
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    const fees = await rpc.estimateFeesPerGas();
    maxFeePerGas = maxFeePerGas ?? fees.maxFeePerGas ?? 30_000_000_000n;
    maxPriorityFeePerGas = maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 1_000_000_000n;
  }

  /* Estimating tells the node what is about to be signed. That is the same
   * disclosure the nonce lookup already made, and the alternative — guessing a
   * gas limit for arbitrary calldata — produces transactions that revert after
   * spending the gas. */
  const gas = tx.gas === undefined
    ? await rpc.estimateGas({ account: from, to, value, ...(data !== undefined ? { data } : {}) })
    : BigInt(tx.gas);

  return {
    chainId,
    nonce,
    to,
    value,
    ...(data !== undefined ? { data } : {}),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: "eip1559",
  };
}
