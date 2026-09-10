// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

import { IHederaTokenService, HTS_PRECOMPILE, HTS_SUCCESS, HTS_ALREADY_ASSOCIATED } from "./IHederaTokenService.sol";

/**
 * A secondary market for Hedera ATS securities, with compliance enforced where
 * it belongs: inside the security.
 *
 * ---------------------------------------------------------------------------
 * The one idea this contract is built around
 *
 * It does NOT check whether a trade is allowed. It attempts the transfer and
 * lets the security's own guards -- control list, KYC, pause, frozen balance --
 * revert it. A revert in either leg reverts the whole fill.
 *
 * That is deliberate. A market that pre-checks compliance can be wrong about
 * the rule; a market that never evaluates the rule cannot be. It also means
 * this contract keeps working when the issuer changes the compliance regime,
 * because it never encoded a copy of it.
 *
 * ---------------------------------------------------------------------------
 * Escrow, and what it costs
 *
 * `list` moves the security into this contract. That makes a fill predictable
 * -- the asset is already in hand, so the only thing that can fail at fill time
 * is the buyer's own eligibility -- but it has a consequence worth stating
 * rather than discovering:
 *
 *   If a seller is frozen AFTER listing, `cancel` cannot return their shares.
 *   The market -> seller transfer reverts and the shares stay escrowed.
 *
 * There is no rescue function here, and that is on purpose. A rescue function
 * is an admin key over other people's securities, which is precisely what a
 * compliance regime exists to prevent. The recovery path is the issuer's own
 * `controllerTransfer` -- the forced transfer, an irreversible privileged act
 * that the LeekWallet console renders on the device before it is signed.
 * Recovery belongs to the issuer, under the device, not to this contract.
 *
 * ---------------------------------------------------------------------------
 * Two payment legs
 *
 * `PAYMENT_TOKEN == address(0)` means the market settles in **native HBAR**;
 * any other address means that ERC-20 (on Hedera, an HTS token reached through
 * its ERC-20 facade).
 *
 * Native settlement exists because HTS association is a real obstacle: a token
 * cannot be received by an account that has not associated with it, which
 * silently defeats faucets and fresh contracts alike. HBAR needs none of that.
 *
 * **Two HBAR units, on opposite sides of the relay.** This took two failures
 * to pin down and both halves are true:
 *
 *   tx `value` field   25e18 weibar    <- what a caller signs and sends
 *        Hedera's relay divides by 1e10
 *   `msg.value`        2.5e9 tinybar   <- what THIS CONTRACT compares
 *
 * So a `priceTotal` for the native leg is in **TINYBAR** (1 HBAR = 1e8),
 * because it is compared against `msg.value` -- while a caller must send a
 * transaction value of `priceTotal * 1e10`.
 *
 * How each half was found, since neither is guessable and a local EVM has no
 * relay to reveal either:
 *
 *   1. Pricing a lot at `25e18` reverted `WrongPayment(2500000000,
 *      25000000000000000000)` -- exactly 1e10 apart. That gave us msg.value's
 *      unit.
 *   2. Then sending a transaction value of `2.5e9` was refused by the relay
 *      before it reached the contract at all: "Value can't be non-zero and
 *      less than 10_000_000_000 wei which is 1 tinybar". That gave us the
 *      transaction field's unit.
 *
 * The exact-value comparison is what made the first one cheap: 0.046 HBAR of
 * gas, nothing stranded, and both numbers named in the error so the ratio was
 * legible. An "approximately equal" check would have filled the lot at 1e-10
 * of its price.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately absent
 *
 * No proxy (so no initializer or storage-ordering hazard). No signatures (so no
 * replay surface). No delegatecall. No oracle -- the seller names a total
 * price, so there is no spot price to manipulate and no per-share division to
 * truncate. No owner and no admin functions at all. Each omission removes a
 * class of risk rather than mitigating one.
 */
contract AtsEscrowMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* --------------------------------------------------------------- types */

    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    struct Listing {
        address seller;
        address security;
        /// Escrowed amount, MEASURED from the balance delta, not the amount asked for.
        uint256 amount;
        /// Total price for the whole lot, in `PAYMENT_TOKEN` base units.
        uint256 priceTotal;
        Status status;
    }

    /* -------------------------------------------------------------- errors */

    error ZeroAddress();
    error ZeroAmount();
    error ZeroPrice();
    error NotOpen(uint256 listingId);
    error NotSeller(uint256 listingId, address caller);
    error NothingEscrowed(address security);
    error AssociationFailed(int64 responseCode);
    error SelfFill(uint256 listingId);
    error WrongPayment(uint256 sent, uint256 required);
    error NativeTransferFailed(address to, uint256 amount);

    /* -------------------------------------------------------------- events */

    event Listed(
        uint256 indexed listingId,
        address indexed seller,
        address indexed security,
        uint256 amount,
        uint256 priceTotal
    );
    event Cancelled(uint256 indexed listingId, address indexed seller, uint256 amount);
    event Filled(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed security,
        uint256 amount,
        uint256 priceTotal
    );

    /* -------------------------------------------------------------- storage */

    /// The payment leg. Immutable: a market that can change what it settles in
    /// is a market whose listings mean something different after the change.
    IERC20 public immutable PAYMENT_TOKEN;

    /// Read, never assumed, for the ERC-20 leg. For the native leg this is 18,
    /// because `msg.value` is weibar -- NOT 8, which is what HBAR has natively.
    /// Stored for callers and display; this contract does no scaling of its
    /// own, because `priceTotal` is a total (see below).
    uint8 public immutable PAYMENT_DECIMALS;

    /// True when this market settles in native HBAR.
    bool public immutable IS_NATIVE;

    uint256 public nextListingId = 1;

    mapping(uint256 listingId => Listing) public listings;

    /* --------------------------------------------------------- constructor */

    /**
     * @param paymentToken The settlement token. On Hedera testnet this is an
     *        HTS token, so this contract associates itself with it here. Without
     *        that, this contract cannot receive a single unit and every fill
     *        reverts for a reason that looks nothing like the cause.
     */
    constructor(IERC20 paymentToken) {
        PAYMENT_TOKEN = paymentToken;

        if (address(paymentToken) == address(0)) {
            /* Native HBAR. No association, no metadata call, nothing to get
             * wrong -- which is the entire reason this leg exists. 18 because
             * msg.value is weibar. */
            IS_NATIVE = true;
            /* 8, not 18. msg.value arrives in tinybar on Hedera -- see the
             * header. Reporting 18 here would tell every caller to price a lot
             * 1e10 too high, which is precisely the fill that reverted. */
            PAYMENT_DECIMALS = 8;
            return;
        }

        IS_NATIVE = false;
        PAYMENT_DECIMALS = IERC20Metadata(address(paymentToken)).decimals();

        /* Associate with the payment token. Tolerated outcomes are SUCCESS and
         * ALREADY_ASSOCIATED; anything else must stop deployment, because the
         * failure is silent afterwards.
         *
         * A low-level call rather than a typed one: on a non-Hedera chain (a
         * local fuzz run, a forge test) address 0x167 has no code and a typed
         * call would revert on the empty return. There, association is not a
         * concept and its absence is correct. */
        (bool ok, bytes memory ret) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), address(paymentToken))
        );
        if (ok && ret.length >= 32) {
            int64 code = abi.decode(ret, (int64));
            if (code != HTS_SUCCESS && code != HTS_ALREADY_ASSOCIATED) revert AssociationFailed(code);
        }
    }

    /* ------------------------------------------------------------ listing */

    /**
     * Escrow `amount` of `security` and offer the lot for `priceTotal`.
     *
     * `priceTotal` is the price of the WHOLE lot, not a unit price. That is a
     * safety property, not a UX choice: there is no per-share figure to divide
     * by, so there is no truncation-to-zero and no multiply-before-divide
     * ordering hazard anywhere in this contract.
     *
     * The escrowed amount is the measured balance delta. If the security moves
     * less than requested -- a transfer hook, a fee, a partition quirk -- the
     * listing reflects what actually arrived, so a fill can always deliver it.
     */
    function list(address security, uint256 amount, uint256 priceTotal)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (security == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (priceTotal == 0) revert ZeroPrice();

        uint256 before = IERC20(security).balanceOf(address(this));
        IERC20(security).safeTransferFrom(msg.sender, address(this), amount);
        uint256 escrowed = IERC20(security).balanceOf(address(this)) - before;
        if (escrowed == 0) revert NothingEscrowed(security);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            security: security,
            amount: escrowed,
            priceTotal: priceTotal,
            status: Status.Open
        });

        emit Listed(listingId, msg.sender, security, escrowed, priceTotal);
    }

    /**
     * Withdraw an unsold listing.
     *
     * Reverts if the seller can no longer receive their own security -- frozen,
     * KYC revoked, security paused. That revert comes from the security, and it
     * is the compliance regime working, not a fault here. See the contract
     * header for the recovery path.
     */
    function cancel(uint256 listingId) external nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != Status.Open) revert NotOpen(listingId);
        if (l.seller != msg.sender) revert NotSeller(listingId, msg.sender);

        /* Effects before interactions: the listing is closed before any token
         * moves, so a re-entrant call through the security's hooks finds a
         * listing that is no longer Open. */
        l.status = Status.Cancelled;
        uint256 amount = l.amount;
        address security = l.security;

        IERC20(security).safeTransfer(msg.sender, amount);

        emit Cancelled(listingId, msg.sender, amount);
    }

    /**
     * Buy a listed lot: pay `priceTotal`, receive `amount` of the security.
     *
     * Both legs settle in one transaction or neither does. There is no state in
     * which the buyer has paid and not received, because a revert on the
     * security leg unwinds the payment leg with it.
     *
     * No compliance check happens here. If the buyer may not hold this security
     * the security itself reverts, and this fill reverts with it.
     */
    function fill(uint256 listingId) external payable nonReentrant {
        Listing storage l = listings[listingId];
        if (l.status != Status.Open) revert NotOpen(listingId);
        if (l.seller == msg.sender) revert SelfFill(listingId);

        l.status = Status.Filled;
        address seller = l.seller;
        address security = l.security;
        uint256 amount = l.amount;
        uint256 priceTotal = l.priceTotal;

        /* Payment goes buyer -> seller directly. This contract never holds the
         * payment between the two legs, so there is no balance here for a
         * failed fill to strand.
         *
         * Exact value only, on both legs. Accepting an overpayment would mean
         * either keeping the difference or refunding it, and a refund is a
         * second external call to an address that may not accept one. */
        if (IS_NATIVE) {
            if (msg.value != priceTotal) revert WrongPayment(msg.value, priceTotal);
            (bool paid,) = seller.call{ value: priceTotal }("");
            if (!paid) revert NativeTransferFailed(seller, priceTotal);
        } else {
            if (msg.value != 0) revert WrongPayment(msg.value, 0);
            PAYMENT_TOKEN.safeTransferFrom(msg.sender, seller, priceTotal);
        }

        IERC20(security).safeTransfer(msg.sender, amount);

        emit Filled(listingId, msg.sender, security, amount, priceTotal);
    }

    /* --------------------------------------------------------------- views */

    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }
}
