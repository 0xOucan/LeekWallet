// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/**
 * The slice of the Hedera ATS factory this repository actually calls.
 *
 * ---------------------------------------------------------------------------
 * Why a hand-written interface, and why you can trust this one
 *
 * The Hashgraph ATS contracts package (npm, scoped) is a devDependency of the ATS
 * mini-app, not a Foundry library, and it does not compile under this profile
 * (it is a 150-facet Hardhat project). So the two functions we call are
 * redeclared here.
 *
 * A redeclared struct is normally a guess, and a guess about a deeply nested
 * calldata layout is the kind that produces a transaction which encodes
 * cleanly and means something else. These do not have to be trusted:
 *
 *  1. Every field below was copied from `contracts/factory/IFactory.sol`,
 *     `contracts/constants/regulation.sol`, `contracts/facets/core/ICore.sol`
 *     and `contracts/infrastructure/proxy/IResolverProxy.sol` of that package
 *     at version 8.0.0 (Apache-2.0), field for field, in declaration order.
 *  2. The resulting selectors were checked against real, successful calldata
 *     pulled off the Hedera testnet mirror node for factory `0.0.9213391` and
 *     decoded with these exact tuples — including the transaction that
 *     deployed this project's own `LEEK` equity. See `RUNBOOK.md` §0.
 *  3. `DeploySecurities` asserts both selectors at run time before it
 *     broadcasts anything, so a future edit to these structs that changes the
 *     ABI stops the script instead of sending a malformed deployment.
 *
 * ---------------------------------------------------------------------------
 * A correction to docs/ATS-DEPLOY-C1.md
 *
 * That document records `0x29002951` as the `deployEquity` selector. It is
 * not: `0x29002951` is **`deployBond`**, and `deployEquity` is `0x837b37b6`.
 * Both were re-derived here from the canonical signatures and confirmed by
 * decoding live calldata of each shape. The equity deploy that document
 * describes did happen — it is simply recorded under the wrong selector.
 */
interface IAtsFactory {
    /// Categories of dividend entitlement an equity class may carry.
    enum DividendType {
        NONE,
        PREFERRED,
        COMMON
    }

    enum RegulationType {
        NONE,
        REG_S,
        REG_D
    }

    enum RegulationSubType {
        NONE,
        REG_D_506_B,
        REG_D_506_C
    }

    /// Which registered facet configuration the new proxy loads.
    /// Verified on chain: key `bytes32(1)` version 1 for an equity, key
    /// `bytes32(2)` version 1 for a bond.
    struct ResolverProxyConfiguration {
        bytes32 key;
        uint256 version;
    }

    /// ERC-20 metadata. `isin` is validated by the factory for length (12) and
    /// for its ISO 6166 check digit -- a malformed one reverts the deploy.
    struct ERC20MetadataInfo {
        string name;
        string symbol;
        string isin;
        uint8 decimals;
    }

    /// A role and the accounts granted it at birth.
    struct Rbac {
        bytes32 role;
        address[] members;
    }

    struct SecurityData {
        address resolver;
        uint256 maxSupply;
        ResolverProxyConfiguration resolverProxyConfiguration;
        ERC20MetadataInfo erc20MetadataInfo;
        Rbac[] rbacs;
        address[] externalPauses;
        address[] externalControlLists;
        address[] externalKycLists;
        address compliance;
        address identityRegistry;
        bool arePartitionsProtected;
        bool isMultiPartition;
        bool isControllable;
        bool isWhiteList;
        bool clearingActive;
        bool internalKycActivated;
        bool erc20VotesActivated;
    }

    struct EquityDetailsData {
        bool votingRight;
        bool informationRight;
        bool liquidationRight;
        bool subscriptionRight;
        bool conversionRight;
        bool redemptionRight;
        bool putRight;
        DividendType dividendRight;
        bytes3 currency;
        uint256 nominalValue;
        uint8 nominalValueDecimals;
    }

    struct EquityData {
        SecurityData security;
        EquityDetailsData equityDetails;
    }

    struct BondDetailsData {
        bytes3 currency;
        uint256 nominalValue;
        uint8 nominalValueDecimals;
        uint256 startingDate;
        /// Must be strictly greater than `block.timestamp` AND >= startingDate.
        uint256 maturityDate;
    }

    struct BondData {
        SecurityData security;
        BondDetailsData bondDetails;
        address[] proceedRecipients;
        bytes[] proceedRecipientsData;
    }

    struct AdditionalSecurityData {
        bool countriesControlListType;
        string listOfCountries;
        string info;
    }

    /// Only two combinations are legal: (REG_S, NONE) and (REG_D, non-NONE).
    struct FactoryRegulationData {
        RegulationType regulationType;
        RegulationSubType regulationSubType;
        AdditionalSecurityData additionalSecurityData;
    }

    function deployEquity(
        EquityData calldata equityData,
        FactoryRegulationData calldata factoryRegulationData
    ) external returns (address equityAddress_);

    function deployBond(
        BondData calldata bondData,
        FactoryRegulationData calldata factoryRegulationData
    ) external returns (address bondAddress_);
}

/**
 * Role ids, copied from `contracts/constants/roles.sol` of the same package.
 *
 * These are `keccak`-derived constants in the package rather than computable
 * from a name here, so they are transcribed. Each one below is annotated with
 * the console action it unlocks, because the reason to grant a role at birth
 * is that something downstream is otherwise dead: `mint` without ROLE_ISSUER
 * reverts `AccountHasNoRole`, which is exactly what the already-deployed LEEK
 * equity does today (verified by `eth_call`, RUNBOOK §0).
 */
library AtsRoles {
    /// grantRole / revokeRole, and everything else by extension.
    bytes32 internal constant DEFAULT_ADMIN = 0x00;
    /// mint / issue.
    bytes32 internal constant ISSUER = 0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f;
    /// controllerTransfer / forcedTransfer -- the forced transfer.
    bytes32 internal constant CONTROLLER = 0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e;
    /// setDividend.
    bytes32 internal constant CORPORATE_ACTION = 0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd;
    /// pause / unpause.
    bytes32 internal constant PAUSER = 0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f;
    /// addToControlList / removeFromControlList.
    bytes32 internal constant CONTROL_LIST = 0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d;
    /// grantKyc / revokeKyc.
    bytes32 internal constant KYC = 0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc;
    /// activateInternalKyc / deactivateInternalKyc.
    bytes32 internal constant INTERNAL_KYC_MANAGER =
        0xdd78fdcd1b38a5360405cef8d91e758ad0f42bf2ced681b803b3c2704b0a32a7;
    /// takeSnapshot -- without it C3 has no register to reconcile against.
    bytes32 internal constant SNAPSHOT = 0xf7d999723d2160432933a2aeffaae83e262a5a46fe94f34614a7676d1d1f67c6;
    /// setAddressFrozen / freezePartialTokens.
    bytes32 internal constant FREEZE_MANAGER = 0x71ae38482e1ab1c28e767d64766d686215b490c8c1bd7dfe6b101525187c2155;
    /// setMaxSupply.
    bytes32 internal constant CAP = 0x58d502b7184e1a264e0cacf1a19a6c268356c6d9fda5ad83ab3b599cd3b7f41c;
    /// lock / updateLockExpiration.
    bytes32 internal constant LOCKER = 0xd327cd9a2be405896f3d4584b3b437d798833cc4aa0aafb34c870659c0d47184;
}
