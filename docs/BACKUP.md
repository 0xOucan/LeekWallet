# Backing up a seed that holds real value

The device protects a seed while it is on the device. This document is about the
part the device cannot help with: the copy you write down, which is where most
funds are actually lost.

## The one rule

**The seed and the passphrase must never be in the same place.**

Everything below follows from that. If someone finds both, they have your funds.
If you lose both, so have you. Every decision here is about keeping those two
failure modes apart.

## Do not split a seed phrase by cutting it up

The tempting scheme is: write words 1-8 on paper A, 1-4 and 9-12 on paper B,
5-12 on paper C. Any two papers reconstruct all twelve. It looks like a 2-of-3
backup and it is not one.

**One paper alone is enough to be dangerous.** Someone holding words 1-8, who
knows their positions, does not face a 128-bit problem. They face four unknown
words — about 2^44 candidates before the checksum narrows it further. A rented
GPU rig grinds that in **days to weeks**, deriving addresses and watching for one
that has ever held a balance.

So a single lost or photographed paper turns "computationally impossible" into
"someone patient with a credit card". You would never know it had happened.

The property you wanted is called *information-theoretic security*: with a real
threshold scheme, one share reveals **nothing at all** — not "hard to reverse",
but zero. You cannot get that by cutting the plaintext into overlapping pieces,
in any arrangement. That is the entire reason Shamir's scheme looks complicated.

## "But I use a passphrase, so it does not matter"

Arithmetically it mostly holds. An attacker with eight words still needs the
other four *and* the passphrase, and cannot test either alone: a candidate is
only verifiable by deriving an address and checking the chain, which needs both.
Even a mediocre passphrase pushes the search out of reach.

It is still the wrong trade, for three reasons.

**It makes the passphrase your only real protection.** You began with 128 bits.
After the leak, everything rests on a passphrase that is realistically 30-40
bits, chosen by a human. You have quietly converted a strong secret into a weak
one, and nothing on the outside shows it.

**It usually is not stored as separately as people think.** A passphrase kept
near the papers, or guessable from what someone knows about you, contributes
nothing at the moment it matters.

**It adds a second thing that must survive.** Forget the passphrase and all
three papers together are worthless. You have not removed the backup problem,
you have created another one — while weakening the first.

A passphrase is protection against a **stolen complete backup**. Spending it to
justify a weakened backup spends the same protection twice.

## What to do instead

**Several complete copies of the seed, in different places, and the passphrase
somewhere else again.**

That gets both properties without any new cryptography:

- **One location is robbed.** The thief holds a complete, valid seed and still
  cannot spend: they do not have the passphrase. The full 128 bits are intact.
- **One location is lost, burned or flooded.** The others are complete. There is
  nothing to reconstruct and no threshold to satisfy.

Compare that with three partial papers, which are weaker against theft *and*
offer more ways to lose access. It is worse on both axes at once.

## Verify a restore before you trust it

A wrong passphrase does not fail. It produces a perfectly valid wallet that
simply is not yours — and if you send funds to it, they are gone.

So: record the **master fingerprint (XFP)** when you set the wallet up. It is
eight hex characters shown on the wallet screen and on both passphrase
confirmation screens, and it identifies the *seed*, not one address.

To check a restore, enter the seed, apply the passphrase, and confirm the XFP
matches what you recorded. If it does not, the passphrase is wrong — stop before
moving anything. This is the cheapest check available and it takes seconds.

## Practical notes

- **Paper is a serious option.** It has no firmware, no battery, no reader
  dependency, and is readable in fifty years. Metal is better against fire and
  water. Both beat anything that needs a device to interpret it.
- **Never photograph a seed.** A phone camera roll is the most common way a
  written backup becomes a lost one.
- **Test the restore before funding.** A backup you have never restored from is
  a hypothesis, not a backup.
- **Write down which wallet a backup is for** if you keep several — the XFP is
  the label that cannot be confused with another seed.

## If you genuinely want threshold backup

SLIP-39 (Shamir's Secret Sharing for mnemonics) is the standard, and it gives
the property naive splitting only imitates: any two of three shares recover the
secret, and any one reveals nothing. It is implemented in this tree
(`src/slip39-backup.c`, verified against all 45 official test vectors) and is
**not wired to any screen** — it costs zero bytes in the firmware today.

It is deliberately unfinished because most people do not need it: complete
copies plus a passphrase covers the same ground with fewer ways to go wrong. If
you want it, the remaining work is the interface, not the mathematics.
