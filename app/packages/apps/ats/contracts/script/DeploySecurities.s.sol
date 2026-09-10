// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { IAtsFactory, AtsRoles } from "./IAtsFactory.sol";

/**
 * Deploy N equities and one bond through the Hedera ATS factory.
 *
 *   N=3 forge script script/DeploySecurities.s.sol:DeploySecurities \
 *     --rpc-url https://testnet.hashio.io/api --account hedera-deployer --broadcast
 *
 * ---------------------------------------------------------------------------
 * Why more than one security, and why only a handful
 *
 * A secondary market with one listed asset shows the mechanism but not the
 * market. Three equities and a bond give the console a register worth reading,
 * the market more than one order book, and the demo a bond/equity contrast --
 * without turning the deploy into an afternoon. N is an input, not a constant,
 * because that judgement is the operator's; the parameter table below carries
 * seven equities, which is the ceiling.
 *
 * ---------------------------------------------------------------------------
 * The four decisions baked in here, and the consequence of each
 *
 * 1. **`isControllable = true` on every security.** The issuer's forced
 *    transfer (`controllerTransfer`) is the recovery path for shares stranded
 *    in escrow by a post-listing freeze -- see the header of
 *    `AtsEscrowMarket.sol`. `finalizeControllable()` is one-way, so a security
 *    deployed with this false can never demonstrate it and can never recover.
 *
 * 2. **ERC-3643 stays OFF: `compliance` and `identityRegistry` are zero, and
 *    `internalKycActivated` is false.** This is not laziness, it is the
 *    difference between a token that works and one that reverts every single
 *    transfer. `_validateIdentifiedAccount` calls `isVerified` on the identity
 *    registry; the package's `LowLevelCall.functionStaticCall` returns empty
 *    for a zero target and the check passes, and `verifyKycStatus` short-
 *    circuits to true while internal KYC is deactivated. Point either at a
 *    contract that does not exist and every mint and every fill reverts.
 *    ROLE_INTERNAL_KYC_MANAGER and ROLE_KYC are granted anyway, so the issuer
 *    can turn internal KYC on later from the console, on the device, as a
 *    deliberate act with a screen in front of it.
 *
 * 3. **Roles are granted at birth, not afterwards.** The factory seeds RBAC in
 *    the proxy constructor, then renounces its own temporary admin. A security
 *    deployed with only DEFAULT_ADMIN_ROLE is administrable but inert: `mint`
 *    reverts `AccountHasNoRole(issuer|agent)`. That is not hypothetical -- it
 *    is the state of the already-deployed LEEK equity, confirmed by `eth_call`
 *    before this script was written.
 *
 * 4. **Dividend right COMMON on the equities.** `setDividend` only declares a
 *    corporate action; there is no `payDividend` anywhere in the package, so
 *    C3's reconciliation pays in some other asset. COMMON is what makes the
 *    declaration mean "pro-rata across every holder", which is the only shape
 *    C3 knows how to reconcile.
 *
 * ---------------------------------------------------------------------------
 * The addresses this script prints are SIMULATED
 *
 * Forge logs come from the simulation, and the proxy address is a CREATE
 * address chosen by the factory's nonce at execution time. Read the real ones
 * out of the `EquityDeployed` / `BondDeployed` receipts -- `script/addresses.sh`
 * does exactly that, and the runbook makes it a step rather than a footnote.
 */
contract DeploySecurities is Script {
    /* Verified live on Hedera testnet, chain 296. See RUNBOOK.md §0. */
    address internal constant DEFAULT_FACTORY = 0x00000000000000000000000000000000008c95cF;
    address internal constant DEFAULT_RESOLVER = 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a;

    /* Facet configuration registered in the resolver, read off real calldata:
     * key bytes32(1) v1 deploys an equity, key bytes32(2) v1 deploys a bond. */
    bytes32 internal constant EQUITY_CONFIG_KEY = bytes32(uint256(1));
    bytes32 internal constant BOND_CONFIG_KEY = bytes32(uint256(2));
    uint256 internal constant CONFIG_VERSION = 1;

    /* Six decimals throughout. C3 refuses a distribution in which any holder is
     * owed a fraction of a payment unit, and matching the payment token's
     * precision is what keeps whole-share arithmetic whole. */
    uint8 internal constant DECIMALS = 6;

    /// ISO 4217 "USD" as bytes3, which is what `nominalValue` is denominated in.
    bytes3 internal constant USD = 0x555344;

    uint256 internal constant MAX_EQUITIES = 7;

    struct EquityParams {
        string name;
        string symbol;
        /// 12 characters, ISO 6166 check digit valid -- the factory verifies it.
        string isin;
        /// Whole shares. Scaled by 10**DECIMALS before it reaches the factory.
        uint256 maxSupplyShares;
        /// Face value of one share, in USD cents (nominalValueDecimals = 2).
        uint256 nominalValueCents;
        bool votingRight;
        bool redemptionRight;
    }

    function run() external {
        uint256 n = vm.envOr("N", uint256(3));
        require(n >= 1 && n <= MAX_EQUITIES, "N must be between 1 and 7");

        address factory = vm.envOr("FACTORY", DEFAULT_FACTORY);
        address resolver = vm.envOr("RESOLVER", DEFAULT_RESOLVER);
        address issuer = vm.envOr("ISSUER", msg.sender);
        require(issuer != address(0), "ISSUER unset and no sender");

        /* Guard the one thing a hand-written interface can get wrong silently.
         * If a struct field is ever reordered or retyped in IAtsFactory.sol the
         * calldata would still encode -- against a different function. Both
         * selectors were confirmed against successful mainnet-shaped calldata
         * on the testnet mirror node; assert them before spending anything. */
        require(IAtsFactory.deployEquity.selector == 0x837b37b6, "deployEquity ABI drift");
        require(IAtsFactory.deployBond.selector == 0x29002951, "deployBond ABI drift");

        console2.log("factory  :", factory);
        console2.log("resolver :", resolver);
        console2.log("issuer   :", issuer);
        console2.log("equities :", n);
        console2.log("");

        vm.startBroadcast();

        for (uint256 i; i < n; ++i) {
            EquityParams memory p = _equityParams(i);
            address deployed = IAtsFactory(factory).deployEquity(
                IAtsFactory.EquityData({
                    security: _securityData(
                        resolver, issuer, EQUITY_CONFIG_KEY, p.name, p.symbol, p.isin, p.maxSupplyShares
                    ),
                    equityDetails: IAtsFactory.EquityDetailsData({
                        votingRight: p.votingRight,
                        informationRight: true,
                        liquidationRight: true,
                        subscriptionRight: true,
                        conversionRight: false,
                        redemptionRight: p.redemptionRight,
                        putRight: false,
                        dividendRight: IAtsFactory.DividendType.COMMON,
                        currency: USD,
                        nominalValue: p.nominalValueCents,
                        nominalValueDecimals: 2
                    })
                }),
                _regulation()
            );
            console2.log("equity (simulated)", p.symbol, deployed);
        }

        /* One bond, deployed last so a failure here does not strand the
         * equities. `maturityDate` must be strictly in the future -- the
         * factory schedules a task at it -- so it is computed, never pinned. */
        address bond = IAtsFactory(factory).deployBond(
            IAtsFactory.BondData({
                security: _securityData(
                    resolver, issuer, BOND_CONFIG_KEY, "Leek Capital 2027 Senior Note", "LEEKB", "ZZLEEKBOND12", 100_000
                ),
                bondDetails: IAtsFactory.BondDetailsData({
                    currency: USD,
                    nominalValue: 100_000, // USD 1,000.00 per note
                    nominalValueDecimals: 2,
                    startingDate: block.timestamp,
                    maturityDate: block.timestamp + 365 days
                }),
                proceedRecipients: new address[](0),
                proceedRecipientsData: new bytes[](0)
            }),
            _regulation()
        );
        console2.log("bond   (simulated)", "LEEKB", bond);

        vm.stopBroadcast();

        console2.log("");
        console2.log("Those addresses are SIMULATED. Recover the real ones with:");
        console2.log("  ./script/addresses.sh");
    }

    /* ------------------------------------------------------------ builders */

    /**
     * The shared core configuration. Everything ERC-3643 is deliberately zero
     * or false here; see decision 2 in the header.
     */
    function _securityData(
        address resolver,
        address issuer,
        bytes32 configKey,
        string memory name,
        string memory symbol,
        string memory isin,
        uint256 maxSupplyShares
    ) internal pure returns (IAtsFactory.SecurityData memory) {
        return IAtsFactory.SecurityData({
            resolver: resolver,
            maxSupply: maxSupplyShares * (10 ** DECIMALS),
            resolverProxyConfiguration: IAtsFactory.ResolverProxyConfiguration({
                key: configKey,
                version: CONFIG_VERSION
            }),
            erc20MetadataInfo: IAtsFactory.ERC20MetadataInfo({
                name: name,
                symbol: symbol,
                isin: isin,
                decimals: DECIMALS
            }),
            rbacs: _rbacs(issuer),
            externalPauses: new address[](0),
            externalControlLists: new address[](0),
            externalKycLists: new address[](0),
            compliance: address(0),
            identityRegistry: address(0),
            arePartitionsProtected: false,
            /* Single partition. The market calls plain ERC-20 `transferFrom`
             * and `transfer`; a multi-partition security routes through the
             * *ByPartition facets instead and those calls revert. */
            isMultiPartition: false,
            isControllable: true,
            /* Control list as a BLACKLIST (false = deny-list). A whitelist with
             * nobody on it blocks every holder, including the issuer. */
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: false,
            erc20VotesActivated: false
        });
    }

    /**
     * Every role the console's privileged surface needs, all to one issuer.
     *
     * One account rather than a separation-of-duties layout, and said out loud
     * rather than implied: this is a testnet demonstration where the point is
     * that each of these acts is rendered and approved on a hardware device.
     * A production issuer should split these across separate keys.
     */
    function _rbacs(address issuer) internal pure returns (IAtsFactory.Rbac[] memory rbacs) {
        bytes32[12] memory roles = [
            AtsRoles.DEFAULT_ADMIN,
            AtsRoles.ISSUER,
            AtsRoles.CONTROLLER,
            AtsRoles.CORPORATE_ACTION,
            AtsRoles.PAUSER,
            AtsRoles.CONTROL_LIST,
            AtsRoles.KYC,
            AtsRoles.INTERNAL_KYC_MANAGER,
            AtsRoles.SNAPSHOT,
            AtsRoles.FREEZE_MANAGER,
            AtsRoles.CAP,
            AtsRoles.LOCKER
        ];

        rbacs = new IAtsFactory.Rbac[](roles.length);
        for (uint256 i; i < roles.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = issuer;
            rbacs[i] = IAtsFactory.Rbac({ role: roles[i], members: members });
        }
    }

    /**
     * Regulation S, no sub-type -- the only combination the factory accepts
     * with `RegulationSubType.NONE`. The excluded-country list mirrors what
     * every other deployment against this factory has used.
     */
    function _regulation() internal pure returns (IAtsFactory.FactoryRegulationData memory) {
        return IAtsFactory.FactoryRegulationData({
            regulationType: IAtsFactory.RegulationType.REG_S,
            regulationSubType: IAtsFactory.RegulationSubType.NONE,
            additionalSecurityData: IAtsFactory.AdditionalSecurityData({
                countriesControlListType: false,
                listOfCountries: "CU,KP,IR,SY",
                info: "LeekWallet ATS demonstration issue. Testnet only."
            })
        });
    }

    /**
     * The parameter table.
     *
     * ISINs use the `ZZ` prefix on purpose. `ZZ` is not an allocated ISO 3166
     * country code, so none of these can collide with, or be mistaken for, a
     * real security -- while still satisfying the factory's length and check-
     * digit validation. Each check digit below was computed with the package's
     * own algorithm and the algorithm itself was verified against a known-good
     * ISIN before these were generated.
     */
    function _equityParams(uint256 i) internal pure returns (EquityParams memory) {
        if (i == 0) {
            return EquityParams({
                name: "Leek Capital Ordinary Shares",
                symbol: "LEEKA",
                isin: "ZZLEEK000015",
                maxSupplyShares: 1_000_000,
                nominalValueCents: 10_000,
                votingRight: true,
                redemptionRight: false
            });
        }
        if (i == 1) {
            return EquityParams({
                name: "Verdant Growth Fund I",
                symbol: "VGF1",
                isin: "ZZLEEK000023",
                maxSupplyShares: 250_000,
                nominalValueCents: 250_000,
                votingRight: false,
                redemptionRight: true
            });
        }
        if (i == 2) {
            return EquityParams({
                name: "Harbour Logistics Holdings",
                symbol: "HRBR",
                isin: "ZZLEEK000031",
                maxSupplyShares: 5_000_000,
                nominalValueCents: 5_000,
                votingRight: true,
                redemptionRight: false
            });
        }
        if (i == 3) {
            return EquityParams({
                name: "Andes Solar Infrastructure",
                symbol: "ANDS",
                isin: "ZZLEEK000049",
                maxSupplyShares: 750_000,
                nominalValueCents: 100_000,
                votingRight: true,
                redemptionRight: true
            });
        }
        if (i == 4) {
            return EquityParams({
                name: "Miralta Property REIT",
                symbol: "MRLT",
                isin: "ZZLEEK000056",
                maxSupplyShares: 2_000_000,
                nominalValueCents: 50_000,
                votingRight: false,
                redemptionRight: false
            });
        }
        if (i == 5) {
            return EquityParams({
                name: "Cobalt Ridge Mining",
                symbol: "CBRG",
                isin: "ZZLEEK000064",
                maxSupplyShares: 400_000,
                nominalValueCents: 150_000,
                votingRight: true,
                redemptionRight: false
            });
        }
        return EquityParams({
            name: "Tidewater Marine Leasing",
            symbol: "TIDE",
            isin: "ZZLEEK000072",
            maxSupplyShares: 1_200_000,
            nominalValueCents: 25_000,
            votingRight: false,
            redemptionRight: true
        });
    }
}
