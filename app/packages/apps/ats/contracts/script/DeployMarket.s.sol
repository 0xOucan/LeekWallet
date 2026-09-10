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
 * Native HBAR settlement (the default, and the one that works today):
 *
 *   PAYMENT_TOKEN=0x0000000000000000000000000000000000000000 \
 *     forge script script/DeployMarket.s.sol:DeployMarket \
 *     --rpc-url https://testnet.hashio.io/api --account hedera-deployer --broadcast
 *
 * An HTS/ERC-20 payment token, if you have one you actually hold:
 *
 *   PAYMENT_TOKEN=0x...  (same command)
 *
 * ---------------------------------------------------------------------------
 * Why the native leg is the default here
 *
 * On Hedera an HTS token cannot be received by an account that has not
 * associated with it. Not "is discouraged from" -- cannot. That is why the
 * faucet delivered nothing to any of this project's accounts, and it is why a
 * market pinned to a token nobody holds is a market that can never settle.
 *
 * HBAR needs no association. `PAYMENT_TOKEN == address(0)` selects it, and the
 * contract then skips both the metadata call and the `associateToken` call
 * because neither has anything to do. Prefer it unless you have confirmed a
 * balance of a specific token in a specific account.
 *
 * The payment token is immutable in the deployed market. Choosing it is the one
 * decision here that cannot be revised afterwards, so this script prints what
 * it is about to pin -- symbol and decimals for a token, an explicit statement
 * for native -- before it deploys, and a wrong address is visible in the log
 * rather than three steps later.
 */
contract DeployMarket is Script {
    function run() external returns (AtsEscrowMarket market) {
        /* Required, with no default, deliberately. A market whose settlement
         * asset was chosen by an omitted environment variable is a market
         * nobody decided about. */
        address paymentToken = vm.envAddress("PAYMENT_TOKEN");

        if (paymentToken == address(0)) {
            console2.log("payment leg : NATIVE HBAR");
            console2.log("  priceTotal is denominated in TINYBAR (1 HBAR = 1e8).");
            console2.log("  The tx value field is weibar, but Hedera converts it:");
            console2.log("  msg.value arrives in tinybar. PAYMENT_DECIMALS reports 8.");
            console2.log("  HTS association does not apply to HBAR and is skipped.");
        } else {
            // Fail loudly here rather than in the constructor: if this address is
            // not a token, the deploy should stop before it costs anything.
            string memory sym = IERC20Metadata(paymentToken).symbol();
            uint8 dec = IERC20Metadata(paymentToken).decimals();
            console2.log("payment leg : ERC-20 / HTS");
            console2.log("  token     :", paymentToken);
            console2.log("  symbol    :", sym);
            console2.log("  decimals  :", dec);
        }

        vm.startBroadcast();
        market = new AtsEscrowMarket(IERC20(paymentToken));
        vm.stopBroadcast();

        console2.log("");
        console2.log("AtsEscrowMarket deployed at (SIMULATED address):", address(market));
        console2.log("Read the real one from the broadcast receipt.");
        console2.log("");

        if (paymentToken == address(0)) {
            console2.log("Native leg: no association step. The market can receive HBAR");
            console2.log("as soon as it exists. Go straight to listing.");
        } else {
            console2.log("NEXT, BEFORE ANY LISTING: confirm the market can receive the");
            console2.log("payment token. On Hedera an HTS token cannot be held by an");
            console2.log("unassociated account, and that failure is silent until a fill.");
            console2.log("Send it 1 unit of the payment token and check the balance.");
            console2.log("No local test covers this: a local chain has no code at 0x167.");
        }
    }
}
