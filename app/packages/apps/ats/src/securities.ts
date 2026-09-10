/**
 * The securities this console offers by name, and the pilot it will not.
 *
 * ---------------------------------------------------------------------------
 * Why a table at all
 *
 * The address field stays, and it is still the only thing that decides which
 * contract is read. What this table changes is the default: four real
 * securities exist on Hedera testnet, and a console whose only one-click option
 * was the built-in fixture taught its user that the fixture is what this app is
 * for. The fixture is still here, still one click away, and still carries
 * `FIXTURE_NOTICE` on every screen it reaches — that honesty is the reason the
 * fixture is safe to keep, and it is not weakened by giving the real ones a
 * place beside it.
 *
 * Everything below is a LABEL. The symbol, the name and the decimals are this
 * app's own note about an address; the register read is what produces figures,
 * and the register read is what the screen shows. Nothing here is evidence
 * about a contract, which is why none of it is passed to `SecurityFacts` —
 * those come from the chain (act-view.ts's `factsFrom`), deliberately.
 *
 * ---------------------------------------------------------------------------
 * The pilot that cannot be used, and why it is listed anyway
 *
 * `0x651e73eb…` (`LEEK`) was the first deployment from this workspace. It was
 * granted DEFAULT_ADMIN_ROLE and nothing else, so it cannot be minted: the
 * issuer role was never granted, and DEFAULT_ADMIN_ROLE does not imply it. It
 * is listed here as RETIRED rather than omitted because an address that is
 * absent from a list is an address someone pastes into the field, and the
 * console then reads a register that looks entirely normal right up to the
 * point where a mint refuses on chain for a reason nobody can see. Naming it,
 * with the reason, is the only version of this that helps.
 */

/** Hedera testnet. Every address below is chain 296 only. */
export const ATS_SECURITIES_CHAIN_ID = 296;

export interface KnownSecurity {
  address: string;
  /** Advisory. The register read is what a screen shows. */
  symbol: string;
  name: string;
  /** Advisory, and never used to scale anything: decimals() is read. */
  decimals: number;
  kind: "equity" | "bond";
}

/**
 * Deployed from this workspace, verified by `eth_call` on 2026-09-10: each one
 * answers `name`, `symbol`, `decimals` (6) and `totalSupply`, and each has the
 * Issuer role granted to the deployer at birth — which is what the retired
 * pilot below lacks.
 */
export const KNOWN_SECURITIES: readonly KnownSecurity[] = [
  {
    address: "0x188fd9e330d22edd3381b21715d0a1722206b43f",
    symbol: "LEEKA", name: "LeekWallet Equity Series A", decimals: 6, kind: "equity",
  },
  {
    address: "0xaab4b09e4691ec2284399a6a27466a498051bb23",
    symbol: "VGF1", name: "Vega Growth Fund I", decimals: 6, kind: "equity",
  },
  {
    address: "0x653bfb114985583e30a80b62a81f5bad1d4852eb",
    symbol: "HRBR", name: "Harbour Industrial", decimals: 6, kind: "equity",
  },
  {
    address: "0x512988f3e1a2fc5da6fa65daffd35bb7437a3c84",
    symbol: "LEEKB", name: "LeekWallet Bond 2026", decimals: 6, kind: "bond",
  },
];

/** A security this console will read but will not present as usable. */
export interface RetiredSecurity extends KnownSecurity {
  why: string;
}

export const RETIRED_SECURITIES: readonly RetiredSecurity[] = [
  {
    address: "0x651e73ebcf18ef7e050c90af0461d91d640635bb",
    symbol: "LEEK", name: "LeekWallet pilot", decimals: 6, kind: "equity",
    why:
      "This pilot cannot be minted. Its deployer holds DEFAULT_ADMIN_ROLE and " +
      "nothing else, and DEFAULT_ADMIN_ROLE does not imply the Issuer role — so " +
      "a mint against it reverts on chain, after the press. Its register reads " +
      "normally, which is exactly why it is named here rather than left out.",
  },
];

export const securityAt = (address: string): KnownSecurity | undefined =>
  KNOWN_SECURITIES.find((s) => s.address === address.trim().toLowerCase());

export const retiredAt = (address: string): RetiredSecurity | undefined =>
  RETIRED_SECURITIES.find((s) => s.address === address.trim().toLowerCase());

/** The sentence that must accompany any label taken from the table above. */
export const SECURITY_LABEL_NOTICE =
  "The name and symbol beside each address are this app's own note, not a " +
  "reading of the contract. The address is what is read and what the device " +
  "shows; every figure on the register below came from the chain.";
