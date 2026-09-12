// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { LeekSecurityFactory } from "../src/LeekSecurityFactory.sol";

/**
 * Diagnostic only. Calls the deployed wrapper with the same arguments the
 * companion sent, to separate "our parameters are wrong" from "the ATS factory
 * refuses a contract as the caller".
 */
contract TryIssue is Script {
    function run() external {
        LeekSecurityFactory wrapper =
            LeekSecurityFactory(0x3a56974075d734aFa5BF7f63e34F9C3237408AeD);
        console2.log("calling wrapper.deployEquity ...");
        address a = wrapper.deployEquity("ROCKETPOCKET", "RCKPKT");
        console2.log("deployed", a);
    }
}
