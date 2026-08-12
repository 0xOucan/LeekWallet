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
| T11a | Flash encryption in QEMU, release mode | — | `read_flash` yields no plaintext |
| T11b | Secure boot v2, signing key handling documented | T11a | unsigned image refuses to boot |
| T11c | Hardware burn procedure + the irreversibility warnings | T11a, T11b | a second person can follow it |

T9a-T9d and T14 are pure firmware and fully host-testable. T11* needs QEMU and then a board you
are willing to lose.
