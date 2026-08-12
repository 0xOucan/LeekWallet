# LeekWallet Companion

One [Tauri v2](https://tauri.app) codebase for Linux, macOS, Windows and
Android, talking to the device over BLE on Android and USB CDC on desktop.

```
app/
├── packages/core/     @leekwallet/core — protocol codec, transport-agnostic
├── src/               UI (shared by every platform)
└── src-tauri/         Rust shell: transports, capability allowlist
```

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
