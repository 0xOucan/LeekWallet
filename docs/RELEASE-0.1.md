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
| `leekwallet-s3-0.1.0.bin` | ESP32-S3-N16R8 | CI, Linux | **yes** |
| `leekwallet-pixie-0.1.0.bin` | Firefly Pixie (C3) | CI, Linux | **not yet** |
| `LeekWallet-0.1.0.AppImage` | Linux x86-64 | CI, ubuntu | **yes** |
| `LeekWallet-0.1.0.msi` | Windows x86-64 | CI, windows | **no — see below** |
| `LeekWallet-0.1.0.dmg` | macOS | CI, macos | **no — see below** |
| `leekwallet-0.1.0.apk` | Android arm64 | CI, ubuntu | **yes** |
| `SHA256SUMS` | — | CI | — |

The Pixie firmware ships in 0.1 only if phase 3 of
[PIXIE-PORT.md](PIXIE-PORT.md) lands. If it does not, it is simply absent
rather than shipped untested.

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

Whether **0.1 waits for the Pixie**. It should not. The S3 firmware, the
companion and the APK are tested today; the Pixie port is phases 1–3 away and
its display shim is not written. Ship 0.1 for the S3, and let the Pixie be 0.2
— releasing a second board's firmware that has never been run on that board
would undo the reason this document lists a test status per artefact.
