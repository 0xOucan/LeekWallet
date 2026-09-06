# Alternative path — LatAm collective finance on the LeekWallet ecosystem

Written 2026-09-06. An alternative to `HACKATHON-PLAN.md`, same three sponsors
(1inch, Circle/Arc, Hedera), different thesis: instead of three developer-facing
apps, one product aimed at a problem 40 million Mexicans already have.

Everything below is sourced. Where the research contradicted the original idea,
the idea changed rather than the research.

---

## 1. What the research actually says

### The demand is enormous and already organised

- **31% of Mexico's population participates in a tanda.** Groups of 10–12,
  typically ~$100 weekly, with each turn paying out $1,000–1,250.
- **30% of LatAm adults are unbanked**; only **29%** have formal savings.
- **$324 billion** in LatAm stablecoin volume in 2025, **+89% YoY**. In
  Argentina stablecoins were **more than half** of all peso exchange purchases;
  in Brazil **90%** of crypto flows; Mexico ~40%, driven by remittances.

Adoption is not the barrier it was. Inflation and remittances already did that
work. Nubank alone embedded USDC for 127 million customers.

### On-chain ROSCAs are a graveyard, and the reasons are specific

This is the most important finding, and it kills the obvious idea.

Bloinx (ceased ~2022), Daret (never deployed), Njangi On-Chain (testnet only),
Nexspecto (no adoption) — plus a steady stream of hackathon entries. Almost
none reached a real ROSCA community. Three reasons:

1. **"ROSCAs are already intermediary-free."** Blockchain's central pitch —
   remove the middleman — solves a problem tandas do not have.
2. **Social trust cannot be coded.** In a study of 130 ROSCAs, members raised
   the risk of default and organiser fraud, but *few had actually suffered it*.
   `Confianza` works. Replacing it adds complexity and removes nothing.
3. **Members cannot manage keys or gas.** Expecting low-income, non-technical
   participants to hold private keys and buy a gas token is unrealistic.

**So: do not build an on-chain tanda.** Anything that digitises the rotation
itself is competing with a graveyard and with WhatsApp, and losing to both.

### What tandas genuinely cannot do

The same sources point at the gap. A tanda can produce a lump sum. It cannot:

- **Own an asset.** No legal vehicle for collective title, no way to divide a
  share, no way to exit without dissolving the group.
- **Vouch for a member outside the group.** `Confianza` is not portable.
- **Earn anything on the float.** Money sits idle between contribution and
  payout, in a currency that in Argentina lost 211% in 2023.
- **Scale past the social network.** You can only tanda with people you know.

The one cited author who offers a way forward says future platforms should
combine payment rails with **assets the group might collectively purchase**,
and use technology-based trust to extend reach **where social enforcement no
longer suffices** — not to replace it.

That sentence is the entire design brief.

### Three specific LatAm exclusions the stacks can address

**Renting requires a property-owning guarantor.** In Mexico a landlord
typically demands an *aval* or *fiador* who owns property in the same city.
Without that network you pay **2–3 months' deposit** or buy a *póliza
jurídica*. Young people, internal migrants and informal workers are excluded by
a requirement that has nothing to do with whether they pay rent.

**65% of dwellings are informal.** Across 12 LatAm countries, 65% of dwellings,
76% of rural properties and 92% of businesses are extralegal — **$1.2 trillion
of dead capital**, unusable as collateral.

**Small merchants cannot accept cards.** Fees are high and acceptance low; in
El Zonte, businesses "could never qualify for merchant accounts". Cash still
dominates informal commerce.

### Collective housing works, and is blocked by law, not capacity

Uruguay's FUCVAM: **500+ cooperatives, ~100,000 people, since 1970**, built on
collective ownership and mutual aid. Exported to 15 countries — and it
**failed to take root in almost all of them**. The obstacle was never community
capacity. It was the absence of legal status and public financing; institutional
barriers "increasingly led to individual solutions".

---

## 2. What this rules out, honestly

Before the plan, the things a blockchain cannot do, so we never claim them:

- **It cannot create legal title.** Registering a house on Hedera does not make
  anyone its owner. Only the state registry does. Any pitch implying otherwise
  is false and would deserve to lose.
- **It cannot make an informal property collateral.** De Soto's titling thesis
  is contested; formalisation has in places produced displacement rather than
  credit. We are not "unlocking $1.2 trillion".
- **It cannot manufacture `confianza`.** The circle brings that. We must not
  design as though we supply it.

What is left is narrower, true, and still valuable: **a treasury nobody can
steal, a record the group can show to outsiders, and a vehicle for holding
something together.**

---

## 3. The thesis

> **Do not digitise the tanda. Give the circle a treasury nobody can steal,
> a record it can show, and an asset it can hold.**

And the structural answer to the adoption killer:

> **Members never touch a key. The circle holds one device.**

A tanda already elects an organiser who collects the money. That person gets a
LeekWallet. Members pay in by scanning a QR from any wallet or app they already
use. Nobody manages a seed phrase but the treasurer, once — and even they cannot
move funds without a physical press on a screen the host cannot forge.

This inverts the failure. Prior projects pushed key management down to every
member; we push it up to one device the group already trusts a human to hold.

---

## 4. How the three stacks map — and why each is load-bearing

### Arc (Circle) — the money, and the accessibility fix

**USDC is Arc's native gas token.** That single fact removes the "buy a second
token to pay fees" barrier that the ROSCA post-mortems name explicitly. A
circle operates in one asset it already understands: dollars.

- Chain ID **5042002**, RPC `https://rpc.testnet.arc.io`, explorer
  `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`
- **Native USDC has 18 decimals**; the ERC-20 interface at
  `0x3600000000000000000000000000000000000000` has 6. EURC at
  `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, 6 decimals.
- EURC matters more here than it looks: remittance corridors into LatAm are not
  only from the US.

Contribution requests are **EIP-681** URIs rendered as QR — payable from any
wallet, no app install, no keys issued.

### 1inch Aqua — the float, custodied by nobody

This is the strongest fit in the whole plan, and it is not decorative.

**The historical #1 failure mode of a tanda is the organiser absconding with the
pot.** Every custodial digital tanda reproduces that risk and merely changes who
holds it.

Aqua does not custody. Tokens **stay in the holder's own wallet** under a single
approval; the registry tracks *virtual* balances
(`balances[maker][app][strategyHash][token]`) and moves tokens only at
execution via `pull()`/`push()`.

So an Aqua-backed circle float means **nobody holds the money** — not the
organiser, not us, not a pool contract. The idle pot earns without ever being
deposited anywhere. That is not a yield feature; it is the removal of the exact
risk that has always made tandas fragile.

- Aqua registry `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`
- SwapVM router `0x111111338c5091e8440b67b168bae16a668ac0de`
- SDK `@1inch/aqua-sdk`
- Live on Polygon, Gnosis, Optimism, Unichain, Sonic, BNB — **all already in
  `app/packages/core/src/chains.ts`**

### Hedera ATS — the record and the vehicle

ATS issues **securities** — equities and bonds, ERC-1400 with partial ERC-3643,
KYC-gated registers, freezes, transfer restrictions, lock-ups, plus a
mass-payout framework.

That is precisely the machinery a cooperative needs and a spreadsheet cannot be:
**who contributed what, who holds which share, what the exit terms are, and who
is allowed to hold one.** FUCVAM's blocker was the absence of a vehicle for
collective ownership; ATS is a credible digital form of one — a participation
unit, not a deed, and we say so.

Mass payout is the distribution rail when a circle owns something that yields.

### LeekWallet — the trust anchor

One device, held by the elected treasurer. Every disbursement rendered and
physically confirmed. The companion's existing **ERC-7730 clear-signing engine**
(`app/packages/core/src/erc7730.ts`) makes each of the three domains legible on
a 128×64 screen — including the 18-vs-6 decimals trap, which on a device that
renders raw units (`src/ui.c:4834`) is a factor of 10¹² waiting to happen.

---

## 5. Three candidate products, assessed

The user asked for the option space, not one answer.

### Option A — **Círculo de Aval** (the deposit-and-guarantee circle)

A savings circle whose output is not just a lump sum but a **credential**: the
group's on-chain record substitutes for the *fiador* a member does not have,
and the group posts a real escrowed deposit.

| | |
|---|---|
| Problem | You cannot rent without a property-owning guarantor |
| Who | Young people, internal migrants, informal workers |
| Arc | Deposit escrowed in USDC; rent paid in USDC/EURC; USDC is gas |
| Aqua | Deposit earns while escrowed, custodied by nobody |
| ATS | The circle's participation register; the guarantee instrument |
| Novelty | **High.** Exports `confianza` as a portable credential instead of replacing it — exactly what the ROSCA post-mortems say is missing |
| Risk | The landlord must accept it. Demo-able, but real adoption needs a counterparty |

### Option B — **Círculo de Vivienda** (the FUCVAM-shaped acquisition circle)

A circle accumulating toward **collective** acquisition, with ATS participation
units as the internal ownership record and exit mechanism.

| | |
|---|---|
| Problem | Co-ops work but lack a legal vehicle and finance outside Uruguay |
| Arc | Contributions and settlement |
| Aqua | The multi-year float — the longer the horizon, the more the yield matters |
| ATS | The participation register, lock-ups, transfer restrictions, distributions |
| Novelty | **High**, and it is the one the literature explicitly asks for |
| Risk | **Highest.** Long horizon, and we cannot supply legal title. A demo shows the register and the rules, not a house changing hands |

### Option C — **La Caja** (merchant till + circle treasury)

The Arc POS from the first plan, joined to the circle: a food-truck park or
market where merchants accept USDC/EURC and a merchants' circle pools a slice
of takings.

| | |
|---|---|
| Problem | Small merchants cannot get card acceptance; takings sit in cash |
| Arc | POS, QR, tips, batch settlement — all as originally designed |
| Aqua | The pooled treasury earns without custody |
| ATS | Weakest fit; the merchants' association register, at best |
| Novelty | **Medium.** Crypto POS is well-trodden; the circle treasury is the fresh part |
| Risk | **Lowest.** Bitcoin Beach proved merchant circular economies work, and we already planned the POS |

### Recommendation

**Build A, with C as the on-ramp, and treat B as the roadmap.**

A is the most defensible and the most LatAm-specific. C is largely already
planned, demos beautifully, and gives A a source of real transaction history. B
is the vision and belongs in the pitch, not the sprint — its horizon is years
and its blocker is legislative.

If forced to one: **A**.

---

## 6. What we ship

One companion app, **Círculo**, plus firmware clear-signing for three domains.

```
app/packages/apps/circulo/
  circle.ts        membership, rounds, contribution schedule
  arc/             EIP-681 requests, QR, USDC/EURC, 18-vs-6 decimals
  aqua/            float strategy: ship/dock, non-custodial by construction
  ats/             participation register, distributions
  credential.ts    the exportable record a landlord can verify
```

The device renders what matters:

```
  DISBURSE ROUND 7          POST DEPOSIT
  Circle  Tacos del Parque  Circle  Tacos del Parque
  To      María G. (#4)     For     Av. Juárez 118
  Amount  1,200.00 USDC     Amount  3,600.00 USDC
  Round   7 of 12           Locked  12 months
  [ REJECT ]   [ APPROVE ]  [ REJECT ]   [ APPROVE ]
```

Branches, as before — one per stack, none importing another:

```
main
├── feat/apps-framework      lands first
├── feat/app-circulo-arc     money rails + decimals
├── feat/app-circulo-aqua    non-custodial float
└── feat/app-circulo-ats     register + credential
```

---

## 7. Honest sequencing

| # | Work | Note |
|---|---|---|
| 1 | `feat/apps-framework` | small, everything depends on it |
| 2 | Arc: contributions, QR, decimals, disbursement | the demo spine |
| 3 | Aqua: the float | the strongest narrative; SwapVM decoder if time |
| 4 | ATS: register + credential export | heaviest SDK, do last |

Finish 1–3 before starting 4. Every track requires a working MVP, an
architecture diagram and a demo video; a half-built integration produces none.

## 8. What we will not claim

- No legal title, no property registry, no "unlocking dead capital".
- No claim that this banks the unbanked. It gives an existing, working
  institution a treasury and a record.
- The device is the trust anchor; secure boot is **still not burned**, so we do
  not claim tamper resistance.
- **Testnets only. No real funds.**
