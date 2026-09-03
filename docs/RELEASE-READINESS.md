# Release readiness

What is ready to ship, what is not, and what only a human can do. Written
against the state of `main` at the time of the flashing fix; the checked boxes
are things that were run, not things that were reasoned about.

## 1. The flashing issue, and what was changed

**The defect.** A release published one image per board — the merged image — and
every flasher wrote it at offset `0x0`. `partitions.csv` puts `nvs` at `0x9000`,
*before* the application at `0x10000`, and `merge_bin` fills the gap between the
partition table and the app with `0xFF`. A merged image is therefore not three
regions with holes between them; it is one continuous span from `0x0` that
contains an erased vault. Writing it wipes every wallet on the board.

This was found by doing it: a development board holding three wallets came up
empty, and bytes `0x9000..0x9010` of the merged image read `ffffffff`. A board
flashed with three separate writes (`pio run -t upload`) kept its wallets. The
two images cannot be told apart from their contents — both begin with the same
ESP-IDF magic byte `0xE9` — so nothing downstream can infer the answer.

**The fix, in four places.**

| Where | Change |
|---|---|
| `scripts/release.sh` | emits **two** images per board: `-provision.bin` (merged, `0x0`) and `-update.bin` (application, `0x10000`), each with its own SHA-256, both in `SHA256SUMS` |
| `manifest-fragment.json` | two entries per board carrying `kind`, `offset` and `wipesWallets`, instead of one entry carrying a filename |
| Website `/flash` | the two builds are labelled *in the list* ("erases every wallet" / "keeps your wallet"), the warning re-appears above the button, and the write goes to the offset the entry names rather than a constant `0` |
| Desktop/Android companion | a mode selector; the acknowledgement text is rewritten per mode and **un-ticks itself** when the mode changes; `flash_write` now **requires** an offset — `offset: None` is an error, where it used to mean "merged image at `0x0`" |

The last one is the important one. The old default was the destructive branch,
so a caller that had simply not thought about the question got a wipe. A caller
that has not decided is now a caller that cannot write.

The Chrome extension does not flash and is unaffected.

## 2. Firmware

| | ESP32-S3 | Firefly Pixie (ESP32-C3) |
|---|---|---|
| Builds | ✅ `pio run -e esp32s3` | ✅ `pio run -e pixie` |
| Boots on hardware | ✅ | ✅ |
| Display | ✅ SSD1306 128×64 I²C | ✅ ST7789 240×240 SPI, 128×64 frame upscaled ×1.875 |
| Buttons | ✅ SW1 up, SW2 down, SW3 back, SW4 next | ✅ same physical order |
| PIN, wallet creation, signing | ✅ | ✅ |
| Host protocol | ✅ | ✅ `getFeatures` reports `BOARD_MODEL` |

Both targets share `oled-core.c`; only the transport differs. Note that the
host test suite links `fake_oled.c`, so a transport-layer regression passes the
suite — the S3 display bug (`sizeof` on a pointer, flushing 4 bytes of 1024)
did exactly that. **Transport changes need a board.**

## 3. Companion

- **Desktop (Linux)** — builds, runs, flashes, signs. Tested against both boards.
- **Windows / macOS** — cross-compiled only. **Never run.** Say so in the
  release notes rather than implying coverage.
- **Android** — builds; USB flashing goes through the `UsbManager` plugin. Note
  that `espflash`'s `Port` is a concrete `TTYPort`/`COMPort` taken by value, so
  there is no seam to hand it an Android file descriptor; the Android path is
  its own implementation and must be exercised on a phone before it is claimed.
- **Chrome extension** — EIP-1193 + EIP-6963 provider, popup connects over Web
  Serial. **Known open defect:** the offscreen document reports "the device did
  not answer within 5000 ms". The serial chooser itself was fixed (Chrome
  anchors it to a *tab*, and an extension popup has none). Not release-blocking
  for the firmware, but it blocks calling the extension shipped.

## 4. Website

Separate repo, `/leekwalletwebsite`. `npm run check` passes: 7 views, no errors,
no 404s, no horizontal overflow. `/flash` is compliant with the two-image
manifest above. `assets/firmware/manifest.json` still has an empty `releases: []`
— it fills from a release, and the page already renders the "no release yet"
state rather than an empty list.

## 5. Before the first release — human only

None of these can be done from here, and each blocks a real release:

1. **Android signing** — create the keystore and the four GitHub secrets. The
   injection path has never run against a real keystore; verify it on the first
   run rather than trusting it.
2. **GPG release key** — create it and sign `SHA256SUMS` by hand. The script
   deliberately never generates or prints key material.
3. **Per-platform test status in the release notes** — Windows and macOS builds
   are untested. Users must be told which binaries nobody has run.
4. **Flash both boards from the published artefacts**, not from a local build:
   an update image onto a board that holds a wallet, and confirm the wallet is
   still there afterwards. That is the specific regression this release exists
   to fix, and it should be observed rather than assumed.
