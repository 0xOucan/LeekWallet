# LeekSecurityFactory — audit report

Contract: `src/LeekSecurityFactory.sol` · Solidity 0.8.30 · Cancun
Deployed: `0x3a56974075d734aFa5BF7f63e34F9C3237408AeD` on Hedera testnet (296)
Superseded deployment: `0x8E091117e82500Cab2d44991ceD7D3D49A343635` — non-functional, see C-1
Verification: sourcify **exact_match** (runtime `exact_match`)
Reviewed **2026-09-11** against the ethskills
[security](https://ethskills.com/security/SKILL.md) and
[audit](https://ethskills.com/audit/SKILL.md) skills.

**Status: C-1 RESOLVED 2026-09-11 by redeployment.** No open findings. No
fund-loss finding at any point. Slither: 6 results, all Informational or Low,
none in a security-relevant path.

---

## 1. Scope and skill routing

Per the audit skill's routing table, the contract's features select these
domains:

| feature | domain loaded |
|---|---|
| every contract | `evm-audit-general`, `evm-audit-precision-math` |
| roles, ownership, permissionless entry point | `evm-audit-access-control` |
| non-mainnet deployment (Hedera) | `evm-audit-chain-specific` |
| loops over roles and over string bytes | `evm-audit-dos` |
| creates contracts through an external factory | `evm-audit-general` (delegate/external-call sections) |

**Deliberately NOT loaded, and why:** `evm-audit-erc20` — the contract never
holds, transfers or approves a token; `evm-audit-proxies` — it is not a proxy
and is not upgradeable; `evm-audit-signatures` — no signatures, permits or
meta-transactions; `evm-audit-oracles` — no prices; `evm-audit-erc4626`,
`-defi-*`, `-flashloans` — no vault, pool, pricing or borrowing; `-assembly` —
no inline assembly, no CREATE2 in our code; `-erc721`, `-governance`,
`-bridges`, `-erc4337` — not applicable.

## 2. What the contract is

A template wrapper. `IAtsFactory.deployEquity` takes a seventeen-field nested
struct and 3,748 bytes of calldata; the LeekWallet device holds `ETH_MAX_DATA`
(768) and refuses more. This contract freezes the template that
`script/DeploySecurities.s.sol` already used and exposes:

```solidity
deployEquity(string name, string symbol) returns (address)   // 196 bytes
deployBond(string name, string symbol)   returns (address)   // 196 bytes
```

It holds **no tokens, no roles, no funds and no owner**, and has no upgrade
path. There is nothing in it to steal and nothing to seize.

---

## 3. Findings

### [C-1] A Hedera long-zero address is not callable from a contract
**Severity**: High (availability; no fund risk)
**Category**: evm-audit-chain-specific
**Location**: the `FACTORY` immutable, set at construction
**Status**: **RESOLVED 2026-09-11** — redeployed at
`0x3a56974075d734aFa5BF7f63e34F9C3237408AeD`

The first deployment set `FACTORY` to `0x00000000000000000000000000000000008c95cF`,
the ATS factory's Hedera **long-zero** address: twelve zero bytes followed by
the entity number. Every `cast call` and every deploy script in this repository
used that form successfully, because the JSON-RPC relay resolves it for a
top-level call. **It does not resolve for a contract-to-contract call.**

Inside the EVM the wrapper's call to it was treated as a call to a
non-existent account. The mirror-node action trace of the failed transaction
`0x72f828b7…` is unambiguous:

```
depth=0  EOA → wrapper          gas_used 61063  REVERT_REASON  0x
depth=1  wrapper → 0x…008c95cF  gas_used 0      OUTPUT         0x
         recipient: null
```

A call to an address with no code returns **success with empty output**. Solidity
then decoded an `address` from empty returndata and reverted — with no revert
data, which is why the failure was opaque from every angle above the trace.

**The correct address is the contract's EVM alias**,
`0xd1F118A40f3b02883D35909eF2517e7EDd78379d`, from the mirror node at
`/api/v1/contracts/0.0.9213391` → `evm_address`. Both addresses hold identical
code; only the alias is callable from another contract.

**Why this took so long to find, recorded because the reasoning was wrong
twice.** The empty revert data was first read as evidence *against* the ISIN
validator, since `WrongISIN(string)` carries data — but Hedera's relay routinely
returns `data: "0x"` regardless, so that inference was unsound. The second wrong
hypothesis was Hedera's gas estimator, which this project had already been
bitten by twice; `gasUsed = 83,171` against ~8,034,068 for a working deploy
killed it. What settled it was the action trace, not reasoning from symptoms.

Two experiments bounded the problem before the trace was read, and both remain
valid:

- EOA → factory **directly**, with this contract's exact template and its
  generated ISIN `ZZ0000000008`, **succeeds** — so the parameters, the roles,
  the regulation data and the ISIN were never at fault.
- The identical wrapper call **succeeds in Foundry's local EVM**, where
  long-zero addresses are ordinary addresses with code. A local fork cannot
  reproduce this class of bug at all, which is worth knowing before trusting one.

**Fix, and the guard against recurrence.** `DEFAULT_FACTORY` in
`script/DeployLeekSecurityFactory.s.sol` is now the alias, and the script
**refuses any address with twelve leading zero bytes**, naming the mirror-node
field to look up. `FACTORY` is `immutable`, so the fix required a redeploy; the
superseded contract remains on chain, verified, as the exhibit for this finding.

**Generalisation worth carrying:** on Hedera, any address taken from a block
explorer, a relay call or another script may be a long-zero form. It is safe to
call from an EOA and unsafe to store in a contract. Prefer the mirror node's
`evm_address` for anything a contract will call.

### [L-1] Events are emitted after the external call
**Severity**: Low
**Category**: evm-audit-general (reentrancy-events)
**Location**: `deployEquity()` L189, `deployBond()` L231
**Status**: Accepted

Slither flags `EquityDeployed` / `BondDeployed` being emitted after
`FACTORY.deploy*`. A re-entering factory could interleave events.

**Why it is accepted:** the event must carry the deployed address, which does
not exist until the call returns, so it cannot precede it. More importantly the
*state* ordering is already correct: `_serial` is consumed **before** the
external call (checks-effects-interactions), so a re-entrant factory cannot mint
two securities under one ISIN. `FACTORY` is `immutable` and is the audited ATS
factory, not caller-supplied. Event ordering alone carries no value.

### [L-2] ISIN serials are per-wrapper, not global
**Severity**: Low
**Category**: evm-audit-general
**Status**: Accepted, documented

`_isin()` derives from a per-contract `_serial`, so two deployments of this
wrapper would issue the same ISIN sequence, and the ATS factory does not
enforce ISIN uniqueness. The `ZZ` prefix is not an allocated ISO 3166 country
code, so nothing generated here can collide with or be mistaken for a real
security — which is the property that matters. Duplicate ISINs across two
wrappers would be a bookkeeping nuisance on a testnet demonstration, not a
security issue.

### [I-1] `checkDigit`'s `sum` is not explicitly initialised
**Severity**: Informational
**Category**: evm-audit-general (Slither `uninitialized-local`)
**Status**: Not fixed — deliberately

`uint256 sum;` is zero-initialised by the language; Slither flags the absence of
an explicit `= 0`. Behaviour is correct and is pinned by tests against **two
published ISINs** (Apple `US0378331005`, BAE `GB0002634946`), and by the live
contract returning 5 for Apple's digit string via `eth_call`.

**Not fixed because the contract is deployed and verified `exact_match`.**
Editing the source would invalidate that verification and require a redeploy,
which is not warranted for a style-level finding with no behavioural effect. If
the contract is ever redeployed for another reason, add the initialiser then.

### [I-2] Immutables are UPPER_CASE
**Severity**: Informational
**Category**: naming-convention
**Status**: Not fixed — matches the codebase and Solidity convention for
immutables. Same redeploy argument as I-1.

### [I-3] Slither's `timestamp` detector on `bond == address(0)`
**Severity**: Informational — **false positive**

Slither reports a "dangerous timestamp comparison" and then names
`bond == address(0)`, which is an address check. The heuristic fires because
`block.timestamp` is used elsewhere in the same function (for `startingDate` /
`maturityDate`). No action.

---

## 4. Checklist results, by domain

### Access control (`evm-audit-access-control`)

- **Permissionless `deployEquity` / `deployBond` — deliberate.** Every one of
  the twelve roles goes to `msg.sender`; the wrapper grants itself none. A
  caller therefore receives authority over the security they just created and
  over **nothing else**. An access list would add an admin key that can be lost
  or abused, to gate an operation that costs the caller gas and affects only the
  caller. Asserted by `test_factoryContractHoldsNoRole`.
- **No owner, no `Ownable`, no pause, no upgrade path.** Nothing to seize, no
  2-step transfer needed, no admin overpower.
- `FACTORY` and `RESOLVER` are `immutable`, validated non-zero in the
  constructor, and the deploy script additionally asserts `FACTORY.code.length > 0`.

### Precision & math (`evm-audit-precision-math`)

- `MAX_SUPPLY_SHARES * (10 ** DECIMALS)` = 1e6 × 1e6 = 1e12 — constant, no
  overflow, no user input, no division anywhere.
- No division-before-multiplication: the only division is `% 10` and `/ 10` in
  the ISIN check digit, on values bounded by 9×2.
- **Decimals are fixed at 6, not read from anywhere.** A per-call decimals
  field is exactly the kind of invisible number this design exists to keep off
  the screen.
- No downcast that can truncate: `uint8(len)` is guarded by `len > MAX_*` checks
  first; `uint16(offset)` holds offsets bounded by a 196-byte calldata.

### Denial of service (`evm-audit-dos`)

- **No unbounded loops.** The role loop is exactly 12; the ISIN loops are
  exactly 9 and 13 iterations. Both are compile-time constants.
- Name and symbol are bounded at 64 and 12 bytes, so calldata and gas are
  bounded by construction.
- No `selfdestruct` force-send surface (the contract holds no balance and no
  balance-dependent logic), no return-data bomb (the factory's return value is a
  single `address`).

### ERC-20 (not loaded — and why that is safe)

The contract **never** calls `transfer`, `transferFrom`, `approve` or
`balanceOf`, holds no token and grants no allowance. Fee-on-transfer, rebasing,
ERC-777 hooks, approve races and deny-lists are all inapplicable. This is worth
stating rather than omitting: it is the single largest class of finding that
does not apply here, and it does not apply because the contract was scoped not
to touch tokens.

### Reentrancy

Checks-effects-interactions is observed: `_serial` is read and incremented
**before** the external call, so a re-entrant factory cannot reuse an ISIN. No
`ReentrancyGuard` is added because there is no state a second entry could
corrupt and no value to drain — the contract holds nothing.

---

## 5. Tool output

```
slither src/LeekSecurityFactory.sol --solc-remaps "…"
  uninitialized-local   1   (I-1, false positive in effect)
  reentrancy-events     2   (L-1, accepted)
  timestamp             1   (I-3, false positive)
  naming-convention     2   (I-2)
  → 6 result(s), 0 Medium or above
```

Slither 0.11.6. `forge test --match-path test/LeekSecurityFactory.t.sol` — **25
passing**, including the two published-ISIN check-digit vectors and
`test_calldataFitsTheHardwareWallet`.

## 6. What this audit does not cover

- **The ATS factory and the securities it deploys.** Those are Hedera's
  contracts; Hedera publishes its own `Smart Contracts Audit Report.pdf` in the
  [ATS repository](https://github.com/hashgraph/asset-tokenization-studio). We
  verified the four deployed securities are byte-for-byte the published
  `ResolverProxy`, which is an integrity check, not an audit of their logic.
- **The ATS SDK** — not used by this project at all. The
  `@hashgraph/asset-tokenization-contracts` package is a devDependency used as
  read-only ABI artifacts, asserted by `test/abi.test.ts`; no SDK code runs.
- **C-1's root cause**, which is open and needs a real transaction to settle.
- This is a **self-audit against published checklists**, not an independent
  review. It is testnet software.
