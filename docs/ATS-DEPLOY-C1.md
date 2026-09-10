# C1 — Deploying one Hedera equity, step by step

The console (C2) is built and honest, but it has never read a real security:
its only data is `FIXTURE_ADDRESS`, labelled *"no figure on this screen came
from Hedera."* This is the cheapest conversion of finished work into a
demonstrable one — deploy one equity, paste its address into **Read register**,
and the fixture notice disappears because the figures are real.

## 0. What was verified, and how

Everything below was checked against the chain on 2026-09-08, not taken from a
tutorial:

| Fact | Value | How it was verified |
|---|---|---|
| Chain id | `296` (`0x128`) | `eth_chainId` on `https://testnet.hashio.io/api` |
| Factory | `0.0.9213391` = `0x00000000000000000000000000000000008c95cf` | `eth_getCode` returns a diamond proxy |
| **Resolver** | `0xba2d5fc2083a0b8f164c50e65d782087fba18e0a` | see below |
| `deployEquity` selector | **`0x837b37b6`** | **corrected 2026-09-10** — this row read `0x29002951` until then, which is `deployBond`. Re-derived with `cast sig` and confirmed by ABI-decoding live calldata of each shape; see the correction below and `app/packages/apps/ats/contracts/RUNBOOK.md` §0 |
| `deployBond` selector | **`0x29002951`** | same derivation |
| Contracts pkg licence | Apache-2.0 | `package.json` — compatible, unlike the Aqua SDK |

**The resolver address is not published in the npm package.** It was recovered
empirically: the mirror node
(`/api/v1/contracts/0.0.9213391/results`) was asked for the factory's recent
calls, the `deployEquity` and `deployBond` ones were ABI-decoded, and `SecurityData.resolver` —
the first field of the first struct — read out. **Six independent deployments
all name the same resolver**, and that address has code. That is why it is
written here as a fact rather than a guess. Re-derive it the same way if a
deploy ever starts failing:

```bash
curl -s "https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.9213391/results?limit=25&order=desc"
# decode the 0x837b37b6 (equity) or 0x29002951 (bond) entries;
# SecurityData.resolver is the first field of the first struct either way
```

### Correction, 2026-09-10 — the selectors were swapped here

An earlier version of this file recorded `0x29002951` as `deployEquity`. It is
**`deployBond`**. `deployEquity` is **`0x837b37b6`**.

The factory's recent history makes it obvious once counted: `0x837b37b6`
appears **once** — this project's own LEEK equity — and `0x29002951` **24
times**, other people's bonds. Decoding the single `0x837b37b6` call yields
`maxSupply` `1000000000000` = 1,000,000 x 10^6, matching LEEK exactly.

**The resolver address published above is nonetheless correct**, and it is worth
being precise about why: `SecurityData` is the first field of both `EquityData`
and `BondData`, so the offset arithmetic landed on the same field either way.
The method was wrong and the answer was right by structural coincidence. It has
since been re-derived from the real `deployEquity` call.

## 1. Prerequisites

- A funded **Hedera testnet account** with HBAR (a deploy is a few HBAR).
- Its **ECDSA private key** and the matching **EVM address**. A Hedera account
  created from an ED25519 key has no usable EVM key — if `eth_getBalance` on
  your EVM address returns `0x0` while the portal shows HBAR, that is the
  cause; create an **ECDSA** account instead.

Check the account the RPC will actually charge:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<YOUR_EVM_ADDRESS>","latest"]}' \
  https://testnet.hashio.io/api
```

A non-zero result is the green light. Anything else, stop here — every later
step fails in a way that looks like a contract bug and is not.

## 2. Who signs this one

Two options, and they are not equivalent:

- **A throwaway testnet ECDSA key (recommended for C1).** The SDK's wallet
  layer supports `METAMASK`/`DFNS`/`FIREBLOCKS`/`AWSKMS` — LeekWallet is not one
  of them, and the deployment path is a single large nested struct. Fighting the
  wallet abstraction to hardware-sign a *one-off deployment* buys little.
- **The device.** C1's audit gate asks for "the deployment approved on the
  device". That is real, but note where the actual security story lives: it is
  **C2** — the privileged actions (`grantRole`, `pause`, `revokeKyc`, `mint`)
  that can freeze holders and dilute every holder. Those are already
  device-rendered and device-approved. Deploying the token is the least
  dangerous thing an issuer ever does.

Recommendation: deploy with a throwaway testnet key, keep every privileged
action device-signed, and say exactly that in the demo. It is defensible and
honest. **Testnet only — never a key that holds real value.**

## 3. Build the call

`deployEquity(EquityData, FactoryRegulationData)` is a deeply nested struct.
**Do not hand-encode it.** Use the ABI shipped in the contracts package, which
is already a dependency of the ATS app:

```
app/node_modules/@hashgraph/asset-tokenization-contracts
  contracts/factory/IFactory.sol      <- the structs
  artifacts/ .. typechain-types/      <- the compiled ABI to import
```

`SecurityData` fields that decide the outcome:

| Field | Value |
|---|---|
| `resolver` | `0xba2d5fc2083a0b8f164c50e65d782087fba18e0a` |
| `maxSupply` | your share count (prior real deploys used `1`, `10000000000`, `50000000000`) |
| `erc20MetadataInfo` | name, symbol, decimals |
| `rbacs` | the roles granted at birth — **your account must appear here as admin**, or you deploy a token you cannot administer |
| `isControllable`, `isWhiteList`, `internalKycActivated` | drive which C2 actions are even legal |

`EquityDetailsData`: the rights booleans, `dividendRight`, `currency` as
**`bytes3` of the ISO code** (USD = `0x555344`), `nominalValue` and
`nominalValueDecimals`.

## 4. Dry-run before you spend anything

**This is the step that saves the HBAR.** Simulate first — `eth_call` /
viem's `simulateContract` — against the same factory with the same arguments.
A revert here costs nothing; a revert in step 5 costs a transaction and tells
you less.

If it reverts, the usual causes in order: wrong resolver, `rbacs` missing your
admin entry, a `maxSupply` of `0`, or a malformed `bytes3` currency.

## 5. Send it, then record it

Send the transaction. The return value is the deployed equity **proxy
address**. Then:

1. Confirm it on **HashScan** (testnet) — the audit gate asks for exactly this.
2. Open the companion → **Hedera 296** → **Read register** → paste the address.
   The register should populate with real figures and **no fixture notice**.
3. Try one privileged action end to end (grant a role, then revoke it) and
   photograph the device screen. That is the C2 evidence, and it only becomes
   real once a real token exists.

## 6. Record it in docs/ATS.md

C1, C2 and C3 all require it. Write down: the equity address, the transaction
hash, the constructor values used, and the account that holds admin. A
deployment nobody wrote down is a deployment nobody can reproduce.

## Failure modes worth naming

- **A half-configured token.** C1's gate says a failed deploy must not leave
  something we later mistake for live. If a deploy reverts after the proxy
  exists but before roles are set, treat that address as dead — record it as
  abandoned in `docs/ATS.md` and deploy again. Do not try to repair it.
- **Reading a non-ATS address.** The console already says so once, at the top,
  rather than printing forty identical rows. If you see that, the address is
  wrong, not the token.
