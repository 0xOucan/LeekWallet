# La Caja — Arc payments and payroll, from a hardware wallet

A LeekWallet mini-app for taking stablecoin payments and running payroll on
**Arc**, Circle's L1, with USDC, EURC and cirBTC. Every transfer is rendered on
an ESP32 screen and approved there.

Sponsor: **Arc — Best DeFi / Onchain Finance Application (Continuity Track)**.


**[Architecture diagram →](../../../../docs/ARCHITECTURE.md)** — how a transaction reaches the device,
and which part of the system is trusted.

---

## Two halves

### 1. La Caja — the till

Point-of-sale that needs **no wallet on the customer's side and no wallet on
the waiter's side**. The waiter runs a scanner; the till builds a payment
request; the customer pays from whatever they already use.

- Request building and EIP-681 URIs: [`src/uri.ts`](src/uri.ts), [`src/request.ts`](src/request.ts)
- Waiter mode, reachable **before** any device is connected: [`src/waiter.ts`](src/waiter.ts)
- Settlement watcher: [`src/watch.ts`](src/watch.ts)

The economics are stated in [`src/rails.ts`](src/rails.ts) rather than implied: Mexican card
acquiring is 3.5% + IVA = **4.06%**; ours is gas. On Arc that is a rounding
error, which is the actual argument for stablecoin-native rails.

### 2. Payroll — multi-send with accountability

Import a CSV of staff, then pay them. The distinguishing choice: **salary and
tips go out as two separate transactions per employee**, never netted into one.

That is not a technical constraint, it is an accounting one — in a restaurant,
tips are not wages, they are frequently owed to a pool, taxed differently, and
disputed separately. One transaction carrying both is a number nobody can
reconcile afterwards. Two transactions are two lines in a ledger.

- Parser and plan: [`src/payroll.ts`](src/payroll.ts) · [`src/staff.ts`](src/staff.ts)
- Example CSV: [`examples/payroll-example.csv`](examples/payroll-example.csv)

**The CSV parser is treated as a security boundary**, because it is: a payroll
file is attacker-controlled input that ends in a transfer amount. It refuses
rather than coerces, and the shape of an accepted field is pinned by a regex
with tests behind it.

## Tokens and chains

`USDC`, `EURC` and `cirBTC` — [`PAYROLL_TOKENS`](src/payroll.ts).

Addresses come from Circle's own published deployment data, not from us, so a
chain that gains EURC gains it here by updating that table rather than by
someone typing an address. Where Circle lists no EURC, the entry is `null` and
the app says the token is unavailable on that chain instead of guessing.

**cirBTC is Circle Wrapped Bitcoin and exists on Arc testnet and Ethereum
Sepolia only.** It is **not** cbBTC — a different token with a different
address, on different chains. That distinction cost this project a round of
corrections and is worth stating plainly.

Arc Testnet is chain **5042002**, and its native gas unit is **USDC with 18
decimals** — not ether, and not the 6 decimals USDC has as an ERC-20 elsewhere.
That asymmetry is handled explicitly in [`src/rails.ts`](src/rails.ts); assuming it away is how a
gas estimate lands a million times off.

## No contracts

This app deploys nothing and calls no contract of ours. It composes ERC-20
transfers of tokens Circle already deployed. There is therefore nothing here to
verify on an explorer, and nothing to audit beyond the CSV boundary and the
transfer construction — which is the point: **the trust is in the device
screen, not in a contract we wrote.**

## Key files

| | |
|---|---|
| [`src/rails.ts`](src/rails.ts) | chains, tokens, decimals, and the cost argument |
| [`src/payroll.ts`](src/payroll.ts) | the payroll plan, salary and tips kept apart |
| [`src/staff.ts`](src/staff.ts) | CSV parsing as a security boundary |
| [`src/order.ts`](src/order.ts) | the till's order model |
| [`src/waiter.ts`](src/waiter.ts) | waiter mode, no wallet required |
| [`src/watch.ts`](src/watch.ts) | watching for settlement |

## Run the tests

```bash
pnpm --dir app/packages/apps/till test     # 13 suites
```

## Status

The code and its tests are complete. **End-to-end execution on Arc testnet has
not yet been recorded** as of 2026-09-11 — unlike Aqua and ATS, this app has no
on-chain transaction to point at yet. Stated here rather than left to be
discovered.
