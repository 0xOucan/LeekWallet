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
- Which restaurant a terminal collects for: [`src/merchant.ts`](src/merchant.ts)
- Settlement watcher: [`src/watch.ts`](src/watch.ts)

The waiter configures nothing. The terminal learns the restaurant from the
first well-formed bill it is shown, remembers it, and refuses any later bill
that pays a different address — with the address it would have paid on screen.
`merchant.ts` is explicit that this is a **misconfiguration and outsider-forgery
check, not a defence against whoever holds the terminal**: the first code
teaches it, and nothing on a till can do better, because there is no key there
to sign a policy with and the digest in a request is a checksum, not a
signature.

**Proven on three devices**: the desktop cashier issued a bill, the Android APK
scanned it, an unmodified Rabby wallet paid it, and the terminal noticed by
itself — `PAID — 2.4287 USDC received, block 46732732, 13 confirmation(s)` on
Base Sepolia, while the other eight chains reported *checked and nothing has
arrived* with their block ranges and endpoints named.

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
- Batching: [`src/disperse.ts`](src/disperse.ts)
- Example CSV: [`examples/payroll-example.csv`](examples/payroll-example.csv)

**Batched through Disperse, optionally.** Ticking *batch via Disperse* sends the
same plan as an approval, one `disperseToken` for every salary and one for every
tip — **three device confirmations whatever the headcount** instead of two per
person. Salaries and tips are still separate transactions, so the accounting
property above survives the batching. The device decodes `disperseToken` itself
and draws each recipient and amount on its own screen; a tenth recipient in one
batch is refused as a call the screen cannot hold rather than truncated.

**Demo CSV, kept out of the repository.** *Use example CSV* loads a payroll file
without a file picker, so a recorded screen never shows the folder tree. Put the
file at `example.csv` in the folder that contains the repository — beside it,
not inside it — and run `pnpm --dir app tauri dev` as usual. `LEEK_DEMO_CSV`
points it at a different file.

The dev server alone serves it (`vite.config.js`, `apply: "serve"`); a production
build never contains it. In a built app the button falls back to a copy
remembered on that machine.

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

**Executed on Arc testnet**, batched through Disperse and signed on both boards
(every transaction confirmed `status 1`):

| board | approve | salaries | tips |
|---|---|---|---|
| ESP32-S3 | [`0xa521ce6e…`](https://testnet.arcscan.app/tx/0xa521ce6e05294321f3339ab9e1ace62d2493db4a6c26eb64e84663f6adafb7b8) | [`0x31099ba2…`](https://testnet.arcscan.app/tx/0x31099ba28ee13d31ceb5bdb37b1e1c230922194d5f9743cd8065d8a92eececba) | [`0xd49a3549…`](https://testnet.arcscan.app/tx/0xd49a35491561c10eac280c866bcf10813503e677555408474611800826f01511) |
| Firefly Pixie | [`0x26b08eaf…`](https://testnet.arcscan.app/tx/0x26b08eaf63cafb291b4fe38ad79b6eb192770f427a2382632d93f420fc2823ca) | [`0xebe252d2…`](https://testnet.arcscan.app/tx/0xebe252d259d0a2786731b3fc616e3fa5f32244da0238cccda64660509803096e) | [`0xc705d3fb…`](https://testnet.arcscan.app/tx/0xc705d3fbb2641679604f72615f96bf3faecc63d3875205dbbb0d597d772c0dd8) |

The waiter terminal ran across three devices — desktop cashier, Android scanner
with no wallet on it, an unmodified Rabby paying — and detected the payment on
its own:
[`0x83f8f67c…`](https://sepolia.basescan.org/tx/0x83f8f67c7e2462cd695c0ff243493004e400e550afaf89990f4ed3428897d91f)
on Base Sepolia.
