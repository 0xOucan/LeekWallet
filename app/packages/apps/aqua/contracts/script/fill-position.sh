#!/usr/bin/env bash
#
# Fill an Aqua position the device just shipped, and print the proof.
#
#   ./script/fill-position.sh 0x<ship tx hash>
#
# The ship hash is the "Aqua: sent 0x…" line in the companion's device log,
# on the step that says "ship a strategy". Everything else is read from chain:
#
#   1. the ship receipt   -> the strategy bytes, its hash, the maker, and how
#                            much WETH was pushed (the fill is sized from it)
#   2. order-fields.mjs   -> the (maker,traits,data) order tuple, refused if its
#                            own parse does not re-encode to the strategy
#   3. quote              -> free static call: gate, band, deadline, arithmetic
#   4. allowance          -> topped up only if short (quote does NOT check it --
#                            RUNBOOK step 7, learned the hard way)
#   5. swap               -> the fill, signed by the taker keystore
#   6. proof              -> Basescan link and the balances that moved
#
# The taker is the `monad-deployer` foundry keystore (it holds the LWGATE gate
# token). The maker is the device. They must differ: a maker filling its own
# position accomplishes nothing. No private key ever appears on a command line;
# cast prompts for the keystore password.
#
# Environment overrides (all optional):
#   ACCOUNT      foundry keystore name        (default monad-deployer)
#   BASE_RPC     Base mainnet RPC             (default https://mainnet.base.org)
#   AMOUNT_OUT   WETH wei to take out         (default: a quarter of the WETH pushed)
#   TAKER        the keystore's address       (default the RUNBOOK deployer; saves a password prompt)
#   DRY_RUN=1    read and quote only; approve and swap nothing
set -euo pipefail
cd "$(dirname "$0")/.."

SHIP_TX="${1:-}"
[[ "$SHIP_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || {
  echo "usage: $0 0x<ship tx hash>   (the 'ship a strategy' line in the device log)" >&2
  exit 2
}

ACCOUNT="${ACCOUNT:-monad-deployer}"
BASE_RPC="${BASE_RPC:-https://mainnet.base.org}"
EXPLORER="https://basescan.org"
ROUTER=0x111111338c5091e8440b67b168bae16a668ac0de
REGISTRY=0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
# 22 bytes; flags in the last two. 0x0040 = USE_TRANSFER_FROM_AND_AQUA_PUSH.
TT=0x00000000000000000000000000000000000000000040
TOPIC_SHIPPED=0xdc3622e0
TOPIC_PUSHED=0x3f18354a

for tool in cast jq python3 node; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

TAKER="${TAKER:-0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45}"
echo "==> taker   $TAKER  ($ACCOUNT)"

# ---------------------------------------------------------------- 1. receipt
echo "==> reading ship $SHIP_TX"
RECEIPT=$(cast receipt "$SHIP_TX" --rpc-url "$BASE_RPC" --json)
[[ "$(jq -r .status <<<"$RECEIPT")" == "0x1" ]] || {
  echo "the ship transaction did not succeed -- there is no position to fill" >&2
  echo "    $EXPLORER/tx/$SHIP_TX" >&2
  exit 1
}

read -r MAKER HASH STRATEGY WETH_PUSHED < <(python3 - "$RECEIPT" "$TOPIC_SHIPPED" "$TOPIC_PUSHED" "$REGISTRY" "$WETH" <<'PY'
import json, sys
r, t_ship, t_push, registry, weth = json.loads(sys.argv[1]), *sys.argv[2:]
logs = [l for l in r["logs"] if l["address"].lower() == registry.lower()]
ship = [l for l in logs if l["topics"][0].startswith(t_ship)]
if len(ship) != 1:
    sys.exit(f"expected one Shipped event in that transaction, found {len(ship)}")
w = lambda d: [d[2:][i:i+64] for i in range(0, len(d) - 2, 64)]
sw = w(ship[0]["data"])
maker, h = "0x" + sw[0][24:], "0x" + sw[2]
off = int(sw[3], 16) // 32
ln = int(sw[off], 16)
strategy = "0x" + "".join(sw[off + 1:])[: ln * 2]
pushed = 0
for l in logs:
    if l["topics"][0].startswith(t_push):
        pw = w(l["data"])
        if ("0x" + pw[3][24:]).lower() == weth.lower():
            pushed = int(pw[4], 16)
print(maker, h, strategy, pushed)
PY
)

echo "    maker     $MAKER"
echo "    strategy  $HASH"
echo "    WETH in   $WETH_PUSHED wei"
[[ "${MAKER,,}" != "${TAKER,,}" ]] || { echo "maker and taker are the same address -- refusing" >&2; exit 1; }
[[ "$WETH_PUSHED" -gt 0 ]] || { echo "this position pushed no WETH, so there is nothing to take out" >&2; exit 1; }

AMOUNT_OUT="${AMOUNT_OUT:-$(( WETH_PUSHED / 4 ))}"
echo "    fill      $AMOUNT_OUT wei WETH out"

# ------------------------------------------------------------ 2. order tuple
ORDER=$(node script/order-fields.mjs "$STRATEGY" | tail -n 1)
[[ "$ORDER" == \(* ]] || { echo "order-fields.mjs did not produce an order tuple" >&2; exit 1; }

# ------------------------------------------------------------------ 3. quote
SIG="((address,uint256,bytes),address,address,uint256,bytes)"
echo "==> quote (free)"
if ! QUOTE=$(cast call --rpc-url "$BASE_RPC" --from "$TAKER" "$ROUTER" \
      "quote$SIG" "$ORDER" "$USDC" "$WETH" "$AMOUNT_OUT" "$TT" 2>&1); then
  echo "quote reverted -- nothing was sent." >&2
  # Name the two failures a demo actually hits, rather than guessing.
  if [[ "$QUOTE" == *0x09e99adc* ]]; then
    DL=$(grep -oE '0x09e99adc[0-9a-f]{128}' <<<"$QUOTE" | cut -c75-)
    echo "DeadlineReached: this position expired at $(date -u -d @$((16#$DL)))." >&2
    echo "Ship a fresh one from the companion and run this again with its hash." >&2
  elif [[ "$QUOTE" == *0x9669f955* ]]; then
    echo "TakerTokenBalanceIsZero: $TAKER holds no gate token, so opcode 14 refuses it." >&2
  else
    echo "See contracts/RUNBOOK.md step 9." >&2
    echo "$QUOTE" >&2
  fi
  exit 1
fi
AMOUNT_IN=$(python3 -c "import sys; print(int(sys.argv[1][2:66], 16))" "$QUOTE")
echo "    pays      $AMOUNT_IN USDC units for $AMOUNT_OUT wei WETH"

if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "DRY_RUN=1 -- stopping before approve and swap."
  exit 0
fi

# -------------------------------------------------------------- 4. allowance
ALLOW=$(cast call --rpc-url "$BASE_RPC" "$USDC" "allowance(address,address)(uint256)" "$TAKER" "$ROUTER" | awk '{print $1}')
if (( ALLOW < AMOUNT_IN )); then
  NEED=$(( AMOUNT_IN * 2 ))
  echo "==> router allowance $ALLOW < $AMOUNT_IN, approving $NEED"
  cast send --rpc-url "$BASE_RPC" --account "$ACCOUNT" \
    "$USDC" "approve(address,uint256)" "$ROUTER" "$NEED" >/dev/null
else
  echo "    allowance $ALLOW covers it"
fi

bal() { cast call --rpc-url "$BASE_RPC" "$1" "balanceOf(address)(uint256)" "$2" | awk '{print $1}'; }
M_USDC0=$(bal "$USDC" "$MAKER"); M_WETH0=$(bal "$WETH" "$MAKER")

# ------------------------------------------------------------------- 5. swap
echo "==> swap (sign with the $ACCOUNT keystore)"
SWAP=$(cast send --rpc-url "$BASE_RPC" --account "$ACCOUNT" --json "$ROUTER" \
  "swap$SIG" "$ORDER" "$USDC" "$WETH" "$AMOUNT_OUT" "$TT")
FILL_TX=$(jq -r .transactionHash <<<"$SWAP")
[[ "$(jq -r .status <<<"$SWAP")" == "0x1" ]] || { echo "swap failed: $EXPLORER/tx/$FILL_TX" >&2; exit 1; }

# ------------------------------------------------------------------ 6. proof
M_USDC1=$(bal "$USDC" "$MAKER"); M_WETH1=$(bal "$WETH" "$MAKER")
cat <<EOF

FILLED on Base mainnet.

  ship  (signed on the device)  $EXPLORER/tx/$SHIP_TX
  fill  (signed by the taker)   $EXPLORER/tx/$FILL_TX

  maker USDC  $M_USDC0 -> $M_USDC1   (+$(( M_USDC1 - M_USDC0 )) units)
  maker WETH  $M_WETH0 -> $M_WETH1   (-$(( M_WETH0 - M_WETH1 )) wei)

The fill's sender is the taker, not the device -- by design. The device's
address appears on both token legs in the fill's logs.
EOF
