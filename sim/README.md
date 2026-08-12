# Testing LeekWallet without hardware

You do not need a board attached to find most of the bugs in this firmware. Three tiers, from
fastest to most faithful. Use the cheapest tier that can express the test.

## Tier 1 — host-native logic tests (this directory)

Compile the firmware's own `.c` files with the host compiler and stub out the handful of
ESP-IDF symbols they touch. Millisecond runs, ordinary `gdb`, ASan and UBSan available, no
emulator in the loop.

```bash
make -C sim test
```

This is where the PIN state machine, the mnemonic entry logic, the screen graph, and the
wallet's encrypt/decrypt round-trip belong. What is already here:

- `test_mnemonic_entry.c` — drives `src/mnemonic-entry.c` through all 2048 BIP39 words,
  keystroke by keystroke, asserting the committed word is the one typed. Regression guard for
  [AUDIT.md S3](../AUDIT.md).
- `test_pin.c` — `src/pin.c` against the fake NVS, including the two power-cut scenarios from
  [S4](../AUDIT.md).
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

To extend coverage to `ui.c` and `colibri-wallet.c`, the remaining fakes are:

| ESP-IDF surface | Fake |
|---|---|
| `nvs_flash.h` / `nvs.h` | ✅ done — `esp_stubs.c` |
| `esp_log.h` | ✅ done — `esp_stubs.c` |
| `driver/gpio.h`, FreeRTOS queue/task | still to do (T0.2): scripted button sequence feeding `ui_handle_button()` directly |

Then add a fake `oled.c` that writes into a 128x64 bit buffer instead of pushing I2C, and dump
it as ASCII or PGM. Now a test can assert on what the user actually sees:

```c
press(BUTTON_ACCEPT); press(BUTTON_UP); press(BUTTON_ACCEPT);
assert_screen_contains("Enter PIN");
```

Golden-file those dumps and UI regressions become a diff. This is also the only practical way
to test the QR renderer.

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
