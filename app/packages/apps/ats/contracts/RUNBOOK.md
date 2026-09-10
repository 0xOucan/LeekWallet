# One round of ATS deployments on Hedera testnet

From nothing to securities, holders and a live secondary market, in one sitting.

Everything runs from `app/packages/apps/ats/contracts/`. Every command is
copy-pasteable and every step says what a correct result looks like, because a
step whose success you cannot recognise is a step you cannot debug.

**Testnet only.** Nothing here should ever touch a key that holds real value.

---

## 0. The facts this runbook stands on

Re-derived on 2026-09-10 against the chain, not taken from documentation.

| Fact | Value | How it was checked |
|---|---|---|
| Chain id | `296` | `eth_chainId` on `https://testnet.hashio.io/api` |
| RPC | `https://testnet.hashio.io/api` | used for everything below |
| Factory | `0.0.9213391` = `0x00000000000000000000000000000000008c95cf` | its EVM alias, which is what appears in logs, is `0xd1f118a40f3b02883d35909ef2517e7edd78379d` |
| Resolver | `0xba2d5fc2083a0b8f164c50e65d782087fba18e0a` | first field of `SecurityData` in every recent successful `deployEquity` |
| Equity facet config | key `bytes32(1)`, version `1` | decoded from real calldata |
| Bond facet config | key `bytes32(2)`, version `1` | decoded from real calldata |
| `deployEquity` selector | **`0x837b37b6`** | see the correction below |
| `deployBond` selector | **`0x29002951`** | see the correction below |

### A correction to `docs/ATS-DEPLOY-C1.md`

That document records `0x29002951` as `deployEquity`. **It is `deployBond`.**
Both selectors were re-derived from the canonical signatures with `cast sig`,
and then confirmed by ABI-decoding live calldata of each shape off the mirror
node — the `0x837b37b6` call decoded to this project's own `LEEK` equity
(`LeekWallet` / `LEEK` / 6 decimals, deployed by `0x9c77c6…`), and a
`0x29002951` call decoded to somebody's `Demo Bond 2026`. `script/IAtsFactory.sol`
asserts both at run time before it broadcasts anything.

### The state of the existing LEEK equity, and why it matters

`0x651e73ebcf18ef7e050c90af0461d91d640635bb` (`0.0.10461772`) exists, has
`totalSupply` 0 — and **cannot be minted**. Confirmed by `eth_call`:

```
hasRole(DEFAULT_ADMIN_ROLE, 0x9c77c6…)  -> true
hasRole(ROLE_ISSUER,        0x9c77c6…)  -> false
mint(...)                               -> reverts AccountHasNoRole(issuer|agent)
```

It was deployed with `DEFAULT_ADMIN_ROLE` only. The admin *can* grant itself
`ROLE_ISSUER` afterwards, but the cleaner path — and the one `DeploySecurities`
takes — is to grant every role the console needs in the deploy itself. Treat
the LEEK equity as the pilot it was; the securities you deploy below are the
ones the demo uses.

### Accounts

| Role | EVM address | Hedera id | HBAR |
|---|---|---|---|
| LeekWallet device | `0xbDEB381a7c77040bf2a99E2990C116774CCb339f` | `0.0.10413558` | 200 |
| Foundry deployer | `0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` | `0.0.7307292` | 141 |
| Hedera deployer | `0xe7df15ba0c0baa20ce6f90aba3fe3a5f7fe3515f` | `0.0.7307276` | 1000 |

**None of them holds any HTS token.** The Circle faucet delivered nothing, and
the likely reason is structural rather than a glitch: on Hedera a token cannot
be received by an account that has not associated with it. That is why the
market has a native HBAR leg and why this runbook uses it.

---

## 1. Decide these five things before you start

Four of them are irreversible or expensive to change. Read them once now rather
than discovering them at step 6.

1. **Which account signs.** The Foundry deployer has 141 HBAR and already owns
   the LEEK equity. The Hedera deployer has 1000. See the cost warning in step
   4 — with `N=3` plus a bond, 141 HBAR is *tight*.
2. **`N`, the number of equities.** Default 3, maximum 7. Plus one bond, always.
3. **The settlement asset.** Native HBAR (`PAYMENT_TOKEN=0x0`) unless you have
   confirmed a real balance of a real HTS token in the buyer's account. This is
   **immutable in the deployed market** — getting it wrong means deploying
   again.
4. **Who the holders are.** At least two, including the LeekWallet device
   `0xbDEB…` so the demo can show a device-held position.
5. **Who buys.** The fill must come from a *different* key than the listing
   (`SelfFill` reverts), and that key needs HBAR for both the price and the gas.

---

## 2. Import the keys, once

Never pass a private key on a command line — it lands in shell history, and in
your shell's history file, and in any backup of it.

```bash
cast wallet import hedera-deployer --interactive   # the issuer / seller
cast wallet import buyer           --interactive   # a DIFFERENT account
cast wallet list
```

Every command below takes `--account <name>` and prompts for the passphrase.

Set the two things every command needs:

```bash
export RPC=https://testnet.hashio.io/api
export ISSUER=0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45   # your signer's address
```

Sanity-check the account the RPC will actually charge:

```bash
cast balance $ISSUER --rpc-url $RPC --ether
```

A zero balance next to a funded portal usually means an ED25519 Hedera account:
it has no usable EVM key. Create an **ECDSA** account instead. Stop here if this
reads zero — every later failure will look like a contract bug and will not be
one.

---

## 3. Build and test locally first

```bash
forge build
forge test
```

Expect **21 passing tests**. They cover the market, not the deployment: a
frozen buyer who cannot fill, a frozen seller whose shares stay escrowed, a
paused security that blocks everything, and 10,000-run fuzz over the escrow and
payment arithmetic. See `AUDIT-REPORT.md`.

---

## 4. Deploy the securities

Dry-run first. It costs nothing, it runs against a fork of the live chain, and
it catches a malformed ISIN, a bad resolver or a missing role before any HBAR
moves.

```bash
N=3 forge script script/DeploySecurities.s.sol:DeploySecurities \
  --rpc-url $RPC --sender $ISSUER
```

**Expect:** `SIMULATION COMPLETE`, four `equity/bond (simulated)` lines, and a
gas estimate. If it reverts, the usual causes in order: a wrong resolver, an
ISIN that fails its check digit, `rbacs` without an admin, a `maxSupply` of 0.

> **Cost.** The dry run estimated **~11.1M gas per security, ~105 HBAR for
> `N=3` plus the bond**. The Foundry deployer's 141 HBAR covers that with
> little to spare. If you are not sure, deploy from the 1000-HBAR account, or
> start with `N=2`. Hedera prices gas differently from Ethereum and the
> estimate is not exact — treat it as the right order of magnitude, not a bill.

Then broadcast:

```bash
N=3 forge script script/DeploySecurities.s.sol:DeploySecurities \
  --rpc-url $RPC --account hedera-deployer --broadcast --slow
```

`--slow` sends one transaction at a time and waits for each receipt. On Hedera
that matters: these are ~11M-gas transactions and firing four at once invites
nonce trouble.

**If Hedera rejects the transaction type**, add `--legacy`.
**If it runs out of gas**, add `--gas-limit 15000000` (Hedera's per-transaction
ceiling; estimation is not always generous).

### Recover the real addresses — this is not optional

```bash
./script/addresses.sh
```

**Expect** one line per security: symbol, address, transaction hash. The
addresses Forge printed during the run are the *simulation's*; the proxy
address depends on the factory's nonce at execution time. The receipts are the
truth, and `addresses.sh` decodes `EquityDeployed` / `BondDeployed` out of them.

Write them down now. Put them in `docs/ATS.md`.

```bash
export SEC=0x...        # the first equity, for the steps below
cast call $SEC "name()(string)"      --rpc-url $RPC
cast call $SEC "symbol()(string)"    --rpc-url $RPC
cast call $SEC "decimals()(uint8)"   --rpc-url $RPC
cast call $SEC "getMaxSupply()(uint256)" --rpc-url $RPC
cast call $SEC "isControllable()(bool)"  --rpc-url $RPC   # must be true
```

---

## 5. Mint to the holders

```bash
SECURITY=$SEC \
HOLDERS=0xbDEB381a7c77040bf2a99E2990C116774CCb339f,0xe7df15ba0c0baa20ce6f90aba3fe3a5f7fe3515f,$ISSUER \
SHARES=1200,800,500 \
forge script script/MintAndDistribute.s.sol:MintAndDistribute \
  --rpc-url $RPC --account hedera-deployer --broadcast --slow
```

`SHARES` is in **whole shares**. The script reads `decimals()` off the token and
scales for you. Whole amounts are a requirement, not a habit: C3 refuses a
distribution in which any holder is owed a fraction of a payment unit, so a
register with fractional positions is one no dividend can reconcile.

The script refuses before spending if the signer lacks `ROLE_ISSUER`/`ROLE_AGENT`,
if the token is paused, or if the mint would exceed `getMaxSupply()`.

**Verify on chain, not from the log:**

```bash
cast call $SEC "totalSupply()(uint256)" --rpc-url $RPC
cast call $SEC "balanceOf(address)(uint256)" 0xbDEB381a7c77040bf2a99E2990C116774CCb339f --rpc-url $RPC
cast call $SEC "getTotalSecurityHolders()(uint256)" --rpc-url $RPC
```

**Expect** `totalSupply` = 2,500,000,000 (2,500 shares × 10⁶), the device's
balance = 1,200,000,000, and 3 security holders. Paste `$SEC` into the console's
**Read register** — the fixture notice should disappear, because the figures are
now real.

Repeat for the other securities with different holder mixes. Depth of story is
the point: one security with three holders and one with a single concentrated
position read very differently on the register.

---

## 6. Deploy the market

```bash
PAYMENT_TOKEN=0x0000000000000000000000000000000000000000 \
forge script script/DeployMarket.s.sol:DeployMarket \
  --rpc-url $RPC --account hedera-deployer --broadcast
```

**Expect** `payment leg : NATIVE HBAR` in the log *before* the deploy line. If
you meant to pin a token and see this, stop — the payment token is immutable in
the deployed contract.

Get the real address out of the receipt (again, not from the log):

```bash
# .receipts is what the chain said; .transactions is what the simulation guessed.
export MARKET=$(jq -r '.receipts[0].contractAddress' broadcast/DeployMarket.s.sol/296/run-latest.json)
echo $MARKET
cast call $MARKET "IS_NATIVE()(bool)"          --rpc-url $RPC   # true
cast call $MARKET "PAYMENT_DECIMALS()(uint8)"  --rpc-url $RPC   # 18, see below
cast call $MARKET "nextListingId()(uint256)"   --rpc-url $RPC   # 1
```

`PAYMENT_DECIMALS` reads **18, not 8**. HBAR has 8 decimals, but `msg.value` in
the EVM is weibar at 18. A price written in tinybar is off by a factor of
10,000,000,000 and settles anyway. `ListLot` takes `PRICE_HBAR` in whole HBAR
and does the multiplication itself, precisely so you never type that number.

### 6b. THE STEP YOU CANNOT SKIP — and when it does not apply

**If you deployed with an HTS/ERC-20 payment token**, do this now, before any
listing exists:

```bash
cast send $TOKEN "transfer(address,uint256)" $MARKET 1 --rpc-url $RPC --account hedera-deployer
cast call  $TOKEN "balanceOf(address)(uint256)" $MARKET --rpc-url $RPC
```

**Expect exactly `1`.** If it reverts, or reads `0`, the constructor's
`associateToken` call through the system contract at `0x167` did not take
effect, and **every fill will fail** for a reason that looks nothing like the
cause. Fix that before continuing.

This is the one path in the whole system that **no test covers and no test
can**: a local chain has no code at `0x167`, so association is not a concept
there and its absence is correct. The only place it can be proven is here.

**If you deployed the native HBAR leg** (`IS_NATIVE() == true`), **association
does not apply.** HBAR is not an HTS token; there is nothing to associate with,
the constructor made no `0x167` call, and this step has nothing to check. Say
so out loud rather than skipping it silently — the reason this leg exists is
that association is the failure mode that killed the token path.

---

## 7. List a lot

Run as the **seller** — an account that actually holds shares.

```bash
MARKET=$MARKET SECURITY=$SEC SHARES=100 PRICE_HBAR=25 \
forge script script/ListAndFill.s.sol:ListLot \
  --rpc-url $RPC --account hedera-deployer --broadcast --slow
```

This approves the market for exactly the lot and then lists it. `priceTotal` is
the price of the **whole lot**, not per share — there is no per-share figure
anywhere in the market, and therefore no division and no truncation.

**Verify:**

```bash
cast call $MARKET "nextListingId()(uint256)" --rpc-url $RPC     # now 2
cast call $MARKET "getListing(uint256)" 1 --rpc-url $RPC
cast call $SEC "balanceOf(address)(uint256)" $MARKET --rpc-url $RPC   # 100000000
```

**Expect** the listing to show your seller, the security, `amount` 100000000,
`priceTotal` 25000000000000000000 (25 × 10¹⁸ weibar), and `status` **1**
(`Open`). The shares are now in the market's custody — that is what escrow
means, and `cancel` is the only way back for the seller.

---

## 8. Fill it, from a different account

```bash
MARKET=$MARKET LISTING_ID=1 \
forge script script/ListAndFill.s.sol:FillLot \
  --rpc-url $RPC --account buyer --broadcast --slow
```

The buyer needs at least 25 HBAR plus gas. The script sends `value` equal to
`priceTotal` exactly — the market rejects an overpayment rather than keeping or
refunding it.

**Verify — this is the proof the whole thing works:**

```bash
cast call $MARKET "getListing(uint256)" 1 --rpc-url $RPC        # status 2 = Filled
cast call $SEC "balanceOf(address)(uint256)" <buyer>  --rpc-url $RPC   # 100000000
cast call $SEC "balanceOf(address)(uint256)" $MARKET  --rpc-url $RPC   # 0
cast balance <seller> --rpc-url $RPC --ether                    # up by ~25 HBAR
```

Both legs settled in one transaction, or neither did. No compliance check
happened in the market: if the buyer may not hold that security, the security
reverts and the fill reverts with it.

---

## 9. Verify the contracts on HashScan

```bash
forge verify-contract $MARKET src/AtsEscrowMarket.sol:AtsEscrowMarket \
  --verifier sourcify \
  --verifier-url https://server-verify.hashscan.io \
  --chain-id 296 \
  --constructor-args $(cast abi-encode "constructor(address)" 0x0000000000000000000000000000000000000000)
```

The securities are factory-deployed proxies and are already verified by
association with the ATS deployment; only the market is yours to verify.

---

## 10. The demo worth recording

Now that a real register exists, each of these is a screen on a real device
against real state:

1. **Read register** on a deployed security — real holders, real balances, no
   fixture notice.
2. **Force transfer** (`controllerTransfer`) — shares moving *without the
   holder's consent*, rendered on the device before it is signed. This works
   only because `isControllable` was true at deploy.
3. **Freeze a holder**, then watch their next `fill` revert. Compliance
   enforced at transfer, by the security, not by the market.
4. **Declare a dividend** (`setDividend`) against a snapshot, then reconcile it
   in C3. Remember: `setDividend` declares a corporate action and moves no
   money. There is no `payDividend` in the package. The payment is a separate
   transfer the issuer makes, which is exactly what C3 reconciles.

---

## When it fails

| Symptom | Cause | Fix |
|---|---|---|
| `transaction type not supported` | Hedera relay rejects EIP-1559 | add `--legacy` |
| out of gas / `CONTRACT_REVERT_EXECUTED` on deploy | estimate short | `--gas-limit 15000000` |
| `AccountHasNoRole` | the signer lacks the role for that call | it was not in `rbacs` at deploy; `grantRole` as admin, or redeploy |
| `WrongISIN` / `WrongISINChecksum` | 12 characters and a valid ISO 6166 check digit are both required | use the table in `DeploySecurities.s.sol`, do not invent one |
| every transfer reverts | `identityRegistry` or `compliance` points at a contract that does not exist | they must stay zero unless a real ERC-3643 stack is deployed |
| `fill` reverts with no clear reason, HTS leg | the market never associated with the payment token | step 6b — and it is fatal, not retryable |
| the price is 10¹⁰ too small | tinybar written where weibar was needed | use `PRICE_HBAR`; never hand-write a native price |
| `SelfFill` | seller and buyer are the same key | fill with `--account buyer` |
| simulated address ≠ real address | you read Forge's log instead of the receipt | `./script/addresses.sh` |
| nonce errors mid-run | four large transactions in flight at once | `--slow` |

---

## What each script is, in one line

| File | What it does |
|---|---|
| `script/IAtsFactory.sol` | The factory structs and role ids, transcribed from the package and selector-checked against live calldata |
| `script/IAtsSecurity.sol` | The security calls these scripts make — the same set the console reads |
| `script/DeploySecurities.s.sol` | `N` equities plus one bond, with every role granted at birth |
| `script/MintAndDistribute.s.sol` | Whole-share minting to named holders, with the pre-flight checks that name their own failure |
| `script/DeployMarket.s.sol` | The escrow market, native or token leg |
| `script/ListAndFill.s.sol` | `ListLot` (seller) and `FillLot` (buyer) — two keys, one trade |
| `script/addresses.sh` | The real deployed addresses, out of the receipts |
