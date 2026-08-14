# Camera and scanner options for airgapped QR signing

Costing exercise for [ROADMAP](../ROADMAP.md) **T58b**, feeding the **T58a** research spike.
The question this document answers is narrow: **what do we buy?**

It does not answer whether airgapped signing works. That is T58a, and T58a ends in a measurement
on a bench, not a web search. What follows is the shopping list that makes the measurement
possible, plus an honest account of which numbers vendors publish and which they do not.

---

## 1. Why the buying criterion is scan rate, and nothing else

The display half of QR signing already exists (`src/qrcode.c`). The missing half is input.

The screen is 128x64 monochrome, which caps a single QR frame somewhere around version 10-14 —
far short of a signed EIP-1559 transaction. So the transport is **animated QR**: BC-UR, the
fountain-coded multipart scheme Keystone uses, in both directions. That single fact reshapes the
purchase, because animated QR is a *stream*. The device is not photographing one code and
stopping; it is decoding frame after frame until the fountain converges.

Which means the decisive spec is **sustained reads per second in continuous mode**.

A module that scans on a trigger press is useless here — there is nobody to press it sixty times.
A module that manages two reads per second turns a signature into a thirty-second staring contest.
The spec that matters is therefore the one listings almost never print. Every vendor advertises
symbologies and "high speed"; almost none state a continuous decode rate.

> **This document's main finding is a negative one:** for every onboard-decoding module we
> costed except one, the continuous scan rate is **not published anywhere we could find** —
> not in the datasheet, not in the vendor wiki, not in the library headers. The one module that
> does publish it publishes a number that rules it out.

That is not a reason to stall. It is a reason to buy two cheap modules and measure, which is
exactly what T58a says to do and costs about $35.

**Marking convention.** Every claim below is tagged:
- **[datasheet]** — read out of a vendor manual or vendor source code we opened directly.
- **[listing]** — from a reseller or vendor store page.
- **[inferred]** — our reasoning, not anyone's measurement.
- **[NOT FOUND]** — we looked and could not confirm it. Treat these as bench work.

**On links.** AliExpress listings rot, get relisted, and change seller within months. **Part
numbers are load-bearing; links are not.** Search the part number, ignore the URL.

---

## 2. Onboard-decoding scanner modules

These decode in their own silicon and hand us a decoded string over UART or I²C. They sidestep
the framebuffer, the decoder, *and* the PSRAM dependency in T58c all at once. That is why T58b
says to cost them first.

### 2.1 The Grow GM-family — GM65 / GM66 / GM77

Hangzhou Grow Technology. One manual covers the family; the variants differ in packaging and
optics, not protocol. GM65 is the bare board, GM66 is enclosed with a mounting plate, GM77 adds
white illumination and red aiming for low light.

We read the GM66 V1.3 manual directly. Findings:

- **Interface:** UART TTL (default 9600 8N1) or USB. Wiring is VCC / GND / TX / RX — **4 pins**,
  plus an optional trigger key. **[datasheet]**
- **Sensor:** 648x488 CMOS. 5 V supply, ~120 mA scanning / 30 mA standby. **[datasheet]**
- **Symbologies:** QR, Data Matrix, PDF417, plus the usual 1D zoo. **[datasheet]**
- **Default mode is continuous** — "reading module read code continuous and automatic. Break
  after reading one code, break time is changeable." Default read interval **1.0 s**, default
  single-read timeout 3 s. Out of the box, this is roughly **one read per second**, which would
  be miserable. **[datasheet]**
- **The interval is configurable to zero.** This is the important find. Serial zone bit `0x0005`
  is "Read interval, `0x00`-`0xFF` : 0.0-25.5 s". `0x00` means no break — back-to-back reads.
  The printed setup-barcode sheet also carries an explicit "No break" option. **[datasheet]**
- **Configuration does not require Windows.** Section 8 of the manual documents a full serial
  instruction set with CRC-CCITT framing, readable and writable from the host MCU. Setup
  barcodes exist as an alternative, not a requirement. Mode select is a zone bit
  (`10` = continuous), as is the interval. So the ESP32 can put the module into
  zero-interval continuous mode at boot, over the same UART it reads from. **[datasheet]**

What we could **not** confirm:

- **Actual sustained decode rate with the interval set to zero. [NOT FOUND]** Setting the break
  to 0.0 s removes the *artificial* delay; it says nothing about how long the engine itself takes
  per frame. The "15 m/min scan speed" quoted for GM77 is a linear-barcode swipe rate and tells
  us nothing about 2D throughput. **[listing]** This is the number to measure.
- **Maximum QR payload per scan. [NOT FOUND]** The manual caps length for the 1D symbologies
  (32 or 255 characters, per type) but states no ceiling for QR. The "max 256 bytes" figure in
  the manual refers to configuration-register reads, not decoded output — do not confuse them.
- **Same-code suppression.** Later manual revisions (GM65 V1.7 / GM65-S) describe a "same barcode
  reading delay" that refuses to re-report an identical code within a window. The V1.3 text we
  read does not. This is mostly harmless for BC-UR, whose consecutive frames differ — **but an
  animated QR loop repeats**, so if suppression is present and long, it will eat frames on the
  second pass. Verify it can be disabled. **[inferred risk]**

**Price:** AliExpress GM65 around **$19**, GM66 and GM77 in the same $20-25 band **[listing]**;
clones below $20 are routine. DFRobot sells the identical GM65 as DFR0660 for **$49.90** and the
GM77 for **$55.90** **[listing]** — the same hardware at 2.5x, buying you support and a wiki.

### 2.2 M5Stack Unit QRCode (U173)

A 640x480 engine behind an STM32F030 that does bus conversion.

- **$18.50**, HY2.0-4P Grove connector — **4 pins, no soldering**. **[listing]**
- **I²C (address 0x21) or UART, selected by a physical switch on the side.** **[datasheet]**
- QR, Data Matrix, PDF417 and 14 1D types. **[datasheet]**
- **Auto-scan is togglable purely over the wire.** M5's own library exposes `setTriggerMode(AUTO_SCAN_MODE)`,
  `getDecodeReadyStatus()`, `getDecodeLength()`, `getDecodeData()` against registers 0x0010 /
  0x0020 / 0x1000. No PC tool, no printed setup barcodes. **[datasheet — vendor library headers]**
- **Continuous scan rate: [NOT FOUND].** Absent from the docs page, the store page, and the
  library. There is not even a decode-interval constant to reason from.
- **Max payload: [NOT FOUND].** `getDecodeData(uint8_t*, uint16_t len)` declares no maximum;
  the real ceiling is whatever buffer the unpublished STM32 firmware holds. Do not assume it
  is generous.

Address 0x21 does not collide with the SSD1306 at 0x3C, so this can share the existing I²C bus
on GPIO 8/9 and cost us **zero additional GPIOs**. That is a genuine advantage on a board where
10/5/6/7 are buttons and 35/36/37 are reserved against T58c.

### 2.3 Useful Sensors Tiny Code Reader

The best-documented module in the entire survey, and the documentation is what rules it out.

- **$7.00**, 4-wire Qwiic/STEMMA-QT I²C, address 0x0C (fixed). **[listing / datasheet]**
- **Free-running: no trigger, it always decodes.** **[datasheet]**
- **Continuous rate: ~5 Hz.** The vendor states the model "runs about five times a second",
  ~200 ms latency per detection. **[datasheet — published, explicit]**
- **Max payload: 254 bytes.** The I²C read returns a fixed 256-byte struct: `uint16 length` +
  `uint8 content[254]`, UTF-8, unwrapped. **[datasheet — published, explicit]**
- **QR only.** The vendor is explicit that it is not a multi-format reader. **[datasheet]**

Credit where due: this is the only vendor in the survey that published the number we asked for.
Unfortunately it is 5 fps against a **hard** 254-byte payload wall, and the vendor's own docs
suggest senders "decrease FPS" to suit it. A BC-UR fragment routinely exceeds 254 bytes. Two
independent disqualifications. **Do not buy this for T58** — though at $7 it is a fine part for
some other job.

### 2.4 DFRobot Gravity Ring 2D QR scanner (SEN0486)

- **$39.90**, GM60-class engine, Gravity 4-pin, UART **and** I²C, 3.3 V/5 V, <70 mA,
  640x480, RGB indicator. **[listing]**
- QR, Data Matrix, PDF417 + the 1D set. **[datasheet]**
- **Continuous scan rate: [NOT FOUND]** — absent from the DFRobot wiki.
- **Max payload: [NOT FOUND]** — absent from the wiki; the `DFRobot_GM60` library documents
  `detection()` returning "the scanned data as a character string" with no buffer constant.

Twice the price of the M5Stack unit, same unknowns, no better documented. No reason to prefer it.

### 2.5 Waveshare Barcode Scanner Modules (B / C / D / E)

A family of UART+USB modules, several explicitly listing **sensing, continuous and manual**
modes, UART default 9600 8N1. **[listing]** We could not reach the Waveshare wiki (HTTP 403), so
everything here is reseller-grade. **Continuous scan rate: [NOT FOUND]. Max payload: [NOT FOUND].**
Generally pricier than the GM-family clones for no documented advantage. Not recommended, but
not disqualified either — just uninvestigable from here.

---

## 3. Can these read what we need?

UR / BC-UR encodes as **uppercase alphanumeric**, which lands in QR's alphanumeric mode — denser
than byte mode and well within every engine's symbology support. Encoding is not the problem.

Two things are:

1. **Payload ceiling per scan.** Only two numbers in this survey are known: the Tiny Code
   Reader's 254 bytes (fatal) and everyone else's silence. A low ceiling does not break BC-UR —
   the sender can shrink the fragment size — but it raises fragment count, and fragment count
   multiplies against scan rate to set total scan time. A 254-byte cap and 5 fps compound
   badly. **This is why payload and rate must be measured together, not separately.**
2. **Output framing.** The Tiny Code Reader returns a length-prefixed raw struct **[datasheet]**.
   The GM-family emits decoded data on the UART with optional configurable prefix/suffix and
   CODE ID **[datasheet]** — meaning we can turn the decoration off and get a clean payload, or
   leave a CODE ID on to distinguish symbologies. M5Stack returns length + data via registers
   **[datasheet]**. All three are workable; none forces us to parse vendor cruft.

**Windows-only configuration is not a risk for the two modules we recommend.** GM-family mode and
interval are settable by serial command from the host MCU; M5Stack's auto-scan is settable over
I²C from the host MCU. Both verified in vendor documentation/source. This was a real concern
going in and it turned out not to bite.

---

## 4. Low-pin camera alternatives

For completeness, and the short answer is that they do not help.

**ArduCam Mega 3MP / 5MP (SPI).** ~$16-25 / ~$22-40 **[listing]**. Genuinely 4-wire SPI plus
power — about 6 wires against the OV7670's 18, which is the one real win. But **SPI clock tops
out at 8 MHz** **[listing]** = 1 MB/s, and that ceiling dominates everything:

- QVGA RGB565 raw = 153.6 KB = **~154 ms of pure transfer**, ~6.5 fps before any decoding.
- QVGA grayscale = 76.8 KB = ~77 ms.
- JPEG shrinks transfer to ~10 ms but adds a decode: measured ESP32-S3 JPEG decode of a
  272x233 image is **~20-23 ms** with a SIMD-accelerated decoder, ~55 ms with accelerated
  TJpgDec, ~109 ms plain. **[blog benchmark, S3-specific]**

So JPEG-over-SPI wins on wall clock (~35 ms vs ~77 ms) but spends ~25 ms of the exact CPU quirc
needs. Worse, **JPEG subsampling and ringing on sharp black/white edges are actively hostile to
QR module-boundary detection**, especially on the dense high-version frames BC-UR produces.
**[inferred, but the mechanism is well understood]**

Decoding still lands on us either way. That is the whole point: a raw camera of *any* pin count
buys us nothing on the part that is actually expensive. **Pin count was never the bottleneck.**

**Himax HM01B0** — 320x240 native grayscale, ~4 wires in 1-bit mode, which is exactly the format
quirc wants with no conversion pass. The catch is there is no ESP-IDF `esp32-camera` driver; we
would write LCD_CAM capture ourselves. **[inferred]** Interesting, not for a first attempt.

Note also the ESP32-S3 has no MIPI-CSI (that is the P4) and its LCD_CAM peripheral is DVP-native,
so any non-DVP sensor means SPI or bit-banging.

---

## 5. The OV7670 we already own

Technically viable, and we should be honest that "viable" is doing a lot of work.

OV7670 is on the supported list in Espressif's `esp32-camera` driver **[datasheet]**, so the
capture side is solved. The decode side is where it goes wrong.

**The measurement we wanted does not exist.** No one has published quirc timings on ESP32-S3 at
QVGA. We are not going to invent one. The single hard data point we found is Espressif's own
`qrcode-demo` sample output on an ESP32-S3-EYE, 240x240, PSRAM enabled, likely 240 MHz
**[datasheet — vendor example output, not a controlled benchmark]**:

| stage | time |
|---|---|
| `time_find_ms`, **no** QR in frame | ~22 ms |
| `time_find_ms`, **QR present** | **~229 ms** |
| `time_decode_ms` | ~3 ms |

That split is the finding. **quirc's cost is dominated by the identify stage, and it gets roughly
10x more expensive precisely when a code is present** — which is the only case that matters to us.
The Reed-Solomon stage is free by comparison. For scale, quirc's author quotes ~50 ms for a VGA
frame on a modern x86 core; a 160 MHz LX7 being 1-2 orders slower is consistent with 229 ms at
240x240.

Scaling that one point to our board **[inferred, clearly labelled — this is arithmetic, not
measurement]**:

- 240x240 → QVGA 320x240 is 1.33x the pixels → **~300 ms**
- 240 MHz → our **160 MHz** is 1.5x → **~450 ms/frame ≈ 2 fps**
- plus capture and YUV→grayscale conversion

**Call it 1.5-2.5 fps sustained at QVGA.** Maybe 3-4 fps with every lever pulled: 240 MHz clock,
240x240 or smaller, YUV422 capture using the Y plane directly (never RGB565→gray), quirc's buffer
pinned to internal SRAM, and capture/decode split across the two cores — that last one is the
best single lever, since the two stages pipeline cleanly.

**RAM.** From reading quirc's source **[datasheet — code, not benchmark]**: with the default
`QUIRC_MAX_REGIONS` of 254, `quirc_pixel_t` is `uint8_t` and the pixel buffer aliases the image
buffer, so the footprint is about **w x h + a few KB** — ~57 KB at 240x240, ~77 KB at QVGA,
~307 KB at VGA. Raise `QUIRC_MAX_REGIONS` above 254 and you lose the aliasing and pay 3x. Don't.

**This changes the PSRAM story.** At QVGA, quirc's 77 KB plus a grayscale framebuffer's 77 KB is
~154 KB, which **plausibly fits in the S3's internal SRAM** if we capture grayscale directly.
**[inferred]** The popular Arduino wrapper's "PSRAM required" error is a wrapper decision made for
the classic ESP32's smaller DRAM, not an architectural requirement. And if we *did* enable PSRAM,
quirc's working buffer should stay internal anyway — PSRAM is slower, so putting it off-die makes
229 ms *worse*. So the camera path may not force T58c after all, which is a point in its favour
that we did not expect.

**Verdict: not fast enough to be pleasant, but possibly not fatal.** BC-UR is fountain-coded, so
dropped frames cost time, not correctness — a sender animating at 4-8 fps against a receiver
managing 2-3 fps still converges. For a transaction of maybe 10-30 fragments, expect **10-20
seconds of holding the device up to a screen**. Tolerable. Not good. And T58a's bar is explicitly
*pleasant*, not merely *possible*: "a camera that cannot decode fast enough to be pleasant is
worse than none."

The 18 pins the user dislikes are, ironically, the least of its problems.

---

## 6. Comparison

Rate and payload are the two columns that decide this, and they are mostly empty. That is the
result, not an omission.

| Module | Pins | Interface | Price | Continuous rate | Max payload | Continuous mode set from host? |
|---|---|---|---|---|---|---|
| **M5Stack Unit QRCode (U173)** | 4 | I²C 0x21 **or** UART | **$18.50** | **NOT FOUND** | NOT FOUND | **Yes**, I²C registers |
| **Grow GM65 / GM66 / GM77** | 4 | UART (or USB) | **~$19-25** AliExpress; $49.90 DFRobot | **NOT FOUND**; interval settable to 0.0 s | NOT FOUND for QR | **Yes**, serial commands |
| Useful Sensors Tiny Code Reader | 4 | I²C 0x0C | $7.00 | **~5 Hz** (published) | **254 B** (published) | n/a — always free-running |
| DFRobot Gravity Ring (SEN0486) | 4 | UART or I²C | $39.90 | NOT FOUND | NOT FOUND | Presumably |
| Waveshare Scanner (B/C/D/E) | 4 | UART + USB | ~$25-40 | NOT FOUND | NOT FOUND | Unknown (wiki 403) |
| ArduCam Mega 3MP (SPI) | ~6 | SPI @ 8 MHz | ~$16-25 | ~6.5 fps transfer ceiling | n/a — we decode | n/a |
| **OV7670 (owned)** | 18 | DVP parallel | owned (~$3) | **~2 fps** decoded (inferred) | n/a — we decode | n/a |

---

## 7. Recommendation

**Buy both the M5Stack U173 and a GM65 clone. About $35 total.**

Neither vendor publishes the one number that decides this, so the honest move is not to pick a
winner from listings — it is to buy the two plausible candidates and measure them. $35 is less
than the cost of being wrong once. This is precisely what T58a asks for: *measured, not assumed*.

**Buy first — M5Stack Unit QRCode U173, $18.50.** Four pins on a Grove connector, no soldering,
and at I²C address 0x21 it shares the existing bus with the SSD1306 at 0x3C for **zero additional
GPIOs** — which matters on a board where 10/5/6/7 are buttons and 35/36/37 are mortgaged to T58c.
Auto-scan toggles over I²C from firmware with an open vendor library. Fastest path to a bench
number.

**Buy alongside — Grow GM65 (or GM66 if you want the enclosure), ~$19-25 on AliExpress.** Buy the
clone, not DFRobot's $49.90 DFR0660: identical hardware, and the Grow manual is the real datasheet
either way. This is the rate hedge. It is the only module in the survey with a *documented*
mechanism for back-to-back continuous reads — zone bit `0x0005` set to `0x00` — and it is
host-configurable over the same UART we read from. Sensor is 648x488 against the M5's 640x480, so
it should tolerate denser frames. Costs one UART's worth of GPIOs.

**Do not buy the Tiny Code Reader for this.** 5 fps and a 254-byte hard cap, both published, both
disqualifying. It is the only module we could rule out on evidence, which is worth something.

**Skip the ArduCam SPI modules.** The 8 MHz bus and JPEG edge artifacting make them a lateral move
at best. Pin count is not our bottleneck; decode time is, and they do not touch it.

**What to do with the OV7670: keep it, do not build on it yet — but flash `espressif/qrcode-demo`
onto the S3 with it and read `time_find_ms` on our own frames.** That is an afternoon's work and
it replaces every inferred number in section 5 with a measurement. If it comes back near 450 ms
we have our answer and the scanner modules win outright. If it comes back materially faster, the
camera path reopens — and with it T62's entropy idea, which needs a real camera and cannot be fed
by a scanner module that only ever emits decoded strings.

### Open items for the bench, in priority order

1. Sustained decoded frames/second, M5 U173 and GM65, against a real animated BC-UR stream —
   not a static code. **The whole purchase turns on this.**
2. Maximum QR payload accepted per scan by each. Measure by encoding progressively longer
   uppercase-alphanumeric payloads until decode fails.
3. Whether same-code suppression exists on the GM-family firmware we actually receive, and
   whether it can be disabled — an animated QR loop repeats, and suppression would eat frames
   on the second pass.
4. `time_find_ms` from `espressif/qrcode-demo` on our own board, with the OV7670, at 160 MHz
   and at 240 MHz.

Nothing above is worth trusting more than an hour on a bench with a real stream.

---

## Sources

Vendor documentation:
- [GM66 user manual V1.3 (Hangzhou Grow Technology)](https://www.sunrom.com/download/768.pdf) — read directly; continuous mode, zone bits, serial protocol
- [GM65 user manual V1.3](https://www.sunrom.com/download/767.pdf) · [GM65 V1.7](https://uelectronics.com/wp-content/uploads/2022/03/GM65-Barcode-reader-mudule-User-Manual.pdf)
- [M5Stack Unit QRCode docs](https://docs.m5stack.com/en/unit/Unit-QRCode) · [M5Unit-QRCode library](https://github.com/m5stack/M5Unit-QRCode) · [store U173](https://shop.m5stack.com/products/qr-code-scanner-unit-stm32f030)
- [Tiny Code Reader datasheet](https://cdn-shop.adafruit.com/product-files/5744/TCR-Datasheet.pdf) · [developer docs](https://github.com/usefulsensors/tiny_code_reader_docs/blob/main/README.md) · [SparkFun](https://www.sparkfun.com/useful-sensors-tiny-code-reader.html)
- [DFRobot DFR0660 / GM65](https://www.dfrobot.com/product-1996.html) · [GM77](https://www.dfrobot.com/product-2480.html) · [SEN0486 wiki](https://wiki.dfrobot.com/sen0486/) · [DFRobot_GM60](https://github.com/DFRobot/DFRobot_GM60)
- [Waveshare Barcode Scanner Module](https://www.waveshare.com/barcode-scanner-module.htm) · [Module (C)](https://www.waveshare.com/barcode-scanner-module-c.htm)

Decode performance:
- [espressif/qrcode-demo](https://github.com/espressif/qrcode-demo) · [qrcode_demo_main.c](https://github.com/espressif/qrcode-demo/blob/main/main/qrcode_demo_main.c) — the 22 ms / 229 ms figures
- [espressif/quirc component](https://components.espressif.com/components/espressif/quirc) · [dlbeer/quirc](https://github.com/dlbeer/quirc) · [quirc project page](https://dlbeer.co.nz/oss/quirc.html)
- [espressif/esp32-camera](https://github.com/espressif/esp32-camera) — OV7670 support
- [alvarowolfx/ESP32QRCodeReader](https://github.com/alvarowolfx/ESP32QRCodeReader) — source of the "PSRAM required" claim
- [atomic14: a faster ESP32 JPEG decoder](https://www.atomic14.com/2023/09/30/a-faster-esp32-jpeg-decoder) · [perf tests](https://github.com/atomic14/esp32-jpeg-perf-tests) · [espressif/esp_jpeg](https://components.espressif.com/components/espressif/esp_jpeg)

Cameras:
- [CNX: ArduCam Mega SPI](https://www.cnx-software.com/2022/12/21/arducam-mega-3mp-5mp-spi-camera-for-microcontrollers/) · [ArduCAM Mini 2MP](https://www.arducam.com/arducam-2mp-spi-camera-b0067-arduino.html)
- AliExpress GM65 listing observed at $19.36 — part number `GM65`, link deliberately omitted as listings drift
