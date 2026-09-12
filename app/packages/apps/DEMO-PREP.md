# Preparation before recording a demo

Hackathon-only, like everything else under `apps/`. Delete with the mini-apps.

## Is anything expiring?

**No, with one exception.** As of 2026-09-10 23:30 UTC:

| track | state | clock |
|---|---|---|
| Aqua (Base 8453) | position shipped, filled, docked, allowances revoked | **an Aqua position lives 2 hours.** A live demo needs a fresh ship |
| Hedera ATS (296) | 4 securities deployed, 2500 minted, market live, Listing 1 filled | none — testnet state is permanent |
| Arc payroll | **never tested end to end** | none |

Everything already done is permanent evidence on chain and can be *shown* at
any time. Only a **live** Aqua fill needs setting up first, because the
`deadline` opcode refuses every fill once the two hours are up.

## Order to record in

Record Hedera first. It has no clock, the state is already interesting, and it
gives you a warm-up before the one segment that is time-boxed.

---

## 0. Common, before any recording

```bash
cd ~/Hardware/FireflyPixie/leekwallet
pnpm --dir app tauri dev
```

- Connect and unlock the device. Do this **before** recording: the PIN entry
  and passkey compare are slow and the passkey is different every session.
- Confirm the firmware is current. There is **no build identity in the
  protocol** (`getStatus` returns wallet state, the handshake returns
  `PROTOCOL_VERSION`), so the only test is behavioural: a two-leg Aqua ship is
  676 bytes and a board with `ETH_MAX_DATA = 640` refuses it with
  `device error 0x0001`. If in doubt, `./flash-both.sh dev` — that writes only
  the app partition at `0x10000` and leaves your seed alone. Never `provision`.
- Base RPC: `mainnet.base.org` must be first in the order shown in
  Diagnostics. `base.drpc.org` cannot serve `eth_getLogs` at all (0/5 measured)
  and the portfolio scan — and therefore the **dock button** — depends on it.

---

## 1. Hedera ATS  (no time limit)

Already on chain and worth showing as-is:

- `LEEKA` `0x188fd9e330d22edd3381b21715d0a1722206b43f`, supply 2500/1000000,
  three holders (1200 / 900 / 400), twelve roles on the admin.
- Escrow market `0xcde9596fd89c5368b5bd46c2b93544cbb201f8df`, Listing 1 filled.

**Balances confirmed 2026-09-10:** deployer 423.6 HBAR / 400 LEEKA,
device 200 HBAR / 1200 LEEKA. Enough for several listings and fills.

What the **companion** can do, live, from the device: `mint`, `grantRole`,
`revokeRole`, `revokeKyc`, `pause`/`unpause`, `freezePartialTokens`,
`setAddressFrozen`, `lock`, `setMaxSupply`, control-list add/remove,
`takeSnapshot`, `setDividend`, and list/buy on the secondary market.

What it **cannot**: deploy a new equity or bond. That is the factory script in
`docs/ATS.md`, deliberately — issuing a security is not a wallet operation.
If the demo needs a fresh deployment, run the script BEFORE recording and show
the console reading the result.

### To have a fillable listing on camera

Listing 1 is already filled, so create a new one first (~2 min):

1. Secondary market → **Sell into the market**. Shares in raw units (6
   decimals: `100000000` = 100 shares), price in **HBAR** for the WHOLE lot.
2. Plan the sale, approve on the device. The shares move into escrow.
3. Leave it unfilled. Fill it on camera from the other account.

### The refusal demo, if you want it

Freeze the buyer (`setAddressFrozen`), attempt the fill, watch it revert, then
unfreeze and let it settle. The market deliberately does **not** pre-check
compliance: it attempts both transfers and lets the security's own rules revert
them. That is the point — the refusal comes from the security, not the market.
It costs the buyer gas, so say so on camera.

---

## 1b. HashScan verification — DONE for the market

`AtsEscrowMarket` `0xcde9596fd89c5368b5bd46c2b93544cbb201f8df` is verified on
Sourcify for chain 296 (match + runtimeMatch, 2026-09-11), which is what
HashScan reads. The Tokenization track lists "contracts verified on HashScan
where applicable" as a qualification requirement, so this is one of them met.

```bash
# The command that did it, for the next contract:
forge verify-contract <ADDRESS> src/<File>.sol:<Contract> \
  --chain-id 296 --verifier sourcify --verifier-url "https://sourcify.dev/server" \
  --constructor-args $(cast abi-encode "constructor(address)" <ARG>)
# then poll the job URL it prints, or:
curl -s "https://sourcify.dev/server/v2/contract/296/<ADDRESS>"
```

`LeekSecurityFactory` needs the same treatment once deployed. Its constructor
is `(address factory, address resolver)`.

---

## 2. Aqua on Base  (2-hour window — do this LAST, or immediately before)

A fresh position is required; the docked one cannot be filled again.

1. Re-check ETH spot. Plan with a mid within ~30% of it, or the band sits off
   the market and the position is an arbitrage gift (RUNBOOK step 3).
2. Companion → Aqua → **Ship a position**. Human units, not raw:
   WETH `0.000406168`, USDC `1`, mid `2462`, fee `0.30`, 2 hours, gate
   `0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b`.
3. **Check the band reads ~1723 to 3517 USDC per WETH.** This is the only
   check that catches a decimals error.
4. Ship. Then record.
5. For the fill, RUNBOOK step 7 — the signature and the 22-byte traits there
   are verified against a real fill, so follow it exactly.
6. Dock afterwards and revoke, on camera if you like: it is the half of DeFi
   nobody demos.

**Pause a few seconds between device confirmations.** Approvals outrun the
RPC's view of the nonce and you get `nonce too low`.

### Building the Aqua demo environment from scratch

If the wallets are ever emptied or you demo from a different device, this is
the whole environment. Nothing here is optional: each line was a failure first.

**Addresses.** Maker is the DEVICE (it must be, or the strategy names a maker
the device will refuse). Taker is a second funded EOA in your Foundry keystore.

```bash
export BASE_RPC=https://mainnet.base.org   # NOT drpc: 0/5 on eth_getLogs
export MAKER=<device address>
export DEPLOYER=<taker address>
export REGISTRY=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
export ROUTER=0x111111338c5091e8440b67b168bae16a668ac0de
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
export WETH=0x4200000000000000000000000000000000000006
export CBBTC=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
```

**Funding.** Small absolute amounts; the demo is about mechanism, not size.

| account | needs | why |
|---|---|---|
| maker (device) | ~0.002 ETH, 2.5 USDC, 0.004 WETH | gas, plus both legs of a two-sided position |
| taker | ~0.005 ETH, 4 USDC | gas, plus the fill. It pays USDC in both directions, so it needs no WETH |

**Gate token.** The gate is opcode 14: only an address holding a non-zero
balance of the gate token can fill. The TAKER holds it, the maker does not.
`LWGATE` is already deployed at `0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b`
(taker 1000, maker 0) and is **verified on Basescan and Sourcify** -- worth
showing on camera, because it is the one place the position's
"permissionless" claim needs a qualifier and the source is how a viewer checks
it rather than believing us. Redeploy only if you change takers:
`forge script script/DeployGateToken.s.sol --rpc-url "$BASE_RPC" --account <key> --broadcast`

**Firmware.** A two-leg ship is 676 bytes of calldata. A board flashed before
2026-09-10 has `ETH_MAX_DATA = 640` and refuses it with `device error 0x0001`.
There is no version string in the protocol, so the only check is behavioural —
if the ship is refused for size, reflash with `./flash-both.sh dev`.

**Sequence, roughly 15 minutes.**

1. Ship from the companion (Aqua -> Ship a position). Human units. Check the
   band line against a price you know.
2. Verify from chain, never from the UI:
   `cast receipt "$TX" --rpc-url "$BASE_RPC" --json | jq -r '.logs[].topics[0]'`
   expect one `Shipped` `0xdc3622e0…` and one `Pushed` `0x3f18354a…` per leg.
3. Approve the taker's USDC **to the ROUTER**, not the registry.
4. `quote`, then `swap` — runbook step 7, whose signature and 22-byte traits
   are verified against a real fill.
5. Dock, then revoke both allowances.

**What will bite you, in order of likelihood.** All of these happened:

- `quote` returns a clean price for a swap that cannot execute. It validates
  the program, not the ability to pay. Gas estimation is the real check.
- `nonce too low` between device confirmations. Wait a few seconds.
- The portfolio scan fails and with it the DOCK BUTTON, because the dock UI is
  built from the scan. Base must have `mainnet.base.org` first in the RPC
  order.
- A stale mid price puts spot outside the band, turning the position into free
  arbitrage. Re-check spot every time.

---

## 3. Arc payroll  — TEST BEFORE RECORDING

**Not yet exercised end to end.** Do a full dry run on testnet before any
camera: CSV import, the salary/tips split into two transactions per employee,
and a multi-send of USDC/EURC/cirBTC.

cirBTC exists on **Arc testnet and Ethereum Sepolia only**. It is Circle
Wrapped Bitcoin and is NOT cbBTC — different token, different address.

---

## What to have on screen as evidence

| | |
|---|---|
| Aqua ship (676 B) | `0x8eba6a313f13f0c8a77ea1354279d8ef458b445031fb2629ecf23b85c1439241` |
| Aqua fill | `0x8478c356986936ee50ee8375dfece2610b16036af772c4ce8545049ce4028da6` |
| Aqua dock | `0x274877aa875599d892dc870973e8258004d28ee34508ed1fb7aa599865385d42` |
| strategy hash | `0x0074090ac9b076e231e297eb66b86b5825483bda916b388edf13024a3b6d7112` |

The fill moved 0.230594 USDC against 0.00009 WETH at 2,562 USDC/WETH, with
spot at 2,462 — the maker earned the spread plus a 0.30% fee, and the virtual
credits and the real ERC-20 transfers agree to the unit.
