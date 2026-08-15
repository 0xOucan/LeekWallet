# Accessibility — pre-delivery checklist (T31)

What was audited, what was measured, what passes, and what does not. The
subject is the companion app: `app/index.html`, `app/src/styles.css`,
`app/src/tokens.css`, `app/src/main.ts` and `app/src/wc/ui.ts`. The device's
own OLED is a separate problem and is not in scope here.

One thing shapes every decision below. **Confirming on the device is a security
step, not a convenience.** The app tells you to compare a passkey, to type a PIN
on the device, to read every page of a transaction before approving it. A user
who cannot tell that the device is waiting either misses the confirmation
entirely or walks over and presses the button without having been told what it
is for — and the second one is exactly the behaviour the confirmation exists to
prevent. So "the screen reader never announced it" is filed here as a security
defect, not as a papercut.

---

## 1. Screen reader

### The defect that mattered

Every "the device is waiting for you" line went to the device log and nowhere
else. The log is a scrolling box at the bottom of the page whose text node is
rewritten wholesale on every entry: a sighted user glances at it, and a screen
reader user has no reason to be sitting in it at the moment those lines arrive.
So the instructions to compare the passkey, to enter the PIN, and to check every
page of a transaction reached nobody who could not see the screen.

Fixed with a dedicated `role="alert"` region (`#announce`, `app/index.html`) fed
by `announce()` and `deviceAttention()` in `main.ts`. `deviceAttention()` logs
and announces **the same string**; the wording of the security-critical lines is
unchanged. Its callers are only the moments the hardware is waiting or has just
answered:

| Moment | What is announced |
|---|---|
| Handshake done | Compare the passkey `d i g i t s` with the device screen, then press ALLOW (announced only; the log keeps its own wording) |
| Handshake not confirmed | Not confirmed on the device. The connection attempt has ended. |
| Unlock | `enter your PIN on the device…` (verbatim, as logged) |
| Signing, both the send form and a dapp request | `check every page on the device, then approve` (verbatim) |
| Dapp message signing | `…: confirm the message on the device` (verbatim) |
| Device rejected / timed out | `rejected on the device` / `timed out waiting for an answer on the device` (verbatim) |
| A dapp proposal or request arrives unprompted | One sentence naming the dapp and the method |

The passkey is spoken digit by digit rather than as a six-digit number, because
"eight hundred and forty-two thousand" is not a string anyone can compare
against a device screen.

`announce()` clears the region before writing. Live regions announce on
*change*, and two identical instructions in a row — the same signing prompt for
a second transaction — are not a change, so without the clear the second one is
silent. That is the failure mode this whole section is about, repeated.

### Live regions, deliberately placed

- `role="status"` (polite) on: connection state and wallet state in the header,
  balance figure, transaction result, camera hints, copy status, WalletConnect
  status, the pending-request queue length.
- `aria-live="polite"` kept on: address hint, token error, max-amount note,
  amount conversion note, token discovery note.
- **Removed** from `#preview`: it redrew on every keystroke, so a screen reader
  re-read a whole transaction interpretation for every character typed into the
  amount field, which is how a user learns to mute the app. The warnings list
  inside it is live instead — that is the part that changes rarely and matters
  most.
- **Removed** from the WalletConnect request card, replaced by the one-sentence
  announcement above, for the same reason at larger scale.
- **Not** live: the device log. It is `role="log"` with a label, focusable so it
  can be read and scrolled, and it stays quiet because prepending into one text
  node makes every entry look like the entire history changing.

### Names and roles

- Panels are `<section aria-labelledby>` on their own headings, so the page is
  navigable by landmark and not only by tab.
- A visually hidden `<h1>LeekWallet companion</h1>` gives the page a top level;
  the panel headings below it are `h2`, and the Device panel's heading was
  demoted from `h1` to `h2` to make that outline real. That is a visible change
  — "Device" now sets at the same 16px as "Addresses" and "Device log" instead
  of 20px — and it is the right one: it was never a page title, only the first
  panel, and sizing it like one said otherwise.
- `#transport` lost `aria-label="Transport"`. It sits under a visible label
  reading "Link", and a control whose accessible name is not its visible name is
  a control voice-control users cannot address (WCAG 2.5.3).
- Buttons generated per row — "Send this token", "Stop watching", "Watch and
  send", "Remove", "End session" — carry an `aria-label` naming the contract
  address, network or dapp they act on. Read out of context, one of five
  identical "Remove" buttons is not a choice anyone can make.
- The backend badge now mirrors its `title` into `aria-label`. Whether the
  signature you are about to trust came from hardware or from the mock was
  reachable only by hovering a mouse.
- The QR toggle exposes `aria-expanded`/`aria-controls`; both camera toggles
  expose `aria-pressed`, because their labels never change and a running camera
  is not a state to leave unsaid.
- The status dot is `aria-hidden`: it is colour and nothing else, and the
  sentence beside it already says the same thing in words.
- The address QR already carried `role="img"` with the full address as its
  label. Left alone — it was right.
- Camera previews are `aria-hidden` and out of the tab order. A `<video>` of a
  camera has nothing to say to a screen reader and cannot be operated from a
  keyboard; the live hint beside it carries what matters.

## 2. Keyboard

- Every control is a real `<button>`, `<select>`, `<input>`, `<textarea>`,
  `<summary>` or `<a>`. There is no `div` with a click handler in the app, and
  no positive `tabindex` anywhere, so tab order is DOM order and DOM order is
  reading order.
- **There are no modal dialogs.** The WalletConnect proposal and request are
  cards in the flow, on purpose (`styles.css`, `.wc-card`) — so there is no
  focus trap to escape and no "dismiss the thing in the way" reflex being
  trained on a signing screen. Nothing here needs `inert`, an escape key
  handler, or focus restoration.
- One focus ring, defined once, on `a, button, select, input, textarea, summary,
  [tabindex]`. The old per-component rules missed the bare selects and inputs
  outside `.field`, the `<summary>` toggles, and the explorer link in the
  transaction result: tabbing through those showed nothing at all.
- The scanner is reachable and stoppable from the keyboard: "Scan QR" toggles,
  and "Stop camera" appears immediately after it in DOM order.
- The log is `tabindex="0"` so a keyboard user can scroll it, which a
  non-focusable overflow container does not allow.
- A skip link jumps past the sticky header to `#main`.
- **Bug found and fixed while doing this:** `[hidden]` was losing to class rules
  that set a `display`. The amount-unit selector (`.field`, `display: block`)
  and the address QR container (`.addr-qr`, `display: flex`) were on screen and
  in the tab order while the code that drew them believed they were hidden.
  `[hidden] { display: none !important; }` now settles it globally.

## 3. Contrast

Measured, not eyeballed: sRGB relative luminance per WCAG 2.1, computed from
the tokens in `app/src/tokens.css`. Both themes. Thresholds are 4.5:1 for body
text, 3:1 for large text and for the boundary of a user-interface component
(1.4.3 and 1.4.11).

### Light theme

| Foreground | on `--bg` #F4F5F2 | on `--surface` #FFFFFF |
|---|---|---|
| `--text` #1A1D1A | 15.54 | 17.01 |
| `--muted` #5E665F | 5.42 | 5.93 |
| `--accent` / `--ok` #3F6E31 | 5.50 | 6.02 |
| `--danger` #A33329 | 6.27 | 6.86 |
| `--warn` #8A6510 | 4.86 | 5.32 |
| `--border` #D8DCD6 | 1.27 | 1.39 |
| `--control-border` #7E867F **(new)** | 3.42 | 3.75 |

`--accent-fg` on `--accent` (the primary button's own text): **6.02**.

### Dark theme

| Foreground | on `--bg` #0F1210 | on `--surface` #171B18 |
|---|---|---|
| `--text` #E8EDE9 | 15.90 | 14.69 |
| `--muted` #909A91 | 6.48 | 5.98 |
| `--accent` / `--ok` #7ABF6A | 8.51 | 7.86 |
| `--danger` #E5796A | 6.53 | 6.03 |
| `--warn` #D9A441 | 8.38 | 7.74 |
| `--border` #2A302B | 1.40 | 1.29 |
| `--control-border` #6A716B **(new)** | 3.76 | 3.47 |

### What that says

- **All text passes 4.5:1 in both themes.** The tightest is `--warn` on `--bg`
  in light mode at **4.86:1** — a pass with about 8% of headroom, which is worth
  knowing before anyone darkens the page background.
- **The controls failed 1.4.11 and now pass.** A secondary button is
  `--surface` on a `--surface` panel; an input is `--bg` on `--surface`, and
  `--surface` against `--bg` is **1.09:1** (light) / **1.08:1** (dark). The
  border was therefore the only thing saying "this is a control" — and it was
  `--border` at **1.39:1**. Buttons, inputs, selects, textareas and the manual
  copy box now use `--control-border`, which clears 3:1 against both surfaces in
  both themes with the numbers above. `--border` stays where it belongs: panel
  edges, rules, separators.
- **The focus indicator passes.** `--accent` measures 6.02:1 (light, on surface)
  and 7.86:1 (dark, on bg) against what surrounds it, well past 3:1.
- **Placeholders are now themed.** They were the one piece of text in the app
  whose colour nobody had chosen; the UA default is tuned for a white field and
  these fields are `--bg`, which in dark mode is nearly black. They are
  `--muted` now — 5.42:1 and 6.48:1.
- **State colours are never the only channel.** The header dot is a colour, and
  the words beside it say the same thing. The mainnet warning is `--danger`
  *and* the word MAINNET. UNVERIFIED blocks are a warn-coloured dashed edge
  *and* the literal word, injected from CSS so it cannot be forgotten.

## 4. What does not pass, and why it is here anyway

- **Decorative borders stay at 1.3–1.4:1.** Panel edges, the dashed preview box,
  the badge chip, token row separators. These are not user-interface components
  and no information depends on seeing them — the preview's status is carried by
  the words "drawn by this app, not by the device", not by its dashes. Raising
  them would flatten the deliberate difference between "a thing you operate" and
  "a boundary". Recorded as a knowing choice rather than an oversight.
- **Disabled controls sit at `opacity: 0.5`** and are below every threshold.
  WCAG exempts inactive components (1.4.3, 1.4.11) and their state is exposed
  properly through `disabled`, so this is a pass by exemption, not by measurement.
- **No screen reader has actually run against this build.** Everything above is
  read from the markup and the computed colour values. NVDA + Firefox, VoiceOver
  + Safari, and TalkBack in the Android build each still need a pass, and the
  announcement flow — which is the security-relevant part — is what should be
  exercised first.
- **No automated check guards any of this.** `./scripts/check.sh` has no axe or
  markup-linting stage, so this document is the checklist and it is a manual one.
- **Reflow and zoom are unmeasured.** The layout is fluid and has phone rules,
  but 320 CSS px and 200% text zoom (1.4.4, 1.4.10) were not walked through.
- **Scanning a QR code needs sight.** A blind user cannot aim a camera at a
  dapp's screen. The whole flow works without it — the wc: link can be pasted
  and the recipient typed — and the panels say so where scanning is unavailable.
  Not solvable here; documented so it is not rediscovered as a bug.

## 5. The checklist itself

Before shipping a change to the companion UI:

1. Tab from the top of the page to the bottom. Every stop shows a visible ring;
   nothing is reachable that is meant to be hidden; nothing traps you.
2. Every new control has an accessible name, and it matches its visible label.
3. Any new "the device is waiting" message goes through `deviceAttention()`, not
   `log()`. This is the security-relevant rule in this document.
4. New live regions are `role="status"` unless the device is waiting, in which
   case they are the existing `#announce`. No live region wraps content that
   redraws as the user types.
5. New colours come from `tokens.css` and are measured, not chosen by eye:
   4.5:1 for text, 3:1 for the edge of anything you can operate. Control
   boundaries use `--control-border`, never `--border`.
6. Anything toggled with `hidden` is verified to actually disappear — it will,
   given the global rule, but a new `display` on a class is how that broke the
   first time.
7. Heading levels still form one outline: `h1` (hidden) → panel `h2` → `h3`
   inside a panel.
