// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";
import { GateToken } from "../src/GateToken.sol";

/// @title DeployGateToken
/// @notice Deploys the gate token whose holder is permitted to fill the Aqua
///         positions of ../docs/STRATEGIES.md.
///
/// @dev The holder is read from the `GATE_HOLDER` environment variable rather
///      than defaulted to `msg.sender`. They are usually the same address here
///      — the deployer is also the taker — but "usually" is how a deploy
///      script eventually mints a gate to the wrong account, and the whole
///      supply is unrecoverable if it goes to an address nobody controls.
///      There is no mint. Name it explicitly or the script does not run.
///
///      Run with `--account`, never with a private key on the command line:
///      a key in argv is a key in the shell history, in the process table, and
///      in any log the shell writes.
///
///          cast wallet import base-deployer --interactive
///          forge script script/DeployGateToken.s.sol \
///            --rpc-url "$BASE_RPC" --account base-deployer \
///            --broadcast --verify
contract DeployGateToken is Script {
    function run() external returns (GateToken token) {
        address holder = vm.envAddress("GATE_HOLDER");

        /* A supply of exactly 1 would work -- opcode 14 only tests for
         * non-zero -- but it leaves no room to hand a unit to a second taker
         * without giving up the gate. 1000 units of a 0-decimal credential is
         * still a credential, and it costs nothing. */
        uint256 supply = vm.envOr("GATE_SUPPLY", uint256(1000));

        vm.startBroadcast();
        token = new GateToken(holder, supply);
        vm.stopBroadcast();

        console.log("GateToken      :", address(token));
        console.log("holder         :", holder);
        console.log("supply         :", supply);
        console.log("holder balance :", token.balanceOf(holder));
        console.log("");
        console.log("This address is the argument to SwapVM opcode 14 in every");
        console.log("program built by app/packages/apps/aqua/src/authoring.ts.");
        console.log("Pass it as GATE_TOKEN when planning a position.");
    }
}
