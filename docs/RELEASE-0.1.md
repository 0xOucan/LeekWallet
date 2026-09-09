# Release 0.1 — what ships, how it is built, and what is untested

**Status: planned.** Nothing has been published. This is the scope and the
mechanism for the first release, deliberately drawn *before* airgapped signing
and before the temporary-seed changes discussed for a later version.

The point of cutting here is that everything in this scope has been run on
hardware. Everything after it has not.

---

## Scope

**In.** Everything currently on `main`: the vault, dice entropy, the temporary
seed, EIP-712 and contract-call rendering with refuse-by-default, the session
handshake with the passkey comparison, the approval guard, the 180-second idle
timeout, hold-to-lock, and the companion with WalletConnect.

**Out, and stated as out.**

| | Why it waits |
|---|---|
| Airgapped QR signing | needs a camera and PSRAM; hardware not yet in hand |
| Temporary seed surviving a wallet switch | a wallet state-machine change, in the file where a mistake is invisible |
| eFuse burning, secure boot | never done on silicon |
| ATECC608B | no chip obtained |
| Firmware flasher in the app | gated on secure boot — see below |

## Artefacts

| Artefact | Target | Built by | Device-tested? |
|---|---|---|---|
| `leekwallet-s3-0.1.0-chaak-pool-provision.bin` | ESP32-S3-N16R8 | CI, Linux | **yes** |
| `leekwallet-s3-0.1.0-chaak-pool-update.bin` | ESP32-S3-N16R8 | CI, Linux | **yes** |
| `leekwallet-pixie-0.1.0-chaak-pool-provision.bin` | Firefly Pixie (C3) | CI, Linux | **yes** |
| `leekwallet-pixie-0.1.0-chaak-pool-update.bin` | Firefly Pixie (C3) | CI, Linux | **yes** |
| `LeekWallet-0.1.0.AppImage` | Linux x86-64 | CI, ubuntu | **yes** |
| `LeekWallet-0.1.0.msi` | Windows x86-64 | CI, windows | **no — see below** |
| `LeekWallet-0.1.0.dmg` | macOS | CI, macos | **no — see below** |
| `leekwallet-0.1.0.apk` | Android arm64 | CI, ubuntu | **yes** |
| `SHA256SUMS` | — | CI | — |
| `SHA256SUMS.asc` | — | maintainer | — |

Two firmware images per board, and they are **not** interchangeable. `provision`
is the merged image written at `0x0`; it spans `nvs` at `0x9000` and therefore
**erases every wallet** — correct for a new or deliberately reset board and only
then. `update` is the application alone at `0x10000` and leaves the vault where
it is. Neither can be told from the other by its bytes, so the operation is
chosen by the person flashing, never inferred.

The Pixie firmware **did** ship in 0.1: phase 3 of
[PIXIE-PORT.md](PIXIE-PORT.md) landed, and the board boots, displays, signs and
answers `getFeatures` with `model: LeekWallet-Pixie`.

It must be flashed **from a terminal**. Browser flashing is blocked for the C3
because esptool-js corrupts writes to it — the firmware and the release are
fine, the browser tooling is not. See
[PIXIE-PORT.md](PIXIE-PORT.md#browser-flashing-is-blocked).

## Can Windows and macOS be tested?

**Built, yes. Tested, only partly — and the gap has to be published.**

GitHub Actions runs `windows-latest` and `macos-latest`, and Tauri v2 builds on
both. Extending `.github/workflows/ci.yml` — five jobs today, all
`ubuntu-latest` — to a `matrix.os` is the mechanism, and it is free for a public
repository.

What CI on those runners **can** verify:

- the app compiles and bundles into an `.msi` and a `.dmg`
- the whole host test suite passes, because it runs against the mock device
- the WalletConnect, CBOR, framing, EIP-712 and simulation tests pass

What it **cannot** verify, on any runner:

- **anything involving a device.** There is no board attached to a CI machine
  and no Bluetooth radio. USB enumeration, BLE pairing, the passkey comparison,
  and every signing flow are untested on Windows and macOS until a person with
  that OS and a board runs them.

That distinction is the whole reason this section exists. A release that says
"Windows supported" when nobody has ever plugged a wallet into Windows is
exactly the kind of claim this project spends its status section refusing to
make. So the release notes say, per platform: **built and unit-tested in CI;
device interaction unverified**, until someone verifies it.

The cheapest way to close it is people rather than infrastructure: two testers,
one per OS, with a board and the checklist from
[docs/BURN-PROCEDURE.md](BURN-PROCEDURE.md)-style step lists. Until then the
label stands.

### Signing, which is a cost not a task

- **macOS**: an unsigned `.dmg` is blocked by Gatekeeper. Users can right-click
  → Open, or `xattr -dr com.apple.quarantine`. Notarising properly needs an
  Apple Developer account at $99/year.
- **Windows**: an unsigned `.msi` raises SmartScreen. An EV certificate is
  several hundred dollars a year and tied to an identity.

For a project that has not raised funds for an audit, neither is a good use of
the first dollars. **Publish checksums, document the warning, and say why it
appears** — which is also more honest than a signature, since a signature
attests to an identity and not to the code.

`docs/RELEASE.md` already covers the part that matters more: the builds are
reproducible, so a reader can rebuild and compare rather than trust.

## A merged image at 0x0 destroys the wallet

Found the hard way, on a board holding a real wallet.

`nvs` sits at **0x9000**, before the app at 0x10000 — deliberately, because it
means `ota_0`/`ota_1` can be added later without moving the vault. But
`esptool merge_bin` fills the gap between the partition table and the app with
**0xFF**, so a merged image is not three regions with holes between them: it is
one continuous span from 0x0 that happens to contain an erased NVS. Writing it
at 0x0 erases the vault — mnemonics, IVs, KDF salt, PIN counter.

Verified rather than reasoned: bytes 0x9000..0x9010 of a merged image are
`ffffffff…`, and a board flashed that way came up with no wallets while a board
flashed with three separate writes at 0x0/0x8000/0x10000 kept `password_set=1`.

**So the offset is not a detail, it is the whole question:**

| Write | Offset | Effect |
|---|---|---|
| Merged image | `0x0` | **Erases every wallet.** Correct for a new or recovered board, and only then |
| Application only | `0x10000` | Updates the firmware, vault untouched |

Both flashers must therefore ask which of those two things the user is doing,
and must not treat "flash" as one operation. A first install and an update
differ by whether the person loses their money, and that cannot be inferred from
the file.

The releases publish both — the merged image for provisioning, the application
image for updating — and the checksums cover each separately.

## Flashing from the companion — the actual answer

Asked directly: **can the desktop or Android app flash a board over USB or
BLE?**

**Over BLE: no, and not for a missing-feature reason.** The ESP32 ROM
bootloader speaks a serial protocol over UART/USB and has no radio at all.
BLE exists only once *some* firmware is already running, so a radio path can
only ever be an update mechanism, never a way to program a blank board.

An OTA-over-BLE path *is* buildable (roadmap T66) and is deliberately not built.
Two reasons, and the second is the real one:

1. BLE moves 20–100 kB/s. A 1.2 MB image is minutes.
2. **A firmware-update endpoint on a device without secure boot is the
   evil-maid attack, offered as a feature.** The protocol has no host-invokable
   wipe, no `getMnemonic`, and no way to set the PIN over the wire — all
   deliberate, all documented in PROTOCOL.md §4. "Replace the firmware" belongs
   in the same list until the firmware can refuse to run an unsigned image.

**Over USB: yes, and it is already planned as T65.** `espflash` is a Rust
library, Tauri's backend is Rust, and the desktop app already owns a serial
transport. The work is real but ordinary: enter download mode (DTR/RTS), run
the stub, write the image, verify.

**Android is close to free, and an earlier draft of this document said
otherwise.** The claim was that `espflash` cannot use the `serialport` crate on
a phone, so the transfer would need Android's `UsbManager` behind a new Tauri
plugin. That plugin already exists: T59 shipped USB serial on Android, and
`transport-serial` carries two backends behind one API precisely so the phone is
not a special case.

Better still, `android-usb-serial` ships a `serialport_compat` module whose
`SerialPortAdapter` implements the whole `serialport::SerialPort` trait —
`write_data_terminal_ready` and `write_request_to_send` included, which are
exactly the two calls that toggle DTR/RTS to put the chip into download mode. So
the chain is `SerialPortAdapter` → `espflash::Connection` → image, with no new
transport work on either platform.

What remains on Android is the ordinary part: an OTG cable, the runtime USB
permission prompt, and a UI that can survive the device disappearing and
re-enumerating mid-flash.

**And T65 stays gated on secure boot, in substance rather than in sequence.**
Without it, a one-click flasher is a one-click way to install firmware that
keeps your PIN and hands the device back looking normal. If the button ships
before the fuses do, it must say that plainly rather than being quietly greyed
out.

## Mechanism

Steps 1-3 are now written: `.github/workflows/ci.yml` carries the matrix and
`check.sh firmware` builds both boards, and `.github/workflows/release.yml`
builds everything a tag needs, merges each firmware into one flashable image
and attaches a `SHA256SUMS` to a **draft** release. Written, not demonstrated:
this repository has no remote and neither workflow has ever executed. Step 4 is
a human act by construction.

1. **Extend CI to a matrix** — `ubuntu-latest`, `windows-latest`, `macos-latest`
   for the app jobs; firmware stays Linux-only, since both targets cross-compile
   there.
2. **Add the `pixie` environment** to the firmware build job, so the C3 image is
   built on every commit whether or not it ships.
3. **A tag builds everything**, uploads the artefacts and a `SHA256SUMS`, and
   the reproducibility jobs in `docs/RELEASE.md` gate the tag rather than
   decorate it.
4. **Release notes carry the per-platform test status table above**, verbatim.

## The one thing to decide first

*(Resolved: it did not wait, and the Pixie landed anyway — both boards shipped
in `v0.1.0-chaak-pool`. The reasoning below is kept as it stood.)*

Whether **0.1 waits for the Pixie**. It should not. The S3 firmware, the
companion and the APK are tested today; the Pixie port is phases 1–3 away and
its display shim is not written. Ship 0.1 for the S3, and let the Pixie be 0.2
— releasing a second board's firmware that has never been run on that board
would undo the reason this document lists a test status per artefact.
