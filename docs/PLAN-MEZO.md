# Mezo: plan and roadmap

LeekWallet's entry for the **Mezo Buildathon** (AKINDO, two waves). This is the
planning document: what is verified, what it costs, what ships in which wave,
and what must not be guessed at.

The hackathon surface lives in its own package, `app/packages/apps/leekdefi/`, under
the five rules in [MINI-APPS.md](MINI-APPS.md), so the event's code can be
deleted in one commit when it ends. Firmware changes are the exception and are
marked as such: a call the device *draws* has to be decoded by the device, and
that is wallet code, not event code.

**Status, 17 Oct 2026.** The chain rows, the token rows and the per-chain gas
ticker are merged (T-MEZO-1, 2, 3): a Mezo transaction is drawn in **BTC** on
the device and in the companion, and an unlisted chain is drawn with no ticker
rather than a guess. The LeekStonks contracts are **live on Mezo testnet**,
settling in the MUSD Mezo's own borrow system mints, so MUSD borrowed against
BTC can be spent on them — addresses in `leek-stocks/ADDRESSES.md`.

**Status, 19 Oct 2026.** The mini-app (T-MEZO-5) ships as
`app/packages/apps/leekdefi/`, and it is not the read-only surface this document
planned: it buys, redeems, stakes, unstakes and borrows, all through
`screenProposal`. The borrow-call decoders (T-MEZO-6) were pulled forward from
Wave 2 and are **on a board** — eight generic rows in `src/eth-decode.c`, their
host mirror, and 71 shared vectors. The dapp, the feed and the two index vaults
are deployed and answering; both pools are listed; both vaults are above 100%
coverage.

Owed: the air-gapped demo on hardware (T-MEZO-4) and the submission materials.
**No buy or redeem has yet been signed on the device** — that walk is the one
thing the whole entry rests on and it is still untested on hardware. The full
picture is in [PLAN-MEZO-ROADMAP.md](PLAN-MEZO-ROADMAP.md).

## 1. The event, in the terms it will judge us by

| | |
|---|---|
| Hard requirement | the project integrates **MUSD and/or MEZO** |
| Chains allowed | Mezo Mainnet, Ethereum, Base, **BSC, Robinhood** (per the Terms of Participation, which differ from the overview page's "BNB Chain"); **Mezo testnet accepted** |
| Wave 1 | build 16–26 Oct 2026, judged 27 Oct – 1 Nov, $2,000 MEZO |
| Wave 2 | build 2–15 Nov, judged 16–22 Nov, $5,000 MEZO |
| Announcement | 23 Nov 2026, online demo |
| Submit | live link, public repo, deck, 2-minute video, AKINDO form |

Scoring, and where we stand:

| Criterion | Weight | Where our work goes |
|---|---|---|
| Mezo integration | 30% | §3: BTC-as-gas on the trusted display, MUSD drawn on-device, borrow calls decoded |
| Product & viability | 30% | §2: the argument |
| Technical implementation | 20% | existing: 31 host suites, shared C/TS vectors, device-side decoding |
| User experience | 10% | companion plus device screens; air-gapped flow |
| Materials | 10% | §7 |

**Track 2, Access and Distribution**, which names "cross-platform wallets and
interfaces that simplify MUSD/MEZO access". The form takes track selection as
multiple choice, and a **Track 1 DeFi entry is planned as a separate
repository**: an MUSD-settled ETF market, planned in
[PLAN-MEZO-TRACK1.md](PLAN-MEZO-TRACK1.md). The two submissions reference each
other and each stands alone.

Two of their stated priorities fit us exactly and should be said plainly in the
submission rather than implied: *existing products adding MUSD/MEZO integration
are prioritised*, and *extend, don't detour*. LeekWallet is a working wallet
adding Mezo support, not a new app built to win a prize.

## 2. The product argument

MUSD is a dollar backed by Bitcoin, and the reason to hold one is to not sell
the other. That makes **where the key lives** the whole question, and it is the
question LeekWallet answers: an $8–15 device that decodes the transaction
itself, draws it on a screen the host cannot write to, and refuses what it
cannot explain.

The air-gapped camera build sharpens it. An MUSD payment can be signed with **no
cable, no Bluetooth, no Wi-Fi and no pairing**: the device reads the request off
a phone screen with its camera and answers with a QR code, over EIP-4527, the
protocol other hardware wallets already speak. For a Bitcoin-collateralised
stablecoin whose users are, by selection, people who care where their keys are,
that is the feature.

## 3. Verified ground truth

Everything in this section was checked on **14 Oct 2026**, by RPC call or from
Mezo's own repositories. Nothing here is from memory, and anything not verified
is in §6 instead.

### 3.1 Networks

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | **31611** (`eth_chainId` → `0x7b7b`, checked live) | **31612** (`0x7b7c`, checked live) |
| Gas token | **BTC**, 18 decimals | **BTC**, 18 decimals |
| RPC | `https://rpc.test.mezo.org` | no default published; providers below |
| Explorer | `https://explorer.test.mezo.org` | `https://explorer.mezo.org` |

Mainnet RPC providers, from Mezo's developer docs: Boar
`https://mezo-mainnet.boar.network`, Imperator `https://rpc_evm-mezo.imperator.co`,
Validation Cloud `https://mainnet.mezo.public.validationcloud.io`, dRPC
`https://mezo.drpc.org` (this one answered `eth_chainId` here).

**BTC as gas is the interesting part.** Our chain table already carries a
per-chain `nativeCurrency.symbol`, so the companion needed only a row. The
firmware printed the literal string `"ETH"` when it drew an amount, which on
Mezo was wrong on the one screen this project refuses to be wrong on. Fixed in
T-MEZO-3: `eth_gas_symbol()` in `src/eth-tx.c` reads a chain table that carries
the name and the ticker in one row, and returns NULL — no ticker drawn — for a
chain it does not carry. BNB Chain and Polygon were misnamed the same way and
are fixed by the same table.

### 3.2 MUSD

| Network | Address | Checked |
|---|---|---|
| Mezo mainnet | `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` | `symbol()` → `MUSD`, `decimals()` → 18, live over dRPC |
| Mezo testnet | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | `symbol()` → `MUSD`, `decimals()` → 18, live over `rpc.test.mezo.org` |

Both match Mezo's own contracts reference
(`mezo-org/documentation`, `users/resources/contracts-reference.md`), which also
lists the same address on **Ethereum** and **Base** via a Wormhole NTT bridge.
Those two are listed, not yet verified here, and must be read off each chain
before they land in code (§6).

MUSD is a plain ERC-20 with `transfer`, `transferFrom` and a `permit` nonce, so
**the device already decodes an MUSD payment today**: `ETH_CALL_ERC20_TRANSFER`
and `ETH_CALL_ERC20_APPROVE` are in the decodable set and are drawn field by
field with no descriptor from the host. This is a demonstration, not a task.

### 3.3 Where each asset lives, and what bridges it

Checked live on each chain's own RPC, 14 Oct 2026, by calling `symbol()`:

| Asset | Mezo | Ethereum | Base | BNB Chain | Solana |
|---|---|---|---|---|---|
| **MUSD** | `0xdD468A…F9F186` ✓ | same address ✓ | same address ✓ | **absent** — that address holds no contract on BNB | — |
| **MEZO** | `0x7B7c000000000000000000000000000000000001` ✓ | `0x8e4cbBcc…6d4848b` ✓ | same address ✓ | same address ✓ | `8niMFW4yuv3vLoqTtBaC6rchyasmUhgvpgSyPEeeCrw6` (listed, not checked) |
| **aMUSD** | — | `0x52317a47…aAE96aBc` ✓ (Morpho vault receipt) | — | — | — |

Consequence for chain choice: **BNB Chain can only mean MEZO**, not MUSD. Mezo
testnet is our primary target, with Ethereum and Base available for MUSD if a
second chain is wanted.

### 3.4 Bridges

Mezo's own bridging is **Wormhole NTT** (Native Token Transfer), burn-and-mint,
driven from the Portal UI at `portalbridge.com` or the Mezo dApp. Addresses from
Mezo's contracts reference:

| | NTT Manager | Wormhole Transceiver |
|---|---|---|
| MUSD on Mezo | `0x7efb386675d75280D39Aae42964A6776DE0ee0bD` | `0x56E27f1A8425515FFD4BD76A254Ac1a5c0B66D71` |
| MEZO on Mezo | `0x5E668D912F69db0762CD0fE00647dA9fa6b29591` | `0x528edf2dBbC6Ae6978c88E54B260AB86B682D18c` |
| MEZO on Ethereum | `0x13916D0daB357DCBAa1600b594d62C641840686A` | `0x920871aF2D4106E76d204fEA7122fA129C9283b1` |
| MEZO on Base | `0x0c46f496C410465975a427e34a976fc15a2edE4f` | `0x27321f84704a599aB740281E285cc4463d89A3D5` |
| MEZO on BSC | `0x09959798B95d00a3183d20FaC298E4594E599eab` | `0xa10aD2570ea7b93d19fDae6Bd7189fF4929Bc747` |

Two other paths exist and are not the same thing:

- **Mezo Portal**, the deposit contract on Ethereum (`0xAB13B8ee…fD5B8A39` proxy,
  with a tBTC BitcoinDepositor), which is how BTC and the bridged `m*` tokens
  (mUSDC, mUSDT, mDAI, mUSDe, the wrapped BTC variants) reach Mezo.
- **tBTC**, which is how Bitcoin itself becomes collateral.

No evidence was found that **Stargate or LayerZero** support Mezo or MUSD;
searching turned up only the 2025 Stargate acquisition story. Treat Wormhole NTT
as the only bridge for these two assets until Mezo says otherwise.

**For this wallet, none of this is code.** A bridge transfer is an ERC-20
`approve` plus a contract call; the device decodes the approve today and would
refuse the NTT transfer as an unknown call. Decoding NTT is a candidate, not a
plan: it is only worth it if a judge or a user actually bridges from the device.

### 3.5 Borrowing MUSD, and why it is cheap for us

From `mezo-org/musd`, `solidity/contracts/interfaces/IBorrowerOperations.sol`:

```solidity
function openTrove(uint256 _debtAmount, address _upperHint, address _lowerHint) external payable;
function addColl(address _upperHint, address _lowerHint) external payable;
function withdrawColl(uint256 _amount, address _upperHint, address _lowerHint) external;
function withdrawMUSD(uint256 _amount, address _upperHint, address _lowerHint) external;
function repayMUSD(uint256 _amount, address _upperHint, address _lowerHint) external;
function closeTrove() external;
function refinance(address _upperHint, address _lowerHint) external;
function adjustTrove(uint256 _collWithdrawal, uint256 _debtChange, bool _isDebtIncrease,
                     address _upperHint, address _lowerHint) external payable;
```

Every parameter is `uint256`, `address` or `bool`. By rule 3 of MINI-APPS.md
that is the **cheapest tier**: one row each in the firmware's signature table
plus shared vectors, not a hand-written decoder. The hint arguments are
sorted-list positions and carry no meaning a user must check; the decision is
the amount, the direction, and whether BTC is attached.

That makes "borrow MUSD against BTC, confirmed on separate hardware, with the
device naming the amount itself" a realistic Wave 2 deliverable rather than an
aspiration.

**Borrowing exists only on Mezo.** The trove system is deployed on the Mezo
chain; MUSD on Ethereum and Base is the bridged NTT token with no trove system
behind it. So:

- **For the wallet, this costs no Solidity at all.** We decode calls, we do not
  deploy markets. Borrowing is reached by signing `BorrowerOperations` calls on
  Mezo, which is a firmware table row per function.
- **Borrowing MUSD on another chain** would mean either a market that already
  lists it — Mezo's docs name a Morpho MUSD vault on Ethereum, whose receipt
  token `aMUSD` is verified above, and that is *supplying*, not borrowing
  against BTC — or a lending market of your own. That is the separate Track 1
  repository, not this one. Verify any Morpho market's parameters before
  claiming a borrow path exists there.

The architecture, in Mezo's words: a position is opened by
`BorrowerOperations.openTrove` with BTC attached; the BTC sits in `ActivePool`
until withdrawn, repaid, redeemed against (`TroveManager.redeemCollateral`) or
liquidated (`TroveManager.liquidate`).

### 3.6 The other testnets, and a market of our own

Checked with `eth_getCode` on each testnet's own RPC, 14 Oct 2026:

| | Sepolia | Base Sepolia | BSC testnet |
|---|---|---|---|
| MUSD (`0xdD468A…`) | **no contract** | **no contract** | **no contract** |
| MEZO (`0x8e4cbB…`) | present, `symbol()` → `MEZO` | present (same bytecode size) | **no contract** |
| MezoBridge (`0x3a3BaE…`) | present | — | — |

So **MUSD exists on no testnet except Mezo's own.** Any MUSD-shaped demo on
Sepolia or Base Sepolia has to be a token we deploy ourselves. Our chain table
already carries Sepolia (11155111), Base Sepolia (84532) and BNB testnet (97),
so those cost no companion work.

That makes the idea workable: **deploy a Mezo-like lending market, with our own
mock collateral and stablecoin, on testnets.** Three facts decide how:

1. **The deploy path exists.** `mezo-org/musd` ships numbered Hardhat deploy
   scripts for the whole system, including `07_deploy_mock_aggregator.ts` — a
   mock price oracle. A full trove deployment on any EVM testnet is
   configuration, not new contracts.
2. **The licence is GPL-3.0**, and LeekWallet is Apache-2.0. A published fork
   of their contracts is a derivative work and must be GPL-3.0, so it **cannot
   live in this repository**. It belongs in the separate Track 1 repo, licensed
   GPL-3.0, with the lineage credited. This is also what the Buildathon rules
   require: reused code must be open source and cited.
3. **The wallet needs no new work to support it.** A fork keeps the function
   signatures, so the firmware table rows added for Mezo's `BorrowerOperations`
   decode our own deployment unchanged. One decoder, two chains, and a borrow
   demo that does not depend on obtaining testnet MUSD on Mezo.

The honest framing for a submission: Mezo's market is the real one, ours is a
testbed that proves the wallet's decoding against the same ABI. Do not present
a redeployment as an original protocol.

## 4. The work, as tasks

Each task names where it lands and what proves it. "Event" means it leaves with
the mini-app; "wallet" means it stays.

| ID | Task | Lands in | Proof | Tier |
|---|---|---|---|---|
| T-MEZO-1 | Mezo testnet and mainnet in the chain table, BTC gas, 18 decimals, the verified RPCs and explorers, CSP entries for the new hosts | wallet, `core/chains.ts` + `tauri.conf.json` | balances load on both; `eth_chainId` asserted in the app suite | small |
| T-MEZO-2 | MUSD in `TOKEN_HINTS` for 31611/31612, and `MUSD` added to the tracked symbols with its deployment map | wallet, `core/chains.ts`, `core/all-chain-balances.ts` | an MUSD balance shows; a send is drawn by the device from its own decoder | small |
| T-MEZO-3 | **The gas symbol on the device.** Replace the hardcoded `"ETH"` with the chain's own ticker, so Mezo draws BTC | wallet, `src/ui.c` (+ firmware chain table) | **done**: `sim/test_ui.c` renders a 31611 transaction and asserts BTC with ETH on no page, plus an unlisted chain id; `sim/test_eth_tx.c` and the core suite pin the tables | medium |
| T-MEZO-4 | Air-gapped MUSD payment end to end: phone builds the request, camera board reads it, device draws it, QR signature back, phone broadcasts | wallet (exists) + event demo | a testnet transaction hash, filmed | integration |
| T-MEZO-5 | `app/packages/apps/leekdefi/`: a read-only Mezo surface — BTC and MUSD balances, trove health if an address has one, and an MUSD send that goes through `screenProposal` | event, own package + own CSS | `app/test` isolation rules; one line in `MINI_APPS` | medium |
| T-MEZO-6 | Borrow calls in the device's decodable set: `openTrove`, `withdrawMUSD`, `repayMUSD`, `addColl`, `withdrawColl`, `closeTrove` | wallet, `src/eth-decode.c` table | shared C/TS vectors, refusal cases included | medium |
| T-MEZO-7 | Trove health page in the mini-app, read from `TroveManager` | event | testnet position | small |
| T-MEZO-8 | The deployment requirement (§5) | event, contracts inside the app folder | a verified contract on Mezo testnet | open |
| T-MEZO-9 | Submission materials: deck, 2-minute video, AKINDO form answers, README section | docs | submitted | small |

## 5. The deployment requirement, honestly

Screening checks for "a working deployment on a supported chain". A wallet is
firmware plus a companion; it is not a contract, and pretending otherwise would
be the kind of claim this project does not make. Three options, cheapest first:

1. **Lean on what is already on-chain.** A testnet transaction hash for an
   MUSD payment signed air-gapped *is* a working deployment of the integration,
   and the explorer link is the evidence. Risk: a screener looking for a
   contract address may score it as "demo only".
2. **A small contract that earns its place**, inside `app/packages/apps/leekdefi/contracts/`,
   as Aqua's did. The candidate worth building is a **device attestation
   registry**: a wallet publishes the account xpub fingerprint it pairs with, so
   a second device or a companion can check it later. It is small, it is real,
   and it is ours rather than decoration.
3. **Nothing, and say so.** Submit as "testnet deployment" with the transaction
   hashes and accept the scoring.

Recommendation: **1 for Wave 1**, decide 2 for Wave 2 once the integration is
real. Do not build a contract whose only purpose is to exist.

## 6. What must not be guessed

Open items, each with the method for closing it. None of these may be written
into code from memory or from a mirror site.

- **MEZO testnet address.** The mainnet addresses are verified in §3.3; no
  testnet MEZO address is published in the contracts reference. The faucet hands
  out test MEZO, so the address can be read from a faucet transaction.
- **The borrow contract addresses on testnet.** Not in the public docs. The
  `SCALE_TEST_ADDRESSES.md` file in `mezo-org/musd` lists a full set, but its
  MUSD (`0xf9BBcC…`) is **not** the documented testnet MUSD, so that file is a
  different deployment and must not be used as the testnet address book. Two
  ways to close it: read `BorrowerOperationsAddressAdded` from the MUSD contract
  on testnet (the public RPC caps `eth_getLogs` at 10,000 blocks, so this needs
  chunking around its deployment), or take the addresses from the testnet dApp
  and confirm each with `mintList`/`burnList` on MUSD.
- **Whether a Morpho MUSD market allows borrowing**, as opposed to supplying.
  Read the market parameters before claiming either.
- **How to obtain test MUSD.** Documented as "borrow against test BTC, or swap
  BTC → MUSD in the testnet dApp". The faucet gives BTC and MEZO, not MUSD.
  Needed before T-MEZO-4 can be filmed.
- **Whether the Mezo explorer has a usable API.** `explorer.test.mezo.org`
  returned 404 for the Blockscout v1 and v2 paths tried here, so the history
  view in the mini-app should not assume one.

## 7. Wave split

**Wave 1 (16–26 Oct) — the integration, shipped and filmed.**
T-MEZO-1, 2, 3, 4, 5, 9. The claim: LeekWallet supports Mezo, draws BTC gas and
MUSD amounts from its own decoder, and signs an MUSD payment with no electrical
connection to the host. Evidence: a testnet transaction hash and a two-minute
film of the air gap.

**Wave 2 (2–15 Nov) — depth.**
T-MEZO-6, 7, and a decision on T-MEZO-8. The claim: borrowing MUSD against BTC
confirmed on hardware that names the amount itself, with the parser held to
shared vectors on both sides. Wave 2 resubmissions must state what changed, so
keep a changelog as the work happens.

## 8. Rules we keep while doing this

- A mini-app cannot reach a key, a transport or the device; it builds calldata
  and hands it to `screenProposal` (MINI-APPS.md rule 1).
- A host-side descriptor cannot make a call signable. Supporting a Mezo call
  means extending the **firmware** (rule 2).
- What cannot be drawn is not signed. If a borrow call cannot be rendered in
  full on 128x64, it is refused, not summarised (rule 4).
- No hardcoded values: addresses, chain IDs and decimals go in the existing
  tables, verified, with the check recorded.
- Commit style unchanged; the mini-app's Solidity, if any, lives in its folder.
