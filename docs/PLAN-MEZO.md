# Mezo: plan and roadmap

LeekWallet's entry for the **Mezo Buildathon** (AKINDO, two waves). This is the
planning document: what is verified, what it costs, what ships in which wave,
and what must not be guessed at.

The hackathon surface lives in its own package, `app/packages/apps/mezo/`, under
the five rules in [MINI-APPS.md](MINI-APPS.md), so the event's code can be
deleted in one commit when it ends. Firmware changes are the exception and are
marked as such: a call the device *draws* has to be decoded by the device, and
that is wallet code, not event code.

## 1. The event, in the terms it will judge us by

| | |
|---|---|
| Hard requirement | the project integrates **MUSD and/or MEZO** |
| Chains allowed | Mezo, Ethereum, Base, BNB Chain; **Mezo testnet accepted** |
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
interfaces that simplify MUSD/MEZO access". A Track 1 DeFi entry is a separate
repository and is out of scope here.

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
per-chain `nativeCurrency.symbol`, so the companion needs only a row. The
firmware does not: it prints the literal string `"ETH"` when it draws an amount
(`src/ui.c:5580` and `src/ui.c:6265`). On Mezo that is wrong on the one screen
this project refuses to be wrong on. See T-MEZO-3.

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

### 3.3 Borrowing MUSD, and why it is cheap for us

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

The architecture, in Mezo's words: a position is opened by
`BorrowerOperations.openTrove` with BTC attached; the BTC sits in `ActivePool`
until withdrawn, repaid, redeemed against (`TroveManager.redeemCollateral`) or
liquidated (`TroveManager.liquidate`).

## 4. The work, as tasks

Each task names where it lands and what proves it. "Event" means it leaves with
the mini-app; "wallet" means it stays.

| ID | Task | Lands in | Proof | Tier |
|---|---|---|---|---|
| T-MEZO-1 | Mezo testnet and mainnet in the chain table, BTC gas, 18 decimals, the verified RPCs and explorers, CSP entries for the new hosts | wallet, `core/chains.ts` + `tauri.conf.json` | balances load on both; `eth_chainId` asserted in the app suite | small |
| T-MEZO-2 | MUSD in `TOKEN_HINTS` for 31611/31612, and `MUSD` added to the tracked symbols with its deployment map | wallet, `core/chains.ts`, `core/all-chain-balances.ts` | an MUSD balance shows; a send is drawn by the device from its own decoder | small |
| T-MEZO-3 | **The gas symbol on the device.** Replace the hardcoded `"ETH"` with the chain's own ticker, so Mezo draws BTC | wallet, `src/ui.c` (+ firmware chain table) | `sim/test_ui.c` renders a 31611 transaction and asserts "BTC"; a host/firmware vector pins it | medium |
| T-MEZO-4 | Air-gapped MUSD payment end to end: phone builds the request, camera board reads it, device draws it, QR signature back, phone broadcasts | wallet (exists) + event demo | a testnet transaction hash, filmed | integration |
| T-MEZO-5 | `app/packages/apps/mezo/`: a read-only Mezo surface — BTC and MUSD balances, trove health if an address has one, and an MUSD send that goes through `screenProposal` | event, own package + own CSS | `app/test` isolation rules; one line in `MINI_APPS` | medium |
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
2. **A small contract that earns its place**, inside `app/packages/apps/mezo/contracts/`,
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

- **MUSD on Ethereum and Base.** Mezo's docs list the same address on both.
  Read `symbol()` and `decimals()` on each chain before adding either row.
- **The MEZO token address.** Mezo's public contracts reference has the heading
  and no address under it. If MEZO is to be supported, get the address from the
  explorer or Discord, verified by RPC. MUSD alone satisfies the requirement.
- **The borrow contract addresses on testnet.** Not in the public docs. The
  `SCALE_TEST_ADDRESSES.md` file in `mezo-org/musd` lists a full set, but its
  MUSD (`0xf9BBcC…`) is **not** the documented testnet MUSD, so that file is a
  different deployment and must not be used as the testnet address book. Two
  ways to close it: read `BorrowerOperationsAddressAdded` from the MUSD contract
  on testnet (the public RPC caps `eth_getLogs` at 10,000 blocks, so this needs
  chunking around its deployment), or take the addresses from the testnet dApp
  and confirm each with `mintList`/`burnList` on MUSD.
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
