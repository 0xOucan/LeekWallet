// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { LeekSecurityFactory } from "../src/LeekSecurityFactory.sol";
import { AtsEscrowMarket } from "../src/AtsEscrowMarket.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * Fill the escrow market with something to buy.
 *
 *   forge script script/PopulateMarket.s.sol:PopulateMarket \
 *     --rpc-url https://testnet.hashio.io/api \
 *     --account monad-deployer --sender 0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45 \
 *     --broadcast --slow
 *
 * Issues eight equities through LeekSecurityFactory, mints a different number
 * of shares of each, and lists each at a different price — so the market has
 * depth and the demo has something to compare. Every lot is priced between 1
 * and 8 HBAR, which is nonsense as a valuation and exactly right as a demo:
 * the point is to fill several of them on camera and watch the holdings change.
 *
 * ---------------------------------------------------------------------------
 * The names are deliberately not real companies
 *
 * Every name here is misspelt on purpose -- Gugle, Appel, Tesler, Nvidiya,
 * Netflikz, Meta4, Amazonas, Coca Kola. A tokenised security carrying a real
 * company's name is an impersonation whether or not anybody meant it that way,
 * and this one would be sitting on a public testnet with a working order book
 * attached. The symbols are bent away from the real tickers for the same
 * reason: APEL not AAPL, NFLZ not NFLX. The ISINs the factory generates carry the `ZZ` prefix for the
 * same reason: `ZZ` is not an allocated ISO 3166 country code, so nothing here
 * can be mistaken for a real instrument by anything that reads ISINs.
 *
 * ---------------------------------------------------------------------------
 * Cost, and why --slow
 *
 * Each issuance is ~8M gas and Hedera caps a contract call at 15M, so these
 * cannot be batched into one transaction. At ~1,150 gwei that is roughly 9 HBAR
 * per issuance, plus a mint, an approval and a listing each -- call it 11 HBAR
 * per company. **Budget ~90 HBAR for the eight**, against the 420 the deployer
 * held when this was written. Run it once: a second run issues eight MORE
 * securities with new addresses rather than topping up the old ones. `--slow` because Hedera's relay does not like several
 * transactions arriving at once from one account, and a nonce race here costs
 * a re-run rather than a retry.
 */
contract PopulateMarket is Script {
    /* Redeploy-safe: read from the environment when set, so this script does
     * not go stale the way a hard-coded address does. */
    address internal constant DEFAULT_FACTORY = 0x3a56974075d734aFa5BF7f63e34F9C3237408AeD;
    address internal constant DEFAULT_MARKET = 0xCde9596fd89C5368b5Bd46c2B93544Cbb201f8DF;

    struct Issue {
        string name;
        string symbol;
        /** Whole shares to mint and list. */
        uint256 shares;
        /** Total price for the whole lot, in TINYBAR (1 HBAR = 1e8). */
        uint256 priceTinybar;
    }

    function run() external {
        address factoryAddr = vm.envOr("FACTORY_WRAPPER", DEFAULT_FACTORY);
        address marketAddr = vm.envOr("MARKET", DEFAULT_MARKET);
        require(factoryAddr.code.length > 0, "wrapper has no code");
        require(marketAddr.code.length > 0, "market has no code");

        LeekSecurityFactory factory = LeekSecurityFactory(factoryAddr);
        AtsEscrowMarket market = AtsEscrowMarket(payable(marketAddr));

        /* Prices are deliberately trivial -- 1 to 8 HBAR for a whole lot -- so
         * the buying side of the demo is a sequence of real fills rather than
         * one cautious transaction. The device holds ~190 HBAR and the whole
         * book below totals 32, so it can clear the market and still pay gas.
         *
         * Share counts vary on purpose too: a book where every row is the same
         * size shows nothing about the register afterwards. */
        Issue[8] memory plan = [
            Issue("Gugle Holdings",       "GUGL",  500, 1_00000000),
            Issue("Appel Computer Co",    "APEL", 1200, 2_00000000),
            Issue("Tesler Motors",        "TSLR",  250, 3_00000000),
            Issue("Nvidiya Graphics",     "NVDY",  750, 4_00000000),
            Issue("Netflikz Streaming",   "NFLZ",  300, 5_00000000),
            Issue("Meta4 Platforms",      "MTA4",  900, 6_00000000),
            Issue("Amazonas Retail",      "AMZS", 1500, 3_50000000),
            Issue("Coca Kola Bottling",   "KOLA",  600, 7_50000000)
        ];

        for (uint256 i; i < plan.length; ++i) {
            Issue memory p = plan[i];
            console2.log("");
            console2.log("=== issuing", p.symbol);

            vm.startBroadcast();
            address security = factory.deployEquity(p.name, p.symbol);
            vm.stopBroadcast();
            console2.log("  security", security);

            uint8 dec = IMintable(security).decimals();
            uint256 raw = p.shares * (10 ** dec);

            /* Mint, approve, list -- three transactions, each its own broadcast
             * so --slow can space them. `mint` returns NOTHING on these
             * contracts; declaring a bool return made an earlier script report
             * failure on a mint that had succeeded, which is a double-mint
             * hazard, so IMintable above says `external;` and not
             * `returns (bool)`. */
            vm.startBroadcast();
            IMintable(security).mint(msg.sender, raw);
            vm.stopBroadcast();
            console2.log("  minted (raw)", raw);

            vm.startBroadcast();
            IMintable(security).approve(marketAddr, raw);
            vm.stopBroadcast();

            vm.startBroadcast();
            uint256 id = market.list(security, raw, p.priceTinybar);
            vm.stopBroadcast();
            console2.log("  listing", id);
            console2.log("  price (tinybar)", p.priceTinybar);
        }

        console2.log("");
        console2.log("Done. Open the Share market app and press 'Read the market'.");
        console2.log("Record the new addresses in app/packages/apps/ats/src/securities.ts");
        console2.log("only if you want them named there -- the console reads name()");
        console2.log("and symbol() from the contract either way.");
    }
}
