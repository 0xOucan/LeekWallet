/**
 * The one place the WalletConnect flow asks "what chain is this?".
 *
 * It exists because the answer is about to change shape. The registry is
 * growing a distinction between curated chains and user-added custom ones, with
 * `resolveChain()` covering both and `chainLabelDetailed()` returning a name
 * already qualified as e.g. "My Rollup (custom, unverified)". A name a user
 * typed must never be rendered as though the app were asserting it — that is
 * the same mislabel PROTOCOL.md 6d rules out for token symbols, applied to
 * networks.
 *
 * Routing every chain lookup in the dapp path through here means that swap is
 * two lines in one file rather than a hunt through the UI, and it means there
 * is a single place a reviewer can check that no dapp-facing screen names a
 * chain without its caveat.
 *
 */

import {
  chainLabelDetailed, resolveChain, CUSTOM_CHAIN_NOTICE, type ChainInfo,
} from "../../packages/core/src/chains.ts";

export { CUSTOM_CHAIN_NOTICE };

/**
 * The chain, or undefined.
 *
 * Undefined must be treated as a refusal by every caller, never as a reason to
 * fall back to a default. A dapp that names a chain the user has not added and
 * gets Ethereum instead has obtained a signature for a network nobody chose,
 * which is the exact failure worth engineering against.
 */
export function resolveChainForDapp(chainId: number): ChainInfo | undefined {
  /* Curated and user-added alike. A custom chain the user deliberately added
   * is a chain they can sign for; what must not happen is the *name* being
   * presented as though the app vouched for it - see chainText below. */
  return resolveChain(chainId);
}

/** How to name a chain on screen. Pre-qualified; callers must not re-word it. */
export function chainText(chainId: number): string {
  /* `.text` already carries "(custom, unverified)" where it applies. Reading
   * `.name` instead would drop exactly the qualifier that makes a
   * user-supplied name safe to display. */
  return chainLabelDetailed(chainId).text;
}

/** True when the chain's name is the user's word rather than a reviewed one. */
export function chainIsCustom(chainId: number): boolean {
  return chainLabelDetailed(chainId).source === "custom";
}
