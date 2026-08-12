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

## Status

Implemented: frame encoding/decoding with incremental buffering, BLE chunking
and reassembly, hostile-length rejection. Tests cover byte-at-a-time delivery,
coalesced frames, and dropped chunks.

Next: CBOR command codec (T21), the mock device (T23), then the Tauri shell
(T27b) and viem adapter (T24). The mock is the priority — it lets the UI be
built and demoed with no hardware attached.

See [../docs/PROTOCOL.md](../docs/PROTOCOL.md) for the wire format and
[../docs/DESIGN.md](../docs/DESIGN.md) for the visual language.
