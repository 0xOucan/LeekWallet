# LeekWallet Code Audit

Scope: `src/` (3,367 lines) and `components/colibri-wallet/` (1,253 lines) as of this audit.
`components/trezor-crypto/` is upstream Trezor code and was reviewed only where LeekWallet calls into it.

Findings are ordered by severity. Each one names the file and line so it can be turned into a
regression test in `sim/` before it is fixed.

**Status:** S2, S3, S4, S5, S6, S7, S8b, S8c, S8d, S8h, S8i and S8k are **fixed** and covered by
tests. `ui.c` now runs on the host (T0.2-T0.4), so screen and button behaviour is testable rather
than argued about.

**S1 is the one that still matters.** Its key derivation and storage encryption are done — salted
PBKDF2 and authenticated AES-GCM — but **flash encryption and secure boot are not enabled**, so
an attacker with the device still reads the vault off the chip and attacks the PIN offline. The
KDF turns that from instant into days. It does not stop the read. S5 and the remainder of S8
also stand.

---

## S1 — Seed is recoverable from a flash dump in seconds

**Where:** `components/colibri-wallet/colibri-wallet.c:112` (`derive_key_from_password`),
`sdkconfig.defaults` (`CONFIG_NVS_ENCRYPTION=n`, no flash encryption, no secure boot),
`src/ui.c:449` (PIN length is pinned to 4 digits — see S2).

**Chain:**

1. The AES-256 key that protects every mnemonic is `SHA256(SHA256(pin))`. No salt, no KDF,
   two hash invocations.
2. The UI can only ever produce a 4-digit PIN, so the key space is 10,000 candidates.
3. `CONFIG_NVS_ENCRYPTION=n` and flash encryption is not enabled, so
   `esptool.py read_flash` over the USB port dumps the NVS partition verbatim.
4. `pwd_hash` (`SHA256³(pin)`) is stored alongside the ciphertext, giving the attacker a free
   oracle to confirm the guess without touching AES.

Ten thousand double-SHA256 evaluations is microseconds. Physical access to the device — or to
a discarded one — is full seed recovery. The 3-attempt wipe counter is irrelevant because the
attack never goes through the firmware.

**Partially fixed.** The key derivation layer is done: `components/leek-wallet/vault-kdf.c`
derives both the storage key and the verifier from PBKDF2-HMAC-SHA512 over a per-device random
salt under separate domain strings, so the stored verifier is no longer an oracle for the
encryption key. `wallet_set_password()` creates v2 vaults; `wallet_unlock()` migrates legacy ones
on the first successful unlock, one wallet at a time, with the version marker flipped last and
an alternate-key fallback so an interrupted migration resumes instead of bricking the vault.

**Still open, and still disqualifying without them:**
- Iteration count (12000) is a placeholder — 7 ms on a desktop, needs tuning to ~500 ms on the
  S3 (T9c).
- Storage is still unauthenticated AES-CBC; AES-GCM is T14.
- **Flash encryption and secure boot are not enabled** (T11). Until they are, an attacker can
  still dump NVS — the KDF raises the cost from instant to days, but does not stop the read.

**Remaining fix direction:**
- Enable flash encryption + secure boot v2 (QEMU emulates eFuses, so this is testable before
  burning anything irreversible — see `sim/README.md`).
- Allow real PIN lengths (S2). A 4-digit PIN behind a proper KDF is still only 10⁴; the KDF
  buys time, the length buys entropy.

Note that `pwd_hash` and the encryption key are both unsalted functions of the same PIN, so they
are linked. Derive them from independent salts.

---

## S2 — ~~The PIN is always exactly 4 digits~~ FIXED

**Where:** `src/ui.c:467-501` (setup), `src/ui.c:572-599` (unlock).

Both handlers add the selected digit on ACCEPT and then immediately act on
`if (pin_cursor >= PIN_MIN_LENGTH)`. `PIN_MIN_LENGTH` is 4 (`src/pin.h:14`). There is no
separate submit action, so the fourth digit *is* the submit:

- Setup commits the first entry to `pin_first_entry` and jumps to confirm mode at 4 digits.
- Unlock calls `pin_verify()` at 4 digits.

`PIN_MAX_LENGTH` (8) is unreachable. The renderer draws eight slots (`PIN_DISPLAY_LEN`, `ui.c:177`),
which tells the user a longer PIN is possible, and README.md advertises "4-8 digit PIN".

Setup and unlock are consistent with each other, so the device is not bricked — but the entropy
ceiling is 10⁴ and that feeds directly into S1.

**Fixed, then fixed again.** The selector cycles 0-9 plus an `OK` option that appears once the
PIN reaches `PIN_MIN_LENGTH`.

The first version of this fix was unusable on real hardware. `OK` sat one step past 9 with only
the current option rendered, so a user scrolling 0-9 never saw it and had no way to submit at
all — strictly worse than the bug it replaced, and caught only by putting it on a device. The
selector now renders its neighbours (`8 <9> OK`), which makes the option findable before you
reach it. A reminder that a green test suite says nothing about whether a screen can be operated. ACCEPT appends; submitting is a separate, deliberate act, so 4-8 digits are all
reachable and each attempt is charged once, on intent. Note this raises the *ceiling* to 10⁸ but
the KDF underneath is still `SHA256²` — S1 is what makes that entropy worth anything.

---

## S3 — ~~110 of 2048 BIP39 words cannot be typed~~ FIXED

**Where:** `src/ui.c:1196-1202`.

```c
if (entry_prefix_len >= 3 && mnemonic_find_word(entry_prefix) >= 0) {
    should_accept = true;
    match = entry_prefix;      /* commit the exact word */
}
```

Any 3+ character prefix that is *itself* a BIP39 word is committed immediately. But 110 BIP39
words have a shorter BIP39 word as a proper prefix, and those 110 can never be reached:

| you type  | device commits |
|-----------|----------------|
| `address` | `add`          |
| `actress` | `act`          |
| `airport` | `air`          |
| `alley`   | `all`          |
| `canyon`  | `can`          |

Reproduced natively — see `sim/test_mnemonic_entry.c`, which replays the exact accept logic
against the real wordlist:

```
words that commit the WRONG word: 110 / 2048
12-word seeds that cannot be imported: 48.4%
```

For 24-word seeds it is ~73%. Since `wallet_validate_mnemonic()` then fails the checksum, the
screen silently resets to word 1 (`ui.c:1251`) with no explanation. A user restoring a real
backup hits a coin-flip chance of an unrecoverable-looking loop.

**Fixed twice.** The logic moved to `src/mnemonic-entry.c` (no ESP-IDF deps, so the host suite drives
it directly). Auto-commit now fires only when exactly one word still matches; when the prefix is
itself a word but others extend it, an explicit `OK` option appears in the selector. The selector
is also built from `mnemonic_word_completion_mask()`, so dead-end letters are never offered.

`sim/test_mnemonic_entry.c` now types all 2048 words keystroke-by-keystroke:
**0 wrong, 0 unreachable**, worst case 49 button presses (`surprise`). That press count is the
new UX cost and is worth revisiting — a two-axis selector or coarse letter jumps would cut it
(T44).

**The second fix came from hardware testing.** Auto-committing on a unique match still lost a
word: the selector offers only viable letters, so neighbours are arbitrary, and after `po` the
letter `p` sits directly beside `s`. A user aiming for `post` who over-scrolled by one landed
on `pop`, which uniquely matches `popular` and committed instantly with no prompt and no
obvious undo. The mistake then surfaced twelve words later as a checksum failure naming no word.

Nothing auto-commits now. A unique match surfaces `OK` pre-highlighted and captioned with the
word it would accept (`OK:post`), so confirming costs one press and a wrong turn costs one
CANCEL. Reachability is unchanged; the entry is one press per word slower and no longer silently
wrong.

**Related, currently benign:** the 4+ character uniqueness test at `ui.c:1204-1212` probes
uniqueness by appending the single letter `'a'`. That is not a uniqueness test in general — it
only checks one of 26 branches. I verified it happens to produce zero false accepts on the
English wordlist, so it is correct today by luck rather than construction. Replace it with a
real completion count and add the exhaustive test as a regression guard.

---

## S4 — ~~Power-cycling during the wipe grants unlimited PIN attempts~~ FIXED

**Where:** `src/pin.c:61-67` and `src/pin.c:209-224`.

`pin_verify()` compares first, then decrements, then persists. Two windows fall out:

*Free attempts.* Yanking power after the comparison but before `nvs_set_u8` leaves the counter
at its old value. The attacker gets an unbounded supply of guesses at one reboot each.

*Wipe evasion.* When the counter reaches 0, `pin_verify` persists 0 and returns false; the
*UI* is what actually wipes (`ui.c:592-597`). Cut power in between and the device reboots with
`attempts == 0` in NVS. `pin_init()` then hits:

```c
if (err == ESP_OK && attempts > 0 && attempts <= PIN_MAX_ATTEMPTS) {
    remaining_attempts = attempts;
} else {
    remaining_attempts = PIN_MAX_ATTEMPTS;   /* 0 is treated as "unset" */
}
```

A persisted 0 is indistinguishable from a missing key, so the counter resets to 3 with the
wallet fully intact. Repeat for 10,000/3 reboots.

**Fixed.** `pin_verify()` now spends and commits the attempt *before* comparing, and refunds it
only on verified success — an interrupted guess is a spent guess. `pin_init()` distinguishes a
stored `0` from an absent key, and `screen_boot_on_button` resumes an interrupted wipe before
offering any further attempts.

Still worth adding: a crash-injecting fake NVS (T0.1) so this is a test rather than an argument.

---

## S5 — Seeds and PINs linger in `.bss` after use

**Where:** `src/ui.c` (`mnemonic_buffer[256]`, the `MnemonicEntry entry`, `full_mnemonic[300]`,
`pin_entry`/`pin_first_entry`), `src/pin.c:28` (`current_pin`).

**Fixed (T6), covered by `sim/test_ui.c`.** `screen_t.exit` now takes the destination screen and three
hooks use it: `forget_mnemonic_unless_needed` (kept live only across the display ↔ verify
hand-off, which shares the buffer in both directions), `forget_mnemonic_entry`, and
`forget_pin_entry`. `full_mnemonic` was already zeroed on every path.

The test covers both directions of the mistake, which is the point: leaving the seed flow must
zero all 256 bytes (checked from the display screen *and* the verify screen, so it cannot pass
with the hook missing on one of them), and moving between display and verify must **not** zero it,
because those two share the buffer and hand off in both directions. Deleting the hook fails 6
assertions; making it zero unconditionally fails 9.

`wallet_lock()` is careful — it zeroes the mnemonic, passphrase, encryption key, and node
(`colibri-wallet.c:485-488`). The UI layer above it is not. The plaintext mnemonic sits in the
static `mnemonic_buffer` from the moment it is displayed until the next screen overwrites it,
across lock, across `pin_lock()`, and across `pin_wipe()` + `wallet_wipe()`. The import path
leaves the same data in `entry_words` and in the `full_mnemonic` stack frame.

This turns any memory-disclosure bug, crash dump, or JTAG pause into a seed disclosure, and it
means "Wipe Device" leaves the seed in RAM until reboot.

**Fix direction:** `memzero()` these on screen exit — the `screen_t` struct already has an
unused `.exit` hook (every screen passes `NULL`), which is exactly the seam for it.
`pin_wipe()` and the settings wipe path should zero the UI buffers too.

---

## S6 — ~~Seed generation may run with degraded entropy~~ FIXED

**Where:** `src/rand_esp32.c:11`, `sdkconfig.defaults`.

`random32()` forwards to `esp_random()`. Per the ESP-IDF documentation, the S3 hardware RNG is
only guaranteed to produce true random numbers while an RF subsystem (Wi-Fi or Bluetooth) is
enabled; otherwise entropy depends on the SAR ADC or RC fast clock being active. LeekWallet
generates mnemonics from the main menu with Wi-Fi and BLE both off by default — the RF stacks
are opt-in toggles buried in Settings.

I have not measured the actual output quality on this silicon, so I am flagging this as
"unverified and load-bearing" rather than "broken": for a wallet, seed entropy is the one thing
that must not be probabilistic.

**Fixed, and promoted from "measure someday" to top priority** by precedent: Coldcard shipped
exactly this bug. A build configuration error in firmware 4.0.1 (2021) made seed generation fall
back from the hardware RNG to a weak software source, cutting 128 bits to 40-72. It went
unnoticed for five years and was mass-drained in 2026. Our exposure had the identical shape —
one function, silently degrading, nothing watching the output.

`src/entropy.c` now gates all key material:

- `bootloader_random_enable()` wraps generation whenever RF is inactive; `ui.c` reports RF
  transitions via `entropy_set_rf_active()` so the ADC is never contended.
- NIST SP 800-90B style health tests (repetition count, proportion, distinct-value floor for
  seed-sized buffers) run on every output.
- **Fails closed.** `random_buffer()` — the function `mnemonic_generate()` calls — aborts rather
  than returning material that failed its tests. There is deliberately no fallback path.
- `entropy_dump_for_analysis()` emits raw RNG over serial for offline dieharder/STS runs.

`sim/test_entropy.c` covers stuck-at-zero, stuck-at-value, mid-buffer stalls, heavy bias, and
low-variety seeds, with 700 false-positive trials on healthy input.

**Building it found a real bug in my own test design:** NIST's Adaptive Proportion Test counts
occurrences of the window's *first* sample, which suits a continuous stream but not one-shot
validation — a source emitting 53% one value passed cleanly because the window happened to start
with a different byte. Replaced with a histogram-max test over the window, which is strictly
stronger and catches bias on the first buffer.

**Still outstanding:** the health tests catch a catastrophically broken RNG, not a subtly biased
one. Certifying quality needs a large offline sample through dieharder on real hardware. The dump
function exists for exactly that, and it has not been run yet.

---

## S7 — ~~Wipe is incomplete and unconfirmed~~ PARTIALLY FIXED

**Where:** `src/pin.c:252-267`, `src/ui.c:1560-1566`, `src/ui.c:592-597`.

`pin_wipe()` calls `nvs_erase_all()` on a handle opened for the `leek_pin` namespace only. It
does not touch the `colibri` namespace where the encrypted mnemonics live — `wallet_wipe()` is
a separate call the UI has to remember to make. It does in both current call sites, but they
are not atomic: a power cut between them leaves ciphertext with no PIN, or a PIN with no
wallet. Neither the settings wipe nor the failed-PIN wipe asks for confirmation, so a
mis-navigation in a 3-item menu destroys the wallet outright.

**Confirmation is fixed. Atomicity is now fixed too (T5).**

`device_wipe()` in `src/device-wipe.c` writes an intent marker to a third
namespace (`leek_wipe`) before touching anything, erases the wallet namespace
first and the PIN second, and clears the marker only once both have committed.
`device_wipe_resume()` runs at boot, before the UI can unlock, and finishes any
wipe the power cut interrupted. All three UI call sites now go through it.

Covered by `sim/test_device_wipe.c`: seven groups, each cutting power at a
different point. Reversing the erase order fails three of them and removing the
marker fails eight, so the suite is holding the property up rather than
describing it.

A live hardware test destroyed a wallet by selecting "Wipe Device" while scrolling a three-item
menu. `SCREEN_WIPE_CONFIRM` had been declared in the enum but never implemented, so the menu
item wiped instantly. It now shows what is about to be destroyed and requires three deliberate
OK presses; anything else aborts. The wipe also clears the UI-layer seed buffers, which the old
path did not.

Still open: `pin_wipe()` and `wallet_wipe()` remain two non-atomic calls. A power cut between
them leaves ciphertext with no PIN, or a PIN with no wallet. That needs a single `device_wipe()`
with a resume-on-boot flag.

---

## S8 — Correctness and robustness defects

| # | Where | Issue |
|---|-------|-------|
| a | `src/ui.c:764-775` | `screen_wallet_info_render` slices `eth_address.hex` at fixed offsets 0/16/30. When `enter` failed it writes short strings like `"Path failed"` into the same field, and lines 2-3 then render from zeroed padding. In bounds (the struct is memset at `ui.c:705`) but the user sees a truncated error over a blank address — indistinguishable from a real address at a glance. Use a separate error field. |
| b | `src/pin.c:191` | ~~PIN hash compared with `memcmp`~~ **fixed** — constant-time compare. |
| c | `src/pin.c:309` | ~~`pin_get_current(pin, 0)` writes `pin[-1]`~~ **fixed** — guarded. |
| ~~d~~ ✅ | `src/ui.c` | 24-word import: **fixed (T3)**. The import screen now opens with a 12/24 prompt and passes the answer to `mnemonic_entry_reset()`; BACK from the first character returns to it. Covered by the 24-word round-trip in `sim/test_mnemonic_entry.c`, which also pins the boundary — a 24-word phrase must not report itself complete at word 12. |
| e | `src/ui.c:1557` | "Change PIN" is a live menu item that logs `not yet implemented` and silently does nothing. `pin_change()` exists in `pin.c:269`. |
| f | `src/ui.c:857` | `screen_wallet_create_on_button` calls `ui_render()` re-entrantly from inside a button handler to paint "Generating...", then the caller invalidates again. Works, but the screen contract now has two render paths. |
| g | `src/ui.c:1272-1274` | Wi-Fi AP ships a hardcoded WPA2 password (`leek1234`) and the AP is reachable while the wallet is unlocked. It is a test feature; make it unavailable in release builds rather than a menu item. |
| h | `leek-wallet.c:129` | ~~AES-CBC with zero padding and no MAC~~ **authenticated implementation ready** in `src/vault-crypt.c`: AES-256-GCM, `nonce \|\| ciphertext \|\| tag`, nonce generated internally so it cannot be reused by a caller. Tests confirm a single flipped bit anywhere — nonce, ciphertext or tag — is rejected, where CBC produced a different plaintext and no error. **Wired in as storage format v3 and verified on hardware**: a device holding three v2 wallets migrated on unlock, and the same seeds derive the same addresses afterwards, confirmed by the user and by 20 successful derivations with no decrypt failures in the log. |
| i | `src/ui.c:1630-1636` | ~~The QR screen maps ACCEPT/DOWN to "reveal seed phrase"~~ **fixed**. Hardware testing hit it: the QR fills the display so there is no footer, and pressing a button to leave the screen instead locked the device and demanded the PIN. Revealing the seed now lives in Settings, labelled, and still re-asks for the PIN. |
| k | `src/oled.c` | ~~Every character was written straight to the panel, after `oled_clear()` blanked it over I2C~~ **fixed**. Hardware testing reported the screen flickering on every keypress, which was the frame being composed in front of the user: a blank panel, then ~20 separate I2C transactions filling it back in. Drawing now composes into a RAM buffer and the panel changes once per render. |
| j | `src/button.c:71` | `xQueueSend(..., 0)` drops button events when the 8-slot queue is full. Silent input loss during a slow render (PBKDF2 takes ~800 ms and blocks the UI task). Consider blocking briefly, or draining stale input after long operations. |

---

## Note on the target hardware

`platformio.ini:20` and `partitions.csv` are built for **4 MB flash, no PSRAM**
(`CONFIG_SPIRAM=n`). An **N16R8** module is 16 MB flash with 8 MB PSRAM. If the board is
changing, then `board_build.flash_size`, the partition table (currently a 3 MB app in a 4 MB
layout), and the PSRAM config all need to move together — and note that PSRAM is
[currently broken under QEMU](https://github.com/espressif/qemu/issues/129), so keep
`CONFIG_SPIRAM=n` for the emulated test target regardless.

There is also no `docs/leekwallet-logo.png` in the tree, so the README header image is broken.

---

## Suggested fix order

S3 and S2 are the ones a user hits on day one. S1 and S4 are the ones that matter once the
device holds real value. S5 is cheap and should ride along with any of them.

1. **S3** — import is 50/50 broken today, and the fix is contained to one function.
2. **S2** — unblocks any real PIN entropy; touches two handlers.
3. **S4** — ordering change in `pin_verify` plus a sentinel in `pin_init`.
4. **S1** — KDF swap is easy; flash encryption + secure boot is a day of QEMU work.
5. **S5**, **S7** — wire up the unused `.exit` hook, unify wipe.
7. **S8** — batch as cleanup.

Every one of these is testable on the host without hardware. See `sim/README.md`.
