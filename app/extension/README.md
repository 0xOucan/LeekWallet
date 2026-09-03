# LeekWallet browser extension

The LeekWallet companion, as a Chromium MV3 extension. It announces an
EIP-1193 provider over EIP-6963, talks to the device over Web Serial, and holds
no keys.

It is the same protocol as the desktop and Android apps, over a different wire.
`app/packages/core` is imported unchanged — CBOR, framing, the X25519
handshake, the session, the EIP-712 transcription, the chain registry, the RPC
failover. The extension adds one file of real substance,
`src/serial-transport.ts`, which is 180 lines and implements a two-method
interface.

## What it can and cannot do

**It needs desktop Chromium.** Web Serial is a Chromium API. Mozilla has
recorded its position on it as *harmful* and WebKit's is *opposed*; neither has
shipped it, and neither has said they intend to. Chrome for Android supports no
extensions at all, and Chrome for iOS is Safari's engine in a Chrome coat. So
this runs on desktop Chrome, Edge, Brave, Opera, Vivaldi and Arc, on Windows,
macOS, Linux and ChromeOS, and nowhere else.

The extension says so rather than showing a Connect button that opens nothing.
`src/env.ts` produces the sentence, and the popup renders it in place of the
controls. Firefox and Safari users are pointed at the desktop app, which reaches
the same device over the same protocol without needing a browser API.

**It is not a key holder.** Every private key stays on the device. Every
signature is produced there. Every confirmation is drawn there, from the
device's own decode of the transaction bytes — not from anything this extension
tells it they mean. If the device refuses, the request fails; there is no path
through this code that can talk it round.

**There is no browser-drawn signing confirmation, on purpose.** The only
approval dialog in the extension is "this site would like to see your
addresses". A second, browser-drawn "confirm this transaction" screen is drawn
by software that an attacker who owns the host also owns, and a wallet that
trains people to read it has taught them to read the wrong screen. When a
signature is in flight the popup says one thing: *check the device*.

**It does not implement `wallet_addEthereumChain`.** A chain added by a website
is a set of RPC endpoints chosen by that website, and an endpoint that lies
about nonce, gas price and balance is enough to get an honest user to sign a bad
transaction. The curated registry in `packages/core/src/chains.ts` is the
answer, and adding to it is a code change somebody reviews.
`wallet_switchEthereumChain` returns `4902` for anything not in it.

**It does not sign contract creations.** The device has no screen for "this
deploys code you cannot read", and signing what it cannot describe is precisely
what a hardware wallet exists to prevent.

## Methods

| Method | Behaviour |
| --- | --- |
| `eth_accounts` | Addresses this origin was granted. Never prompts. `[]` if none. |
| `eth_requestAccounts` | Derives ten addresses on the device, then opens the approval window. |
| `eth_chainId` | The active chain, as hex. One chain for the whole extension. |
| `wallet_switchEthereumChain` | Switches within the curated registry; `4902` otherwise. Notifies every connected origin. |
| `personal_sign` | The device renders the message and signs its own EIP-191 digest. |
| `eth_signTypedData_v4` | Transcribed by `core/eip712.ts`; refused if it cannot be transcribed faithfully. The domain's `chainId` must match the active chain. |
| `eth_sendTransaction` | Nonce, gas and fees filled from the chain's public RPC when absent; signed on the device; broadcast; returns the hash. EIP-1559 only. |

Sixteen read-only methods (`eth_call`, `eth_getBalance`, `eth_getLogs`, …) are
proxied to the active chain's public endpoints, because a provider whose reads
fail looks broken rather than unsupported. The list is an allowlist rather than
a passthrough: every proxied call tells a public node operator something about
what this browser is looking at, and a short auditable list is the way to keep
that honest. `eth_sendRawTransaction` is deliberately absent — a raw transaction
this extension never saw signed is not something it should relay.

Anything else returns `4200`.

## Architecture, and the MV3 offscreen decision

```
  page (MAIN world)          window.postMessage        src/inpage.ts
        │                                              EIP-1193 + EIP-6963
        ▼
  content script (ISOLATED)  chrome.runtime            src/content.ts
        │                                              relay; adds no identity
        ▼
  service worker             chrome.runtime            src/background.ts
        │                                              origin ledger, routing
        ▼
  offscreen document         navigator.serial          src/offscreen.ts
        │                                              owns the port + session
        ▼
  LeekWallet device
```

Four processes, and the fourth is the interesting one.

**An MV3 service worker cannot hold the serial port.** Two independent reasons,
either of which is sufficient:

1. `navigator.serial` is exposed to documents. A service worker does not have
   it at all.
2. Chrome terminates an idle service worker after about thirty seconds, and the
   termination is not cooperative. A LeekWallet session is a pair of nonce
   counters that mean something only while both ends agree; a worker evicted
   between two frames would leave the device holding a session the browser has
   forgotten, and every later request would fail to decrypt with nothing on
   either screen to explain it. Signing takes as long as a human takes to read
   four pages on a small OLED and press a button — routinely longer than the
   worker is allowed to live.

So the port lives in an **offscreen document**: a hidden, real DOM document with
the extension's origin, created by the worker and outliving it. It has
`navigator.serial`; it has `localStorage`, which `core/rpc.ts` uses to remember
which endpoint answered; and it stays put while the worker comes and goes. The
worker treats it as a server it sends commands to. A worker evicted mid-request
now costs one request, not the session.

One wrinkle worth stating plainly: **the popup still has to ask for the port.**
`navigator.serial.requestPort()` shows a chooser and therefore needs user
activation, which a hidden document by definition does not have. But a granted
port is remembered against the extension's *origin*, not the page that asked —
so the popup asks once, with a real click behind it, and from then on
`getPorts()` in the offscreen document returns it, across browser restarts. The
human authorises; the background holds.

A second wrinkle, stated because it is a genuine weak point: Chrome's
enumerated `chrome.offscreen` reasons do not include "hold a device handle". The
API was designed around DOM access. `WORKERS` is the closest honest description
— a long-lived background task the worker cannot host — and the `justification`
string in `background.ts` is written for a human reviewer. If Chrome tightens
what it accepts there, that is the line that will need to change.

### Why EIP-6963 and not `window.ethereum`

`window.ethereum` is one slot and every wallet wants it. Whoever writes last
wins, which made "install two wallets" a coin toss and pushed extensions into
defining the property non-configurably so nobody could overwrite them — a race
whose prize is breaking the user's other wallet. EIP-6963 ends it: the page
fires `eip6963:requestProvider`, every wallet answers, and the *user* picks in
the dapp's own dialog.

So the default is to announce and leave the global alone. A wallet that breaks
MetaMask by existing gets uninstalled before anyone finds out whether it was any
good.

There is an opt-in checkbox to also claim `window.ethereum`, for older dapps
with no wallet chooser. Off by default; and when on, the property is defined
*writable and configurable*, taking the slot without welding it shut. It also
cannot take the slot synchronously — the MAIN world has no `chrome.storage`, so
the setting arrives a millisecond or two after the injected script runs — which
is a second, independent reason it is not the default. The popup says so next to
the checkbox.

The injected script is a `MAIN`-world content script at `document_start` rather
than a `<script>` tag injected from the isolated world. A tag is a frame later
and, on a page with a strict `script-src`, is simply blocked — the provider then
silently never appears, which is the worst failure a wallet has, because the
page looks normal and the wallet is just not there.

### The origin check

Exactly one security decision is made in the browser: which origins may see
which addresses. It is made against `sender.origin` — the origin Chrome asserts
about the sending frame — and never against anything a page said about itself.
The content script rebuilds each request from four fields precisely so that a
page cannot decorate a message with an origin claim, and no such field exists on
the wire.

Events are filtered the same way. `chrome.tabs.sendMessage` addresses a *tab*,
and a tab's frames can be anybody; so an event carries the list of origins it
was meant for, and each content script checks that list against its own
`location.origin` before relaying it. Filtering by the tab's URL alone would
hand `accountsChanged` to every embedded third-party iframe on the page.

### Known limitations

- **An evicted worker cancels a pending connection approval.** The in-flight
  `eth_requestAccounts` lives in the worker's memory. Persisting a half-answered
  approval across a restart would mean a click in the popup could resolve a
  request whose page navigated away minutes ago, which is worse. The cost is one
  rejected `eth_requestAccounts`, which every connect button already handles.
- **One active chain for the whole browser**, not one per site. A switch driven
  by one tab is announced to every connected origin.
- **One connection approval at a time.** A second site asking while one is on
  screen is rejected rather than queued: a stack of approval dialogs is the
  shape of UI where somebody clicks through the one they meant to read.
- **Derived addresses are never persisted.** A passphrase wallet leaves no trace
  on the device by design, and writing its addresses into extension storage
  would undo exactly that. They are dropped whenever the device locks, switches
  wallet, changes passphrase or changes account.

## Building

From `app/`:

```sh
pnpm install
pnpm --filter @leekwallet/extension build
```

Output lands in `app/extension/dist/`. It is not checked in: a committed build
is one nobody can tell apart from the source it claims to be, and for a wallet
that is the artefact people most need to be able to check.

The build is deliberately **unminified**, with source maps. A reviewer — and the
Chrome Web Store's reviewers — has to be able to read what a wallet ships, and
the whole extension is well under a megabyte.

Type checking:

```sh
pnpm --filter @leekwallet/extension typecheck
```

### Three Vite passes, not one

`build.mjs` runs Vite three times, and they are not interchangeable:

1. **Modules** — `popup.html`, `offscreen.html`, `src/background.ts`. These are
   extension pages and an MV3 worker declared `"type": "module"`, so they get
   real ES modules and share chunks. viem and @noble are most of the bytes.
2. **`content.js`**, 3. **`inpage.js`** — one single-file IIFE each. Chrome
   injects `content_scripts` as *classic* scripts, so an `import` statement in
   either is a syntax error at injection time, and the failure is silent.

`manifest.json` is copied verbatim rather than generated. It is the file that
declares this extension's permissions, and a manifest produced by a build step
is a manifest nobody reviews. The build then checks that every file the manifest
names actually exists, which catches a renamed entry point before Chrome does.

## Loading it unpacked

1. `pnpm --filter @leekwallet/extension build`
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked**, and choose `app/extension/dist`
5. Pin LeekWallet to the toolbar
6. Plug in the device, open the popup, **Choose device…**, and pick the serial
   port. Chrome asks once.
7. Compare the six-digit passkey against the device's screen. If the digits
   differ, do not approve — something is relaying the connection.
8. Unlock with the PIN, **on the device**. It never travels to the browser.

## What is tested, and what is not

Tested:

- The extension **builds** with no errors or warnings (`node build.mjs`).
- It **type checks** clean under the repo's `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` settings, over all
  nine source files plus `packages/core`.
- The manifest is **valid MV3** by inspection, and the build asserts that every
  file it names was emitted.
- `packages/core` — the framing, CBOR, session, EIP-712 and chain code that does
  the actual protocol work — has its own test suite, unchanged and passing.

**Not** tested:

- **Anything involving hardware.** No LeekWallet device was connected to this
  code at any point. The handshake, the passkey comparison, unlock, derivation
  and all four signing paths are ported from `app/src/main.ts`, which *is*
  hardware-tested, but the port itself has never spoken to a device.
- **Anything involving a browser.** The extension has not been loaded into
  Chrome. The MV3 wiring — offscreen document creation, message routing between
  four contexts, the Web Serial grant surviving from the popup to the offscreen
  document, the EIP-6963 announcement racing a dapp's own script — is
  correct-by-reading and unverified by running.
- **Any dapp.** No site has connected to this provider.

Do not treat this as working with a device until someone has watched it do so.

## Browsers, and one that will not work

**Chromium desktop only.** Web Serial is implemented by Chrome, Brave, Edge and
Opera on the desktop. It is not implemented by Firefox or Safari, and not by
Chrome on Android, which also ships no extensions at all.

**Firefox cannot run this**, and not because the manifest is the wrong shape.
Mozilla has declined both Web Serial and WebUSB on privacy and security
grounds — it is a settled position, not a gap that closes by waiting. An
extension there would load and then have no way to reach the device. The only
route on Firefox is **native messaging** to a helper program that owns the port,
which means shipping a native component; the desktop companion in `app/` is
already that program, so it is a real option rather than a fantasy, but it is a
different piece of work.

### If your browser is a Flatpak or Snap

The port chooser will be **empty**, and the extension cannot tell you why,
because from inside the sandbox there is simply nothing there. Chromium
enumerates serial ports through udev, and a Flatpak has no `/run/udev` unless
it is given one:

```sh
flatpak override --user --filesystem=/run/udev:ro com.brave.Browser
flatpak override --user --device=all com.brave.Browser
```

Then quit the browser completely — closing the window is not enough — and start
it again. If the list is still empty, a browser installed from a package rather
than a sandbox is the reliable answer.

Observed, not guessed: inside `com.brave.Browser` the device appeared as
`crw-rw---- nfsnobody nfsnobody /dev/ttyACM0` and `/run/udev` did not exist.
