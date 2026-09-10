// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";
import { MockUSDC } from "./mocks/MockSecurity.sol";

/**
 * A security that re-enters the market from inside its own transfer.
 *
 * An ATS security is a diamond with facets and transfer hooks, so "the token
 * calls back into you mid-transfer" is a real shape, not a contrived one. This
 * is the adversary the nonReentrant guard and the effects-before-interactions
 * ordering exist for.
 */
contract ReentrantSecurity is ERC20 {
    AtsEscrowMarket public market;
    uint256 public targetListing;
    bool public armed;
    bool public reenterAttempted;
    bytes public reenterRevertData;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(AtsEscrowMarket m, uint256 listingId) external {
        market = m;
        targetListing = listingId;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && address(market) != address(0)) {
            armed = false; // one shot
            reenterAttempted = true;
            try market.fill(targetListing) {
                // If this ever succeeds the guard has failed.
                reenterRevertData = hex"";
            } catch (bytes memory err) {
                reenterRevertData = err;
            }
        }
    }
}

contract ReentrancyTest is Test {
    AtsEscrowMarket market;
    ReentrantSecurity sec;
    MockUSDC usdc;

    address seller = makeAddr("seller");
    address buyer = makeAddr("buyer");

    function setUp() public {
        usdc = new MockUSDC();
        sec = new ReentrantSecurity();
        market = new AtsEscrowMarket(IERC20(address(usdc)));

        sec.mint(seller, 10_000_000);
        usdc.mint(buyer, 1_000_000_000);

        vm.prank(seller);
        sec.approve(address(market), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(market), type(uint256).max);
    }

    function test_reentrantSecurityCannotDoubleFill() public {
        vm.prank(seller);
        uint256 id = market.list(address(sec), 1_000_000, 25_000_000);

        // The security will call market.fill(id) from inside the fill's own
        // security transfer.
        sec.arm(market, id);

        uint256 buyerBefore = sec.balanceOf(buyer);
        vm.prank(buyer);
        market.fill(id);

        assertTrue(sec.reenterAttempted(), "the re-entrant path never ran; test proves nothing");
        assertTrue(sec.reenterRevertData().length > 0, "RE-ENTRANT FILL SUCCEEDED");

        // Exactly one lot delivered, once.
        assertEq(sec.balanceOf(buyer) - buyerBefore, 1_000_000, "double delivery");
        assertEq(sec.balanceOf(address(market)), 0, "escrow left over");
        assertEq(usdc.balanceOf(seller), 25_000_000, "seller paid more than once");
        assertEq(uint8(market.getListing(id).status), 2, "listing should be Filled");
    }
}
