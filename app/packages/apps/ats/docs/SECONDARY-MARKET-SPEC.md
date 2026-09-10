# C4 — a compliance-respecting secondary market for ATS securities

Hedera lists this as an extra-points item: *"A secondary market for ATS-issued
assets, which the Studio does not have today"* and *"Order book or auction with
compliance enforced at transfer."*

Per `app/packages/apps/README.md`, the Solidity lives in
`app/packages/apps/ats/contracts/` so deleting the mini-app takes it with it.

## 0. Decisions (settled 2026-09-10)

| Question | Decision |
|---|---|
| Order book or escrow? | **Escrow with match.** Seller lists, buyer fills atomically. An on-chain book is more contract for the same demo. |
| Payment leg | **USDC on Hedera testnet**, 6 decimals |
| Custody | **The market escrows the security.** More predictable than allowance-and-pull: the asset is already in hand at fill time. |

## 1. The Hedera constraint that must be handled first

Both USDC candidates are **HTS tokens**, addressed by long-zero EVM addresses:

| Token id | EVM address | symbol | decimals |
|---|---|---|---|
| `0.0.429274` | `0x0000000000000000000000000000000000068cda` | USDC | 6 |
| `0.0.5449` | `0x0000000000000000000000000000000000001549` | USDC | 6 |

**An HTS token cannot be received by an account that is not associated with
it**, and a newly deployed contract has no auto-association slots. So the market
contract MUST associate itself with the payment token before it can hold a
single unit:

```solidity
IHederaTokenService(0x0000000000000000000000000000000000000167)
    .associateToken(address(this), paymentToken);
```

Do this in the constructor (or a one-shot `initialize`) and **assert the
response code**. A silent failure here presents later as "every fill reverts"
with no obvious cause. Pick one token id, pin it, and record which.

The ATS security itself is an ordinary EVM contract (a diamond proxy), **not**
an HTS token, so it needs no association.

## 2. What escrow custody changes

Two consequences follow from the market holding the security, and both matter.

### 2a. The compliance demo moves from the seller to the buyer

Under allowance-and-pull, freezing the *seller* blocks the fill. Under escrow,
the seller's shares have already moved, so:

- Freezing the **seller** after listing does **not** stop the sale.
- Freezing the **buyer**, or revoking their KYC, **does** — the market → buyer
  transfer reverts, and the whole fill reverts with it.

That is still an excellent demo, arguably a better one:

> The issuer revokes a buyer's KYC in the LeekWallet console — signed on the
> device — and that buyer can no longer receive the security. The trade reverts.
> Grant it back and the same trade settles.

### 2b. A frozen seller can strand escrowed shares

If a seller lists, then the issuer freezes them, `cancel()` cannot return the
shares — the market → seller transfer reverts. The shares sit in the market.

**This is not a bug to engineer around; it is the compliance regime working.**
The recovery path already exists and we already render it: the issuer calls
**`controllerTransfer`**, the forced transfer, to move them out. Document it,
and demo it — it is the strongest possible justification for having built that
screen.

## 3. The contract

One contract, `AtsEscrowMarket`. All-or-nothing fills; no partial fills, no
order book, no matching engine.

```
list(security, amount, priceTotal)  -> listingId   // pulls the security into escrow
cancel(listingId)                                   // returns it to the seller
fill(listingId)                                     // buyer pays USDC, receives the security
```

State per listing: `seller`, `security`, `amount`, `priceTotal`, `status`.

### Rules, applied from the loaded security skill

1. **Decimals are queried, never assumed.** The security is 6 decimals here and
   USDC is 6, but `IERC20Metadata(token).decimals()` is read for both. No `1e18`
   anywhere. A hard-coded scale is the named anti-pattern and it is exactly the
   shape of bug that survives a demo and fails in review.
2. **`priceTotal` is a total, not a unit price.** This removes the multiply/divide
   ordering hazard entirely — there is no per-share division to truncate to zero.
   If a unit price is ever added, multiply before dividing.
3. **CEI plus `nonReentrant`** on `list`, `cancel` and `fill`. The security is a
   diamond with facets and hooks, so an external call can re-enter. Update the
   listing's status **before** any transfer.
4. **`SafeERC20` for every transfer**, both legs.
5. **Balance-measured escrow.** Record `balanceAfter - balanceBefore` as the
   escrowed amount rather than trusting the requested amount. Cheap insurance
   against a transfer that moves less than asked.
6. **No infinite approvals.** Ever. Buyers approve the exact `priceTotal`.
7. **Access control**: only the seller may `cancel`. `fill` is open. Any admin
   function is `Ownable` and must justify its existence.
8. **Input validation**: non-zero security, non-zero amount, non-zero price,
   seller is not the zero address, listing exists and is `Open`.
9. **An event on every state change**: `Listed`, `Cancelled`, `Filled`.
10. **No oracle.** The seller names the price. This deliberately avoids the
    entire oracle-manipulation class; there is no DEX spot price to manipulate.

### Explicitly out of scope

Partial fills, order matching, upgradeability (so no proxy, no `initializer`
hazards, no storage-ordering rules), signatures (so no EIP-712 replay surface),
and `delegatecall`. Each omission removes a named risk class from the skill's
checklist rather than mitigating it.

## 4. Invariants to test

- A fill either completes both legs or reverts entirely. **No state where the
  buyer paid and did not receive**, or the reverse.
- A non-KYC'd or frozen buyer cannot fill. The revert comes from the security,
  not from us — we do not pre-check, so we cannot be wrong about the rule.
- A cancelled or filled listing cannot be filled again.
- Only the seller can cancel.
- The market never holds USDC after a fill settles.
- Reentrancy through the security's hooks cannot double-fill a listing.

## 5. Deployment

Foundry script, run with the deployer key
(`0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45`, funded on Hedera testnet).
See `https://docs.hedera.com/evm/quickstart/deploy-with-foundry`.

Deploy **3 to 5 securities with real holders**, not ten empty ones — a market is
judged on depth of story, not asset count. Make the script take `N` so it
demonstrably scales. Deploy **one bond** to show the factory handles both;
do not build bond lifecycle (that is `Coupon.setCoupon()`, which we have not
built and which the console does not render).

Verify sources on HashScan — the track asks for it.

## 6. Before deploying

Run `slither .` and `forge test --fuzz-runs 10000` per the audit skill, and
resolve every critical finding. The audit skill's deliverable is an
`AUDIT-REPORT.md`; produce one and keep it beside the contract.
