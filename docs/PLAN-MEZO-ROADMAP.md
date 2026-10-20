# Mezo Buildathon: the roadmap

One schedule across two submissions and three code surfaces. The reasoning
lives in [PLAN-MEZO.md](PLAN-MEZO.md) (the wallet, Track 2) and
[PLAN-MEZO-TRACK1.md](PLAN-MEZO-TRACK1.md) (the ETF and lending platform,
Track 1). This document is what to do, in what order, by when.

**Wave 1 build closes 26 Oct 2026. Wave 2 runs 2–15 Nov. Demo 23 Nov.**

## Status, 17 Oct 2026

| | |
|---|---|
| **LeekStonks contracts** | **live on Mezo testnet (31611)**, settling in the MUSD Mezo's own borrow system mints. Seven contracts; three verified on the explorer, all seven against the source |
| **Keys** | split: `leek-publisher` can only publish prices, `monad-deployer` can do everything but publish. The deployer's publisher rights were revoked on both oracles |
| **Price feed** | runs, rehearsed against the live oracles, reports its chain id. Not on the VPS yet |
| **Dapp** | 58 kB entry, 34 tests, clicked through against a local chain: approve, buy, redeem, and a refusal that predicted its own revert. Not pointed at Mezo yet, not deployed |
| **Leeknding** | written: 95 tests, 8 invariants, mocks, a rate-limited faucet that refuses mainnet ids, seeding and monitoring scripts. Deployed nowhere |
| **Wallet** | chains, MUSD and MEZO token rows, and the per-chain gas ticker all merged (T-MEZO-1, 2, 3). A Mezo transaction draws **BTC**, and an unlisted chain draws no ticker at all |
| **Owed** | the air-gapped demo on hardware (T-MEZO-4), Leeknding to Sepolia and Base Sepolia, and the submission materials. **No buy or redeem has been signed on the device yet.** The mini-app (T-MEZO-5), the borrow decoders (T-MEZO-6, pulled forward from Wave 2) and the VPS deploy are done |
| **Blocked on you** | test MUSD for the demo, a free Etherscan API key for Sepolia verification, and Cloudflare CNAMEs when the VPS deploy happens |

What the deployment taught, all of it recorded in `leek-stocks/DEPLOYMENT.md`:
Mezo checks Cosmos **sequences** rather than queuing nonces, so Foundry's
pipelined broadcast is refused; a transaction sits in a block long before its
**receipt** can be read, so a successful deploy reports failure; and the
explorer does not index contracts **deployed by a contract**, so four of ours
cannot be verified there and are checked against the source instead. None of
the three is in Mezo's documentation, and each is worth a line in the
submission's limitations.

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

**Three repositories, but one dapp.** The split is about licences and
deletability, not about what a user sees: the front end in `leek-stocks/web`
serves both the ETF market and the lending market, because a front end consumes
ABIs and addresses, which are data. An Apache-2.0 front end talking to GPL-3.0
contracts is fine; an Apache-2.0 *fork* of them would not be.

**How the contracts are written.** Foundry, Solidity 0.8.28, `evm_version =
london` to match Mezo's documented setting, OpenZeppelin v5 for roles and
SafeERC20. The ethskills security and testing checklists are the standard every
contract is held to before deployment: explicit access control on every
privileged function, Checks-Effects-Interactions, no hardcoded `1e18`, multiply
before divide, events on every state change, input validation including zero
addresses and amounts, and tests that cover properties rather than restating
the implementation — unit, fuzz at **1000 runs minimum**, invariant tests for
anything stateful, fork tests for anything touching an external protocol, and a
gas snapshot. `slither` is not installed on this machine yet and is a gate
before any deployment.

**Deploy keys.** Mezo is EVM, so the existing `monad-deployer` keystore account
works on Mezo testnet; its address needs test BTC from the faucet for gas.
Passwords are typed into a prompt (`forge script --account monad-deployer`),
never passed on a command line, and never echoed.

**What crosses a repo boundary is data, never code.** The wallet's mini-app
vendors the ABI JSON and the deployed addresses — facts, not derivative work —
and never imports the platform's source. That keeps MINI-APPS.md rule 1 intact
and keeps the mini-app deletable in one commit.

### What stays in the wallet after the hackathon, and what goes

The Mezo work divides cleanly, and it is worth keeping it that way as it is
written rather than sorting it out afterwards:

| Addition | After the event |
|---|---|
| Mezo chains in the chain table, MUSD and MEZO token hints | **stays.** Generic wallet capability: one more EVM chain and four more verified token rows, the same shape as every other entry |
| The per-chain gas symbol on the device (T-MEZO-3) | **stays.** It is a correctness fix for any chain whose gas is not ether, and Mezo only exposed it |
| Borrow-call decoder rows (T-MEZO-6) | **stays** unless the calls go unused. Decoding is wallet capability, and a decoder that is deleted takes its vectors with it |
| `app/packages/apps/leekdefi/` | **goes**, in one commit, like Aqua and ATS before it. The hackathon surface is the removable part, which is exactly why it lives there |
| The 1.5" board profile (H-1) | **stays.** Hardware support is not event-specific |

So: no board hardware is needed for any of the Mezo software work, the wallet
keeps everything that is generally useful, and the event-shaped code is
quarantined from the start. The expectation that there are no mini-apps after
the hackathon costs nothing under this split — the framework survives an empty
`MINI_APPS`, as it does today.

## 2. The two front ends, and why both exist

The same contracts are reached two ways, deliberately:

**A. The public dapp** (`leek-stocks/web`, on your server, internet-facing).
Anyone can open it with any wallet. It is what the submission's "live project
link" points at, and what a judge clicks. It reaches LeekWallet, if the user
has one, through **WalletConnect**, exactly as any other dapp does — no special
casing.

**B. The in-wallet mini-app** (`app/packages/apps/leekdefi/` in this repo).
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
| T-MEZO-3 | **The gas symbol on the device.** Replace the hardcoded `"ETH"` in `src/ui.c` with the chain's own ticker, so Mezo draws BTC. Firmware chain table, host vectors, a `sim/test_ui.c` case on 31611 | **done**. An unlisted chain gets no ticker at all rather than the usual answer; the companion summary was wrong the same way and is fixed with it |
| T-MEZO-4 | Air-gapped MUSD payment on Mezo testnet, end to end, filmed | **next**, and needs test MUSD |
| T-MEZO-5 | `app/packages/apps/leekdefi/`: balances, MUSD send through `screenProposal`, the ETF surface | unblocked: the contracts are live |
| T-MEZO-9 | Submission: deck, 2-minute video, AKINDO answers, README section | last two days |

### Platform, in `leek-stocks`

| ID | Task | Depends on |
|---|---|---|
| S-1 | Repo, Foundry, Apache-2.0, README that states the trust model plainly (CI still owed) | **done** |
| S-2 | `IndexOracle` implementing `AggregatorV3Interface`: push-only, role-restricted, `maxStaleness`, immutable `maxDeviationBps`, pausable, monotonic rounds | **done**, 15 tests, fuzz 1000 |
| S-3 | The feed service: a derived index from an openly licensed source, a heartbeat, a read-only endpoint that names its chain, a hardened systemd unit | **done**, 19 tests; running locally against the live oracles |
| S-4 | `ETFShare` and `ETFFactory` with **exactly** `deployETF(string,string)`, everything else frozen in registry state so the call stays drawable on 128x64 | **done** |
| S-5 | **done.** `IssuanceVault`: `buy(uint256 musdAmount, uint256 minShares)`, `redeem(uint256 shares, uint256 minMusd)`, priced from the oracle, **settled in real testnet MUSD on Mezo**, fee in basis points, refuses a stale or paused feed | S-4 |
| S-6 | Deploy to Mezo testnet with Gologgle and Amezon, addresses recorded | **done**, 17 Oct. `leek-stocks/ADDRESSES.md` |
| S-7 | `web/`: the public dapp — connect, prices, buy, redeem, WalletConnect lazily loaded | **built**; hosting and the Mezo addresses are owed |
| S-8 | Moved to `leek-lend` and renamed `leek*`: mock plus a second deployment on **Sepolia**, to show multichain. The deploy script refuses mainnet chain IDs | S-6 |

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

1. **T-MEZO-4**, the air-gapped MUSD payment, now that the device names BTC.
2. **S-1 and S-2** in the new repo: scaffold, then the oracle.
3. **Get test MUSD** on Mezo testnet, because every settlement path needs it.
