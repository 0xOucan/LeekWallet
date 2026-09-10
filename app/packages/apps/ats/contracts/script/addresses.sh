#!/usr/bin/env bash
#
# Recover the REAL addresses of the securities a broadcast just deployed.
#
# Forge's console output comes from the simulation. The proxy address is chosen
# by the factory's nonce at execution time, so the simulated address and the
# broadcast one agree only by luck. The addresses that matter are the ones in
# the receipts, and this reads them from there.
#
#   ./script/addresses.sh                     # newest DeploySecurities run
#   ./script/addresses.sh <run-latest.json>   # a specific run
#
# It decodes `EquityDeployed(address indexed deployer, address equityAddress,
# ...)` and `BondDeployed(...)`, whose first NON-indexed field is the deployed
# address -- so it is the first 32-byte word of the log's data.

set -euo pipefail

cd "$(dirname "$0")/.."

RPC="${RPC:-https://testnet.hashio.io/api}"
RUN="${1:-broadcast/DeploySecurities.s.sol/296/run-latest.json}"

if [[ ! -f "$RUN" ]]; then
    echo "no broadcast record at $RUN" >&2
    echo "Did the run use --broadcast? A dry run writes to .../dry-run/ instead," >&2
    echo "and a dry run's addresses are not real." >&2
    exit 1
fi

EQUITY_TOPIC="$(cast keccak 'EquityDeployed(address,address,((address,uint256,(bytes32,uint256),(string,string,string,uint8),(bytes32,address[])[],address[],address[],address[],address,address,bool,bool,bool,bool,bool,bool,bool),(bool,bool,bool,bool,bool,bool,bool,uint8,bytes3,uint256,uint8)),(uint8,uint8,(bool,string,string)))')"
BOND_TOPIC="$(cast keccak 'BondDeployed(address,address,((address,uint256,(bytes32,uint256),(string,string,string,uint8),(bytes32,address[])[],address[],address[],address[],address,address,bool,bool,bool,bool,bool,bool,bool),(bytes3,uint256,uint8,uint256,uint256),address[],bytes[]),(uint8,uint8,(bool,string,string)))')"

echo "reading $RUN"
echo

for hash in $(jq -r '.transactions[].hash' "$RUN"); do
    # The receipt, not the broadcast file: the broadcast file records what was
    # sent, the receipt records what happened.
    receipt="$(cast receipt "$hash" --rpc-url "$RPC" --json)"

    addr="$(jq -r --arg e "$EQUITY_TOPIC" --arg b "$BOND_TOPIC" '
        .logs[] | select(.topics[0] == $e or .topics[0] == $b) | .data' <<<"$receipt" \
        | head -1 | sed 's/^0x//' | cut -c25-64)"

    if [[ -z "$addr" ]]; then
        echo "$hash  -> no EquityDeployed/BondDeployed log (did it revert?)"
        continue
    fi

    addr="0x$addr"
    symbol="$(cast call "$addr" 'symbol()(string)' --rpc-url "$RPC" 2>/dev/null || echo '?')"
    echo "$symbol  $addr   ($hash)"
done

echo
echo "Record these in docs/ATS.md. A deployment nobody wrote down is a"
echo "deployment nobody can reproduce."
