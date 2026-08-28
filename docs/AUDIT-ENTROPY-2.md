# Entropy audit, second pass — verifying the fixes, and what the first pass missed

Scope: `src/entropy.c`, `src/entropy.h`, `src/rand_esp32.c`,
`scripts/check-rng-unique.sh`, and every consumer of `random_buffer()` /
`entropy_fill()`. `src/transport.c`, `src/session.c`, `src/button.c`, the vault
and the PIN code are read here but owned elsewhere; findings against them are
reported, not fixed.

This pass does not re-litigate `docs/AUDIT-ENTROPY.md`. It does two things:
check whether the six fixes claimed there hold, by measurement rather than by
reading the diff, and look where the first pass did not.

Toolchain as pinned: `platformio.ini` → `espressif32@6.12.0` → ESP-IDF 5.5.0.
Firmware builds clean at this commit (`pio run -e esp32s3`, SUCCESS, 92 s).

---

## 0. Verdict at a glance

| # | Claimed fix | Holds? |
|---|---|---|
| 1 | Duplicate `random_buffer()` removed, guarded by `check-rng-unique.sh` | **The fix holds; the guard did not.** 8 of 9 evasions succeeded, and the guard's stated reason for excluding `rand.c` is factually false — F-1, F-2. Guard rewritten. |
| 2 | RF flag set by `transport.c` at boot and on change; Wi-Fi separate; gate ORs them | **Partly.** Boot and suspend are correct and verified. Three windows remain where a radio is up and the gate believes otherwise — F-3, F-4, F-5. |
| 3 | 512-byte deep sample inside the same RNG window | **Holds.** Reproduced independently; the numbers are right to the third decimal — §3. |
| 4 | A mutex serialises the gate | **Holds for what it claims**, including `entropy_dump_for_analysis()`. It does not cover the RF flags or the user pool, and the header says "Serialised internally" without qualification — F-6, F-7. |
| 5 | Seed creation calls `transport_suspend()` | **Holds for USB and BLE**, on every exit path including cancel, auto-lock and generation failure. It does not suspend Wi-Fi, and a comment says it does — F-8. |
| 6 | `mnemonic_clear()` is called | **Holds.** Both call sites verified. One plaintext copy the first pass did not enumerate survives elsewhere — F-9. |

New findings past the first pass: **F-10** (HIGH, documentation) — the
bits-per-press justification names the wrong source for the bits, and the first
pass's own recommended improvement would, implemented as written, cut a
rhythmic user's contribution by an order of magnitude. **F-11** — the SLIP-39
RNG hook is a runtime-replaceable second path in production firmware.

Two low-risk defects fixed in this pass; everything else is reported only. See
§8.

---

## 1. Fix 1 — one `random_buffer()`, and a guard that did not guard

### The linker question, settled

The duplicate is gone from `components/trezor-crypto/rand_esp32.c` (now a
comment-only file) and the surviving definition is the checked one. Confirmed
against the ELF this pass built, not against the previous audit's note:

```
$ xtensa-esp32s3-elf-nm .pio/build/esp32s3/firmware.elf | grep random
4200a2e8 T random32
4200a2f8 T random_buffer
$ xtensa-esp32s3-elf-addr2line -f -e .pio/build/esp32s3/firmware.elf 0x4200a2f8
random_buffer
/IDF_PROJECT/src/rand_esp32.c:41
```

So every seed byte on a shipped image goes through `entropy_fill()`. That half
of the fix holds.

### F-1 — HIGH (documentation) · the guard's stated reason for excluding `rand.c` is false

`scripts/check-rng-unique.sh` excluded `components/trezor-crypto/rand.c` by
name, and said why:

> `rand.c`'s copies live inside `#ifdef USE_INSECURE_PRNG`, which the check
> above proves is never set, so that file is excluded by name rather than by
> trying to parse preprocessor conditionals in grep.

That is true of `random32()` and **false of `random_buffer()`**. Reading
`rand.c`: the `#endif /* USE_INSECURE_PRNG */` is at line 51, and

```c
void __attribute__((weak)) random_buffer(uint8_t *buf, size_t len) {   /* line 58 */
```

sits below it, compiled unconditionally on every build. It is in the shipped
archive:

```
$ xtensa-esp32s3-elf-nm .pio/build/esp32s3/esp-idf/trezor-crypto/libtrezor-crypto.a
00000000 W random_buffer
```

and it is not a dead symbol in the source sense either — compiling `rand.c` on
the host without a `random32()` fails to link *because of that function*:

```
/usr/bin/ld: rand.c:(.text+0x3f): in function `random_buffer':
             undefined reference to `random32'
```

So the one file the guard refuses to look at is the one file that contains a
live second definition of the function the guard exists to keep unique.

The situation is not dangerous today, and the reason it is not is a different
reason than the one written down. `rand.c`'s copy is **weak** and
`src/rand_esp32.c`'s is **strong**, so GNU ld picks the strong one
deterministically — this is a language rule, not the archive-order accident the
original defect rode on. The exclusion is therefore correct; its justification
is not. That matters because the next person to touch this reads the comment,
not the object file, and a comment that says "the macro protects us" invites
deleting the strong definition and getting a silent, gateless
`random_buffer()` — which is precisely the failure this file was written to
prevent. **Fixed**: the comment now states the weak/strong rule and cites the
`nm` and `addr2line` output above.

### F-2 — HIGH · the guard was evadable eight ways out of nine

The guard matched a definition as `^(void|uint32_t)[[:space:]]+${sym}\(` over
`src` and `components`. I wrote each plausible second definition into the tree
and ran the guard. Results **before**:

| | evasion | guard |
|---|---|---|
| A | plain `void random_buffer(` in `src/` | caught |
| B | `__attribute__((used)) void random_buffer(` | **evaded** |
| C | return type on its own line | **evaded** |
| D | `typedef void v; v random_buffer(` | **evaded** |
| E | definition under `lib/` | **evaded** |
| F | `#define random_buffer(b,n) esp_fill_random((b),(n))` | **evaded** |
| G | `#define USE_INSECURE_PRNG 1` in `components/trezor-crypto/options.h` | **evaded** |
| H | `USE_INSECURE_PRNG` in `src/CMakeLists.txt` | **evaded** |
| I | `USE_INSECURE_PRNG` in `platformio-local.ini` | **evaded** |

B/C/D are the shapes a vendored-library update or a refactor produces without
anyone intending anything. **E is the material one**: `lib/README` states that
PlatformIO "will compile them to static libraries and link into the executable
file" — an archive member, which is exactly the shape of the original bug, in a
directory the guard did not search. G–I: the `USE_INSECURE_PRNG` search covered
`platformio.ini`, `CMakeLists.txt`, `sdkconfig*` and
`components/*/CMakeLists.txt` and no headers at all, while a `#define` in
`options.h` compiles exactly as well as a `-D`.

G is loud in practice — with the macro set, `rand.c` defines a strong
`random32()` and so does `src/rand_esp32.c`, so the link fails on a duplicate
symbol rather than silently swapping in the LCG. That is luck, not design, and
it depends on `src/rand_esp32.c` continuing to define `random32()`.

**Fixed.** The definition search now matches on the shape of a definition
rather than on the return type (symbol applied to an argument list, on a line
that is not a statement and is not comment prose), searches `lib/` as well, and
the macro search covers `*.c`/`*.h`/`*.ini`/`*.txt`/`*.cmake`/`sdkconfig*`/`*.py`
across the tree with `rand.c` — the file that legitimately names the macro in
its own `#ifdef` — excluded. **After**: A–E, G, H and I all caught; the clean
tree still passes.

**F remains open, and no source-text check will close it.** A macro that
redirects the *call site* leaves the definition unique and correct. The check
that would catch F, and all of A–E without regexes, is the one the audit trail
already shows a human doing by hand: resolve `random_buffer` in the built ELF
with `addr2line` and assert it lands in `src/rand_esp32.c`. That is a
recommendation, not a change — it needs a built artefact, which `check.sh`'s
`sim` stage deliberately runs before. See §7 R-1.

---

## 2. Fix 2 — the RF flag. Boot and suspend are right; three windows are not

`transport_apply()` reporting the flag closes the boot hole the first pass
found, and I verified the two cases the brief names:

- **Early boot, before `transport_init()`.** `ble_active` and `wifi_active`
  are both statically `false`, and both radios genuinely are off. Nothing draws
  entropy before `transport_init()`: `main.c` runs display → buttons →
  `ui_init()` → `transport_init()` → `protocol_start()` → `xTaskCreate(ui_task)`,
  so the two tasks that can reach `random_buffer()` are created *after* the flag
  is correct. **Correct, no finding.**
- **During `transport_suspend()`.** `ble_transport_stop()` runs
  `nimble_port_stop()` + `nimble_port_deinit()` — the controller is actually
  torn down, not just de-advertised — and only *then* is
  `entropy_set_ble_active(false)` called. The flag lags in the safe direction:
  it claims a radio is up slightly longer than one is. **Correct, no finding.**

Three windows remain.

### F-3 — MEDIUM · the flag is set *after* the radio comes up, in both directions

`transport_apply()` (`transport.c:60-90`) calls `ble_transport_start()`, which
returns with NimBLE initialised, GATT registered and the host task running —
and `entropy_set_ble_active(true)` is the *last* statement of the function,
after the writer install and the `current` assignment. The Wi-Fi toggle has the
identical shape: `esp_wifi_start()` at `ui.c:2490`, `entropy_set_wifi_active(true)`
at `ui.c:2493`.

In that window a concurrent `entropy_fill()` — `session_begin()` on a host
connect, a vault salt or IV on a wallet store — reads `rf_is_active() == false`
and calls `bootloader_random_enable()` while the radio owns the SAR ADC. That
is the condition Espressif's Random Number Generation page names as unsafe, and
it is the same defect the fix moved out of the settings screen, not one it
removed. The window is short and the flags are written from a different task
than the gate's reader, so this is narrow rather than routine.

`AUDIT.md:266` states the consequence as settled — "the gate ORs them — so the
ADC is never contended". It is contended for the length of that window.
Reported, not fixed: the ordering change is in `transport.c`, which this audit
does not own.

### F-4 — LOW (latent) · `transport_apply()`'s failure path skips the flag entirely

```c
if (!ble_transport_start()) {
    protocol_set_rx_enabled(true);
    current = TRANSPORT_USB;
    return false;               /* <- returns before entropy_set_ble_active() */
}
```

If `ble_active` were `true` on entry, a failed BLE start would leave the gate
believing a radio is up when none is — and *that* direction is the dangerous
one: the gate then skips `bootloader_random_enable()` and every subsequent
draw, seeds included, comes from an `esp_random()` that Espressif documents as
"pseudo-random only", silently.

I could not reach it. `transport_set()` returns early when `kind == current`,
`ble_transport_start()` returns `true` immediately when already `running`, and
every path that reaches a *failing* start has been through a stop that cleared
the flag. So this is latent, not live. It is worth recording because the
invariant that saves it lives three functions away in two other files, and the
early return is the one exit from `transport_apply()` that does not maintain the
flag.

### F-5 — LOW · the flags are read under the gate lock and written outside it

`ble_active` and `wifi_active` are plain `bool`s written from the transport task
and from `ui_task`, and read inside `entropy_fill()`'s critical section. The
mutex does not extend to them, so even with F-3's ordering corrected the read
and the radio state can disagree by a scheduling quantum. On Xtensa a `bool`
store is atomic, so there is no torn read — the exposure is staleness, not
corruption, and it is the same window F-3 describes.

### F-3b — the same asymmetry, inside this module · **FIXED**

`entropy_dump_for_analysis()` called `rf_is_active()` twice: once to decide
whether to enable, and again to decide whether to disable. Because the flags are
written by other tasks and are not under the lock, those two calls can disagree,
and both ways it can disagree are wrong:

- a radio comes up mid-dump → the disable is skipped → the SAR ADC noise source
  is left running underneath a live radio, indefinitely, for the rest of the
  boot;
- a radio goes down mid-dump → `bootloader_random_disable()` is called for a
  window this function never opened → the bootloader RNG is turned off for
  whoever did open one.

`entropy_fill()` gets this right — it latches the decision in a local
`bootloader_rng`. The dump path did not. **Fixed** by latching it the same way.
Unreachable today (the function still has no callers, see F-12), which is why
it is safe to fix here rather than recommend.

---

## 3. Fix 3 — the 512-byte deep sample. Verified independently

I rebuilt the harness from scratch against the current `src/entropy.c`
(`-DLEEK_HOST_TEST`), with an independent xoshiro256\*\* reference stream, and
reran every figure the first pass quotes. 2 000 000 buffers per length for false
positives, 200 000 trials per detection cell.

**False positives — zero, at every length:**

```
len=  12  0/2000000 rejected (0.00e+00)
len=  16  0/2000000 rejected (0.00e+00)
len=  32  0/2000000 rejected (0.00e+00)
len=  64  0/2000000 rejected (0.00e+00)
len= 512  0/2000000 rejected (0.00e+00)
len=1024  0/2000000 rejected (0.00e+00)
```

**Detection, biased source (0x00 with probability p, else uniform):**

| p | len=32 | len=512 | first pass claimed (512) |
|---|---|---|---|
| 0.05 | 0.0000 | **0.9938** | 0.9942 |
| 0.10 | 0.0000 | 1.0000 | 1.0000 |
| 0.25 | 0.0052 | 1.0000 | 1.0000 |
| 0.50 | **0.2082** | **1.0000** | 0.2087 → 1.0000 |
| 0.75 | 0.8664 | 1.0000 | 1.0000 |
| 0.90 | 0.9983 | 1.0000 | 1.0000 |

**Detection, clean-but-shallow (SHA-256 counter mode over a k-bit key — the
Coldcard shape):**

```
 8-bit key: len=32 0/200000 (0.0000)   len=512 0/200000 (0.0000)
16-bit key: len=32 0/200000 (0.0000)   len=512 0/200000 (0.0000)
24-bit key: len=32 0/200000 (0.0000)   len=512 0/200000 (0.0000)
32-bit key: len=32 0/200000 (0.0000)   len=512 0/200000 (0.0000)
40-bit key: len=32 0/200000 (0.0000)   len=512 0/200000 (0.0000)
```

**The fix holds and the claimed numbers are accurate to the third decimal.**
0.21 → 1.00 for a ~1 bit/byte source is real, the false-positive rate really is
zero (so the gate will not `abort()` healthy hardware), and — importantly — the
first pass's *negative* claim is also accurate: the deep sample buys **nothing**
against a shallow-but-clean source. `README.md:436-443` and `entropy.h:132-140`
both state that limitation plainly. Good documentation.

Code review of the mechanism confirms the ordering the numbers depend on: the
deep draw happens inside the same `bootloader_random_enable()` window as the
caller's draw (`entropy.c:435-452`), the health check still runs on the **raw**
hardware bytes before the user-pool mix (`entropy.c:478` precedes the mix block
at `:502`), and `deep_sample` is `memzero`d before the lock is released.

The trigger rule is as documented — first draw of a boot regardless of size,
then every draw ≥ 16 bytes — and `deep_check_done` is set only on `ENTROPY_OK`,
so a failing source is re-checked rather than latched. Correct.

---

## 4. Fix 4 — the mutex. Covers the window it claims, and nothing else

Every path that opens the process-wide bootloader-RNG window takes `gate_lock`:
`entropy_fill()` at `:419` and `entropy_dump_for_analysis()` at `:539`, with a
give on all five exits of the former. `last_result` is written inside it on
every path but one. Lazy creation on first use is sound here — the first call
happens from vault code long before `ui_task` exists, and there is no
initialisation order to get wrong. Failure to take the lock within 5 s is
treated as a health failure, so it fails closed. **The fix holds.**

Two gaps, both narrow:

### F-6 — LOW · `last_result` is written outside the lock on the argument-check path

```c
if (!buf || len == 0) {
    last_result = ENTROPY_FAIL_NO_SOURCE;   /* not under gate_lock */
    return false;
}
```

A concurrent `entropy_fill()` holding the lock can have its `last_result`
overwritten by this, so `rand_esp32.c` would print the wrong reason in the
message immediately before `abort()`. Diagnostics only — the abort still
happens, and it happens for the right buffer.

### F-7 — LOW · the lock does not cover the user pool, and the header does not say so

`entropy.h:141` says "Serialised internally," unqualified. What is serialised is
the hardware window and `last_result`. `entropy_mix_pool()` reads `user_pool`
and `user_events` from inside the lock, while `entropy_add_user_event()` and
`entropy_reset_user_pool()` write them from `ui_task` with no lock at all.

There is no live race, and the reason there is none is instructive: the entropy
screen suspends both transports, so during collection the only task that can
reach the gate is the one doing the collecting. That is the same "the other
task cannot be running right now" argument the mutex was added precisely to
stop relying on. A `SHA256_CTX` shared across a lock boundary is worth either
bringing inside the lock or documenting as deliberately outside it.

---

## 5. Fix 5 — `transport_suspend()` during generation. Airtight for USB and BLE

I traced every way to re-enable a transport between `screen_entropy_enter()` and
the end of the seed flow.

- `transport_resume()` has exactly one caller in the tree,
  `screen_main_menu_enter()` (`ui.c:1565`). There is no timeout resume, no error
  resume, no host-triggered resume.
- **Cancel** (`BUTTON_CANCEL` on the entropy screen) → `SCREEN_MAIN_MENU` →
  resume. Correct.
- **Generation failure** (`wallet_create_run_generation()`, unlock failure or
  `wallet_create_mnemonic()` error) sets an error string and stays on the
  create screen; the links stay suspended until the user reaches the main menu.
  Fail-safe direction.
- **Auto-lock mid-flow.** `lock_check_timeout()` fires inside `ui_task`'s loop
  and can move the screen to the unlock/PIN screen from
  `SCREEN_MNEMONIC_DISPLAY`. That is not the main menu, so the links stay
  suspended — again the safe direction — and `forget_mnemonic_unless_needed()`
  runs on the way out. The device can be left with both links down until the
  user navigates to the main menu; that is an availability quirk, not a
  weakness.
- **A screen change mid-generation** is not reachable: generation runs
  synchronously inside `ui_poll_deferred()` with no button processing, and
  `button_drain()` discards presses made during it.
- **`transport_suspend()` is idempotent** (`if (suspended) return;`), so
  re-entering the entropy screen cannot lose `resume_to`.
- **Reboot-and-resume.** `suspended` is RAM state, so a reboot during the flow
  brings the stored link back up. Generation is not resumable, so there is no
  half-made seed to serve — but note that `wallet_create_mnemonic()` **stores
  and selects** the wallet before the words are displayed, so a reboot between
  generation and display leaves a stored seed the user has never seen. That is a
  backup-integrity issue, not an entropy one, and it is out of this audit's
  scope; recording it because the suspend/resume trace is where it surfaced.

### F-8 — MEDIUM (documentation) · `transport_suspend()` does not suspend Wi-Fi, and a comment says it does

`screen_entropy_enter()` (`ui.c:2846`) says:

> Nothing may be listening while a seed is made. This is the first screen of
> wallet creation, so suspending here covers the whole of it.

`transport_suspend()` tears down BLE and disables the USB protocol endpoint. It
does not touch Wi-Fi. In the `wifi` build environment a user who enabled the AP
from the settings screen and then created a wallet has an access point up
through collection, generation, display and verification.

The entropy gate itself handles this correctly — `wifi_active` is true, so it
takes the RF-is-up branch and `esp_random()` is a true RNG. What is wrong is the
claim, and the claim is the one a reader relies on. The Wi-Fi AP is compiled out
of the default build (`platformio.ini` gates it behind a separate env, and
`README.md` calls it a development fixture with a hardcoded password), which is
why this is MEDIUM rather than higher.

---

## 6. Fix 6 — `mnemonic_clear()`, and the plaintext copies

`mnemonic_clear()` is called from two places, both in `ui.c`:
`forget_mnemonic_unless_needed()` (the `.exit` hook on
`SCREEN_MNEMONIC_DISPLAY`, `SCREEN_MNEMONIC_VERIFY` and two others) and the
wipe-confirmation path at `ui.c:3027` which does not exit through that hook.
The placement argument in the first pass is right and the hook fires on every
transition out of the pair. **The fix holds.**

I then enumerated every remaining plaintext copy of a generated phrase:

| copy | lifetime | covered? |
|---|---|---|
| `bip39.c`'s `static CONFIDENTIAL char mnemo[240]` | until the exit hook | yes, by this fix |
| `ui.c`'s `static char mnemonic_buffer[256]` | until the exit hook | yes, and separately at `:858`, `:1916`, `:3022`, `:3291`, `:5145` |
| `leek-wallet.c`'s `state.mnemonic` | until `wallet_lock()` | by design — it is the unlocked wallet |
| `word[]` locals in the display and verify renderers | function scope | stack, overwritten immediately |
| CBOR / protocol buffers | — | **never populated.** `grep -n mnemonic src/protocol.c` returns nothing: no protocol path reads or transmits a phrase |
| serial log | — | **clean.** The only log lines near the phrase are `"Displaying %d words"` and `"Created %d-word mnemonic as wallet #%d"` — counts and indices, no words |

### F-9 — LOW · the seed words survive in the OLED framebuffer as a bitmap

`src/oled.c:225` holds `static uint8_t framebuffer[OLED_WIDTH * OLED_PAGES]`, and
the mnemonic display screen renders four words into it per page. Nothing zeroes
it when the seed flow ends: `forget_mnemonic_unless_needed()` clears both text
buffers and leaves the rendered glyphs. It is overwritten by the next screen's
`oled_clear()` (every render begins with one), so the window is one repaint —
but it is a window in which a crash dump or a JTAG halt yields the seed as a
legible 128×64 bitmap, which is exactly the threat the exit-hook comment at
`ui.c:569-576` names ("into any crash dump or JTAG pause taken in between").
The first pass's `memzero` inventory did not include the framebuffer.

Reported rather than fixed: `oled.c` is display code and the right call is
whether the hook should force a repaint or blank the buffer, which is a UI
decision.

### F-9b — informational · `mnemonic_from_data()` returns a pointer into a shared static

Two live mnemonics cannot coexist; a second call invalidates the first caller's
pointer. Not reachable in this firmware (one generation at a time), but it
surfaced immediately when I called it twice in a test harness, and it is the
kind of thing an import-plus-generate screen would trip over.

---

## 7. Past the first pass

### 7.1 The user pool, audited adversarially

The screen credits `BITS_PER_EVENT = 2` × `ENTROPY_TARGET_EVENTS = 64` = 128
bits and unlocks NEXT there. The question is what a user who is *trying* to be
predictable, or who is simply rhythmic, actually contributes.

**First, the mechanism, checked rather than assumed.**

- **A held button yields one event, not many.** `button_poll_once()` emits only
  on a released→pressed transition after 100 ms of stable level
  (`button.c:107-119`). There is no auto-repeat. A user who holds a button down
  cannot inflate the counter; they must physically release and press 64 times.
  This is the obvious attack on a press counter and the code is immune to it.
- **Which button is not credited.** Only UP and DOWN collect, ACCEPT never does
  (`ui.c:2929-2942`), and the value hashed is `button ‖ timestamp_us`. A
  one-button masher and a four-button masher contribute the same, as the comment
  says.
- **The timestamp hashed is not the button's own.** `button_event_t.timestamp`
  is stamped in `button_poll_once()` — on the strictly periodic 10 ms grid — and
  then **discarded**: `screen_entropy_on_button()` re-reads
  `esp_timer_get_time()` at `ui.c:2941` when `ui_task` dequeues. This turns out
  to be the single most important fact about the pool, and no comment in the
  tree mentions it.

**Then, the measurement.** I modelled the full chain — press → 10 ms poll grid →
100 ms debounce floor → `ui_task` dequeue latency — and estimated the entropy of
the sequence of hashed values as the sum of the marginal entropies of successive
differences over 300 000 simulated sessions of 64 presses. Summing marginals
ignores correlation between a human's consecutive intervals, so **every figure
below is an upper bound.**

```
irregular user  400 +- 150 ms   Shannon 16.29  min-entropy 14.58 bits/press
steady user     300 +-  30 ms   Shannon 14.09  min-entropy 12.37 bits/press
rhythmic user   300 +-   5 ms   Shannon 11.72  min-entropy 10.47 bits/press
metronomic      300 +-   1 ms   Shannon 11.38  min-entropy 10.17 bits/press
masher at floor 100 +-   8 ms   Shannon 11.01  min-entropy  9.63 bits/press
mechanical      300 +- 0.2 ms   Shannon 10.88  min-entropy  9.66 bits/press
perfect metronome, 300 ms exact Shannon 10.45  min-entropy  9.46 bits/press
```

(dequeue latency modelled as 60 µs + half-normal, σ = 400 µs)

**2 bits per press is comfortably conservative — for reasons the code does not
state.** Even a mechanical presser clears 9 bits. But re-run the same models
with the dequeue latency removed, i.e. hashing the press's own `button.c`
timestamp instead of `ui_task`'s re-read:

```
rhythmic user   300 +- 5 ms       Shannon  1.27  min-entropy  1.05 bits/press
perfect metronome, 300 ms exact   Shannon  0.00  min-entropy  0.00 bits/press
```

**Zero.** Once the human interval is quantised to the 10 ms grid, a periodic
user contributes nothing at all. Everything the pool collects from a regular
user is scheduler jitter in `ui_task`'s wakeup. Sweeping how variable that
latency is, for the perfect metronome:

| dequeue latency σ | min-entropy/press | over 64 presses |
|---|---|---|
| 0 µs | 0.00 | **0 bits** |
| 1 µs | 0.88 | 56 bits |
| 5 µs | 3.15 | 198 bits |
| 20 µs | 5.15 | 324 bits |
| 100 µs | 7.47 | 470 bits |
| 400 µs | 9.46 | 596 bits |

The credited 128 bits is reached somewhere between 1 and 5 µs of genuine
latency variance. That is almost certainly satisfied on a device also running a
10 ms poll task, an I²C OLED refresh and idle housekeeping — but **it has never
been measured**, and it is a hardware measurement (§9).

### F-10 — HIGH (documentation) · the bits-per-press justification names the wrong source, and the recommended improvement is a regression

Three claims rest on the wrong mechanism:

1. `entropy.h:88-90`: "They come from `timestamp_us`: the interval between two
   human keypresses carries jitter that no attacker can predict or reproduce."
   Measured: for anyone pressing regularly the human interval carries **0 to 1
   bits per press** after the 10 ms grid. The bits come from RTOS scheduler
   jitter.
2. `entropy.c:184-189`: "Two is the number that survives all of that: a floor
   that holds for a user pressing in near-time, not a mean for a user pressing
   well." The derivation above it reasons entirely about human cadence, which is
   the component that goes to zero in the adversarial case. The number is right;
   nothing in the stated derivation establishes it, and the case it does not
   consider — a user deliberately keeping time — is the one where the stated
   mechanism vanishes.
3. `entropy.h:100-103`: "even with a completely broken silicon source, a seed
   generated after 64 presses is not brute-forceable." True given a few
   microseconds of dequeue jitter. Not true from the argument given.

The practical consequence is the important half. `docs/AUDIT-ENTROPY.md` §9 and
R5 record, as an open decision, that the *better* fix is to "timestamp the raw
GPIO edge in `button_poll_once()` before the debounce delay", which "recovers
real sub-tick jitter and makes the microsecond claim true" and would "let the
target go back to 32 presses". Measured against the actual chain, that change
implemented as written moves the hashed value from `ui_task`'s re-read to a
timestamp taken *on the 10 ms poll grid* — the second block of numbers above —
and takes a rhythmic user from ~10.5 bits per press to ~1.05, and a metronomic
one to zero. **It would be a large regression for the exact case the pool
exists to cover, while halving the press count on the strength of it.**

An edge timestamp only recovers sub-tick jitter if it is taken in a GPIO
*interrupt*, not in the existing 10 ms polling loop. The first pass's own text
says "an ISR timestamp", but the recommendation body says
`button_poll_once()`, and `button.c`'s header says "Polling-based ... more
reliable than interrupts for noisy buttons". Anyone implementing R5 from the
recommendation as phrased ships the regression.

Recommended (not done — `entropy.c`'s comments are mine to fix, `button.c` and
the roadmap are not): correct the three comments to attribute the bits to
dequeue jitter, and annotate R5 in `docs/AUDIT-ENTROPY.md` §9 with the
measurement so the "better" option is not taken on trust.

### 7.2 Can a bad pool reduce the output's entropy? No

Verified by construction against `entropy.c:502-520`:

```
out = SHA256("leek-entropy-mix-v1" ‖ hw_chunk(32) ‖ index_le32 ‖ SHA256(pool) ‖ count_le32)
```

The hardware chunk is a 32-byte input to the hash and the output is 256 bits.
For a full-entropy hardware draw, `H(out) = H(hw)` up to SHA-256 collision
slack. A user who contributes nothing takes the `user_pool_init == false` branch
and receives the raw hardware bytes unchanged. A user who contributes a
*constant* pool makes `out` a fixed bijection-like function of `hw` — no loss.
There is no XOR, no truncation of the hardware input, and no path where pool
material replaces hardware material. **`entropy.h:82-84`'s claim that a rhythmic
one-button masher "cannot make the result worse than hardware alone" is
correct.** The health check running on the raw bytes *before* the mix
(`:478` before `:502`) is what stops the pool from laundering a dead source, and
that ordering is intact.

Truncation for short draws is clean: `chunk` is clamped, the short case
zero-pads deterministically, and only `chunk` bytes are copied back. For the
12-byte GCM nonce this makes the nonce a deterministic function of 12 hardware
bytes plus constants — uniqueness still reduces to hardware uniqueness, which is
what a GCM nonce needs.

The first pass's E-6 (no length prefixes in `entropy_mix_pool`, pool presence
not domain-separated) is unchanged and still not reachable in production:
`hw_len` is always 36 and `entropy_fill()` is the only caller.

### 7.3 SLIP-39

All three randomness draws route through `slip39_random()` → `entropy_fill()`:
the random share values (`:373`), the digest share padding (`:384`), and the
identifier (`:565`). Each is a separate `entropy_fill()` call, so a 2-of-3 split
performs several enable/deep-check/fill/disable cycles — correct, now serialised
by the mutex, and at ~2.8 ms per deep check the cost is invisible against share
generation. `memzero` coverage across the generation path is thorough.

### F-11 — LOW · `slip39_set_random_source()` is a runtime second path in production firmware

```c
static bool (*rng_hook)(uint8_t *buf, size_t len);
void slip39_set_random_source(bool (*fn)(uint8_t *buf, size_t len));
```

`slip39-backup.h:106-110` says randomness comes from `entropy_fill()` "never
from a bare `esp_random()`", and `slip39-backup.c:52-60` argues at length that
there is "no fallback source by design". Both are true only as long as nothing
calls the setter, which is a runtime property rather than the structural one the
comments assert — and structural uniqueness is exactly what
`check-rng-unique.sh` was built to guarantee for `random_buffer()`. The hook
exists for the host suite (`sim/test_slip39.c`), where `entropy_fill()`
deliberately refuses. It has no production caller today.

The cheap improvement is `#ifdef LEEK_HOST_TEST` around the setter, which makes
the comment's claim structural. Not done here: it is a one-line change to a file
this audit does own, but removing an exported symbol has a build-surface
consequence for the test suite that deserves its own review rather than an
audit's drive-by. See R-3.

### 7.4 BIP-39, end to end

Checked with a purpose-built harness against `components/trezor-crypto/bip39.c`,
not by reading:

- **Bit packing round-trips exactly.** data → words → indices → bit string →
  data, over 200 000 random inputs at each length: **0 failures at len=16
  (12 words) and 0 at len=32 (24 words)**.
- **Checksum is standard BIP-39 and correct at both lengths.** `bits[len] =
  bits[0]` takes the top 8 bits of `SHA256(data)`; the word loop consumes 4 of
  them for 12 words and 8 for 24. Recomputed independently in the harness and
  compared under the right mask for each length: 0 mismatches in 400 000 trials.
  `mnemonic_check()` accepts every generated phrase, and
  `wallet_create_mnemonic()` re-verifies with it before storing
  (`leek-wallet.c:1559`).
- **12 vs 24.** `mnemonic_generate()` always draws 32 bytes and uses
  `strength/8` of them, so a 12-word seed keeps the first 16. Both lengths
  therefore present a 32-byte buffer to the health check. Correct — and worth
  noting that the distinct-value floor then covers 32 bytes of which only 16
  become the seed.
- **No modulo bias, and no amplification of a biased byte.** Indices are sliced
  straight out of the bit string; there is no rejection sampling and none is
  needed. Word-index uniformity over 9.6 M indices from uniform bytes:
  **χ² = 2028.2 on 2047 df** (expected 2047 ± 64), min 4463 / max 4910 against
  an expectation of 4687.5. Forcing byte 0 to `0x00` leaves word 0 taking
  **exactly 8 of 2048 values** — the three bits of word 0 that come from byte 1
  — and leaves every later word untouched. A biased byte biases precisely the
  words that consume its bits and no others; nothing amplifies.
- `esp_random() % mnemonic_word_count` at `ui.c:3141` picks which words to quiz
  the user on. It is a bare `esp_random()` outside the gate — so with no radio up
  it is the documented pseudo-random path — but the value is not key material
  and the chosen words are displayed to the user anyway. Not a finding.

### 7.5 Things the first pass declared unverified

- **`entropy_dump_for_analysis()` "Debug builds only" (E-7).** Still not
  enforced — no `#ifdef`, no `NDEBUG` guard, and `entropy.h:150-154` still says
  it. It is not listed as fixed anywhere, so this is an accurate open item
  rather than a stale claim. **F-12**, unchanged from E-7. It still has no
  callers, which also means `AUDIT.md:273`'s "emits raw RNG over serial for
  offline dieharder/STS runs" describes a facility nobody can invoke.
- **dieharder / NIST STS on real hardware (R8).** Still owed, still honestly
  declared owed in `README.md:533` and `AUDIT.md`. Nothing in this pass changes
  that; see §9.
- **The IDF `last_ccount` non-atomic static in `hw_random.c`.** Re-confirmed
  present in the pinned 5.5.0 source. Upstream's; the gate lock narrows it to
  this firmware's callers.

---

## 8. Changed in this pass, versus recommended

**Changed** (two low-risk defects, both unambiguous):

1. `src/entropy.c` — `entropy_dump_for_analysis()` now latches whether *it*
   enabled the bootloader RNG in a local, instead of asking `rf_is_active()`
   again at the end. Closes F-3b. Unreachable today; the function has no
   callers.
2. `scripts/check-rng-unique.sh` — the definition search matches on the shape of
   a definition rather than on the return type, searches `lib/` as well as `src`
   and `components`, and the `USE_INSECURE_PRNG` search covers headers and the
   whole tree rather than four build files. The comment that justified excluding
   `rand.c` by a `#ifdef` that does not contain `random_buffer()` is replaced
   with the weak/strong-symbol reason, quoting the `nm` and `addr2line` output.
   Closes F-1 and F-2 (A–E, G–I; F remains, see R-1).

**Recommended, not done:**

- **R-1** — assert the RNG's identity in the linked ELF, not in the source text:
  `addr2line` on `random_buffer` must land in `src/rand_esp32.c`. It is the only
  check that catches a call-site macro (evasion F) and it catches A–E for free.
  Needs a built artefact, so it belongs in `check.sh`'s `firmware` stage rather
  than `sim`.
- **R-2** — `transport.c`: set the RF flag *before* bringing a radio up, as it
  is already cleared after bringing one down, and maintain it on
  `transport_apply()`'s failure return. Closes F-3 and F-4. Not this audit's
  file.
- **R-3** — `#ifdef LEEK_HOST_TEST` around `slip39_set_random_source()`, making
  `slip39-backup.h`'s "never from a bare `esp_random()`" structural. F-11.
- **R-4** — correct the three comments that attribute the pool's bits to human
  keypress intervals (`entropy.h:88-90`, `entropy.h:100-103`,
  `entropy.c:184-189`), and annotate R5 in `docs/AUDIT-ENTROPY.md` §9 with §7.1's
  measurement so the "better option" is not implemented on trust. F-10. Left
  undone because the correction should be made together with whatever decision
  §9 reaches about `button.c`, not ahead of it.
- **R-5** — `AUDIT.md:266` "so the ADC is never contended" and `ui.c:2846`
  "Nothing may be listening while a seed is made" both overstate; F-3 and F-8.
- **R-6** — either bring the user pool inside `gate_lock` or say in `entropy.h`
  that it is deliberately outside it. F-7.
- **R-7** — blank or repaint the OLED framebuffer when the seed flow exits.
  F-9.
- Dice entropy (first pass R4) and verifiable generation (R9) are unchanged as
  open decisions, and §7.1 strengthens the case for the first: it is the only
  proposal that makes the user's contribution *countable* rather than dependent
  on an unmeasured scheduler property.

---

## 9. Not verifiable without hardware

- **The dequeue-latency variance that the whole user pool now rests on.**
  §7.1 shows the credited 128 bits is reached at somewhere between 1 and 5 µs of
  genuine variance in `ui_task`'s wakeup, and everything below that is
  extrapolation from a model. The measurement is small and worth making: on a
  board, log `esp_timer_get_time()` deltas between `button_poll_once()`'s stamp
  and `screen_entropy_on_button()`'s re-read across a few hundred presses, and
  histogram them. If that distribution is narrow, `BITS_PER_EVENT` is wrong in
  the unsafe direction for a rhythmic user.
- **Whether `bootloader_random_enable()` measurably changes the output.** The
  gate's entire premise is Espressif's documentation. Nothing here has compared
  a sample drawn with the SAR ADC noise source on against one drawn with it off,
  on silicon.
- **dieharder / NIST STS on real output**, in both the RF-up and
  bootloader-RNG configurations. Blocked on F-12: the function that exists to
  produce the sample has no caller.
- **The F-3 window in practice** — whether a `session_begin()` draw can actually
  land inside `transport_apply()`'s radio-up-flag-not-yet-set window depends on
  task priorities and NimBLE's startup timing, which is a trace on hardware, not
  a reading.
- **`memzero()` actually clearing.** All the zeroization reviewed here is
  correct in source. Whether the compiler kept it, and whether a copy survives
  in a register or a stale stack frame, is a question for a JTAG halt or a core
  dump on the device.
