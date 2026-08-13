# LeekWallet Companion

One [Tauri v2](https://tauri.app) codebase for Linux, macOS, Windows and
Android, talking to the device over BLE on Android and USB CDC on desktop.

```
app/
├── packages/core/     @leekwallet/core — protocol codec, transport-agnostic
├── src/               UI (shared by every platform)
└── src-tauri/         Rust shell: transports, capability allowlist
```

## Building the Tauri desktop shell

The web shell runs in any browser against the mock with no extra tooling. The
**Tauri** build additionally needs GTK and WebKit development packages, which
are not installed by default on Ubuntu:

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev libssl-dev librsvg2-dev
```

One line on purpose. A backslash-continued command loses its continuations when
pasted through some terminals, and the shell then reads the remaining package
names as commands — `libssl-dev: command not found` rather than anything that
suggests a paste problem.

`libxdo-dev` and `libayatana-appindicator3-dev` are only needed for global
shortcuts and a tray icon, neither of which this app uses.

**Rust 1.88 or newer** is also required — Tauri's dependency tree moved past
what Ubuntu's packaged `rustc` provides. `rustup default stable` is enough; a
distro Rust will fail with `rustc 1.85.1 is not supported by the following
packages`.

Without any of this, `pnpm dev` and the mock still cover everything except the
native window and the real transports.

### Running the native shell

Two paths, and picking the wrong one gives a window that says it cannot reach
localhost:

```bash
# Development: Vite serves the frontend, edits reload live.
pnpm dev                        # terminal 1, must be running first
cd src-tauri && cargo run       # terminal 2
```

```bash
# Standalone: uses the built dist/, no dev server needed.
pnpm build
cd src-tauri && cargo run --release
```

A **debug** build loads `devUrl` from `tauri.conf.json`, which is
`http://localhost:1420`. A **release** build loads `frontendDist`. So
`cargo run` without `pnpm dev` running produces exactly one symptom — a blank
window complaining it cannot connect — and the fix is whichever half is
missing.

`libEGL warning: DRI3 error` on startup is harmless; the window falls back to
software rendering.

## Setup

Requires **Node 22+** and **pnpm 9+**. Get pnpm through corepack, which ships with Node — no
global install, and the version is pinned by `packageManager` in `package.json`:

```bash
corepack enable pnpm      # once per machine
cd app
pnpm install
```

| Command | From | Does |
|---|---|---|
| `pnpm install` | `app/` | Install the workspace |
| `pnpm test` | `app/` | Run every package's tests |
| `pnpm typecheck` | `app/` | Strict `tsc` over all sources |
| `pnpm --filter @leekwallet/core test` | anywhere | One package only |

Tests run under Node's native type stripping, so there is no build step and no bundler in the
loop. Two consequences worth knowing: `enum` is unavailable (it needs code generation — use a
const object), and `tsc` is typecheck-only, never emitting.

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
That is deliberate for code that parses bytes off a wire on behalf of a signing device — the
index checks alone caught four real unguarded accesses in the framing layer.

## Dependencies and supply chain

The tree is **35 packages**: viem, plus TypeScript, Vite and Node types. That
number is the strongest control available here, and it is worth defending —
every addition is a party who can push code into a process that talks to a
signing device.

`.npmrc` sets three things:

| Setting | Why |
|---|---|
| `ignore-scripts=true` | Most npm supply-chain incidents execute through a `postinstall`. pnpm 9 still runs them by default; pnpm 10 changed that, and we are on 9.x. Nothing here needs them, and the build was verified without. |
| `save-exact=true` | An install today and an install next month resolve identically, rather than relying on a range being honoured. |
| `prefer-frozen-lockfile=true` | A dependency change should be a reviewed commit, not a side effect of running install. |
| `minimumReleaseAge=10080` | Seven days. Refuses anything published in the last week — see below. |

### The seven-day gate

`minimumReleaseAge` is the strongest single answer to the attack pnpm does not
otherwise prevent. A compromised package is usually spotted and yanked within
hours; refusing anything published in the last week lets the ecosystem do the
detection, and this project never installs the bad version at all. The cost is
that a genuine fix is a week late, which for a wallet is the right trade.

**It requires pnpm 10.16 or newer.** This project is pinned to 9.15.3, where the
key is silently ignored, so the line is written and inert. To activate it:

```bash
pnpm add -g pnpm@latest      # or: corepack use pnpm@latest
```

then bump `packageManager` in `package.json`. Note that pnpm 10 also blocks
install scripts by default, which `ignore-scripts` already does here.

> Watch out for one trap while doing this. `corepack prepare` may fail with
> `Cannot find matching keyid` on older Node, because its bundled npm signing
> keys have rotated. The advertised workaround is `COREPACK_INTEGRITY_KEYS=0`,
> which disables signature verification — do not use it. Turning off signature
> checking to install a supply-chain mitigation defeats the mitigation.

### What pnpm does and does not do

It gives a strict `node_modules` layout, so nothing can use a package it did
not declare, and a lockfile with integrity hashes, so a resolved package cannot
be swapped underneath you.

**It does not stop a legitimate package from publishing a malicious version.**
That arrives through the front door on your next install or update, and no
package manager prevents it. Neither does it help with typosquatting, or with a
transitive dependency changing hands.

### Why that is survivable here

The architecture, not the package manager, is what contains this. The seed never
leaves the device, the device re-serialises and re-hashes every transaction
itself, and it renders what it will sign on its own screen before a physical
button press. A compromised npm package can show you a false preview — which is
exactly why [PROTOCOL.md](../docs/PROTOCOL.md) says the app's preview is
advisory — but it cannot extract a key or sign anything you did not approve on
the device.

That is the whole reason the trust boundary sits where it does. If the host had
to be trustworthy, 35 dependencies would be 35 too many.

## Layering

The rule that keeps a Tauri-to-something-else migration cheap, and keeps the
Android and desktop builds honest, is that **no device logic lives in the
shell**. `packages/core` has no platform dependencies at all — it is pure
codec and state machine, testable under plain Node:

```bash
cd app/packages/core && npm test
```

The Rust side owns exactly one thing: moving bytes. `Transport` is a trait with
a serial implementation for desktop and a `btleplug` implementation for
Android, and the protocol above it is identical on both. Adding the second
transport to either platform later is configuration, not rework.

## Running it

```bash
corepack enable pnpm
cd app
pnpm install
pnpm dev          # http://localhost:1420
```

The shell runs in a plain browser against the mock device, so the whole
interface can be exercised with no hardware and no Rust toolchain. `pnpm build`
produces the static bundle Tauri wraps.

The mock is configured with 250 ms of latency on purpose. A mock that answers
instantly hides every place the UI forgot to show that it is waiting, and a
hardware wallet spends real seconds deriving keys.

### Theme

Light, dark, and system, cycled from the status bar and remembered. System is a
distinct state rather than an initial guess — a user who toggles once must be
able to get back to following their OS.

## Status

Implemented:

- **Framing** — length-prefixed frames, incremental decoding, BLE chunking and
  reassembly, hostile lengths rejected before allocating.
- **CBOR** — the protocol subset only, verified against RFC 8949 appendix A.
  Tags, floats, indefinite lengths and 64-bit arguments are refused rather than
  tolerated.
- **Mock device** — session handshake, permission tiers, on-device
  confirmations, user rejection, modelled latency.
- **Shell** — connection state, passkey comparison, ten derived addresses,
  a signing preview, and a device log. Driven entirely by the mock.

Next: the Rust transports (T22) so the same shell talks to real hardware over
USB, then the viem adapter (T24) and WalletConnect (T32).

See [../docs/PROTOCOL.md](../docs/PROTOCOL.md) for the wire format and
[../docs/DESIGN.md](../docs/DESIGN.md) for the visual language.
