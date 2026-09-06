# ETHGlobal plan — three sponsor apps on the LeekWallet ecosystem

Written 2026-09-05. Research-backed: every SDK, address and chain ID below was
read from the sponsor's own documentation, not recalled.

## 1. Which three, and why the fourth is out

| Sponsor | Track we enter | Pool |
|---|---|---|
| **1inch** | Build an Aqua App (+ Continuity variant) | $5,000 / $2,000 |
| **Circle / Arc** | Launch on Arc Testnet & Push to Mainnet (+ Continuity), Best DeFi | $3,500 / $1,500 / $1,667 |
| **Hedera** | Tokenization of Anything | $6,000, up to 3 × $2,000 |

**Ledger is deliberately dropped**, and not only because it sells the competing
product. Its two tracks require building *on the Ledger Agent Stack* with Ledger
as the trust layer — for a hardware wallet project that means shipping a
competitor's device as our security boundary, which is incoherent. Both tracks
are also agent-centric, which we are not.

Note on Hedera: the **Tokenization of Anything** pool is the largest single one
available to us and is **not** Continuity-gated, so no prior Hedera work is
needed. Hedera's own Continuity track *does* require a pre-existing Hedera
project and we do not qualify for it. The AI & Agentic pool is excluded by our
own rule.

## 2. The thesis that makes this one project, not three bolt-ons

LeekWallet exists to answer one question: **what am I actually authorising?**
The keys never leave the device, and the device renders the transaction on a
screen the host cannot forge.

Each sponsor supplies a domain where blind signing is unusually dangerous:

| | What gets signed | Why blind signing is worst here |
|---|---|---|
| 1inch | A **bytecode program** (SwapVM) | One signature authorises a whole strategy nobody can read |
| Hedera | A **compliance action** on a security | Freeze, force-transfer and mint are irreversible and affect third parties |
| Arc | A **merchant settlement** | Staff must take payments without ever holding the treasury key |

The companion already has an **ERC-7730 clear-signing engine**
(`app/packages/core/src/erc7730.ts`, 702 lines, with bundled descriptors). The
device deliberately renders **raw token units** because `decimals()` is not
callable from firmware — see the comment at `src/ui.c:4834`. So each app ships
as a new *clear-signing domain*: descriptors plus, where the payload is not a
plain call, a decoder.

That is the pitch: **three sponsors, one capability.**

## 3. Architecture: LeekWallet Apps

A small framework in the companion so each app is optional, isolated, and
removable. This is what makes the hackathon work safe to keep or discard.

```
app/packages/apps/
  registry.ts          the menu: id, name, chains, enabled flag
  types.ts             the contract every app implements
  aqua/                1inch
  ats/                 Hedera
  till/                Arc
```

Rules, enforced by the framework rather than by discipline:

1. **An app never touches the vault.** It builds an unsigned transaction or
   typed-data payload and hands it to the existing device pipeline. No app gets
   a key, a seed, or the session.
2. **An app must supply its own clear-signing descriptors.** If the device
   cannot render it, the app may not ask for a signature. This is the rule that
   turns the hackathon into product work.
3. **An app is one directory and one registry row.** Deleting the row removes
   it from the UI; deleting the directory removes it entirely. No app may be
   imported from outside its own folder.
4. **Off by default**, behind a flag, until its own hardware test passes.

Rule 3 is what makes rollback a `git revert` rather than an archaeology
expedition.

## 4. App 1 — Aqua (1inch)

### What Aqua actually is

Read from the contracts, because the marketing description misleads: Aqua is a
**shared liquidity layer where the LP's tokens never leave their wallet**. The
registry (`Aqua.sol`) tracks *virtual* balances keyed
`balances[maker][app][strategyHash][token]`. One approval lets a maker
participate in unlimited strategies; tokens move only at execution, via
`pull()`/`push()`.

**That is the same thesis as a hardware wallet.** An LP who never deposits into
a pool, and whose key lives on a device, is the strongest possible version of
self-custodial market making. This is not a bolt-on; it is the natural client.

- Aqua registry: `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`
- SwapVM router: `0x111111338c5091e8440b67b168bae16a668ac0de`
- SDK: `@1inch/aqua-sdk` — `AquaProtocolContract`, `ship()`, `dock()`,
  `calculateStrategyHash()`
- Networks include **Polygon, Gnosis, Optimism, Unichain, Sonic, BNB**, all of
  which `app/packages/core/src/chains.ts` already knows.

### Two different signing problems, both ours

`ship()` and `dock()` are ordinary transactions whose calldata carries an
**opaque encoded strategy**. SwapVM programs are **EIP-712 signed bytecode**.
The SDK builds calldata; it does not sign. So:

**Deliverable A — an on-device SwapVM decoder.** Programs are
`[opcode][args_len][args]` triples. We decode them and render intent:

```
  SwapVM program                 Aqua strategy
  ─────────────────────          ──────────────────────
  0x17 staticBalances            Provide  1,000 USDC
  0x26 limitSwap1D               Sell at  ≥ 0.9995 / DAI
  0x?? deadline                  Expires  6 Sep 14:00
                                 Partial fills allowed
  [ REJECT ]        [ APPROVE ]
```

Nobody else at this hackathon will render bytecode on a hardware screen. It uses
SwapVM (explicitly scored higher), and it is the single most defensible thing we
can build.

**Deliverable B — a custom opcode.** The rules permit modifying SwapVM opcodes.
`_merchantFloorSwap`: a limit swap that refuses to execute below a floor price
*and* caps total drawdown per epoch — a treasury-shaped instruction for a
business holding revenue in one stablecoin and owing costs in another. It ties
directly to the Arc app.

**Deliverable C — ERC-7730 descriptors** for `ship`/`dock` so the approval and
the withdrawal read in plain language.

Testing: `forge test` against `CoreInvariants`, which already checks seven
invariants (exact-in/out symmetry, additivity, quote/swap consistency, price
monotonicity, rounding favouring makers, balance sufficiency, liveness). We add
ours to that harness rather than inventing one.

## 5. App 2 — Asset Tokenization Studio (Hedera)

### Correcting the premise

ATS is for **securities — equities and bonds**, ERC-1400 with partial ERC-3643,
diamond-pattern upgradeable, plus a mass-payout framework. It is not a
physical-goods tracker. The earlier RWA/sensor idea does not fit it and should
not be forced.

The genuine fit is narrower and better: **the issuer's controller keys are the
highest-value keys in a tokenised security.** Whoever holds the ATS controller
role can freeze an investor, force a transfer, mint, or pause the register.
Those actions are irreversible and affect third parties, and today they are
signed by whatever key the admin's browser holds.

### What we build

**A hardware-secured issuer console.** Every privileged ATS operation is
rendered on the device and requires a physical press:

```
  FREEZE ACCOUNT
  Bond    ACME 2028 6.5%
  Holder  0x7a3f…91c2
  Reason  code 4 (investigation)
  This blocks all transfers.
  [ REJECT ]        [ APPROVE ]
```

Scope, in order:

1. Issue a bond on Hedera testnet with the ATS SDK
   (`@hashgraph/asset-tokenization-sdk`), contracts verified on HashScan.
2. ERC-7730 descriptors for the privileged surface: KYC grant/revoke, freeze,
   transfer restriction, pause, mint, force transfer.
3. One lifecycle operation end to end — a **coupon distribution** — approved on
   the device.
4. If time allows, the extra-points item ATS lacks: a minimal **secondary
   market**, compliance enforced at transfer.

Judging favours "real asset classes and real lifecycle management over a token
with a name on it", so a bond with an actual coupon beats anything broader.

## 6. App 3 — The Till (Arc)

Your food-truck / restaurant idea, built on the one structural fact that makes
Arc right for it.

### Arc facts that shape the design

| | |
|---|---|
| Chain ID | **5042002** |
| RPC | `https://rpc.testnet.arc.io` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| Native gas | **USDC** |
| **Native USDC decimals** | **18, not 6** |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` (6 dec) |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6 dec) |

**USDC is the gas token.** A merchant needs no second asset to operate — that is
the whole reason this is plausible retail infrastructure rather than a demo.

**The 18-vs-6 decimals split is a live hazard for us.** The device renders raw
units. The same nominal dollar is `1e18` natively and `1e6` through the ERC-20
interface; showing the wrong one is a factor of 10¹². This is exactly what
ERC-7730 descriptors are for, and getting it right is a real contribution.

### The design

**The key never touches the shop floor.**

```
  Manager                Staff terminal            Customer
  LeekWallet device      companion, no key         any wallet
  ───────────────        ──────────────────        ──────────
  holds treasury    →    builds payment request →  scans QR
  approves payout   ←    cannot sign anything      pays USDC/EURC
```

1. **Terminal mode** — a companion mode with no key at all. It composes an
   **EIP-681** payment URI (`ethereum:<token>@5042002/transfer?address=…&uint256=…`)
   and renders it as a QR. Any wallet can pay it. A waiter can be handed this
   with no custody risk, which is the point.
2. **Tips** — added to the request as a second leg, attributed to a staff id.
   Settled in batch: the manager approves one on-device transaction paying every
   waiter for the shift. One signature, one screen, a list the manager can read.
3. **Merchant registry** — a small Arc contract mapping `slug → address`, so a
   QR can say `foodtruck-park/taco-stand` instead of a hex blob. **We do not
   need a name service**; ENS is a different chain and inventing one is scope we
   cannot defend. A registry contract is ~40 lines and demoable.
4. **Withdrawal from the till** requires the hardware wallet. Staff take money
   in; only the manager takes money out.

This satisfies "USDC or EURC payment flows on Arc added to a commerce, fintech,
or wallet product" precisely, and LeekWallet is already that wallet product.

## 7. Branches

One branch per app, none touching another. `main` stays releasable throughout.

```
main
├── feat/apps-framework     the registry and the isolation rules  ← lands first
├── feat/app-aqua           1inch
├── feat/app-ats            Hedera
└── feat/app-till           Arc
```

- `feat/apps-framework` merges first; the other three branch from it.
- Each merges to `main` only when its own hardware test passes.
- Every app is **off by default**. Shipping the framework does not ship an app.
- Rollback is `git revert` of one merge commit, because rule 3 forbids
  cross-imports.

## 8. Sequencing, and an honest word about scope

Three sponsor integrations plus firmware work is a lot. In priority order, so
that if we run out of time we lose the least:

| # | Work | Why this order |
|---|---|---|
| 1 | `feat/apps-framework` | everything else depends on it; small |
| 2 | **Till (Arc)** | largest combined pool, closest to a real product, and the decimals work is genuine product value |
| 3 | **Aqua decoder (1inch)** | highest novelty, strongest fit; SwapVM scoring bonus |
| 4 | **ATS (Hedera)** | largest single pool but furthest from our identity and the heaviest SDK |
| 5 | Custom SwapVM opcode | the scoring bonus, only once 3 works |
| 6 | ATS secondary market | extra points, only once 4 works |

**Deliver 1–3 completely before starting 4.** Two finished integrations with
on-device clear signing beat three half-built ones; every one of these tracks
requires a working MVP, an architecture diagram and a demo video, and a
half-finished app cannot produce any of them.

Arc requires being "deployed or deployment-ready on Arc mainnet by September
30" — about three weeks from today, and Arc is currently testnet-only, so
"deployment-ready" is the achievable bar. Say so plainly in the submission.

## 9. To confirm before building

1. **Can one project submit to both a general and a Continuity variant of the
   same sponsor's track?** 1inch and Arc each list both. This materially changes
   the prize maths; ask the organisers.
2. **Hedera Continuity** needs a pre-existing Hedera project. We have none, so
   we target Tokenization of Anything only unless told otherwise.
3. **Arc mainnet timing** — confirm whether "deployment-ready" is accepted where
   mainnet is not yet open.

## 10. What we do not claim

Carried forward from `docs/RELEASE-READINESS.md`, because it stays true and
saying it is a strength:

- Secure boot and eFuse binding are **researched and documented, never burned**.
- The Windows and macOS companions build but have **never been run**.
- The Chrome extension fails at its offscreen connection and ships as a
  documented alpha.
- Browser flashing is blocked for the ESP32-C3; the Pixie is terminal-flashed.
- **Testnets only. No real funds.**
