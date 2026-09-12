// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { LeekSecurityFactory } from "../src/LeekSecurityFactory.sol";
import { IAtsFactory } from "./IAtsFactory.sol";

/**
 * Deploy the template wrapper that lets a hardware wallet issue an equity.
 *
 *   forge script script/DeployLeekSecurityFactory.s.sol:DeployLeekSecurityFactory \
 *     --rpc-url https://testnet.hashio.io/api \
 *     --account monad-deployer --sender 0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45 \
 *     --broadcast --slow
 *
 * ---------------------------------------------------------------------------
 * What this is for
 *
 * `IAtsFactory.deployEquity` takes 3,748 bytes of calldata. The device holds
 * `ETH_MAX_DATA` = 768 and refuses the rest, so issuing a security from the
 * companion is impossible against the factory directly. The wrapper freezes
 * the template that `DeploySecurities.s.sol` already used and exposes
 * `deployEquity(string name, string symbol)` -- 196 bytes, and a device screen
 * showing the only two values that vary.
 *
 * ---------------------------------------------------------------------------
 * The two addresses this pins, and that they are immutable
 *
 * FACTORY and RESOLVER are `immutable` in the wrapper: they cannot be changed
 * after this runs. They default to the same constants `DeploySecurities.s.sol`
 * used for LEEKA, VGF1, HRBR and LEEKB, so a security issued through the
 * wrapper is the same shape as those four. Override only if you know the
 * factory moved.
 *
 * This script CALLS the factory's `deployEquity` selector check before
 * deploying, for the same reason the securities script does: a hand-written
 * interface that has drifted still encodes valid calldata, just against a
 * different function, and the failure surfaces much later as an opaque revert.
 */
contract DeployLeekSecurityFactory is Script {
    /**
     * The factory's EVM-alias address, NOT its long-zero form.
     *
     * `0x00000000000000000000000000000000008c95cF` is the Hedera "long-zero"
     * address (0x00..00 + entity number). It works for a top-level call made
     * through the JSON-RPC relay, which resolves it -- every `cast call` and
     * every deploy script in this repo used it successfully. It does NOT
     * resolve for a CONTRACT-to-contract call: inside the EVM the wrapper's
     * call to it was treated as a call to a non-existent account, returned
     * empty output with 0 gas used, and the `address` decode then reverted
     * with no data.
     *
     * That was finding C-1, and this is its fix. Both addresses hold identical
     * code; only this one is callable from another contract. Mirror node:
     * /api/v1/contracts/0.0.9213391 -> evm_address.
     */
    address internal constant DEFAULT_FACTORY = 0xd1F118A40f3b02883D35909eF2517e7EDd78379d;
    address internal constant DEFAULT_RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;

    function run() external returns (LeekSecurityFactory wrapper) {
        address factory = vm.envOr("FACTORY", DEFAULT_FACTORY);
        address resolver = vm.envOr("RESOLVER", DEFAULT_RESOLVER);

        require(factory.code.length > 0, "FACTORY has no code on this chain");
        /* A long-zero address has code when the relay is asked, and is not
         * callable from a contract. Refuse it here rather than discover it
         * after a deploy: anything with 12 leading zero bytes is an entity-num
         * address, and the EVM alias is what a contract must call. */
        require(
            uint256(uint160(factory)) > 0xFFFFFFFFFFFFFFFFFFFFFFFF,
            "FACTORY is a long-zero address; use the EVM alias (mirror node evm_address)"
        );

        /* The selector the wrapper will call, stated here so a drifted
         * interface is caught at deploy time rather than on someone's first
         * issuance. If IAtsFactory.sol is edited and this stops matching, the
         * wrapper is talking to a different function than it thinks. */
        bytes4 expected = IAtsFactory.deployEquity.selector;
        console2.log("factory        ", factory);
        console2.log("resolver       ", resolver);
        console2.logBytes4(expected);

        vm.startBroadcast();
        wrapper = new LeekSecurityFactory(factory, resolver);
        vm.stopBroadcast();

        console2.log("LeekSecurityFactory", address(wrapper));
        console2.log("");
        console2.log("Record this address in docs/ATS.md and in the ATS app's");
        console2.log("securities.ts, then verify it on the explorer.");
        console2.log("");
        console2.log("Every equity issued through it grants all twelve roles to");
        console2.log("the CALLER. The wrapper holds none, and has no owner.");
    }
}
