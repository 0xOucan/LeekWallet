# ATECC608B as a PIN gatekeeper — research, not results

**Status: researched on paper only. No ATECC608B has been obtained, wired, or
talked to. Nothing in this document has been executed.** It exists so that
whoever does get hardware starts from the design questions already answered,
rather than from a datasheet.

Companion to [BURN-PROCEDURE.md](BURN-PROCEDURE.md), which covers the on-chip
(eFuse / secure boot) route. The two solve overlapping problems; this one solves
strictly more of the physical-access problem, and costs a part.

---

## The problem neither software nor eFuses can solve

LeekWallet wipes the vault after 3 failed PINs. That counter lives in NVS, in
flash, on a chip whose firmware the attacker can replace. An attacker holding the
board reflashes it with a build whose counter never increments, and the 3-strike
limit is gone. A 4–8 digit PIN then falls in seconds.

The eFuse `HMAC_UP` binding does **not** fix this, and the reason is worth
restating because it is easy to get wrong: read-protection stops software
*reading* the key, not *using* it. After a reflash the software is the
attacker's, so they call the HMAC peripheral themselves. See NEXT-SESSION.md for
the full table — the short version is that eFuse binding defeats a **flash dump**
and does not defeat a **stolen board**.

The property that does fix it is: **the attempt counter must live in silicon the
main MCU cannot rewrite.** That is what a secure element is for, and it is why
Coldcard uses one this way.

## The model: gate, do not sign

The ATECC608B is **not** used to sign transactions. secp256k1 signing stays in
`trezor-crypto` on the ESP32, where it is auditable and where the seed already
lives during an unlock.

The 608 holds one thing: a secret that is released **only** on a correct PIN, and
only a bounded number of times. The vault key becomes a function of both:

```
vault_key = KDF( PIN , secret_released_by_608 )
```

Get the PIN wrong N times and the 608 stops answering — permanently. The seed
is then unrecoverable by anyone, including the owner. That is the intended
behaviour, and it is why this must never ship without the backup flow being
tested first.

## Why the limit is a hardware guarantee

Three mechanisms, all documented in the ATECC608B datasheet:

- **Monotonic counters** — two of them, max 2,097,151, that only ever
  increment. There is no decrement command and no reset command.
- **`SlotConfig.LimitedUse`** — binds a slot's key to a counter, so using the
  key *is* incrementing the counter. They cannot be separated.
- **The `Lock` command** — permanently locks the config zone, the data zone,
  and individual slots. Once locked there is no unlock, in any command set, with
  any credential.

So the limit is not enforced by LeekWallet's firmware and cannot be relaxed by
replacing it. **Reflashing the ESP32 buys the attacker no additional attempts.**

## Wiring (SOIC-8)

| Pin | Signal |
|---|---|
| 4 | GND |
| 5 | VCC (3.3 V) |
| 7 | SCL |
| 8 | SDA |

Pins 1, 2, 3, 6 are no-connect. **Four functional wires.**

It shares the existing I²C bus — `SDA=GPIO8`, `SCL=GPIO9` — and answers at
`0x60` while the SSD1306 OLED is at `0x3C`, so there is no address conflict.
Pull-ups of 4.7 kΩ to 3.3 V are needed on SDA/SCL if the breakout does not
already carry them. A breakout board avoids fine-pitch soldering entirely.

## The mistake that would be permanent

**The I²C bus is in the clear.** A logic analyser on SDA/SCL captures every byte
crossing between the ESP32 and the 608 — including a secret released after a
correct PIN, if the naive design is used. Physical access is the exact threat
model this part is bought to address, so a plaintext bus gives most of it back.

This is not theoretical caution. [PQ1](https://github.com/EthereumPhone/PQ1)
treats an encrypted MCU↔SE channel as mandatory, using OPTIGA's AES-128-CCM-8
Shielded Connection and SE050's SCP03 — two secure elements, both with the
channel encrypted, no exceptions.

The 608's equivalent is the **I/O protection key** and encrypted read
(`Read`/`Write` in encrypted mode, with `CheckMac`/`GenDig` establishing the
session). The critical scheduling fact:

> **The slot configuration that enables encrypted I/O must be set before the
> config zone is locked, and the config zone lock is permanent.**

Retrofitting the encrypted channel later means starting with a fresh chip. So
the encrypted path has to be part of the first design, not a hardening pass.

## Suggested order of work, when hardware exists

Everything up to the final lock is **reversible**, which is what makes this a
cheap place to make mistakes:

1. **Buy several chips** (they are ~$1–2). Not one.
2. Wire a breakout on flying leads. Confirm the 608 answers at `0x60` alongside
   the OLED — an I²C scan is the whole test.
3. Develop the driver against an **unlocked** chip, which is fully rewritable.
4. Work out the complete slot configuration **including the encrypted I/O path
   and the `LimitedUse` counter binding**, and review it against the datasheet
   as a whole before committing.
5. Prove the failure behaviour: N wrong PINs, chip stops answering, vault
   unrecoverable — on a chip you are willing to destroy.
6. Prove the **backup and restore** flow survives it. A user whose 608 bricks
   must be able to restore from their seed phrase onto a new device.
7. Only then lock the config zone.

## Open questions

- **What is N?** Coldcard's model and PQ1's both sit around 10–13. LeekWallet's
  software limit is 3, which is aggressive for a hardware-enforced permanent
  brick. This wants deciding with the backup flow in view, not in isolation.
- **Does the 608 change the eFuse decision?** They are complementary — the
  608 stops the stolen-board attack, the eFuse binding stops the dump-only
  attack — but the eFuse burn is permanent and should not be spent on a scheme
  that a 608 would restructure. Design both, burn second.
- **Supply and authenticity.** Counterfeit and re-marked Microchip parts exist.
  Sourcing matters for a part whose entire value is that it behaves as
  specified.

## Sources

- Microchip ATECC608B datasheet (`SlotConfig`, `Lock`, monotonic counters,
  I/O protection key)
- PQ1, for the encrypted-MCU↔SE-channel requirement:
  <https://github.com/EthereumPhone/PQ1>
