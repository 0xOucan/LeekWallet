# Running LeekWallet on the Firefly Pixie

**Status: planned, not started.** Everything below is a design with measurements
attached, not a report. No LeekWallet code has been compiled for an ESP32-C3.

---

## Why

The [Firefly Pixie](https://github.com/firefly/pixie-device) is already in the
hands of Ethereum developers. Supporting it means a working hardware wallet for
people who **do not have to buy anything** — which is the same argument this
project makes about $12 boards, applied to hardware that is already on desks.

It is a second target, not a fork. One codebase, two boards.

## The hardware, side by side

| | LeekWallet reference | Firefly Pixie |
|---|---|---|
| MCU | ESP32-S3-N16R8 | ESP32-C3 |
| Core | Xtensa LX7, **2 cores** | RISC-V RV32, **1 core** |
| Clock | 160 MHz configured, **240 MHz available** | 160 MHz |
| RAM | 512 KB SRAM + **8 MB PSRAM** | 400 KB SRAM, no PSRAM |
| Flash | 16 MB | 16 MB |
| SHA accelerator | SHA-1/224/256/384/**512** | SHA-1/224/**256 only** |
| Display | SSD1306 128×64 mono, I²C | **240×240 IPS, RGB565, SPI** |
| Buttons | 4 | 4 |
| LEDs | — | **4× WS2812B** |
| Link | USB-C CDC + BLE | USB-C CDC + BLE |
| Camera | possible (PSRAM) | no |

## What ports unchanged

Measured, not estimated:

- **One ESP32-S3-specific reference in the entire firmware**, and it is a log
  string (`src/main.c:49`).
- Every peripheral the firmware touches exists on the C3: `driver/gpio`,
  `driver/usb_serial_jtag`, BLE, `esp_random`, `esp_timer`.
- No Xtensa assembly anywhere, `trezor-crypto` included.
- Current build uses **56.8 KB of RAM**. `firefly-display` renders in fragments
  rather than holding a 115 KB framebuffer, so 400 KB is not tight.

So this moves as-is — roughly 90% of the codebase, and effectively all of the
security-critical part:

```
components/leek-wallet/    vault, BIP-39/32/44, AES-256-GCM, PBKDF2
components/trezor-crypto/  secp256k1, SHA-2/3, HMAC
src/protocol.c  cbor.c  session.c  ble.c  transport.c  ble-chunk.c
src/eth-tx.c  eth-decode.c  eip712.c  blind-signing.c
src/pin.c  device-wipe.c  entropy.c  mnemonic-entry.c  text-entry.c
```

The companion needs **no protocol changes at all**: the wire format is produced
by files that port untouched.

## The one real job: a display HAL

`src/ui.c` is 5,989 lines written for an 8×21 monochrome grid — and it never
learned anything else about the panel. It reaches the display through six
functions:

| call | uses |
|---|---|
| `oled_draw_string(page, col, str)` | 180 |
| `oled_draw_string_centered(page, str)` | 118 |
| `oled_clear()` | 29 |
| `oled_flush()` | 2 |
| `oled_set_contrast()` | 2 |
| `oled_draw_qrcode()` | 1 |

**298 of 332 calls are two functions.** Implement those six against
`firefly-display` and `ui.c` compiles unchanged, with every screen and every
refusal intact.

That is the whole strategy, and it is worth stating plainly: **do not redesign
the screens to port the wallet.** Redesigning for 240×240 colour is weeks of
work that discards layout decisions already tested on hardware. Ship the shim,
get a working wallet, then improve screens one at a time behind the same six
functions.

### What the shim does

- `oled_draw_string` — render the 5×7 glyphs from `font_5x7` at **3× scale**
  into a 128×64 logical area centred on the panel. Preserves every layout,
  every clip-at-the-right-edge, every centring calculation.
- `oled_clear` / `oled_flush` — fragment fill and blit.
- `oled_set_contrast` — backlight PWM.
- `oled_draw_qrcode` — the existing renderer, scaled.

A later phase can let a screen opt into the full panel without touching the
others, because the shim is an implementation of an interface rather than a
translation layer bolted on top.

### Licence, which matters here

`firefly-display` and `firefly-scene` are **MIT** — compatible with this
project's Apache-2.0.

**`colibri/` and `pixiecolibri/components/colibri-wallet/` are AGPL.** There is
a working Pixie wallet sitting next to this repository and it must not be read
into this one. The shim is written fresh against the MIT headers. This is the
standing rule of the project and the port is where it will be most tempting to
break.

## Phases

**1 — It boots and shows a PIN screen.**
Board target, `sdkconfig.pixie`, GPIO map for four buttons, the six-function
shim. Done when the PIN screen renders and a button moves the cursor.

**2 — It is a wallet.**
Unlock, create a seed, view an address, sign over USB. Everything above the
shim is already written. Done when `app/scripts/test-dapp.mjs personal` returns
a signature that recovers to the displayed address.

**3 — It is the same wallet.**
BLE, session handshake, the passkey comparison, temporary seed, hold-to-lock.
Re-run the hardware tests that only real scheduling can exercise — see the
single-core note below.

**4 — It is a Pixie.**
The four WS2812B LEDs, which LeekWallet has no concept of today. Deliberately
last: they are the only genuinely new feature, and they are decoration until
the wallet works. Worth doing well — a colour cue for *awaiting your approval*
versus *idle* is real UX, not ornament.

**5 — Native screens, optional and incremental.**
Whichever screens most want the extra pixels. The address, the transaction
confirmation and the QR code are the obvious three.

## The companion

**No changes required to talk to it.** The protocol comes out of files that port
unchanged, so the desktop app and the APK work against a Pixie the day phase 3
lands.

Two changes are worth making anyway:

1. **`getFeatures.model`** already exists and returns `"LeekWallet-S3"`. A Pixie
   should return `"LeekWallet-Pixie"`. One line, and it is the only way the host
   can tell them apart.
2. **A capability the host can read.** Airgapped QR signing needs a camera, and
   the Pixie has none. Rather than the app inferring capability from the model
   string — which ages badly the moment there is a third board — `getFeatures`
   should say what the device *can do*, and the app should ask that.

Neither is needed for phase 3. Both are needed before the app offers a feature
one board cannot perform.

## Performance: what is actually different

The honest answer to "will the S3 be faster" is **not today, and yes later**,
for a specific reason.

**Today they are close.** The S3 is configured at 160 MHz — the same as the C3 —
and the vault KDF is a pure software implementation on both. The S3 should be
modestly ahead on SHA-512's 64-bit operations, because Xtensa LX7 handles them
better than RV32IMC, but that is an expectation and not a measurement.
`vault_kdf_benchmark_ms()` exists to settle it on each board.

**The headroom is not close, and it is structural:**

- The S3 can run at **240 MHz**; the C3 cannot. That is 1.5× for one config line.
- The S3's SHA accelerator does **SHA-512**; the C3's stops at SHA-256. The
  planned KDF speedup (T9e, routing PBKDF2-HMAC-SHA512 through the accelerator)
  is therefore **available on the S3 and impossible on the C3**. When that lands,
  the gap becomes large rather than marginal.
- The S3 has **two cores**, so the NimBLE host task and a 500 ms key derivation
  do not contend. On the C3 they timeshare.
- The S3 has **PSRAM**, which is what makes a camera — and therefore airgapped
  signing — possible at all.

**Entropy is the same on both.** Both have a hardware RNG behind the same
SP 800-90B health gate and the same RF-active requirement, and dice contribute
identically. There is no quality difference and no meaningful speed difference.

### The KDF iteration count is a format decision

`VAULT_KDF_V2_ITERATIONS = 2250` was measured on an S3 at 0.226 ms/iteration.
If the C3 measures materially slower, there are two options and they are not
equivalent:

- **Keep 2250 on both.** Unlock is slower on the Pixie. Vaults are portable.
- **Tune per board.** Unlock times match. **A vault written on one board will
  not open on the other**, because the derived key differs.

Portability is worth more than a few hundred milliseconds, so the default should
be to keep the count and let the Pixie be slower — but note that this is only an
issue for the *encrypted blob*. A seed phrase restores on either device
regardless, because BIP-39 is BIP-39.

## Risks, in order

**1. Single-core changes the races.** H-1 — a signature taken under a wallet the
approval screen never showed — was a cross-task race that the host simulator
structurally could not reproduce, and it was only ever caught on real hardware
scheduling. One core is *different* real scheduling, not less of it. The H-1
repro, the 180 s idle timeout and hold-to-lock all need re-running on a Pixie.

**2. Stack sizes were tuned on the S3.** The protocol and BLE tasks were raised
to 8 KB after a 744-byte EIP-712 render struct caused an overflow that surfaced
as "unlock failed: derivation failed". `warn_on_thin_stack()` will report the
margin on the C3; watch it during phase 2 rather than after a user finds it.

**3. Nothing about the eFuse plan changes, which is good but unproven twice
over.** The C3 has `SOC_HMAC_SUPPORTED` and eFuse key-purpose fields, so the
binding design carries over — onto a second board on which it has also never
been burned.

## Comparison chart, for the README

Fill the empty cells from measurements on both boards; do not estimate them.

| | Pixie (C3) | LeekWallet (S3) |
|---|---|---|
| Unlock (vault KDF) | — | 508 ms |
| Seed derivation (PBKDF2 BIP-39) | — | ~460 ms |
| BIP-32 derivation | — | — |
| secp256k1 sign | — | — |
| Display | 240×240 colour | 128×64 mono |
| LED feedback | 4× RGB | none |
| Airgapped QR signing | **no camera** | planned |
| Blind signing, refusals, dice, temp seed | same | same |
| Companion support | same protocol | same protocol |
| Cost to a new user | **already owned** | ~$12–15 |
