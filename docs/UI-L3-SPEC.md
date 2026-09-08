# L3 — All-chain balances on the wallet menu

Follows UI-SPEC-V2 §2b. After connect + handshake + unlock the launcher lands on
the wallet menu, whose headline is the account and, under it, **balances across
every supported chain at once** — big, per §2e's mobile-menu look.

Efficiency over aesthetics, per the standing instruction: no timers, no
animation on the numbers, no per-chain spinner components. One batched read,
four static states.

## 1. Assets shown

The user named six: **ETH, WETH, USDC, EURC, cbBTC, HBAR**. They are not the
same kind of thing and must not be treated as one list.

- **Native** — `eth_getBalance`, no contract address. ETH on the Ethereum-family
  chains; HBAR on Hedera Testnet (296). Note **Arc Testnet (5042002)'s native
  gas token is USDC with an 18-decimal native face**, not ETH — the existing
  comment in `erc7730-circle.ts` explains it. Do not label Arc's native balance
  "ETH".
- **ERC-20** — WETH, USDC, EURC, cbBTC. Each needs a contract address *per
  chain*, and a token that has no address on a chain does not exist there.

## 2. The address matrix

**Do not invent an address.** A wrong token address on a balance screen shows
the wrong number, which is the one failure this screen exists to avoid.

USDC and EURC addresses already live in `packages/core/src/erc7730-circle.ts`
(USDC on 9 testnets, EURC on 4) — **reuse those, do not retype them.**

WETH and cbBTC are the gaps. These were verified on 2026-09-08 by
`eth_call` of `symbol()` against the chain's own RPC and are the only ones
that may be hard-coded:

| chain | id | token | address | symbol returned |
|---|---|---|---|---|
| Sepolia | 11155111 | WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | `WETH` |
| Base Sepolia | 84532 | WETH | `0x4200000000000000000000000000000000000006` | `WETH` |
| Arbitrum Sepolia | 421614 | WETH | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` | `WETH` |
| Unichain Sepolia | 1301 | WETH | `0x4200000000000000000000000000000000000006` | `WETH` |
| OP Sepolia | 11155420 | WETH | `0x4200000000000000000000000000000000000006` | `WETH` |
| Polygon Amoy | 80002 | WETH | `0x52eF3d68BaB452a294342DC3e5f464d7f610f72E` | `WETH` |
| Sepolia | 11155111 | cbBTC | `0x25554f552a72D1263a868D8BE2BC50096b2953Eb` | `cbBTC` |

**Everything not in that table has no entry**, including: WETH on Hedera, Arc,
Hoodi, BSC Testnet, Fuji and Linea Sepolia (the usual Linea WETH candidate
returned no code); cbBTC on every chain except Sepolia. The user says they hold
cbBTC on **Arc Testnet** as well, but neither the Sepolia nor the Base-mainnet
cbBTC address has code on Arc — that address is still **unknown and must be
left out** until it is supplied and verified. Leave a named `TODO` for it rather
than a plausible-looking constant.

If you add any address not in the table above, verify it first with an
`eth_call` of `symbol()` (and `decimals()`) against that chain's own RPC and
paste the result into the commit message. An address that does not answer does
not go in.

## 3. The four states

Reuse the four states UI-SPEC-V2 already defines, and reuse La Caja's existing
treatment of EURC's absence on five of nine chains rather than writing a second
one:

1. **a figure** — a number came back.
2. **`unavailable`** — the token has no address on this chain. It is *not* zero.
   Rendering a missing token as `0` tells the user they hold none of something
   that cannot be held there at all. Grey it, do not hide the row.
3. **`—`** — the read failed (RPC unreachable, call reverted). Distinct from
   both a zero and an `unavailable`; staleness is displayed, never papered over.
4. **`reading…`** — in flight.

## 4. Symbols and decimals are not facts

PROTOCOL.md 6d and the header of `balances.ts` both apply: the host cannot
verify a token's `decimals()` or `symbol()`. Every scaled figure on this screen
goes through `TokenAmountView` with `verified: false` and its notice. There is
no path here that produces a bare pretty string — that constraint is already
enforced by `balances.ts` having no function that returns one, and this screen
must not become the first.

## 5. Fetching

- Use `fetchTokenBalancesBatched()` / `encodeAggregate3` — **one multicall3 per
  chain**, not one request per token. `MULTICALL_CHUNK_SIZE` already caps it.
- Hedera (296) and Arc (5042002) should be checked for a multicall3 deployment
  via `multicall3Address()`; if the chain has none, fall back to individual
  `eth_call`s for that chain only, and do not let that chain's failure stall the
  others.
- **Chains are fetched concurrently and rendered as each settles.** One dead RPC
  must leave eleven chains showing figures and one showing `—`.
- **No polling.** Fetch on entering the wallet menu and on explicit refresh, and
  on the events `balances.ts` already names as making an old answer wrong
  (connect, chain change, address change). Honour `BALANCE_STALE_AFTER_MS` by
  *showing* staleness. Nothing refreshes while the window is hidden.

## 6. Layout

Per §2e: mobile-menu minimal. Account and its total-line headline big; the
per-chain rows quiet underneath. Chain names go through
`chainLabelDetailed()`. No new visual system — follow the existing
`.muted`/`.addr` conventions the L4 pass used.

## 7. Out of scope

Send, the QR reader, and the cascading account→chain header selector are
separate passes. Do not touch `packages/apps/**`, `apps.test.ts`, or any
firmware.

## 8. Done means

`pnpm --dir app typecheck`, `pnpm --dir app test` and `pnpm --dir app build`
all green; bundle growth under 50 KB; a test that a token with no address on a
chain renders `unavailable` and never `0`.
