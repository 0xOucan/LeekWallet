# ATS — Hedera Asset Tokenization Studio, from a hardware wallet

A LeekWallet mini-app that issues, administers and trades **ERC-3643 / ERC-1400
securities** built with the **Hedera Asset Tokenization Studio**, on **Hedera
testnet (chain 296)**, with every privileged act rendered on an ESP32 screen and
approved there.

Sponsor: **Hedera — Tokenization of Anything (Continuity Track)**.


**[Architecture diagram →](../../../../docs/ARCHITECTURE.md)** — how a transaction reaches the device,
and which part of the system is trusted.

---

## Continuity Track: what existed before, and what is new

**The boundary is one commit.** Everything Hedera in this project was written
after `2cbcf62` (*"Correct the stale Pixie status in the docs"*, 2026-09-03).
Before it, this repository was a hardware wallet with no Hedera code of any
kind — no ATS, no HTS, no HBAR, no chain 296.

```bash
# What existed before the event
git log --oneline --until=2026-09-05 | wc -l      # 344 commits
git show 2cbcf62                                  # the last of them

# What was built during it
git log --oneline --since=2026-09-06 | wc -l      # 140+ and still growing
git diff --shortstat 2cbcf62 HEAD                 # 222 files, ~50k lines
git diff --shortstat 2cbcf62 HEAD -- app/packages/apps/ats docs/ATS.md
                                                  # 64 files, ~17k lines — Hedera alone
git log --diff-filter=A --format='%ad %h' --date=short -- app/packages/apps/ats | tail -1
                                                  # 2026-09-06 46c339c — the first line of it
```

The counts above are approximate on purpose: they move every time a commit
lands, and a figure that disagrees with the command printed beside it reads as
dishonest rather than stale. Run the commands. What does not move is the
boundary — `2cbcf62` — and the fact that nothing Hedera exists before it.

The history is continuous from **2026-08-12**, months before this event, with
no single-commit drop at the end.

### What existed before (the wallet)

ESP32-S3 and Firefly Pixie (ESP32-C3) firmware; BIP39/32/44 with AES-256-CBC
storage; BLE and USB transports; the JSON-RPC protocol and its permission
tiers; the encrypted session and passkey handshake; EIP-191 and EIP-712
signing; the ERC-7730 descriptor engine; the on-device calldata decoder for
ERC-20 and a small set of known calls; the host test harness; and the Tauri
companion shell.

**None of it knew what Hedera was.**

### What is new, and why it is not polish

| new | what it required |
|---|---|
| **ATS issuer console** | reading a resolver-proxy diamond's register — holders, roles, KYC, control list, snapshots — through `aggregate3`, with every field its own three-state outcome |
| **Privileged actions** | mint, freeze, pause, lock, cap, control list, KYC, snapshot, dividend — each a single step with its own device screen |
| **`AtsEscrowMarket.sol`** | a secondary market for ATS assets, *which the Studio does not have*. New contract, audited, verified |
| **`LeekSecurityFactory.sol`** | new contract. Makes ATS issuance signable on a 240×240 screen by collapsing 3,748 bytes of calldata to 196 |
| **Firmware decoder for issuance** | `ats_decode_two_strings()` in `src/eth-decode.c`, its mirror in core, three device pages, and shared conformance vectors — **a change to what the device itself can read**, not to an app |
| **Firmware decoder for the market** | `fill`, `cancel` and `list` added to the device's decodable table |
| **HBAR unit handling** | tinybar vs weibar, established by four failed transactions and encoded so the mistake cannot recur |

The two contracts and the two firmware decoders are the answer to *"polish and
bug fixes alone will not qualify"*: the device's own trusted decoder was
extended, which is an architectural change to the thing that makes this a
hardware wallet rather than an app.

### Newly integrated Hedera services

The Hedera Smart Contract Service (chain 296 over the JSON-RPC relay), the
Asset Tokenization Studio contracts, and the mirror node — used for contract
verification metadata and for reading the action trace that diagnosed the
long-zero address finding (see `contracts/AUDIT-LEEKSECURITYFACTORY.md`).

### Roadmap after the hackathon

1. **Scheduled Transactions** for coupon payments and maturity settlement —
   `LEEKB` and the bonds issued from the device already carry a maturity date
   that nothing acts on yet.
2. **Raise `ETH_MAX_DATA` properly** — heap-allocate the RLP buffers so the
   device can hold a larger call, which is the precondition for decoding
   anything wider than two strings.
3. **Upstream to ATS** — the `mint` return-type hazard, the
   `deployEquity`/`deployBond` selector confusion and the long-zero
   contract-to-contract finding are all reportable as they stand.
4. **Independent audit** before any of this touches mainnet. `AUDIT.md` is our
   own list against ourselves and it is not short.

---

## How the sponsor's requirements are met

| requirement | where |
|---|---|
| Use ATS (SDK, **contracts**, web app, or a combination) | ATS contracts directly, via the real factory. [`@hashgraph/asset-tokenization-contracts@8.0.0`](https://www.npmjs.com/package/@hashgraph/asset-tokenization-contracts) is the source of truth for ABIs, role hashes and selectors — asserted by [`test/abi.test.ts`](test/abi.test.ts) |
| Deploy and demonstrate on Hedera testnet | four securities + a market + an issuance factory, all live on 296 |
| Contracts verified on HashScan | **all six**, below |
| Lifecycle operation | mint, transfer, snapshot, distribution, freeze, and a settled secondary trade |

### Extra points claimed

- **A secondary market for ATS-issued assets, which the Studio does not have today** — [`contracts/src/AtsEscrowMarket.sol`](contracts/src/AtsEscrowMarket.sol)
- **Compliance controls in use** — KYC grants, freezes, transfer restrictions, pauses, in [`src/act.ts`](src/act.ts)
- **Dividend distributions** — snapshot-reconciled, [`src/dividend.ts`](src/dividend.ts)
- **Issuance from a hardware wallet** — not on their list, because it did not exist

## Deployed and verified (chain 296)

| contract | address | verification |
|---|---|---|
| **LeekSecurityFactory** | [`0x3a56974075d734aFa5BF7f63e34F9C3237408AeD`](https://hashscan.io/testnet/contract/0x3a56974075d734aFa5BF7f63e34F9C3237408AeD) | sourcify **exact_match** |
| AtsEscrowMarket | [`0xcde9596fd89c5368b5bd46c2b93544cbb201f8df`](https://hashscan.io/testnet/contract/0xcde9596fd89c5368b5bd46c2b93544cbb201f8df) | match |
| LEEKA (equity) | [`0x188fd9e330d22edd3381b21715d0a1722206b43f`](https://hashscan.io/testnet/contract/0x188fd9e330d22edd3381b21715d0a1722206b43f) | match |
| VGF1 (equity) | [`0xaab4b09e4691ec2284399a6a27466a498051bb23`](https://hashscan.io/testnet/contract/0xaab4b09e4691ec2284399a6a27466a498051bb23) | match |
| HRBR (equity) | [`0x653bfb114985583e30a80b62a81f5bad1d4852eb`](https://hashscan.io/testnet/contract/0x653bfb114985583e30a80b62a81f5bad1d4852eb) | match |
| LEEKB (bond) | [`0x512988f3e1a2fc5da6fa65daffd35bb7437a3c84`](https://hashscan.io/testnet/contract/0x512988f3e1a2fc5da6fa65daffd35bb7437a3c84) | match |

The four securities are stock ATS `ResolverProxy` instances, **byte-for-byte
identical** to the published package including the metadata hash; they were
verified by recovering the compiler settings from the bytecode's own CBOR
(solc 0.8.28) and cross-checking ATS's `hardhat.config.ts` (optimizer on, runs
100, evmVersion cancun).

## The interesting part: issuing a security from a 240×240 screen

`IAtsFactory.deployEquity` takes a seventeen-field nested struct and **3,748
bytes** of calldata. The device holds `ETH_MAX_DATA` (768) and refuses more —
deliberately, because it cannot hash or display bytes it never held. Raising
that limit would not help: a screen that says *"deploy equity, approve?"* over
3.7 KB nobody can read is blind signing with better manners.

[`contracts/src/LeekSecurityFactory.sol`](contracts/src/LeekSecurityFactory.sol) moves the template **on chain**, into
verified code, so the call becomes:

```solidity
deployEquity(string name, string symbol)   // 196 bytes
deployBond(string name, string symbol)     // 196 bytes
```

All twelve roles go to `msg.sender` — the device — and the wrapper holds none
and has no owner. The screen then shows **all** of the decision, because name
and symbol are the only things that vary.

The firmware decodes it and draws three pages: what it creates and that the
signer becomes issuer with every role, then the name in full, then the symbol
in full. Both strings must be printable ASCII within the factory's own bounds,
enforced identically on device and host — a control byte, a right-to-left
override or an invisible leading space refuses the whole call rather than being
cleaned, because a name that does not read on screen the way it reads in the
calldata defeats the point.

| part | file |
|---|---|
| Firmware decoder | [`src/eth-decode.c`](../../../../src/eth-decode.c) — `ats_decode_two_strings()` |
| Device pages | [`src/ui.c`](../../../../src/ui.c) — `SIGN_PAGE_ATS_ACTION/_NAME/_SYMBOL` |
| Host mirror | [`packages/core/src/eth-decode.ts`](../../core/src/eth-decode.ts) — `decodeTwoStrings()` |
| Shared vectors | [`packages/core/test/eth-decode-vectors.json`](../../core/test/eth-decode-vectors.json) — 11 ATS vectors, 4 accepted (compared on the decoded strings), 7 refused |

## Where the secondary market is

The market panel is **not** a standalone screen — it is drawn at the bottom of a
security's register, and only after that register has been read.

```
Issue → Discover → Holdings        (always visible)
      ↓  pick a security, "Read register"
Register → Roles → Snapshots → Privileged actions → Distribution → **Secondary market**
```

That ordering is deliberate, and stated in [`src/index.ts`](src/index.ts): what a
lot of shares is worth is a decision made against the register above it, and a
sell form placed above the holder list is a form filled in without reading one.

So if the market is not on screen: **load a security first.** The Holdings panel
lists what this wallet holds, and each row has a button that loads that security
into the console — which is the shortest route to a sell form in front of a
register that was actually read.

The market never renders for the **fixture**, either: there is no escrow market
behind a constructed example, and a market panel drawing fixture prices would be
the one screen where the fixture notice stopped being enough.

## Key files

| | |
|---|---|
| [`src/register.ts`](src/register.ts) | the register read from chain: holders, roles, KYC, control list |
| [`src/act.ts`](src/act.ts) | every privileged action, each a single step with its own device screen |
| [`src/issue.ts`](src/issue.ts) | deploy calldata, decoded back out of the bytes rather than echoed |
| [`src/discover.ts`](src/discover.ts) | what this wallet has issued, from the indexed `caller` topic |
| [`src/holdings.ts`](src/holdings.ts) | balance, decimals, `hasRole(ISSUER)`, supply — each its own outcome |
| [`src/market.ts`](src/market.ts) | the escrow market, in tinybar and weibar |
| [`src/dividend.ts`](src/dividend.ts) | distributions reconciled against a snapshot, never live balances |
| [`docs/ATS.md`](../../../../docs/ATS.md) | deployment records and every decision behind them |
| [`contracts/AUDIT-REPORT.md`](contracts/AUDIT-REPORT.md) | audit of the escrow market |
| [`contracts/AUDIT-LEEKSECURITYFACTORY.md`](contracts/AUDIT-LEEKSECURITYFACTORY.md) | audit of the issuance factory; C-1 found and fixed |

## A note on HBAR units

A price is in **tinybar** (1 HBAR = 1e8) because that is what the contract
compares against `msg.value`. The transaction that pays it carries a `value`
field **1e10 times larger, in weibar**, because Hedera's relay divides the
signed value before the contract sees it. Both figures are shown wherever a
price is, and the second is computed from the first rather than taken from a
field. Establishing this cost four failed transactions.

## Run the tests

```bash
pnpm --dir app/packages/apps/ats test     # 12 suites
cd app/packages/apps/ats/contracts && forge test
```
