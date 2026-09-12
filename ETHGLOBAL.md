# ETHGlobal — Continuity Track

**LeekWallet** — a DIY open-source hardware wallet, and the companion suite that
makes it usable as a hot wallet, a browser extension and a phone app.

This file is the submission index. Each mini-app has its own README with the
sponsor detail; this page says what was built, which track it answers, and
where the code is.

Repository: <https://github.com/0xOucan/LeekWallet> · Licence: Apache-2.0
Last updated **2026-09-11**.

---

## Why the Continuity Track

LeekWallet is not new. The first commit is **2026-08-12**
(`b97b51f Add LeekWallet ESP32-S3 hardware wallet firmware`), months before this
event, and the git history is continuous rather than a single drop on the final
day. We are therefore in the **Continuity Track** on every sponsor that offers
one, and the qualification that matters — *substantive new work completed during
this event, not polish and bug fixes* — is what the rest of this file is about.

On Hedera specifically: the Hedera Discord confirmed that a project with no
prior Hedera code may join the Continuity Track by **integrating Hedera into an
existing project**. That is exactly what happened here.

### What existed before this event

The device and its safety model: ESP32-S3 and Firefly Pixie (ESP32-C3)
firmware, BIP39/32/44 with AES-256-CBC storage, the BLE and USB transport, the
JSON-RPC protocol with its permission tiers, the encrypted session and passkey
handshake, EIP-191/712 signing, the ERC-7730 descriptor engine, the host test
harness, and the companion shell.

### What is new, built during this event

- **Aqua / SwapVM mini-app** — a full position lifecycle on Base mainnet, with a firmware SwapVM program decoder
- **Hedera ATS mini-app** — four securities, a secondary market, and issuance from the device
- **`LeekSecurityFactory`** — a new contract that makes ATS issuance signable on a 240×240 screen
- **Arc payments and payroll mini-app**
- **Firmware decoders** for Aqua `ship`/`dock`, ATS `deployEquity`/`deployBond`/`list`/`fill`/`cancel`, and Disperse `disperseToken`
- **Batched payroll through the canonical Disperse contract** — a payday is three confirmations instead of two per person, and the device draws every recipient itself
- **Shared firmware↔host calldata vectors** — now 60, 31 of them refusals, closing a drift gap the repo had documented against itself
- **A waiter terminal that needs no wallet at all**, proven across three devices: desktop cashier, Android scanner, and an unmodified Rabby paying the bill
- **The Chrome extension made to work** — it shipped broken in the previous tag, and the cause was a wire-format mismatch nobody could have found without hardware
- **A collapsible companion shell**, replacing push-and-Back navigation

---

## The three mini-apps

| app | sponsor | track | on-chain |
|---|---|---|---|
| [**Aqua**](app/packages/apps/aqua/README.md) | 1inch | Build an Aqua App — Continuity | **Base mainnet**, full lifecycle |
| [**ATS**](app/packages/apps/ats/README.md) | Hedera | Tokenization of Anything — Continuity | **Hedera testnet**, 6 verified contracts |
| [**La Caja**](app/packages/apps/till/README.md) | Arc / Circle | Best DeFi or Agentic Application — Continuity | code complete, execution not yet recorded |

---

## 1inch — Aqua

**[Full README →](app/packages/apps/aqua/README.md)**

Official contracts, not redeployments: registry
[`0x1111113ccf…`](https://basescan.org/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a),
SwapVM router
[`0x111111338c…`](https://basescan.org/address/0x111111338c5091e8440b67b168bae16a668ac0de).
[`@1inch/aqua-sdk`](https://www.npmjs.com/package/@1inch/aqua-sdk) `0.3.1` is used as a **parity oracle** —
[`test/sdk-parity.test.ts`](app/packages/apps/aqua/test/sdk-parity.test.ts)
asserts our encoders agree with 1inch's byte for byte, rather than trusting
either at runtime.

**Onchain execution of token transfers**, as the track requires — all signed on
the device, all on Base mainnet:

| step | tx |
|---|---|
| Ship | [`0x8eba6a31…`](https://basescan.org/tx/0x8eba6a313f13f0c8a77ea1354279d8ef458b445031fb2629ecf23b85c1439241) |
| Fill | [`0x8478c356…`](https://basescan.org/tx/0x8478c356986936ee50ee8375dfece2610b16036af772c4ce8545049ce4028da6) |
| Dock | [`0x274877aa…`](https://basescan.org/tx/0x274877aa875599d892dc870973e8258004d28ee34508ed1fb7aa599865385d42) |

**The one contract we deployed is verified:** `GateToken` at
[`0x8ed185f9…`](https://basescan.org/address/0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b#code)
on Basescan *and* Sourcify. Aqua's registry and SwapVM router are 1inch's own
deployments, which is what the track requires — we redeployed neither.

**SwapVM is used, and used on the device.** The firmware decodes the program and
draws one page per instruction in program order
([`src/eth-decode.c`](src/eth-decode.c),
[`src/program.ts`](app/packages/apps/aqua/src/program.ts),
spec in [`docs/AQUA-B3-SPEC.md`](docs/AQUA-B3-SPEC.md)). A program it cannot read
in full refuses the whole ship.

### DCA / TWAP — implemented, not demonstrated (2026-09-11)

**`TWAPSwap.sol` does not exist in [`1inch/swap-vm`](https://github.com/1inch/swap-vm) at HEAD** — `grep -rni twap`
returns zero hits, so 1inch's own TWAP documentation describes source that is
not in the public repository, and `_twap` belongs to the limit-order router
rather than the Aqua router. There was nothing to port.

[`src/dca.ts`](app/packages/apps/aqua/src/dca.ts) therefore ships an **attended**
off-chain keeper: each tranche is prepared and approved individually on the
device. `attended: true` and the unproven notice are **fields with tests**, so
neither can silently vanish from the UI.

This is dated on purpose: **if 1inch deploys a TWAP instruction to Base before
or during judging, this paragraph is out of date and the code is ready for it.**

---

## Hedera — Asset Tokenization Studio

**[Full README →](app/packages/apps/ats/README.md)**

Built on the ATS **contracts** — which the track explicitly allows alongside the
SDK and the web app. [`@hashgraph/asset-tokenization-contracts@8.0.0`](https://www.npmjs.com/package/@hashgraph/asset-tokenization-contracts) is the source
of truth for every ABI, role hash and selector, asserted by
[`test/abi.test.ts`](app/packages/apps/ats/test/abi.test.ts).

**All six contracts verified**, as the track requires:

| contract | address |
|---|---|
| LeekSecurityFactory (**exact_match**) | [`0x3a569740…`](https://hashscan.io/testnet/contract/0x3a56974075d734aFa5BF7f63e34F9C3237408AeD) |
| AtsEscrowMarket | [`0xcde9596f…`](https://hashscan.io/testnet/contract/0xcde9596fd89c5368b5bd46c2b93544cbb201f8df) |
| LEEKA · VGF1 · HRBR · LEEKB | [LEEKA](https://hashscan.io/testnet/contract/0x188fd9e330d22edd3381b21715d0a1722206b43f) · [VGF1](https://hashscan.io/testnet/contract/0xaab4b09e4691ec2284399a6a27466a498051bb23) · [HRBR](https://hashscan.io/testnet/contract/0x653bfb114985583e30a80b62a81f5bad1d4852eb) · [LEEKB](https://hashscan.io/testnet/contract/0x512988f3e1a2fc5da6fa65daffd35bb7437a3c84) |

**Extra points claimed:** a secondary market for ATS assets, *which the Studio
does not have today* ([`AtsEscrowMarket.sol`](app/packages/apps/ats/contracts/src/AtsEscrowMarket.sol));
compliance controls in use ([`src/act.ts`](app/packages/apps/ats/src/act.ts));
snapshot-reconciled distributions ([`src/dividend.ts`](app/packages/apps/ats/src/dividend.ts)).

Both of our Solidity contracts are audited against the ethskills
[security](https://ethskills.com/security/SKILL.md) and
[audit](https://ethskills.com/audit/SKILL.md) checklists, with Slither run on
each: [AtsEscrowMarket](app/packages/apps/ats/contracts/AUDIT-REPORT.md) and
[LeekSecurityFactory](app/packages/apps/ats/contracts/AUDIT-LEEKSECURITYFACTORY.md).
The factory report records one High-severity finding (a Hedera long-zero
address not being callable from a contract), **found, fixed and redeployed** —
with the two wrong hypotheses along the way written down as well.

**And one that is not on their list:** ATS issuance from a hardware wallet. The
factory's own `deployEquity` is 3,748 bytes of calldata against a device limit
of 768, so [`LeekSecurityFactory.sol`](app/packages/apps/ats/contracts/src/LeekSecurityFactory.sol)
moves the template on chain and reduces the call to
`deployEquity(string,string)` — **196 bytes**, with a screen showing the only
two values that vary. The Studio's web app cannot do this.

---

## Arc — payments and payroll

**[Full README →](app/packages/apps/till/README.md)**

Stablecoin-native point-of-sale and payroll on Arc (chain **5042002**), in USDC,
EURC and cirBTC. Salary and tips are sent as **two separate transactions per
employee**, because tips are not wages and one netted transfer is a number
nobody can reconcile afterwards.

No contracts are deployed: the app composes ERC-20 transfers of tokens Circle
already published, so the trust sits in the device screen rather than in a
contract we wrote.

**Honest status:** the code and its tests are complete; **end-to-end execution
on Arc testnet has not yet been recorded** as of 2026-09-11.

---

## The device, and why any of this is different

Every transaction above was rendered page by page on a 240×240 screen and
approved with a physical press. Blind signing is off, and a call the firmware
cannot decode in full is **refused whole** rather than shown in part.

That constraint is what shaped the work. It is why `LeekSecurityFactory` exists
at all, why the SwapVM decoder refuses a program it only partly understands, and
why an issuance whose name contains a right-to-left override is rejected instead
of cleaned — a name that does not read on screen the way it reads in the
calldata defeats the entire point of the device.

**[Architecture diagram →](docs/ARCHITECTURE.md)** — the two gates, the three
tiers of decoding, and a flow per track.

| | |
|---|---|
| Firmware decoders | [`src/eth-decode.c`](src/eth-decode.c) |
| Device signing pages | [`src/ui.c`](src/ui.c) |
| Host mirror | [`app/packages/core/src/eth-decode.ts`](app/packages/core/src/eth-decode.ts) |
| Shared vectors proving they agree | [`app/packages/core/test/eth-decode-vectors.json`](app/packages/core/test/eth-decode-vectors.json) |
| What a mini-app may ask the device for | [`app/packages/core/src/app-proposal.ts`](app/packages/core/src/app-proposal.ts) |

The mirror is not maintained by discipline alone: 49 shared vectors, 25 of them
refusals, are emitted from the firmware and replayed against the host decoder,
comparing decoded *content* rather than accept/reject.
[`docs/MIRROR-GAP.md`](docs/MIRROR-GAP.md) is the finding that demanded it —
written against ourselves, before it was fixed.

---

## Running it

```bash
pnpm --dir app install
pnpm --dir app tauri dev          # desktop companion
pnpm --dir app test               # every workspace suite
make -C sim test                  # the firmware, natively
```

Firmware: `pio run -e esp32s3` / `pio run -e pixie`, flashed with
`./flash-both.sh dev`. It also boots under Espressif's QEMU fork —
[`docs/QEMU.md`](docs/QEMU.md).

## Honest limitations

- **No demo video yet** at the time of writing.
- The companion tracks testnet balances; Base mainnet work is driven from the Aqua panel and scripts.
- **Connecting the Chrome extension reboots the board**, so the PIN is re-entered
  every time. Web Serial gives no way to suppress the DTR toggle that `open()`
  raises, and on the ESP32-S3 that line is wired to reset. The desktop companion
  is unaffected — its Rust transport sets `dtr_on_open(false)`.
- **The waiter terminal learns its restaurant from the first bill it is shown.**
  That is a misconfiguration and outsider-forgery check, not a defence against
  whoever holds the terminal: nothing on a till can be, because there is no key
  there to sign a policy with and the digest in a request is a checksum, not a
  signature. Stated in `merchant.ts` rather than implied.
- Not independently audited. [`AUDIT.md`](AUDIT.md) is our own list of findings against ourselves, and it is not short.

### What ran on-chain

Arc testnet: a four-payment payroll twice per-payment, then the same payroll
batched through Disperse — approve, salaries, tips — signed on both boards.
Hedera testnet: nine equities and a bond from `LeekSecurityFactory`, two issued
from the device, eight market listings, and shares bought from the device.
Base mainnet: a full Aqua position lifecycle. Base Sepolia: a La Caja bill paid
from an unmodified Rabby and detected by the waiter terminal unaided.
