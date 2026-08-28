# Secret-handling audit

Scope: every secret the firmware holds, with the BIP-39 passphrase at the centre — where it
lives, what erases it, and what an attacker with the flash gets today. Companion-app passphrase
handling (`app/src/main.ts`) is included because it is one of the two entry paths.

State audited: branch `audit/secrets`, `src/`, `components/leek-wallet/`, `app/`. Every claim
below names a file and line, a command that was run, or is marked **unverified**.

Assumed configuration: **the default build** — `sdkconfig.defaults`, no flash encryption, no
secure boot. That is the configuration every current user is in. `sdkconfig.secure` exists and
`docs/BURN-PROCEDURE.md` is written, but by `docs/VAULT.md`'s own admission the burn has never
been executed on hardware.

---

## 1. Lifetime table

"Survives reboot?" means the value is still recoverable after a power cycle, from RAM or flash.

| Secret | Born | Held where | Erased by | Survives reboot? |
|---|---|---|---|---|
| **BIP-39 passphrase** | `text_entry_accept` on device (`src/text-entry.c:164`), or `setPassphrase` from the host (`src/protocol.c:1025`) | `state.passphrase[128]`, `.bss` (`components/leek-wallet/leek-wallet.c:75`) | `wallet_lock` (`:1249`), `wallet_select_wallet` (`:2058`), `wallet_clear_passphrase` (`:1509`), `wallet_wipe` (`:2009`), session reset via `host_passphrase_forget` (`src/protocol.c:359`) | **No** — RAM only, never written to NVS (grep for `nvs_set` finds no passphrase write) |
| ↳ its UI transcript | as typed | `passphrase_entry.text[65]`, `.bss` (`src/ui.c:3341`) | every button path, and now the screen `.exit` hook (fixed, §4) | No |
| ↳ its wire copy | decrypted in place | `rx_buf[512]` / `BleReassembler.buf[512]`, `.bss` (`src/protocol.c:77`, `src/ble-chunk.h:44`) | **nothing** — buffers are never zeroed; the passphrase bytes specifically are now zeroed (fixed, §4) | No, but persists in RAM across lock |
| ↳ its host copy | keystrokes in the app | V8 strings + the plaintext CBOR `Uint8Array` (`app/src/main.ts:1034`, `:1046`, `:283`) | nothing; `input.value=""` at `app/src/main.ts:1086` drops the reference only | No, but heap-resident until GC |
| **Mnemonic** | generation (`:1567`) / import (`:1608`) / decryption on unlock (`:1229`) | `state.mnemonic[256]`, `.bss` (`:74`); `mnemonic_buffer` in `src/ui.c` while displayed | `wallet_lock`, `wallet_select_wallet`, `wallet_wipe`; UI copy by `forget_mnemonic_*` (`src/ui.c:589-611`) | Ciphertext yes (NVS `m<gen>_N`); plaintext no |
| **BIP-39 seed (64 B)** | `cache_seed_from_mnemonic` (`:101`) | `state.seed[64]`, `.bss` (`:76`) | `invalidate_seed_cache` (`:113`) on lock, wallet switch, passphrase change | No |
| **BIP32 master/derived node** | `hdnode_from_seed` (`:1746`) | `state.node`, `.bss` (`:77`) | `wallet_lock` (`:1252`), wallet switch (`:2063`) | No |
| **Per-signature private key** | derived inside `state.node` | same `state.node`; RFC6979 nonce inside trezor-crypto's stack frames | node cleared on lock; nonce by `ecdsa_sign_digest`'s own `memzero` | No |
| **Vault encryption key** | `vault_derive_key` (`components/leek-wallet/vault-kdf.c:74`) | `state.encryption_key[32]`, `.bss` (`:73`) | `wallet_lock` (`:1251`), wipe | No — derived from the PIN each unlock |
| **PIN (plaintext)** | keypad (`src/ui.c:332`) | `current_pin[9]`, `.bss` (`src/pin.c:29`); UI transcript `pin_entry` | `pin_lock` (`src/pin.c:441`), `pin_wipe` (`:281`); UI copy by `forget_pin_entry`; the `ensure_wallet_unlocked` stack copy now zeroed (fixed, §4) | No |
| **PIN verifier — vault** | `vault_derive_verifier`, PBKDF2-HMAC-SHA512, 2250 iterations, 16-byte per-device salt | NVS `colibri/vault_rec.password_hash`, or legacy `colibri/pwd_hash`; RAM `vault_stored_hash` | wipe only (RAM copy is not secret-bearing beyond the PIN) | **Yes — in flash** |
| ~~**PIN verifier — pin.c**~~ | **Removed (F1, fixed).** `pin_verify()` calls `wallet_verify_password()`; `src/pin.c` stores no verifier. The retired blob is erased at the first boot with a vault password, or at the first successful unlock without one | — | — | No — but see "logical erase" in `docs/VAULT.md` for what is still physically on an upgraded device's flash |
| **Session keys / passkey** | X25519 + HKDF (`src/session.c:82`) | `sess` struct, `.bss` | `session_reset` (`:171`) on disconnect, transport switch, auth failure | No |
| **Master fingerprint (XFP)** | `wallet_get_master_fingerprint` | `master_xfp[9]` in `src/ui.c:795` | `lock_device` (`src/ui.c:843`) | No — never persisted |

### Passphrase state at every transition

| Transition | Passphrase | Where enforced |
|---|---|---|
| Device entry, confirmed | applied, session-lifetime | `src/ui.c:3427` |
| Device entry, address rejected | cleared | `src/ui.c:3644` |
| Host `setPassphrase`, approved | applied; session-scoped via `session_set_on_reset` | `src/protocol.c:1122-1123` |
| Host `setPassphrase`, rejected or timed out | cleared | `src/protocol.c:1111` |
| Host `setPassphrase`, derivation fails | cleared | `src/protocol.c:1097` |
| Manual lock / auto-lock (5 min default) | cleared | `src/ui.c:840` → `wallet_lock` |
| BLE disconnect / USB transport switch / bad AEAD tag | cleared **if host-supplied**; **kept if typed on the device** | `src/protocol.c:359-366`, deliberate (T42) |
| Wallet switch (`selectWallet` or menu) | cleared | `leek-wallet.c:2058`, `src/protocol.c:1017` |
| PIN change | cleared — `pin_change` → `wallet_change_password`; the vault is not locked, but the UI returns through a screen change. **Partially verified**: `pin_change` itself does not call `wallet_lock`, so a passphrase applied before a PIN change survives it. Not a leak, but it is undocumented. |
| Reboot / power cut | gone (RAM only, ESP32-S3 SRAM is not battery-backed) |
| Wipe | cleared (`wallet_wipe` → `wallet_lock`) |

**Nothing derived from the passphrase reaches flash.** Verified by enumerating every `nvs_set*`
call site in `src/` and `components/leek-wallet/`: the writes are the encrypted mnemonic, the IV,
the vault record, wallet count, active index, backup bitmask, KDF salt/version, PIN hash, attempt
counter, wipe marker, BLE name, and four UI preferences. No address, no fingerprint, no
passphrase check-value. The deniability claim in `docs/VAULT.md` ("Do not record which seeds have
a passphrase") holds against the flash. See F4 for where it did not hold against the console.

---

## 2. What a flash dump yields today

The attacker has the device (or a discarded one), runs `esptool read_flash`, and gets the NVS
partition verbatim — `CONFIG_NVS_ENCRYPTION` is off and flash encryption is not burned.

They obtain:

| Blob | Protection |
|---|---|
| `colibri/m<gen>_N` | AES-256-GCM (v3), key = PBKDF2-HMAC-SHA512(PIN, salt‖"leek-enc-v2", **2250**) |
| `colibri/kdf_salt` | plaintext, 16 bytes |
| `colibri/vault_rec` | PBKDF2 verifier over "leek-ver-v2" — genuinely independent of the encryption key |
| ~~`leek_pin/pin_hash`~~ | **Gone (F1, fixed).** No longer written; erased on upgrade |

The last row decides the answer. Both verifiers are derived from the same PIN, so the attacker
attacks the cheaper one. PIN space is 4–8 digits (`src/pin.h:16-17`) = 1.111 × 10⁸ candidates.

**Measured, not estimated** (`gcc -O2`, this repo's own `sha2.c`, one core of the audit machine;
a throwaway program that reproduces `hash_pin` verbatim and searches for `hash_pin("739104")`,
linking this repo's `components/trezor-crypto/sha2.c`):

```
found=739104 after 739105 candidates in 81.541 s (9064 PIN/s, 9.15e+05 SHA256/s, 1 core)
```

Extrapolating from that measurement:

| Attacker | Full 6-digit space (10⁶) | Full 4–8-digit space (1.11 × 10⁸) |
|---|---|---|
| This machine, 1 core, reference C | 110 s | ~3.4 hours |
| 8 cores with SHA-NI (≈20× per core) | < 1 s | ~1 minute |
| One consumer GPU (hashcat SHA-256 ≈ 2 × 10¹⁰ H/s ÷ 101) | ~5 ms | ~0.6 s |

So: **a flash dump yields the PIN in under a second on a GPU, and the PIN yields every stored
seed after one 2250-iteration PBKDF2.** The 3-attempt wipe counter is irrelevant — the attack
never goes through the firmware.

Even if `leek_pin/pin_hash` did not exist, the PBKDF2 verifier alone would not hold: at 2250
iterations of PBKDF2-HMAC-SHA512, a single RTX-4090-class GPU runs on the order of 6 × 10⁵
candidates/s (extrapolated from published hashcat figures at 1000 iterations — **estimate, not
measured here**), which is **~2 seconds for the 6-digit space** and a few minutes for the whole
4–8-digit space. A numeric PIN of this length is simply not a KDF-defensible secret.

**A passphrase wallet remains safe.** The flash contains nothing that confirms a passphrase
guess — no stored passphrase, no verifier, no cached address or fingerprint. An attacker who
dumps the flash, recovers the PIN and decrypts every mnemonic still cannot tell whether a
passphrase wallet exists, let alone which one. That specific claim in `docs/VAULT.md` ("Where the
passphrase sits") is **true as written and confirmed by the code**.

---

## 3. Findings by severity

### F1 — CRITICAL, **FIXED**: `leek_pin/pin_hash` was an unsalted SHA-256×101 oracle for the PIN

`src/pin.c:38-53` stores a second PIN verifier alongside the vault's, derived with 101 chained
SHA-256 calls and no salt. It is written by `pin_set` (`src/pin.c:161`) into NVS and read back by
`pin_verify`. Every property `components/leek-wallet/vault-kdf.c` was written to obtain — a real
KDF, a per-device salt, domain separation so the verifier is not an oracle — is bypassed by this
blob sitting in the same flash dump. Cost to break: the table in §2. It is the cheapest path to
every stored seed, by roughly six orders of magnitude.

This also makes the salt pointless against a fleet: `pin_hash` is unsalted, so one rainbow table
covers every LeekWallet ever built.

**Fixed.** `hash_pin()` is deleted and `src/pin.c` keeps no verifier: `pin_verify()` asks
`wallet_verify_password()`, so the salted PBKDF2 hash in the vault record is the only value in
flash that recognises a PIN. `pin_set()` establishes that hash rather than a second one, and
refuses to repoint a vault that already has a password (which would orphan every stored mnemonic —
that is `pin_change()`'s job, and it re-encrypts first). The `companion_hash` field inside
`VaultRecord` is retired: it is no longer written, the struct keeps its size so field records stay
readable, and `wallet_init()` rewrites any record still carrying one.

Migration, on devices that already hold wallets: no PIN is needed. The vault's verifier already
answers to the same secret, so the retired blob is redundant the moment this firmware boots and
`pin_init()` erases it. Devices with a PIN but no vault password — a PIN was set and no wallet ever
created — have no strong verifier to check against, so theirs is honoured exactly once; the
success path writes the vault password from the PIN just proved correct and then erases it. Every
intermediate state of both paths is one where exactly the same single PIN opens the device, so a
power cut can never leave zero working PINs. `sim/test_pin.c` sweeps a crash across every write of
both migrations and asserts the owner's PIN still works after each.

The property is tested against storage, not against the diff: `fake_nvs_contains_bytes()` scans
every simulated NVS entry at every offset for the unsalted chained hash of every PIN the device
has held, and `test_no_fast_verifier_in_nvs()` demands it appear nowhere after a set, an unlock, a
change and a reboot.

Caveat, and it is F9's: `nvs_erase_key` is a logical erase. See `docs/VAULT.md`, "What is left in
the flash after the migration".

### F2 — CRITICAL (documentation), **FIXED**: `AUDIT.md` and `docs/VAULT.md` claimed protection the code did not provide

Two independent overstatements, both of which would leave a reader believing a flash dump is
survivable:

1. `AUDIT.md:16-19` — *"the stored verifier is no longer an oracle for the encryption key … The
   KDF turns that from instant into days."* False. `leek_pin/pin_hash` is exactly such an oracle
   (F1), and the answer is seconds, not days. `AUDIT.md:34-42`'s original S1 chain names
   `pwd_hash` as the free oracle and treats it as removed; the oracle simply moved namespace.
2. `docs/VAULT.md` §"A real KDF" — *"turns 10⁶ candidates into roughly six days of continuous
   attack per device."* This computes the attacker's cost at the **device's** derivation speed
   (10⁶ × 0.5 s ≈ 5.8 days). An attacker does not use the device. At GPU speeds the same space is
   seconds (F1) or ~2 s even against the PBKDF2 verifier alone. The number is wrong by five to
   six orders of magnitude, and it is the number a reader uses to decide whether to trust the
   device with funds.

`docs/VAULT.md`'s threat table is otherwise honest, and its passphrase section is accurate.

**Fixed.** Both passages are rewritten. `AUDIT.md`'s S1 summary now says the KDF buys a factor of
a few hundred and that the whole 4–8 digit space falls in minutes to a GPU; `docs/VAULT.md`'s KDF
section carries a table with both verifiers' measured CPU cost and extrapolated GPU cost, states
plainly which figures are measured and which are estimates, and says that flash encryption — not
the KDF — is the layer that survives a dump.

### F3 — MEDIUM: decrypted request plaintext is never wiped from the transport buffers

`rx_buf` (`src/protocol.c:77`) and `BleReassembler.buf` (`src/ble-chunk.h:44`) are 512-byte
`.bss` arrays. `session_decrypt` decrypts **in place** (`src/protocol.c:1247`), so after a
`setPassphrase` the passphrase sits in one of them in cleartext. `ble_chunk_reset`
(`src/ble-chunk.c:14-19`) sets `len = 0` and does not zero the buffer; `consume`
(`src/protocol.c:1298`) only `memmove`s over the front. The residue survives lock, survives
`wallet_wipe`, and lives until a longer frame happens to overwrite it. Any JTAG pause, crash
dump, or memory-disclosure bug reads it back.

Partially fixed: the passphrase bytes specifically are now zeroed (§4). The general case —
zeroing the decrypted payload after dispatch — is transport code owned by another agent, and is
recommended rather than changed.

### F4 — MEDIUM: the serial log announced whether a passphrase was applied

`components/leek-wallet/leek-wallet.c:96` logged `"Caching seed (PBKDF2) with passphrase..."`.
The passphrase value never reached the log, but its *existence* did — and existence is the secret
a passphrase protects. `docs/VAULT.md` is emphatic on this ("If the device knows wallet 3
requires a passphrase, then anyone who compels you to unlock learns that a hidden wallet
exists"). The console is readable over USB by anyone holding an unlocked device. Fixed (§4).

`src/protocol.c:365` still logs *"Session ended; dropping the host-supplied passphrase"*. Left
alone: it fires only on a path where the host already knew, and it is genuinely useful in a
disconnect postmortem. Flagged for a human decision.

### F5 — MEDIUM: a half-typed passphrase outlived the screen

`passphrase_entry` (`src/ui.c:3341`) was cleared on every button path off the passphrase screen,
but `screen_passphrase.exit` was `NULL` (`src/ui.c:288`). An auto-lock firing mid-entry, or a host
request moving the screen, left the typed prefix in `.bss` across the lock and across a wipe.
This is the same class as `AUDIT.md` S5, in the one buffer S5's fix did not cover. Fixed (§4).

### F6 — MEDIUM: the companion leaves the passphrase on the JS heap, and one path can send it in cleartext

From the companion audit (evidence at the cited lines):

- No deliberate sink retains it: not `localStorage`/IndexedDB, not `diagnosticsReport`
  (`app/src/main.ts:3467` emits `passphrase on/off` only), not `log()` (`:1058`, `:1084`), not
  `announce()` (`:1038-1041`), no `console.log` anywhere in `app/src/`. The input is
  `type="password" autocomplete="off" spellcheck="false"` with no `name` and no form wrapper
  (`app/index.html:127-129`), and is cleared in a `finally` (`app/src/main.ts:1086`).
- It is nonetheless heap-resident: two immutable V8 strings (`:1034`, `:1046`) that clearing the
  field cannot overwrite, a closure over `params` retained by the promise queue for up to the
  150 s call timeout (`:250-256`, `:1046`), and — the one artifact that *could* be zeroed and is
  not — the plaintext CBOR buffer produced at `:283`. A heap dump grepped for the ASCII
  `setPassphrase` key lands next to the passphrase itself.
- `app/src/main.ts:1004-1006` claims *"Nothing here keeps the passphrase"*. True of every
  deliberate sink; not true of the heap. Narrow the sentence.
- **`callNow` falls back to a plaintext frame whenever `session?.isActive` is false
  (`app/src/main.ts:283-285`), with no per-method guard.** If the session dies between the last
  poll and the click, the passphrase is CBOR-encoded in the clear, JSON-serialised across the
  Tauri IPC (`app/src/tauri-transport.ts:143`), and written to the serial port or BLE
  characteristic before the device rejects it. The device refuses the request; the disclosure has
  already happened on the wire. Not fixed — `app/src/main.ts:250-290` is transport code.

### F7 — LOW: the vault verifier was compared with `memcmp`

`components/leek-wallet/vault-kdf.h` states *"Compare it with `vault_hash_equals()`, never with
`memcmp()`"*; `leek-wallet.c:1205` and `:1279` used `memcmp`. Low impact — the comparison is
against a hash the attacker cannot choose incrementally without also running the KDF — but the
header made a rule and the code broke it. Fixed (§4).

### F8 — LOW: PIN and verifier residue in RAM

- `ensure_wallet_unlocked` (`src/ui.c:970`) copied the plaintext PIN into a stack frame and never
  zeroed it. Fixed (§4).
- `wallet_lock` zeroed the mnemonic, passphrase, key and node but left `state.password_hash`
  (a KDF output over the PIN) in `.bss`. Fixed (§4).
- `pin.c`'s `current_pin` holds the plaintext PIN for the whole unlocked session by design — the
  vault key is re-derived from it on demand. Correct given the architecture, worth stating.

### F9 — LOW: `nvs_erase_all` is a logical erase, not a physical one

`wallet_wipe` (`leek-wallet.c:1999`) and `pin_wipe` (`src/pin.c:274`) call `nvs_erase_all`, which
marks entries erased in the page state bitmap. The bytes stay in flash until NVS garbage-collects
that page. So immediately after a wipe, a flash dump still contains the old ciphertext, the old
salt and the old `pin_hash` — and with F1 that is still a full compromise of the wallet the user
believed they had destroyed. `docs/VAULT.md`'s wipe discussion and `AUDIT.md` S7 both treat the
wipe as final. **Verified by reading the code path only; not confirmed against a real flash
dump** — that check needs a board and `esptool read_flash` before and after a wipe.

The stale-generation erase (`erase_stale_slots`, `leek-wallet.c:275`) has the same property, and
its comment correctly calls old ciphertext under a retired key a real risk.

### F10 — INFO: failure and abuse paths that hold up

Checked and found sound; recorded so the next audit does not redo them.

- **Power cut mid-PIN-change**: generation-scoped slots plus a single-blob record flip
  (`leek-wallet.c:220-262`) make it atomic, and `pin_reconcile_with_vault` (`src/pin.c:300`)
  catches the window between the flip and `pin_set`. Covered by `sim/test_pin_change.c`.
- **Power cut mid-wipe**: `leek_wipe/pending` marker written first, cleared last, resumed at boot
  (`src/device-wipe.c`). Covered by `sim/test_device_wipe.c` (seven crash points).
- **Repeated wrong PIN**: the attempt is spent and committed to flash *before* the comparison
  (`src/pin.c:206-212`), so cutting power mid-guess costs the attacker the guess. A stored 0 is
  distinguished from an absent key (`src/pin.c:95-108`). Correct, and unusually so.
- **A request erroring halfway**: every `setPassphrase` failure path clears the passphrase before
  returning (`src/protocol.c:1078`, `:1097`, `:1111`).
- **Tampered ciphertext**: v3 is AES-256-GCM (`components/leek-wallet/vault-crypt.c`); a failed
  tag wipes the output buffer rather than returning partial plaintext (`:96`).
- **`memzero` is not elidable.** `components/trezor-crypto/memzero.c:56` resolves to
  `explicit_bzero` under `__NEWLIB__`, which is what the ESP-IDF build uses; `explicit_bzero` is
  present in the linked image (`xtensa-esp32s3-elf-nm firmware.elf` → `4209b5cc T explicit_bzero`).
  `memzero` itself is a separate translation unit with no LTO (`grep -i flto` finds nothing in
  `platformio.ini`, `sdkconfig.defaults` or the generated `sdkconfig.h`), so it links as an
  out-of-line call the compiler cannot see through — confirmed as a real symbol at `42021b8c T
  memzero`. Belt and braces, `objdump -dr` on `vault-kdf.c` at `-O2` shows all four `memzero`
  call sites surviving as `R_X86_64_PLT32 memzero` relocations. Firmware is built at `-Og`
  (`CONFIG_COMPILER_OPTIMIZATION_DEBUG=1` in `.pio/build/esp32s3/config/sdkconfig.h:468`), which
  is strictly less aggressive. The xtensa `objdump` in this toolchain prints no mnemonics, so the
  per-call-site check was done on the x86 build; the symbol and no-LTO evidence covers the
  firmware.

---

## 4. What was changed

Six changes, all zeroization or a documented rule the code broke. No cryptographic construction,
no storage format, no session or transport logic.

| File | Change |
|---|---|
| `src/ui.c` | `ensure_wallet_unlocked` zeroes its stack copy of the PIN on every path (F8) |
| `src/ui.c` | `screen_passphrase.exit = forget_passphrase_entry`, so a lock or a host-driven screen change wipes a half-typed passphrase (F5) |
| `src/protocol.c` | `setPassphrase` zeroes the passphrase bytes inside the decrypted receive buffer (F3, partial) |
| `components/leek-wallet/leek-wallet.c` | the seed-caching log no longer says whether a passphrase is applied (F4) |
| `components/leek-wallet/leek-wallet.c` | `wallet_lock` zeroes `state.password_hash` (F8) |
| `components/leek-wallet/leek-wallet.c` | verifier comparison uses `vault_hash_equals`, as `vault-kdf.h` requires (F7) |

`./scripts/check.sh` passes: 17 host suites, `pio run -e esp32s3` succeeds, app tests and
typecheck pass.

## 5. Recommended, not changed — needs a human decision

1. ~~**F1/F2, the one that matters.**~~ **Done.** `hash_pin` is deleted, `pin.c` verifies through
   the vault's PBKDF2 verifier, and existing devices migrate on the first boot or first unlock.
   PIN entry costs one extra derivation (~0.5 s on the S3).
2. ~~**Then correct the numbers.**~~ **Done** — see F2 above.
3. ~~**Allow a non-numeric or longer PIN**~~ — **declined by the owner, and the second half of
   this recommendation is therefore the standing position: the KDF is defence in depth only, and
   this document says so.**

   The reasoning against is practical and holds up. Entry is four buttons. An alphanumeric PIN
   means many more presses per character and many more mis-entries, and a user who shortens their
   secret to escape that is worse off than one using eight digits. The alphabet is not free.

   What it costs, stated plainly so nobody has to rediscover it: against a flash dump, the PIN's
   own entropy is now the binding constraint, because the fast verifier that used to dominate is
   gone. Measured at 1441 us per guess on one CPU core, and roughly 45 seconds for the whole
   8-digit space on one consumer GPU. Eight digits is meaningfully better than four -- ten
   thousand times the work -- and it is still about a minute.

   So the layer that actually defends a stolen device is **flash encryption, with NVS encryption
   enabled**, not the PIN and not the iteration count. That is what makes the vault unreadable to
   a dump in the first place, and it is why the NVS question ahead of any eFuse burn is the one
   that matters. Raising iterations trades the user's unlock time for one order of magnitude;
   encrypting the partition removes the attack.

   Nothing in `pin_is_valid_format` (`src/pin.c:410`) requires digits, so the door is open if the
   input method ever changes -- a longer numeric PIN is also available at no UX cost worth
   speaking of, and eight is already the maximum this build accepts.
4. **Zero the decrypted payload after dispatch** in `protocol_handle_frame`, and `memzero` the
   buffer in `ble_chunk_reset` (F3). Transport code — another owner.
5. **Gate the plaintext fallback in `callNow`** on `session.isActive` for `setPassphrase`, or for
   every method (F6). App transport — another owner.
6. **Decide about `nvs_erase_all`** (F9): either force an NVS garbage collection after a wipe, or
   state plainly in `docs/BURN-PROCEDURE.md` and the wipe UI that a wipe is only final once flash
   encryption is burned.
7. **Decide whether `src/protocol.c:365` should log at all** (F4).
8. **Narrow `app/src/main.ts:1004-1006`** to "nothing here stores the passphrase", and zero the
   plaintext CBOR buffer after `encrypt()` (F6).
