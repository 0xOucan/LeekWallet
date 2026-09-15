#!/usr/bin/env bash
#
# Before recording the Aqua demo: check both sides can do their part, and
# pre-approve the taker so the live fill is one password prompt, not two.
#
#   ./script/pre-demo.sh
#
# There is no "2-hour permission" to grant here. The 2 hours is the DEADLINE
# baked into the position when the device ships it (the Expires field), and
# the clock starts at the ship. What this script prepares is the taker's side,
# which does not expire:
#
#   maker (the device)  enough WETH and USDC for the example position, and gas
#   taker (keystore)    ETH for gas, USDC to pay the fill, a non-zero LWGATE
#                       balance (opcode 14 refuses anyone without it), and a
#                       USDC allowance to the ROUTER -- not the registry
#
# Only the allowance is ever written, and only when it is below the target.
# Everything else is read and reported.
#
# Environment overrides (all optional):
#   ACCOUNT    foundry keystore name   (default monad-deployer)
#   TAKER      that keystore's address (default the RUNBOOK deployer)
#   BASE_RPC   Base mainnet RPC        (default https://mainnet.base.org)
#   CHECK_ONLY=1  report only; never approve
set -euo pipefail

ACCOUNT="${ACCOUNT:-monad-deployer}"
TAKER="${TAKER:-0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45}"
MAKER="${MAKER:-0xbDEB381a7c77040bf2a99E2990C116774CCb339f}"
BASE_RPC="${BASE_RPC:-https://mainnet.base.org}"
ROUTER=0x111111338c5091e8440b67b168bae16a668ac0de
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
GATE=0x8ed185f95d62a60cc3cf2688ffe3a250b3a8262b

# What "Fill example position" ships, and what a quarter-fill of it costs.
EXAMPLE_WETH=100000000000000      # 0.0001 WETH
EXAMPLE_USDC=300000               # 0.30 USDC
ALLOWANCE_MIN=500000              # 0.50 USDC: a quarter-fill of the example costs ~0.10
ALLOWANCE_TARGET=1000000          # topped up to 1.00 when below the minimum
MIN_GAS_WEI=200000000000000       # 0.0002 ETH; Base fills cost far less

command -v cast >/dev/null || { echo "cast is required" >&2; exit 2; }

bal()  { cast call --rpc-url "$BASE_RPC" "$1" "balanceOf(address)(uint256)" "$2" | awk '{print $1}'; }
eth()  { cast balance --rpc-url "$BASE_RPC" "$1"; }
fmt()  { python3 -c "import sys; print(f'{int(sys.argv[1])/10**int(sys.argv[2]):.6f}'.rstrip('0').rstrip('.'))" "$1" "$2"; }

FAIL=0
check() { # label have need decimals
  local mark="ok  "
  if (( $2 < $3 )); then mark="LOW "; FAIL=1; fi
  printf '  %s %-22s %14s   (needs %s)\n' "$mark" "$1" "$(fmt "$2" "$4")" "$(fmt "$3" "$4")"
}

echo "== maker, the device  $MAKER"
check "ETH for gas"   "$(eth "$MAKER")"          "$MIN_GAS_WEI"   18
check "WETH"          "$(bal "$WETH" "$MAKER")"  "$EXAMPLE_WETH"  18
check "USDC"          "$(bal "$USDC" "$MAKER")"  "$EXAMPLE_USDC"  6

echo "== taker, $ACCOUNT  $TAKER"
check "ETH for gas"   "$(eth "$TAKER")"          "$MIN_GAS_WEI"   18
check "USDC to pay"   "$(bal "$USDC" "$TAKER")"  "$ALLOWANCE_MIN" 6
check "LWGATE (gate)" "$(bal "$GATE" "$TAKER")"  1               0

ALLOW=$(cast call --rpc-url "$BASE_RPC" "$USDC" "allowance(address,address)(uint256)" "$TAKER" "$ROUTER" | awk '{print $1}')
if (( ALLOW < ALLOWANCE_MIN )) && [[ "${CHECK_ONLY:-}" != 1 ]]; then
  printf '  ..   %-22s %14s   -> approving %s (keystore password)\n' "router allowance" "$(fmt "$ALLOW" 6)" "$(fmt "$ALLOWANCE_TARGET" 6)"
  cast send --rpc-url "$BASE_RPC" --account "$ACCOUNT" \
    "$USDC" "approve(address,uint256)" "$ROUTER" "$ALLOWANCE_TARGET" >/dev/null
  ALLOW=$(cast call --rpc-url "$BASE_RPC" "$USDC" "allowance(address,address)(uint256)" "$TAKER" "$ROUTER" | awk '{print $1}')
fi
check "router allowance" "$ALLOW" "$ALLOWANCE_MIN" 6

echo
if (( FAIL )); then
  echo "NOT READY -- top up whatever says LOW before recording." >&2
  exit 1
fi
cat <<'EOF'
READY. The order on camera:
  1. companion, Aqua: "Fill example position" -> Plan the position
  2. device: approve, then ship  (copy the hash on the "ship a strategy" log line)
  3. terminal, within 2 hours:   ./script/fill-position.sh 0x<that hash>
EOF
