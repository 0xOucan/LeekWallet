# Mezo Buildathon: the roadmap

One schedule across two submissions and three code surfaces. The reasoning
lives in [PLAN-MEZO.md](PLAN-MEZO.md) (the wallet, Track 2) and
[PLAN-MEZO-TRACK1.md](PLAN-MEZO-TRACK1.md) (the ETF and lending platform,
Track 1). This document is what to do, in what order, by when.

**Wave 1 build closes 26 Oct 2026. Wave 2 runs 2–15 Nov. Demo 23 Nov.**

## 1. Repositories and licences

Three surfaces, two new repositories:

| Repo | Holds | Licence | Why |
|---|---|---|---|
| `leekwallet` (this one) | firmware, companion, the Mezo **mini-app** | Apache-2.0 | unchanged |
| `leek-stocks` (new) | oracle, ETF factory, shares, issuance vault, **public web front end**, deploy scripts | Apache-2.0 | original work; keep it permissive so the wallet can depend on its ABIs freely |
| `leek-lend` (new, Wave 2) | the lending market | **GPL-3.0 if it is a fork of `mezo-org/musd`** | a published fork is a derivative work; the GPL stays contained in its own repo instead of infecting either of the others |

**Two new repos rather than one**, so a GPL lending fork cannot contaminate the
ETF code or the wallet. If Wave 2's market turns out to be original rather than
a fork, `leek-lend` can be Apache-2.0 too and the split costs nothing.

**What crosses a repo boundary is data, never code.** The wallet's mini-app
vendors the ABI JSON and the deployed addresses — facts, not derivative work —
and never imports the platform's source. That keeps MINI-APPS.md rule 1 intact
and keeps the mini-app deletable in one commit.

## 2. The two front ends, and why both exist

The same contracts are reached two ways, deliberately:

**A. The public dapp** (`leek-stocks/web`, on your server, internet-facing).
Anyone can open it with any wallet. It is what the submission's "live project
link" points at, and what a judge clicks. It reaches LeekWallet, if the user
has one, through **WalletConnect**, exactly as any other dapp does — no special
casing.

**B. The in-wallet mini-app** (`app/packages/apps/mezo/` in this repo).
Opens inside the companion next to the device, builds calldata and hands it to
`screenProposal`. It cannot touch a key, a transport or the device; that is the
framework's rule and the reason an app is safe to ship at all.

They are not redundant. A owns discovery and is the thing that works for
everyone; B owns the part that only this project can show — an ETF purchase
whose every field is drawn by hardware that decoded the calldata itself. The
pitch video needs both: the dapp for "this is a product", the mini-app plus
device for "and this is why it is safer".

The mini-app's shape, from `core/mini-app.ts`: an `id`, a `name`, a one-line
`summary`, the `chainIds` it declares for itself, its own stylesheet, and no
import of any other app. `worksWithoutDevice` stays **false** — unlike La
Caja's waiter, this app's whole point is the device.

## 3. Wave 1: 16–26 Oct

The spine, finished, with nothing half-built. Ten days.

### Wallet, in this repo

| ID | Task | State |
|---|---|---|
| T-MEZO-1 | Mezo mainnet and testnet in the chain table, BTC gas, CSP hosts | **done** (`05ff984`) |
| T-MEZO-2 | MUSD and MEZO token hints, verified per chain | **done** (`05ff984`) |
| T-MEZO-3 | **The gas symbol on the device.** Replace the hardcoded `"ETH"` in `src/ui.c` with the chain's own ticker, so Mezo draws BTC. Firmware chain table, host vectors, a `sim/test_ui.c` case on 31611 | next |
| T-MEZO-4 | Air-gapped MUSD payment on Mezo testnet, end to end, filmed: phone builds, camera reads, device draws, QR signature back, phone broadcasts | after T-MEZO-3 |
| T-MEZO-5 | `app/packages/apps/mezo/`: balances, MUSD send through `screenProposal`, and the ETF surface once `leek-stocks` has addresses | after the contracts |
| T-MEZO-9 | Submission: deck, 2-minute video, AKINDO answers, README section | last two days |

### Platform, in `leek-stocks`

| ID | Task | Depends on |
|---|---|---|
| S-1 | Repo, Foundry or Hardhat, CI that runs tests, Apache-2.0, README that states the trust model plainly | — |
| S-2 | `IndexOracle` implementing `AggregatorV3Interface`: push-only, owner-restricted, `maxStaleness`, `maxDeviationBps`, pausable, monotonic rounds | S-1 |
| S-3 | The feed service on your server: pull an openly licensed index, push rounds on a heartbeat, expose a read-only JSON endpoint for the front ends. systemd unit, TLS, CORS | S-2 |
| S-4 | `ETFShare` (ERC-20, mint/burn by vault, NTT-compatible roles) and `ETFFactory` with **exactly** `deployETF(string name, string symbol)` — everything else frozen in registry state, because that is what keeps the call drawable on a 128x64 screen | S-2 |
| S-5 | `IssuanceVault`: `buy(uint256 musdAmount, uint256 minShares)`, `redeem(uint256 shares, uint256 minMusd)`, priced from the oracle, **settled in real testnet MUSD on Mezo**, fee in basis points, refuses a stale or paused feed | S-4 |
| S-6 | Deploy to Mezo testnet with two parody indices (Gologgle, Amezon), addresses recorded in the repo | S-5 |
| S-7 | `web/`: the public dapp — connect, see indices and prices, buy, redeem, WalletConnect. Hosted on your server at a real domain | S-6 |
| S-8 | Mock `mMUSD` and `mMEZO` plus a second deployment on **Sepolia**, to show multichain. The deploy script refuses mainnet chain IDs | S-6 |

**Critical path:** S-2 → S-4 → S-5 → S-6 → S-7, with T-MEZO-5 hanging off S-6
and the video off both. T-MEZO-3 and T-MEZO-4 are independent of all of it and
should be done first, while the contracts are still being written.

**Day shape, as a target rather than a promise:** oracle and feed by day 3;
factory, share and vault by day 6; deployed with two indices by day 7; dapp and
mini-app by day 9; film and submit on day 10. If something slips, the thing to
cut is S-8, then the mini-app's ETF surface — never the MUSD settlement, which
is the integration being judged.

## 4. Wave 2: 2–15 Nov

Depth, and the things Wave 1 deliberately left out.

| ID | Task | Repo |
|---|---|---|
| T-MEZO-6 | Mezo borrow calls in the device's decodable set: `openTrove`, `withdrawMUSD`, `repayMUSD`, `addColl`, `withdrawColl`, `closeTrove`. One table row each, shared vectors, refusals included | wallet |
| T-MEZO-7 | Trove health in the mini-app, read from `TroveManager` | wallet |
| L-1 | The lending market: fork of `musd` (GPL-3.0) or an original market. **Decide before 2 Nov** | `leek-lend` |
| L-2 | ETF shares as collateral, MUSD as debt, priced by `IndexOracle` | `leek-lend` |
| L-3 | `LoopStrategy`: deposit, borrow, buy, repeat to a target ratio in one transaction, with a loop bound and a health-factor floor. This is the 2x/3x story, and it is what Track 1 names | `leek-lend` |
| S-9 | `buy`/`redeem`/`loop` decoder rows so the device draws those too | wallet firmware |
| S-10 | Shares as a Wormhole NTT token, or a second market deployment on Base Sepolia | `leek-stocks` |
| H-1 | **The 1.5" SH1107 board profile**: new driver, 128x128, QR at version 6, encoder behind a capability flag. A separate `s3cam15` profile so the 0.96" build keeps working | wallet firmware |
| W-2 | Both resubmissions, each stating what changed since Wave 1 | docs |

H-1 is Wave 2 on purpose. The kit is ready but not connected, and a screen
driver is not what wins a software submission ten days before a deadline. It is
a strong "what changed" item, and it doubles the QR payload per frame while
making each module physically larger — which is the honest fix for the
limitation the README currently documents.

## 5. What would sink this, and the countermeasure

| Risk | Countermeasure |
|---|---|
| Three half-built systems | one finished spine per wave; S-8 and the ETF mini-app surface are the designated cuts |
| No test MUSD in time | get it on day 1: borrow against test BTC, or swap in the testnet dApp. The faucet gives BTC and MEZO, **not** MUSD |
| The oracle is a single operator | say so, in the README and the pitch. Add staleness and deviation bounds so it fails closed |
| A parody name read as the real thing | distinct marks, no logos, no copy claiming it tracks a real share price; "mock, unbacked, testnet" in the token metadata |
| GPL contamination | the fork lives alone in `leek-lend`; only ABIs and addresses cross a boundary |
| A judge cannot run it | the public dapp is the live link, and it must work with a plain browser wallet and no hardware |

## 6. Today

1. **T-MEZO-3**, the gas symbol on the device. Hours, not days, and it is the
   single strongest integration item in the wallet.
2. **S-1 and S-2** in the new repo: scaffold, then the oracle.
3. **Get test MUSD** on Mezo testnet, because every settlement path needs it.
