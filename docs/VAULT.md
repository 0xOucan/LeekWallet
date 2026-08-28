# The Vault — protecting the seed at rest

Design for [AUDIT.md S1](../AUDIT.md), the one remaining disqualifying finding.

## What we can honestly claim, and what we cannot

"Protected against physical attacks" is a spectrum, and it matters where on it we land. Four
tiers, from the attack that will actually happen to the one that probably will not:

| Attacker | Today | After this design |
|---|---|---|
| Finds/steals the device, runs `esptool read_flash` | **Seed recovered in seconds** | Ciphertext only; eFuse key is read-protected |
| Steals it and brute-forces the PIN through the firmware | 3 attempts, then wipe | Unchanged, but now this is the *only* route |
| Desolders the flash chip and reads it directly | Seed in plaintext | Ciphertext only — the key never leaves the SoC |
| Funded lab: decapping, fault injection, side-channel on the eFuse | Trivially wins | **Probably still wins** |

The fourth row is the honest limit. ESP32-S3 is a general-purpose MCU, not a certified secure
element, and the ESP32 family has a documented history of fault-injection and glitching attacks
against eFuse protections. A well-resourced attacker with the physical device and laboratory
equipment should be assumed to win.

So the claim is: **"your seed survives losing the device."** Not "your seed survives a
nation-state." That first claim is the one that covers realistic loss — a stolen bag, a
discarded device, a burglary — and it is exactly the claim the current firmware cannot make.

This is also where the DIY argument holds its shape rather than overreaching. We are not
pretending to beat a secure element at physical resistance. We are closing the gap on the attack
that actually happens, while being verifiable on the attacks where silicon does not help.

## Unlock model

Three credentials, with distinct jobs. Keeping them distinct is what stops the design drifting
into "any secret opens anything".

| Credential | Opens the vault | Required to sign | Stored on device |
|---|---|---|---|
| **PIN** | Yes — the daily path | **Yes, always** | Salted hash only |
| **Passphrase** | No | Yes, *if configured* | **Never, not even encrypted** |
| **Seed phrase** | Recovery only — see below | **No** | Encrypted under the PIN-derived key |

**Signing requires PIN, plus passphrase if the user set one.** Never the seed phrase. A device
that asks for your seed phrase in order to send a transaction has trained you into the exact
habit every phishing attack depends on. The seed is for restoring, and nothing else.

**Passphrase is optional.** PIN-only is a complete, supported configuration and should be the
default. A user who wants one wallet and one PIN gets exactly that; the passphrase exists for
people who want a second hidden wallet or an off-device factor.

**The seed phrase is a recovery path, and it restores rather than unlocks.** If the PIN is
forgotten, re-entering the seed does not open the existing vault in place — it wipes and
re-imports, then requires a new PIN to be set. Two reasons this is better than unlocking in
place:

1. One vault with two doors means two locks to get right, and the second one is rarely the one
   that gets audited. Restore-and-reinitialise keeps a single authenticated path into a live
   vault.
2. It costs nothing in practice. Anyone holding your seed phrase already controls the funds and
   has no reason to want your device. So a seed-phrase route into the device grants an attacker
   nothing they did not already have — which is also why it is safe to offer at all.

The passphrase is unaffected by any of this: it is not stored, so restoring from seed cannot
reveal a passphrase wallet. Recovering a passphrase wallet requires the seed *and* the
passphrase, from the user's memory or their own backup. That is the property that kept passphrase
users whole through the Coldcard incident, and it must not be softened for convenience.

## Multi-seed model

Most hardware wallets store exactly one seed and derive everything from it.
LeekWallet stores up to 30, which is a deliberate divergence worth being
explicit about.

```
Vault (one PIN)
├── seed 1 ──┬── no passphrase  → wallet A → m/44'/60'/0'/0/0, /1, /2 ...
│            └── passphrase "x" → wallet B (unrelated to A)
├── seed 2 ──── ...
└── seed 30 ─── ...
```

Three independent axes: which seed, which passphrase, which derivation path.
Only the first is stored.

**What multiple seeds buy:** importing wallets that already exist elsewhere,
keeping genuinely separate identities with separate backups, and sharing one
device across people.

**What they cost:** N seeds means N backups. One seed with multiple BIP44
accounts (`m/44'/60'/account'/...`) covers most "separate wallets" needs with a
single thing to protect, which is exactly why the single-seed convention exists.
The 30 slots are a capability, not a recommendation — the default path should
stay one seed and many accounts.

### Is multi-seed a security problem?

No, but it is a backup problem, and the distinction matters.

**Not a security problem.** Every seed is encrypted under the same vault key
with its own IV, so storing thirty weakens no individual seed. One PIN protects
one seed exactly as well as it protects thirty.

**It is an aggregation problem.** A compromised PIN now costs N wallets instead
of one. That is not a weakness in the crypto, it is more value behind the same
door, and it is the argument for the KDF and flash encryption rather than
against multiple seeds.

**The real risk is human.** N seeds means N phrases to write down, and the
failure is forgetting that wallet 2 was ever created, then wiping. Three
guardrails address it:

- Backup verification is tracked per wallet, and the wipe screen counts
  unverified ones and demands more presses when any exist.
- New Wallet and Import Wallet leave the main menu once a seed exists, so a
  second seed is a deliberate trip into Settings.
- **Every screen showing a phrase names its wallet** — `Seed W2/2 1-4` rather
  than `Seed Phrase`. Hardware testing found this missing, and an unlabelled
  backup is how a phrase ends up filed under the wrong wallet, which is the
  same as losing it.

**But once the passphrase UI lands, most users should not need this.** One seed
plus a passphrase gives unlimited hidden wallets from a single backup, which is
strictly better than N backups: fewer things to lose, and the extra wallets
leave no trace on the device. Multiple stored seeds are for importing wallets
that already exist elsewhere, not for organising new ones.

### Passphrase input on four buttons

Fifty-two letters plus digits and symbols in one linear cycle would be
unusable. Instead the selector carries *mode entries* alongside the characters,
the same trick that makes `OK` work in the PIN and mnemonic screens:

```
  a b c ... z  [A]  [123]  [DEL]  [OK]
                ^     ^
         case toggle  symbol set
```

UP/DOWN move through the ring, ACCEPT applies whatever is highlighted. Picking
`[A]` flips the letter set to uppercase in place — no separate shift button, no
navigating 52 entries, and the four physical buttons keep their meaning
everywhere in the UI. CANCEL stays "delete last character", so the modes cost
nothing in navigation.

Worst case is roughly 15 presses per character. That is slow, and deliberately
so: this is the credential that is typed rarely and protects everything. Users
who want speed have the companion app ([PROTOCOL.md section 5](PROTOCOL.md)),
with the security trade stated plainly.

### Do not record which seeds have a passphrase

Tempting design: mark a seed as "PIN only" or "PIN + passphrase", so the device
can prompt correctly and warn when a passphrase is missing.

**That destroys plausible deniability, and deniability is most of what a
passphrase is for.** If the device knows wallet 3 requires a passphrase, then
anyone who compels you to unlock learns that a hidden wallet exists. The secret
stops being "is there another wallet" and becomes "what is the passphrase",
which is a question that can be asked under pressure.

Trezor's model stores nothing: any passphrase, including none, silently produces
a valid-looking wallet. There is no record to seize and nothing that
distinguishes a real hidden wallet from a typo. We follow the same rule:

- Passphrase is offered at unlock, always, for every seed.
- No flag, counter, or hint is persisted about whether one was ever used.
- Entering the wrong passphrase yields a different empty wallet, not an error.

The cost is that the device cannot tell you that you mistyped, which is exactly
the trap described below — and precisely why the fingerprint display is not
optional. Deniability is what makes the fingerprint necessary, not a substitute
for it.

## Three layers

### 1. A real KDF (replaces `SHA256²`)

Before this, the AES key was `SHA256(SHA256(pin))` — two hash calls, no salt. With a 6-digit PIN
that is 10⁶ candidates at roughly nanoseconds each.

```
salt          = 16 random bytes, per device, stored in NVS
encryption_key = PBKDF2-HMAC-SHA512(pin, salt || "leek-enc-v2", iterations)
verify_hash    = PBKDF2-HMAC-SHA512(pin, salt || "leek-ver-v2", iterations)
```

Two independent domain separators, so the stored verification hash is not an oracle for the
encryption key — in the scheme this replaced they were both unsalted functions of the same PIN,
which means cracking one cracked the other.

`iterations` is 2250, tuned to ~500 ms on the S3 (`vault_kdf_benchmark_ms()` reports ~508 ms at
boot).

#### One verifier, and only one

This construction is worth nothing if something cheaper in the same flash dump answers the same
question. Until recently something did: `src/pin.c` kept its own PIN verifier in
`leek_pin/pin_hash` — SHA-256 applied 101 times, unsalted — and a copy of it inside the vault
record. The PIN and the vault password are the same secret, so an attacker never touched PBKDF2:
they broke the cheap hash and then ran the KDF once. It was also unsalted, so one rainbow table
covered every device ever built.

That verifier is gone. `pin_verify()` now calls `wallet_verify_password()`, and the salted PBKDF2
hash in the vault record is the only value in flash that recognises a PIN. `sim/test_pin.c`
asserts this as a property of storage rather than of the code: after a set, an unlock, a PIN
change and a reboot, the unsalted chained hash of every PIN the device has held appears **nowhere
in simulated flash**, at any offset, in any namespace.

Existing devices are migrated. A device with a vault password drops the retired blob at the first
boot on this firmware — no PIN needed, since the strong verifier already answers to the same
secret. A device that had a PIN but never created a wallet has no strong verifier to check
against, so its retired one is honoured exactly once, at which point the vault password is written
from the PIN just proved correct and the blob is erased. Both orderings are power-cut safe in the
sense the rest of this document uses: at every instant, including the instant the power dies,
exactly one PIN opens the device and never zero.

#### What is left in the flash after the migration

`nvs_erase_key()` is a logical erase, the same as `nvs_erase_all()`: it marks the entry deleted in
the page's state bitmap and leaves the bytes where they are. So immediately after the migration a
`esptool read_flash` **still contains the retired verifier**, and will until NVS garbage-collects
that page — which happens when the page is needed, on no schedule anyone can predict, and never at
all on a device that is then left in a drawer. The value stops being *read* at once; it stops
being *present* at an unknown later time.

This is the same caveat as the wipe (see F9 in `docs/AUDIT-SECRETS.md`), and it has the same
answer: a logical erase is not a physical one, and the only construction that makes a flash dump
useless is flash encryption. What the migration does guarantee is that no *newly provisioned*
device, and no device whose NVS has since been collected, carries a cheap verifier — and that no
firmware from here on writes one. A field device upgrading today should be assumed to still hold
the old blob physically.

**That is no longer an inference.** `esptool read_flash 0x9000 0x6000` on a board in this repo's
own use returns four physically intact copies of `pin_hash` — all the same 32 bytes, all marked
erased, three of them on page 0, which has `seq=0` and has therefore never been garbage-collected
in the device's entire life. The same dump carries a superseded `pwd_hash`, an old `kdf_salt`, the
pre-generation `m_1`/`m_2`/`iv_1`/`iv_2` ciphertext and a superseded `vault_rec`. The partition is
24 KB — six pages, one held back for garbage collection — so a device with a handful of wallets
never fills it and never collects. Read `docs/AUDIT-SECRETS-2.md` N2 for the dump and what it
means for the wipe.

#### What it actually costs an attacker

The number this document used to give — "roughly six days" — was wrong, and wrong in the
dangerous direction. It priced the attacker at the *device's* speed: 10⁶ × 0.5 s ≈ 5.8 days. An
attacker with a flash dump does not use the device. They use a GPU, and they get the whole PIN
space, not the 6-digit slice.

Measured here (one core, `-O2`, this repo's own code, `sim/` build) the two verifiers cost
40 µs and 1627 µs per guess — a factor of 41 on a CPU where both are plain reference C. On a
GPU the gap is wider, because SHA-256 is the most heavily optimised primitive in existence there
and PBKDF2-HMAC-SHA512 is among the least friendly: 64-bit operations, and 2250 sequential
iterations that cannot be parallelised within one candidate.

| Verifier | Candidates/s, one consumer GPU | 6-digit (10⁶) | Whole 4–8 digit space (1.11×10⁸) |
|---|---|---|---|
| retired `pin_hash`, SHA-256×101 | ≈ 2×10⁸ (hashcat SHA-256 ≈ 2×10¹⁰ H/s ÷ 101) | ~5 ms | **~0.6 s** |
| vault verifier, PBKDF2-SHA512×2250 | ≈ 6×10⁵ (extrapolated from published hashcat figures at 1000 iterations) | ~1.7 s | **~3 minutes** |

Both GPU rows are extrapolations from published throughput, not measurements taken here; the CPU
figures above them are measured. Treat the second row as the right order of magnitude, not a
precise number.

So the fix removes a factor of roughly 350 and, more importantly, removes the unsalted blob that
made one precomputation work against the whole fleet. It does not make a numeric PIN a strong
secret, and nothing at this length would. **Read the table honestly: a flash dump of a device
using a 4–8 digit PIN is minutes of GPU time away from every seed on it.**

The defence that actually holds is layer 3 below: with flash encryption on, the attacker cannot
obtain the ciphertext to attack at all. The KDF is defence in depth for the case where they do.
Two things would meaningfully improve the KDF's own contribution, in this order: allowing a
longer or non-numeric PIN (nothing in `pin_is_valid_format()` requires digits), and raising the
iteration count by routing PBKDF2 through the S3's SHA accelerator (T9e).

The cost on the device is one extra derivation per unlock: the PIN screen now takes ~0.5 s to
answer instead of being instant, and a full unlock goes from roughly 1.8 s to 2.3 s, most of which
was always the BIP-39 seed derivation. That is the price of having no cheap verifier, and it is
the right trade.

Worth being precise about where those 2.3 s go, because it is also where the headroom is. A PIN
entry runs PBKDF2 **three times**: `pin_verify()` derives the verifier, and `wallet_unlock()` then
derives the verifier again and the encryption key. 3 × 508 ms ≈ 1.5 s of KDF, against an offline
attacker who pays for exactly one derivation per candidate. Collapsing that to one — derive the
key, and let the verifier be a cheap hash *of the key* rather than a second PBKDF2 pass — would
fund a 2× or 3× iteration count at today's latency. See `docs/AUDIT-SECRETS-2.md` N1.

### 2. Authenticated encryption (replaces raw CBC)

Current storage is AES-256-CBC with zero padding and no MAC. Nothing detects tampering, and
plaintext recovery relies on the mnemonic being NUL-terminated.

Move to **AES-256-GCM** — already vendored at `components/trezor-crypto/aes/aesgcm.c`, and the
S3 has an AES accelerator. Store `nonce || ciphertext || tag`. A modified ciphertext then fails
loudly instead of decrypting to garbage that gets treated as a seed.

### 3. Flash encryption + secure boot v2

The layer that actually stops the flash dump.

- **Flash encryption** (AES-XTS, key in eFuse, read-protected): `esptool read_flash` returns
  ciphertext. The key never leaves the SoC and is not readable by software.
- **Secure boot v2**: only firmware signed by our key boots, so an attacker cannot flash a
  modified image that simply prints the seed over serial. Without this, flash encryption alone
  is bypassable — encrypt the flash, then boot your own firmware that decrypts it for you.

They are a pair. Shipping one without the other is a common and serious mistake.

**Develop both against QEMU**, which emulates eFuses. eFuse burns are irreversible; a mistake on
real hardware is a dead board, and a mistake in the *scheme* is a fleet of dead boards.

## Migration

There are no production wallets yet, but the mechanism is needed before there are:

- Store `kdf_ver` in NVS. Absent or `1` = legacy `SHA256²`; `2` = the scheme above.
- On unlock, try v2. On failure, try v1; if v1 succeeds, transparently re-encrypt every mnemonic
  under v2, write `kdf_ver = 2`, and continue.
- Make the re-encryption crash-safe and idempotent — write the new blobs first, flip the version
  last, resume on boot. The fake NVS crash injection in `sim/` is what proves this, the same way
  it proved the S4 fix.

## Backing it up

The vault protects the seed on the device. The written copy is a separate
problem and the one people actually lose funds to — see
[BACKUP.md](BACKUP.md). The short version: keep the seed and the passphrase in
different places, keep complete copies rather than cut-up ones, and verify a
restore by its master fingerprint before funding it.

## Where the passphrase sits

Worth being explicit, because it is easy to assume the vault protects it: the BIP39 passphrase
is **never stored**, not even encrypted. It lives in RAM for the session and is gone on lock.
That is deliberate and matches Trezor. The vault protects the mnemonic and the PIN hash; the
passphrase is protected by not existing at rest.

Which means a passphrase wallet stays safe **even if every layer above fails.** An attacker with
a full flash dump, the eFuse key, and the PIN still cannot derive a passphrase wallet. This is
not theoretical: passphrase users were one of only two groups unaffected by the Coldcard
incident.

## Task breakdown

| ID | Task | Depends | Done when |
|----|------|---------|-----------|
| T9a | Per-device salt in NVS, generated via `entropy_fill()` | — | host test: salt is stable across reboots, unique per device |
| T9b | PBKDF2 KDF with domain separation, `kdf_ver` tagging | T9a | host round-trip test |
| T9c | Iteration tuning to ~500 ms | T9b | measured on QEMU, confirmed on hardware |
| T9d | Crash-safe v1→v2 migration | T9b | crash-injection test at every write point |
| T14 | AES-GCM storage, tamper rejection | T9b | flipped ciphertext bit is rejected |
| T11a | Flash encryption in QEMU, development mode | — | **DONE (QEMU)** — `qemu-read-flash.sh` passes on the encrypted image; entropy ~7.95 bits/byte throughout |
| T11b | Secure boot v2, signing key handling documented | T11a | **DONE (QEMU)** — key digest burns, RSA-PSS verifies, a flipped ciphertext bit gives `No bootable app partitions` forever |
| T11c | Hardware burn procedure + the irreversibility warnings | T11a, T11b | **WRITTEN, UNEXECUTED** — [BURN-PROCEDURE.md](BURN-PROCEDURE.md) + `scripts/preflight-secure.sh`; done when a second person has followed it on a sacrificial board |

T9a-T9d and T14 are pure firmware and fully host-testable. T11* needs QEMU and then a board you
are willing to lose.

### Where T11 actually stands

The whole burn sequence — secure boot v2 key digest, AES-256-XTS key, encrypt-in-place, and a
normal boot afterwards — **runs to completion under QEMU**, on the same eFuse model the hardware
uses. Espressif's QEMU does emulate ESP32-S3 flash encryption; the earlier note in
[QEMU.md](QEMU.md) that it might not was wrong, and the "stall" behind that guess was the
emulator having no USB-Serial-JTAG device model, so the firmware was booting in silence.

That closes the *scheme* risk, which was the expensive one: a wrong eFuse scheme would have been
a whole batch of bricks rather than one. It does not close the *silicon* risk. QEMU accepts every
eFuse write without modelling the coding scheme
([espressif/qemu#143](https://github.com/espressif/qemu/issues/143)), does not emulate the RTC
watchdog, and cannot say anything about brownout during encrypt-in-place or about whether read
protection holds under a glitch.

So [S1](../AUDIT.md) is **not yet closed**. It closes when a real board has been through
`docs/BURN-PROCEDURE.md`, and `esptool read_flash` on that board returns ciphertext where the
seed used to be. Until then the honest statement is: the design is proven, the burn is not.

Note also that the threat table at the top of this document does not move. Emulated proof of
flash encryption changes the first three rows from "planned" to "implemented and rehearsed"; the
fourth row — a funded lab with the physical device — still reads *probably still wins*, and
nothing in this work touched it.
