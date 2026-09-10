// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";
import { MockSecurity } from "./mocks/MockSecurity.sol";

/// A seller that refuses native transfers, to prove the fill fails cleanly.
contract RejectingSeller {
    function approveSec(MockSecurity s, address spender) external {
        s.approve(spender, type(uint256).max);
    }

    function doList(AtsEscrowMarket m, address sec, uint256 amt, uint256 price) external returns (uint256) {
        return m.list(sec, amt, price);
    }
    // no receive() and no fallback: native transfers to this address revert
}

contract NativePaymentTest is Test {
    AtsEscrowMarket market;
    MockSecurity sec;

    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");

    uint256 constant LOT = 1_000_000;        // 1.0 share, 6 dp
    uint256 constant PRICE = 3 * 1e8;        // 3 HBAR, in TINYBAR (8 dp)

    function setUp() public {
        sec = new MockSecurity(6);
        // address(0) selects the native leg
        market = new AtsEscrowMarket(IERC20(address(0)));

        sec.mint(seller, 100 * LOT);
        vm.deal(buyer, 100 ether);

        vm.prank(seller);
        sec.approve(address(market), type(uint256).max);
    }

    function _list() internal returns (uint256 id) {
        vm.prank(seller);
        id = market.list(address(sec), LOT, PRICE);
    }

    function test_nativeMarketNeedsNoTokenAndReportsTinybarDecimals() public view {
        assertTrue(market.IS_NATIVE(), "should be native");
        assertEq(address(market.PAYMENT_TOKEN()), address(0), "payment token should be unset");
        /* 8, not 18. The transaction's value field is weibar, but Hedera's
         * relay converts it and msg.value arrives in TINYBAR. This assertion
         * read 18 until a real fill on Hedera testnet reverted
         * WrongPayment(2500000000, 25000000000000000000) -- exactly 1e10 apart.
         * The test agreed with the bug, which is why it did not catch it: a
         * local EVM has no relay to do the conversion. */
        assertEq(market.PAYMENT_DECIMALS(), 8, "native leg must report tinybar decimals");
    }

    function test_fillSettlesBothLegsInHbar() public {
        uint256 id = _list();
        uint256 sellerBefore = seller.balance;

        vm.prank(buyer);
        market.fill{ value: PRICE }(id);

        assertEq(sec.balanceOf(buyer), LOT, "buyer did not receive the security");
        assertEq(seller.balance, sellerBefore + PRICE, "seller was not paid");
        assertEq(address(market).balance, 0, "THE MARKET RETAINED HBAR");
        assertEq(sec.balanceOf(address(market)), 0, "escrow left over");
    }

    function test_wrongValueIsRefused_bothDirections() public {
        uint256 id = _list();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.WrongPayment.selector, PRICE - 1, PRICE));
        market.fill{ value: PRICE - 1 }(id);

        // Overpayment is refused too: no silent keep, no refund call.
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AtsEscrowMarket.WrongPayment.selector, PRICE + 1, PRICE));
        market.fill{ value: PRICE + 1 }(id);

        assertEq(address(market).balance, 0, "market kept value from a failed fill");
        assertEq(uint8(market.getListing(id).status), 1, "listing should still be Open");
    }

    function test_frozenBuyerCannotFill_andKeepsTheirHbar() public {
        uint256 id = _list();
        sec.setFrozen(buyer, true);

        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MockSecurity.AddressFrozen.selector, buyer));
        market.fill{ value: PRICE }(id);

        assertEq(buyer.balance, buyerBefore, "buyer lost HBAR on a refused trade");
        assertEq(address(market).balance, 0, "market retained HBAR");
    }

    function test_sellerThatCannotReceiveMakesTheFillRevertCleanly() public {
        RejectingSeller rs = new RejectingSeller();
        sec.mint(address(rs), 10 * LOT);
        rs.approveSec(sec, address(market));
        uint256 id = rs.doList(market, address(sec), LOT, PRICE);

        uint256 buyerBefore = buyer.balance;
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(AtsEscrowMarket.NativeTransferFailed.selector, address(rs), PRICE)
        );
        market.fill{ value: PRICE }(id);

        assertEq(buyer.balance, buyerBefore, "buyer paid for a trade that could not settle");
        assertEq(sec.balanceOf(address(market)), LOT, "escrow disturbed");
    }

    function testFuzz_nativeFillIsAllOrNothing(uint96 amount, uint96 price) public {
        amount = uint96(bound(amount, 1, 100 * LOT));
        price = uint96(bound(price, 1, 50 ether));

        vm.prank(seller);
        uint256 id = market.list(address(sec), amount, price);

        uint256 sellerBefore = seller.balance;
        vm.deal(buyer, uint256(price) + 1 ether);
        vm.prank(buyer);
        market.fill{ value: price }(id);

        assertEq(sec.balanceOf(buyer), amount, "security leg wrong");
        assertEq(seller.balance, sellerBefore + price, "payment leg wrong");
        assertEq(address(market).balance, 0, "market retained value");
    }
}
