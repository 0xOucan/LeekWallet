/**
 * All-chain balances (L3, docs/UI-L3-SPEC.md) — one chain's worth of the
 * wallet-menu headline: the account's native currency plus WETH, USDC, EURC
 * and cirBTC, batched per chain.
 *
 * This file decides *which contract to ask* on each chain; it fetches
 * nothing and scales nothing itself — `multicall.ts` does the batched read,
 * `balances.ts` decodes it and is the only place a scaled figure can be
 * built. What is here is the address matrix and the state machine over its
 * four outcomes.
 *
 * The address matrix is deliberately small and typed by hand, per
 * docs/UI-L3-SPEC.md §2: USDC and EURC are re-exported from
 * erc7730-circle.ts rather than retyped, and WETH/cirBTC live as TOKEN_HINTS
 * entries in chains.ts, each with a comment recording how it was verified.
 * A chain absent from a token's map has no entry anywhere in this app for
 * that pairing — there is no fallback address to fall back to.
 */

import {
  CHAINS, chainLabelDetailed, type ChainInfo,
} from "./chains.ts";
import {
  describeTokenAmount, fetchNativeBalance, fetchTokenBalance, hintMeta,
  type EthRequest, type TokenAmountView,
} from "./balances.ts";
import { fetchTokenBalancesBatched, type TokenBalanceResult } from "./multicall.ts";
import { EURC_DEPLOYMENTS, USDC_DEPLOYMENTS } from "./erc7730-circle.ts";

/** The four ERC-20s this screen tracks. ETH and HBAR are native, not here. */
export type TrackedTokenSymbol = "WETH" | "USDC" | "EURC" | "cirBTC";

export const TRACKED_TOKEN_SYMBOLS: readonly TrackedTokenSymbol[] =
  ["WETH", "USDC", "EURC", "cirBTC"];

/**
 * WETH deployments, verified 2026-09-08 by eth_call of symbol() against each
 * chain's own RPC (docs/UI-L3-SPEC.md §2 table). Six chains only — a chain
 * missing here (Hedera, Arc, Hoodi, BSC Testnet, Fuji, Linea Sepolia) was
 * checked and found to have no WETH this app will assert.
 */
const WETH_DEPLOYMENTS: Readonly<Record<number, string>> = {
  11155111: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", // Sepolia
  84532: "0x4200000000000000000000000000000000000006",   // Base Sepolia
  421614: "0x980b62da83eff3d4576c647993b0c1d7faf17c73",   // Arbitrum Sepolia
  1301: "0x4200000000000000000000000000000000000006",    // Unichain Sepolia
  11155420: "0x4200000000000000000000000000000000000006", // OP Sepolia
  80002: "0x52ef3d68bab452a294342dc3e5f464d7f610f72e",    // Polygon Amoy
};

/**
 * cirBTC — Circle Wrapped Bitcoin — deployments, verified 2026-09-08 the
 * same way: both answer symbol() "cirBTC", name() "Circle Wrapped Bitcoin",
 * decimals() 8. Two chains, which is the whole of where it exists on
 * testnets.
 *
 * Not to be confused with cbBTC, Coinbase Wrapped BTC: a different token
 * from a different issuer that also wraps Bitcoin. This screen tracks
 * cirBTC because that is what the user holds; an earlier draft read
 * "cirBTC" as a typo for cbBTC and pointed Sepolia at Coinbase's contract,
 * which would have shown a balance of the wrong asset.
 */
const CIRBTC_DEPLOYMENTS: Readonly<Record<number, string>> = {
  5042002: "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf",  // Arc Testnet
  11155111: "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3", // Sepolia
};

/** `Deployments` (array of [chainId, address] pairs) as a chainId → address map. */
function asMap(deployments: typeof USDC_DEPLOYMENTS): Readonly<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const [chainId, address] of deployments) out[chainId] = address;
  return out;
}

const USDC_BY_CHAIN = asMap(USDC_DEPLOYMENTS);
const EURC_BY_CHAIN = asMap(EURC_DEPLOYMENTS);

/** Which map answers for a tracked symbol. */
function deploymentsFor(symbol: TrackedTokenSymbol): Readonly<Record<number, string>> {
  switch (symbol) {
    case "WETH": return WETH_DEPLOYMENTS;
    case "USDC": return USDC_BY_CHAIN;
    case "EURC": return EURC_BY_CHAIN;
    case "cirBTC": return CIRBTC_DEPLOYMENTS;
  }
}

/** The contract address for a tracked token on a chain, or undefined. */
export function trackedTokenAddress(symbol: TrackedTokenSymbol, chainId: number): string | undefined {
  return deploymentsFor(symbol)[chainId];
}

/**
 * The chains this screen covers: the curated testnets, which is where every
 * address above and in erc7730-circle.ts was verified. A mainnet row would
 * either need its own verified matrix or would silently reuse a testnet
 * address on the wrong network — neither is acceptable, so mainnets are out
 * of this screen's scope rather than wrong on it.
 */
export function trackedChains(): readonly ChainInfo[] {
  return CHAINS.filter((c) => c.testnet);
}

/* ------------------------------------------------------------- the states */

/**
 * One asset's state on one chain. A discriminated union, same reasoning as
 * `TokenBalanceResult` in multicall.ts: no caller can reach a figure without
 * having looked at `kind` first, and "no address here" cannot collapse into
 * "read a zero" by accident.
 */
export type AssetState =
  /** In flight. Not the same as a failure — nothing is known yet either way. */
  | { kind: "reading" }
  /**
   * No contract address for this token on this chain. Never rendered as 0 —
   * see docs/UI-L3-SPEC.md §3. Native currency is never `unavailable`: every
   * chain in the registry has one.
   */
  | { kind: "unavailable" }
  /** The read failed — RPC unreachable, call reverted, malformed reply. */
  | { kind: "error" }
  /** Native balance, in wei. Decimals/symbol come from the chain registry. */
  | { kind: "native"; wei: bigint }
  /** An ERC-20 balance, already the only shape a scaled figure can take. */
  | { kind: "token"; view: TokenAmountView };

export interface TrackedAssetRow {
  symbol: TrackedTokenSymbol;
  state: AssetState;
}

export interface ChainBalanceRow {
  chainId: number;
  /** Pre-qualified, per chainLabelDetailed — safe to render on its own. */
  label: string;
  native: AssetState;
  tokens: readonly TrackedAssetRow[];
}

/** Every row in its `reading` state, for the initial paint before any fetch lands. */
export function loadingRow(chain: ChainInfo): ChainBalanceRow {
  return {
    chainId: chain.id,
    label: chainLabelDetailed(chain.id).text,
    native: { kind: "reading" },
    tokens: TRACKED_TOKEN_SYMBOLS.map((symbol) => ({ symbol, state: { kind: "reading" } })),
  };
}

/**
 * One chain's balances: the native currency plus every tracked token that
 * has an address on this chain, one multicall3 aggregate for the tokens.
 *
 * Concurrency across chains is the caller's job (Promise.all over chains, or
 * however the UI wants to render as each settles) — this function only
 * handles concurrency *within* one chain, between the native read and the
 * batched token read, which cost nothing extra to run together.
 */
export async function fetchChainBalances(
  request: EthRequest,
  chain: ChainInfo,
  owner: string,
): Promise<ChainBalanceRow> {
  const label = chainLabelDetailed(chain.id).text;

  const nativePromise = fetchNativeBalance(request, owner)
    .then((wei): AssetState => ({ kind: "native", wei }))
    .catch((): AssetState => ({ kind: "error" }));

  const present = TRACKED_TOKEN_SYMBOLS
    .map((symbol) => ({ symbol, address: trackedTokenAddress(symbol, chain.id) }))
    .filter((t): t is { symbol: TrackedTokenSymbol; address: string } => t.address !== undefined);

  const tokensPromise = fetchPresentTokens(request, chain.id, owner, present);

  const [native, resultsBySymbol] = await Promise.all([nativePromise, tokensPromise]);

  const tokens: TrackedAssetRow[] = TRACKED_TOKEN_SYMBOLS.map((symbol) => {
    const state = resultsBySymbol.get(symbol);
    return { symbol, state: state ?? { kind: "unavailable" } };
  });

  return { chainId: chain.id, label, native, tokens };
}

/**
 * Ask for every present token's balance, one aggregate3 per chain (per
 * multicall.ts's MULTICALL_CHUNK_SIZE — four tokens never needs a second
 * chunk in practice, but the batching function still chunks correctly if it
 * did). Falls back to individual `eth_call`s only if the whole batch came
 * back `batch-failed`, which is what a chain with no Multicall3 deployment
 * looks like from here (docs/UI-L3-SPEC.md §5) — Hedera and Arc are exactly
 * this case today.
 */
async function fetchPresentTokens(
  request: EthRequest,
  chainId: number,
  owner: string,
  present: readonly { symbol: TrackedTokenSymbol; address: string }[],
): Promise<Map<TrackedTokenSymbol, AssetState>> {
  const out = new Map<TrackedTokenSymbol, AssetState>();
  if (present.length === 0) return out;

  let results: TokenBalanceResult[];
  try {
    results = await fetchTokenBalancesBatched(request, chainId, owner, present.map((t) => t.address));
  } catch {
    results = present.map((t) => ({ token: t.address, ok: false, reason: "batch-failed" as const }));
  }

  const allBatchFailed = results.every((r) => !r.ok && r.reason === "batch-failed");
  if (allBatchFailed) {
    // No multicall3 answered on this chain. Ask each token on its own rather
    // than let one missing contract cost every token on this one chain — the
    // other chains are unaffected either way (fetchAllChainBalances runs
    // them concurrently and independently).
    results = await Promise.all(present.map(async (t): Promise<TokenBalanceResult> => {
      try {
        return { token: t.address, ok: true, raw: await fetchTokenBalance(request, t.address, owner) };
      } catch {
        return { token: t.address, ok: false, reason: "call-failed" };
      }
    }));
  }

  for (let i = 0; i < present.length; i++) {
    const { symbol, address } = present[i] as { symbol: TrackedTokenSymbol; address: string };
    const result = results[i];
    if (!result || !result.ok) {
      out.set(symbol, { kind: "error" });
      continue;
    }
    // hintMeta first (WETH/cirBTC in TOKEN_HINTS, chains.ts), falling back to
    // fetchTokenMeta's contract-declared answer is deliberately NOT done
    // here: every address this screen asks about is either in TOKEN_HINTS
    // already (all four tracked symbols are) or has no meta at all, and a
    // meta-less TokenAmountView still renders — raw units only, per
    // balances.ts's own rule that a missing symbol costs a plainer screen,
    // never a wrong one.
    const meta = hintMeta(chainId, address);
    out.set(symbol, { kind: "token", view: describeTokenAmount(address, result.raw, meta) });
  }
  return out;
}

/**
 * Every tracked chain, fetched concurrently, each delivered to `onRow` as it
 * settles — never all at once, and never blocked on the slowest chain
 * (docs/UI-L3-SPEC.md §5). A chain this app has no transport for (the caller
 * could not build a request function for it) is reported as `error` on every
 * asset rather than silently dropped, so it still shows a row.
 */
export async function fetchAllChainBalances(
  chainRequest: (chainId: number) => EthRequest | undefined,
  owner: string,
  onRow: (row: ChainBalanceRow) => void,
  chains: readonly ChainInfo[] = trackedChains(),
): Promise<void> {
  await Promise.all(chains.map(async (chain) => {
    const request = chainRequest(chain.id);
    if (!request) {
      onRow({
        chainId: chain.id,
        label: chainLabelDetailed(chain.id).text,
        native: { kind: "error" },
        tokens: TRACKED_TOKEN_SYMBOLS.map((symbol) => ({ symbol, state: { kind: "error" } })),
      });
      return;
    }
    try {
      onRow(await fetchChainBalances(request, chain, owner));
    } catch {
      onRow({
        chainId: chain.id,
        label: chainLabelDetailed(chain.id).text,
        native: { kind: "error" },
        tokens: TRACKED_TOKEN_SYMBOLS.map((symbol) => ({ symbol, state: { kind: "error" } })),
      });
    }
  }));
}
