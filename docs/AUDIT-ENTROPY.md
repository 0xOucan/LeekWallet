# Entropy audit — seed generation

> **Status.** §1–§6 are the audit as first written, at `c27c082`. A later pass
> implemented R2, R3, R5, R6 and R7; §8 records exactly what changed and what
> the numbers are afterwards, and the findings in §5 are annotated **FIXED**
> where they no longer describe the code. Read §8 before acting on §5 or §7.

Scope: every path from silicon noise to a BIP-39 or SLIP-39 word list.
Reviewed at `c27c082`, against the pinned toolchain (`platformio.ini:17`,
`platform = espressif32@6.12.0`, which resolves to **ESP-IDF 5.5.0** —
confirmed from `~/.platformio/packages/framework-espidf/version.txt`).

Out of scope, owned elsewhere: `src/session.c`, `src/transport.c`, the vault
and passphrase code. They are named here only where they call into the gate.

Two defects found before this pass are already fixed and are not re-litigated:
the duplicate unchecked `random_buffer()` in `components/trezor-crypto/`, and
the RF flag that only the settings screen set. Both are now guarded —
`scripts/check-rng-unique.sh`, and `transport.c:89`.

---

## 1. The real entropy path

Every byte of key material reaches the caller through exactly one function.
There is no second path; the link-order accident that used to provide one is
now a build check.

```
esp_random()                       IDF 5.5.0, components/esp_hw_support/hw_random.c
  └─ esp_fill_random(buf, len)     entropy.c:268
       ↑ bootloader_random_enable() first, iff no radio is up   entropy.c:262-266
  └─ entropy_health_check(buf,len) entropy.c:285  ← on the RAW hardware bytes
       └─ fail ⇒ memzero(buf), return false      entropy.c:288-294
  └─ if a user pool exists, per 32-byte chunk:   entropy.c:311-330
       buf[off..] = SHA256("leek-entropy-mix-v1" ‖ hw_chunk ‖ idx
                           ‖ SHA256(pool) ‖ count_le32)
  ↑
random_buffer()                    src/rand_esp32.c:40 — abort() on false
  ↑
  ├─ mnemonic_generate(strength)   components/trezor-crypto/bip39.c:59
  │    └─ always draws 32 bytes, regardless of 12 or 24 words
  │    └─ mnemonic_from_data(data, strength/8)  → 16 or 32 bytes used
  ├─ slip39_random()               src/slip39-backup.c:61-67
  ├─ session_begin() device key    src/session.c:143
  └─ vault nonce / salt / IV       components/leek-wallet/*.c
  ↑
wallet_create_mnemonic()           components/leek-wallet/leek-wallet.c:1530
  ↑
wallet_create_run_generation()     src/ui.c:1965, in ui_task
```

Reaching seed generation from the UI is gated on the entropy screen: the two
menu entries that create a wallet both route to `SCREEN_ENTROPY` first
(`ui.c:1607`, `ui.c:2622`), and that screen refuses to advance until 32 press
events have been collected (`ui.c:2884-2888`). There is no protocol command
that creates a wallet, so there is no way around it. (The target is 64 after
§8.5; the entropy screen also suspends both links now, which is why §8.3 says
the seed path was already covered before the mutex.)

### What `esp_random()` actually guarantees — verified, not assumed

Per the ESP-IDF Random Number Generation page for ESP32-S3, `esp_random()`
returns true random numbers when an RF subsystem (Wi-Fi or BT) is enabled, or
when `bootloader_random_enable()` has been called and not yet disabled (the SAR
ADC mixes an internal noise reading into the HWRNG). With neither, "the output
of the RNG should be considered as pseudo-random only."
<https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/random.html>

**The gate's assumption matches the documentation.** `rf_is_active()` ORs the
two radios (`entropy.c:230-233`) and the bootloader RNG is enabled exactly when
neither is up (`entropy.c:262-266`), which is also the condition the docs
require — the same page warns that `bootloader_random_enable()` "is not safe if
any other subsystem is accessing the RF subsystem or the ADC at the same time."

### Timing — the rate limit is enforced inside IDF, not by this code

The brief asked whether draining 32 bytes in a tight loop outruns the hardware
reseed. It does not, and the caller does not have to care. From the pinned
`components/esp_hw_support/hw_random.c`:

```c
#if defined CONFIG_IDF_TARGET_ESP32S3
#define APB_CYCLE_WAIT_NUM (1778) /* If APB clock is 80 MHz, the maximum sampling
                                     frequency is around 45 KHz */
```

and `esp_random()` busy-waits on the CPU cycle counter until
`ccount - last_ccount >= cpu_to_apb_freq_ratio * APB_CYCLE_WAIT_NUM` before
returning. `esp_fill_random()` is a loop over `esp_random()`, so the pacing
applies per 32-bit word. 32 bytes is 8 words × 1778 APB cycles ≈ 14 200 cycles
≈ **178 µs at 80 MHz**. ESP32-S3 does not define `SOC_LP_TIMER_SUPPORTED`, so
it takes the simple branch. No finding.

One footnote: `last_ccount` is a plain non-atomic `static` shared by all tasks
and both cores. Concurrent callers can each see a stale value and shorten their
own wait. That is upstream's concern, but it compounds finding **E-2** below.

---

## 2. The health test, and where its cutoffs come from

`entropy_health_check()` (`entropy.c:56-113`) runs four tests: all-zero,
all-same, a repetition count, and either a windowed proportion test (len ≥ 512)
or a distinct-value floor (16 ≤ len < 512).

### Repetition Count Test — cutoff is correct

SP 800-90B §4.4.1 gives `C = 1 + ceil(-log2(α) / H)`. At α = 2⁻³⁰ and the
code's stated H = 7 bits/sample: `1 + ceil(30/7) = 1 + 5 = 6`. The code uses
`REPETITION_CUTOFF 6` (`entropy.c:36`). **Correct, and correctly documented.**

### Adaptive Proportion Test — the cutoff is derived for the wrong H

*Resolved in §8.7: one stated H, both constants derived from it.*

SP 800-90B §4.4.2 sets the cutoff as the smallest `C` with
`P[Binomial(W-1, 2^-H) ≥ C] ≤ α`, with W = 512 for non-binary sources. Computed
exactly (rationals, no normal approximation):

| assumed H (bits/byte) | SP 800-90B cutoff C | P(X ≥ C) |
|---|---|---|
| 8 | **16** | 3.9e-10 |
| 7 | 22 | 2.5e-10 |
| 6 | 31 | 3.1e-10 |
| 5 | 45 | 8.8e-10 |
| 4 | 70 | 8.7e-10 |

The code uses `PROPORTION_CUTOFF 16` (`entropy.c:52`). That is the cutoff for
**H = 8**, i.e. a full-entropy source — while the RCT two lines above assumes
H = 7. The two tests do not share an entropy assumption. Using 16 makes the
proportion test *stricter* than the spec would allow at H = 7, so the error is
in the safe direction, but the comment at `entropy.c:48-51` justifies 16 by an
empirical "observed max runs 9-10" argument rather than by the derivation, and
the file therefore does not state a single coherent H. See **E-5**.

The code also departs from the spec deliberately and correctly: it counts the
window's *most frequent* value rather than the window's *first* value
(`entropy.c:41-47`). For one-shot buffer validation that is strictly stronger,
and the reasoning in the comment is sound. The cost is a ~256× union bound on
the false-positive rate — ~1e-7 per window rather than the ~4e-10 the spec's
single-value form gives. The comment's "around 1e-9 per value" is per-value and
is right; the per-window figure is simply not stated.

### Measured false-positive rate: zero. The gate will not brick a good device.

Driving `entropy_health_check()` from a host harness with xoshiro256\*\*
(2 000 000 buffers per length):

```
len=  12  0/2000000 rejected  (0.00e+00)
len=  16  0/2000000 rejected  (0.00e+00)
len=  32  0/2000000 rejected  (0.00e+00)
len=  64  0/2000000 rejected  (0.00e+00)
len= 512  0/2000000 rejected  (0.00e+00)
len=1024  0/2000000 rejected  (0.00e+00)
```

**No false-positive risk.** The concern that a tripping gate could refuse to
generate seeds on healthy hardware is not borne out.

### Measured detection power — this is the important number

The same harness, at `len=32`, which was the length **every real seed
generation used** (`bip39.c:59` always draws 32 bytes) before §8.4 added the
512-byte deep sample:

Against a statistically clean stream with a small key behind it — SHA-256 in
counter mode over an N-bit key, i.e. the Coldcard shape:

```
 8-bit seed, len=32  detected 0/200000 (0.0000)
16-bit seed, len=32  detected 0/200000 (0.0000)
24-bit seed, len=32  detected 0/200000 (0.0000)
32-bit seed, len=32  detected 0/200000 (0.0000)
40-bit seed, len=32  detected 0/200000 (0.0000)
```

Against a crudely biased source (byte is 0x00 with probability p, else uniform):

```
                     len=32              len=1024
P(0x00)=0.05    0/200000 (0.0000)    20000/20000 (1.0000)
P(0x00)=0.10    7/200000 (0.0000)    20000/20000 (1.0000)
P(0x00)=0.25 1097/200000 (0.0055)    20000/20000 (1.0000)
P(0x00)=0.50 41731/200000 (0.2087)   20000/20000 (1.0000)
P(0x00)=0.75 173317/200000 (0.8666)  20000/20000 (1.0000)
P(0x00)=0.90 199652/200000 (0.9983)  20000/20000 (1.0000)
```

Read the `P(0x00)=0.50` row carefully. A source that emits a zero byte half the
time — roughly **1 bit of min-entropy per byte, a 32-byte draw worth about 32
bits** — is accepted by the gate **79% of the time** at the size a seed
actually uses. At 1024 bytes the same source is caught every time.

The tests are not weak; they are being run on a sample 16× too small to have
power. Everything the windowed proportion test is good at is switched off for
every real call, leaving only the coarse `distinct >= len/4` floor
(`entropy.c:105-112`), which for 32 bytes only demands 8 distinct values.

Harness: `scratchpad/power.c`, built against `src/entropy.c` with
`-DLEEK_HOST_TEST`. Numbers above are from a single run; rerunning moves the
last digits only.

---

## 3. The user pool

`entropy_add_user_event()` (`entropy.c:156-170`) folds `button ‖ timestamp_us`
into a running SHA-256; `entropy_mix_pool()` (`entropy.c:180-215`) emits
`SHA256(domain ‖ hw ‖ SHA256(pool) ‖ count_le32)`.

**It genuinely cannot subtract.** The hardware bytes are an input to the hash,
the output is 256 bits, and in `entropy_fill()` the hardware chunk fed in is
itself 32 bytes (`entropy.c:313-323`), so a full-entropy hardware draw survives
the mix with no measurable loss. A user who contributes nothing takes the
`user_pool_init == false` branch and gets the raw hardware bytes unchanged —
strictly no worse off. Confirmed by construction and by `sim/test_entropy.c`.

**Ordering is right.** The health check runs on the raw hardware bytes *before*
the mix (`entropy.c:285`, with the reasoning at `entropy.c:280-284`). Mixing
first would let the pool launder a dead silicon source through SHA-256 and turn
the check into a rubber stamp. This is correct and easy to get wrong.

**Length-extension:** not applicable. The construction is a plain hash of
secret material, not a MAC, and nothing external ever sees a digest of a prefix.

**Truncation:** clean. `chunk` is clamped and only `chunk` bytes are copied back
(`entropy.c:325`); the short-chunk case zero-pads deterministically and
disambiguates chunks with a little-endian index (`entropy.c:317-323`).

**One construction nit (E-6):** the fields are concatenated without length
prefixes, and the pool's presence is not domain-separated — `SHA256(dom ‖ hw ‖
digest ‖ count)` with a 68-byte `hw` and no pool collides with a 36-byte `hw`
plus a pool. Not reachable in production, where `hw_len` is always 36 and the
only caller is `entropy_fill()`, but it is a latent ambiguity in a function the
header exposes for testing.

### The bits-per-press estimate does not hold up

*Corrected in §8.5: 2 bits per press, 64 presses.*

`BITS_PER_EVENT 4` (`entropy.c:145`) is documented as conservative, on the
grounds that the interval between presses is measured at **microsecond
resolution** (`entropy.h:91-95`, and again at `ui.c:2787-2790`). Tracing where
the timestamp actually comes from:

- `ui.c:2892` stamps `esp_timer_get_time()` when **ui_task dequeues** the
  event, not when the button was pressed.
- The event is enqueued by `button_poll_once()`, which the poll task runs every
  `vTaskDelay(pdMS_TO_TICKS(10))` — `button.c:136`. `CONFIG_FREERTOS_HZ=1000`
  (`sdkconfig.defaults:61`), so that is a **strictly periodic 10 ms grid**
  locked to the tick.
- The event only fires once the raw level has been stable for
  `DEBOUNCE_TIME_US 100000`, i.e. 100 ms (`button.c:24`, `button.c:107`).

So the press instant is quantised to 10 ms before it is ever timestamped. The
microsecond digits below that come from context-switch and interrupt jitter,
not from the human. The effective resolution of a press interval is **10 ms**,
not 1 µs.

A user pressing at a typical repeated-press cadence spans maybe 150–600 ms,
about 45 distinct 10 ms buckets, so an interval carries perhaps 3–5 bits if the
user is irregular — and considerably less if they fall into a rhythm, which the
100 ms debounce actively encourages by discarding anything faster. 4 bits per
press is therefore an estimate at the **optimistic** end of the range, not the
conservative floor the code calls it, and `32 events × 4 = 128 bits`
(`ui.c:2805`) is not a bound anyone should lean on. Consecutive intervals from
one human are also not independent, which the estimate does not account for.

This matters more than it would elsewhere, because §2 shows the user pool is
the *only* layer that covers the shallow-source failure mode.

---

## 4. Bytes to words

- **No modulo bias in the seed path.** `mnemonic_from_data()`
  (`bip39.c:68-96`) slices 11-bit indices straight out of the entropy bits.
  There is no rejection sampling and none is needed.
- **12 vs 24 words.** `mnemonic_generate()` always draws 32 bytes and then uses
  `strength/8` of them (`bip39.c:54-64`); a 12-word seed keeps the first 16 and
  discards the rest. Correct, and it means every call — 12-word or 24-word —
  presents a 32-byte buffer to the health check.
- **Checksum.** `bits[len] = bits[0]` after `sha256_Raw` takes the top 8 bits
  of the digest and the word loop consumes `len*3/4` × 11 bits, using 4 of them
  for 12 words and 8 for 24. Standard BIP-39, and `wallet_create_mnemonic()`
  re-verifies with `mnemonic_check()` before storing
  (`leek-wallet.c:1531`).
- **`memzero` of intermediates.** `data` in `mnemonic_generate` (`bip39.c:62`),
  `bits` in `mnemonic_from_data` (`bip39.c:95`), the mix scratch and pool
  snapshot in `entropy.c:327-328` and `entropy.c:205-206`, and the failure path
  that zeroes the caller's buffer (`entropy.c:290`) are all covered.
  **Gap (E-4):** `mnemonic_from_data` returns a pointer into a file-scope
  `static CONFIDENTIAL char mnemo[240]` (`bip39.c:66`), and `mnemonic_clear()`
  — which exists at `bip39.c:100` precisely to wipe it — is **never called
  anywhere in this repository** (`grep -rn mnemonic_clear src components`
  returns only the declaration and the definition). A generated seed phrase
  stays in that buffer in plaintext RAM for the rest of the boot.
- **SLIP-39.** All randomness routes through `slip39_random()`
  (`slip39-backup.c:61-67`) to `entropy_fill()` — the random share values
  (`:373`), the digest share padding (`:384`) and the identifier (`:565`). The
  reasoning at `:52-60` about a random share being key material is correct: with
  T-1 shares the secret follows by interpolation. `memzero` coverage across the
  generation path is thorough (`:370, :407, :409, :435, :505-509, :561-563`).
  No finding beyond the ones that apply to `entropy_fill()` generally — though
  note each share is a **separate** `entropy_fill()` call, so a `2-of-3` split
  performs several independent enable/fill/disable cycles (see **E-2**).
- **`esp_random() % mnemonic_word_count`** at `ui.c:3089` picks which words to
  quiz the user on. Modulo bias is ~2⁻²⁸ and the value is not key material.
  Not a finding.

---

## 5. Findings by severity

### E-1 — HIGH (documentation) · README claims a defence the code measurably does not provide

`README.md:347-352` states that the SP 800-90B health tests mean "the failure
that hit Coldcard would abort this device instead of silently producing a weak
seed." §2 measures that claim directly: **0 detections in 200 000 trials**
against a clean-looking stream with as little as an 8-bit key behind it, at
`len=32`, which is the length every seed generation uses. The health tests
would not have caught Coldcard.

Compounding it, the bullet immediately above (`README.md:343`) calls the user
entropy screen "an optional screen" — when `ui.c:2884-2888` makes it mandatory
and the header at `ui.c:2795-2802` explains at length *why* it is mandatory.
The two bullets have their claims backwards: the layer that would actually have
caught Coldcard is described as optional, and the layer that would not is
credited with catching it.

`AUDIT.md:270-272` gets this right ("the health tests catch a catastrophically
broken RNG, not a subtly biased one"). The README is the document that
overstates. **Changed** — see §8.

### E-2 — MEDIUM · **FIXED** · The bootloader-RNG window is not mutually excluded between tasks

`entropy_fill()` calls `bootloader_random_enable()` / `..._disable()` around
`esp_fill_random()` (`entropy.c:262-272`) with no lock, and
`bootloader_random_disable()` is not reference-counted in IDF.

Three tasks can reach `random_buffer()`: `ui_task` (`main.c:130`, wallet
creation), `protocol` (`protocol.c:1381`, USB-Serial-JTAG, always created), and
`bleproto` (`ble.c:433`). `session_begin()` → `random_buffer()`
(`session.c:143`) is reached from `protocol.c:302` on any host connect.

The race is reachable specifically in USB mode, where `transport.c:89` sets
`entropy_set_ble_active(false)` and both tasks therefore take the
bootloader-RNG branch. Interleave:

```
protocol_task: bootloader_random_enable()
ui_task:       bootloader_random_enable()      (double enable)
ui_task:       esp_fill_random() … disable()
protocol_task: esp_fill_random()               ← bootloader RNG now OFF,
                                                 no radio: pseudo-random only
```

The victim's bytes are documented pseudo-random, and §2 shows the health check
will pass them without complaint. `last_result` (`entropy.c:227`) is likewise a
shared global with no synchronisation, so a failure in one task can be
overwritten by a success in another before the first reads it.

The worst-case victim is a session key, but nothing structurally prevents the
wallet-creation call from being the loser — and SLIP-39 generation makes one
such call per share.

Fixed in the R3 pass: one mutex now spans enable/deep-check/fill/disable, and
`last_result` is written inside it. See §8.3 for what the mutex does *not*
cover.

### E-3 — MEDIUM · **FIXED** · The health check is run on 32-byte samples, where it has almost no power

Detailed in §2. The tests themselves are sound and the windowed proportion test
is genuinely strong — at 1024 bytes it catches every biased source tested,
100% of the time. It is simply never reached, because `bip39.c:59` asks for 32
bytes and `entropy_fill()` checks exactly what it was asked for.

At `len=32` a source with roughly 1 bit of min-entropy per byte passes 79% of
the time. Recommendation R2 in §7.

### E-4 — MEDIUM · **FIXED** · The generated mnemonic is never wiped from `bip39.c`'s static buffer

`mnemonic_clear()` (`bip39.c:100`) exists to zero the `static CONFIDENTIAL char
mnemo[240]` that `mnemonic_from_data()` returns a pointer into, and nothing in
the firmware calls it. `ui.c` and `leek-wallet.c` are careful to `memzero`
their own copies (`ui.c:2974`, `leek-wallet.c:1550`), so the omission looks
like an oversight rather than a decision. Result: a freshly generated seed
phrase sits in plaintext RAM until reboot or until another mnemonic overwrites
it.

Called out rather than fixed only because the right call site is a judgement
about the display flow — the buffer must stay live while
`SCREEN_MNEMONIC_DISPLAY` and the verification screen are using it.

### E-5 — LOW · **FIXED** · The two SP 800-90B cutoffs assume different entropy rates

`REPETITION_CUTOFF 6` is derived at H = 7 (correctly). `PROPORTION_CUTOFF 16`
is the spec's cutoff at H = 8; at H = 7 the spec gives 22. The direction is
safe — the test is stricter than required — but the file states one H and
implements another, and the comment at `entropy.c:48-51` justifies the number
empirically instead of from the derivation, which is how a wrong cutoff would
survive review next time.

### E-6 — LOW · `entropy_mix_pool()` concatenates without length prefixes

Described in §3. Not reachable in production; a latent ambiguity in an
exported function.

### E-7 — LOW · `entropy_dump_for_analysis()` is documented as debug-only and is not

`entropy.h:135-140` says "Debug builds only." Nothing enforces it — no
`#ifdef`, no `NDEBUG` guard (`entropy.c:333-361`). It is currently harmless
because it has no callers anywhere in the tree, which also means the
`AUDIT.md:260` claim that it "emits raw RNG over serial for offline
dieharder/STS runs" describes a facility nobody can currently invoke. The
outstanding dieharder work at `AUDIT.md:270-272` and `README.md:441` is
correctly declared outstanding.

### E-8 — LOW (test hygiene) · A test comment claims a coverage the test does not provide

`sim/test_entropy.c:129-131` builds a 32-byte buffer drawn from 4 distinct
values and comments "This is the shape of the Coldcard failure at seed scale."
It is not. The Coldcard fallback produced a statistically *uniform* stream from
a small key; a 4-distinct-value buffer is a shape the check happens to catch.
The test is fine; the comment manufactures confidence in coverage that §2
measures at zero. **Changed** — see §8.

### Checked, no finding

- `esp_random()` rate limiting (§1) — enforced inside IDF, 178 µs per 32 bytes.
- The RF gate condition matches Espressif's documented requirement (§1).
- False-positive rate of the health check: 0 / 2 000 000 at every length (§2).
- The user pool cannot subtract; the health check correctly runs before the mix (§3).
- Modulo bias, BIP-39 checksum, 12-vs-24 word handling (§4).
- SLIP-39 routes all randomness through the gate (§4).
- `scripts/check-rng-unique.sh` correctly enforces one `random_buffer`
  definition and refuses `USE_INSECURE_PRNG`; it passes at this commit.

---

## 6. How production wallets do it

The Coldcard incident cited throughout this repo's documentation is real and
correctly characterised. Coinkite's own writeup describes a 2021 migration to
libsecp256k1 that silently bound seed generation to MicroPython's `Yasmarang`
software PRNG instead of the hardware TRNG, via an `#ifndef` that a
zero-valued macro satisfied; ~40-bit effective entropy on Mk2/Mk3 firmware
4.0.1–4.1.9, ~72-bit on Mk4/Q where secure-element entropy was still mixed in.
Exploited at scale in 2026.
<https://blog.coinkite.com/coldcard-mk3-seed-generation-warning/>,
<https://blog.coinkite.com/entropy-technical-backgrounder/>,
<https://www.coindesk.com/tech/2026/08/04/coldcard-urges-users-to-move-bitcoin-as-active-wallet-exploit-continues>

The detail most worth internalising: Coinkite states that seeds generated from
≥50 independent dice rolls were **not** at risk. User-supplied entropy was the
only layer that survived.

| Wallet | Sources | Multi-source combining | Host/user entropy so a backdoored RNG cannot fix the seed | User-verifiable generation |
|---|---|---|---|---|
| **Trezor** (T, Safe 3) | STM32 TRNG (+ SE on Safe 3) | yes | **Yes, mandatory.** Device commits to its internal entropy with `HMAC-SHA256(int_entropy, "")`, host then sends 32 bytes, seed derives from both | **Yes** — commit-reveal with 1–4 (Connect) / 2–8 (trezorlib) verification rounds in which the device reveals a prior round's entropy so the host recomputes and compares. Final seed's internal entropy is never revealed [1] |
| **Coldcard** (Mk4/Q) | STM32 TRNG + two secure elements + optional user entropy | XOR/hash of all | **Optional but supported** — dice (2.585 bits/roll, 50 rolls for 128 bits), coin flips, keypresses | Dice math is independently verifiable; third-party verifier exists [2] |
| **Foundation Passport** | MCU RNG + SE TRNG, XORed, plus a per-device one-time pad in SE slot 9 | yes | Dice rolls mixable | Firmware is open and reproducible; no commit-reveal [3] |
| **SeedSigner** | Camera image pixel data, dice, or hand computation | user picks | **User entropy is the primary source** — no device TRNG to backdoor | Stateless and air-gapped; the user can recompute the seed by hand from their dice [4] |
| **Blockstream Jade** | Button/wheel input, CPU counters, battery, temperature, boot-time camera frame, HW RNG, app-supplied entropy — and `bootloader_random_enable()` for radio noise, on the same ESP32 family | hashed together | App-supplied entropy is mixed in; the separate "blind oracle" secret guards PIN decryption, not seed entropy | Open firmware; no commit-reveal on generation [5] |
| **Ledger** | TRNG inside the secure element, CC EAL5+/6+, AIS-31 PTG.2, conditioned in Ledger OS | internal | **No** documented host/user-entropy scheme — the model is certification, not verification | No [6] |

[1] <https://trezor.io/learn/security-privacy/how-trezor-keeps-you-safe/entropy-check-how-trezor-verifies-your-wallet-is-truly-random>,
<https://github.com/trezor/trezor-core/blob/master/src/apps/management/reset_device.py>
[2] <https://coldcard.com/docs/master-seed/>,
<https://coldcard.com/docs/verifying-dice-roll-math/>,
<https://github.com/andreashuber69/verify-coldcard-dice-seed>
[3] <https://github.com/Foundation-Devices/passport-firmware/blob/main/SECURITY/SECURITY.md>
[4] <https://github.com/SeedSigner/seedsigner>
[5] <https://blog.blockstream.com/blockstream-jade-tech-overview-part-1/>
[6] <https://donjon.ledger.com/threat-model/os-random-number-generation/>

### What transfers to an ESP32-S3, and what is cargo-culting

**Transfers directly.** Jade is the strongest reference point: same SoC family,
same `bootloader_random_enable()` call, and it reaches the same conclusion this
firmware does — mix many weak-but-independent local sources rather than trust
one. Its extra sources (CPU cycle counters at input events, battery voltage,
internal temperature) are all available on an S3 and all cost nothing.

**Transfers, with the most value per line.** Dice entropy. It is the one
countermeasure Coinkite's own advisory says protected users, it needs no
hardware, and on a 4-button device it is a text-entry screen. It also gives a
user something the button-timing pool cannot: an entropy contribution they can
reason about and, in principle, recompute.

**Transfers, but is a bigger commitment.** Trezor's commit-reveal. It is the
only scheme in the table that lets a user *prove* the device did not backdoor
the seed, and it needs no secure element — just a host, which this project
already has in `app/`. It does require a protocol change and a host-side
implementation.

**Does not transfer.** Ledger's model — a certified secure-element TRNG — is
not reachable here; there is no SE. Passport's per-device one-time pad assumes
an SE slot to hold it. SeedSigner's camera entropy assumes a camera.
`docs/CAMERA-OPTIONS.md` exists, but treating a camera as an entropy source is
a different project from treating it as a QR scanner.

---

## 7. Recommendations, ranked by risk reduced ÷ effort

**R1 — Correct the README's entropy claims.** Highest ratio available: a
document that credits the health tests with catching the Coldcard failure will
stop someone from building the layer that actually would. Zero risk.
*Done — see §8.*

**R2 — Health-check a 512-byte sample, not the 32 bytes the caller asked for.**
*Done — see §8.4.*
Draw ≥ 512 bytes into a scratch buffer, run the check on that, then derive the
requested output from it (or simply draw the caller's bytes afterwards, having
established the source is alive). §2 measures the change: detection of a
1-bit-per-byte source at seed scale goes from **0.21 to 1.00**. Cost is
128 × 178 µs ≈ **2.8 ms** per call. That is free once per seed. It is *not*
free on every AES IV, so the sensible shape is a periodic or
first-call-per-boot deep check plus the cheap check on every call — a design
choice, hence §9.

**R3 — Serialise the entropy gate with a mutex.** *Done — see §8.3.* Closes E-2. One
`SemaphoreHandle_t` taken across the enable/fill/disable/check sequence, and
`last_result` moves inside it. Small, well-understood, and it removes a path to
a pseudo-random session key. Touches the crypto-critical path, so it wants a
deliberate change rather than an audit's drive-by.

**R4 — Add dice / coin entropy input.** The measure Coinkite says protected
users, on a device that already has text entry (`src/text-entry.c`) and a
mandatory entropy screen to hang it off. Rolls concatenate into the existing
`user_pool` hash — no new crypto, just a new event source and an honest bits
counter (log2(6) = 2.585 bits per d6, log2(2) = 1 bit per coin). It also fixes
the thing E-9-adjacent about the timing pool: dice entropy is *countable*,
where keypress jitter is estimated.

**R5 — Fix the bits-per-press estimate, or fix the resolution it assumes.**
*Done, the cheap half — see §8.5.*
Two options. Cheap: relabel `BITS_PER_EVENT` to 2 and raise
`ENTROPY_TARGET_EVENTS` to 64, and correct `entropy.h:91-95` and `ui.c:2787` to
say 10 ms rather than microseconds. Better: timestamp the raw GPIO edge in
`button_poll_once()` before the debounce delay and pass *that* to
`entropy_add_user_event()`, and/or drop the poll period — which recovers real
sub-tick jitter and makes the microsecond claim true. The first is minutes; the
second is a change to shared input code owned elsewhere.

**R6 — Call `mnemonic_clear()`.** *Done — see §8.6.* Closes E-4. One line, at the point the
display and verification screens are done with the buffer.

**R7 — Reconcile the two SP 800-90B cutoffs.** *Done — see §8.7.* Pick one H, state it once, and
derive both constants from it in a comment that shows the arithmetic (§2 has
the table). Closes E-5. Documentation-shaped, but it is the difference between
a cutoff that is right and a cutoff that happens to be right.

**R8 — Actually run dieharder.** `AUDIT.md:270-272` and `README.md:441` both
declare this outstanding, honestly. `entropy_dump_for_analysis()` exists for it
and currently has no caller (E-7). Wiring it to a hidden menu entry or a
debug-only protocol command and running a few hundred MB through dieharder /
NIST STS in both the RF-up and bootloader-RNG configurations is the only thing
that converts "the health tests pass" into evidence about quality.

**R9 — Verifiable generation (Trezor-style commit-reveal).** The highest
assurance in the table and the largest effort. The device would commit to
`HMAC-SHA256(internal_entropy, "")`, receive 32 bytes of host entropy, derive
`seed = f(internal ‖ host)`, and on request reveal the internal entropy of a
*discarded* candidate so the host can recompute the commitment and the
resulting xpub. It closes the one threat none of R1–R8 touch: a device whose
firmware you cannot audit choosing your seed for you. It needs a protocol
message pair, host support in `app/`, and careful thought about what is
revealed when. Worth a roadmap entry, not a patch. See §9.

**Explicitly not recommended.** Do not add a "software PRNG fallback" for the
case where the health check fails. The abort at `rand_esp32.c:51` is the single
most important line in this subsystem and the reasoning above it is right.

---

## 8. What was changed

### First pass — documentation only

No cryptographic code was modified.

1. `README.md` — the two entropy bullets now say what the code does: the
   user-entropy screen is mandatory (not "optional"), and the health tests are
   described as catching a grossly broken source rather than as the layer that
   would have caught Coldcard. Closes E-1.
2. `AUDIT.md:254-255` — replaced the stale `entropy_set_rf_active()` with the
   two setters that exist, and corrected "`ui.c` reports RF transitions" to
   `transport.c`, which is where the already-fixed defect moved it.
3. `sim/test_entropy.c` — corrected the comment claiming a 4-distinct-value
   buffer is "the shape of the Coldcard failure." Closes E-8.

### Second pass — R2, R3, R5, R6, R7 implemented

Numbers below come from the same harness as §2 (xoshiro256\*\* reference
stream, exact-rational cutoffs, 2 000 000 buffers for false positives and
200 000 for detection), rebuilt against the current `src/entropy.c`. The §2
baseline reproduced exactly before anything was changed — `P(0x00)=0.50` at
`len=32` detected 0.2087, same as the audit's original run — so the before and
after figures are comparable rather than two different experiments.

#### 8.3 R3 — one mutex across the whole gate (closes E-2)

`entropy_fill()` now takes a plain (non-recursive) `SemaphoreHandle_t` before
`bootloader_random_enable()` and releases it on every exit path, so the
enable / deep-check / fill / disable / health-check sequence is atomic against
the other two tasks that reach `random_buffer()`. `last_result` is written
inside the lock. `entropy_dump_for_analysis()` takes the same lock, because it
opens and closes the same process-wide window. Failure to take the lock within
5 s is treated as a health failure — fail closed, no draw. Host builds compile
the lock out; they are single-threaded and return before the hardware path.

**What this still leaves exposed.** The lock makes the *gate* atomic. It does
not make *seed generation* atomic with respect to everything else, and those
are different claims:

- Seed generation itself is now covered twice over. `screen_entropy_enter()`
  calls `transport_suspend()`, so from the first press of the entropy screen
  through generation, display and verification there is no USB or BLE task
  alive to contend at all. That closes E-2 for the seed path on its own, and
  the mutex is what closes it for everything else.
- What remains exposed is every draw made while the links are *up*, which is
  most of them: `session_begin()`'s device key on each host connect, the vault
  salt and record IV on a wallet store or PIN change, and the 12-byte GCM
  nonce per encrypted record. Before the mutex these could and did race each
  other, one task's `bootloader_random_disable()` landing inside another's
  draw. They no longer can.
- Not closed by either: IDF's own `last_ccount` in `hw_random.c` is a
  non-atomic static shared across tasks and cores (§1). Two callers can each
  shorten their own rate-limit wait. That is upstream's, and this lock only
  narrows it — it serialises this firmware's callers, not the ones inside IDF.
- Also not closed: the lock is per-boot state, so a task that aborts inside
  the critical section takes the device down with it (`abort()` in
  `rand_esp32.c`) rather than leaving the mutex held. That is the intended
  behaviour, not a leak, but it is worth stating that there is no recovery
  path by design.

#### 8.4 R2 — the health check now runs on a 512-byte sample (closes E-3)

`entropy_fill()` draws `ENTROPY_DEEP_SAMPLE` (512) bytes into a static buffer,
health-checks that, `memzero`s it, and only then draws the caller's bytes —
inside the same bootloader-RNG window, so the sample vouches for the same
moment of the same source. The caller's own bytes are still checked afterwards
as before; the deep sample is added coverage, not a replacement.

Detection of a source with roughly 1 bit of min-entropy per byte
(`P(0x00) = 0.50`), which is the case §2 identified as passing 79% of the time:

| sample the gate checks | detection |
|---|---|
| before — the caller's 32 bytes | **0.2087** |
| after — a 512-byte deep sample | **1.0000** |

Across the whole biased-source sweep, at the deep sample: `p=0.05` 0.9942,
`p=0.10` 1.0000, and 1.0000 at every larger `p`. The one case that does **not**
improve is the important one to state plainly: a statistically clean stream
behind a small key — the actual Coldcard shape — is still detected **0/200 000
times at 512 bytes**, exactly as at 32. No sample size fixes that; only the
user pool does. R2 closes the shallow-*and*-visibly-biased hole, not the
shallow-and-clean one.

False positives are unchanged at zero: 0/2 000 000 at every length tested.

**When it runs, and why that shape.** §9 left this to a human. The decision
implemented is *by draw size*, not by caller:

- always on the first draw of a boot, whatever its size;
- thereafter on every draw of ≥ 16 bytes.

Sixteen is the smallest draw in this firmware that is key material: seed
entropy (32), the session device key (32), SLIP-39 share values (16 or 32),
the vault salt and wallet-record AES IV (16). Exactly one caller sits below it,
`vault-crypt.c`'s 12-byte GCM nonce, which needs uniqueness rather than
unpredictability and is the only draw frequent enough for 2.8 ms to be felt.

The trade-off, stated: 512 bytes at IDF's ~45 kHz pacing is 128 words × 1778
APB cycles ≈ **2.845 ms**, and the check arithmetic on top of that is a
rounding error (0.4 µs on the host harness at this length; the draw dominates
by three orders of magnitude). Per seed it is free. Per session key it
disappears into the X25519 either side of it. Per vault write it happens when a
wallet is stored or a PIN changed, not per packet. The rejected alternative was
deep-checking only at seed generation: it is cheaper, but it makes the strength
of the check depend on a caller remembering to ask for it, and every finding
this module exists to prevent is a caller not remembering something. Cost:
+512 bytes of `.bss`, and firmware RAM use is 16.5% of 320 KB after the change.

#### 8.5 R5 — the bits-per-press estimate is now a floor (closes the §3 finding)

`BITS_PER_EVENT` 4 → **2**, and `ENTROPY_TARGET_EVENTS` (`ui.c`) 32 → **64**,
so the collection screen still clears 128 bits but by a claim that holds. The
honest figure is 2 bits per press: the press is quantised to a 10 ms polling
grid behind a 100 ms debounce before anything timestamps it (§3), so the
microsecond resolution of `esp_timer_get_time()` is not the resolution of the
measurement, an irregular user offers 3-5 bits and a user who falls into a
rhythm offers less, and consecutive intervals from one human are not
independent. Two is a floor rather than a mean.

`src/button.c` was **not** touched. R5's better option — timestamping the raw
GPIO edge in an ISR — is what would make the microsecond claim true, and it is
a change to shared input code with its own debounce correctness to re-argue;
the accounting is corrected here and the resolution is left as it is. The
comments in `entropy.h`, `entropy.c` and `ui.c` that claimed microsecond
resolution now say 10 ms.

The user-visible cost is real: roughly thirty seconds of pressing instead of
fifteen. That is the price of the number meaning something.

#### 8.6 R6 — `mnemonic_clear()` is called (closes E-4)

Two call sites, both in `ui.c`:

- `forget_mnemonic_unless_needed()`, the existing exit hook on
  `SCREEN_MNEMONIC_DISPLAY` and `SCREEN_MNEMONIC_VERIFY`. §5 flagged the
  location as a judgement call about the display flow; the flow answers it. The
  hook already exists precisely to define "the screens that held the phrase are
  done with it", it already zeroes `mnemonic_buffer` there, and it fires on
  every transition out of that pair. Clearing bip39.c's static buffer in the
  same place means the two plaintext copies now have the same lifetime instead
  of one outliving the other by the rest of the boot.
- The wipe confirmation path, which zeroes `mnemonic_buffer` inline and does
  not exit through that hook. A wipe that leaves the seed readable in RAM is
  not a wipe.

Clearing immediately after generation was considered and rejected: it is a
narrower window, but it puts the wipe in `wallet_create_mnemonic()`'s caller
rather than at the point the *readers* are done, and a future screen that reads
the phrase again would silently reintroduce the leak.

#### 8.7 R7 — one H, stated once, both cutoffs derived from it (closes E-5)

The file now states **H = 7 bits/sample at α = 2⁻³⁰** once, in a comment above
both constants, with the reasoning: assuming full entropy to derive the cutoffs
of the tests whose job is to notice a shortfall is circular.

- `REPETITION_CUTOFF` stays **6** = `1 + ceil(30/7)`, the spec's number at that H.
- `PROPORTION_CUTOFF` stays **16**. The spec's cutoff at H = 7 is 22; 16 is a
  deliberate tightening, and it is now documented as one, with the arithmetic
  and the measurement rather than the old "observed max runs 9-10".

Both alternatives were measured before choosing:

| variant | FP (clean stream) | detection `p=0.05`, len 512 | detection `p=0.50`, len 32 |
|---|---|---|---|
| **H=7, RCT 6, APT 16** (chosen) | 0 / 2 000 000 at every length | 0.9942 | 0.2087 |
| H=7 by the book, RCT 6, APT 22 | 0 / 2 000 000 | 0.8820 | 0.2081 |
| H=8, RCT 5, APT 16 | 6.0e-07 at len 1024, 0 at ≤512 | 0.9941 | 0.3961 |

Claiming H = 8 would have been the other coherent answer and buys real power at
32 bytes, but it is the wrong assumption for a test that exists for degraded
sources, and it is the only variant with a non-zero false-positive rate — which
in this firmware means an `abort()` on healthy hardware. Keeping 16 over the
spec's 22 costs nothing measurable and gains 0.88 → 0.99 detection on the
weakly-biased source at the length the gate now actually checks.

#### 8.8 Tests

`sim/test_entropy.c` gains `test_deep_sample_is_why()`, which asserts the R2
measurement rather than describing it: a ~1 bit/byte source must be caught
100% of the time at 512 bytes, and must *not* be caught more than half the time
at 32 — the second half so that if the gap ever closes, the test says so
instead of a stale comment. In-suite it reports `len=32 0.2010, len=512
1.0000`. The bit-estimate assertion moved from ≥ 40 to ≥ 20 bits for 10 events,
with the reason recorded at the assertion. `sim/test_ui.c`'s entropy-screen
tests now format the target count from a single constant instead of a dozen
`"32"` literals.

`./scripts/check.sh` passes: host suites, conformance vectors, app tests,
typecheck, android manifest, and the ESP-IDF firmware build.

---

## 9. Needs a human decision

- **R4: is dice entropy in scope for this device?** It is the single measure
  with the best evidence behind it — the one thing Coinkite says protected
  users — and it is also a screen, a wordlist-free text entry flow, and a UX
  conversation on a 128×64 OLED. It matters more after §8.4 than before: the
  deep check demonstrably does *not* catch the clean-but-shallow source, so
  countable user entropy remains the only cover for it.
- **R5's second option: timestamp the GPIO edge.** §8.5 fixed the accounting;
  the resolution is still 10 ms. An ISR timestamp in `button.c` would recover
  real sub-tick jitter and let the target go back to 32 presses, halving the
  time the user spends on the entropy screen. It is a change to shared input
  code and wants its own review of the debounce.
- **The 64-press target is now a UX cost.** Thirty seconds of pressing is the
  honest price of 128 bits at 2 bits a press. Dice (R4) or an edge timestamp
  (above) are the two ways to buy it back; lowering the target is not.
- **R9: is verifiable generation a goal?** It is the difference between "trust
  this firmware" and "verify this firmware did not cheat," and it is the only
  item here that changes the protocol.
- **R8 still stands.** Nothing in this pass converts "the health tests pass"
  into evidence about quality; that needs `entropy_dump_for_analysis()` wired
  to something a human can invoke, and a few hundred MB through dieharder in
  both the RF-up and bootloader-RNG configurations.
