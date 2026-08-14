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

Today the AES key is `SHA256(SHA256(pin))` — two hash calls, no salt. With a 6-digit PIN that is
10⁶ candidates at roughly nanoseconds each.

```
salt          = 16 random bytes, per device, stored in NVS
encryption_key = PBKDF2-HMAC-SHA512(pin, salt || "leek-enc-v2", iterations)
verify_hash    = PBKDF2-HMAC-SHA512(pin, salt || "leek-ver-v2", iterations)
```

Two independent domain separators, so the stored verification hash is not an oracle for the
encryption key — today they are both unsalted functions of the same PIN, which means cracking
one cracks the other.

`iterations` tuned to ~500 ms on the S3 (measure on QEMU first, then hardware). That turns 10⁶
candidates into roughly six days of continuous attack per device instead of a moment — and with
flash encryption on, the attacker cannot get the ciphertext to attack in the first place. The KDF
is defence in depth for the case where they do.

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
