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
 *
 * Since T62 a native build sends RPC calls through a Rust command instead
 * (src-tauri/src/rpc.rs), which the CSP does not govern — that is what makes a
 * user-supplied endpoint reachable at all. The allowlist is NOT relaxed as a
 * result. A browser build, the dev server, and any build compiled without the
 * proxy's HTTP client still fetch straight from the window, and while that
 * path exists it must stay bounded to origins somebody reviewed. An allowlist
 * that is merely redundant costs nothing; one that was deleted because a
 * second door opened is not recoverable.
 *
 * ---------------------------------------------------------------------------
 * Why this is a curated table and not "every chain ID"
 *
 * The obvious reading of "support all chains" is to bundle the chainlist
 * registry: roughly two thousand entries, names and RPCs contributed by
 * whoever opened the pull request. We deliberately do not, for three reasons
 * that all point the same way.
 *
 * 1. A wallet's entire job is letting someone verify what they are signing.
 *    Two thousand uncurated networks are presented in the same typeface, with
 *    the same authority, as the ones a human actually checked — so the UI
 *    would be asserting things nobody verified. That is the same failure mode
 *    as a host-supplied token symbol (section 6d): the label becomes the
 *    attack surface. A short list somebody checked beats a long list you have
 *    to trust.
 * 2. The floor behaviour is already safe. The device renders the raw chain ID
 *    and does not care what this app calls it, and an unrecognised ID shows as
 *    "chain N" with a warning. Nothing about an absent chain is broken; adding
 *    unverified names would not make it safer, only more confident-looking.
 * 3. Bundle size and supply-chain surface both matter here. A multi-megabyte
 *    dependency that ships names and URLs straight into a signing UI, updated
 *    by strangers, is exactly the dependency a wallet should not have.
 *
 * What genuinely makes the app chain-agnostic is the escape hatch below:
 * user-added custom chains. The user supplies the ID, name, symbol, decimals,
 * RPC and explorer themselves, it is persisted, and it is marked `custom`
 * everywhere it surfaces so that a self-chosen name is never mistaken for a
 * checked one. That covers every chain we did not curate without pretending we
 * curated it.
 */

export interface NativeCurrency {
  name: string;
  /** Ticker of the gas token. Not a token-list symbol; it is part of the chain. */
  symbol: string;
  decimals: number;
}

/**
 * Where an entry came from. Carried as a field rather than implied by which
 * array it lives in, so no renderer can show a chain name without having had
 * to look straight at whether anyone checked it — same reasoning as
 * `TokenHint.verified` below.
 */
export type ChainSource = "curated" | "custom";

export interface ChainInfo {
  /** "curated" = typed in here by hand. "custom" = typed in by the user. */
  source: ChainSource;
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

/** An entry as written below: `source` is filled in for it, never by hand. */
type CuratedEntry = Omit<ChainInfo, "source">;

/**
 * The curated table. Ordered mainnets-then-testnets purely so the selector
 * reads well.
 *
 * Selection rule: chains people actually hold balances on, plus the testnet
 * each of those is developed against. Two independent RPC operators per chain
 * minimum, so one of them being down or rate-limiting does not remove the
 * chain from the app.
 *
 * A chain must also be ALIVE, not merely well-known. Being listed here is an
 * offer to sign and broadcast on that network, and the offer is false if
 * nothing will accept the transaction -- so a chain that has stopped producing
 * blocks comes out, whether it was formally shut down (Polygon zkEVM, Holesky)
 * or has simply stalled with no announcement (Scroll Sepolia). Note that a dead
 * chain can keep answering reads perfectly: Holesky served eth_chainId and
 * eth_blockNumber for months after its shutdown, frozen at one height. Liveness
 * is a block-height question, and `./scripts/check.sh rpc` is how it is asked. Anything not here is reachable as a custom chain, which
 * is the honest place for "we did not check this".
 */
const CURATED: readonly CuratedEntry[] = [
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
    id: 100,
    name: "Gnosis",
    nativeCurrency: { name: "xDAI", symbol: "XDAI", decimals: 18 },
    rpcUrls: ["https://gnosis-rpc.publicnode.com", "https://gnosis.drpc.org"],
    explorerUrl: "https://gnosisscan.io",
    testnet: false,
  },
  {
    id: 130,
    name: "Unichain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://unichain-rpc.publicnode.com", "https://unichain.drpc.org"],
    explorerUrl: "https://uniscan.xyz",
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
    id: 146,
    name: "Sonic",
    nativeCurrency: { name: "Sonic", symbol: "S", decimals: 18 },
    rpcUrls: ["https://sonic-rpc.publicnode.com", "https://sonic.drpc.org"],
    explorerUrl: "https://sonicscan.org",
    testnet: false,
  },
  {
    id: 324,
    name: "zkSync Era",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.era.zksync.io", "https://zksync.drpc.org", "https://rpc.ankr.com/zksync_era"],
    explorerUrl: "https://era.zksync.network",
    testnet: false,
  },
  /* Polygon zkEVM (1101) was removed on 2026-08-14. Polygon Labs shut the
   * network down on 2026-07-01, after announcing the wind-down in June 2025;
   * the sequencer is off and its public RPCs answer 404. Left in the table it
   * would be a network the user can select, sign for, and broadcast into
   * nothing — an offered chain is a claim that it works.
   *
   * Anyone who held funds there: assets in a self-custodied address were
   * auto-migrated to Ethereum L1 and are recoverable through Polygon's zkEVM
   * Claims interface. Assets left inside a DeFi contract were not migrated.
   * This note is here because deleting the entry also deletes the only place
   * the app ever mentioned the chain. */
  {
    id: 5000,
    name: "Mantle",
    nativeCurrency: { name: "Mantle", symbol: "MNT", decimals: 18 },
    rpcUrls: ["https://mantle-rpc.publicnode.com", "https://mantle.drpc.org"],
    explorerUrl: "https://mantlescan.xyz",
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
    id: 42220,
    name: "Celo",
    nativeCurrency: { name: "Celo", symbol: "CELO", decimals: 18 },
    rpcUrls: ["https://celo-rpc.publicnode.com", "https://celo.drpc.org"],
    explorerUrl: "https://celoscan.io",
    testnet: false,
  },
  {
    id: 43114,
    name: "Avalanche C-Chain",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: [
      "https://avalanche-c-chain-rpc.publicnode.com",
      "https://avalanche.drpc.org",
    ],
    explorerUrl: "https://snowtrace.io",
    testnet: false,
  },
  {
    id: 59144,
    name: "Linea",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://linea-rpc.publicnode.com", "https://linea.drpc.org"],
    explorerUrl: "https://lineascan.build",
    testnet: false,
  },
  {
    id: 81457,
    name: "Blast",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://blast-rpc.publicnode.com", "https://blast.drpc.org"],
    explorerUrl: "https://blastscan.io",
    testnet: false,
  },
  {
    id: 534352,
    name: "Scroll",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://scroll-rpc.publicnode.com", "https://scroll.drpc.org"],
    explorerUrl: "https://scrollscan.com",
    testnet: false,
  },

  /* Testnets. Kept because a wallet nobody can rehearse on is a wallet people
   * end up rehearsing on with real money. */
  {
    id: 97,
    name: "BNB Smart Chain Testnet",
    nativeCurrency: { name: "Test BNB", symbol: "tBNB", decimals: 18 },
    rpcUrls: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"],
    explorerUrl: "https://testnet.bscscan.com",
    testnet: true,
  },
  {
    id: 1301,
    name: "Unichain Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://unichain-sepolia-rpc.publicnode.com",
      "https://unichain-sepolia.drpc.org",
    ],
    explorerUrl: "https://sepolia.uniscan.xyz",
    testnet: true,
  },
  /* Holesky (17000) was removed on 2026-08-14. The Ethereum Foundation shut it
   * down at the end of September 2025, after Pectra testing left it with an
   * exit queue it never recovered from; Hoodi (560048), already in this table,
   * is its designated replacement.
   *
   * Worth recording HOW this was caught, because responding is not the same as
   * working: one endpoint still answered eth_chainId and eth_blockNumber
   * correctly, so every liveness check based on "did it reply" passed it. The
   * block number was frozen at 5765077 across samples 45 seconds apart. That is
   * why scripts/check-rpc-liveness.mjs compares block height over time instead
   * of just asking whether the endpoint is up. */
  {
    id: 43113,
    name: "Avalanche Fuji",
    nativeCurrency: { name: "Test Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: [
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      "https://avalanche-fuji.drpc.org",
    ],
    explorerUrl: "https://testnet.snowtrace.io",
    testnet: true,
  },
  {
    id: 59141,
    name: "Linea Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://linea-sepolia-rpc.publicnode.com",
      "https://linea-sepolia.drpc.org",
    ],
    explorerUrl: "https://sepolia.lineascan.build",
    testnet: true,
  },
  {
    id: 80002,
    name: "Polygon Amoy",
    nativeCurrency: { name: "Test POL", symbol: "POL", decimals: 18 },
    rpcUrls: [
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://polygon-amoy.drpc.org",
    ],
    explorerUrl: "https://amoy.polygonscan.com",
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
    id: 421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.drpc.org",
    ],
    explorerUrl: "https://sepolia.arbiscan.io",
    testnet: true,
  },
  /* Scroll Sepolia (534351) was removed on 2026-08-14. Unlike Polygon zkEVM and
   * Holesky there is no shutdown announcement -- the chain is simply not
   * producing blocks. Every operator, including Scroll's own
   * sepolia-rpc.scroll.io ("No nodes available"), was frozen at block 19039813
   * across samples half an hour apart, while Scroll mainnet advanced normally.
   *
   * Listed-but-down is still down. A chain in this table is an offer to sign
   * and broadcast on it, and that offer is false while nothing accepts the
   * transaction. If Scroll Sepolia comes back, it comes back with a
   * scripts/check-rpc-liveness.mjs run showing blocks moving. */
  {
    id: 560048,
    name: "Hoodi",
    nativeCurrency: { name: "Hoodi Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-hoodi-rpc.publicnode.com", "https://hoodi.drpc.org"],
    explorerUrl: "https://hoodi.etherscan.io",
    testnet: true,
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
    id: 11155420,
    name: "OP Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [
      "https://optimism-sepolia-rpc.publicnode.com",
      "https://optimism-sepolia.drpc.org",
    ],
    explorerUrl: "https://sepolia-optimism.etherscan.io",
    testnet: true,
  },
] as const;

/**
 * The curated chains, stamped as such. `CHAINS` stays curated-only so that
 * existing callers — tx-interpret in particular — cannot start asserting a
 * user-supplied name by accident; custom chains are reached deliberately, via
 * `allChains()`.
 */
export const CHAINS: readonly ChainInfo[] = CURATED.map((c) => ({
  source: "curated" as const,
  ...c,
}));

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

/**
 * Every distinct origin the *curated* table may need to reach. Used to audit
 * the CSP. Custom chains are excluded on purpose: their origins cannot be in a
 * build-time allowlist, and mixing them in here would make the CSP audit pass
 * or fail depending on what the user typed yesterday.
 */
export function rpcOrigins(): string[] {
  const seen = new Set<string>();
  for (const c of CHAINS) for (const url of c.rpcUrls) seen.add(new URL(url).origin);
  return [...seen].sort();
}

/* ------------------------------------------------------ user-added chains
 *
 * The escape hatch. A curated table can never cover every EVM network, and
 * pretending otherwise is how uncurated data ends up wearing curated
 * authority. So the user supplies the whole entry themselves and it is marked
 * `custom` forever after.
 *
 * Three rules the rest of the app has to keep:
 *
 * - A custom entry never wins over a curated one. Otherwise "add a chain" is a
 *   way to rename Ethereum, and the chain name is a thing the user reads to
 *   decide whether to sign.
 * - A custom name is not evidence. Anywhere one is rendered, the `custom`
 *   marking must be rendered too — `chainLabelDetailed()` exists so a caller
 *   cannot get the name without the marking in the same call.
 * - The unknown-chain path stays. An ID in neither set still resolves to
 *   "chain N" with the existing warning, and `chainName()` still refuses to
 *   answer for it, which is what keeps tx-interpret honest.
 *
 * Storage is a two-method interface rather than a direct `localStorage`
 * reference so core stays runnable under node (tests) and any future
 * non-browser shell. The shape is deliberately localStorage's.
 */

export interface ChainStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where custom chains live. Versioned so a future format change is detectable. */
export const CUSTOM_CHAINS_KEY = "leekwallet.customChains.v1";

/** What the user fills in. Same fields as ChainInfo minus the source stamp. */
export interface CustomChainInput {
  id: number;
  name: string;
  nativeCurrency: NativeCurrency;
  rpcUrls: readonly string[];
  explorerUrl: string;
  testnet?: boolean;
}

export type ChainValidation =
  | { ok: true; chain: ChainInfo }
  | { ok: false; errors: string[] };

/** localStorage when there is one; otherwise an in-memory stand-in for tests. */
export function defaultChainStore(): ChainStore {
  const ls = (globalThis as { localStorage?: ChainStore }).localStorage;
  if (ls) return ls;
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  };
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a user-entered chain. Returns every problem at once rather than the
 * first, because a form that reveals its objections one at a time is a form
 * people give up on and paste an RPC into a browser instead.
 *
 * https is required for the same reason the CSP requires it: a plaintext RPC
 * lets anyone on the path lie about nonce, gas price and balance, which is
 * enough to get a bad transaction signed by an honest user.
 */
export function validateCustomChain(input: CustomChainInput): ChainValidation {
  // Not just for the form: this also runs over whatever is in storage, which
  // may be anything at all.
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["Not a chain definition."] };
  }
  const errors: string[] = [];
  const id = Number(input.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    errors.push("Chain ID must be a positive whole number.");
  } else if (getChain(id) !== undefined) {
    // Not merely a duplicate: allowing it would let a custom entry shadow a
    // name the user is relying on to be the checked one.
    errors.push(`Chain ${id} is already built in (${getChain(id)?.name}) and cannot be redefined.`);
  }

  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    errors.push("Name is required.");
  } else if (input.name.length > 40) {
    errors.push("Name must be 40 characters or fewer.");
  }

  const cur = input.nativeCurrency;
  if (typeof cur?.symbol !== "string" || cur.symbol.trim().length === 0) {
    errors.push("Currency symbol is required.");
  } else if (cur.symbol.length > 12) {
    errors.push("Currency symbol must be 12 characters or fewer.");
  }
  if (typeof cur?.name !== "string" || cur.name.trim().length === 0) {
    errors.push("Currency name is required.");
  }
  // 18 for every EVM gas token in practice; the bound catches a typo that
  // would move the decimal point by orders of magnitude in a balance display.
  if (!Number.isInteger(cur?.decimals) || cur.decimals <= 0 || cur.decimals > 18) {
    errors.push("Decimals must be a whole number between 1 and 18 (usually 18).");
  }

  const rpcUrls = Array.isArray(input.rpcUrls) ? input.rpcUrls : [];
  if (rpcUrls.length === 0) {
    errors.push("At least one RPC URL is required.");
  }
  for (const url of rpcUrls) {
    if (!isHttpsUrl(url)) errors.push(`RPC URL must be a valid https:// URL: ${String(url)}`);
  }
  if (new Set(rpcUrls).size !== rpcUrls.length) errors.push("Duplicate RPC URLs.");

  const explorer = typeof input.explorerUrl === "string" ? input.explorerUrl.replace(/\/+$/, "") : "";
  if (!isHttpsUrl(explorer)) errors.push("Explorer URL must be a valid https:// URL.");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    chain: {
      source: "custom",
      id,
      name: input.name.trim(),
      nativeCurrency: {
        name: cur.name.trim(),
        symbol: cur.symbol.trim(),
        decimals: cur.decimals,
      },
      rpcUrls: [...rpcUrls],
      explorerUrl: explorer,
      testnet: input.testnet === true,
    },
  };
}

/**
 * Read the persisted custom chains, re-validating every one.
 *
 * Re-validation is not paranoia about the user: localStorage is writable by
 * anything that ever gets script into this origin, so entries are treated as
 * untrusted input on the way *out* of storage as well as in. A malformed or
 * curated-shadowing entry is dropped rather than repaired, because silently
 * repairing it would produce a chain the user never entered.
 */
export function loadCustomChains(store: ChainStore = defaultChainStore()): ChainInfo[] {
  let parsed: unknown;
  try {
    const raw = store.getItem(CUSTOM_CHAINS_KEY);
    if (raw === null) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ChainInfo[] = [];
  const seen = new Set<number>();
  for (const entry of parsed) {
    const result = validateCustomChain(entry as CustomChainInput);
    if (!result.ok || seen.has(result.chain.id)) continue;
    seen.add(result.chain.id);
    out.push(result.chain);
  }
  return out;
}

function persist(chains: readonly ChainInfo[], store: ChainStore): void {
  // `source` is not persisted: it is a property of where the entry came from,
  // and re-deriving it on load means a hand-edited "source":"curated" in
  // storage cannot promote a user entry into a checked one.
  store.setItem(
    CUSTOM_CHAINS_KEY,
    JSON.stringify(chains.map(({ source: _source, ...rest }) => rest)),
  );
}

/** Add (or replace, by id) a custom chain. Returns the validation result. */
export function addCustomChain(
  input: CustomChainInput,
  store: ChainStore = defaultChainStore(),
): ChainValidation {
  const result = validateCustomChain(input);
  if (!result.ok) return result;
  const kept = loadCustomChains(store).filter((c) => c.id !== result.chain.id);
  persist([...kept, result.chain], store);
  return result;
}

/** Remove a custom chain. True if something was removed. */
export function removeCustomChain(
  chainId: number | bigint,
  store: ChainStore = defaultChainStore(),
): boolean {
  const id = Number(chainId);
  const current = loadCustomChains(store);
  const kept = current.filter((c) => c.id !== id);
  if (kept.length === current.length) return false;
  persist(kept, store);
  return true;
}

/** Curated first, then custom. The order is the trust order, and the UI shows it. */
export function allChains(store: ChainStore = defaultChainStore()): ChainInfo[] {
  return [...CHAINS, ...loadCustomChains(store)];
}

/**
 * Lookup across both sets, curated winning. For UI that must be able to reach
 * a custom chain (the selector, the RPC picker, explorer links). Note that it
 * returns the `source` with it — callers must not drop that on the floor.
 */
export function resolveChain(
  chainId: number | bigint,
  store: ChainStore = defaultChainStore(),
): ChainInfo | undefined {
  return getChain(chainId) ?? loadCustomChains(store).find((c) => c.id === Number(chainId));
}

export interface ChainLabel {
  /** Safe to render on its own: already carries the caveat for custom chains. */
  text: string;
  /** The bare name, or undefined when nothing named this ID. */
  name?: string;
  source?: ChainSource;
  /** True when nothing — curated or custom — knows this ID. */
  unknown: boolean;
}

/**
 * The label plus what it is worth, in one call, so a renderer cannot obtain a
 * user-supplied name without also obtaining the fact that it is user-supplied.
 * `text` is deliberately pre-qualified rather than leaving that to a caller who
 * might forget on one screen out of five.
 */
export function chainLabelDetailed(
  chainId: number | bigint,
  store: ChainStore = defaultChainStore(),
): ChainLabel {
  const id = Number(chainId);
  const found = resolveChain(id, store);
  if (found === undefined) return { text: `chain ${id}`, unknown: true };
  return {
    text: found.source === "custom" ? `${found.name} (custom, unverified)` : found.name,
    name: found.name,
    source: found.source,
    unknown: false,
  };
}

/** The sentence a UI must show next to any custom chain it is offering. */
export const CUSTOM_CHAIN_NOTICE =
  "This network was added by you, not checked by this app. Its name, symbol and " +
  "RPC are whatever was typed in; only the chain ID shown on the device decides " +
  "which network your signature is valid on.";

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
