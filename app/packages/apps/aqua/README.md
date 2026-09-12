# Aqua — 1inch Aqua / SwapVM, from a hardware wallet

A LeekWallet mini-app that authors, ships, monitors, fills and docks **1inch
Aqua** positions on **Base mainnet**, with every transaction rendered page by
page on an ESP32 device and approved there. Blind signing is off.

Sponsor: **1inch — Build an Aqua App (Continuity Track)**.


**[Architecture diagram →](../../../../docs/ARCHITECTURE.md)** — how a transaction reaches the device,
and which part of the system is trusted.

---

## What it does

| | |
|---|---|
| **Author a position** | Pick a pair and a risk tier, type a mid price, and the app builds the SwapVM program. The band is read back **in the units you typed**, which is the only check that catches a decimals error. |
| **Ship it** | A capped `approve` plus `ship`, as one plan, with the approval capped at the position's own amount — never unlimited. |
| **Monitor funding** | Aqua quotes from *virtual* balances and does not check your real balance or allowance, so a credited position can revert on every fill. The app draws that comparison and shows an under-funded position in the danger tone. |
| **Dock and revoke** | Docking ends the authority; revoking the allowance is a separate act, and the app says so, because docking does not touch it. |
| **DCA / TWAP** | Implemented and shippable. **Not demonstrated** — see below. |

## Official contracts, not redeployments

| | |
|---|---|
| Aqua registry | [`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`](https://basescan.org/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) |
| SwapVM router | [`0x111111338c5091e8440b67b168bae16a668ac0de`](https://basescan.org/address/0x111111338c5091e8440b67b168bae16a668ac0de) |
| SDK | [`@1inch/aqua-sdk`](https://www.npmjs.com/package/@1inch/aqua-sdk) `0.3.1`, as a **parity oracle** — see [`test/sdk-parity.test.ts`](test/sdk-parity.test.ts) |

The SDK is a devDependency used to prove our encoders agree with 1inch's byte
for byte, at every leg count, rather than being trusted at runtime. Our
strategy hash, topics and registry address are all asserted to be the SDK's.

## On-chain execution — the full lifecycle, Base mainnet

Every step signed on the device.

| step | transaction |
|---|---|
| Ship (676 B of calldata) | [`0x8eba6a31…`](https://basescan.org/tx/0x8eba6a313f13f0c8a77ea1354279d8ef458b445031fb2629ecf23b85c1439241) |
| Fill | [`0x8478c356…`](https://basescan.org/tx/0x8478c356986936ee50ee8375dfece2610b16036af772c4ce8545049ce4028da6) |
| Dock | [`0x274877aa…`](https://basescan.org/tx/0x274877aa875599d892dc870973e8258004d28ee34508ed1fb7aa599865385d42) |
| Revoke ×2 | [`0x0566325e…`](https://basescan.org/tx/0x0566325ebb09a6ac001d8d303c54c84fee6eaf2ae334e3a624ec0a8aaa369523), [`0x23573ec5…`](https://basescan.org/tx/0x23573ec5eb0b599c22af31336be57597f4772a17569883670d1a580e943cecb6) |

Strategy hash `0x0074090ac9b076e231e297eb66b86b5825483bda916b388edf13024a3b6d7112`.
One `Shipped`, two `Pushed` — a two-sided position. The fill moved **0.230594
USDC against 0.00009 WETH at 2,562 USDC/WETH** with spot at 2,462: the maker
earned the spread plus the 0.30% fee, and the registry's virtual credits and
the real ERC-20 transfers agree to the unit.

## SwapVM

The device decodes the SwapVM program itself and draws **one page per
instruction, in program order**. A program it cannot read in full refuses the
**whole** ship — there is no state where the legs are shown beside a program
the device gave up on.

- Opcode table and decoder: [`src/program.ts`](src/program.ts) · firmware side in [`../../../../src/eth-decode.c`](../../../../src/eth-decode.c)
- Spec: [`docs/AQUA-B3-SPEC.md`](../../../../docs/AQUA-B3-SPEC.md)

The opcode table is **dense indices, established empirically against live Base
strategies** — an earlier reading taken from the source at commit `4918338`
produced an enum-ordered table that refused every real strategy. The mirror
vectors now compare decoded programs instruction by instruction, not merely
accept/refuse, because comparing only "accepted" is exactly how the wrong table
passed review the first time.

## DCA / TWAP — implemented, not demonstrated (as of 2026-09-11)

**`TWAPSwap.sol` does not exist in [`1inch/swap-vm`](https://github.com/1inch/swap-vm) at HEAD.** `grep -rni twap` over that
repository returns zero hits, so 1inch's own TWAP documentation describes source
that is not in the public repo. There was nothing to port, and `_twap` belongs
to the limit-order router rather than the Aqua router.

So [`src/dca.ts`](src/dca.ts) ships an **attended** off-chain keeper instead: each tranche is
prepared and approved individually on the device. `attended: true` is a field
on the plan with a test behind it, and the "unproven" notice is likewise a
tested field, so neither can silently disappear from the UI.

**If 1inch deploys a TWAP instruction to Base before or during the judging
window, this section is out of date and the code is ready to use it.** It is
dated deliberately.

## The two authoring forms, and which one you want

The Aqua panel shows **two** ways to create a position. They are not
alternatives of equal standing, and it is worth knowing which is which.

### "Ship a position" — the one to use

Pick a pair, pick a risk tier, type a mid price. The app assembles the SwapVM
program for you, reads the band back **in the units you typed**, checks each leg
against the wallet's real balance, and refuses a leg it cannot fund. Everything
demonstrated on Base mainnet was shipped from this form.

Code: [`src/tier-plan.ts`](src/tier-plan.ts) (the pure planner) and
[`src/author-view.ts`](src/author-view.ts) (the form).

### "Deploy a position" — the raw path

This is the escape hatch: `Aqua app`, `Strategy config` (a raw 32-byte word),
`Strategy program` (raw SwapVM bytecode), and up to four `Token` / `Provide`
pairs. Nothing is assembled for you — you are handing the registry bytes you
built elsewhere.

It exists because the tier form deliberately only knows three bands on two
pairs, and SwapVM can express far more than that. Modifying opcodes or defining
your own instruction — which the 1inch track explicitly allows — produces a
program the tier form has no vocabulary for, and this is where you ship it. It
is also how a program is tested against the **device** before any UI exists for
it: paste the bytes, and the firmware either draws every instruction or refuses
the whole ship.

The four token rows are the registry's own shape: a strategy may be credited
with up to four tokens, each with its own amount, and `ETH_AQUA_MAX_LEGS` in the
firmware bounds what the device will draw.

**What it does not do for you:** there is no band read-back, because it does not
know what your program means; no tier; and no balance check beyond the refusals
in [`src/deploy.ts`](src/deploy.ts). The safety that remains is the safety that
matters — the approval is still capped and never unlimited, the strategy must
still name **this** wallet as maker or it is refused outright, and the device
still refuses a program it cannot decode in full. But a mid price you cannot see
is a mid price nobody checked, so use the tier form unless you specifically need
this one.

Code: [`src/manage.ts`](src/manage.ts).

## Key files

| | |
|---|---|
| [`src/program.ts`](src/program.ts) | SwapVM bytecode decoder, settled opcode table |
| [`src/authoring.ts`](src/authoring.ts) | risk tiers, band maths, program assembly |
| [`src/tier-plan.ts`](src/tier-plan.ts) | pure planner: refuses a leg larger than the balance, names what is missing |
| [`src/manage.ts`](src/manage.ts) | the raw "Deploy a position" form, and dock |
| [`src/deploy.ts`](src/deploy.ts) | capped approvals; refuses to encode an unlimited one |
| [`src/funding.ts`](src/funding.ts) | virtual credit vs real balance and allowance |
| [`src/positions.ts`](src/positions.ts) | chunked, retried, **all-or-nothing** log scan |
| [`src/withdraw.ts`](src/withdraw.ts) | dock, and the revoke that docking does not do |
| [`src/dca.ts`](src/dca.ts) | attended DCA schedule |
| [`contracts/RUNBOOK.md`](contracts/RUNBOOK.md) | the operational runbook, corrected against real failures |
| [`contracts/src/GateToken.sol`](contracts/src/GateToken.sol) | the gate token (opcode 14) that keeps a position off bots |

## Run the tests

```bash
pnpm --dir app/packages/apps/aqua test
```

Eleven suites, including SDK parity and the firmware-mirror vectors.
