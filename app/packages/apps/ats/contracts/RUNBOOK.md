# Deploying the ATS secondary market on Hedera testnet

Everything here runs from `app/packages/apps/ats/contracts/`.

## 0. Accounts (resolved 2026-09-10)

| Role | EVM address | Hedera id | HBAR |
|---|---|---|---|
| LeekWallet device | `0xbDEB381a7c77040bf2a99E2990C116774CCb339f` | `0.0.10413558` | 200 |
| Foundry deployer | `0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45` | `0.0.7307292` | 141 |
| Hedera deployer | `0xe7df15ba0c0baa20ce6f90aba3fe3a5f7fe3515f` | `0.0.7307276` | 1000 |

**None of these had an HTS token associated at the time of writing.** Find the
account that actually holds your USDC before going further — the payment token
address is the one input this whole thing turns on.

Deployed equity so far: `0x651e73ebcf18ef7e050c90af0461d91d640635bb`
(`0.0.10461772`, `LEEK`, 6 decimals, max supply 1,000,000, total supply 0).

## 1. Import the key once

Never pass a private key on the command line — it lands in shell history.

```bash
cast wallet import hedera-deployer --interactive
cast wallet list
```

## 2. Find the payment token

The market pins ONE payment token at construction, permanently. Confirm the
address before deploying:

```bash
TOKEN=0x...            # the USDC you actually hold
RPC=https://testnet.hashio.io/api
cast call $TOKEN "symbol()(string)"   --rpc-url $RPC
cast call $TOKEN "decimals()(uint8)"  --rpc-url $RPC
cast call $TOKEN "balanceOf(address)(uint256)" <your-address> --rpc-url $RPC
```

Two candidates answer `USDC` / `6` on testnet, but you hold neither yet:
`0.0.429274` = `0x0000000000000000000000000000000000068cda`, and
`0.0.5449` = `0x0000000000000000000000000000000000001549`.

## 3. Deploy

```bash
export PAYMENT_TOKEN=0x...
forge script script/DeployMarket.s.sol:DeployMarket \
  --rpc-url https://testnet.hashio.io/api \
  --account hedera-deployer \
  --broadcast
```

The script prints the token's symbol and decimals **before** deploying, so a
wrong address is obvious in the log rather than three steps later.

If Hedera rejects the transaction type, retry with `--legacy`. If it runs out of
gas, add `--gas-limit 8000000` — Hedera's estimation is not always generous.

## 4. THE STEP THAT DECIDES WHETHER ANY OF THIS WORKS

On Hedera an HTS token **cannot be received by an unassociated account**. The
constructor calls `associateToken` through the system contract at `0x167`, but
that path is **not exercised by any local test** — a local chain has no code at
`0x167`. So verify it for real, before any listing exists:

```bash
MARKET=0x...                      # from the deploy log
cast send $TOKEN "transfer(address,uint256)" $MARKET 1 \
  --rpc-url $RPC --account hedera-deployer
cast call $TOKEN "balanceOf(address)(uint256)" $MARKET --rpc-url $RPC
```

**Expect `1`.** If it reverts or reads `0`, the association did not happen and
nothing downstream will work. Fix that before continuing; it is the single most
likely cause of a first-run failure.

## 5. Mint, then list and fill

`totalSupply` on the equity is 0, so mint before any market flow — C3 cannot
reconcile a dividend across zero holders either.

Mint whole share amounts. The security has 6 decimals, and C3 refuses a
distribution where any holder is owed a fraction of a payment unit.

```bash
SEC=0x651e73ebcf18ef7e050c90af0461d91d640635bb

# seller approves the market for the exact lot, never more
cast send $SEC "approve(address,uint256)" $MARKET 1000000 --rpc-url $RPC --account hedera-deployer

# list 1.0 share for 25.00 USDC
cast send $MARKET "list(address,uint256,uint256)" $SEC 1000000 25000000 --rpc-url $RPC --account hedera-deployer

# buyer approves the exact price, then fills (from a DIFFERENT account)
cast send $TOKEN  "approve(address,uint256)" $MARKET 25000000 --rpc-url $RPC --account buyer
cast send $MARKET "fill(uint256)" 1 --rpc-url $RPC --account buyer
```

`fill` reverts if the buyer may not hold the security. That is the compliance
regime working — the market never checks, the security does.

## 6. Verify on HashScan

The track asks for verified contracts.

```bash
forge verify-contract $MARKET src/AtsEscrowMarket.sol:AtsEscrowMarket \
  --verifier sourcify \
  --verifier-url https://server-verify.hashscan.io \
  --chain-id 296
```

## 7. The demo worth recording

1. Buyer has no KYC → `fill` reverts.
2. Issuer grants KYC **in the LeekWallet console, signed on the device**.
3. The same `fill` now settles.
4. Issuer freezes the buyer on the device → the next trade reverts again.

Compliance enforced at transfer, driven by a hardware wallet you built. Nothing
on a slide.
