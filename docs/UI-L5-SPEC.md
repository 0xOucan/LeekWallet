> **Superseded for navigation by docs/UI-L6-SPEC.md.** L5's destinations and
> their Back buttons are gone: the home is one accordion of collapsible
> sections. **§3 of this document is still binding** — it is the safety
> invariant, and L6 carries it forward verbatim and strengthens its test.

# L5 — the wallet menu is the home, and the tab bar goes

## The gap this closes

L3 put the account and the all-chain balances on `#walletmenu`. But
`setShellVisible(true)` still reveals **both** the wallet menu **and the tab
bar**, and the tab bar is still the only way to reach Send and Receive.

The user rejected the tab bar explicitly — *"I just checked and i didnt like
it"* — and restated the brief twice:

> launch app, then we can see only 4 blocks connect device, flash firmware, la
> caja waiter mode … on connect+handshake+unlock → wallet menu with account and
> all-chain balances in big, send block with QR code reader, receive with
> account list + QR + address … app mobile/menu minimalistic style.

So Send and Receive were supposed to be **blocks on the wallet menu**, entered
the way the launcher's tiles are entered. The panels themselves are already
built and good (an audit confirmed the Send panel, its QR scanner, EIP-681
parsing and its refusal test are all complete and tested). **Nothing in this
milestone rewrites a panel.** L5 is navigation only: the wallet menu becomes the
post-unlock home, and the tab bar is deleted.

## 1. What the wallet menu shows, in order

1. **The account line and its address** — `#wmaccount`, `#wmaddress`. Unchanged.
2. **Balances across every chain, big** — `#wmchains`. Unchanged, including the
   four states from `docs/UI-L3-SPEC.md` §3 and the `#wmnote` disclaimer that the
   device neither reports nor confirms them.
3. **The blocks.** New. Same visual language as `.launcher__tile` — reuse that
   CSS, do not invent a second tile style:

   | Block | Destination panel | Description line |
   |---|---|---|
   | Send | `signpanel` | Scan a code or paste an address |
   | Receive | `addrpanel` | Show an address to be paid into |
   | Activity | `activitypanel` | *(only if it is not a placeholder — see §5)* |
   | Apps | `apps` | The mini-apps for this device |
   | Connect a site | `wcpanel` | WalletConnect pairing |

4. **Refresh** — `#wmrefresh`. Keep it, but it belongs with the balances, not
   below the blocks.

## 2. Navigation

There is already a state machine for exactly this shape: `preConnectDest`,
`applyPreConnectVisibility()`, `enterDest()`, `goToLauncher()` and the
`backingOut` flag (L1). **Extend that pattern; do not write a second one.**

- Post-unlock the home is `#walletmenu`. Entering a block hides the wallet menu
  and shows that one panel.
- **Every destination has a Back** that returns to the wallet menu, matching the
  launcher's Back exactly in placement and wording.
- Only one destination is on screen at a time.
- `selectTab()`/`applyTabVisibility()` are replaced by this. If any of their
  behaviour is load-bearing beyond "toggle `[hidden]` on whole panels", carry it
  over deliberately and say which.
- Delete `#tabbar` from `index.html` and every code path that only served it,
  including `activeTab` if nothing else reads it. Leaving a hidden tab bar in
  the DOM is not "done" — it is the thing that was rejected, merely invisible.

## 3. What must not regress

`setShellVisible(false)` currently force-hides every tab-owned panel on lock,
disconnect and `invalidateDerived`. **That is a safety behaviour, not a tab-bar
detail**: a locked device must not leave a Send form or an address on screen.
Whatever replaces it must still shut every destination and return to the wallet
menu on lock, disconnect, wallet change, passphrase apply, and
`invalidateDerived`.

Also preserve:

- `#waiterdest`'s two entry points (launcher pre-connect, and Apps once
  connected). Its outer gate must keep widening/narrowing without overriding
  `#apps`'s own decision.
- The wallet-menu fetch moment: entering it refreshes balances
  (`docs/UI-L3-SPEC.md` §5). Entering it *by backing out of a destination* is
  the same moment and should refresh the same way — but still **no polling and
  nothing while the window is hidden**.

## 4. Style

`docs/UI-SPEC-V2.md` §2e: mobile-menu minimal. Efficiency over aesthetics —
reuse `.launcher__tile`, add no animation, add no runtime dependency. The
account and balances stay the headline; the blocks sit quietly under them.

## 5. Judgement calls left to the implementer

- **Activity is a placeholder.** A block leading to an empty panel is worse than
  no block. Either omit it, or have it say plainly that it is not built yet.
  State which you chose and why.
- If a destination is meaningless while something is missing (e.g. Connect a
  site with no chain selected), prefer disabling the block with a reason over
  hiding it silently.

## 6. Out of scope

- The contents of `signpanel`, `addrpanel`, `wcpanel`, `apps` — all already
  built. Do not redesign them.
- The cascading account→chain header selector. Separate pass.
- Any firmware change.

## 7. Done means

`pnpm --dir app typecheck`, `pnpm --dir app test`, `pnpm --dir app build` all
green; bundle growth under 20 KB (this is navigation, and it deletes a tab bar,
so it may well shrink); `grep -n "tabbar" app/index.html app/src/*.ts` returns
nothing; and a test pinning that lock/disconnect returns to the wallet menu with
every destination shut.
