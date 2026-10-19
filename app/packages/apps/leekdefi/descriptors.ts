/**
 * ERC-7730 descriptors for LeekStonks' own calls.
 *
 * ---------------------------------------------------------------------------
 * Why the app carries these and core does not
 *
 * erc7730-mezo.ts in core describes MUSD and MEZO, because "this is an
 * approval of 296.96 MUSD" is a fact any preview wants whether or not this app
 * is in the build. These four are the opposite: `buy`, `redeem`, `stake` and
 * `unstake` at these addresses are this app's contracts, and a descriptor for
 * them left behind in core after the app is deleted would be dead weight
 * nobody could attribute to anything. So they live here and are handed to the
 * shell through `MiniApp.descriptors`, which exists for exactly this.
 *
 * ---------------------------------------------------------------------------
 * What a descriptor does and does not buy
 *
 * It satisfies the HOST gate. `screenProposal` passes an app's call on one of
 * two routes - membership in DEVICE_DRAWN_KINDS, or a descriptor that renders
 * every argument with no conflicts - and these take the second. It does not
 * satisfy the device: the firmware decodes what it signs from its own table in
 * src/eth-decode.c, and until a row for `buy(uint256,uint256)` landed there
 * the device refused the call outright no matter what the host believed. Both
 * halves are required, and the C table is the one that actually protects the
 * signer.
 *
 * ---------------------------------------------------------------------------
 * Why the second argument is never hidden
 *
 * Every format below renders both arguments. `minShares` of zero is a buy at
 * whatever price the oracle happens to publish, which is precisely the call
 * someone operating a mispriced feed wants signed, so it gets a line of its
 * own rather than being folded into a total. Hiding it would still pass the
 * gate - `hiddenFields` is permitted - and would make the screen a summary of
 * the decision instead of the decision.
 */

import { parseDescriptor, type Descriptor } from "@leekwallet/core/erc7730.ts";

import { INDICES, MEZO, MEZO_TESTNET, MUSD, STAKING } from "./addresses.ts";

/** 2^256-1, the conventional infinite allowance. Written out, not computed. */
const UNLIMITED = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/**
 * A tokenAmount field.
 *
 * `token` is a literal because none of these calls carries the token as an
 * argument. Decimals come from TOKEN_HINTS in chains.ts and never from here,
 * so an amount whose token has no hint prints raw units and refuses to scale -
 * which is why the three LeekStonks tokens were added to that table rather
 * than 18 being assumed in the renderer.
 */
const tokenAmount = (label: string, path: string, token: string) => ({
  label,
  format: "tokenAmount",
  path,
  params: { token, threshold: UNLIMITED, message: "UNLIMITED" },
});

/**
 * `approve` on an index share.
 *
 * Needed because `redeem` ends in `share.burnFrom(msg.sender, shares)`, and
 * ERC20Burnable's `burnFrom` spends an allowance: without approving the share
 * to its own vault, a redeem reverts. So the approval is part of redeeming,
 * and an app that could redeem but not approve could not redeem at all.
 *
 * In the app rather than in core, unlike MUSD and MEZO: these two tokens are
 * this app's contracts, and a descriptor for them left in core after the app
 * is deleted is dead weight nobody can attribute to anything.
 */
function shareFormats(share: string): Record<string, unknown> {
  return {
    "approve(address spender, uint256 amount)": {
      intent: "Approve a share burn",
      fields: [
        { label: "Spender", format: "addressName", path: "#.spender" },
        tokenAmount("Shares", "#.amount", share),
      ],
    },
    "transfer(address to, uint256 amount)": {
      intent: "Send shares",
      fields: [
        { label: "To", format: "addressName", path: "#.to" },
        tokenAmount("Shares", "#.amount", share),
      ],
    },
  };
}

function vaultFormats(share: string): Record<string, unknown> {
  return {
    "buy(uint256 musdAmount, uint256 minShares)": {
      intent: "Buy index shares",
      fields: [
        tokenAmount("Spending", "#.musdAmount", MUSD),
        tokenAmount("At least", "#.minShares", share),
      ],
    },
    "redeem(uint256 shares, uint256 minMusd)": {
      intent: "Redeem index shares",
      fields: [
        tokenAmount("Redeeming", "#.shares", share),
        tokenAmount("At least", "#.minMusd", MUSD),
      ],
    },
  };
}

const STAKING_FORMATS: Record<string, unknown> = {
  "stake(uint256 amount)": {
    intent: "Stake MEZO for a fee discount",
    fields: [tokenAmount("Staking", "#.amount", MEZO)],
  },
  "unstake(uint256 amount)": {
    intent: "Unstake MEZO",
    fields: [tokenAmount("Unstaking", "#.amount", MEZO)],
  },
};

function build(
  contractName: string,
  address: string,
  formats: Record<string, unknown>,
  slug: string,
): Descriptor | null {
  return parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId: MEZO_TESTNET, address }] } },
      metadata: { owner: "LeekStonks", contractName },
      display: { formats },
    },
    // `local/`, never `registry/`: these were written here, and the provenance
    // string a user sees must say so. Dropped on a parse failure rather than
    // repaired, so a descriptor nobody wrote cannot describe a transaction.
    `local/leekdefi-${slug}`,
  );
}

/** Every descriptor this app offers, built once. */
const ALL: readonly Descriptor[] = [
  ...INDICES.map((index) =>
    build(`${index.symbol} vault`, index.vault, vaultFormats(index.share), `vault-${index.symbol.toLowerCase()}`),
  ),
  ...INDICES.map((index) =>
    build(index.symbol, index.share, shareFormats(index.share), `share-${index.symbol.toLowerCase()}`),
  ),
  build("MEZO staking", STAKING, STAKING_FORMATS, "staking"),
].filter((d): d is Descriptor => d !== null);

/**
 * The descriptors that apply to one address, as `MiniApp.descriptors` is
 * called.
 *
 * Filtered by `to` rather than returning the whole set: the shell asks about
 * the call it is screening, and an app that answers with descriptors for three
 * other contracts is asking the matcher to do its narrowing. Chain is checked
 * too, though the shell only mounts this app on Mezo testnet - an app that
 * trusted that would be relying on the shell to enforce the app's own list.
 */
export function descriptorsFor(chainId: number, to: string): readonly Descriptor[] {
  if (chainId !== MEZO_TESTNET) return [];
  const wanted = to.toLowerCase();
  return ALL.filter((d) =>
    d.deployments.some((dep) => dep.chainId === chainId && dep.address === wanted),
  );
}
