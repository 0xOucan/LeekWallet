// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";

/**
 * Deploy the secondary market.
 *
 *   PAYMENT_TOKEN=0x...  forge script script/DeployMarket.s.sol:DeployMarket \
 *     --rpc-url https://testnet.hashio.io/api --account <keystore> --broadcast
 *
 * The payment token is read from the environment rather than hardcoded, because
 * pinning the wrong USDC is a mistake you only discover after the first fill
 * reverts. The script echoes the token's symbol and decimals before deploying
 * so a wrong address is obvious in the log, not three steps later.
 */
contract DeployMarket is Script {
    function run() external returns (AtsEscrowMarket market) {
        address paymentToken = vm.envAddress("PAYMENT_TOKEN");
        require(paymentToken != address(0), "PAYMENT_TOKEN unset");

        // Fail loudly here rather than in the constructor: if this address is
        // not a token, the deploy should stop before it costs anything.
        string memory sym = IERC20Metadata(paymentToken).symbol();
        uint8 dec = IERC20Metadata(paymentToken).decimals();
        console2.log("payment token :", paymentToken);
        console2.log("  symbol      :", sym);
        console2.log("  decimals    :", dec);

        vm.startBroadcast();
        market = new AtsEscrowMarket(IERC20(paymentToken));
        vm.stopBroadcast();

        console2.log("AtsEscrowMarket deployed at:", address(market));
        console2.log("");
        console2.log("NEXT, BEFORE ANY LISTING: confirm the market can receive the");
        console2.log("payment token. On Hedera an HTS token cannot be held by an");
        console2.log("unassociated account, and that failure is silent until a fill.");
        console2.log("Send it 1 unit of the payment token and check the balance.");
    }
}
