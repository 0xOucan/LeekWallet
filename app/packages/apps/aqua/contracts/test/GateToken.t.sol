// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { GateToken } from "../src/GateToken.sol";

/// @dev A holder that reverts on any call, used to show there is no callback
///      surface: transferring to it must still succeed, because GateToken
///      makes no external call at all. If a hook were ever added, this test is
///      where it would first be noticed.
contract HostileHolder {
    fallback() external payable { revert("no"); }
}

contract GateTokenTest is Test {
    GateToken internal token;

    address internal constant TAKER = address(0xBEEF);
    address internal constant OTHER = address(0xCAFE);
    uint256 internal constant SUPPLY = 1000;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setUp() public {
        token = new GateToken(TAKER, SUPPLY);
    }

    /* ------------------------------------------------------------ the mint */

    function test_supplyIsMintedOnceToTheHolder() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(TAKER), SUPPLY);
        assertEq(token.balanceOf(OTHER), 0);
    }

    function test_mintIsObservableFromTheZeroAddress() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), TAKER, SUPPLY);
        new GateToken(TAKER, SUPPLY);
    }

    function test_constructorRefusesTheZeroHolder() public {
        vm.expectRevert(GateToken.ZeroAddress.selector);
        new GateToken(address(0), SUPPLY);
    }

    function test_constructorRefusesAZeroSupply() public {
        /* A gate token nobody can hold gates the position shut forever, and
         * there is no mint to recover with. */
        vm.expectRevert();
        new GateToken(TAKER, 0);
    }

    /* ----------------------------------------- what opcode 14 actually reads */

    function test_theGateIsExactlyBalanceNonZero() public {
        /* Opcode 14 tests `balanceOf(taker) != 0` and nothing else, so this is
         * the only property of this token that has any effect on chain. */
        assertTrue(token.balanceOf(TAKER) != 0, "holder passes the gate");
        assertFalse(token.balanceOf(OTHER) != 0, "a non-holder does not");

        vm.prank(TAKER);
        token.transfer(OTHER, 1);
        assertTrue(token.balanceOf(OTHER) != 0, "one unit is enough");
        assertTrue(token.balanceOf(TAKER) != 0, "and the holder still passes");
    }

    function test_decimalsAreZeroBecauseThisIsACredential() public view {
        assertEq(token.decimals(), 0);
    }

    /* -------------------------------------------------------------- transfer */

    function test_transferMovesBalanceAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(TAKER, OTHER, 40);
        vm.prank(TAKER);
        assertTrue(token.transfer(OTHER, 40));
        assertEq(token.balanceOf(TAKER), SUPPLY - 40);
        assertEq(token.balanceOf(OTHER), 40);
    }

    function test_transferRefusesTheZeroAddressRatherThanBurning() public {
        /* A burn would drop the circulating supply while totalSupply stayed
         * constant, breaking the invariant the whole audit rests on. */
        vm.prank(TAKER);
        vm.expectRevert(GateToken.ZeroAddress.selector);
        token.transfer(address(0), 1);
    }

    function test_transferRefusesMoreThanTheBalance() public {
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(GateToken.InsufficientBalance.selector, 0, 1));
        token.transfer(TAKER, 1);
    }

    function test_selfTransferIsANoOp() public {
        /* The credit reads back the freshly written debit, so from == to must
         * leave the balance untouched rather than doubling or zeroing it. */
        vm.prank(TAKER);
        token.transfer(TAKER, SUPPLY);
        assertEq(token.balanceOf(TAKER), SUPPLY);
    }

    function test_zeroValueTransferIsPermittedAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(TAKER, OTHER, 0);
        vm.prank(TAKER);
        assertTrue(token.transfer(OTHER, 0));
    }

    function test_transferMakesNoExternalCall() public {
        /* The recipient reverts on every call it receives. The transfer must
         * still succeed, which is only possible because there is no hook. */
        HostileHolder hostile = new HostileHolder();
        vm.prank(TAKER);
        assertTrue(token.transfer(address(hostile), 5));
        assertEq(token.balanceOf(address(hostile)), 5);
    }

    /* ----------------------------------------------------------- allowance */

    function test_transferFromSpendsTheAllowance() public {
        vm.prank(TAKER);
        token.approve(OTHER, 100);
        vm.prank(OTHER);
        assertTrue(token.transferFrom(TAKER, OTHER, 60));
        assertEq(token.allowance(TAKER, OTHER), 40);
        assertEq(token.balanceOf(OTHER), 60);
    }

    function test_transferFromRefusesBeyondTheAllowance() public {
        vm.prank(TAKER);
        token.approve(OTHER, 10);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(GateToken.InsufficientAllowance.selector, 10, 11));
        token.transferFrom(TAKER, OTHER, 11);
    }

    function test_anInfiniteAllowanceIsStillDecremented() public {
        /* Deliberately NOT special-cased. Every other ERC-20 skips the
         * decrement at type(uint256).max as a gas optimisation, which also
         * makes an unlimited approval cheaper to live with. This repository's
         * position is that an unlimited approval is never the right answer, so
         * nothing here is built to make one convenient. */
        vm.prank(TAKER);
        token.approve(OTHER, type(uint256).max);
        vm.prank(OTHER);
        token.transferFrom(TAKER, OTHER, 7);
        assertEq(token.allowance(TAKER, OTHER), type(uint256).max - 7);
    }

    function test_approveRefusesTheZeroSpender() public {
        vm.prank(TAKER);
        vm.expectRevert(GateToken.ZeroAddress.selector);
        token.approve(address(0), 1);
    }

    function test_approveEmitsAndOverwrites() public {
        vm.prank(TAKER);
        token.approve(OTHER, 5);
        vm.expectEmit(true, true, false, true);
        emit Approval(TAKER, OTHER, 9);
        vm.prank(TAKER);
        token.approve(OTHER, 9);
        assertEq(token.allowance(TAKER, OTHER), 9, "set, not incremented");
    }

    /* ------------------------------------------------- there is no admin */

    function test_thereIsNoWayToChangeTheSupply() public view {
        /* Asserted by absence: the ABI has no mint, burn, owner or upgrade
         * entry point, so the only statement to make about the supply is that
         * it is immutable, and the only way to break it would be to add a
         * function -- which would change this contract's bytecode and this
         * test would then be sitting next to the diff that did it. */
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_theContractCannotReceiveEth() public {
        /* No receive, no payable fallback. Value sent to it is refused rather
         * than stranded. */
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(token).call{ value: 1 wei }("");
        assertFalse(ok, "the token must not accept ETH");
    }

    /* ---------------------------------------------------------------- fuzz */

    function testFuzz_supplyIsConservedAcrossAnyTransfer(
        address to, uint256 value, uint256 supply
    ) public {
        supply = bound(supply, 1, type(uint128).max);
        value = bound(value, 0, supply);
        vm.assume(to != address(0));

        GateToken t = new GateToken(TAKER, supply);
        vm.prank(TAKER);
        t.transfer(to, value);

        /* The invariant the audit rests on: balances only ever move, so their
         * sum is totalSupply. Written to handle to == TAKER, where the two
         * balances are the same slot and must not be double-counted. */
        uint256 sum = to == TAKER ? t.balanceOf(TAKER) : t.balanceOf(TAKER) + t.balanceOf(to);
        assertEq(sum, t.totalSupply(), "supply conserved");
        assertEq(t.totalSupply(), supply, "supply unchanged");
    }

    function testFuzz_transferFromNeverSpendsMoreThanApproved(
        uint256 approved, uint256 spend
    ) public {
        approved = bound(approved, 0, SUPPLY);
        spend = bound(spend, 0, SUPPLY);

        vm.prank(TAKER);
        token.approve(OTHER, approved);
        vm.prank(OTHER);
        if (spend > approved) {
            vm.expectRevert();
            token.transferFrom(TAKER, OTHER, spend);
            assertEq(token.allowance(TAKER, OTHER), approved, "allowance untouched on revert");
        } else {
            token.transferFrom(TAKER, OTHER, spend);
            assertEq(token.allowance(TAKER, OTHER), approved - spend);
            assertEq(token.balanceOf(OTHER), spend);
        }
    }
}
