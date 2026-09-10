# AtsEscrowMarket — audit report

Contract: `src/AtsEscrowMarket.sol` · Solidity 0.8.30 · Cancun
Reviewed 2026-09-10 against the ethskills **security** and **audit** skills.
Spec: `../docs/SECONDARY-MARKET-SPEC.md`.

**Status: not yet deployed.** Two items below must be closed first (§5).

## 1. Scope and threat model

A secondary market for Hedera ATS securities. Sellers escrow a lot and name a
total price in USDC; buyers fill atomically. The market has **no owner, no admin
functions, no upgrade path, and no oracle**.

Adversaries considered: a malicious or hook-bearing security contract, a buyer
who should not be permitted to hold the security, a seller trying to double-sell
or reclaim a sold lot, a third party trying to cancel or fill someone's listing,
and a fee-on-transfer or partially-transferring token.

## 2. Findings

**No High or Medium findings.** No GitHub issues filed (the audit skill files
issues for Medium and above).

### Informational

| # | Finding | Disposition |
|---|---|---|
| I-1 | A seller frozen after listing cannot `cancel`; shares remain escrowed | **Accepted, by design.** A rescue function would be an admin key over other people's securities — exactly what a compliance regime exists to prevent. Recovery is the issuer's `controllerTransfer`, rendered on-device by the LeekWallet console. Proved by `test_frozenSellerCannotCancel_sharesStayEscrowed`. |
| I-2 | No partial fills | Out of scope by decision. All-or-nothing removes a class of accounting bugs. |
| I-3 | `PAYMENT_DECIMALS` is stored but unused on-chain | Intentional: read (never assumed) for callers and display. This contract performs **no scaling**, because `priceTotal` is a total. |
| I-4 | Constructor tolerates a non-Hedera chain where `0x167` has no code | Intentional. Association is not a concept off Hedera, and a typed call would revert on empty return data, making the contract untestable locally. |

## 3. Checklist — ethskills security skill

| Rule | Status |
|---|---|
| Token decimals queried, never assumed; no hard-coded `1e18` | ✅ `IERC20Metadata.decimals()`; no `1e18` in the source |
| Multiply before divide | ✅ **N/A by design** — `priceTotal` is a total, so the contract contains no division at all |
| CEI + `nonReentrant` | ✅ status written before every transfer; `ReentrancyGuard` on all three entry points; proved by `test_reentrantSecurityCannotDoubleFill` |
| `SafeERC20` everywhere | ✅ both legs |
| Fee-on-transfer / partial transfer handled by balance measurement | ✅ escrow is `balanceAfter - balanceBefore`; `testFuzz_escrowMatchesWhatArrived` |
| No infinite approvals | ✅ contract never calls `approve`; `type(uint256).max` appears nowhere in `src/` |
| Access control on state-changing functions | ✅ only the seller may `cancel`; `fill` is intentionally open; there are no privileged functions to protect |
| Input validation (zero address, zero amount, bounds) | ✅ `ZeroAddress`, `ZeroAmount`, `ZeroPrice`, `NothingEscrowed`, `SelfFill`, `NotOpen` |
| Events on every state change | ✅ `Listed`, `Cancelled`, `Filled` |
| Oracle safety | ✅ **N/A** — no oracle; the seller names the price, so there is no spot price to manipulate |
| MEV / slippage | ✅ **N/A** — a fill is at the listed total price or it reverts; there is no slippage parameter to leave at zero |
| Proxy / initializer / storage ordering | ✅ **N/A** — not upgradeable |
| EIP-712 replay (domain, nonce, deadline) | ✅ **N/A** — no signatures |
| `delegatecall` safety | ✅ **N/A** — none |
| ERC-4626 inflation | ✅ **N/A** — no shares |

Six rows are N/A **because a risk class was removed rather than mitigated**.
That is the design intent recorded in the spec, not a gap in review.

## 4. Tests

`forge test` — **15 passed, 0 failed**, including **20,000 fuzz runs**.

Invariants proved:

- a fill settles both legs or neither — `testFuzz_fillIsAllOrNothing`
- a frozen buyer cannot fill, **and no payment moves** — `test_THE_PROPERTY_frozenBuyerCannotFill_andNothingMoves`
- a buyer without KYC is refused, and the same trade settles once granted — `test_buyerWithoutKycCannotFill_andCanOnceGranted`
- a paused security blocks the fill — `test_pausedSecurityBlocksEverything`
- a filled or cancelled listing cannot be filled or cancelled again
- only the seller can cancel; a seller cannot fill their own listing
- the market holds **no payment token** after a fill — asserted in every fill test
- a re-entrant security cannot double-fill — the test asserts the re-entrant path *actually executed*, so the pass is not vacuous

Gas: `list` 187k, `fill` 110k, `cancel` 55k.

## 5. Outstanding before deployment

1. **Slither has not been run** — it is not installed in this environment.
   `pip install slither-analyzer && slither .`, and resolve every reentrancy,
   unchecked-return, and unprotected-state-change finding. The audit skill
   requires it; this report does not claim it passed.
2. **The HTS association path is untested.** Local chains have no code at
   `0x167`, so `test_*` exercises the tolerated no-op branch, **not** a real
   association. It must be confirmed on Hedera testnet: deploy, then verify the
   contract can receive USDC before any listing is made. This is the single most
   likely cause of a first-run failure.
3. Verify the source on HashScan after deployment — the track asks for it.
