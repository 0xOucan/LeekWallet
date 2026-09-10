// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { IAtsSecurity } from "./IAtsSecurity.sol";
import { AtsRoles } from "./IAtsFactory.sol";

// Foundry's DefaultSender, which msg.sender becomes when a script runs without
// --sender. It is never a real actor here, and every time it silently stood in
// for one the failure arrived late and looked like something else: a mint that
// "had no role", a seller that "did not hold that many shares". Refuse it by
// name so the message says what is actually wrong.
address constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

function requireRealActor(address who, string memory envName) pure {
    require(
        who != address(0) && who != FOUNDRY_DEFAULT_SENDER,
        string.concat(
            envName,
            " is unset, so it fell back to Foundry's DefaultSender. Set ",
            envName,
            "=<address> and pass --sender <address>."
        )
    );
}


/**
 * Mint a security to its first holders.
 *
 *   SECURITY=0x... \
 *   HOLDERS=0xbDEB...,0x9c77...,0xe7df... \
 *   SHARES=1200,800,500 \
 *   forge script script/MintAndDistribute.s.sol:MintAndDistribute \
 *     --rpc-url https://testnet.hashio.io/api --account hedera-deployer --broadcast
 *
 * ---------------------------------------------------------------------------
 * Whole shares, and why the script refuses anything else
 *
 * `SHARES` is counted in WHOLE SHARES. The scaling to base units happens here,
 * from `decimals()` read off the token rather than assumed, because a security
 * with 6 decimals and one with 18 differ by a factor of a trillion and the
 * mistake looks like a successful transaction.
 *
 * Whole shares are not a convenience. C3 refuses a distribution in which any
 * holder is owed a fraction of a payment unit -- a register holding 1.5 shares
 * at a rate of one cent per share owes somebody half a cent, and there is no
 * honest way to pay it. Minting only whole amounts is the cheapest way to keep
 * every later dividend reconcilable, so this script cannot express the state
 * that would break C3.
 *
 * ---------------------------------------------------------------------------
 * What it checks before it spends anything
 *
 * Each of these is a failure that otherwise surfaces as an opaque revert, one
 * transaction later, with a message that names neither the cause nor the fix:
 *
 *   - the caller actually holds ROLE_ISSUER (or ROLE_AGENT) on this security;
 *   - the token is not paused;
 *   - the mint total plus the existing supply stays inside `getMaxSupply()`;
 *   - holders and share counts are the same length, and no holder is zero.
 *
 * The already-deployed LEEK equity fails the first of these: it was deployed
 * with DEFAULT_ADMIN_ROLE only, so `mint` reverts `AccountHasNoRole`. That is
 * the exact case this check exists to name out loud.
 */
contract MintAndDistribute is Script {
    /// ROLE_AGENT, the alternative to ROLE_ISSUER that `mint` also accepts.
    bytes32 internal constant ROLE_AGENT = 0x9830aa071a741c08855dd42130bdb0ff50f7bdf5a4b72f12181eefded0c6542b;

    function run() external {
        IAtsSecurity security = IAtsSecurity(vm.envAddress("SECURITY"));
        address[] memory holders = vm.envAddress("HOLDERS", ",");
        uint256[] memory shares = vm.envUint("SHARES", ",");
        address issuer = vm.envOr("ISSUER", msg.sender);
        requireRealActor(issuer, "ISSUER");

        require(holders.length > 0, "HOLDERS is empty");
        require(holders.length == shares.length, "HOLDERS and SHARES differ in length");

        uint8 decimals = security.decimals();
        uint256 unit = 10 ** decimals;

        console2.log("security   :", security.name(), address(security));
        console2.log("symbol     :", security.symbol());
        console2.log("decimals   :", decimals);
        console2.log("issuer     :", issuer);
        console2.log("");

        require(
            security.hasRole(AtsRoles.ISSUER, issuer) || security.hasRole(ROLE_AGENT, issuer),
            "issuer holds neither ROLE_ISSUER nor ROLE_AGENT: mint would revert"
        );
        require(!security.paused(), "security is paused: mint would revert");

        uint256 totalBase;
        for (uint256 i; i < holders.length; ++i) {
            require(holders[i] != address(0), "holder is the zero address");
            require(shares[i] > 0, "a holder is being minted zero shares");
            totalBase += shares[i] * unit;
        }

        uint256 supplyBefore = security.totalSupply();
        uint256 maxSupply = security.getMaxSupply();
        /* maxSupply == 0 means uncapped in this package; only compare when set. */
        if (maxSupply != 0) {
            require(supplyBefore + totalBase <= maxSupply, "mint would exceed getMaxSupply()");
        }

        vm.startBroadcast();
        for (uint256 i; i < holders.length; ++i) {
            security.mint(holders[i], shares[i] * unit);
            console2.log("  minted", shares[i], "shares to", holders[i]);
        }
        vm.stopBroadcast();

        console2.log("");
        console2.log("supply before (base units):", supplyBefore);
        console2.log("minted        (base units):", totalBase);
        console2.log("");
        console2.log("Verify with `cast call`, not with this log: these numbers come");
        console2.log("from the simulation. The runbook's step 5 does exactly that.");
    }
}
