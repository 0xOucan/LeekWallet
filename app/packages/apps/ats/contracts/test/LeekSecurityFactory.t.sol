// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { LeekSecurityFactory } from "../src/LeekSecurityFactory.sol";
import { IAtsFactory, AtsRoles } from "../script/IAtsFactory.sol";

/** Records what it was asked to deploy, so the template can be asserted. */
contract FactorySpy {
    IAtsFactory.EquityData public lastEquity;
    address public lastSender;
    address public next = address(uint160(0xBEEF));

    string public lastName;
    string public lastSymbol;
    string public lastIsin;
    uint256 public lastMaxSupply;
    uint8 public lastDecimals;
    uint256 public rbacCount;
    bool public lastIsWhiteList;
    bool public lastIsMultiPartition;
    bool public lastIsControllable;
    address[] public rbacMember0;
    bytes32[] public rbacRoles;
    uint256 public calls;

    function setNext(address a) external { next = a; }

    uint256 public lastMaturity;
    uint256 public lastStarting;
    bytes32 public lastConfigKey;

    function deployBond(
        IAtsFactory.BondData calldata bondData,
        IAtsFactory.FactoryRegulationData calldata
    ) external returns (address) {
        calls++;
        lastSender = msg.sender;
        lastName = bondData.security.erc20MetadataInfo.name;
        lastSymbol = bondData.security.erc20MetadataInfo.symbol;
        lastIsin = bondData.security.erc20MetadataInfo.isin;
        lastMaxSupply = bondData.security.maxSupply;
        lastConfigKey = bondData.security.resolverProxyConfiguration.key;
        lastStarting = bondData.bondDetails.startingDate;
        lastMaturity = bondData.bondDetails.maturityDate;
        rbacCount = bondData.security.rbacs.length;
        delete rbacMember0;
        delete rbacRoles;
        for (uint256 i; i < bondData.security.rbacs.length; ++i) {
            rbacRoles.push(bondData.security.rbacs[i].role);
            rbacMember0.push(bondData.security.rbacs[i].members[0]);
        }
        return next;
    }

    function deployEquity(
        IAtsFactory.EquityData calldata equityData,
        IAtsFactory.FactoryRegulationData calldata
    ) external returns (address) {
        calls++;
        lastSender = msg.sender;
        lastName = equityData.security.erc20MetadataInfo.name;
        lastSymbol = equityData.security.erc20MetadataInfo.symbol;
        lastIsin = equityData.security.erc20MetadataInfo.isin;
        lastDecimals = equityData.security.erc20MetadataInfo.decimals;
        lastMaxSupply = equityData.security.maxSupply;
        lastIsWhiteList = equityData.security.isWhiteList;
        lastConfigKey = equityData.security.resolverProxyConfiguration.key;
        lastIsMultiPartition = equityData.security.isMultiPartition;
        lastIsControllable = equityData.security.isControllable;
        rbacCount = equityData.security.rbacs.length;
        delete rbacMember0;
        delete rbacRoles;
        for (uint256 i; i < equityData.security.rbacs.length; ++i) {
            rbacRoles.push(equityData.security.rbacs[i].role);
            rbacMember0.push(equityData.security.rbacs[i].members[0]);
        }
        return next;
    }
}

contract LeekSecurityFactoryTest is Test {
    LeekSecurityFactory internal lek;
    FactorySpy internal spy;
    address internal constant RESOLVER = address(uint160(0xA11CE));
    address internal constant ISSUER = address(uint160(0x1551E4));

    function setUp() public {
        spy = new FactorySpy();
        lek = new LeekSecurityFactory(address(spy), RESOLVER);
    }

    /* ------------------------------------------------------------ the ISIN */

    /**
     * The one test that can actually fail if the doubling runs the wrong way.
     *
     * US0378331005 is Apple's published ISIN. U=30, S=28, so the body expands
     * to "3028" + "037833100" and the check digit is 5. Driving our own
     * generator with our own expectation would pass either way round.
     */
    function test_checkDigit_matchesPublishedIsin() public view {
        assertEq(lek.checkDigit(bytes("3028037833100")), 5, "US0378331005");
    }

    /** A second published one, different parity, so it is not a coincidence. */
    function test_checkDigit_secondPublishedIsin() public view {
        // GB0002634946 (BAE Systems): G=16, B=11 -> "1611" + "000263494", check 6.
        assertEq(lek.checkDigit(bytes("1611000263494")), 6, "GB0002634946");
    }

    function test_isin_isTwelveCharsAndZzPrefixed() public {
        lek.deployEquity("Leek Test", "LEEKT");
        string memory isin = spy.lastIsin();
        assertEq(bytes(isin).length, 12, "ISIN length");
        assertEq(bytes(isin)[0], "Z", "country 0");
        assertEq(bytes(isin)[1], "Z", "country 1");
    }

    /** Its own check digit must validate under the same rule. */
    function test_isin_checkDigitIsSelfConsistent() public {
        lek.deployEquity("Leek Test", "LEEKT");
        bytes memory isin = bytes(spy.lastIsin());
        bytes memory digits = new bytes(13);
        digits[0] = "3"; digits[1] = "5"; digits[2] = "3"; digits[3] = "5";
        for (uint256 i; i < 9; ++i) digits[4 + i] = isin[2 + i];
        assertEq(uint8(isin[11]) - 48, lek.checkDigit(digits), "self-consistent");
    }

    function test_isin_isUniquePerDeployment() public {
        lek.deployEquity("One", "ONE");
        string memory a = spy.lastIsin();
        lek.deployEquity("Two", "TWO");
        string memory b = spy.lastIsin();
        assertTrue(
            keccak256(bytes(a)) != keccak256(bytes(b)),
            "two deployments produced the same ISIN"
        );
    }

    /* ---------------------------------------------------------- the template */

    function test_allTwelveRolesGoToCaller() public {
        vm.prank(ISSUER);
        lek.deployEquity("Leek Test", "LEEKT");

        assertEq(spy.rbacCount(), 12, "role count");
        for (uint256 i; i < 12; ++i) {
            assertEq(spy.rbacMember0(i), ISSUER, "role member is not the caller");
        }
        // The roles themselves, in the order the deployment script used.
        assertEq(spy.rbacRoles(0), AtsRoles.DEFAULT_ADMIN, "DEFAULT_ADMIN");
        assertEq(spy.rbacRoles(1), AtsRoles.ISSUER, "ISSUER");
        assertEq(spy.rbacRoles(11), AtsRoles.LOCKER, "LOCKER");
    }

    /** The factory itself must never hold a role: it is not an issuer. */
    function test_factoryContractHoldsNoRole() public {
        vm.prank(ISSUER);
        lek.deployEquity("Leek Test", "LEEKT");
        for (uint256 i; i < 12; ++i) {
            assertTrue(spy.rbacMember0(i) != address(lek), "wrapper granted itself a role");
        }
    }

    function test_templateMatchesTheDeploymentScript() public {
        lek.deployEquity("Leek Capital Ordinary Shares", "LEEKA");
        assertEq(spy.lastDecimals(), 6, "decimals");
        assertEq(spy.lastMaxSupply(), 1_000_000 * 1e6, "max supply scaled by decimals");
        assertEq(spy.lastIsWhiteList(), false, "must be a blacklist, not a whitelist");
        assertEq(spy.lastIsMultiPartition(), false, "single partition, or the market reverts");
        assertEq(spy.lastIsControllable(), true, "controllable");
    }

    function test_nameAndSymbolArePassedThrough() public {
        lek.deployEquity("Harbour Industrial", "HRBR");
        assertEq(spy.lastName(), "Harbour Industrial");
        assertEq(spy.lastSymbol(), "HRBR");
    }

    /* ------------------------------------------------------------ validation */

    function test_refusesEmptyName() public {
        vm.expectRevert(LeekSecurityFactory.NameEmpty.selector);
        lek.deployEquity("", "LEEKT");
    }

    function test_refusesEmptySymbol() public {
        vm.expectRevert(LeekSecurityFactory.SymbolEmpty.selector);
        lek.deployEquity("Leek Test", "");
    }

    function test_refusesOverlongName() public {
        string memory long = new string(65);
        vm.expectRevert(
            abi.encodeWithSelector(LeekSecurityFactory.NameTooLong.selector, 65, 64)
        );
        lek.deployEquity(long, "LEEKT");
    }

    function test_refusesOverlongSymbol() public {
        string memory long = new string(13);
        vm.expectRevert(
            abi.encodeWithSelector(LeekSecurityFactory.SymbolTooLong.selector, 13, 12)
        );
        lek.deployEquity("Leek Test", long);
    }

    function test_constructorRefusesZeroFactory() public {
        vm.expectRevert(LeekSecurityFactory.FactoryAddressZero.selector);
        new LeekSecurityFactory(address(0), RESOLVER);
    }

    function test_constructorRefusesZeroResolver() public {
        vm.expectRevert(LeekSecurityFactory.ResolverAddressZero.selector);
        new LeekSecurityFactory(address(spy), address(0));
    }

    function test_refusesZeroAddressFromFactory() public {
        spy.setNext(address(0));
        vm.expectRevert(LeekSecurityFactory.FactoryReturnedZeroAddress.selector);
        lek.deployEquity("Leek Test", "LEEKT");
    }

    /* ------------------------------------------------- the point of it all */

    /**
     * The device holds ETH_MAX_DATA = 768 bytes and refuses more. The raw
     * factory call is 3,748 bytes; this wrapper's call must be far under the
     * limit, or the whole design is pointless.
     */
    function test_calldataFitsTheHardwareWallet() public pure {
        bytes memory data = abi.encodeCall(
            LeekSecurityFactory.deployEquity,
            ("Leek Capital Ordinary Shares", "LEEKA")
        );
        assertLt(data.length, 768, "calldata exceeds ETH_MAX_DATA");
    }

    /* ------------------------------------------------------------------ bonds */

    function test_bond_usesTheBondConfigKey() public {
        lek.deployBond("Leek Capital 2027 Senior Note", "LEEKB");
        assertEq(spy.lastConfigKey(), bytes32(uint256(2)), "bond config key");
    }

    function test_equity_usesTheEquityConfigKey() public {
        lek.deployEquity("Leek Test", "LEEKT");
        assertEq(spy.lastConfigKey(), bytes32(uint256(1)), "equity config key");
    }

    /** Maturity must be strictly in the future or the factory rejects it. */
    function test_bond_maturityIsInTheFuture() public {
        lek.deployBond("Note", "NOTE");
        assertEq(spy.lastStarting(), block.timestamp, "starts now");
        assertGt(spy.lastMaturity(), block.timestamp, "matures in the future");
        assertEq(spy.lastMaturity(), block.timestamp + 365 days, "one-year term");
    }

    /** It must stay in the future when issued years from now, not be pinned. */
    function test_bond_maturityIsComputedNotPinned() public {
        vm.warp(block.timestamp + 4000 days);
        lek.deployBond("Note", "NOTE");
        assertGt(spy.lastMaturity(), block.timestamp, "maturity went stale");
    }

    function test_bond_allTwelveRolesGoToCaller() public {
        vm.prank(ISSUER);
        lek.deployBond("Note", "NOTE");
        assertEq(spy.rbacCount(), 12, "role count");
        for (uint256 i; i < 12; ++i) {
            assertEq(spy.rbacMember0(i), ISSUER, "bond role member is not the caller");
        }
    }

    function test_bond_refusesEmptyName() public {
        vm.expectRevert(LeekSecurityFactory.NameEmpty.selector);
        lek.deployBond("", "NOTE");
    }

    /** Equities and bonds share one serial, so an ISIN is never reused. */
    function test_isinSerialIsSharedAcrossKinds() public {
        lek.deployEquity("One", "ONE");
        string memory a = spy.lastIsin();
        lek.deployBond("Two", "TWO");
        string memory b = spy.lastIsin();
        assertTrue(keccak256(bytes(a)) != keccak256(bytes(b)), "equity and bond shared an ISIN");
    }

    function test_bond_calldataFitsTheHardwareWallet() public pure {
        bytes memory data = abi.encodeCall(
            LeekSecurityFactory.deployBond, ("Leek Capital 2027 Senior Note", "LEEKB")
        );
        assertLt(data.length, 768, "bond calldata exceeds ETH_MAX_DATA");
    }
}
