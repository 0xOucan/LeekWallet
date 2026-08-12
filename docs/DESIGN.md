# LeekWallet Companion — Design System

One visual language for the Tauri desktop app (Linux/macOS/Windows) and the Tauri Android app.
Minimal, retro-leaning, no pixel art.

The organizing idea: **the app is a window onto a monochrome device.** The wallet itself is a
128x64 OLED with four buttons and no colour. Rather than fight that, the companion echoes it —
mono-forward type, hairline borders, flat surfaces, one accent colour, generous negative space.
Retro comes from restraint and typography, not from CRT filters or 8-bit sprites.

Checklist rules below marked ✅ are enforced pre-delivery, adapted from
[ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill).

---

## Tokens

Define once as CSS custom properties. Never hardcode a colour in a component.

```css
:root {
  /* Light */
  --bg:        #F4F5F2;
  --surface:   #FFFFFF;
  --border:    #D8DCD6;
  --text:      #1A1D1A;
  --muted:     #5E665F;
  --accent:    #3F6E31;   /* leek green — 6.9:1 on --bg */
  --accent-fg: #FFFFFF;
  --danger:    #A33329;
  --warn:      #8A6510;
  --ok:        #3F6E31;
}

:root[data-theme="dark"], :root:not([data-theme="light"]) {
  @media (prefers-color-scheme: dark) {
    --bg:        #0F1210;
    --surface:   #171B18;
    --border:    #2A302B;
    --text:      #E8EDE9;
    --muted:     #909A91;
    --accent:    #7ABF6A;   /* 9.2:1 on --bg */
    --accent-fg: #0F1210;
    --danger:    #E5796A;
    --warn:      #D9A441;
    --ok:        #7ABF6A;
  }
}
```

Every pair above clears **4.5:1** ✅. Verify with a contrast checker after any palette edit —
the accent is the one most likely to drift under it.

### Spacing

4px base. Use only these: `4, 8, 12, 16, 24, 32, 48, 64`. No arbitrary values.

### Radius and elevation

- Radius `2px` on everything. Squarer reads retro; fully square reads unfinished.
- **No drop shadows.** Separation comes from `1px solid var(--border)`. Flat is the whole point.
- Exactly one exception: modals may use a full-screen scrim at `rgba(0,0,0,0.5)`.

### Typography

Two families, both open source, both with a slight terminal heritage:

| Role | Family | Use |
|---|---|---|
| UI | IBM Plex Sans | Labels, buttons, prose |
| Data | IBM Plex Mono | Addresses, hashes, amounts, chain IDs, **anything the user must verify** |

Monospace for verifiable data is a security property, not a style choice — proportional fonts
make `l`/`1` and `0`/`O` ambiguous in an address.

| Token | Size / line-height | Weight |
|---|---|---|
| `--text-xs` | 12 / 16 | 400 |
| `--text-sm` | 14 / 20 | 400 |
| `--text-base` | 16 / 24 | 400 |
| `--text-lg` | 20 / 28 | 500 |
| `--text-xl` | 28 / 36 | 500 |

Never go below 12px. Nothing above 28px — this is a utility, not a landing page.

### Motion

150-200ms, `ease-out`. Only opacity and transform. ✅ Wrap everything in:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

### Icons

**SVG only — [Lucide](https://lucide.dev). No emoji as icons.** ✅ 20px in UI, 16px inline,
`stroke-width: 1.5`, `currentColor`. Emoji are fine in prose, never as interface elements.

---

## Component rules

**Buttons.** Three variants only: primary (accent fill), secondary (border, transparent fill),
ghost (text only). Height 36px, padding `0 16px`. Destructive actions use `--danger` and always
require a confirm step. ✅ `cursor: pointer` on every clickable element. ✅ Visible focus ring:
`outline: 2px solid var(--accent); outline-offset: 2px` — never `outline: none` without a
replacement.

**Address display.** Always mono, always EIP-55 checksummed casing, always chunked in 4s:

```
0x71C7 656E EC7A B88B 098D EFB7 51B7 401B 5F6D 8976
```

Never truncate an address the user is meant to verify. Truncation (`0x71C7…8976`) is allowed
only in lists where a full copy is one click away.

**Device status.** Persistent, always visible: connection state and which wallet is selected.
Transport is implied by platform — BLE on Android, cable on desktop — so do not make the user
choose one. Name it only in error copy, where "turn on Bluetooth" and "check the cable" are
different instructions. A hardware wallet app where you can't see connection state at a glance
is a hardware wallet app people mis-click in.

**Passphrase field.** When the app is used as a keyboard for the passphrase
([PROTOCOL.md §5](PROTOCOL.md)), that input must use an in-app keyboard, never the system IME,
with autocorrect, clipboard and screenshots disabled. On Android a system keyboard may sync
typed text to the cloud. Pair it with the device-side fingerprint confirmation, and state
plainly in the UI that host entry is weaker than typing on the device.

**Transaction review.** The desktop screen is a *convenience preview*, never the source of
truth. It must say so. The signing decision happens on the device's OLED — the app should show
the same fields, in the same order, so the user can compare them, and visually mark that the
device is what counts.

**Empty and error states.** Every list and async view needs: empty, loading, error, and
"device disconnected". Four states, written before the happy path is styled.

---

## Responsive

✅ Breakpoints `375 / 768 / 1024 / 1440`.

- **375-767** (Android): single column, 16px gutters, 44px minimum touch targets, primary
  action fixed to the bottom within thumb reach.
- **768-1023**: single column, centred, `max-width: 640px`.
- **1024+** (desktop): two panes — persistent left nav (200px) + content, `max-width: 960px`.

One component tree, two shells. If a component needs to know whether it is on Android, that is
a design smell — it should be reacting to width, not platform. The one legitimate exception is
connection *error* copy, since a failed BLE scan and an unplugged cable need different advice.

---

## Anti-patterns

Explicitly out of scope for this project:

- Pixel-art fonts, scanline overlays, CRT curvature, terminal-green-on-black as the *whole*
  palette. The retro reference is restraint, not nostalgia cosplay.
- AI-purple gradients, glassmorphism, neumorphism.
- Animated splash screens, celebratory confetti on send.
- Emoji as status indicators.
- Any layout where price data or branding is more prominent than the address being verified.

---

## Pre-delivery checklist

- [ ] All colours from tokens; none hardcoded
- [ ] Text contrast ≥ 4.5:1, both themes
- [ ] `cursor: pointer` on all clickables
- [ ] Visible focus states, full keyboard traversal
- [ ] Hover transitions 150-300ms
- [ ] `prefers-reduced-motion` respected
- [ ] `prefers-color-scheme` respected, plus a manual override
- [ ] Renders at 375 / 768 / 1024 / 1440
- [ ] SVG icons only
- [ ] Every async view has empty / loading / error / disconnected states
- [ ] Addresses mono, checksummed, chunked
- [ ] Every destructive action confirmed
