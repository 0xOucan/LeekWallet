// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";
import { IAtsSecurity } from "./IAtsSecurity.sol";

/**
 * The two halves of one secondary-market trade, as two scripts.
 *
 * They are separate contracts on purpose. A fill by the seller reverts
 * (`SelfFill`), so the buy leg must run under a different key -- and a single
 * script cannot switch keystores mid-run. Two invocations with two `--account`
 * values is the honest shape of the thing, and it is also what proves the
 * escrow works: the shares leave one account and arrive in another, through a
 * contract that never checked whether either was allowed to hold them.
 *
 * ---------------------------------------------------------------------------
 * The decimals trap, defused by the interface rather than by a warning
 *
 * For the native leg `priceTotal` is in WEIBAR: `msg.value` on Hedera's EVM is
 * 18-decimal, while HBAR itself has 8. A price written in tinybar is off by
 * 1e10 -- it would list a 25 HBAR lot for 0.0000000025 HBAR, and it would
 * succeed. So the native path here takes `PRICE_HBAR`, a whole number of HBAR,
 * and does the multiplication itself. The ERC-20 path takes `PRICE_UNITS` in
 * the payment token's own base units, which the script prints alongside the
 * token's `decimals()` so a wrong power of ten is visible before it is sent.
 */
contract ListLot is Script {
    function run() external {
        AtsEscrowMarket market = AtsEscrowMarket(payable(vm.envAddress("MARKET")));
        IAtsSecurity security = IAtsSecurity(vm.envAddress("SECURITY"));
        uint256 shares = vm.envUint("SHARES");
        address seller = vm.envOr("SELLER", msg.sender);

        require(shares > 0, "SHARES must be positive");

        uint8 securityDecimals = security.decimals();
        uint256 amount = shares * (10 ** securityDecimals);

        uint256 priceTotal = _priceTotal(market);

        console2.log("market     :", address(market));
        console2.log("security   :", security.symbol(), address(security));
        console2.log("seller     :", seller);
        console2.log("lot        :", shares, "shares =", amount);
        console2.log("priceTotal :", priceTotal);
        console2.log("native leg :", market.IS_NATIVE());
        console2.log("");

        require(security.balanceOf(seller) >= amount, "seller does not hold that many shares");
        require(!security.paused(), "security is paused: list would revert");

        vm.startBroadcast();
        /* Approve the exact lot, never more. An approval left standing is an
         * open authorisation over a security, and the market has no owner who
         * could ever be asked to give it back. */
        security.approve(address(market), amount);
        uint256 listingId = market.list(address(security), amount, priceTotal);
        vm.stopBroadcast();

        console2.log("listing id (simulated):", listingId);
        console2.log("");
        console2.log("The id is the simulation's. Read the real one from the Listed");
        console2.log("event, or from `nextListingId() - 1` right after the send.");
    }

    /**
     * Price, in whatever the market settles in.
     *
     * Two env vars rather than one, so that a number meant for the wrong leg is
     * a missing-variable error instead of a thousand-fold mispricing.
     */
    function _priceTotal(AtsEscrowMarket market) internal view returns (uint256) {
        if (market.IS_NATIVE()) {
            uint256 priceHbar = vm.envUint("PRICE_HBAR");
            require(priceHbar > 0, "PRICE_HBAR must be positive");
            /* 1e18, not 1e8: msg.value is weibar. See the header. */
            return priceHbar * 1e18;
        }

        uint256 units = vm.envUint("PRICE_UNITS");
        require(units > 0, "PRICE_UNITS must be positive");
        console2.log("payment token decimals:", market.PAYMENT_DECIMALS());
        return units;
    }
}

/**
 * Buy a listed lot. Run this with a DIFFERENT `--account` than `ListLot`.
 *
 *   MARKET=0x... LISTING_ID=1 \
 *   forge script script/ListAndFill.s.sol:FillLot \
 *     --rpc-url https://testnet.hashio.io/api --account buyer --broadcast
 *
 * The buyer needs no permission from this contract and gets none: if the
 * security will not let them hold it, the security reverts and the fill reverts
 * with it, both legs together. That is the whole design -- see the header of
 * `AtsEscrowMarket.sol`.
 */
contract FillLot is Script {
    function run() external {
        AtsEscrowMarket market = AtsEscrowMarket(payable(vm.envAddress("MARKET")));
        uint256 listingId = vm.envUint("LISTING_ID");
        address buyer = vm.envOr("BUYER", msg.sender);

        AtsEscrowMarket.Listing memory listing = market.getListing(listingId);
        require(listing.status == AtsEscrowMarket.Status.Open, "listing is not Open");
        require(listing.seller != buyer, "buyer is the seller: fill would revert SelfFill");

        console2.log("market     :", address(market));
        console2.log("listing    :", listingId);
        console2.log("  seller   :", listing.seller);
        console2.log("  security :", listing.security);
        console2.log("  amount   :", listing.amount);
        console2.log("  price    :", listing.priceTotal);
        console2.log("buyer      :", buyer);
        console2.log("");

        if (market.IS_NATIVE()) {
            require(buyer.balance >= listing.priceTotal, "buyer cannot cover priceTotal in weibar");
            vm.startBroadcast();
            market.fill{ value: listing.priceTotal }(listingId);
            vm.stopBroadcast();
        } else {
            IERC20 payment = market.PAYMENT_TOKEN();
            require(
                payment.balanceOf(buyer) >= listing.priceTotal, "buyer does not hold enough of the payment token"
            );
            vm.startBroadcast();
            /* Exact approval, and only for this fill. The market pulls payment
             * straight from buyer to seller and never holds it in between. */
            payment.approve(address(market), listing.priceTotal);
            market.fill(listingId);
            vm.stopBroadcast();
        }

        console2.log("filled. Confirm on chain, not here:");
        console2.log("  cast call <security> 'balanceOf(address)(uint256)' <buyer>");
        console2.log("  cast call <market> 'getListing(uint256)' <id>   # status must read 2 (Filled)");
    }
}
