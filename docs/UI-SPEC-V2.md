# Companion UI — the shape the owner asked for

Supersedes the tab-bar shell in `docs/UI-REDESIGN-PLAN.md` §2b. What M1–M4 built
was a tab bar from launch; this is a **launcher**: a few large blocks, and
clicking one enters it.

Everything in `docs/UI-REDESIGN-PLAN.md` §1b (efficiency) and §4 (rules that
survive a redesign) still applies unchanged.

---

## Open question — resolve before building

The brief says **"only 4 blocks"** and then names **three**: Connect device,
Flash firmware, La Caja waiter mode. Build the three that were named. **Do not
invent a fourth.** If a fourth is wanted it will be said; a made-up block is
worse than a missing one, because it looks decided.

---

## 1. Launch — the pre-connect screen

Three blocks, large, nothing else. No tab bar, no empty panels, no greyed
controls.

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  Connect device      │  │  Flash firmware      │  │  La Caja — waiter    │
│                      │  │                      │  │                      │
│  USB or Bluetooth    │  │  Install or update   │  │  Take a payment.     │
│                      │  │  from a release      │  │  No wallet needed.   │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

Each is a **destination**, not a panel that is always open. Clicking enters it;
there is a way back.

None of the three needs a wallet, which is why they are the pre-connect set.
Membership is decided by `MiniApp.worksWithoutDevice` for apps, not by name.

### 1a. La Caja — waiter
Entering it shows the **scan button first**. A waiter's first action is to point
a camera at the cashier's screen; that is the primary control, not a text field
below other things. The paste field stays as the fallback (a request also
travels by message, and a camera can be refused or dark).

### 1b. Flash firmware
Entering it **lists the GitHub releases** — already built in M4. Each release
offers two choices, worded by consequence, not by filename:

- **Update firmware** — `-update.bin` at `0x10000`, keeps your wallet
- **Full flash** — `-provision.bin` at `0x0`, **erases every wallet**

The destructive one stays behind a deliberate second step. It is never the
default and never one click from arrival.

### 1c. Connect device
USB or Bluetooth. On success: handshake → compare the passkey → unlock on the
device → **the app moves to the wallet screen.** The transition is the signal
that it worked; the user should not have to find the next thing.

---

## 2. Connected — the wallet screen

### 2a. Balance, across every chain at once

The top of the screen is the account and its money, **large**, with **every
chain listed**, not just the selected one.

```
   Account 0
   0xbDEB…339f

   ┌───────────────────────────────────────────┐
   │  Sepolia            0.00838 ETH           │
   │  Base Sepolia       12.40 USDC            │
   │  Arc Testnet        unavailable           │
   │  Polygon Amoy       —                     │
   └───────────────────────────────────────────┘
```

Three states, and they must be distinguishable in text, not only in colour:

| | Meaning |
|---|---|
| a figure | read successfully, from a named operator |
| **unavailable** | the RPC did not answer — **never render this as 0** |
| — | nothing held, read successfully |

This is the existing *unavailable ≠ zero* rule at its most visible. A merchant
who reads `0` for a chain that is merely unreachable will conclude they were not
paid.

**Fetch cost is the risk here.** Balances across nine chains is nine round trips
before anything is on screen. Requirements:
- batch per chain through the existing `multicall.ts`;
- render each chain as it arrives — never block the screen on the slowest;
- a chain still in flight reads **"reading…"**, which is a fourth state and not
  the same as unavailable;
- pause refreshes when the window is hidden.

### 2b. Send
Recipient (`0x…` or scanned), token, chain, amount → review → sign on device.
**Reuse `tx-interpret.ts` and the ERC-7730 engine.** Do not write a second
preview: a second preview is a second thing that can disagree with the device,
and the device is the authority.

### 2c. Receive
Pick an account **from the list** — receiving into the wrong account is a real
mistake and the list is what prevents it. Then the QR and the address in full,
with its derivation path.

### 2d. The rest
Activity, Apps and WalletConnect remain reachable. Diagnostics stays collapsed
at the bottom — it has been load-bearing for every bug in this project.

---

## 3. What must not regress

Carried from `docs/UI-REDESIGN-PLAN.md` §4 and repeated because a launcher
rewrite is where they get lost:

1. The device is the authority; the preview says so.
2. **Unavailable ≠ zero**, now on the most-read screen in the app.
3. No mini-app gets a signer; `app/test/apps.test.ts` pins the contract.
4. The waiter terminal holds no key.
5. Raw units where decimals are unknown, with the reason shown.
6. Destructive actions are never the default.
7. Testnet labelled everywhere; mainnet louder.
8. **The shell never names an app by ID** — ask through `MiniApp`.

## 4. Efficiency, unchanged

Zero new runtime UI dependencies. ≤ 50 KB added. `transform`/`opacity` only,
≤ 200 ms. No `backdrop-filter`, no shimmer. **The target device is the Android
tablet.** A screen that lists nine chains must not be nine layout passes.
