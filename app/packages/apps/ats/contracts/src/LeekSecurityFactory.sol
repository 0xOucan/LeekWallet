// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { IAtsFactory, AtsRoles } from "../script/IAtsFactory.sol";

/**
 * Issue an ATS equity or bond from a hardware wallet, by fixing everything
 * except the name and the symbol.
 *
 * ---------------------------------------------------------------------------
 * Why this contract exists at all
 *
 * The ATS factory's `deployEquity` takes a seventeen-field nested struct and
 * its calldata measures **3,748 bytes**. The LeekWallet device holds at most
 * `ETH_MAX_DATA` (768) and refuses anything longer, deliberately: it cannot
 * hash or display bytes it never held. Raising that limit is possible but it
 * does not solve the real problem, which is consent. A screen that says
 * "deploy equity, approve?" over 3.7KB the holder cannot read is blind signing
 * wearing a costume.
 *
 * So the template moves on chain, into code that is deployed once and verified,
 * and the call becomes `deployEquity(string,string)` -- about 260 bytes, well
 * inside the device's limit, and a screen that shows the only two things that
 * actually vary. What is signed and what is displayed are then the same thing,
 * which is the property a hardware wallet exists to provide.
 *
 * ---------------------------------------------------------------------------
 * The template, and that it is NOT a security decision this contract makes
 *
 * Every constant below is copied from `script/DeploySecurities.s.sol`, which
 * deployed LEEKA, VGF1, HRBR and LEEKB. This contract changes no policy; it
 * freezes the policy that was already used, so the device does not have to
 * re-state it on every call.
 *
 * **All twelve roles go to `msg.sender`, never to this contract.** A caller
 * receives authority over the security they just created and over nothing
 * else, so an open `deployEquity` grants no privilege over anybody else's
 * issue. This contract holds no roles, no tokens and no funds, and has no
 * owner: there is nothing here to steal and nothing to upgrade. That is why it
 * is deliberately permissionless -- an access-control list would add an admin
 * key that could be lost or abused, to protect an operation that costs the
 * caller gas and affects only the caller.
 *
 * ---------------------------------------------------------------------------
 * Security notes against the pre-deploy checklist
 *
 *   access control   Nothing privileged to guard; see above. Roles -> caller.
 *   reentrancy       One external call, to an immutable trusted factory, and
 *                    `_serial` is incremented BEFORE it (checks-effects-
 *                    interactions). A re-entering factory therefore cannot
 *                    mint two securities with the same ISIN.
 *   tokens           None held, none transferred, no approvals of any kind.
 *   oracles / math   No prices. The only arithmetic is the ISIN check digit,
 *                    which is tested against a published ISIN.
 *   validation       Name and symbol are bounded and must be non-empty; the
 *                    factory address is checked non-zero at construction.
 *   events           `EquityDeployed` carries the caller, the address, the
 *                    symbol and the generated ISIN.
 *   decimals         Fixed at 6, matching every existing issue, because a
 *                    per-call decimals field is exactly the kind of invisible
 *                    number this design exists to remove from the screen.
 */
contract LeekSecurityFactory {
    /* ------------------------------------------------------------ template */

    uint8 internal constant DECIMALS = 6;
    bytes32 internal constant EQUITY_CONFIG_KEY = bytes32(uint256(1));
    bytes32 internal constant BOND_CONFIG_KEY = bytes32(uint256(2));
    uint256 internal constant CONFIG_VERSION = 1;
    bytes3 internal constant USD = 0x555344;

    /// Whole shares, scaled by 10**DECIMALS before it reaches the factory.
    uint256 public constant MAX_SUPPLY_SHARES = 1_000_000;
    /// Face value of one share in USD cents (nominalValueDecimals = 2).
    uint256 public constant NOMINAL_VALUE_CENTS = 100;

    /// Bond template: notes outstanding, and USD 1,000.00 face per note.
    uint256 public constant MAX_BOND_NOTES = 100_000;
    uint256 public constant BOND_NOMINAL_VALUE_CENTS = 100_000;
    /**
     * Term of every bond issued here.
     *
     * `maturityDate` must be strictly in the future -- the factory schedules a
     * task at it -- so it is computed from `block.timestamp` at issuance and
     * never pinned. One year matches LEEKB.
     */
    uint256 public constant BOND_TERM = 365 days;

    uint256 internal constant MAX_NAME_BYTES = 64;
    uint256 internal constant MAX_SYMBOL_BYTES = 12;

    IAtsFactory public immutable FACTORY;
    address public immutable RESOLVER;

    /* --------------------------------------------------------------- state */

    /**
     * Feeds the generated ISIN, so two deployments never collide.
     *
     * Nine digits, so it wraps at 1e9 -- unreachable at one deployment per
     * transaction, and a wrap would only repeat an ISIN, which the factory
     * itself is free to reject. It is not a security boundary.
     */
    uint256 private _serial;

    event EquityDeployed(
        address indexed caller,
        address indexed equity,
        string symbol,
        string isin
    );

    /**
     * Indexed on the caller so the companion can ask the chain "what have I
     * issued?" in one filtered `eth_getLogs`.
     *
     * Aqua's events are NOT indexed and that cost this project a portfolio
     * scan that had to walk every block and could not be filtered by maker.
     * These are indexed precisely so that never happens here.
     */
    event BondDeployed(
        address indexed caller,
        address indexed bond,
        string symbol,
        string isin
    );

    error FactoryAddressZero();
    error ResolverAddressZero();
    error NameEmpty();
    error SymbolEmpty();
    error NameTooLong(uint256 length, uint256 maximum);
    error SymbolTooLong(uint256 length, uint256 maximum);
    error FactoryReturnedZeroAddress();

    constructor(address factory, address resolver) {
        if (factory == address(0)) revert FactoryAddressZero();
        if (resolver == address(0)) revert ResolverAddressZero();
        FACTORY = IAtsFactory(factory);
        RESOLVER = resolver;
    }

    /* -------------------------------------------------------------- deploy */

    /**
     * Deploy an equity named `name` with symbol `symbol`, all twelve roles to
     * the caller.
     *
     * Everything else -- resolver, config key and version, decimals, max
     * supply, nominal value, rights, regulation, control-list polarity -- is
     * the frozen template above, which is why the calldata is small enough for
     * a hardware wallet to hold and the screen short enough to read.
     */
    function deployEquity(string calldata name, string calldata symbol)
        external
        returns (address equity)
    {
        _requireNameAndSymbol(name, symbol);

        /* Effects before interaction: the serial is consumed here, so the ISIN
         * is already spent if the factory call re-enters. */
        uint256 serial = _serial;
        _serial = serial + 1;
        string memory isin = _isin(serial);

        equity = FACTORY.deployEquity(
            IAtsFactory.EquityData({
                security: _securityData(
                    name, symbol, isin, msg.sender, EQUITY_CONFIG_KEY, MAX_SUPPLY_SHARES
                ),
                equityDetails: IAtsFactory.EquityDetailsData({
                    votingRight: true,
                    informationRight: true,
                    liquidationRight: true,
                    subscriptionRight: true,
                    conversionRight: false,
                    redemptionRight: false,
                    putRight: false,
                    dividendRight: IAtsFactory.DividendType.COMMON,
                    currency: USD,
                    nominalValue: NOMINAL_VALUE_CENTS,
                    nominalValueDecimals: 2
                })
            }),
            _regulation()
        );

        if (equity == address(0)) revert FactoryReturnedZeroAddress();
        emit EquityDeployed(msg.sender, equity, symbol, isin);
    }

    /**
     * Deploy a bond named `name` with symbol `symbol`, all twelve roles to the
     * caller.
     *
     * Same template discipline as `deployEquity`, with the bond's own config
     * key and its own face value. `startingDate` is now and `maturityDate` is
     * `BOND_TERM` from now: both are computed rather than supplied, because a
     * maturity date that has already passed is rejected by the factory and is
     * exactly the kind of value nobody can sanity-check on a 240x240 screen.
     */
    function deployBond(string calldata name, string calldata symbol)
        external
        returns (address bond)
    {
        _requireNameAndSymbol(name, symbol);

        uint256 serial = _serial;
        _serial = serial + 1;
        string memory isin = _isin(serial);

        bond = FACTORY.deployBond(
            IAtsFactory.BondData({
                security: _securityData(
                    name, symbol, isin, msg.sender, BOND_CONFIG_KEY, MAX_BOND_NOTES
                ),
                bondDetails: IAtsFactory.BondDetailsData({
                    currency: USD,
                    nominalValue: BOND_NOMINAL_VALUE_CENTS,
                    nominalValueDecimals: 2,
                    startingDate: block.timestamp,
                    maturityDate: block.timestamp + BOND_TERM
                }),
                proceedRecipients: new address[](0),
                proceedRecipientsData: new bytes[](0)
            }),
            _regulation()
        );

        if (bond == address(0)) revert FactoryReturnedZeroAddress();
        emit BondDeployed(msg.sender, bond, symbol, isin);
    }

    /* ------------------------------------------------------------ internals */

    function _requireNameAndSymbol(string calldata name, string calldata symbol) internal pure {
        uint256 nameLength = bytes(name).length;
        uint256 symbolLength = bytes(symbol).length;
        if (nameLength == 0) revert NameEmpty();
        if (symbolLength == 0) revert SymbolEmpty();
        if (nameLength > MAX_NAME_BYTES) revert NameTooLong(nameLength, MAX_NAME_BYTES);
        if (symbolLength > MAX_SYMBOL_BYTES) revert SymbolTooLong(symbolLength, MAX_SYMBOL_BYTES);
    }

    function _securityData(
        string calldata name,
        string calldata symbol,
        string memory isin,
        address issuer,
        bytes32 configKey,
        uint256 maxSupplyUnits
    ) internal view returns (IAtsFactory.SecurityData memory) {
        return IAtsFactory.SecurityData({
            resolver: RESOLVER,
            maxSupply: maxSupplyUnits * (10 ** DECIMALS),
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
            /* Single partition: the escrow market calls plain ERC-20
             * `transfer`/`transferFrom`, and a multi-partition security routes
             * through the *ByPartition facets instead, where those revert. */
            isMultiPartition: false,
            isControllable: true,
            /* Blacklist (false = deny-list). A whitelist with nobody on it
             * blocks every holder, the issuer included. */
            isWhiteList: false,
            clearingActive: false,
            internalKycActivated: false,
            erc20VotesActivated: false
        });
    }

    /** Every role to one issuer -- the caller. See the header. */
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
     * The ISIN check digit over an already letter-expanded digit string.
     *
     * Public and pure so a test can drive it with a PUBLISHED ISIN rather than
     * with our own output -- checking our generator against our own generator
     * would pass no matter which way round the doubling went. See
     * `test_checkDigit_matchesPublishedIsin`.
     *
     * Luhn from the right of the body: the rightmost body digit is doubled,
     * because the check digit that will sit to its right is not part of the
     * sum.
     */
    function checkDigit(bytes memory digits) public pure returns (uint256) {
        uint256 sum;
        uint256 n = digits.length;
        for (uint256 i; i < n; ++i) {
            uint256 d = uint8(digits[n - 1 - i]) - 48;
            if (i % 2 == 0) {
                d *= 2;
                if (d > 9) d -= 9;
            }
            sum += d;
        }
        return (10 - (sum % 10)) % 10;
    }

    /* ----------------------------------------------------------------- ISIN */

    /**
     * `ZZ` + nine digits of `serial` + a Luhn check digit.
     *
     * The factory validates both the length and the check digit, so this
     * cannot be a formatting nicety. `ZZ` is not an allocated ISO 3166 country
     * code, so nothing generated here can collide with, or be mistaken for, a
     * real security -- the same reasoning the deployment script used.
     *
     * The check digit follows the ISIN rule: letters expand to two digits
     * (A=10 ... Z=35), the whole body becomes one digit string, then Luhn from
     * the right. `Z` is 35, so the `ZZ` prefix contributes "3535". The
     * implementation is tested against US0378331005, a published ISIN.
     */
    function _isin(uint256 serial) internal pure returns (string memory) {
        bytes memory body = new bytes(11);
        body[0] = "Z";
        body[1] = "Z";
        for (uint256 i; i < 9; ++i) {
            body[10 - i] = bytes1(uint8(48 + uint8(serial % 10)));
            serial /= 10;
        }

        /* "3535" for ZZ, then the nine digits: thirteen digits in all. */
        bytes memory digits = new bytes(13);
        digits[0] = "3"; digits[1] = "5"; digits[2] = "3"; digits[3] = "5";
        for (uint256 i; i < 9; ++i) digits[4 + i] = body[2 + i];

        uint256 check = checkDigit(digits);

        bytes memory out = new bytes(12);
        for (uint256 i; i < 11; ++i) out[i] = body[i];
        out[11] = bytes1(uint8(48 + uint8(check)));
        return string(out);
    }
}
