# L6 — the home is one accordion, and the Back buttons go

## The gap this closes

L5 made the wallet menu the post-unlock home and gave it blocks: Send,
Receive, Activity, Apps, Connect a site. Each block was a *destination* — it
hid the home and showed one panel, with a Back button to return. The user
rejected that shape for the same reason the tab bar was rejected, and said
what they wanted instead:

> we tried to do screens per section, lets keep all but collapsable so no
> click and back buttons easy for navigation. send uncollapse then click in
> the send name and it collapses so i can go to receive apps or wallet
> connect. also let change the chain under the connection device part, so i
> dont need go to send for changing chains.

and gave the flow that the push/pop shape was actually costing them:

> when i try to participate in a strategy using the aqua app, after setting
> the prices, amounts etc, I have to go back to menu, then in connect app for
> signing the transactions. […] we could put notifications so users can know
> that in connect dapp/walletconnect menu there is a signature request.

So: no destinations, no Back. One screen, sections that fold.

## 1. What the home shows, in order

Above the accordion, unchanged: the Device panel (connect, unlock,
disconnect) — the accordion sits under it, which is what "under the
connection device part" means for the chain selector.

| # | Section | Body | Header line |
|---|---|---|---|
| 1 | Balances | `#walletmenu` | the unified total, live |
| 2 | Network | `#chainpanel` | the selected chain and whether it is a testnet |
| 3 | Receive | `#addrpanel` | Show an address to be paid into |
| 4 | Send | `#signpanel` | Scan a code or paste an address |
| 5 | Apps | `#waiterdest` | The mini-apps for this device |
| 6 | Connect a site | `#wcpanel` | WalletConnect pairing — plus the badge, §4 |
| 7 | Activity | `#activitypanel` | Not built yet |

**Unified balances.** One figure per asset, summed across every chain that
answered, with testnet and mainnet kept in separate lists because those two
numbers must never be added together. It is a sum of *units*, never a fiat
total: this app has no price source and an invented price is a worse lie than
an honest per-asset sum. Two figures are only added when they agree on symbol
*and* decimals; a symbol with different decimals on different chains is shown
as not summable rather than silently wrong. Anything still reading or errored
counts as missing and the note says so — docs/UI-L3-SPEC.md §3's rule that
unavailable must not read as zero applies to a total exactly as it does to a
row.

This build still fetches balances for `trackedChains()` only, which is the
testnets. The mainnet list therefore says "not fetched — this build tracks
testnets only" rather than showing a zero. Widening the fetch set is a
separate decision: it is sixteen more chains' worth of RPC disclosure per
refresh, and this pass is navigation.

**Network.** The chain `<select>`, the RPC first-choice `<select>`, the
`chainnote` and the "Add a network" disclosure, lifted wholesale out of the
Send panel. Send now *follows* the chain selection; it no longer *is* the
place that selection lives.

## 2. Single-open, and why

Only one section is expanded at a time. Opening one collapses the last;
clicking an open section's own header collapses it and leaves everything
closed.

The alternative — multi-open — was considered mainly for the signing flow: a
user in a mini-app who needs Connect a site could keep both on screen. It
was rejected because:

- The user described single-open in their own words ("click in the send name
  and it collapses so i can go to receive apps or wallet connect").
- It preserves L5's reading of docs/UI-L5-SPEC.md — only one section's
  content on screen — so the lock invariant and the visual rule stay the same
  shape rather than diverging.
- On a phone, two expanded sections push the second one below the fold, so
  "both visible" is not actually what multi-open buys.
- **Multi-open buys nothing for the signing flow anyway**, because collapse
  is not unmount — see §5.

## 3. The invariant (unchanged from docs/UI-L5-SPEC.md §3)

A locked or disconnected device must never leave a Send form or an address on
screen. L6 makes that *harder*, not easier, to get right: a collapsed section
is still in the DOM, and a row of headers left standing on lock is still the
wallet on screen.

`sectionHidden(shellOpen, open)` (app/src/nav.ts) is the rule, and it is pure
and DOM-free. While `shellOpen` is false every **wrapper**, every **header**
and every **body** is hidden, whichever section was expanded. `setShellVisible`
is called from exactly the places L5 called it: derivation success, unlock,
host-side passphrase apply, `invalidateDerived`, and disconnect.
`app/test/nav.test.ts` pins all of it without a browser, including the new
trap — that merely collapsing the bodies is not enough.

## 4. The signature badge

A pending WalletConnect proposal or request — including one a mini-app raised
through `walletConnect.review()`, which is how Aqua asks for a signature —
puts a badge on the **Connect a site** header: the word "Waiting for you", in
`--warn`, with `role="status"` so it is announced and not colour-only.

It is read off the DOM (`MutationObserver` on `#wcproposal` and `#wcrequest`'s
`hidden`) rather than pushed from `src/wc/ui.ts`, which owns those two cards
and toggles them as the queue moves. Same fact, one source of truth, no second
copy to drift. The badge clears when Connect a site is opened, and on lock.

## 5. Collapse keeps state — verified

`mountApps()` runs only from `remountApps()`, which is called on connect, on
address change, and on chain change. **No navigation path calls it.**
Collapsing a section only writes `[hidden]`; nothing is removed from the DOM,
no listener is dropped and no app is remounted. So a half-configured Aqua
strategy, a half-typed Send form and the WalletConnect queue all survive
opening another section and coming back.

The one thing that still wipes a mini-app's form is **changing the chain**,
because an app is per-chain and is remounted by design (src/apps/registry.ts).
That was true before L6 and is unchanged.

## 6. What was deleted

- The five `.walletmenu__blocks` tiles and their click handlers.
- `#sendback`, `#receiveback`, `#activityback`, `#wcback` and their handlers.
- `Dest`, `DEST_PANEL_IDS`, `destHidden`, `applyDestVisibility`,
  `goToWalletMenu`, `enterBlock`.
- The redundant `$("addrpanel").hidden = true` / `$("signpanel").hidden = true`
  pairs in `invalidateDerived` and `disconnect`, now that `setShellVisible`
  hides every section body itself.

`#waiterback` stays, and *only* for the pre-connect path (La Caja from the
launcher): `#waiterdest` doubles as the Apps body post-unlock, where the
header above it is the way out, so `applySectionVisibility` hides the Back
button whenever the shell is open. `#connectback` and `#flashback` stay:
the pre-connect launcher is untouched by this pass.

## 7. Style and accessibility

- Each header is a real `<button>` inside an `<h2>`, carrying `aria-expanded`
  and `aria-controls` — a tab stop that announces its own state. No `<div>`
  with a click handler, and nothing here removes a focus ring.
- 56px minimum header height, the whole row as the target, not the chevron.
- Only `transform` and `opacity` animate. Height is never animated: it cannot
  be animated from `auto` without measuring, and it reflows the page under the
  user's finger. `prefers-reduced-motion: reduce` removes even the 4px settle.
- Semantic tokens only (app/src/tokens.css); no raw hex in the component CSS.
- No fixed pixel widths; the header's description line wraps
  (`overflow-wrap: anywhere`) so a long chain name cannot scroll the page
  sideways on a phone.

## 8. Out of scope

The contents of every panel — Send, Receive, WalletConnect, the mini-apps.
L6 moved the chain/RPC/custom-network fields between panels and changed
nothing inside them.
