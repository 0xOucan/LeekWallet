/**
 * EVM chain registry (T51) — plain data, one source of truth.
 *
 * EVM chains differ only by `chainId`, which EIP-155 already puts inside the
 * signed payload, so supporting more of them is an app-side matter of knowing
 * RPC endpoints (docs/PROTOCOL.md section 6d). This table is that knowledge.
 *
 * It lives in core rather than in the UI because two things need it and they
 * must not disagree: the shell, which picks an RPC and a chainId to sign, and
 * tx-interpret.ts, which names the chain in the preview. A second copy of this
 * mapping would eventually drift, and a drifted chain name is precisely the
 * mislabel section 6d says is worse than no name at all.
 *
 * Naming a chain here is a claim. An ID that is absent stays a bare number
 * everywhere — "chain 8453" is honest; a confident wrong name is not.
 *
 * Every RPC origin listed here must also appear in the connect-src allowlist
 * in src-tauri/tauri.conf.json, or the request is blocked at runtime. That
 * duplication is deliberate: the CSP is a reviewable security boundary and
 * cannot be generated from this file at build time.
 */

export interface NativeCurrency {
  name: string;
  /** Ticker of the gas token. Not a token-list symbol; it is part of the chain. */
  symbol: string;
  decimals: number;
}

export interface ChainInfo {
  id: number;
  /** Shown to the user, and the name tx-interpret is willing to assert. */
  name: string;
  nativeCurrency: NativeCurrency;
  /**
   * Public endpoints, in preference order. Multiple entries so one operator
   * being down or rate-limiting does not take the chain out entirely. Whoever
   * is asked learns which addresses you are interested in; none of them can
   * move funds.
   */
  rpcUrls: readonly string[];
  /** Base URL, no trailing slash. `${explorerUrl}/tx/${hash}` is a valid link. */
  explorerUrl: string;
  /** Testnet money is worthless, and the UI should say so before you sign. */
  testnet: boolean;
}

/**
 * The table. Ordered mainnets-then-testnets purely so the selector reads well.
 */
export const CHAINS: readonly ChainInfo[] = [
  {
    id: 1,
    name: "Ethereum",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    explorerUrl: "https://etherscan.io",
    testnet: false,
  },
  {
    id: 10,
    name: "OP Mainnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
    explorerUrl: "https://optimistic.etherscan.io",
    testnet: false,
  },
  {
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"],
    explorerUrl: "https://bscscan.com",
    testnet: false,
  },
  {
    id: 137,
    name: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    explorerUrl: "https://polygonscan.com",
    testnet: false,
  },
  {
    id: 8453,
    name: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
    explorerUrl: "https://basescan.org",
    testnet: false,
  },
  {
    id: 42161,
    name: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    explorerUrl: "https://arbiscan.io",
    testnet: false,
  },
  {
    id: 11155111,
    name: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.gateway.tenderly.co",
      "https://sepolia.drpc.org",
      "https://0xrpc.io/sep",
    ],
    explorerUrl: "https://sepolia.etherscan.io",
    testnet: true,
  },
  {
    id: 84532,
    name: "Base Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.drpc.org"],
    explorerUrl: "https://sepolia.basescan.org",
    testnet: true,
  },
  {
    id: 17000,
    name: "Holesky",
    nativeCurrency: { name: "Holesky Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-holesky-rpc.publicnode.com", "https://holesky.drpc.org"],
    explorerUrl: "https://holesky.etherscan.io",
    testnet: true,
  },
] as const;

/** Undefined for anything not in the table — callers must handle that. */
export function getChain(chainId: number | bigint): ChainInfo | undefined {
  const id = Number(chainId);
  return CHAINS.find((c) => c.id === id);
}

/** The name to assert, or undefined. Never a guess. */
export function chainName(chainId: number | bigint): string | undefined {
  return getChain(chainId)?.name;
}

/**
 * How to refer to a chain in a sentence. Falls back to the number, which is
 * what the device shows for an ID it does not recognise either.
 */
export function chainLabel(chainId: number | bigint): string {
  return chainName(chainId) ?? `chain ${Number(chainId)}`;
}

/** Every distinct origin the app may need to reach. Used to audit the CSP. */
export function rpcOrigins(): string[] {
  const seen = new Set<string>();
  for (const c of CHAINS) for (const url of c.rpcUrls) seen.add(new URL(url).origin);
  return [...seen].sort();
}

/* -------------------------------------------------- token metadata (advisory)
 *
 * NOT a token list, and deliberately not one.
 *
 * A token list maps a contract address to a symbol. If the device rendered
 * "1000 USDC" from a host-supplied symbol, a compromised host could relabel a
 * worthless contract as USDC and the confirmation screen would become the
 * attack. So none of this ever reaches the device, and it is not authoritative
 * here either: this app is the untrusted machine.
 *
 * The entries below exist only so a preview can say "this looks like it might
 * be USDC" while showing the contract address that actually decides the
 * outcome. They are a handful of major contracts typed by hand, not a bundled
 * multi-megabyte Uniswap list — the size is the point: nobody can audit a list
 * of thousands, and a long list you have to trust is worse than a short one you
 * checked. Anything absent is displayed as an address, which is the correct
 * behaviour rather than a degraded one.
 *
 * If a Uniswap-format list is ever fetched at runtime, it feeds exactly this
 * structure and inherits exactly this marking. There is no path by which a
 * symbol becomes verified on the host.
 */

export interface TokenHint {
  chainId: number;
  /** Lower-case hex, 0x-prefixed. Compare case-insensitively. */
  address: string;
  /** Advisory only. Never render without the disclaimer below. */
  symbol: string;
  /** Advisory only. The device cannot call decimals() and neither do we. */
  decimals: number;
  /**
   * Always false. Present as a field, rather than implied by which table the
   * entry came from, so that no caller can render a symbol without having had
   * to look straight at the fact that nothing checked it.
   */
  verified: false;
}

const TOKEN_HINTS: readonly TokenHint[] = [
  { chainId: 1, address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, verified: false },
  { chainId: 1, address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6, verified: false },
  { chainId: 1, address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18, verified: false },
  { chainId: 1, address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18, verified: false },
  { chainId: 10, address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", symbol: "USDC", decimals: 6, verified: false },
  { chainId: 137, address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", decimals: 6, verified: false },
  { chainId: 8453, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, verified: false },
  { chainId: 42161, address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", symbol: "USDC", decimals: 6, verified: false },
] as const;

/**
 * A guess at what a contract might be, or undefined. The caller must render
 * the contract address regardless of what this returns.
 */
export function tokenHint(chainId: number | bigint, address: string): TokenHint | undefined {
  const id = Number(chainId);
  const key = address.toLowerCase();
  return TOKEN_HINTS.find((t) => t.chainId === id && t.address === key);
}

/**
 * Exact raw-units → decimal string, integer arithmetic only. Applying a
 * decimals value this app merely guessed is itself advisory; the raw units
 * are the only figure that came from the calldata.
 */
export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / scale}${frac ? "." + frac : ""}`;
}

/**
 * The sentence that must accompany any rendering of a TokenHint. A constant so
 * it cannot drift between screens and so a reviewer can grep for its use.
 */
export const TOKEN_HINT_NOTICE =
  "Token name and decimals are a guess by this app and were not checked by anything. " +
  "The contract address above is what the device shows and what you are signing.";
