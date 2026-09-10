# GateToken — audit report

Contract: `src/GateToken.sol` · Solidity 0.8.30 · Cancun · optimizer 200
Reviewed 2026-09-10 against the ethskills **security** and **audit** skills.
Spec: `../docs/STRATEGIES.md` §5.

**Status: not yet deployed.** Slither is clean (§5). `forge test` is green with
20,000 fuzz runs (§4). Two items remain open and neither can be closed locally
(§6) — one of them can stop the deployment.

---

## 1. Scope and threat model

`GateToken` is a fixed-supply ERC-20 that exists for exactly one purpose: to be
the address argument of SwapVM opcode 14, `onlyTakerTokenBalanceNonZero`, in
the Aqua programs this app authors. Opcode 14 tests `balanceOf(taker) != 0` and
nothing else, so **the only property of this token with any on-chain effect is
whether a given address holds a non-zero balance.**

It holds no value, custodies nothing, and is not a party to any swap. The
tokens actually at risk in the surrounding flow — USDC, WETH, cbBTC — never
touch this contract. What is at risk if this contract is wrong is *availability*
of the maker's positions, not the maker's funds.

**No owner. No admin functions. No upgrade path. No oracle. No external call of
any kind.**

Adversaries considered:

| Adversary | What they would want | Why they cannot |
|---|---|---|
| A bot wanting to fill the gated positions | a non-zero balance | supply is minted once, in the constructor, to one named address; there is no mint |
| Anyone wanting to lock the maker's positions shut | to zero the holder's balance | balances move only on the holder's own authority; a transfer to `address(0)` is refused, so there is no accidental burn either |
| A malicious recipient | a callback during `transfer` | there is no hook and no external call — proved by `test_transferMakesNoExternalCall`, which transfers to a contract that reverts on every call it receives |
| Anyone at all | to inflate supply | `totalSupply` is `immutable` and no code path writes a balance except `_transfer`, which conserves the sum |

## 2. Findings

**No High, Medium or Low findings. No GitHub issues filed** (the audit skill
files issues at Medium and above).

### Informational

| # | Finding | Disposition |
|---|---|---|
| I-1 | The classic ERC-20 `approve` race (spender front-runs a change from N to M and spends N+M) is not mitigated | **Accepted, explicitly.** This token is never approved to anything — it is held and read by opcode 14. `approve` exists because ERC-20 requires it. Documented in the source; callers needing the safe pattern approve to zero first. |
| I-2 | The gate is a centralisation the pool does not advertise | **Accepted and documented, not fixed.** Anyone reading the program sees opcode 14 and an address; nothing on chain says whether that token is widely held. It is not. Recorded in the contract's own header and in STRATEGIES.md §6.4, and the pool is never to be described as "permissionless" without the qualifier. |
| I-3 | `decimals` is 0, which some ERC-20 UIs render oddly | **Intentional.** This is a credential, not an amount. Opcode 14 tests only for non-zero, so magnitude never has an effect, and 18 decimals would invite a reader to interpret a balance as a quantity that means something. |
| I-4 | An infinite allowance is decremented rather than short-circuited | **Intentional, at a small gas cost.** Every other ERC-20 skips the decrement at `type(uint256).max` as an optimisation that also makes an unlimited approval cheaper to live with. This repository's position is that an unlimited approval is never the right answer, so nothing here is built to make one convenient. Pinned by `test_anInfiniteAllowanceIsStillDecremented`. |
| I-5 | Written out rather than inherited from OpenZeppelin | **Intentional.** ~60 lines with no dependency to vendor, license-check and keep current, for a contract guarding two demo positions. The audit surface is the whole file. The tradeoff runs the other way for anything holding value; this holds none. |

## 3. Checklist — ethskills security skill

| Rule | Status |
|---|---|
| Token decimals queried, never assumed | ✅ **N/A** — this contract is the token, and its decimals are a documented constant, not an assumption about somebody else's |
| No floating point / no hard-coded scale | ✅ no scaling of any kind; the contract performs no multiplication or division at all |
| Multiply before divide | ✅ **N/A by design** — there is no division in the source |
| Reentrancy: CEI + `nonReentrant` | ✅ **N/A because the surface is absent, not guarded** — no external call, no hook, no callback, no `receive`, no payable fallback. `test_transferMakesNoExternalCall` proves it against a recipient that reverts on every call |
| `SafeERC20` on outbound transfers | ✅ **N/A** — this contract never calls another token |
| No infinite approvals | ✅ the contract never calls `approve` itself; `type(uint256).max` is handled, never privileged (I-4) |
| Access control on state-changing functions | ✅ there are no privileged functions to protect: no owner, no mint, no burn, no pause |
| Input validation (zero address, zero amount, bounds) | ✅ `ZeroAddress` on the constructor holder, on `approve`'s spender and on `_transfer`'s recipient; a zero supply is refused; `InsufficientBalance` / `InsufficientAllowance` carry both figures |
| Advanced input validation (array lengths, duplicates) | ✅ **N/A** — no arrays, no batch entry point |
| Events on every state change | ✅ `Transfer` on the mint (from `address(0)`, so an indexer sees the supply appear) and on every transfer; `Approval` on every approve |
| Incentive design for maintenance functions | ✅ **N/A** — there are no maintenance functions |
| Fee-on-transfer / partial transfer safety | ✅ **N/A** — this contract transfers only itself, and it transfers exactly the amount asked |
| Oracle safety, staleness | ✅ **N/A** — no oracle, no price |
| MEV / sandwich / `amountOutMinimum` | ✅ **N/A** — nothing here is priced or swapped |
| Proxy init / storage layout / upgrade authority | ✅ **N/A** — not upgradeable, no proxy, no initializer |
| EIP-712 replay (domain, nonce, deadline) | ✅ **N/A** — no signatures; `permit` is deliberately absent |
| `delegatecall` safety | ✅ **N/A** — none in the source |
| ERC-4626 inflation | ✅ **N/A** — no shares, no vault |
| Integer arithmetic correctness | ✅ two `unchecked` blocks, each with the branch that proves it safe immediately above it and a comment saying which; the supply-conservation fuzz covers the rest |
| Automated analysis run | ✅ Slither, 102 detectors, **0 results** (§5) |
| Source verified on the explorer | ⚠️ open — §6.2 |

Fourteen rows are N/A **because a risk class was removed rather than
mitigated**, which is the design intent recorded in STRATEGIES.md §5 and not a
gap in review. A contract with no external calls cannot have a reentrancy bug;
a contract with no owner cannot have an access-control bug. That is the reason
this contract is 60 lines instead of 600.

## 4. Tests

`forge test` — **21 passed, 0 failed**, including **20,000 fuzz runs** across
two properties.

Invariants proved:

- **Supply is conserved across any transfer.** `testFuzz_supplyIsConservedAcrossAnyTransfer`,
  10,000 runs over recipient, value and supply. Handles `to == holder`, where
  the two balances are one storage slot and must not be double-counted.
- **`transferFrom` never spends more than was approved,** and a reverted
  attempt leaves the allowance untouched. `testFuzz_transferFromNeverSpendsMoreThanApproved`,
  10,000 runs.
- **A self-transfer is a no-op.** The credit reads back the freshly written
  debit, so `from == to` must leave the balance exactly where it was rather
  than doubling or zeroing it — the classic unchecked-ERC-20 bug.
- **A transfer to `address(0)` is refused, not treated as a burn.** A burn
  would drop the circulating supply while `totalSupply` stayed constant,
  breaking the invariant this whole review rests on, and a gate token burned by
  accident locks the position shut with no way back.
- **The mint is observable from `address(0)`,** so an indexer reconstructing
  balances from logs sees the supply come into existence.
- **The contract cannot receive ETH.** No `receive`, no payable fallback; value
  sent to it is refused rather than stranded.
- **The gate is exactly `balanceOf != 0`,** tested as the property opcode 14
  actually reads, including that one unit is enough.

## 5. Slither

```
slither . --filter-paths "lib/"
INFO:Slither:. analyzed (1 contracts with 102 detectors), 0 result(s) found
```

Clean, with no findings to dispose of and no detectors suppressed.

## 6. Open before deployment

### 6.1 Opcode 18's argument semantics — **can stop the deployment**

Not a finding against this contract, and recorded here because this is the
document a deployer reads last.

`docs/AQUA-B3-SPEC.md` §3 settles that live Base strategies carry `op 18
argslen 64`. It does **not** settle that the two words are `sqrt(P) × 1e18`
with `P = tokenGt/tokenLt` in raw units — that comes from documentation, and
this repository's own rule (commit `c5f3dc3`, "Do not decode a threshold whose
layout is inferred") says we do not act on an inferred layout.

**`RUNBOOK.md` step 0 reads the args of a real live opcode-18 program off Base
and checks our computed bounds land in the same order of magnitude.** If they
do not, the positions fall back to plain `xycSwap` (opcode 17, zero args,
nothing to get wrong) and the tiers are shelved. Checked before the deployment,
not after.

### 6.2 Explorer verification

`forge script --verify` publishes the source on Basescan. It cannot be done
locally and is not done until the deploy runs. Until then, nobody but the
deployer can read what they are being asked to trust.

## 7. What this report does not claim

- That the *positions* are safe. This report covers 60 lines of ERC-20. The
  economic properties of a concentrated-liquidity band, the impermanent loss it
  carries, and the correctness of the sqrt prices are in STRATEGIES.md §3 and
  §6, and §6.1 above is the one that is still open.
- That the gate makes the pool safe. It makes it *narrow*. A holder of the gate
  token can still fill at any price inside the band, which is the point.
- That anything here has been exercised on mainnet. Nothing has. `forge test`
  and Slither are what has been run.
