# Plan: LeekWallet v2, multi-board and airgapped

Working plan for the `research/airgap-vault-cloak` line of work. Design lives in
[RESEARCH-AIRGAP-VAULT.md](RESEARCH-AIRGAP-VAULT.md); pins in
[BOARD-S3CAM-PINOUT.md](BOARD-S3CAM-PINOUT.md); the decode measurement in
[../research/qr-spike/README.md](../research/qr-spike/README.md).

## Boards

Support is additive. **No existing board loses support, ever.** A release that
drops a board is a release we do not ship.

| Board | Status | Transport | Vault |
|---|---|---|---|
| ESP32-S3-N16R8 (reference, no cam) | **supported today** | USB, BLE | flash |
| Firefly Pixie (ESP32-C3) | **supported today** | BLE | flash |
| ESP32-S3-N16R8 CAM + OV5640 | **new** | QR default, USB/BLE on request | microSD |
| ESP32-S3 mini / C3 mini | **researching** | unknown | unknown |

The mini boards are a research item, not a commitment. They are listed so the
board profile is designed to take them, not so anyone waits for them.

`src/board.h` already selects pins per target and already explains why. It
currently branches on `CONFIG_IDF_TARGET_ESP32C3`, which cannot separate the
two S3 boards, so it gains an explicit `LEEK_BOARD_*` define. That is the
first change, and everything else depends on it.

## Sequencing, and why the companions wait

The four clients cannot be built in parallel **yet**, because three of them
would be writing against a protocol that does not exist. BC-UR and EIP-4527
frames are the contract between device and companion. Until that contract is
written and has passing vectors, parallel client work produces four different
guesses.

So the order is: contract first, then parallel.

```
phase 0  board profile        ── unblocks everything
phase 1  BC-UR + EIP-4527     ── the contract, host-tested, shared by all four
            │
            ├── phase 2a  firmware: camera, SD vault, cloak
            ├── phase 2b  desktop companion
            ├── phase 2c  Android (port of desktop)
            └── phase 2d  Chrome extension
                    │
phase 3  integration on hardware, QEMU regression, release
```

Phases 2a-2d are genuinely parallel and are where four agents earn their keep.
Phases 0 and 1 are one person's work and spawning agents for them would cost
more than it saves.

## Phase 0 — board profile

- Add `LEEK_BOARD_S3`, `LEEK_BOARD_PIXIE`, `LEEK_BOARD_S3CAM` and select on it
  rather than on target alone.
- Add `[env:esp32s3cam]` to `platformio.ini`, plus its QEMU variant.
- Feature flags, so code compiles out cleanly per board:
  `LEEK_HAS_CAMERA`, `LEEK_HAS_SDCARD`, `LEEK_HAS_SE`, `LEEK_HAS_BLE`,
  `LEEK_HAS_USB`, `LEEK_VAULT_ON_SD`.
- Existing two boards must build byte-identically before and after. That is the
  acceptance test, and it is checkable.

## Phase 1 — the contract

- BC-UR: bytewords, fountain encode and decode, multipart assembly.
- EIP-4527 UR types: `crypto-hdkey`, `eth-sign-request`, `eth-signature`.
- **Host-native tests first**, against published vectors, before any of it runs
  on a device. This is shared by firmware and all three companions, so it ships
  as one implementation in C for the device and one in TypeScript for the
  clients, held together by the same vector file — the pattern the existing
  decoder already uses with its 60 shared vectors.

## Phase 2a — firmware

1. Camera bring-up, `esp32-camera`, grayscale QVGA into PSRAM.
2. quirc in PSRAM; run `research/qr-spike/bench.c` unchanged on hardware and
   replace the estimated decode rate with the measured one.
3. microSD, 1-bit SDMMC on 38/39/40.
4. Vault v2: header, Argon2id, AES-256-GCM key slots. **Write the close and
   zeroise path before the open path.**
5. Cloak shell and the settings-shaped PIN entry.
6. QR sign flow end to end, with the device drawing the decoded call itself.
7. Radio gate: off at boot, 5-second hold or five confirmations to enable, with
   the screen stating the air gap is being given up, and off after a power cycle.

## Phase 2b/2c/2d — the three clients

Each gains: animated QR display, camera or webcam QR capture, and the EIP-4527
flow, while keeping the USB and BLE paths already shipped. Android is a port of
the desktop app, as it is today. The extension keeps its existing USB path and
adds QR for the CAM board.

## Mini apps

Aqua, ATS and Till are hackathon work and were always scoped to be removable.
They come out of the default build in this line of work and stay in `apps/`
until removed outright, per the standing rule. Removing them is its own commit,
separate from anything else, so it can be reverted alone.

## Standing rules for this work

- Every phase ends green under QEMU before the next begins.
- Every phase ends with the older boards still building.
- Branch per phase, merged into `research/airgap-vault-cloak`.
- Nothing irreversible on hardware: no eFuse burn, no `provision`, and the Pixie
  is flashed only with `./flash-both.sh dev`.
- Commit messages follow joelparkerhenderson/git-commit-message: imperative
  summary of 50 characters or less, blank line, body wrapped at 72 explaining
  why rather than what. No bump section. Author 0xoucan, Claude as co-author.
