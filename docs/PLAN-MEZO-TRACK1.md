# Mezo Track 1: the DeFi repo

Planning for the **second** submission: a separate repository, entered in Track
1 (DeFi), settling in MUSD, with LeekWallet as the hardware that signs it. The
wallet's own work is [PLAN-MEZO.md](PLAN-MEZO.md) and stays in this repo; this
document exists here only until the new repo is created, then moves there.

Both tracks may be entered: the AKINDO form takes track selection as multiple
choice. Two submissions that share one story — *the asset, and the hardware that
holds it* — score better than two unrelated ones.

**Deployment chains, from the Terms of Participation:** Mezo Mainnet, Ethereum,
Base, **BSC**, or **Robinhood**. Mezo testnet is explicitly welcome. Note the
Terms say BSC and Robinhood where the overview page said BNB Chain; the Terms
are the binding document.

## 1. What this is

An **ETF marketplace**: a factory that issues share tokens tracking an index,
priced by an oracle, bought and redeemed in MUSD, with a lending market behind
it so shares can be collateral. Multichain, with Mezo and MUSD at the centre.

Three parts, in the order they earn their place:

1. **Oracle.** A price feed fed by the API on your server.
2. **ETF factory and shares.** Issue, price, buy and redeem against MUSD.
3. **Lending.** A Mezo-style trove market, so shares and MUSD are productive.

## 2. What we already own, and should reuse

**The factory pattern from the Hedera ATS work, which the firmware still
decodes.** `src/eth-decode.c` carries `deployEquity(string,string)` and
`deployBond(string,string)`, and `src/eth-decode.h:77` records why they are
drawable at all: the factory froze a 3,748-byte template on chain, so the only
values that vary are the two on the screen. `ETH_MAX_DATA` is 768 bytes
(`src/eth-tx.h:61`), and the ATS struct was five times that.

**That is the design constraint for the ETF factory, not an afterthought.**
`deployETF(string name, string symbol)` with everything else frozen in verified
on-chain code is drawable on a 128x64 screen today. A constructor taking a
seventeen-field struct is not, and by rule 4 of [MINI-APPS.md](MINI-APPS.md)
what cannot be drawn is not signed. Design the factory so the device can draw
it, and the hardware story comes free.

**The lending market**, if it is a fork of `mezo-org/musd`, is **GPL-3.0** and
must be its own repository under GPL-3.0 with the lineage credited. Its deploy
scripts include a mock price aggregator, so a testnet deployment is
configuration. See PLAN-MEZO.md §3.6.

## 3. The oracle

Mezo's own `PriceFeed` consumes `ChainlinkAggregatorV3Interface`
(`solidity/contracts/interfaces/` in `mezo-org/musd`). **Implement that
interface** and the oracle drops into both their code and ours without a shim.

Design, and its honest weaknesses:

| | |
|---|---|
| Source | the API on your server pushes `latestRoundData` updates |
| Trust | **single operator — you.** This is the weakest link in the whole design and must be documented, not glossed |
| Staleness | consumers must reject an answer older than a heartbeat, and the contract should expose `updatedAt` honestly rather than touching it on every read |
| Bounds | reject a move larger than a set percentage per round; a fat-fingered or compromised push should fail, not liquidate everyone |
| Pausing | a guardian that can halt issuance when the feed is stale |

For a testnet submission a single-operator oracle is acceptable **if it is
described as one**. Judges score security at 20%, and a design that names its
own trust assumption reads better than one that hides it.

## 4. The naming problem, which is not cosmetic

Selling tokens called "Google" or "Amazon" stock has two separate costs, and
the second one is in the rules you just agreed to.

1. **Trademark.** The Terms, §8(c), warrant that your submission "does not and
   will not infringe the intellectual property or proprietary rights of any
   third party, including... trademarks." Naming a share token after a real
   company, or using its logo, is exactly that risk.
2. **Securities framing.** A token sold as exposure to real equity, even on a
   testnet, invites a reading nobody wants, and these jurisdictions are not
   friendly ground for it.

**Both are avoidable at no cost to the demo**, because what you are showing is
the mechanism, not the ticker:

- **Synthetic indices with our own names.** `LEEK-TECH`, `LEEK-BTC-YIELD`. No
  trademark, no claim about real shares, and the oracle can still be fed real
  index data for realism.
- **Explicit mock tickers**, if realism matters: `mkGOOGL`, with "mock,
  unbacked, testnet only" on the contract, the UI and the token name itself.
  Weaker than the first option; still far better than `GOOGL`.
- Either way: **testnet only, no real backing claimed, disclaimer in the
  contract's own metadata**, so it travels with the token.

Recommendation: synthetic indices. It removes a legal question from a
submission that is otherwise strong on exactly the axis — "genuinely deployable
rather than just a demo" — that this choice would undermine.

## 5. The bridge, and why I would not write one

You have a server that could run a relayer, so a custom bridge is possible. It
is also the single most dangerous thing on this list: a bridge is a contract
holding other people's assets whose safety rests entirely on an off-chain
signer, and "we wrote our own bridge in two weeks" is the sentence a security
reviewer stops reading at.

Three options, in the order I would take them:

1. **Use Wormhole NTT, which already supports Mezo.** MUSD and MEZO are bridged
   that way today, with manager and transceiver addresses recorded in
   PLAN-MEZO.md §3.4. Making ETF shares an NTT token gives multichain transfer
   with no trusted relayer of ours, and "composability with existing
   infrastructure" is a stated scoring preference.
2. **No bridge: deploy the market on each chain** and let MUSD arrive by the
   official bridge. Multichain by deployment rather than by transfer. Cheapest
   and nearly as good a story.
3. **Our own relayer**, testnet only, if there is a reason the first two cannot
   serve: a single signer, mint caps per period, a pause guardian, replay
   protection by chain ID and nonce, and documentation that says plainly it is
   trusted and unaudited. Never on mainnet.

Recommendation: **1 for the shares, 2 for the market.** Keep the server for the
oracle, which genuinely needs it.

## 6. Scope, against the calendar

Wave 1 closes **26 Oct**, twelve days from the start. Wave 2 closes **15 Nov**.
The failure mode here is three half-built systems; the fix is one finished
spine per wave.

**Wave 1 — the spine.**
- Oracle contract implementing `AggregatorV3`, fed by the server, with
  staleness and bounds. Deployed on Mezo testnet.
- ETF factory plus one index, `deployETF(string,string)`, template frozen
  on-chain so the device can draw the call.
- Buy and redeem in **MUSD** on Mezo testnet. This is the MUSD integration, and
  it must be real: shares priced in MUSD, settled in MUSD.
- A minimal dapp, and **LeekWallet signing the issuance and a purchase**, which
  is the cross-submission story.
- Pitch video and deck.

**Wave 2 — depth.**
- Lending: the musd fork on testnet, ETF shares as collateral, MUSD borrowed
  against them. Separate repo, GPL-3.0.
- Multichain: shares as an NTT token, or a second deployment on Base Sepolia.
- Firmware: a decoder row for `buy`/`redeem` so the device draws those too,
  which lands in the **wallet** repo, not this one.
- Wave 2 resubmissions must state what changed; keep the changelog as you go.

## 7. How the two submissions reference each other

- **Track 2 (LeekWallet):** a hardware wallet that decodes MUSD and Mezo
  borrowing on its own screen, and signs air-gapped. Mentions the ETF dapp as
  the dapp it was tested against.
- **Track 1 (this repo):** an MUSD-settled ETF market whose issuance and
  purchases can be confirmed on hardware that draws them field by field.

Same story from both ends, and each is a complete submission alone.

## 8. Decisions taken

Settled 14 Oct 2026:

| Question | Decision |
|---|---|
| Tickers | **Parody names**: Gologgle, Amezon and the like. Distinct marks, no logos, no claim of real equity exposure. Metadata says mock, unbacked, testnet |
| Bridge | **No bridge of ours.** Wormhole NTT for anything that must move; the market deploys per chain. The server runs the oracle only |
| Oracle | **Ours, on your server**, implementing `AggregatorV3Interface`. This needs no permission from Chainlink: the interface is four view functions, and Mezo's own `MockAggregator` is exactly this. Prices come from an open-source real-time index feed |
| Missing MUSD on other testnets | **Deploy our own mock MUSD and mock MEZO** there, clearly labelled (§9) |
| Wave split | Wave 1 marketplace; Wave 2 leverage, built as **looping on the lending market**, not a perps exchange (§6) |

### A note on parody names

Parody is the right call and it holds as long as the name is a distinct mark and
the product never claims to be the real thing. So: no logos, no colour schemes
lifted from the originals, no "tracks Alphabet's share price" in the copy. The
token tracks *an index our oracle publishes*, which happens to be real data.
`Gologgle` is a parody; `Gologgle (GOOGL)` with Alphabet's logo is a problem
wearing a funny hat.

## 9. Mock MUSD and MEZO on the other testnets

MUSD exists on no testnet but Mezo's own, and MEZO answers only on Sepolia and
Base Sepolia (PLAN-MEZO.md §3.6). So multichain testnet work needs tokens we
deploy. Rules for them:

- **Named so they cannot be mistaken for the real thing**: `mockMUSD` with
  symbol `mMUSD`, not `MUSD`. A faucet-mintable ERC-20 with 18 decimals, open
  `mint()` on testnets only.
- **Never on a mainnet**, and the deploy script should refuse a mainnet chain ID
  outright rather than rely on discipline.
- **The real one takes precedence where it exists.** On Mezo testnet the market
  uses the real MUSD at `0x118917a4…`. The mocks exist for Sepolia, Base
  Sepolia and BSC testnet only.

That ordering matters for scoring: *depth of MUSD integration* is judged, and a
submission whose flagship deployment uses real testnet MUSD on Mezo, with mocks
only where Mezo has not deployed, is a far stronger claim than one running
entirely on tokens we minted.

## 10. Architecture

Contracts, in dependency order. Nothing here is a fork unless it says so.

**Oracle**
- `IndexOracle` — implements `AggregatorV3Interface` (`decimals`,
  `description`, `latestRoundData`, `getRoundData`). One instance per index.
  Push-only, owner-restricted, with: `maxStaleness` after which consumers must
  refuse, `maxDeviationBps` per round, a `paused` flag, and monotonic round IDs.
- `OracleRegistry` — index symbol to oracle address, so the factory and the
  market resolve feeds by name rather than hardcoding.

**ETF market (Wave 1)**
- `ETFShare` — ERC-20 share token, 18 decimals, mint and burn restricted to its
  vault. Written NTT-compatible (mint/burn controlled by a manager role) so
  Wormhole can carry it later without a rewrite.
- `ETFFactory` — `deployETF(string name, string symbol)` **and nothing else in
  the signature**. Index composition, oracle, fee and settlement token come
  from registry state frozen before deployment. This is the ATS lesson (§2) and
  it is what keeps the call drawable on the device.
- `IssuanceVault` — `buy(uint256 musdAmount, uint256 minShares)` and
  `redeem(uint256 shares, uint256 minMusd)`, priced from the oracle, settled in
  MUSD, with slippage bounds and a fee in basis points to the treasury. Refuses
  a stale or paused feed.
- `Treasury` — fees, withdrawable by owner. Dull on purpose.

**Lending (Wave 2)**
- Either a **fork of `mezo-org/musd`** (GPL-3.0, own repo, lineage credited —
  inherits audited trove mechanics, mock aggregator included) or a **simple
  original market** (no GPL question, less battle-tested). Decision still open.
- Collateral: ETF shares and MUSD. Debt: MUSD. The price of a share comes from
  the same `IndexOracle`, which is the whole reason the oracle is first.

**Leverage (Wave 2), as looping not perps**
- `LoopStrategy` — deposit shares, borrow MUSD against them, buy more shares,
  repeat to a target ratio, in one transaction, with a max-loops bound and a
  health-factor floor.
- This is what Track 1 actually asks for: "looping strategies for MUSD/MEZO
  positions (leveraged yield farming)". A perps exchange needs a funding rate,
  a matching engine and a liquidation keeper, which is a quarter of work, not a
  fortnight, and its risk sits on the oracle we just admitted is single-operator.
  2x and 3x via looping is the same user-facing promise with a tenth of the
  attack surface.

**What the device draws, and therefore what the firmware needs**
| Call | Firmware cost |
|---|---|
| `approve(MUSD, vault, amount)` | none, decoded today |
| `deployETF(string,string)` | none if shaped like ATS; the decoder exists |
| `buy(uint256,uint256)` / `redeem(uint256,uint256)` | one table row each, static types |
| `loop(uint256,uint256,uint8)` | one table row, static types |
Each row needs shared C/TypeScript vectors including refusals, and lands in the
**wallet** repo.

## 11. Decisions still open

1. **Repo and licence** — one repo for ETF plus lending under GPL-3.0
   (simplest if the lending market is a musd fork), or two repos so the ETF
   code stays permissive.
2. **Whether the lending market is a fork at all.** A fork inherits audited
   mechanics and the GPL; an original simpler market avoids both. Both are
   defensible; pick deliberately before Wave 2 starts.
3. **Which index feed.** It must be open source or openly licensed for
   redistribution, since the oracle republishes it on chain.
