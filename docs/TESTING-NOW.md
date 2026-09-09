# What you can test right now

Written against `main` = `9ea8e4d`. Honest about what is verified, what is
untested, and what cannot work yet.

## Before anything

```bash
git pull
pnpm --dir app install
pnpm --dir app tauri dev        # ONE command — cargo run starts half the app
```

**Do not reflash the Pixie.** It is already on current firmware with both
wallets intact. **The ESP32-S3 has not been reflashed** — Aqua Q2 changed the
firmware, so if you want to test Aqua signing on the S3, flash
`-update.bin` at **`0x10000`** (never `0x0`).

Apps appear as **tabs**, and only for the chain they support. If an app is
missing, you are on the wrong chain — that is deliberate, not a bug.

| Chain | Apps you will see |
|---|---|
| Base Sepolia, Arc, OP/Arb/Unichain/Linea Sepolia, Amoy, Fuji | La Caja, La Caja — waiter |
| **Ethereum Sepolia** | La Caja, waiter, **Aqua** |
| **Hedera 296** | **Issuer console** |

---

## 1. La Caja — the cashier/waiter split  ✅ best demo

This is the newest work and the least tested by you. Two apps now.

### 1a. Cashier issues a bill
1. Chain → **Base Sepolia**. Open **La Caja**.
2. Enter a bill, pick 10% / 15% / custom.
3. **Check the headline says `Total to pay`** and carries the sub-cent marker
   (`5.6129`, not `5.61`). Only the exact figure settles — that was a real bug
   and this is the fix.
4. It produces a **request QR** for the waiter.

### 1b. Waiter shows it to the customer
5. Second device (or second window) → **La Caja — waiter**.
6. Scan the cashier's QR.
7. It shows **every accepted chain**, and the client-facing address QR.

### 1c. The property worth attacking
**Try to change the amount as the waiter.** You should find no way to — there is
one input and it takes a request, never a number. If you find a way to alter the
amount or the recipient, that is a genuine bug and I want to hear about it.

### 1d. Pay it
8. Scan with Rabby, send the exact amount.
9. Watcher confirms in seconds; eight other chains report *checked and nothing
   arrived*, each naming its block range.

### 1e. The test nobody has run yet
**Kill your network mid-watch.** A chain that cannot be reached must read
**unknown**, never **unpaid**. This is still unverified against a real outage,
and it is the failure that could make a customer pay twice.

---

## 2. Aqua — now with signing  ⚠️ untested on hardware

Chain → **Ethereum Sepolia** (Aqua is deployed there; it is *not* on Base
Sepolia or Amoy). You need Sepolia ETH and a test ERC-20.

- **Q1** portfolio: an address with no positions must show an **empty state**;
  kill the RPC and it must say **unavailable**, never `0`.
- **Q2** deploy: `approve` (capped, never unlimited) then `ship()`, both
  rendered on the device.

**Nobody has ever pressed a button for this.** Q2 was verified against an
`anvil` fork, not hardware. Specifically unknown: whether the maker address is
legible on the 128×64 panel, and whether a 640-byte `signTransaction` survives a
real BLE round-trip. **You would be the first.** If the device shows nothing or
the frame fails, that is expected-unknown, not a surprise.

Try the refusals: an unlimited approval must be refused, and a strategy naming
another address must refuse outright.

---

## 3. Issuer console — fixture, plus new action screens  ⚠️

Chain → **Hedera 296**.

- **Load fixture** → the full register. Every figure carries *"no figure on this
  screen came from Hedera."* This is your Hedera demo today.
- **Read register** with a non-ATS address → should now say **once**, at the
  top, that the address does not answer like an ATS security. It used to print
  40 identical rows.
- **Privileged actions** (grantRole, pause, revokeKyc, freeze, mint…) now build
  proposals with consequence text — *"can issue new shares to any address,
  diluting every holder"*.

**Nothing here has touched a chain.** No HBAR, so no security was deployed and
nothing was signed or seen on HashScan. To make it real: deploy one equity via
the pre-deployed factory `0.0.9213391` (EVM `0x…008c95cf`) on chain 296, then
paste that address into **Read register**.

---

## What I would do, in order

1. **La Caja cashier → waiter → pay with Rabby.** Record it. This is the
   submittable Arc demo and the split is new.
2. **Kill the network mid-watch.** Five minutes, closes the one untested
   failure that could cost a customer money.
3. **Aqua on Sepolia with the device.** First hardware press for Q2 — expect
   surprises, that is the point.
4. **Deploy one Hedera equity** to un-fixture the console.

## Do not expect to work

- Chrome extension — offscreen document never answers.
- Android USB — fix applied, **never tested**. BLE works.
- Windows/macOS companions — build, never run.
- Aqua SwapVM decoding (Q3/B3) — **built, never run against a chain.** The
  host decoder, the firmware walker and the refusal screen all exist, and the
  shared calldata vectors prove both decoders refuse the same programs (35
  vectors, 18 refusals, five of them SwapVM programs). What has not happened is
  a real `ship` to a real router: the mainnet-fork worry was misplaced —
  redeploying SwapVM is explicitly allowed, so the Sepolia path in
  `swap-vm/DEPLOY.md` is the way to exercise it. Until then the evidence is
  fixtures, not transactions.
