# What you can test today, step by step

Written against `main` at the time of the three-way merge. Honest about what is
built and what is not — three mini-apps exist, but they are at different
milestones and only one is testable end to end.

---

## 0. First: you do NOT need to reflash your boards

```
git diff --stat v0.1.0-chaak-pool..main -- src/ components/ partitions.csv platformio.ini
   (empty)
```

**Zero firmware changes since the release.** Every one of the 10,530 changed
lines is companion-side. Your Firefly Pixie and ESP32-S3 are already running the
current firmware, and reflashing would only risk your wallets for no gain.

**Do rebuild the companion** — that is where all the new work is.

---

## 1. What is actually testable

| App | Milestone | Testable now? |
|---|---|---|
| **Arc — La Caja** | C2 + C3 | ✅ **end to end, with your funds** |
| **Aqua** | Q1 only | ⚠️ read-only view; `ship()`/`dock()` **not built** |
| **Hedera — ATS** | E2 + descriptors | ⚠️ fixture-backed; no security deployed yet |

**Nothing signs yet.** The `propose()` seam exists but no app calls it. The
device is not involved in any of these three flows today, which is why the
firmware did not change.

---

## 2. Build the companion

```bash
cd ~/Hardware/FireflyPixie/leekwallet
git pull
pnpm --dir app install
pnpm --dir app typecheck && pnpm --dir app test     # both should pass
```

**Desktop:**
```bash
pnpm --dir app tauri dev            # or: pnpm --dir app tauri build
```

**Android** — the generated project is not tracked, so it is re-created:
```bash
pnpm --dir app tauri android init
pnpm --dir app tauri android build --apk
```
Signing, if you want an installable release APK, is in `docs/SIGNING-KEYS.md`
(fingerprint `73:31:6B:9C:…:39:7B`). For testing, a debug build is fine and needs
no keystore.

---

## 3. Arc — La Caja  ✅ the one to demo

You have USDC/EURC on Base Sepolia, Ethereum Sepolia and Arc. That is enough.

### 3.1 The terminal
1. Open the companion, switch the chain to **Arc Testnet (5042002)**.
2. Open **La Caja** from the apps menu.
3. Enter a total, e.g. `284.53`. Pick **10%**, **15%**, or a custom percent.
4. Check the three lines sum: base + tip = total. They are integer cents; a
   third decimal is refused rather than truncated.
5. Note the payable amount carries sub-cent entropy — `284.5317`. That marker is
   how the watcher tells two open orders apart.

### 3.2 The share
- **QR** — scan with a phone wallet.
- **Copy link** — an `ethereum:` URI.
- **WhatsApp** — how a bill actually travels in Latin America.

Chains are listed **cheapest first**. Ethereum L1 is marked expensive: below a
**$49.27** ticket, L1 gas costs more than a Mexican card fee (Banxico: Clip
3.59%, Mercado Pago 3.34%, MP Point debit 4.06%).

**EURC exists on only 4 of the 9 chains.** Impossible combinations are struck
through, not offered and then failed. Verify that: pick EURC, then look at
Polygon Amoy — it should be unselectable.

### 3.3 Pay it, and watch it arrive
1. Scan the QR with a wallet holding **Base Sepolia USDC**.
2. Send the exact amount shown.
3. The terminal should mark it paid within a poll cycle.

### 3.4 The test that matters most
**Turn off your network mid-watch**, or point a chain at a dead RPC.

The chain must render as **unknown / not looked at** — never as **unpaid**.
Telling a customer their payment did not arrive when the RPC is merely down
invites them to pay twice. If you ever see "unpaid" for an unreachable chain,
that is a bug and I want to know.

---

## 4. Aqua — read-only portfolio  ⚠️

**`ship()` and `dock()` are not built.** Q2 is the next milestone. What exists is
the portfolio view.

### What you can do now
Point it at an address that already has Aqua positions. Aqua is deployed on:

| Chain | Registry `0x1111113ccf1426a8e30e2bff5e005d929bf6a90a` |
|---|---|
| Polygon, Gnosis, Ethereum **mainnet** | ✅ |
| **Ethereum Sepolia** | ✅ (verified: identical bytecode, 25 events in 9000 blocks) |
| Base/Arb/OP Sepolia, Amoy, Chiado | ❌ |

So a **Sepolia** address works, and you have Sepolia funds.

Check two things:
1. An address with no positions shows an **empty state**, not a spinner.
2. Kill the RPC — it must say **unavailable**, never **0**. An LP who reads "0"
   and believes their liquidity is gone will do something expensive.

### For Q2 later
Sepolia has the registry, so `approve`/`ship`/`dock` can run there with faucet
ETH. SwapVM decoding (Q3) needs a **mainnet fork** — the router is mainnet-only,
and the sponsor states local forks are acceptable.

**Licence caution:** Aqua is `LicenseRef-Degensoft-Aqua-Source-1.1` —
source-available, not open source, incompatible with our Apache-2.0. Calling the
deployed contracts is fine; **copying or modifying SwapVM source is not** without
reading that licence first.

---

## 5. Hedera — issuer console  ⚠️ needs one deployment

Your HBAR unblocks this, and there is good news: **you do not have to deploy the
ATS contract suite.** It is already on testnet.

From `apps/ats/web/.env.example` in the ATS repo:

| Contract | Hedera ID | EVM address |
|---|---|---|
| Business Logic Resolver | `0.0.9212226` | `0x00000000000000000000000000000000008c9142` |
| Factory | `0.0.9213391` | `0x00000000000000000000000000000000008c95cf` |

Chain **296**, RPC `https://testnet.hashio.io/api`, explorer HashScan.

### What to do
1. Fund an EVM-compatible account with testnet HBAR (`portal.hedera.com`).
2. Call the factory's `deployEquity` to issue one security. Easiest route today
   is the ATS web app pointed at those IDs; the SDK route is `Equity.create`.
3. Note the resulting token address, and open the console against it.

Until that exists the console renders a **fixture**, labelled `FIXTURE_NOTICE`
on screen. That label is deliberate — nothing pretends to be live data.

### What to check once it is real
- Holders, supply, roles, KYC and snapshots read correctly.
- Kill the RPC: **unavailable ≠ no holders**.
- The **HTS trap**: an HTS system contract answers an *unknown selector* with
  `success` and junk instead of reverting. A first implementation reported plain
  testnet USDC as a security with 64 snapshots. Point the console at a plain
  ERC-20 and confirm it says **not a security** rather than inventing one.

---

## 6. Order I would do this in

1. **Rebuild the companion** — everything else depends on it.
2. **Arc, all of section 3** — the only end-to-end flow, and your demo. Record it.
3. **Aqua read-only on Sepolia** — five minutes, confirms the portfolio reads.
4. **Deploy one Hedera equity** — the single step that turns the console from a
   fixture into a real thing.

Do not reflash the boards. Do not spend HBAR on anything before step 4.
