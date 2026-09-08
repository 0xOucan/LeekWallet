# Companion UI redesign — execution plan

A Rabby-class interface for the LeekWallet companion, across desktop
(Linux/Windows/macOS), Android, and the Chrome extension.

Written to be executed by a subagent working milestone by milestone, then
audited on hardware. **Every milestone is independently shippable and
independently revertible.**

---

## 0. Read this first — one requirement cannot be built as stated

The brief asks for *"transactions: last 10 txs per chain via RPC, load more on
scroll."* **A standard Ethereum RPC cannot answer that.** Verified, not assumed:

```
eth_getTransactionsByAddress  →  "the method does not exist/is not available"
eth_getLogs without an address →  "Please specify an address in your request"
```

There is no RPC method that lists an address's transactions. Rabby appears to do
it because Rabby runs its own indexing backend. We have no backend and adding
one would mean every user's addresses flow to a server we operate — the opposite
of this project.

**What is actually knowable, and the design follows from it:**

| Source | Covers | Cost |
|---|---|---|
| **Local record** of what this wallet signed | every send made here, all chains | free, exact |
| `eth_getLogs` **per watched token** | ERC-20 in/out for tokens the user watches | one call per token per chain |
| An explorer API (Etherscan/Blockscout) | everything | **discloses the address to a third party** |

So the Activity panel shows **local history first**, augmented by per-token log
queries, and names the gap in plain words rather than implying completeness:

> *Shows transactions signed on this wallet, and transfers of tokens you watch.
> A transfer you received in a token you do not watch is not listed. No RPC can
> list an address's history; only an indexer can, and using one would tell it
> which addresses are yours.*

An explorer API may be offered **opt-in, per chain, off by default**, with the
disclosure above the switch. That is a milestone of its own (M9) and is optional.

This is not a limitation to hide. "We show what we can prove and say what we
cannot" is the same discipline as *unavailable ≠ zero* everywhere else.

---

## 1. Design system — use the skill, then commit the result

Install and run `ui-ux-pro-max` (github.com/nextlevelbuilder/ui-ux-pro-max-skill)
for **fintech / crypto wallet**. It produces a style, palette, typography
pairing and reasoning rules.

**Constraints the skill's output must respect — these are not negotiable and
override any generated palette:**

1. `app/src/tokens.css` already carries **measured** contrast values with the
   reasoning in comments, e.g. `--control-border` at 3.75:1 because WCAG 1.4.11
   asks 3:1 of a control's boundary. Any new palette must be **re-measured and
   the measurements written into the comments**. Do not inherit a number.
2. `docs/ACCESSIBILITY.md` and `docs/DESIGN.md` are the standing contract. Read
   both before changing a token. If the skill's advice conflicts, the repo's
   measured accessibility wins and the conflict is recorded.
3. No colour-only meaning. A "danger" action must read as dangerous in
   monochrome — this app refuses transactions for a living.
4. Reduced-motion honoured; visible keyboard focus everywhere; 375px–1440px.

**Deliverable:** `docs/DESIGN.md` updated with the chosen system and the
measurements, `tokens.css` regenerated, everything else unchanged. One commit.

---

## 2. Information architecture

### 2a. Before a device is connected

The app opens on three things and nothing else. **None of them needs a wallet**,
which is exactly why they are the pre-connection surface:

| Panel | Why it belongs here |
|---|---|
| **Connect** | the primary action; USB and BLE, with the real failure messages |
| **La Caja — waiter** | holds no key by design; a waiter never connects a device |
| **Flash firmware** | you flash a board *before* it is a wallet |

Everything else is hidden — not disabled. A greyed-out Send with no device is
noise.

**Flash firmware lists real releases.** Fetch
`https://api.github.com/repos/0xOucan/LeekWallet/releases`, show tag, date,
board, and the two image kinds with their consequences:

- `-update.bin` → `0x10000` — *keeps your wallet*
- `-provision.bin` → `0x0` — **erases every wallet**

Same rule as the website's flasher: **the destructive one is never the default
and never one click away.** Verify the SHA-256 against `SHA256SUMS` before
writing. If the API is unreachable, say so — do not show an empty list that
reads as "no releases exist".

### 2b. After connect

A persistent **header**: account selector → chain selector, cascading. Below it,
tabs:

```
┌─────────────────────────────────────────────────┐
│  ◆ LeekWallet    [Account 0 ▾] [Sepolia ▾]  ⏻  │
├─────────────────────────────────────────────────┤
│  Send   Receive   Activity   Apps   Connect     │
├─────────────────────────────────────────────────┤
│                                                 │
│                  (panel)                        │
│                                                 │
├─────────────────────────────────────────────────┤
│  ▸ Diagnostics                        collapsed │
└─────────────────────────────────────────────────┘
```

- **Send** — recipient (0x or scanned), token, chain, amount, review, sign.
- **Receive** — address, QR, copy, and the derivation path.
- **Activity** — see §0. Local first, honest about the gap.
- **Apps** — the existing mini-app tabs (Aqua, ATS, La Caja).
- **Connect** — WalletConnect pairing and connected dapps.
- **Diagnostics** — collapsed at the bottom; the device log and `Copy
  diagnostics`. It has been load-bearing for every bug in this project and must
  stay one click away, not be removed for tidiness.

---

## 3. Milestones

Each ends green on `pnpm --dir app typecheck`, `pnpm --dir app test`, and
`./scripts/check.sh`. Each is one or a few commits. **Do not start the next
until the previous is green.**

| # | Milestone | Deliverable |
|---|---|---|
| **M1** | Design system | skill run, `tokens.css` re-measured, `docs/DESIGN.md` updated. No layout change yet. |
| **M2** | Shell & routing | header, tab bar, panel container, collapsed diagnostics. Panels move, none change internally. |
| **M3** | Pre-connect state | only Connect + waiter + Flash visible with no device; the rest appear on connect. |
| **M4** | Releases in the flasher | GitHub API, tags, both image kinds with consequences, SHA-256 check, offline state. |
| **M5** | Send | recipient/token/chain/amount → existing review + sign path. **Reuse `tx-interpret.ts` and the ERC-7730 engine; do not write a second preview.** |
| **M6** | Receive | address, QR, path, copy. |
| **M7** | Activity | local history store + per-watched-token logs, infinite scroll, the honesty notice from §0. |
| **M8** | Responsive | 375px–1440px, Android tablet and phone, keyboard nav, reduced motion. |
| **M9** *(optional)* | Explorer API | opt-in per chain, off by default, disclosure above the switch. |

---

## 4. Rules that survive the redesign

These are not style preferences. Breaking one is a regression even if it looks
better.

1. **The device is the authority.** Every screen that shows a transaction says
   the preview is drawn by the app and the device is what counts. That sentence
   does not get shortened for layout.
2. **Unavailable ≠ zero, everywhere.** A balance, a position, a chain, a holder
   list. An unreachable RPC never renders as `0` or as "none".
3. **No mini-app gets a signer.** `app/test/apps.test.ts` pins `AppContext`'s
   fields and fails on any new one. If the redesign needs a new capability,
   that test forces the judgement — record it, do not widen the list quietly.
4. **The terminal holds no key.** `test/no-signing.test.ts` must keep passing.
5. **Raw units where decimals are unknown**, with the reason shown. The device
   cannot call `decimals()` (`src/ui.c:4834`).
6. **Destructive actions are never the default.** Provision, wipe, unlimited
   approval.
7. **Testnet is labelled everywhere**, and mainnet says so louder.

---

## 5. Platform notes

- **Desktop** — Tauri. `pnpm --dir app tauri dev` is one command; `cargo run`
  starts half the app and is for Rust-side iteration only.
- **Android** — after **every** `tauri android init`, run
  `./scripts/android-usb-host.sh`. `gen/` is gitignored; the camera permission
  was lost this way once and USB twice. The APK does **not** update on
  `git pull` — rebuild and reinstall.
- **Chrome extension** — currently broken at the offscreen document. The
  redesign should share tokens and components with the desktop shell but **must
  not** be blocked on that bug; fixing it is separate work.

---

## 6. How this gets executed and audited

**Execution:** a subagent runs M1→M8 in order, one milestone per message, with
its own tests green before moving on.

**Audit (Opus, after each of M2, M5, M7):** read the diff, check the seven rules
above, run `check.sh`, and verify on hardware where the milestone touches
signing.

**Hardware testing, in this order:**
1. Desktop Linux — fastest loop.
2. **Firefly Pixie** over BLE and USB — it holds two wallets; flash
   `-update.bin` at `0x10000` only.
3. **ESP32-S3** — has not been reflashed since Aqua Q2 changed the firmware.
4. **Android tablet** — rebuild, reinstall, then USB to the Pixie, which has
   never been exercised with the fix in place.

**Release:** only after all four pass. `./scripts/release.sh <tag> esp32s3` and
`pixie`, sign `SHA256SUMS` with `2E7D83AF39ACD8A9493A2372E5D8C3021D03039E`,
publish, then `node tools/add-release.mjs` in the website repo.
