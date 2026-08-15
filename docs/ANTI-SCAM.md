# Anti-scam infrastructure, and which half of it a hardware wallet can use

Research note. Written while implementing EIP-712 typed-data signing (T12b), because
the question "what do Rabby and revoke.cash actually do, and how much of it belongs
on a device with a 128x64 screen" decides what that feature has to display.

The short version: **almost everything the industry calls wallet security lives on
the host, is advisory, and a compromised host defeats all of it.** That is not an
argument against it. It is an argument for knowing which layer you are standing on,
because the two failure modes are completely different and a wallet that blurs them
is lying to its user.

## The attack this is all aimed at

The modern drainer does not ask you to send it money, and increasingly does not ask
for an on-chain `approve()` either. It asks for an **off-chain EIP-712 signature** via
`eth_signTypedData_v4` — an EIP-2612 `Permit` or a Uniswap `Permit2` `PermitSingle`
/ `PermitBatch`. Signing is free, gasless, and produces no on-chain record at the
moment of the theft.

Three properties make this the weapon of choice:

- **It looks like nothing.** No gas, no pending transaction, no balance change. Many
  users have been trained that "signing a message is safe" because that was roughly
  true in the `personal_sign` era.
- **It is invisible until it fires.** The signature sits off-chain. The attacker
  chooses when to submit it, and `Permit2` signatures carry a deadline that can be
  far in the future, so the drain can happen long after the phishing site is gone.
  There is no on-chain trace linking the theft to the site that took the signature,
  which is why these attacks are hard to attribute.
- **`Permit2` amplifies it.** Permit2 is a single contract holding allowances on
  behalf of many dapps. One phished `Permit2` signature can reach *every token the
  victim has ever approved to Permit2*, rather than one token for one dapp.

Scale, for calibration: roughly **260,000 victims and $314M lost to phishing on EVM
chains in H1 2024 alone**, already exceeding all of 2023. This is the dominant
theft vector for self-custody users, well ahead of key extraction.

## What the host-side tools do

**Rabby** runs, before you sign:

1. **Transaction simulation** against a forked node, producing the concrete balance
   changes — what leaves, what arrives. This is the "pre-sign" panel.
2. **A rule engine** (open source: `RabbyHub/rabby-security-engine`, with rules in
   `web3-security-rules`) evaluating a context — transaction, typed data, or dapp
   connection — against rules that produce severities the UI can act on. Rules cover
   things like sending to an address you have never sent to, a contract flagged as
   previously exploited, an origin that does not match the dapp, and unlimited
   approvals.

**revoke.cash** works on the other side of the clock: it is *hygiene*, not
interception. It enumerates outstanding allowances so you can revoke them, and for
Permit2 it surfaces the two operations that actually matter — `lockdown`, which
batch-revokes allowances for a spender, and `invalidateNonces`, which kills
signatures you have already signed but nobody has submitted yet. That second one is
the only tool that helps *after* you have been phished but *before* the drain lands.
It cannot recover anything already taken.

The critical property of both: **they are advisory and they are defeasible.** They
run on the host. Malware that can alter what a dapp shows can alter what the scanner
shows. They raise the cost of an attack; they do not bound it.

## What a hardware wallet can do that none of that can

The device's authority comes from one property: **it holds the key and it has its own
screen**, so what it displays is not subject to the host's account of events. That
makes exactly one guarantee available — *what you see is what you sign* — and it is
worth more than any amount of host-side scoring, because it survives a fully
compromised host.

The industry splits on how to honour it for typed data:

- **Trezor** walks the user through the structure field by field, showing the domain
  (name, version, verifying contract) and the message fields with their names.
- **Ledger** historically signs the *hash* of the encoded data — the user confirms a
  digest, not the content — with clear-signing only for schemas it has metadata for.
  That metadata standard is **ERC-7730**, and its acknowledged weakness is coverage:
  where neither dapp nor wallet has descriptors, the user is back to blind signing.
  **ERC-8213** is the proposed fallback, on the honest premise that a human cannot
  verify 500 bytes of hex on a small screen: rather than show unreadable bytes, show
  a short reproducible digest that can be compared against one the dapp displays.

LeekWallet's existing position (PROTOCOL.md 6bis) is the Trezor end of that split,
and stricter: **refuse what cannot be rendered** unless blind signing is explicitly
enabled. That is the right default for this project and should not be softened.
Note the real cost, though: refusing is a worse user experience than a digest, and a
user who cannot complete a legitimate signature here will complete it in a hot
wallet instead. ERC-8213-style digests are the compromise to consider later — a
weaker guarantee than rendering, a much stronger one than signing blind.

## What this means for T12b

Device-side, authoritative, must be on the device's own screen:

- **The domain**: `verifyingContract`, `chainId`, `name`. The verifying contract is
  the field that says *who this signature is really for*, and it is the one a
  phishing site cannot fake without changing what gets signed.
- **`chainId` cross-check** against the chain the device believes it is on. A
  mismatch is a replay setup and should be called out, not silently rendered.
- **Unlimited amounts named as such.** `uint256.max` must never render as a long
  number a user's eye slides over; the existing ERC-20 approval path already names
  unlimited approvals and typed data must match it.
- **Deadlines shown as absolute time**, with a far-future deadline flagged. "Valid
  for 50 years" is the signature of a drainer, not of a swap.
- **Permit2 fields specifically**: token, spender, amount, expiration, and
  `sigDeadline`. If the verifying contract is Permit2, the spender is the address
  that ends up holding the power, and it deserves the same prominence a transfer
  recipient gets.

Host-side, advisory, and **must be labelled as advisory** — the same rule already
applied to ERC-7730 descriptors, which are unsigned and tied to nothing:

- Approval hygiene in the companion, in the spirit of revoke.cash: list outstanding
  allowances, and offer `lockdown` / `invalidateNonces` for Permit2. This is cheap,
  needs no new trust, and is the only remedy that works between phishing and drain.
- Simulation, if ever added, is a convenience and must never gate or replace what
  the device decides.

The line to hold: the device must never be made to depend on a host claim, and the
app must never present a host-side warning as though the device verified it. A green
tick that means "our scanner had no opinion" is worse than no tick at all.

## Sources

- Rabby security engine: <https://github.com/RabbyHub/rabby-security-engine>,
  rules at <https://github.com/RabbyHub/web3-security-rules>
- Revoke.cash on Permit2 and permit signatures:
  <https://revoke.cash/learn/approvals/what-is-permit2>,
  <https://revoke.cash/learn/approvals/what-are-eip2612-permit-signatures>
- MetaMask on signature phishing:
  <https://support.metamask.io/stay-safe/protect-yourself/wallet-and-hardware/signature-phishing/>
- Ledger on clear signing and ERC-7730 v2:
  <https://www.ledger.com/blog-the-evolution-of-clear-signing>
- EIP-712: <https://eips.ethereum.org/EIPS/eip-712>
