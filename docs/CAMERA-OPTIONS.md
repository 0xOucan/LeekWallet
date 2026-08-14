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

That is not a reason to stall. It is a reason to buy a module and measure, which is exactly what
T58a says to do.

> **Revision note.** This document's first pass ended at "buy two modules, about $35". That was
> rejected as too expensive, and the context then changed again: the wallet is becoming a
> **product**, hand-assembled and shipped, so **pin count and assembly simplicity now outrank
> price**. Sections 7-9 are the second pass. The short version: a cheaper and better-specified
> UART module exists (**GM802**, §7.1), but the zero-GPIO I²C unit is now worth its premium
> (§8.1), and the price of the spike falls from $35 to **$18.50** either way.

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

**Price:** AliExpress GM65 around **$19** **[listing]**; clones below $20 are routine. DFRobot
sells the identical GM65 as DFR0660 for **$49.90** and the GM77 for **$55.90** **[listing]** —
the same hardware at 2.5x, buying you support and a wiki.

> **Correction (budget pass).** An earlier revision put GM66 and GM77 "in the same $20-25 band".
> That is wrong at the top end: a GM77 AliExpress listing was observed at **$42.59** **[listing]**,
> and Grow's own wholesale sheet quotes GM77 at $22/pc in quantity **[listing]**. GM77 is the
> expensive member of the family, not a peer of the GM65. It is also the wrong member for us:
> its extra cost buys white illumination and a red aimer for low light, and we are reading a
> self-illuminated LCD. **The cheap members of this family are GM802 and GM805 — see §7.**

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

The 18 pins the user dislikes are, ironically, the least of its problems — though under the
product ranking adopted in §7 they are now disqualifying on their own.

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
| **OV7670 (owned)** | 18 | DVP parallel | owned (<$2) | **~2 fps** decoded (inferred) | n/a — we decode | n/a |
| **GROW GM802-S** (§7.1) | 4, **3.3 V** | UART (or USB) | **~$9.90** | **NOT FOUND**; interval settable to 0.0 s | NOT FOUND for QR | **Yes**, serial zone bits |
| GROW GM805-S | 4, 5 V | UART (or USB) | ~$9.60 | as GM802 | NOT FOUND | Yes |
| ESP32-CAM + quirc (§7.2) | 4 (UART to wallet) | UART | ~$5-7 (+$2 flasher) | **~3-4 fps inferred**, NOT FOUND | ours to choose | it's our firmware |
| Bare OV2640 24-pin (§7.3) | 18 | DVP parallel | ~$5 | n/a — we decode | n/a | n/a |
| Phone camera (§7.4) | 0 | BLE / optical | **$0** | fast | large | n/a — **breaks the airgap inbound** |

**Additional GPIOs consumed on the wallet**, which is now the first-ranked criterion: M5 U173
**0** (shares I²C 8/9 at address 0x21); GM802 / GM805 / GM65 / ESP32-CAM **2** (one UART pair);
OV7670 / bare OV2640 **~12-18**; phone **0**.

---

## 7. The budget tier: under $10

$35 was costed as "two candidates, measure both". It is a research budget, not a bill of
materials, and it is a fair objection that it is more than the whole rest of the wallet. This
section asks the narrower question: **what is the cheapest thing that actually gets QR data into
the S3?**

The discipline from §1 does not relax here. A $6 module with an unpublished scan rate is not a
bargain, it is a cheaper gamble. The one thing the budget tier must not do is buy a *worse*
unknown to save $12.

> **The ranking changed mid-survey, and it matters.** The context is now a **product**: the
> ESP32-S3-N16R8 is settled as the core, and the intent is to hand-solder wallets and ship them
> to people who ask, with the DIY build staying open and buildable. That makes **low pin usage a
> first-class requirement**, not an aesthetic preference — spare GPIOs are what keep custom
> builds and future peripherals possible on a board where 10/5/6/7 are buttons and 35/36/37 are
> mortgaged to T58c.
>
> **Rank on pin count first, assembly simplicity second, price third.** Price still binds — $35
> was rejected — but **a $6 part costing 12 GPIOs or a second board to flash is now worse than a
> $15 part costing 2 pins and one solder step.** Sections 7.2 and 7.3 were costed under the old
> ranking and are re-judged against the new one below.

### 7.1 GM802 — the finding of this pass

The GM-family is bigger than the GM65/66/77 the first survey looked at. Grow also sell **GM802**
and **GM805**, marketed as the small/cheap end of the same line, and **they are the same protocol**.

We pulled the **GM805 series manual V1.2.1 (100 pages)** and read it directly. It is the same
document architecture as the GM66 V1.3 manual — same read modes, same CRC-framed serial
instruction set, same zone-bit map:

- **Continuous mode is §3.1 and is the default.** Verbatim: "reading module read code continuous
  and automatic. Break after reading one code, break time is changeable." **[datasheet]**
- **Zone bit `0x0005` is "Read interval", `0x00`-`0xFF` = 0.0-25.5 s, and the manual explicitly
  annotates `0x00`: "No interval".** This is the exact register the first survey found on the
  GM66 — **it is present on this family too.** **[datasheet]**
- **Zone bit `0x0004` is time-for-single-read; `0x0006` is image-stabilisation time.** Break time
  default 1.0 s, single-read default 5 s. **[datasheet]**
- **Same-barcode reading delay is a documented, switchable feature (§ zone bit `0x0013`/`0x0014`,
  bit 7 = on/off, delay time in 100 ms units, `0x00` = infinite).** Crucially the manual's printed
  default is **"Same bar code reading without delay"** — the starred default option.
  **[datasheet]** This is the §2.1 "inferred risk" resolved: on this family the suppression exists,
  is off by default, and is switchable from the host. **That is a real de-risking, and it is on the
  cheap part, not the expensive one.**
- Serial-command configuration (read/write/save zone bit, CRC-CCITT) is §10, host-driven, no
  Windows tool required. **[datasheet]**
- Sensor **640x480 CMOS**, default UART **9600 8N1**. **[datasheet]**

And the part that decides it:

- **GM802 runs on DC 3.3 V**, 70 mA max, ~6 mA standby, UART/USB, 640x480 CMOS.
  **[datasheet — Grow product page]** GM805 is the 5 V version of the same thing.

**The GM65/GM66 are 5 V parts.** On a 3.3 V S3 that means a supply rail we may not have and a
level-shift consideration on the module's RX. **GM802 removes that entirely.** It is cheaper *and*
electrically simpler than the module §7 originally recommended as the rate hedge.

**Price: $9.90 at qty 1, $9.50 at 2-9, $8.00 at 10+ from Grow via Alibaba; Made-in-China lists the
series at $9.50/pc. [listing]** GM805 quotes ~$9.60. **[listing]**

- **AliExpress availability at that price: [NOT FOUND].** We found GM802/GM805 on Alibaba,
  Made-in-China and Indian resellers (Hubtronics), not on an AliExpress listing we could price.
  Search AliExpress for `GM802`, `GM802-S`, `GM803`, `GM805` before assuming it is absent —
  these are recent parts and listings lag. If AliExpress has nothing, Alibaba at $9.90 is still
  inside budget, at the cost of slower shipping.
- Take **GM802-S** (5-30 cm), not -L (7-50 cm). We are reading a 128x64 screen at desk distance.
- **Continuous decode rate: still [NOT FOUND].** Same silence as every other module. What has
  changed is that the *cheap* option now carries the same documented interval and suppression
  controls as the expensive one, so the gamble is no longer a worse gamble — just a cheaper one.
- **Max QR payload: [NOT FOUND].** Same as GM66.
- `GM803` appears in the same release wave, described by Grow as "serial small cheap DC3.3V";
  we did not read its manual. **[listing]** Likely a peer of GM802.

### 7.2 ESP32-CAM as a scanner module

The idea: put an **ESP32-CAM** (classic dual-core ESP32-S at 240 MHz, OV2640 with hardware JPEG,
4 MB PSRAM, ~$5) in front of the wallet, run `esp32-camera` + `quirc` **on it**, and emit the
decoded string over UART. The wallet then sees exactly what a GM802 gives it: power, ground, and
a serial line carrying text. Structurally a scanner module, at scanner-module price, with source
we control.

It is a genuinely good idea and it survives costing better than expected.

**Price.** AliExpress listings observed at **$4.93** for ESP32-CAM with OV2640 included
**[listing]**; the "original Ai-Thinker" branded listing sits nearer **$11.57** **[listing]**;
$7 is the long-standing typical figure **[listing]**. Ignore the $1.09 listing that surfaces in
search — that is an accessory, not the board. **Call it $5-7 for a clone, $12 for genuine
Ai-Thinker.**

**PSRAM.** The AI-Thinker reference design has **520 KB SRAM + 4 MB external PSRAM**
**[listing/datasheet]**, and clones mostly follow it because the camera examples need it. But
**"PSRAM init failed" and "no PSRAM found" on ESP32-CAM clones is a well-documented and common
failure** **[listing — forum/issue traffic on esp32.com, easytarget/esp32-cam-webserver #287,
Random Nerd troubleshooting]**, and there are ESP32-CAM variants shipped without it. The
mitigation is known: `config.fb_location = CAMERA_FB_IN_DRAM;` **[listing — Arduino forum,
arduino-esp32 PR #6219]**. **This matters less to us than to a webcam project**, because §5
already established that quirc's working buffer *should stay internal anyway* — PSRAM is slower,
and putting the identify stage off-die makes it worse. At 240x240 grayscale we need roughly
57 KB + framebuffer, which fits DRAM. **So a no-PSRAM clone is an inconvenience here, not a
brick.** **[inferred, from §5's RAM arithmetic]**

**Frame rate.** This is where honesty is required, and it splits into two numbers people confuse.

*Capture* is fast and measured. An arXiv benchmark of the ESP32-CAM/OV2640 reports **~44 FPS at
320x240 and ~43 FPS at 240x240**, JPEG, dropping to ~14 FPS at VGA **[datasheet — published
benchmark, ESP32-CAM specific]**. Capture is not the bottleneck and never was.

*Decode* is the bottleneck and is **[NOT FOUND]** for this board. The only anchor remains
Espressif's `qrcode-demo` output quoted in §5: **~229 ms `time_find_ms` with a QR present, ~22 ms
without, ~3 ms decode**, at 240x240 on an ESP32-S3-EYE. We searched specifically for published
quirc timings on the classic ESP32 and **found none** — the tutorials (Random Nerd, Last Minute
Engineers, CircuitDigest) all show working sketches and **none publishes a frame rate or a
latency**. Last Minute Engineers' only performance remark is that you may have to "slowly move the
QR code closer to and further away from the camera until it's recognized" — which is the texture
of a slow, fussy decoder, not a number. **[listing]**

Scaling **[inferred, clearly labelled]**: the ESP32-CAM's LX6 at 240 MHz against the S3's LX7 at
240 MHz is *slower per clock* for this workload — the S3 has the PIE SIMD extensions that the
JPEG benchmark in §4 exploited and the LX6 does not, though stock quirc does not use them either.
Assume **rough parity to 1.5x worse: ~230-350 ms per frame with a code present, i.e. 3-4 fps** at
240x240. The one structural advantage is real: **the ESP32-CAM is dual-core**, and capture/decode
pipeline cleanly across two cores — the same lever §5 identified as the best one, except here it
costs us nothing on the wallet's own CPU because it is a different chip.

**Wiring.** Four wires: 5 V, GND, and a UART pair. The ESP32-CAM has no USB-serial on board, so
you also need a **USB-TTL adapter (~$1-2) or an ESP32-CAM-MB baseboard (~$2)** to flash it once
— and GPIO0 must be pulled low to enter download mode. **[listing]** That is a one-time cost,
not a per-unit one, and the user likely owns a USB-TTL already.

**Verdict under the product ranking: drop it.** Costed as a hobby trick this is elegant. Costed
as something you hand-solder into units and ship to strangers, it is a **second board to source,
mount, power, flash and support**, on a second architecture, with its own firmware to build,
version, sign and update — and no USB-serial on board, so assembly gains a USB-TTL adapter and a
GPIO0-low download dance *per unit*. It also adds a WiFi/BLE-capable MCU to a device whose entire
selling point is that it does not need one, and every buyer who asks "what is that other chip
doing" deserves a better answer than "nothing, we promise". Two boards is not a minimalistic DIY
build. **Keep it on the shelf as a bench instrument and as the only path to T62 (camera entropy),
which a decoded-string-only scanner can never feed. Do not put it in a shipped wallet.**

The paragraphs below are the hobby-build costing, retained because the reasoning is still sound
if the product framing ever loosens.

**Verdict as a hobby build: the strongest budget candidate on capability, the weakest on effort.**
For ~$6 you get
a 3-4 fps (inferred) onboard decoder whose firmware is *ours* — meaning we control the read
interval, the duplicate suppression, the payload ceiling and the output framing, none of which we
can control on a closed module and three of which are **[NOT FOUND]** on every closed module in
this document. That is a real answer to §1's complaint. The price is that we now maintain a second
firmware, on a second architecture, with its own build. **It is the right buy if the GM802 gamble
loses, and the right buy anyway if T62 (camera entropy) ever matters — a scanner module emits only
decoded strings and can never feed T62; an ESP32-CAM can hand over raw frames.**

One caveat worth stating plainly: the ESP32-CAM has WiFi and BLE radios on it. For an *airgap*
device, bolting a second wireless-capable MCU to the wallet is not free of argument. The radios
are ours to leave uninitialised, and the link is a one-way-ish UART, but "the scanner has a WiFi
stack" is a sentence that needs a good answer before this ships. **[inferred]**

### 7.3 Bare OV2640 vs the OV7670 already owned

Short answer: **not worth $4, and buy it anyway only if you are buying an ESP32-CAM.**

**Price: $5.00 at qty 1 on Alibaba for a 24-pin DVP OV2640, falling to $4.50 in tens
[listing]**; AliExpress 24-pin OV2640 modules for ESP32-CAM are widely listed, typically in the
$3-6 band **[listing]**. The OV7670 is famously **under $2** **[listing — Arducam comparison]**.

The upgrade buys three things: a hardware JPEG engine, better-documented registers, and being
the sensor Espressif actually built `esp32-camera` around and every tutorial targets
**[listing — Arducam, espboards comparisons]**. It costs one thing: nothing structural.

But **the pins are identical** — both are DVP, both want the same 12+ line parallel bus, both hit
LCD_CAM the same way. And §4/§5 already settled the decisive point: **pin count was never the
bottleneck, decode time is, and a different sensor does not touch decode time.** The JPEG engine
is *actively unhelpful* to us — §4 established JPEG ringing on sharp black/white edges is hostile
to QR module-boundary detection, and we want raw grayscale (the Y plane) anyway, which the OV7670
gives up directly.

So: **if you are driving the sensor from the wallet's own S3, the $4 buys you nothing you need,
and the OV7670 you own is the correct part.** The only reason to buy an OV2640 is that it is
physically the sensor an ESP32-CAM ships with (§7.2), in which case you did not buy it separately.

Note the incompatibility: **OV2640/OV3660/OV5640 share the 24-pin ribbon and swap freely on
ESP32-CAM boards; the OV7670 does not use that ribbon** **[listing — Arducam]**. The owned
OV7670 cannot be plugged into an ESP32-CAM.

### 7.4 Phone as scanner — $0, and the airgap question

The companion app in `app/` is already a Tauri v2 build targeting **Android over BLE** and desktop
over USB CDC (`app/README.md`). An Android phone has a camera, a mature QR decoder, and an existing
BLE link to the wallet. **The scanner already exists and costs nothing.**

It also mostly defeats the purpose, and the reason is worth being precise about rather than
hand-waving.

**What the phone route actually is.** The wallet displays an animated QR; the phone scans it. That
direction is fine — it is exactly what Keystone does, where the *phone* scans the *wallet's*
screen to broadcast a signed transaction **[listing — Keystone/Consensys docs]**. The problem is
the other direction. If the phone forwards the unsigned transaction to the wallet **over BLE**,
there is no airgap at all: there is a radio link into the wallet, which is precisely the thing
T58 exists to remove. Calling that "QR signing" would be a lie in the README.

**The honest framing:**

| Direction | Transport | Airgap intact? |
|---|---|---|
| Wallet → host (signed tx) | wallet screen → phone camera | **Yes.** Optical, one-way, no radio into the wallet |
| Host → wallet (unsigned tx) | phone screen → **wallet camera** | **Yes.** This is the half that needs hardware |
| Host → wallet (unsigned tx) | phone → **BLE** | **No.** This is the existing product, renamed |

So the phone replaces the *host-side* scanner, which we were never going to buy — the display half
already exists in `src/qrcode.c` and any phone can read it. It cannot replace the *wallet-side*
camera without collapsing the airgap into the BLE link we already have. **The $0 option solves the
half that was already free.**

Two things it is genuinely good for, and they are not nothing:

1. **It makes half of T58 shippable today with no hardware.** Display-only QR export — the wallet
   shows an animated signed transaction, the phone reads it, the phone broadcasts. The unsigned
   transaction still arrives over BLE, so this is *not* an airgap and must not be described as
   one, but it does remove the return path and it exercises the BC-UR encoder end to end. **That
   is a free, real integration test of the fountain encoder before any module is bought.**
2. **A phone with airplane mode on, used as a QR relay between an online machine and the wallet's
   camera, is the classic airgap workflow** — but that still needs the wallet-side camera.

**Verdict: viable as a bench tool and as a half-feature, worthless as a substitute for the
purchase.** Anyone who claims a wallet is airgapped while its transactions arrive over BLE from a
phone is describing a different property than the one the word means.

### 7.5 Things we looked at and would not buy

- **USB scanners over USB host.** The S3 has USB-OTG, so a $10-15 USB HID barcode gun is
  electrically possible. Cost: a USB host stack, a HID class driver, and 5 V bus power on a
  battery device, in exchange for a part with the *same* unpublished scan rate. Strictly worse
  than a $10 UART module on every axis. **[inferred]** Not costed further.
- **Salvaged scan engines** (from dead POS terminals, self-checkout units, old inventory guns).
  Genuinely near-free if one is to hand, and often a good engine. But the interface is
  undocumented, the pinout is undocumented, and the decode rate is — as ever — undocumented. This
  is a weekend of reverse engineering to save $10. **[inferred]** Not recommended, not condemned.
- **Tiny Code Reader at $7** remains in budget and remains disqualified on published evidence
  (5 Hz, 254-byte cap). Cheapness does not rescue it. See §2.3.

---

## 8. Recommendation

### 8.1 The product recommendation: pins first

Ranked on **pin count, then assembly, then price**, the survey produces a clear winner and it is
not the cheapest part.

**Ship the M5Stack Unit QRCode U173, $18.50. Offer the GROW GM802-S at ~$9.90 as the DIY-build
alternative.**

**Why the more expensive part wins.** The U173 speaks I²C at **address 0x21**. The SSD1306 sits at
**0x3C on GPIO 8/9**. They do not collide, so the scanner shares the bus the display already uses
and costs **zero additional GPIOs** **[datasheet]**. Nothing else in this document does that. On a
board being sold as a base for custom builds, a peripheral that consumes no pins is worth more
than $9 of savings — it is the difference between the QR feature and the *next* feature being
mutually exclusive or not. It also arrives as a cased unit on a keyed HY2.0-4P Grove cable:
**no soldering, no polarity mistake, one connector per unit, identical every time.** For
hand-assembling units that is the whole game.

**I²C-shared versus UART, on the grounds that matter for hand assembly:**

| | M5 U173 (I²C 0x21) | GM802-S (UART) | GM65/GM66 (UART) |
|---|---|---|---|
| Additional GPIOs | **0** — shares 8/9 | 2 | 2 |
| Connector | Keyed HY2.0-4P Grove, cable in box | Bare pads / FPC — **solder or crimp** | Bare pads / FPC |
| Level shifting | None, 3.3 V | **None, 3.3 V native** | **5 V part** — rail + RX shift |
| Enclosure mounting | Cased unit, mounting holes | Bare board, DIY standoffs | GM66 ships enclosure + plate |
| Per-unit assembly | Plug in | 4 joints, strain relief, mount | 4 joints + 5 V supply |
| Price | $18.50 | ~$9.90 | ~$19 |

The GM802 is a genuinely good part and the best thing found in this pass — **3.3 V native**,
documented `0x0005` read interval with `0x00` = no interval, same-barcode suppression documented
and defaulting to off, full host-side serial configuration **[datasheet]**. If you are building
one for yourself and have a soldering iron out anyway, it is the better buy and it saves $9. It
loses on exactly two axes, and both are product axes rather than engineering ones: **two GPIOs**,
and **four solder joints times every unit you ship**.

The 5 V GM65 the first pass recommended is now the worst of the three: same pin cost as the
GM802, twice the price, and a supply rail the board does not have.

**Keep the module optional — the base build must work with no camera at all.** QR is additive;
nothing in the wallet's core flows may require it. In practice that means:

- **Firmware:** the scanner is probed at boot and absent is a normal state, not an error. An I²C
  probe at 0x21 returning NAK simply means the QR panels are not offered.
- **Retrofit, I²C route:** bring **SDA / SCL / 3V3 / GND** out to a 4-pin header (or a Grove
  footprint) on every unit, populated or not. Adding a scanner later is *plugging in a cable* —
  no firmware reflash needed if the probe is already there, no GPIO reassignment, no risk to a
  device that already holds a seed. This is the strongest argument for the I²C route on a
  shipped product and it is worth designing in even for units sold without a scanner.
- **Retrofit, UART route:** two GPIOs must be reserved and named in firmware up front, or a
  retrofit means a reflash. Reserve them at design time or accept the reflash.

**The OV7670 is now disqualified for shipped units on pin count alone** — 18 DVP lines against a
requirement that spare pins be preserved. It stays exactly what §5 said it was: a bench
instrument for measuring quirc, and the T62 path. Same for the ESP32-CAM (§7.2).

**Total for the spike under the new ranking: $18.50 for one module, or $28.40 if you want the
GM802 alongside as the rate hedge** — still below the $35 that was rejected, and buying a shippable
part rather than two experiments.

**What you give up by taking the GM802 instead, to save $9:** two GPIOs permanently, four solder
joints per unit, a keyed connector, and a cased enclosure. **What you do not give up: any
information.** Neither vendor publishes the continuous scan rate or the payload ceiling. That
symmetry is why price alone never decided this.

<details>
<summary><b>The pure under-$10 answer, for the DIY builder</b></summary>

**Buy a GROW GM802-S, ~$9.90 at qty 1.** If you want a second opinion in the same budget, add an
ESP32-CAM clone at ~$5 and you are still under $15 for two independent candidates.

The GM802 is the right first buy for reasons that are documented rather than hoped:

- **3.3 V native.** No level shifting, no 5 V rail. The GM65 the first pass recommended is a 5 V
  part. **[datasheet]**
- **It carries the exact register that made the GM65 worth buying** — zone bit `0x0005` read
  interval, `0x00` = no interval — verified in the GM805-series manual, which covers this
  family. **[datasheet]**
- **Same-barcode suppression is documented, defaults to off, and is switchable from the host.**
  This was flagged as an unresolved risk in §2.1 and is now resolved *in our favour* on the
  cheap part. **[datasheet]**
- Full CRC-framed serial configuration from the MCU, no Windows tool. **[datasheet]**
- Half the price of the GM65, a fifth of a GM77.

**What you give up versus the $35 two-module plan:**

| | $35 plan (M5 U173 + GM65) | Under-$10 plan (GM802) |
|---|---|---|
| Candidates to measure | 2 | 1 (2 if you add the ESP32-CAM) |
| Soldering / connectors | None — Grove + no-solder | **Yes.** Bare board, flying leads or FPC |
| GPIO cost | Zero (M5 shares I²C at 0x21) | **One UART pair** |
| Supply | 3.3 V (M5) / 5 V (GM65) | 3.3 V |
| Vendor support | M5 wiki, open library, docs site | Manual PDF and nothing else |
| Continuous rate known? | **No** | **No** |
| Payload ceiling known? | **No** | **No** |
| Availability | Stocked, Western resellers | **Alibaba-ish; AliExpress presence unconfirmed** |

Read the last three rows carefully. **The premium buys convenience, support and pins — not
information.** Nobody sells the number that decides this.

</details>

### 8.2 Order of operations, free steps first

1. **$0 — before buying anything.** Flash `espressif/qrcode-demo` on the S3 with the OV7670 you
   already own and read `time_find_ms`. This is an afternoon and it replaces every inferred
   number in §5 with a measurement. If it comes back materially faster than the inferred ~450 ms,
   you may need to buy nothing at all.
2. **$0 — in parallel.** Ship display-side animated QR against a phone (§7.4). Proves the BC-UR
   encoder with no hardware. Do not call it an airgap.
3. **$18.50 — M5 U173.** The shippable candidate. Measure sustained decoded frames/second
   against a real BC-UR stream, and the payload ceiling.
4. **~$10 — GM802-S**, as the rate hedge if the U173 disappoints, or as the documented DIY
   alternative regardless.
5. **~$5 — ESP32-CAM**, bench only, and only if T62 becomes interesting.

Steps 1 and 2 are free and should happen before any money moves. **$18.50 buys the decision;
$28.40 buys the decision plus a hedge.** Both are under the $35 that was rejected.

**Do not buy a GM77.** Observed at $42.59 **[listing]**; its premium is illumination and an aimer,
for reading paper in the dark. We read a backlit screen.

**Do not buy the Tiny Code Reader**, cheap as it is: 5 fps and 254 bytes, both published, both
disqualifying (§2.3).

---

## 9. What selling assembled devices implies

Short, because it is a consequence to note rather than a design to settle here — but it changes
who carries risk, so it belongs written down.

**Whoever solders and flashes a device becomes the trust anchor for whoever buys it.** A DIY
builder flashing their own board trusts themselves. A buyer receiving an assembled wallet trusts
the assembler completely: the seed will be generated by whatever firmware is actually on that
flash, and the buyer has no way to inspect it.

**Web/WiFi flashing with published checksums is good UX and does not close that gap.** A checksum
proves that the image *you chose to download* matches the published build. It says nothing about
what was already on a device that arrived by post — a shipped unit could carry different firmware
entirely, and the buyer would have to reflash to find out, which is exactly the step a
non-technical buyer was being spared.

**That is what secure boot (T11) provides**, and the timing matters: the device must refuse to run
an image that is not signed by the project key, and that property comes from **eFuses burned
before shipping**, not after. Fuses burned by the buyer protect against later tampering but not
against the assembler. Fuses burned by the assembler at least bind the shipped unit to a published
signing key — a weaker claim than "you built it yourself", but a checkable one.

None of this blocks shipping units. It does mean **T11 stops being a hardening task and becomes a
prerequisite for selling assembled devices**, and the README should be plain about which of the
two things a given buyer is getting.

---

## 10. Open items for the bench, in priority order

1. **Sustained decoded frames/second, M5 U173 (and GM802 if bought), against a real animated
   BC-UR stream** — not a static code. **The whole purchase turns on this**, and it is the number
   no vendor in this survey except Useful Sensors publishes.
2. **Maximum QR payload accepted per scan.** Encode progressively longer uppercase-alphanumeric
   payloads until decode fails.
3. **Same-code suppression on the firmware we actually receive.** Documented and default-off on
   the GM802/GM805 family **[datasheet]**; **[NOT FOUND]** for the M5 U173, whose STM32 firmware
   is closed. An animated QR loop repeats, so suppression would eat frames on the second pass.
4. **`time_find_ms` from `espressif/qrcode-demo`** on our own board with the OV7670, at 160 MHz
   and 240 MHz. Free, and it retires every inferred number in §5.
5. **That the U173 really is silent at 0x21 when absent**, so the base build works with no
   scanner fitted (§8.1) and a retrofit needs no reflash.

Nothing above is worth trusting more than an hour on a bench with a real stream.

**Standing dispositions.** *Tiny Code Reader:* do not buy — 5 fps, 254-byte cap, both published,
both disqualifying; the only module ruled out on evidence. *ArduCam SPI:* skip — 8 MHz bus and
JPEG edge artifacting, and pin count was never the decode bottleneck. *OV7670 (owned):* keep as a
bench instrument, not a shipped part — 18 pins fails the first-ranked criterion — but do run
`qrcode-demo` on it, and note it is the only path to T62 entropy alongside the ESP32-CAM, since a
scanner module emits decoded strings and nothing else.

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

Budget tier (§7-8):
- [GM805 series user manual V1.2.1](https://robu.in/wp-content/uploads/2024/08/GM805.pdf) — **read directly (100 pp)**; §3.1 continuous mode, zone bits `0x0004`/`0x0005`/`0x0006`, "Read interval `0x00`: No interval", same-barcode reading delay (default *without delay*), §10 CRC serial instructions
- [GM802 series manual](https://hubtronics.in/docs/GM802.pdf) (403 to us; same family, same zone-bit map) · [GROW GM802 product page](https://en.hzgrow.com/product/189.html) — DC 3.3 V, 70 mA, 640x480 CMOS, UART/USB · [GM805 product page](https://en.hzgrow.com/product/191.html) · [GM803 announcement](https://en.hzgrow.com/news_1/1887010157474717696.html)
- [GM802-S on Alibaba](https://www.alibaba.com/product-detail/GROW-GM802-S-1D-2D-QR-1600464676789.html) — $9.90/1, $9.50/2-9, $8.00/10+ · [Made-in-China GM802 series](https://hzgrow.en.made-in-china.com/product/eZJGXaNjwvWF/China-Grow-GM802-Series-DC3-3V-USB-Ttl232-Barcode-Scanner-1d-2D-Qr-Bar-Code-Reader.html) — $9.50/pc · [Hubtronics GM802-L](https://hubtronics.in/grow-gm802-l-barcode-reader-module)
- GM77 observed at [$42.59 on AliExpress](https://www.aliexpress.com/item/1005003596679659.html) — the correction in §2.1
- [A Benchmark Reference for ESP32-CAM Module (arXiv 2505.24081)](https://arxiv.org/html/2505.24081v1) — ~44 FPS at 320x240, ~43 at 240x240, ~14 at VGA, JPEG. **Capture only, not decode**
- ESP32-CAM pricing: [$4.93 clone](https://www.aliexpress.com/item/32968206529.html) · [$11.57 Ai-Thinker](https://www.aliexpress.com/item/33051653631.html) · [Maker Advisor "$7 ESP32-CAM"](https://makeradvisor.com/esp32-cam-ov2640-camera/)
- ESP32-CAM PSRAM absence and the `CAMERA_FB_IN_DRAM` workaround: [esp32.com "PSRAM init failed"](https://esp32.com/viewtopic.php?t=31247) · [easytarget/esp32-cam-webserver #287](https://github.com/easytarget/esp32-cam-webserver/issues/287) · [Arduino forum: OV2640 without PSRAM](https://forum.arduino.cc/t/esp32-cam-how-to-use-ov2640-camera-without-psram/984220) · [Random Nerd troubleshooting](https://randomnerdtutorials.com/esp32-cam-troubleshooting-guide/)
- ESP32-CAM QR tutorials, none of which publish a frame rate: [Random Nerd](https://randomnerdtutorials.com/esp32-cam-qr-code-reader-scanner-arduino/) · [Last Minute Engineers](https://lastminuteengineers.com/esp32-cam-qr-code-scanner/) · [CircuitDigest](https://circuitdigest.com/microcontroller-projects/esp32-cam-qr-code-scanner)
- [Arducam: OV2640 vs OV7670](https://blog.arducam.com/ov2640-vs-ov7670-detailed-comparisons-and-resources/) — OV7670 under $2, 24-pin ribbon incompatibility · [espboards: ESP32 camera modules compared](https://www.espboards.dev/blog/esp32-camera-modules-compared/) · [OV2640 24-pin DVP, $5/1 on Alibaba](https://www.alibaba.com/product-detail/Factory-Price-2MP-DVP-24PIN-OV2640_1601070799367.html)
- Phone-as-scanner / airgap framing: [Consensys: MetaMask x Keystone transparent QR](https://consensys.io/blog/metamask-x-keystone-how-to-benefit-from-hardware-wallet-security-using-transparent-qr-code) · [Casa: QR code signing with Keystone](https://blog.casa.io/introducing-qr-code-signing-with-keystone/) · `app/README.md` (Tauri v2, Android/BLE + desktop/USB CDC)

Cameras:
- [CNX: ArduCam Mega SPI](https://www.cnx-software.com/2022/12/21/arducam-mega-3mp-5mp-spi-camera-for-microcontrollers/) · [ArduCAM Mini 2MP](https://www.arducam.com/arducam-2mp-spi-camera-b0067-arduino.html)
- AliExpress GM65 listing observed at $19.36 — part number `GM65`, link deliberately omitted as listings drift
