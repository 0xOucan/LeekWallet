/**
 * ERC-7730 descriptors for Mezo's MUSD and MEZO, on Mezo testnet.
 *
 * ---------------------------------------------------------------------------
 * Why these exist
 *
 * The device already draws ERC-20 `approve` from its own table, with a screen
 * that says "Approve spending" and turns 2^256-1 into the word UNLIMITED. The
 * host gate is the half that was missing: `screenProposal` lets a mini-app's
 * call through on one of two routes, membership in DEVICE_DRAWN_KINDS or a
 * matching descriptor, and ERC-20 approve is deliberately not in the first.
 * So without these, an app on Mezo could propose a buy and not the approval
 * that has to precede it, which is the worse half of the pair to block: an
 * approval is the call that grants a contract the ability to take tokens.
 *
 * ---------------------------------------------------------------------------
 * Why in core rather than in the app that wanted them
 *
 * The same reason erc7730-circle.ts gives, and the test is the same: "this
 * calldata is an approval of 296.96 MUSD" is a fact any preview of that
 * transaction wants, with or without a mini-app compiled into the build. It
 * does not mention an app, does not grow when one is added, and leaves nothing
 * behind that only made sense next to one. What IS app-specific - which vault
 * is being approved, and why - belongs with the app and stays there.
 *
 * ---------------------------------------------------------------------------
 * Provenance
 *
 * Written here, not copied from the registry, so every `source` starts with
 * `local/` and carries no commit. Both addresses were read on chain on
 * 2026-10-18 against rpc.test.mezo.org.
 *
 * MUSD is the one point worth being careful about. Mezo testnet carries five
 * contracts answering symbol() "MUSD" with 18 decimals; this is the one whose
 * mintList(BorrowerOperations) is true, which is the only one the borrow
 * system mints and the only one anything settles in. Describing the wrong one
 * would put a confident sentence under a transaction in a token nobody holds.
 * See the note beside the MUSD row in chains.ts.
 *
 * Decimals still come from TOKEN_HINTS and never from here (renderField), so a
 * deployment listed below with no matching hint prints raw units and refuses
 * to scale rather than assuming 18.
 */

import { parseDescriptor, type Descriptor } from "./erc7730.ts";

/** The settlement MUSD on Mezo testnet: the mintable one, not the documented one. */
export const MEZO_TESTNET_MUSD = "0xf9bbccc0f1b68ea07c86de6f88c76b3d8e2dd0af";

/** MEZO as an ERC-20. A precompile over the Cosmos bank module, same address on both networks. */
export const MEZO_TOKEN = "0x7b7c000000000000000000000000000000000001";

/**
 * `transfer` and `approve`, the two calls worth describing on a token.
 *
 * `approve` carries the threshold that turns an infinite allowance into a
 * word. A number with 78 digits on a confirmation screen teaches nobody
 * anything, and an unlimited allowance is the thing most worth noticing.
 */
function formats(token: string): Record<string, unknown> {
  const amount = {
    label: "Amount",
    format: "tokenAmount",
    path: "#.amount",
    // A literal: neither call carries the token as an argument, because the
    // token is the contract being called.
    params: {
      token,
      // 2^256-1. Written out rather than computed, so the constant a reviewer
      // checks is the one that ships.
      threshold: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      message: "UNLIMITED",
    },
  };
  return {
    "transfer(address to, uint256 amount)": {
      intent: "Send",
      fields: [{ label: "To", format: "addressName", path: "#.to" }, amount],
    },
    "approve(address spender, uint256 amount)": {
      intent: "Approve spending",
      fields: [{ label: "Spender", format: "addressName", path: "#.spender" }, amount],
    },
  };
}

function descriptorFor(symbol: string, address: string, chainId: number): Descriptor | null {
  return parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId, address }] } },
      metadata: { owner: "Mezo", contractName: symbol },
      display: { formats: formats(address) },
    },
    // Parsed through the same gate as the registry files and dropped on
    // failure rather than repaired: a descriptor patched into shape would
    // describe a transaction by a rule nobody wrote down.
    `local/mezo-${symbol.toLowerCase()}-${chainId}`,
  );
}

/**
 * Kept as its own export rather than folded into BUNDLED_DESCRIPTORS, so
 * provenance stays legible in both directions: nothing here can be mistaken
 * for reviewed registry content, and a registry check cannot pass over a file
 * we wrote ourselves.
 */
export const MEZO_DESCRIPTORS: readonly Descriptor[] = [
  descriptorFor("MUSD", MEZO_TESTNET_MUSD, 31611),
  descriptorFor("MEZO", MEZO_TOKEN, 31611),
].filter((d): d is Descriptor => d !== null);
