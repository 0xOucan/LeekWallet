# Zero-friction settlement: paying from any chain without gas

Design note for La Caja. The goal: **a customer pays from whatever chain they
already hold USDC on, without holding that chain's native token, and without
being asked to think about chains at all.**

---

## 1. On reusing `Z0tzBridge.sol`

The instinct — "we need contracts to sweep to the restaurant address" — is
right. This particular contract is the wrong one to use, for four specific
reasons, and none of them is about code quality.

**It mints on the relayer's word alone.**

```solidity
function mint(address recipient, uint256 amount, uint256 srcChainId, bytes32 srcLockId)
    external onlyRelayer returns (bytes32 mintId)
{
    ...
    IMintable(address(token)).mint(recipient, amount);
}
```

Nothing here proves the lock happened. `srcLockId` is an argument, not a proof.
A compromised relayer key mints unlimited tokens. CCTP requires **Circle's
attestation signature** over the burn — a cryptographic proof the destination
contract verifies. That is the difference between a bridge and a promise.

**A leaked relayer key is unrecoverable.** `setRelayer` is `onlyRelayer`, so an
attacker who takes the role reassigns it to themselves permanently. No admin, no
timelock, no pause.

**It produces a wrapped IOU, not USDC.** The merchant would hold a bridge token
redeemable only through that bridge. CCTP burns native USDC on the source and
mints **native** USDC on the destination — the merchant ends up with real
Circle USDC, which is the entire point of settling in a stablecoin.

**`lockId` has no nonce.** It hashes `(sender, amount, destChainId, recipient,
localChainId, block.number)`. Two identical sweeps from the same address in one
block collide and the second reverts on `"Bridge: duplicate lock"`. Narrow, but
a restaurant sweeping several equal amounts will find it.

**The verdict is not "don't write contracts".** We need two, and they are
described below. They are just not a bridge — CCTP already is one, with a real
proof system, and we should not compete with it.

---

## 2. What actually creates the friction

Two separate things, often confused:

| Friction | Who feels it | Fix |
|---|---|---|
| Customer must hold the origin chain's **native gas token** | every customer | **EIP-3009** — a signed authorization a relayer submits |
| Customer must **choose a chain** | every customer | accept all of them; detect where their money is |

Neither is solved by a bridge. Both are solved by meta-transactions.

## 3. EIP-3009 is the mechanism

Circle's USDC implements **EIP-3009** natively (`transferWithAuthorization`,
`receiveWithAuthorization`, `cancelAuthorization`). The customer signs an
EIP-712 message off-chain — **no gas, no native token, no approval
transaction** — with a `bytes32` nonce and a validity window. Anyone can submit
it; the submitter pays the gas.

Any wallet that can sign typed data can do this. That is every wallet.

**Caveat to check per chain:** bridged (non-native) USDC does not necessarily
implement EIP-3009 — Polygon's bridged token notably does not. The accepted
matrix must be verified per chain rather than assumed, exactly like the EURC
asymmetry.

### Why not Circle Paymaster

Circle Paymaster lets users pay gas in USDC, is permissionless, needs no API
key — and is **the wrong tool here**:

- it requires an **ERC-4337 smart account**; a diner with MetaMask has an EOA
- it is deployed only on **Arbitrum and Base** (plus testnets)
- 10% gas surcharge

EIP-3009 works with plain EOAs on every chain with native USDC. Paymaster stays
on the list as an option for customers who *do* have a smart account.

### Prior art

Gelato's `gasless-cctp` implements precisely this pattern: a sender contract on
each source chain and a receiver on each destination; the user signs **two
ERC-3009 authorizations** (the transfer and the relay fee) plus an intent
signature bounding the max fee and destination domain; the relayer submits
`depositForBurn`, then a watcher fetches the attestation and calls
`receiveMessage`, taking its fee from the minted USDC. Gas is abstracted away
and compensated in USDC.

We follow that shape rather than inventing one.

---

## 4. The architecture

```
Customer                Relayer (ours)            Arc (settlement)
any chain, EOA          pays gas, refunded        LeekWallet admin
─────────────────       ──────────────────        ────────────────────
signs EIP-3009      →   CajaForwarder             
(no gas, no native)     · verifies authorization
                        · pulls USDC
                        · depositForBurn → 26  →  CCTP attestation
                                              →  receiveMessage
                                                 CajaTill (Arc)
                                                 · records order + tip
                                                 · splits staff shares
                                                 · ONLY admin withdraws
```

**Two contracts, both small:**

**`CajaForwarder`** (one per source chain). Takes an EIP-3009 authorization plus
a bounded intent, pulls the USDC, and calls `depositForBurn` to domain 26. It
custodies nothing beyond the length of one transaction, and it must **refuse an
authorization whose destination domain is not the one the customer signed** —
otherwise the relayer chooses where the money goes.

**`CajaTill`** (on Arc). Receives the minted USDC, records the order and its tip
split, and permits withdrawal **only** by the address the LeekWallet device
holds. Staff can read it; nobody but the admin can drain it.

**Direction is fixed and non-negotiable: into Arc, never out.** The public Iris
API returns nothing for Arc as a *source* domain — an open issue whose only
workaround is a community relay. We never depend on that.

## 4b. The relayer really is simple — keep it that way

To be clear, because the section above reads heavier than the thing it
describes: **the relayer is a private key, some gas, and a loop.** No
encryption, no consensus, no infrastructure. It watches for work, signs, pays
gas, and moves on. Deploying one is an afternoon.

```
loop:
  take a signed authorization from the terminal queue
  submit it on the source chain          (pay gas)
  poll Iris for the attestation
  submit receiveMessage on Arc           (pay gas, in USDC)
```

There is exactly **one property worth protecting**, and it costs nothing to
keep:

> **The customer's signature names the destination. The relayer only pays gas.**

That single line is the difference between two designs that take identical
effort to run:

| | Custodial | Courier |
|---|---|---|
| Customer sends to | the relayer's address | the till, directly |
| Relayer holds funds | yes, in flight | **never** |
| Leaked key costs | every payment in flight | the ability to submit already-signed transfers |
| Crash mid-flow | funds stranded on a hot key | funds are where the customer sent them |
| Effort to operate | key + gas + loop | key + gas + loop |

EIP-3009 gives us the courier version for free: `to`, `value`, `validAfter`,
`validBefore` and `nonce` are all **inside the signed payload**. The relayer
cannot change the recipient, the amount, or the deadline — it can only choose
whether to submit. So "just relay, route, send" is exactly right; we simply let
the signature carry the routing instead of the relayer's own logic.

Two reasons this matters beyond good practice. A hot key that custodies customer
payments is the precise thing this project argues against everywhere else — a
judge will notice. And a courier relayer needs no monitoring, no balance
reconciliation, and no incident plan for a key compromise, which is *less* work
to run, not more.

## 5. Who pays, and how the relayer is repaid

The relayer fronts gas on the source chain and on Arc, and is repaid in USDC out
of the payment itself — a second EIP-3009 authorization for the fee, bounded by
the customer's signed maximum.

**The customer must see the fee before signing.** A "free" payment that quietly
deducts an unbounded relay fee is a worse product than one that shows a number.
The terminal displays base + tip + relay fee, and the signed intent caps it.

## 6. Staging — this is a stretch, not the MVP

The POS ships **without any of this**:

| Stage | Customer experience | Contracts needed |
|---|---|---|
| **MVP (T2)** | plain USDC transfer, pays own gas, any wallet | **none** |
| **G1** | same, but we accept 9 chains and sweep at shift close | none (relayer script only) |
| **G2** | signs EIP-3009, **no native gas needed** | `CajaForwarder` |
| **G3** | settles into `CajaTill` on Arc with tip splitting | + `CajaTill` |

**Do not start G2 before the MVP is recorded on video.** Gasless is what makes
the demo memorable; a working POS is what makes it a submission.

## 7. Testing rounds

| Round | What is tested | Funds |
|---|---|---|
| **G-1** | EIP-3009 authorization signed and submitted by a relayer on Base Sepolia; **customer address holds zero ETH** | Base Sepolia USDC only (deliberately no ETH) |
| **G-2** | Replay: the same authorization submitted twice is **rejected by the nonce** | as above |
| **G-3** | Expiry: an authorization past `validBefore` **fails** | as above |
| **G-4** | Wrong destination: relayer tries to burn to a domain the customer did not sign; forwarder **refuses** | as above |
| **G-5** | Fee bound: relayer claims more than the signed max; **refused** | as above |
| **G-6** | Full path Base Sepolia → Arc, customer with zero native gas, funds land in `CajaTill` | Base Sepolia USDC, Arc USDC for relayer gas |
| **G-7** | Crash between `depositForBurn` and `receiveMessage`; resumes from the attestation, **no double-burn** | as G-6 |
| **G-8** | Withdrawal from `CajaTill` by a non-admin **refuses**; by the device, succeeds and renders correctly | Arc USDC |

**G-4 and G-5 are the ones that matter.** They are the tests that stop our own
relayer from being a thief. A gasless system where the relayer picks the
destination or the fee is a custodial system with extra steps.

## 8. What we will not claim

- The relayer is **trusted for liveness**: if it stops, payments stop. It is not
  trusted for *custody* — bounded authorizations mean it cannot redirect funds
  or overcharge — and that distinction goes in the README rather than being
  glossed.
- EIP-3009 support is **verified per chain**, not assumed.
- Testnets only. No real funds.
