# La Caja — Arc mini-app

Standalone plan. One document per sponsor app; this is the Arc one.

**What it is.** A point of sale for small merchants. A waiter builds a bill,
adds a tip, and shares it. The customer pays in USDC or EURC from whatever
chain they already use. Takings sweep to the merchant's Arc treasury. Only the
LeekWallet device can withdraw.

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

### The receiving address is a contract, not an EOA

This is the one non-obvious decision, and it is what keeps the relayer honest.

If the customer pays into the merchant's **EOA**, then bridging those funds to
Arc requires a key that controls that address. Two bad options follow: the
merchant signs every sweep by hand, or the relayer holds a hot key that controls
customer money. The second is custody, and it is exactly what this project
argues against everywhere else.

So the address printed on the QR is a **`CajaInbox`** — a small contract, one per
chain, with an **immutable destination** set at deployment:

```solidity
contract CajaInbox {
    address public immutable token;        // USDC or EURC on this chain
    bytes32 public immutable destination;  // merchant's Arc address
    uint32  public constant DOMAIN = 26;   // Arc, fixed

    /// Anyone may call. Bridges the whole balance to `destination` on Arc.
    function sweep() external { ... depositForBurn(...) ... }
}
```

Consequences, all good:

- **Anyone can call `sweep()`.** The relayer is a caller who pays gas, not a
  custodian. It has no key over the funds.
- **A rogue or compromised relayer can only send the money where the merchant
  already said.** The destination is immutable.
- **No EIP-3009 needed.** The user's instinct — "just relay, route, send" — is
  preserved exactly, and made safe by the contract rather than by trusting the
  relayer.
- Deploy with **CREATE2** so the same address appears on every chain. The
  customer sees one address regardless of where they pay.

> **The relayer is a private key, some gas, and a loop.** Watch the inboxes,
> call `sweep()`, poll Iris, call `receiveMessage` on Arc. No encryption, no
> consensus. The contract is what makes that simplicity safe.

It lives on the VPS and belongs in **its own repository** — it is an operational
service with a hot key and a deploy cadence, and none of that should share a
release process with wallet firmware. It needs no access to the companion, the
device, or the vault; it reads chains and calls `sweep()`. Two jobs:

1. **Confirm** — watch `Transfer` logs to each `CajaInbox` and report a payment
   as received, so the waiter can tell the customer it went through. This is the
   latency the customer feels, and it is seconds.
2. **Settle** — call `sweep()`, poll Iris, call `receiveMessage` on Arc. This is
   background work nobody waits for.

Keeping those two jobs separate matters: **the customer is never waiting on
CCTP.** Confirmation is a log read.

### Two roles, two devices, one signed chain of custody

The admin issues the amount; the waiter adds the tip; the customer pays. Both
staff run the companion, in different modes.

```
  ADMIN (has LeekWallet)      MESERO (companion only)      CUSTOMER
  ──────────────────────      ───────────────────────      ────────────
  opens the shift             scans admin QR
  signs a SHIFT GRANT     →   receives base amount     →   scans final QR
  issues base check       →   adds tip 10/15/custom        pays from any chain
  (no tip, no key given)      shows PAID to client     ←   relayer confirms
```

**The question this design has to answer: what stops a waiter inventing an
order, or pocketing the difference?** A QR containing only numbers stops
nothing. So the amounts are signed.

**Shift grant.** At shift open the admin's device signs one EIP-712 grant:

```
  OPEN SHIFT · Tacos del Parque
  Date      6 Sep, 14:00–23:00
  Staff     4 terminals
  Max order      2,000.00 USDC
  Max tip              25%
  [ REJECT ]              [ APPROVE ]
```

One physical press per **shift**, not per order — a press per table is not a
product. The grant names the staff terminals, caps the order value and caps the
tip percentage.

**Each order** is then signed by the waiter's terminal key, which the grant
names. The QR the customer scans carries `{merchant, orderId, base, tip,
staffId}` plus that chain of signatures.

What this buys, and it is the whole point of a hardware wallet being present:

- A waiter **cannot invent revenue** — an order outside a valid grant never
  settles as legitimate takings, so the books do not silently absorb it.
- A waiter **cannot exceed the tip cap** the admin signed.
- Every peso is attributable to a `staffId`, which is what makes tip splitting
  at shift close arithmetic rather than an argument.
- The admin **never hands out a key**. The grant is a capability with an expiry.

For the demo, per-order admin signing is also supported and is more visually
obvious. The shift grant is the version that would survive a real Friday night.

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

### Step 2 — Terminal mode
A companion mode with **no key and no reachable signing path**. Waiter enters a
total, picks **10% / 15% / custom** tip, sees the grand total, and produces:

- a **QR** with an EIP-681 URI, and
- a **share link** — because in Latin America a bill gets sent over WhatsApp

Chains are listed **cheapest first**, with L1 marked as expensive for small
tickets.

### Step 3 — The watcher
Poll `Transfer` logs to each `CajaInbox` across all nine chains.

**A chain whose RPC is unreachable shows as *unknown*, never *unpaid*.** Telling
a customer their payment did not arrive when our RPC is down is this app's worst
possible failure.

Matching an order to a payment: **unique amount** for the MVP — `$284.53`
becomes `$284.5317`, so two open orders never collide. (Upgrade later: derive a
per-order address from the merchant's public xpub, watch-only, no key on the
terminal.)

### Step 4 — Roles and shifts
**Admin** (device), **cashier**, **waiter** (staff id on every request). Tips
accrue per staff id. Shift close produces one settlement the admin approves.

### Step 5 — The relayer and the sweep
A loop: watch inboxes → `sweep()` → poll Iris → `receiveMessage` on Arc.

### Step 6 — `CajaTill` on Arc
Receives the mint, records orders and tip splits, and permits withdrawal **only**
by the device's address.

```
  WITHDRAW FROM TILL
  Merchant  Tacos del Parque
  Sales     1,284.50 USDC
  Tips        96.00 USDC (4 staff)
  To        admin · 0x7a3f…91c2
  [ REJECT ]              [ APPROVE ]
```

---

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

## 5. Testing rounds

| # | What is tested | Testnet funds |
|---|---|---|
| **T1** | USDC and EURC render correctly on Arc and Base Sepolia; a **missing descriptor refuses** | Arc USDC; Base Sepolia USDC + ETH |
| **T2** | QR paid from a phone wallet on Base Sepolia; terminal confirms; **terminal has no signing path** | Base Sepolia USDC + ETH |
| **T3** | Pay from 3 chains, all detected; **kill one RPC → shows *unknown*, not *unpaid*** | USDC + gas on Base Sepolia, Polygon Amoy, Avalanche Fuji |
| **T4** | EURC accepted on Base Sepolia, correctly **unavailable** on Polygon Amoy | Base Sepolia EURC |
| **T5** | Tip presets compute correctly; batch settlement reconciles; a **mismatched recipient list refuses** | Arc USDC |
| **T6** | `CajaInbox.sweep()` callable **by anyone**; funds can only reach the immutable destination | Base Sepolia USDC + ETH |
| **T7** | Full sweep Base Sepolia → Arc; **measure the real Fast Transfer time** | Base Sepolia USDC + ETH; Arc USDC |
| **T8** | Crash between `sweep()` and `receiveMessage`; **resumes from the attestation, no double-burn** | as T7 |
| **T9** | `CajaTill` withdrawal by a non-admin **refuses**; by the device, succeeds and renders | Arc USDC |

**T6 and T8 are the ones that matter.** T6 proves the relayer cannot redirect
funds. T8 proves a crash does not lose money that has already been burned on the
source chain.

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
| **C4** | Tips, roles, shift close (T5) | + accountability |
| **C5** | `CajaInbox` + relayer + sweep (T6–T8) | + auto-settlement to Arc |
| **C6** | `CajaTill` (T9) | + hardware-gated treasury |
| **C7** *(stretch)* | EIP-3009 gasless path | + zero-gas customers |

**Record the demo at C2.** A working POS on video is a submission; an
unrecorded C5 is not.

---

## 7. What we will not claim

- The relayer is trusted for **liveness**, not custody. If it stops, sweeps
  stop; it can never redirect or take funds. That distinction goes in the
  README, not in the small print.
- "Cheaper than card" is true on L2s and Arc, **not on Ethereum L1 below ~$49**.
- Arc is **testnet only**; we submit as deployment-ready and say so.
- Secure boot is not burned. ATECC608B and airgapped comms are bench work about
  to begin, not shipped.
- Testnets only. No real funds.
