// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";
import { MockSecurity, MockUSDC } from "./mocks/MockSecurity.sol";

contract AtsEscrowMarketTest is Test {
    AtsEscrowMarket market;
    MockSecurity sec;
    MockUSDC usdc;

    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");
    address stranger = makeAddr("stranger");

    uint256 constant LOT = 1_000_000;      // 1.0 share at 6 decimals
    uint256 constant PRICE = 25_000_000;   // 25.00 USDC

    function setUp() public {
        usdc = new MockUSDC();
        sec = new MockSecurity(6);
        market = new AtsEscrowMarket(IERC20(address(usdc)));

        sec.mint(seller, 100 * LOT);
        usdc.mint(buyer, 1_000_000_000);

        vm.prank(seller);
        sec.approve(address(market), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function _list() internal returns (uint256 id) {
        vm.prank(seller);
        id = market.list(address(sec), LOT, PRICE);
    }

    /* ------------------------------------------------------- the happy path */

    function test_listEscrowsAndFillSettlesBothLegs() public {
        uint256 id = _list();
        assertEq(sec.balanceOf(address(market)), LOT, "not escrowed");

        uint256 sellerUsdcBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        market.fill(id);

        assertEq(sec.balanceOf(buyer), LOT, "buyer did not receive the security");
        assertEq(usdc.balanceOf(seller), sellerUsdcBefore + PRICE, "seller was not paid");
        assertEq(sec.balanceOf(address(market)), 0, "security stranded in the market");
        assertEq(usdc.balanceOf(address(market)), 0, "THE MARKET HELD PAYMENT AFTER A FILL");
    }

    /* ---------------------------------- THE PROPERTY: compliance is the security's */

    function test_THE_PROPERTY_frozenBuyerCannotFill_andNothingMoves() public {
        uint256 id = _list();
        sec.setFrozen(buyer, true);

        uint256 buyerUsdc = usdc.balanceOf(buyer);
        uint256 sellerUsdc = usdc.balanceOf(seller);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MockSecurity.AddressFrozen.selector, buyer));
        market.fill(id);

        // Both legs unwound: the payment did NOT happen either.
        assertEq(usdc.balanceOf(buyer), buyerUsdc, "buyer paid despite a refused transfer");
        assertEq(usdc.balanceOf(seller), sellerUsdc, "seller was paid for a trade that did not settle");
        assertEq(sec.balanceOf(address(market)), LOT, "escrow disturbed by a failed fill");
        assertEq(uint8(market.getListing(id).status), 1, "listing should still be Open");
    }

    function test_buyerWithoutKycCannotFill_andCanOnceGranted() public {
        uint256 id = _list();
        sec.setKycRequired(true);
        sec.setKyc(seller, true);
        sec.setKyc(address(market), true);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MockSecurity.KycMissing.selector, buyer));
        market.fill(id);

        // The issuer grants KYC; the same trade now settles.
        sec.setKyc(buyer, true);
        vm.prank(buyer);
        market.fill(id);
        assertEq(sec.balanceOf(buyer), LOT, "grant did not unblock the trade");
    }

    function test_pausedSecurityBlocksEverything() public {
        uint256 id = _list();
        sec.setPaused(true);
        vm.prank(buyer);
        vm.expectRevert(MockSecurity.SecurityPaused.selector);
        market.fill(id);
    }

    /* --------------------------------------- escrow's documented consequence */

    function test_frozenSellerCannotCancel_sharesStayEscrowed() public {
        uint256 id = _list();
        sec.setFrozen(seller, true);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(MockSecurity.AddressFrozen.selector, seller));
        market.cancel(id);

        // Documented, not a bug: recovery is the issuer's controllerTransfer.
        assertEq(sec.balanceOf(address(market)), LOT, "shares should remain escrowed");
    }

    /* --------------------------------------------------- lifecycle and access */

    function test_cancelReturnsAndClosesTheListing() public {
        uint256 id = _list();
        vm.prank(seller);
        market.cancel(id);
        assertEq(sec.balanceOf(seller), 100 * LOT, "shares not returned");
        assertEq(uint8(market.getListing(id).status), 3, "not Cancelled");
    }

    function test_onlySellerCanCancel() public {
        uint256 id = _list();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.NotSeller.selector, id, stranger));
        market.cancel(id);
    }

    function test_aFilledListingCannotBeFilledOrCancelledAgain() public {
        uint256 id = _list();
        vm.prank(buyer);
        market.fill(id);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.NotOpen.selector, id));
        market.fill(id);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.NotOpen.selector, id));
        market.cancel(id);
    }

    function test_aCancelledListingCannotBeFilled() public {
        uint256 id = _list();
        vm.prank(seller);
        market.cancel(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.NotOpen.selector, id));
        market.fill(id);
    }

    function test_sellerCannotFillTheirOwnListing() public {
        uint256 id = _list();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.SelfFill.selector, id));
        market.fill(id);
    }

    /* ------------------------------------------------------ input validation */

    function test_rejectsZeroInputs() public {
        vm.startPrank(seller);
        vm.expectRevert(AtsEscrowMarket.ZeroAddress.selector);
        market.list(address(0), LOT, PRICE);
        vm.expectRevert(AtsEscrowMarket.ZeroAmount.selector);
        market.list(address(sec), 0, PRICE);
        vm.expectRevert(AtsEscrowMarket.ZeroPrice.selector);
        market.list(address(sec), LOT, 0);
        vm.stopPrank();
    }

    function test_decimalsAreReadNotAssumed() public view {
        assertEq(market.PAYMENT_DECIMALS(), 6, "payment decimals not read from the token");
    }

    /* ----------------------------------------------------------------- fuzz */

    function testFuzz_fillIsAllOrNothing(uint96 amount, uint96 price) public {
        amount = uint96(bound(amount, 1, 100 * LOT));
        price = uint96(bound(price, 1, 1_000_000_000));

        vm.prank(seller);
        uint256 id = market.list(address(sec), amount, price);

        uint256 buyerSecBefore = sec.balanceOf(buyer);
        uint256 sellerUsdcBefore = usdc.balanceOf(seller);

        vm.prank(buyer);
        market.fill(id);

        assertEq(sec.balanceOf(buyer), buyerSecBefore + amount, "security leg wrong");
        assertEq(usdc.balanceOf(seller), sellerUsdcBefore + price, "payment leg wrong");
        assertEq(usdc.balanceOf(address(market)), 0, "market retained payment");
        assertEq(sec.balanceOf(address(market)), 0, "market retained security");
    }

    function testFuzz_escrowMatchesWhatArrived(uint96 amount) public {
        amount = uint96(bound(amount, 1, 100 * LOT));
        vm.prank(seller);
        uint256 id = market.list(address(sec), amount, PRICE);
        assertEq(market.getListing(id).amount, amount, "listing amount != measured escrow");
        assertEq(sec.balanceOf(address(market)), amount, "escrow != listing amount");
    }
}
