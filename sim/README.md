# Testing LeekWallet without hardware

You do not need a board attached to find most of the bugs in this firmware. Three tiers, from
fastest to most faithful. Use the cheapest tier that can express the test.

## Tier 1 — host-native logic tests (this directory)

Compile the firmware's own `.c` files with the host compiler and stub out the handful of
ESP-IDF symbols they touch. Millisecond runs, ordinary `gdb`, ASan and UBSan available, no
emulator in the loop.

```bash
make -C sim test        # just these suites
./scripts/check.sh      # everything checkable without a board
```

`scripts/check.sh` is what CI runs, so a green run locally and a green run in CI
cannot disagree about what green means.

This is where the PIN state machine, the mnemonic entry logic, the screen graph, and the
wallet's encrypt/decrypt round-trip belong. What is already here:

- `test_mnemonic_entry.c` — drives `src/mnemonic-entry.c` through all 2048 BIP39 words,
  keystroke by keystroke, asserting the committed word is the one typed. Regression guard for
  [AUDIT.md S3](../AUDIT.md).
- `test_pin.c` — `src/pin.c` against the fake NVS, including the two power-cut scenarios from
  [S4](../AUDIT.md).
- `test_ui.c` — the real `src/ui.c`, driven by scripted button presses against a framebuffer
  OLED. Covers the 12/24 word-count prompt on the import screen, the seed buffer's lifetime
  across the display/verify handoff ([S5](../AUDIT.md)), and PIN entry's explicit-submit
  selector.
- `esp_stubs.c` + `shim/` — in-memory NVS and logging; `shim/` shadows the ESP-IDF headers so
  firmware sources compile unmodified.
- `host_stubs.c` — deterministic `random32()` so runs repeat.

Two tools make the ordering bugs testable:

- **Crash injection.** `fake_nvs_crash_after(n)` lets `n` more writes land and silently drops
  every one after, exactly as power loss would.
- **I/O ordering probe.** `fake_nvs_writes_before_first_read()` reports how many writes were
  already durable when an operation performed its first read. This is what actually pins down
  S4: `pin_verify()` must have committed the decremented attempt counter *before* it reads the
  stored hash. Crash injection alone cannot show this — a single-write operation has nothing
  left to drop — which is a good reminder that a passing crash test is not the same as a
  correct ordering.

The fakes standing in for ESP-IDF and for the parts of the firmware a UI test has no business
running:

| Surface | Fake |
|---|---|
| `nvs_flash.h` / `nvs.h`, `esp_log.h`, `esp_timer.h`, `esp_random.h` | `esp_stubs.c` |
| FreeRTOS queue/task, `button.h` | `fake_input.c` |
| `oled.h` | `fake_oled.c` — 8×21 character grid plus a 128×64 bit buffer |
| `leek-wallet.h` | `fake_wallet.c` — deterministic addresses, real BIP39 checksum |

Wi-Fi, BLE and TinyUSB need no fakes at all: every such block in `ui.c` sits behind a
`CONFIG_*` macro that is simply undefined on the host.

A UI test therefore reads as a sequence of presses and a claim about the screen:

```c
go(SCREEN_MNEMONIC_ENTRY);
press(BUTTON_DOWN); press(BUTTON_ACCEPT);
CHECK(fake_oled_row_contains(0, "Word 1/24"), ...);
```

**Assert on text, not pixels.** `fake_oled_row(page)` returns what the firmware drew on that
row. A pixel golden fails on every cosmetic tweak and does not say which one; "row 0 says
Word 24/24" fails only when the device is actually wrong. `fake_oled_dump_pixels()` exists for
the cases that really are geometric — the QR renderer above all — and `fake_oled_dump()` prints
the character grid, which is what a failing assertion shows you.

## Tier 2 — ESP-IDF Linux target

```bash
idf.py --preview set-target linux
```

Runs the application against real ESP-IDF component implementations compiled for the host.
Useful when a fake would have to reimplement too much NVS semantics to be trustworthy. Slower
to set up than Tier 1 and only a subset of components support it, so reach for it when Tier 1
fakes start telling comfortable lies.

## Tier 3 — QEMU (`esp32s3` machine)

```bash
idf.py qemu monitor
```

Espressif's QEMU fork emulates the S3 CPU, memory, and several peripherals, and runs the same
binary you would flash. It boots the real bootloader and the real NVS driver over an emulated
flash image, which makes it the right tier for:

- **Flash encryption and secure boot.** QEMU emulates eFuses, so you can develop the [S1](../AUDIT.md)
  hardening against burn-once fuses without bricking a real board. This alone justifies the tier.
- Partition table and NVS-layout changes.
- Boot-path and panic-handler behaviour.

Limitations that matter here:

- **No I2C SSD1306 model.** QEMU has a virtual framebuffer device, but it is not your OLED —
  the display path stays a Tier 1 concern.
- **No GPIO buttons.** Drive the UI through a serial hook or keep input testing in Tier 1.
- **PSRAM is broken** ([espressif/qemu#129](https://github.com/espressif/qemu/issues/129)).
  Keep `CONFIG_SPIRAM=n` for the emulated target even if the physical board is an N16R8.

## What each tier will not catch

I2C bus timing and OLED init quirks, button bounce characteristics, brownout behaviour, real
RNG entropy ([S6](../AUDIT.md)), USB enumeration against real hosts, and power draw. Those need
the board. Everything in AUDIT.md except S6 can be pinned down before you plug anything in.

## Sources

- [QEMU Emulator — ESP32-S3, ESP-IDF Programming Guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/tools/qemu.html)
- [Running ESP-IDF Applications on Host](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/host-apps.html)
- [espressif/qemu#129 — PSRAM not working with QEMU ESP32-S3](https://github.com/espressif/qemu/issues/129)
