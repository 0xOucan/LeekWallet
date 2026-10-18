/**
 * The LeekStonks deployment on Mezo testnet, round two.
 *
 * Every address here was read out of the deploy log by
 * `leek-stocks/scripts/record-deployment.sh`, which verifies on chain before
 * it writes: code at each address, each vault bound to its own share and its
 * own oracle, both settling in the borrowable MUSD, both wired to staking, and
 * the two indices not collapsed onto one oracle. Then checked again here on
 * 2026-10-18 against rpc.test.mezo.org.
 *
 * Addresses are permanent once deployed, so carrying them in source is not a
 * copy that can drift into being wrong - only into being old. What makes old
 * detectable is that every read below goes through the vault: the share token
 * and the oracle are asked for, never assumed, so a stale vault address fails
 * loudly on the first read instead of quietly pricing against nothing.
 *
 * MUSD is the one entry worth care. Mezo testnet carries five contracts
 * answering symbol() "MUSD" with 18 decimals, and only this one has
 * mintList(BorrowerOperations) true - the only one the borrow system mints and
 * the only one the vaults accept. The address Mezo's own documentation names,
 * 0x118917a4..., is not it.
 */

/** Mezo testnet. The only chain this app is deployed on. */
export const MEZO_TESTNET = 31611;

export interface IndexDeployment {
  /** The invented index name. Not a company; see the disclaimer in index.ts. */
  readonly symbol: string;
  readonly vault: string;
  /** Read back from the vault at mount; this is only the expectation. */
  readonly share: string;
}

export const INDICES: readonly IndexDeployment[] = [
  {
    symbol: "GOLOGGLE",
    vault: "0xF13f191F1eaB90E5331DA292dA922E3b797B1824",
    share: "0xa4220DF063149aa750bd54bEf578b244a3bc9Be7",
  },
  {
    symbol: "AMEZON",
    vault: "0x4b6C535b6d298fB8a51E3577d7037340359d18E1",
    share: "0x6c4A0dEcA88C51a27E91841E7017f1bE654769aD",
  },
];

/** MEZO fee-discount staking. Takes MEZO, pays MUSD, mints sMEZO. */
export const STAKING = "0x6b15c487471CcE6A088D292A2f3834942a60e998";

/** The settlement token: the MUSD BorrowerOperations can mint. */
export const MUSD = "0xf9BBcCC0F1b68EA07c86de6F88C76b3d8E2dD0af";

/** MEZO as an ERC-20. A precompile, same reserved address on both networks. */
export const MEZO = "0x7B7c000000000000000000000000000000000001";

/**
 * Mezo's own faucet, which hands out the testnet BTC that is both gas and
 * borrow collateral here.
 *
 * A link and not a button: this app cannot claim for you, and a button that
 * opened a browser tab would look like one that did something on chain. MUSD
 * is deliberately absent from it - on Mezo testnet the MUSD is the real one,
 * minted by borrowing against BTC, so there is nothing to faucet.
 */
export const MEZO_FAUCET = "https://faucet.test.mezo.org";

/** Mezo's borrow market, where MUSD comes from. Shown, never called by this app. */
export const BORROWER_OPERATIONS = "0xa14cbA6DD12D537A8decc7dd3c4aC413B8711eba";
