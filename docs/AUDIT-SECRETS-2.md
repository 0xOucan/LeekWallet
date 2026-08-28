# Secret-handling audit, second pass

Scope: the PIN, the vault, and everything in flash that touches them. This is a follow-up to
`docs/AUDIT-SECRETS.md` and deliberately does not repeat it — the first pass's findings are taken
as read, its top finding (F1, the unsalted SHA-256×101 PIN verifier) is re-verified rather than
re-argued, and everything new is numbered N*.

State audited: branch `audit2/vault`, `src/pin.c`, `components/leek-wallet/`, `sim/test_pin.c`,
`AUDIT.md`, `docs/VAULT.md`. Assumed configuration is still **the default build**: no flash
encryption, no secure boot, `CONFIG_NVS_ENCRYPTION` off.

Two things separate this pass from the first. Every timing below was taken this session, on this
machine or on a board; and the flash residue that the first pass could only reason about has now
been dumped off real hardware and read.

**The owner's decision is taken as fixed: the PIN stays 4–8 digits.** Nothing here proposes
widening the alphabet. Everything here is about what can be improved without touching it.

---

## 0. Measurements this document rests on

**On hardware.** ESP32-S3, 160 MHz, board attached at `/dev/ttyACM0`, captured from the boot log
this session:

```
W (809) vault-kdf: KDF benchmark: 2250 iterations in 508 ms (target ~500)
I (300) wallet: Wallet initialized, password_set=1, wallets=4, active=1, vault=v3
```

So one `vault_derive_key()` costs **508 ms**, or 0.226 ms per iteration.

**On the audit machine** (13th Gen Core i7-1355U, one core, `gcc -O2`, this repo's own
`pbkdf2.c`/`sha2.c`, reproducing `derive_v2()` verbatim; best of four runs, the machine throttles
to roughly 2.5 ms after a minute of load):

```
iters= 2250    1627.1 us/guess     614.6 guesses/s/core
iters= 4500    2748.9 us/guess     363.8 guesses/s/core
iters= 9000    7357.8 us/guess     135.9 guesses/s/core
retired sha256x101    39.951 us/guess       25031 guesses/s/core
```

Linear in the iteration count, as expected: ≈0.72 µs per iteration per core. One desktop core is
**312× faster than the device** at the same work. The retired verifier is **41× cheaper** than the
vault's on a CPU where both are plain reference C — consistent with the first pass's 44×.

**PIN space.** 4–8 digits is 10⁴ + … + 10⁸ = **1.1111 × 10⁸** candidates.

| Attacker | Rate | Whole 4–8 digit space |
|---|---|---|
| Device itself, through the firmware | 2 guesses/s, and 3 of them | irrelevant — the wipe fires |
| One audit-machine core | 615/s | ~50 hours |
| This machine, 12 cores | ~7×10³/s | ~4.4 hours |
| One RTX-4090-class GPU (**estimate**) | ~1×10⁶/s | **~2 minutes** |

The GPU row is arithmetic, not a measurement, and it is stated so the arithmetic can be checked:
PBKDF2-HMAC-SHA512 with `dkLen = 64` is one output block, so 2 × 2250 = 4500 SHA-512 compressions
per candidate; published hashcat SHA-512 throughput on a 4090 is ≈4–5 × 10⁹ H/s; 4.5 × 10⁹ / 4500
≈ 1 × 10⁶ candidates/s. Treat "a few minutes" as the honest resolution. The task brief's ~45 s
figure and this ~2 min figure are the same claim within the error bars of a public benchmark.

---

## 1. Does the F1 fix hold?

Four questions were asked. Answers, with what was checked.

### 1.1 Nothing writes a fast verifier on any path — **holds**

Every `nvs_set*` call site in `src/` and `components/leek-wallet/` was enumerated:

```
src/ui.c            bright, wblocks, account, lock_to        (leek_ui)
src/device-wipe.c   pending                                  (leek_wipe)
src/transport.c     link                                     (leek_ui)
src/pin.c           attempts                                 (leek_pin)   <- the ONLY pin.c write
src/blind-signing.c blindsig                                 (leek_ui)
src/ble-name.c      ble_name                                 (leek_ui)
leek-wallet.c       vault_rec, kdf_salt, kdf_ver, m*/iv*, wallet_cnt,
                    active_idx, backup_ok, pwd_hash          (colibri)
```

`src/pin.c` writes exactly one key, and it is the attempt counter. `pwd_hash` and
`vault_rec.password_hash` are the same salted PBKDF2 verifier; nothing else in flash is a function
of the PIN. `retired_hash_pin()` has no caller that writes: it is reached only from `pin_verify()`'s
vault-less branch, compared in constant time, and its input and output are zeroed.

Provisioning (`pin_set`) and PIN change (`pin_change`) both go through `wallet_set_password` /
`wallet_change_password` and then call `erase_retired_hash()`. Neither writes a verifier of its own.

### 1.2 The three migration cases — **all correct**, and the proof was widened

- *Device with wallets.* `pin_init()` sees a vault password and erases the retired blob at boot
  with no PIN needed. Correct: the strong verifier already answers to the same secret.
- *PIN, no wallet.* `pin_verify()` honours the retired blob once, `migrate_retired_verifier()`
  writes the vault password from the PIN just proved, then erases. Correct.
- *Never provisioned.* `pin_is_set()` is false on both counts, PIN setup is offered, `pin_set()`
  establishes the vault password directly. Correct.

The power-cut sweep was re-run and **found a gap in its own coverage, not in the code**. The
with-vault migration makes 2 writes and was swept fully. The vault-less migration makes **6**, and
the sweep's bound was hard-coded at 3 — cuts 4, 5 and 6 were never exercised. The bound is now
measured the same way the with-vault one already was, and the test reports its own width:

```
== a power cut during the migration never leaves zero working PINs
   sweeping 2 writes (vault present)
   sweeping 6 writes (no vault)
PASSED (0 failures)
```

All seven previously-unswept cut points pass, and each now also asserts that a *wrong* PIN is
still refused after the cut — the old vault-less sweep only checked that the right one worked, so
a crash that erased the verifier entirely would have gone unnoticed. **The migration is correct;
the proof of it was not complete. It is now.**

### 1.3 The attempt counter and the 3-strike wipe — **survive**

`erase_retired_hash()` uses `nvs_erase_key`, not `nvs_erase_all`, precisely so `attempts` (same
namespace) survives; `pin_init()` distinguishes a stored `0` from an absent key; the attempt is
spent and committed before the comparison, so an interrupted guess is a spent guess.
`test_attempts_survive_the_migration` covers migration + three wrong PINs + wipe. All pass.

### 1.4 `test_no_fast_verifier_in_nvs` — **was weaker than its name**, now strengthened

The old check searched simulated flash for one specific 32-byte value: SHA-256×101 of the PIN. That
proves the *removed blob* is gone. It does not prove the *property* — a verifier at SHA-256×2, or
SHA-256(salt‖pin), would have passed it silently while being just as cheap.

Changed (test-only): `fast_verifier_in_flash()` now sweeps the family — chained SHA-256 at depths
1, 2, 3 and 101 (2 and 3 are the legacy v1 encryption key and verifier, so they are not
hypothetical), plus `SHA-256(salt‖pin)` and `SHA-256(pin‖salt)` using the device's own stored
`kdf_salt`. And the check is now shown to be capable of failing: the test plants a SHA-256²
verifier at a non-zero offset inside an unrelated blob under a key nothing looks for, asserts the
scan finds it, and removes it again. A detector that cannot fail proves nothing.

**Limit, and it is a real one.** The fake NVS `memset`s an entry on erase and overwrites in place
on update. Real NVS does neither. So this test can only ever assert the property of the *logical*
store — which is exactly the gap N2 is about, and no host test can close it.

---

## 2. New findings

### N1 — MEDIUM: an unlock pays for three KDF runs; the attacker pays for one

`pin_verify()` calls `wallet_verify_password()` → one PBKDF2. `ensure_wallet_unlocked()` then calls
`wallet_unlock()`, which calls `compute_password_hash()` (the same derivation, again) **and**
`derive_key_from_password()`. Three runs, 3 × 508 ms ≈ **1.52 s of KDF per PIN entry**
(`src/ui.c:1319`, `:1330`, `:1008`; `leek-wallet.c:1221`, `:1234`).

An offline attacker derives once per candidate and tests against the GCM tag. So the honest user
pays 3× the work factor the attacker pays. That is the whole answer to "is 2250 the right trade":

| | KDF per unlock | attacker cost/candidate |
|---|---|---|
| today | 3 × 508 ms = 1.52 s | 1 unit |
| today, 2× iterations | 3.05 s | 2 units |
| today, 4× iterations | 6.1 s | 4 units |
| **one derivation, 4× iterations** | **2.03 s** | **4 units** |

Collapsing the count buys a factor of 4 for **+0.5 s** on the unlock, where raising iterations
alone costs +4.6 s for the same factor. The construction is standard: derive the 32-byte encryption
key with PBKDF2 once, and store `SHA-256(key ‖ "leek-ver-v3")` as the verifier. The verifier stays
non-invertible, the domain separation the header cares about is preserved (a leaked verifier still
is not a key), and per-candidate attacker cost is unchanged at one PBKDF2 — because it already was.

In absolute terms 4× still only moves the GPU figure from ~2 minutes to ~8. That is worth having
and it is not a solution; see N4 for the thing that would be.

**Recommended, not changed.** It alters the stored verifier's construction, which means a v4 and a
re-encryption-free migration path. That is not a low-risk edit and it needs the owner's decision.

Secondary, and cheaper still: routing PBKDF2-HMAC-SHA512 through the S3's SHA accelerator (ROADMAP
T9e) would buy iterations at the same latency. Worth measuring before promising — SHA-512
acceleration on the S3 goes through `MBEDTLS_SHA512_ALT` and has a history of breakage
([esp-idf#12380](https://github.com/espressif/esp-idf/issues/12380)), and this vault deliberately
uses vendored trezor-crypto so the host suite can test it. A measurement, not a refactor, is the
next step.

### N2 — HIGH: a logical erase leaves everything in flash, and this is now observed, not inferred

`docs/AUDIT-SECRETS.md` F9 recorded this as LOW and marked it *"verified by reading the code path
only; not confirmed against a real flash dump."* It has now been confirmed. `esptool read_flash
0x9000 0x6000` on the attached board, parsed against the NVS page format:

```
--- page 0: state=0xfffffffc seq=0
  [  8] erased  pin_hash   data=6892b5e0ff40b76b 1e81eb7826e24fffffa5ffc7066c6033480336d1ceec2e47
  [ 13] erased  kdf_salt   data=e5cbbfe2d5a2d96f 5c921df4aab178d6ffffffff...
  [ 17] erased  pwd_hash   data=4d92b4c0e18f1711 0c78e3c551c51e593e23bf4fa18c0a204112ec13f276d68e
  [ 22] erased  m_1        data=29e09835eedf9721 295874ab541ffe428a1a80ddda812fe3...
  [ 27] erased  iv_1       ...
  [ 36] erased  m_2        ...
  [ 41] erased  iv_2       ...
  [ 48] erased  pin_hash   (identical bytes)
  [ 52] erased  pwd_hash   (identical bytes)
  [ 57] erased  pin_hash   (identical bytes)
--- page 2: seq=13
  [ 28] erased  pin_hash   (identical bytes)
  [ 99] erased  vault_rec  01000000 ...   <- superseded record, generation 0
  [107] written vault_rec  01010000 ...   <- live record, generation 1
```

Four physically intact copies of the same `pin_hash`, on a live device, all marked erased. The
superseded `vault_rec`, the old `pwd_hash`, the old `kdf_salt` and the pre-generation
`m_1`/`m_2`/`iv_1`/`iv_2` ciphertext are all still there.

Three things this settles.

1. **Page 0 has `seq=0`.** It is the original page, and it has never been garbage-collected in this
   device's entire life, despite pages 1, 2 and 3 having filled and rotated past it. The
   partition is `0x6000` — six 4 KB pages, one held in reserve for GC — and each page holds 126
   entries. A device with a handful of wallets writes a few entries per unlock and simply never
   comes back round. **"Until NVS garbage-collects that page" is, in practice, "never."**
2. **The F1 fix does not protect an upgraded field device against a flash dump.** It protects
   newly provisioned ones. On a device that has ever held the retired verifier, the migration
   removes it from the *live* store and leaves the bytes where a dump finds them. The cheap oracle
   is still there. This is the one place where "F1: FIXED" reads more strongly than the truth, and
   `docs/VAULT.md` now says so explicitly.
3. **A wipe is not an erase.** `wallet_wipe()` and `pin_wipe()` call `nvs_erase_all`, which is the
   same logical marking (ESP-IDF NVS: entry state `Erased (2'b00)` means *"a key-value pair in this
   entry has been discarded. Contents of this entry will not be parsed anymore"* — parsed, not
   removed; physical erasure happens only when a page is reclaimed,
   [NVS documentation](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/storage/nvs_flash.html)).
   Immediately after a wipe, every mnemonic ciphertext, the salt and the verifier are still in the
   dump.

**What a user must actually do to be clean.** In descending order of how much it is worth:

1. `esptool erase_region 0x9000 0x6000` (or `erase_flash`) from a host. This is a real sector
   erase and is the only step in this list that is unconditional.
2. Failing that, keep using the device — the residue leaves when the pages rotate, on no schedule.
3. Burn flash encryption + secure boot (T11), after which the residue is ciphertext and the
   question stops mattering.

Nothing the firmware currently does achieves (1) by itself.

**Recommended, not changed.** The firmware fix is real and small: after `wallet_wipe()` +
`pin_wipe()`, `device_wipe()` should `nvs_flash_deinit()` → `nvs_flash_erase()` → `nvs_flash_init()`,
which erases the partition's sectors physically. It is deliberately not done here: `nvs_flash_erase`
on the wipe path is a change to the one code path whose failure mode is a device that will not
come back, it interacts with the resume marker (which lives in the same partition and would be
erased by it, so the marker ordering has to be rethought, not just extended), and the fake NVS
cannot model sector erase — so it needs a hardware test, not a host one. It should be the next
piece of work on this file.

### N3 — LOW: a wipe leaves `leek_ui`, including the blind-signing setting

`device_wipe()` erases `colibri`, `leek_pin` and `leek_wipe`. It never touches `leek_ui`, which
holds the user-chosen BLE advertising name (`src/ble-name.c:19`), the **blind-signing flag**
(`src/blind-signing.c:15`), the transport preference, brightness, orientation, auto-lock timeout
and the BIP-44 account index.

Two consequences. The BLE name is a user-chosen string broadcast to anyone scanning, and it
survives the wipe that was supposed to make the device impersonal. And blind signing — off by
default, five presses behind a warning screen — stays **on** across a wipe, so a device wiped and
handed to someone else silently starts life with its most permissive setting enabled. A factory
reset that does not restore a security default to its default is not a factory reset.

Reported rather than fixed: `leek_ui` is UI-owned state and clearing it is a product decision
about what "Wipe Device" means, not a defect with one obvious edit. The blind-signing flag at
minimum should be reset.

### N4 — the eFuse / HMAC question: **yes, definitively**, with one large caveat

*Can a per-device secret be bound into the vault key that an attacker with only a flash dump would
not have, without secure boot?*

**Yes.** The ESP32-S3 has six eFuse key blocks (`BLOCK_KEY0`–`BLOCK_KEY5`, physical BLOCK4–9) and
an HMAC peripheral. Burning one block with purpose `HMAC_UP` ("HMAC generated for software use",
purpose 8) and read-protecting it gives firmware a key it can *use* through
`esp_hmac_calculate(HMAC_KEY0, msg, len, out)` — HMAC-SHA256 — and cannot *read*. Espressif's own
guidance: *"Configure the eFuse key block to be read-protected using `esp_efuse_set_read_protect()`,
so that software cannot read back the value"*
([HMAC peripheral](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/peripherals/hmac.html)).
The documentation states **no dependency on secure boot or flash encryption** for HMAC operation,
and the eFuse guide confirms the block count and that the burn is one-way: *"Each eFuse is a
one-bit field which can be programmed to 1 after which it cannot be reverted back to 0"*, and with
the Reed-Solomon scheme on key blocks *"each block can only be written to one time"*
([eFuse manager](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/system/efuse.html)).

Confirmed available on this board, from `espefuse.py summary` run this session:

```
KEY_PURPOSE_0..5 (BLOCK0)   = USER R/W (0x0)
BLOCK_KEY0 (BLOCK4) .. BLOCK_KEY5 (BLOCK9)   all unburned
RD_DIS (BLOCK0)             = 0
SECURE_BOOT_EN (BLOCK0)     = False
SPI_BOOT_CRYPT_CNT (BLOCK0) = Disable
```

All six blocks free, on a device with no secure boot and no flash encryption. The capability is
there today.

**What it would buy, and what it would not.**

The right construction puts the chip secret *inside* the per-guess loop, not after it:

```
chip   = esp_hmac_calculate(HMAC_KEY0, kdf_salt || "leek-bind-v1")   // 32 B, never in flash
key    = PBKDF2-HMAC-SHA512(pin, chip || kdf_salt || "leek-enc-v3", N)
```

Then a flash dump alone is **worthless** — the attacker is missing 256 bits of key material and no
amount of GPU changes that. That is a categorical improvement over anything the iteration count
can do, and it is the only one available on an unburned device.

The caveat is exactly the one `docs/VAULT.md` already makes about flash encryption, and it applies
here identically: **without secure boot, an attacker with the physical device can flash their own
firmware and call `esp_hmac_calculate()` as an oracle.** They cannot extract the key; they can use
it. So the honest claim changes from "your seed survives a dump" to:

| Attacker | Today | With an HMAC-bound key, no secure boot |
|---|---|---|
| Dumps the flash of a device they do not keep (discarded, stolen-and-sold, remote read) | seed in minutes | **nothing — no offline attack exists** |
| Keeps the device and reflashes it | seed in minutes | must run every guess *on the S3*, at 508 ms each |
| Keeps the device, reflashes, and precomputes | — | still 508 ms/guess **if the HMAC is inside the loop**; ~µs/guess if it is bolted on afterwards |

The third row is the design-critical one. If the chip secret is mixed in *after* PBKDF2 — key =
HMAC(chip, PBKDF2(pin)) — the reflashing attacker precomputes all 1.1 × 10⁸ PBKDF2 outputs on a GPU
and then asks the device for 1.1 × 10⁸ fast HMACs, which is hours, not years. Mixed in *before*, as
above, each guess costs a full on-device derivation: 1.1 × 10⁸ × 0.508 s ≈ **1.8 years on the one
board they hold**, unparallelisable, and the 3-strike counter is back in play because the firmware
is the only thing that can derive.

Costs to weigh honestly, none of them small:

- **The burn is irreversible and it is per-device.** A wrong key, a wrong purpose, a brownout
  mid-burn, and the board is scrap or the wallet is unrecoverable. It belongs in the same
  provisioning procedure as T11's burn, with the same rehearsal.
- **The seed becomes chip-bound.** A device that dies takes its vault with it, absolutely. That is
  correct behaviour for a hardware wallet with a written backup, and it is a support disaster for
  anyone who skipped the backup. It must be stated on the box, not in a doc.
- **Fault injection.** The fourth row of `docs/VAULT.md`'s threat table does not move. The ESP32
  family has a documented history of glitching attacks against eFuse protections, and read
  protection under a glitch is precisely what QEMU cannot tell you about.
- **It does not replace T11.** Secure boot is what turns the second table row above into the
  first. This is a strictly weaker layer that happens to be available *now*, on unburned hardware,
  and it defeats the attack the first pass identified as the realistic one.

**Verdict: yes, and it is the single highest-value change available that does not touch the PIN
alphabet.** Bigger than any iteration count, smaller than secure boot, and orthogonal to both.

### N5 — INFO: the ciphertext is a clean target, but for a different reason than the header claims

`vault-kdf.h` says the domain separators mean *"cracking the verifier no longer yields the
encryption key."* True, and it does not help against a dump. The stored mnemonic is AES-256-GCM,
and **its tag verifies the encryption key at exactly the cost of deriving it**. An attacker with
the flash never touches `vault_rec`; they attack `m1_N` directly, at one PBKDF2 per candidate — the
same price the verifier would have charged. Deleting the stored verifier entirely would not slow
them down by one candidate.

So the answer to "is the ciphertext an oracle-free target" is: **nothing in flash rejects a PIN
candidate more cheaply than one full PBKDF2** — checked against the real dump above, key by key —
but the ciphertext itself is a perfect verifier, and it always will be. Only the KDF cost and the
PIN's entropy price a guess. The header comment has been corrected to say this.

What else is in flash and what it leaks:

| Key | Leaks | Narrows the PIN search? |
|---|---|---|
| `kdf_salt` | nothing; per-device, required | no — but it does defeat fleet-wide precomputation, which is its job |
| `kdf_ver` | storage format | no |
| `vault_rec` | generation (0/1), verifier, 33 zero bytes of retired fields | no |
| `wallet_cnt`, `active_idx` | how many seeds, which is selected | no |
| `backup_ok` | which wallets have had a backup verified | no |
| `m<gen>_N` | **exact plaintext length** — GCM is a stream cipher, so the blob is `12 + len + 16` | no |

The last row is the only one worth a note. The ciphertext length reveals the exact byte length of
the mnemonic string, which gives away the word count and the sum of the word lengths. Against a
128-bit seed that is a few bits, and it costs nothing to remove: pad the plaintext to a fixed 256
bytes before `vault_encrypt()`. INFO, not a finding, and it is a v4 change so it belongs with N1's
if that is ever done.

### N6 — the passphrase: **still never stored, and nothing confirms a guess**

Re-verified, and this time against real storage rather than a grep. The complete set of live keys
in the hardware dump is `goggles`/`orient`/`bright`/`lock_to`/`blindsig`/`link` (UI), `attempts`
(PIN), `kdf_salt`/`kdf_ver`/`vault_rec`/`m1_1`/`m1_2`/`m1_3`/`wallet_cnt`/`active_idx` (vault),
`pending` (wipe), plus the ESP-IDF Wi-Fi and PHY calibration namespaces. There is no passphrase, no
passphrase verifier, no cached address, no fingerprint, no per-wallet "has passphrase" flag.

`state.passphrase` is `.bss` only and is zeroed by `wallet_lock`, `wallet_select_wallet`,
`wallet_clear_passphrase` and `wallet_wipe`. `mnemonic_to_seed()` consumes it and nothing derived
from the result is persisted. The `docs/VAULT.md` claim — an attacker with the flash, the eFuse key
and the PIN still cannot tell whether a passphrase wallet exists — **is true as written**, and it is
the only claim in this document that a flash dump does not weaken.

It is also, given N1–N4, the layer that actually holds today. That is worth saying plainly to
users rather than only in a design doc.

---

## 3. What was changed

Four edits. One test strengthening, one test-coverage gap closed, two documentation corrections.
No cryptographic construction, no storage format, no migration logic, no session or transport code.

| File | Change |
|---|---|
| `sim/test_pin.c` | `fast_verifier_in_flash()` sweeps a family of cheap verifiers (SHA-256 at depths 1/2/3/101, and salted one-shot forms) instead of one constant, and the check is proved capable of failing by planting one (§1.4) |
| `sim/test_pin.c` | the vault-less migration's power-cut sweep measures its own width instead of assuming 3 writes — it is 6, so cuts 4–6 were never run — and now also asserts a wrong PIN is refused after each cut (§1.2) |
| `components/leek-wallet/include/vault-kdf.h` | the iteration comment described 4500 iterations at ~1.0 s; the code is 2250 at a measured 508 ms. Corrected, with the honest note about what the domain separation does and does not buy (N5) |
| `AUDIT.md`, `docs/VAULT.md`, `src/ui.c` | S1's "instant to days" survived the first pass's own correction and is now right; S7's wipe is marked as logical with the hardware evidence; VAULT.md's residue section is upgraded from inference to observation and its measured µs figures re-taken; the unlock-latency comment says three derivations, not "around a second" |

`./scripts/check.sh` passes.

## 4. Recommended, not changed

In the order they are worth doing.

1. **N4 — bind the vault key to an eFuse HMAC key.** The only change here that makes a flash dump
   useless without secure boot. Needs a provisioning procedure alongside `docs/BURN-PROCEDURE.md`,
   and the derivation must put the chip secret *inside* the PBKDF2 input, not after it.
2. **N2 — make the wipe physical.** `nvs_flash_erase()` after the logical wipe, with the resume
   marker moved somewhere it survives. Needs a hardware test; the host suite cannot see it.
3. **N1 — collapse three KDF runs to one, then raise the iteration count.** 4× the work factor for
   +0.5 s on the unlock. Storage-format change, so it wants an owner's decision and a v4.
4. **N3 — reset the blind-signing flag on wipe**, at minimum; decide what else in `leek_ui` a
   factory reset should clear.
5. **N5 — pad the mnemonic plaintext** to a fixed length before encryption, if a v4 happens anyway.
6. Say in the UI, not only in `docs/VAULT.md`, that until T11 is burned the passphrase is the layer
   that survives losing the device.

Sources for N2 and N4:
[HMAC peripheral](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/peripherals/hmac.html) ·
[eFuse manager](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/system/efuse.html) ·
[NVS storage](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-reference/storage/nvs_flash.html) ·
[esp-idf#12380, SHA-512 acceleration on the S3](https://github.com/espressif/esp-idf/issues/12380)
