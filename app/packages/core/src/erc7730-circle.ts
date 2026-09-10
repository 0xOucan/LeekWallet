/**
 * ERC-7730 descriptors for Circle's testnet USDC and EURC.
 *
 * ---------------------------------------------------------------------------
 * Why these are not in erc7730-bundled.ts
 *
 * That file is registry files copied verbatim at a pinned commit, and its
 * header says not to hand-edit them, because an edited "registry" file is no
 * longer a registry file and its provenance string becomes a lie. These are
 * written here, so they say so: every `source` below starts with `local/`, not
 * `registry/`, and carries no commit. A reviewer can tell at a glance which
 * descriptors somebody else reviewed and which ones we wrote.
 *
 * The registry has no entry for these contracts. Waiting for one would mean
 * shipping Arc support with the Arc rendering bug still in it.
 *
 * ---------------------------------------------------------------------------
 * Why these are in core rather than in the mini-app that wanted them
 *
 * Mini-apps must be removable at build time, so app-specific code lives in the
 * app's own directory. These are not app-specific. "This calldata is a USDC
 * transfer of $12.50" is something any preview of that transaction wants, on
 * any screen, with or without a point-of-sale app compiled in — the same
 * reason TOKEN_HINTS and the chain table are in core. Nothing here imports an
 * app, mentions one, or grows when one is added; what IS app-specific is the
 * decision to accept payment on these nine chains, and that decision belongs
 * with the app.
 *
 * ---------------------------------------------------------------------------
 * Why one descriptor per deployment instead of one per token
 *
 * A `tokenAmount` field needs to name the token whose decimals apply. Neither
 * `transfer` nor `approve` has a token argument — the token IS the contract
 * being called — so the reference has to be a literal address, and a literal
 * address is per-deployment. Grouping nine chains under one descriptor would
 * mean one of them naming the other eight's contract.
 *
 * Note what the descriptor actually buys and does not. Decimals are read from
 * TOKEN_HINTS in chains.ts, never from the descriptor (see renderField), and
 * the raw units are printed alongside every scaled figure. So a descriptor
 * with no matching token hint still refuses to scale: it prints
 * "N raw units (decimals unknown)" rather than guessing 18. That refusal is
 * the behaviour worth protecting, and erc7730.test.ts pins it.
 *
 * ---------------------------------------------------------------------------
 * Arc, which is the whole reason this file exists
 *
 * On Arc (5042002) USDC is the gas token. The native unit has 18 decimals; the
 * ERC-20 interface at 0x3600…0000 has 6. The firmware renders raw units by
 * design because it cannot call decimals() (src/ui.c, sign_draw_amount), so
 * the host preview is the only place a human sees a scaled amount, and the
 * host has two different correct answers on one chain. The native path is
 * covered by `nativeCurrency.decimals` in chains.ts; the ERC-20 path is
 * covered by the descriptor below plus its token hint. Confusing the two
 * renders a $1 payment as $1,000,000,000,000 or as a millionth of a cent.
 *
 * Every address, symbol and decimals value here was read off the chain on
 * 2026-09-06 rather than copied from a document.
 */

import { parseDescriptor, type Descriptor } from "./erc7730.ts";

/** chainId → contract address, lower-case. */
export type Deployments = ReadonlyArray<readonly [number, string]>;

/**
 * USDC. Nine chains: the eight CCTP V2 testnet source domains plus Arc.
 *
 * Arc's entry is the native gas token's ERC-20 face, which is why its address
 * is a predeploy and not a normal deployment.
 *
 * Exported (as `USDC_DEPLOYMENTS`) so the all-chain balances screen
 * (docs/UI-L3-SPEC.md §2) can ask "which chains have USDC, at what address"
 * without a second, hand-typed copy of this table. TOKEN_HINTS in chains.ts
 * carries the matching symbol/decimals for these exact addresses already.
 */
const USDC: Deployments = [
  [1301, "0x31d0220469e10c4e71834a79b1f276d740d3768f"],       // Unichain Sepolia
  [43113, "0x5425890298aed601595a70ab815c96711a31bc65"],      // Avalanche Fuji
  [59141, "0xfece4462d57bd51a6a552365a011b95f0e16d9b7"],      // Linea Sepolia
  [80002, "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582"],      // Polygon Amoy
  [84532, "0x036cbd53842c5426634e7929541ec2318f3dcf7e"],      // Base Sepolia
  [421614, "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d"],     // Arbitrum Sepolia
  [5042002, "0x3600000000000000000000000000000000000000"],    // Arc Testnet
  [11155111, "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"],   // Sepolia
  [11155420, "0x5fd84259d66cd46123540766be93dfe6d43130d7"],   // OP Sepolia
] as const;

/**
 * EURC. Four chains, and the absence is load-bearing: a chain missing here has
 * no EURC we checked, and the app must offer nothing rather than an address it
 * assumed by analogy with USDC.
 */
const EURC: Deployments = [
  [43113, "0x5e44db7996c682e92a960b65ac713a54ad815c6b"],      // Avalanche Fuji
  [84532, "0x808456652fdb597867f38412077a9182bf77359f"],      // Base Sepolia
  [5042002, "0x89b50855aa3be2f677cd6303cec089b5f319d72a"],    // Arc Testnet
  [11155111, "0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4"],   // Sepolia
] as const;

/**
 * cirBTC — Circle Wrapped Bitcoin. Two chains, the same two
 * `all-chain-balances.ts` verified on 2026-09-08 by calling symbol(), name()
 * and decimals() over each chain's own RPC.
 *
 * NOT cbBTC. Coinbase Wrapped BTC is a different token from a different
 * issuer at different addresses, and the two names are one keystroke apart; an
 * earlier draft of the balances screen read "cirBTC" as a typo for it and
 * pointed Sepolia at Coinbase's contract. A descriptor is the place that
 * mistake would do the most damage, because a descriptor is what makes a
 * screen say confidently what a transfer IS.
 *
 * Described for the same reason USDC and EURC are: any preview of a transfer
 * of this token wants it, with or without an app compiled in. The decimals
 * still come from TOKEN_HINTS and not from here — a deployment listed below
 * with no token hint would print raw units and refuse to scale, which is the
 * behaviour erc7730.test.ts pins.
 */
const CIRBTC: Deployments = [
  [5042002, "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf"],    // Arc Testnet
  [11155111, "0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3"],   // Sepolia
] as const;

/** `USDC`, exported for reuse — see the comment above `USDC`. */
export const USDC_DEPLOYMENTS: Deployments = USDC;
/** `EURC`, exported for reuse — same reason as `USDC_DEPLOYMENTS`. */
export const EURC_DEPLOYMENTS: Deployments = EURC;
/**
 * `CIRBTC`, exported so the all-chain balances screen reads the same two
 * addresses this file describes rather than keeping a second copy of them. Two
 * copies of a contract address is how one of them gets to be wrong.
 */
export const CIRBTC_DEPLOYMENTS: Deployments = CIRBTC;

/**
 * The two calls worth describing.
 *
 * `transfer` is the payment. `approve` is here because an approval is the call
 * users misread most, and an unlimited allowance rendered as a number with 78
 * digits teaches nothing — the threshold turns it into a sentence. Nothing
 * else on these contracts is described: an omitted format falls through to the
 * app's own decoder, which is the honest floor.
 */
function formats(token: string): Record<string, unknown> {
  const amount = {
    label: "Amount",
    format: "tokenAmount",
    path: "#.amount",
    // A literal, because neither call carries the token as an argument.
    params: {
      token,
      // 2^256-1, the conventional "infinite" allowance. Written out rather
      // than computed so the constant a reviewer checks is the one shipped.
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

function descriptorsFor(symbol: string, owner: string, deployments: Deployments): Descriptor[] {
  const out: Descriptor[] = [];
  for (const [chainId, address] of deployments) {
    const raw = {
      context: { contract: { deployments: [{ chainId, address }] } },
      metadata: { owner, contractName: symbol },
      display: { formats: formats(address) },
    };
    // Parsed through the same gate as the registry files, and dropped on
    // failure rather than repaired: a descriptor we patched into shape would
    // describe a transaction by a rule nobody wrote down.
    const d = parseDescriptor(raw, `local/circle-${symbol.toLowerCase()}-${chainId}`);
    if (d !== null) out.push(d);
  }
  return out;
}

/**
 * Locally written descriptors, kept as a separate export from
 * BUNDLED_DESCRIPTORS so provenance stays legible in both directions: nothing
 * here can be mistaken for reviewed registry content, and a registry check
 * cannot accidentally pass over a file we wrote ourselves.
 */
export const CIRCLE_DESCRIPTORS: readonly Descriptor[] = [
  ...descriptorsFor("USDC", "Circle", USDC),
  ...descriptorsFor("EURC", "Circle", EURC),
  ...descriptorsFor("cirBTC", "Circle", CIRBTC),
];
