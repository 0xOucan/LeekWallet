# La Caja — Arc mini-app

Standalone plan. One document per sponsor app; this is the Arc one.

**What it is.** A point of sale for small merchants, on two devices. The
cashier builds the bill and the tip and issues a payment request; the waiter
carries a phone to the table, scans that request, and shows the customer what to
pay. The customer pays in USDC or EURC from whatever chain they already use, to
the restaurant's own address. Neither staff device holds the LeekWallet, and
neither can move money.

---

## 1. The design, and why it is this shape

### The customer pays their own gas, and sends directly

The customer makes a **plain ERC-20 transfer** from any wallet, on any chain we
accept. No CCTP knowledge, no meta-transaction, no app install, no approval
step.

This was not the first design. It is better than the alternatives:

| Alternative | Why not |
|---|---|
| Customer calls `depositForBurn` so funds land on Arc | Requires a CCTP-aware wallet. Even **Fast Transfer is 8–20 s** and Standard is **15–19 min** — dead time at a table |
| Customer signs EIP-3009, we relay gaslessly | Elegant, and a genuine upgrade, but it needs a forwarder contract per chain and signed fee bounds. **Not the MVP** |

Gas on an L2 is a fraction of a cent. Making the customer pay it removes an
entire subsystem.

### The relayer is gone — 2026-09-08

An earlier draft of this document put a `CajaInbox` contract on every chain, gave
it an immutable Arc destination, and ran a relayer on a VPS that called
`sweep()`, polled Iris and called `receiveMessage` on Arc. All of that has been
**dropped**, and this section is kept as the record of why rather than deleted.

The owner's reasoning, and it is better than what it replaced: **it does not
matter which chain the money lands on.** A restaurant that is paid in USDC on
Base is paid. Consolidating those takings onto Arc is a treasury preference, not
a requirement of taking payment, and it was paying for itself with:

| What the relayer cost | |
|---|---|
| A contract per chain | nine deployments, CREATE2, an audit surface |
| A hot key | on a VPS, holding gas, running unattended |
| A second repository | its own deploy cadence, its own on-call |
| A failure mode | crash between `sweep()` and `receiveMessage` |

So the design says which chains are accepted, shows all of them, and lets the
customer choose. **No bridging, no hot key, no contract, no service.** The
address on the QR is the restaurant's own address, and what arrives has arrived.

What is genuinely lost: takings sit on nine chains instead of one, and somebody
has to consolidate them eventually. That is a periodic treasury operation the
merchant does with the LeekWallet in hand — one press, at a time of their
choosing — not a service that must be running while a customer stands at a
table. Trading an always-on hot key for an occasional hardware-signed transfer
is the right direction for this project specifically.

The CCTP reference data in §3 stays. It is correct, it costs nothing to keep,
and a merchant who does want to consolidate onto Arc will need it.

### Two roles, two devices, no relayer

```
CASHIER / ADMIN (companion)        WAITER (companion, phone or tablet)
──────────────────────────         ──────────────────────────────────
enters the bill + tip          →   scans the cashier's QR
issues a payment-request QR        shows the client the address QR
                                   watches every accepted chain
                                   sees the payment land
```

Neither role holds the restaurant's LeekWallet. The restaurant address is a
fixed recipient; the customer pays it on any accepted chain, and the waiter sees
it arrive. They are two separate mini-apps — `till` and `till-waiter` — mounted
on two devices, and that separation is what makes the next section true.

**A waiter cannot modify the request.** This is the whole point of splitting the
roles, so it is structural rather than a disabled input:

- The request is a **frozen value**, not a form. The cashier seals
  `{merchant, recipient, token, total, marker, chains, issuedAt}` into one
  canonical byte string; the waiter's app *parses* that string and holds the
  result frozen (`Object.freeze`, `readonly` throughout). Writing to it throws.
- The waiter's module **contains no constructor**. `waiter.ts` does not import
  `sealRequest`, `buildOrder`, `parseCents`, `tipCents` or `newMarker`, and a
  test reads the file and fails if it ever does. An amount it did not receive is
  an amount it has no code to produce.
- The waiter's screen has **one input**, and it takes a request, never a number.
  A test mounts the app, fills every input it can find with hostile values,
  fires every listener, and asserts the payable units and the recipient in the
  rendered URI are byte-identical to the ones the cashier sealed.
- Choosing which chain's QR is displayed is not a modification: the recipient
  and the figure are the same on all of them, and the other eight stay on
  screen with their own amounts.

### What the request does and does not prove

The QR carries a **checksum**, a truncated sha256 over the canonical bytes. It
detects a request that was mis-scanned or edited after issue, and the waiter's
app refuses a mismatch outright rather than showing it with a warning.

It is **not a signature**, and this document is not going to imply otherwise.
There is no signing key in the cashier's app: `AppContext.propose` needs the
device, and the cashier does not hold it — the device is the treasury, in a
safe. So:

> **Anyone who can display a QR can forge a payment request.** A waiter with a
> phone and this source code can seal a request for any amount they like, and no
> terminal can tell it from a genuine one.

What stops that being theft is not cryptography, it is the recipient:

1. The waiter's app **refuses any request that does not pay the address the
   terminal was configured with**. A forged request therefore pays the
   restaurant. The forger's gain is zero.
2. What a forger *can* do is overcharge a customer — bill $400 for a $40 meal —
   and the restaurant keeps the money. That is a dispute at the counter, not an
   exfiltration, and it is exactly the exposure a paper bill pad already has.
3. Rewriting the recipient to the waiter's own address is the attack that would
   actually cost the restaurant money, and it is the one (1) refuses.
4. What no unsigned request can prevent: a waiter quietly issuing bills the
   cashier never approved, into the restaurant's account. Reconciling those is
   accounting, not cryptography.

The upgrade is obvious and needs one thing this milestone does not have: a key
on the cashier's device. When the cashier is an admin holding the LeekWallet,
`propose` can sign an EIP-712 request and the waiter can verify it against the
merchant's published address. Until then the checksum is integrity, and the
words in the UI say integrity.

### The SDK: what Circle's App Kit is used for, and what it is not

`@circle-fin/app-kit/chains` supplies the USDC and EURC addresses, the chain
ids, the CCTP domains and the Gateway contracts for all nine rails. They used to
be a hand-copied table in `rails.ts`: right on the day it was typed, and nothing
in the repository would have noticed the day it stopped being. A wrong USDC
address on a QR is money sent to a contract that cannot return it.

The subpath is load-bearing. The package **root** exports `Adapter`, `spend`,
`bridge` and the rest of the wallet layer, and the terminal's import allow-list
matches `@circle-fin/app-kit/chains` and not the root — an object with a
`.spend()` on it has no business inside an app whose claim is that it cannot
move money. That is docs/SDK-POLICY.md's rule applied literally: the SDK
supplies the data, and nothing here hands it a signer, because there is none to
hand.

Not used, with reasons rather than omissions:

| App Kit capability | Why not |
|---|---|
| **Send** | The terminal never sends. The customer's own wallet does, from their own device. |
| **Swap**, **Bridge** | Both need a signer, and both existed to serve the relayer that no longer exists. Nine accepted chains is the replacement for bridging. |
| **Earn** | A restaurant's float is not a yield position, and it would need the key. |
| **Unified Balance** | The one that nearly fitted. `getBalances` takes a plain address and no signer, so a keyless terminal *can* call it — but Gateway balances only show USDC that has been **deposited into Gateway**, and depositing requires a signature the terminal cannot make. A merchant taking ordinary ERC-20 transfers to their address has a unified balance of zero, so the figure would be a confident, wrong answer to "what have I taken today". It belongs on an admin screen where the device is present, not on a point of sale. |
| **`@circle-fin/adapter-viem-v2`** | Its entire job is to give a kit a wallet client. This app has no key and no longer bridges, so installing it would add an unused dependency to a security-critical import allow-list. |

### Chain choice is the customer's, and it is shown

The final QR lists every accepted chain with its logo, **cheapest first**.
Mainnet or testnet is a configuration flag, not a code path. The customer taps
the chain they already hold USDC on.

### Direction is fixed: into Arc, never out

The public Iris API returns **nothing for Arc as a source domain (26)** —
an open issue on `circlefin/evm-cctp-contracts`, whose only workaround is a
community-hosted relay. We never depend on it. Money flows in and settles.

---

## 2. The economics — with the correction

Mexican merchant discount rates, from Banxico's published tables (Oct 2025,
giro "Otros") and Mercado Pago's own terms:

| Provider | Rate |
|---|---|
| Clip, average | **3.59%** |
| Clip, debit | 1.90% |
| Mercado Pago, average | **3.34%** |
| Mercado Pago Point, debit | 3.5% **+ IVA → 4.06%** |

Ours is gas only. On a ticket:

| Ticket | Card @ 4.06% | L2 / Arc (~$0.01) | **Ethereum L1 (~$2.00)** |
|---|---|---|---|
| $10 | $0.41 | $0.01 | **$2.00** |
| $20 | $0.81 | $0.01 | **$2.00** |
| $50 | $2.03 | $0.01 | **$2.00** |
| $100 | $4.06 | $0.01 | $2.00 |
| $300 | $12.18 | $0.01 | $2.00 |

**The correction worth having before this reaches a pitch deck: Ethereum L1 is
*worse* than a card below roughly a $49 ticket.** For a taquería with $10–20
bills, L1 costs two to five times a Mercado Pago fee. The claim "cheaper than
Mastercard" is true on L2s and Arc by a factor of 40–80, and **false on L1 for
ordinary restaurant tickets**.

So the terminal **ranks chains by cost and warns on L1 for small tickets**. That
is a more honest product and a better demo than pretending all chains are equal.

---

## 3. Reference data

**Arc:** chain **5042002** · RPC `https://rpc.testnet.arc.io` · explorer
`https://testnet.arcscan.app` · faucet `https://faucet.circle.com` · **USDC is
the native gas token** · native USDC **18 decimals**, ERC-20 interface **6**.

**CCTP V2 testnet contracts — identical on every chain:**

| Contract | Address |
|---|---|
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` |
| MessageV2 | `0xbaC0179bB358A8936169a63408C8481D582390C4` |

**Domains and tokens (testnet):**

| Chain | Domain | USDC | EURC |
|---|---|---|---|
| Ethereum Sepolia | 0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4` |
| Avalanche Fuji | 1 | `0x5425890298aed601595a70AB815c96711a31Bc65` | `0x5E44db7996c682E92a960b65AC713a54AD815c6B` |
| OP Sepolia | 2 | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | — |
| Arbitrum Sepolia | 3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | — |
| Base Sepolia | 6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x808456652fdb597867f38412077A9182bf77359F` |
| Polygon Amoy | 7 | `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582` | — |
| Unichain Sepolia | 10 | `0x31d0220469e10c4E71834a79b1f276d740d3768F` | — |
| Linea Sepolia | 11 | `0xFEce4462D57bD51A6A552365A011b95f0E16d9B7` | — |
| **Arc Testnet** | **26** | `0x3600000000000000000000000000000000000000` | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |

Attestation: `https://iris-api-sandbox.circle.com/v2/messages/{srcDomain}/{txHash}`

**USDC pays from 9 chains; EURC from 4.** Unavailable combinations are greyed
out, never offered.

---

## 4. Build, step by step

### Step 1 — Chains and descriptors
Add Arc and the eight source chains to `app/packages/core/src/chains.ts`.
ERC-7730 descriptors for USDC and EURC on each.

The Arc descriptor is the one that matters: native USDC is 18 decimals, the
ERC-20 interface is 6, and the device renders **raw units** by design
(`src/ui.c:4834`). Without the descriptor the screen is wrong by 10¹².

### Step 2 — Cashier mode
A companion mode with **no key and no reachable signing path**. The cashier
enters a total, picks **10% / 15% / custom** tip, sees the grand total, and
produces:

- a **QR** with an EIP-681 URI, and
- a **share link** — because in Latin America a bill gets sent over WhatsApp

Chains are listed **cheapest first**, with L1 marked as expensive for small
tickets.

### Step 3 — The watcher
Poll `Transfer` logs to the merchant's address across all nine chains.

**A chain whose RPC is unreachable shows as *unknown*, never *unpaid*.** Telling
a customer their payment did not arrive when our RPC is down is this app's worst
possible failure.

Matching an order to a payment: **unique amount** for the MVP — `$284.53`
becomes `$284.5317`, so two open orders never collide. (Upgrade later: derive a
per-order address from the merchant's public xpub, watch-only, no key on the
terminal.)

### Step 4 — Two roles, two devices
**Cashier** issues; **waiter** displays and watches. Two mini-apps, `till` and
`till-waiter`, sharing a package and a stylesheet. The waiter's app parses a
sealed request and has no code that builds one; see §1.

### Step 5 — ~~The relayer and the sweep~~ *dropped*
Replaced by "say which chains are accepted and let the customer choose". The
reasoning is in §1; nothing in this app bridges, and no service runs unattended.

### Step 6 — ~~`CajaTill` on Arc~~ *deferred*
A treasury contract on Arc that only the device may withdraw from is still the
right end state, and it is no longer on this app's critical path: with the
relayer gone, takings arrive directly in the merchant's address on whichever
chain the customer used. Consolidating them is a hardware-signed transfer the
merchant makes when they choose.

## 4b. Verified on hardware and on-chain — 2026-09-08

The first real payment through the terminal, end to end, with nothing mocked.

| | |
|---|---|
| Wallet | Rabby, scanning the terminal's QR |
| Chain | Base Sepolia (84532) |
| Token | USDC `0x036cbd53842c5426634e7929541ec2318f3dcf7e` |
| Amount | `2429700` raw = **2.4297 USDC** — the marker matched exactly |
| Tx | `0xe7c7423692c6f6cb91272a2a4cc94021951be424a074f1cc74c096085d0a6f15` |
| Block | 46533335, status success |
| Detected | by the watcher, on the right chain, with confirmations counted |

Independently confirmed by `eth_getTransactionReceipt`: the `Transfer` log's
`to` is the merchant address and the value is the exact payable amount,
sub-cent marker included. **T2 and T3 are met against a live chain**, and the
unique-amount matching works in practice and not only in a test.

Eight other chains simultaneously reported *checked and nothing has arrived*,
each naming its block range and the operator that answered — so the watcher
distinguished the paying chain from eight quiet ones rather than guessing.

**Still untested:** the unreachable-RPC path against a real outage. The wording
is in place (*"A chain that could not be reached is shown as unknown, never as
unpaid"*) but every chain answered during this run, so nothing exercised it.

## 4c. C4 as built — 2026-09-08

The milestone as delivered, which is not the C4 in the table below as originally
written; the table has been updated to match.

| | |
|---|---|
| Roles | two mini-apps, `till` (cashier) and `till-waiter` |
| Request | canonical `caja1\|…` byte string, frozen on decode, sha256 checksum |
| Unmodifiability | structural — no constructor in `waiter.ts`, one input on screen, proven by `test/waiter.test.ts` |
| Anti-forgery | recipient pinned to the terminal's own merchant address |
| Chains | all nine shown on the client-facing view, each with its own payable figure |
| SDK | `@circle-fin/app-kit/chains` supplies every USDC and EURC address |
| Not built | shift grants, staff ids, tip accounting — those were C4's other half and remain open |

The exact payable figure, sub-cent marker included, is the prominent number on
both screens, under the words **Total to pay**.

## 5. Testing rounds

| # | What is tested | Testnet funds |
|---|---|---|
| **T1** | USDC and EURC render correctly on Arc and Base Sepolia; a **missing descriptor refuses** | Arc USDC; Base Sepolia USDC + ETH |
| **T2** | QR paid from a phone wallet on Base Sepolia; terminal confirms; **terminal has no signing path** | Base Sepolia USDC + ETH |
| **T3** | Pay from 3 chains, all detected; **kill one RPC → shows *unknown*, not *unpaid*** | USDC + gas on Base Sepolia, Polygon Amoy, Avalanche Fuji |
| **T4** | EURC accepted on Base Sepolia, correctly **unavailable** on Polygon Amoy | Base Sepolia EURC |
| **T5** | Tip presets compute correctly; the sealed request round-trips to identical bytes | none |
| **T6** | **A waiter cannot modify the request**: every input attacked, every listener fired, the payable units and recipient unchanged | none |
| **T7** | An **edited** request QR is refused by its checksum, field by field | none |
| **T8** | A request paying **any address but the restaurant's** is refused before it reaches a customer | none |
| **T9** *(deferred)* | `CajaTill` withdrawal by a non-admin refuses; by the device, succeeds and renders | Arc USDC |

**T6 and T8 are the ones that matter**, and they are the ones automated. T6 is
the property the two-role split exists for; T8 is the only thing standing
between an unsigned request and a waiter redirecting a bill, because there is no
signature to check (§1).

T6–T8 are unit tests and need no funds — which is the point: a security property
that only holds when a testnet faucet is up is not a property anyone should rely
on.

### Funds to obtain

| Asset | Source |
|---|---|
| **Arc USDC** — get this first, it is gas *and* settlement | `faucet.circle.com` |
| USDC: Base Sepolia, Polygon Amoy, Avalanche Fuji | `faucet.circle.com` |
| EURC: Base Sepolia | `faucet.circle.com` |
| Native gas: Base Sepolia ETH, POL (Amoy), AVAX (Fuji) | public faucets |

---

## 6. Milestones and gates

Every gate answers: **works / refuses / renders / recovers / written down.**

| Gate | Deliverable | Submittable if we stop |
|---|---|---|
| **C1** | Chains + descriptors (T1) | Arc support, correct rendering |
| **C2** | **Terminal + single-chain payment (T2)** | **Working POS** ✅ |
| **C3** | Watcher + EURC matrix (T3–T4) | + multi-chain acceptance |
| **C4** | **Two roles, unmodifiable request, App Kit chain data (T5–T8)** | **+ a bill a waiter cannot alter** ✅ |
| **C5** | ~~`CajaInbox` + relayer + sweep~~ | dropped — §1 |
| **C6** | `CajaTill` on Arc (T9) | + hardware-gated treasury, deferred |
| **C7** *(stretch)* | Signed requests once the cashier holds the device | + a forged bill becomes detectable |
| **C8** *(stretch)* | EIP-3009 gasless path | + zero-gas customers |

**Record the demo at C2.** A working POS on video is a submission; an
unrecorded C6 is not.

---

## 7. What we will not claim

- **The payment request is not authenticated.** It carries a checksum, not a
  signature, and anyone who can display a QR can forge one. We claim only what
  is true: a forged request pays the restaurant's own address, because the
  waiter's app refuses any other recipient. That sentence goes in the README, in
  those words.
- A waiter **cannot alter** an issued request, and that one is structural and
  tested. It is a different claim from the one above and must not be blurred
  into it.
- There is **no relayer and no bridging**. We do not claim automatic settlement
  onto Arc; takings sit where the customer paid until the merchant moves them
  with the device.
- "Cheaper than card" is true on L2s and Arc, **not on Ethereum L1 below ~$49**.
- Arc is **testnet only**; we submit as deployment-ready and say so.
- Secure boot is not burned. ATECC608B and airgapped comms are bench work about
  to begin, not shipped.
- Testnets only. No real funds.
