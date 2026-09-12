// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IAtsFactory, AtsRoles } from "./IAtsFactory.sol";

/** Diagnostic: print the exact calldata the wrapper sends to the ATS factory. */
contract EncodeDirect is Script {
    function run() external pure {
        address issuer = 0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45;
        bytes32[12] memory roles = [
            AtsRoles.DEFAULT_ADMIN, AtsRoles.ISSUER, AtsRoles.CONTROLLER,
            AtsRoles.CORPORATE_ACTION, AtsRoles.PAUSER, AtsRoles.CONTROL_LIST,
            AtsRoles.KYC, AtsRoles.INTERNAL_KYC_MANAGER, AtsRoles.SNAPSHOT,
            AtsRoles.FREEZE_MANAGER, AtsRoles.CAP, AtsRoles.LOCKER
        ];
        IAtsFactory.Rbac[] memory rbacs = new IAtsFactory.Rbac[](12);
        for (uint256 i; i < 12; ++i) {
            address[] memory m = new address[](1);
            m[0] = issuer;
            rbacs[i] = IAtsFactory.Rbac({ role: roles[i], members: m });
        }

        IAtsFactory.SecurityData memory sd = IAtsFactory.SecurityData({
            resolver: 0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a,
            maxSupply: 1_000_000 * (10 ** 6),
            resolverProxyConfiguration:
                IAtsFactory.ResolverProxyConfiguration({ key: bytes32(uint256(1)), version: 1 }),
            erc20MetadataInfo: IAtsFactory.ERC20MetadataInfo({
                name: "Acme Industrial", symbol: "ACME", isin: "ZZ0000000008", decimals: 6
            }),
            rbacs: rbacs,
            externalPauses: new address[](0),
            externalControlLists: new address[](0),
            externalKycLists: new address[](0),
            compliance: address(0),
            identityRegistry: address(0),
            arePartitionsProtected: false,
            isMultiPartition: false,
            isControllable: true,
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: false,
            erc20VotesActivated: false
        });

        bytes memory data = abi.encodeCall(IAtsFactory.deployEquity, (
            IAtsFactory.EquityData({
                security: sd,
                equityDetails: IAtsFactory.EquityDetailsData({
                    votingRight: true, informationRight: true, liquidationRight: true,
                    subscriptionRight: true, conversionRight: false, redemptionRight: false,
                    putRight: false, dividendRight: IAtsFactory.DividendType.COMMON,
                    currency: 0x555344, nominalValue: 100, nominalValueDecimals: 2
                })
            }),
            IAtsFactory.FactoryRegulationData({
                regulationType: IAtsFactory.RegulationType.REG_S,
                regulationSubType: IAtsFactory.RegulationSubType.NONE,
                additionalSecurityData: IAtsFactory.AdditionalSecurityData({
                    countriesControlListType: false,
                    listOfCountries: "CU,KP,IR,SY",
                    info: "LeekWallet ATS demonstration issue. Testnet only."
                })
            })
        ));
        console2.logBytes(data);
    }
}
