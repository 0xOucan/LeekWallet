// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @title GateToken
/// @notice A fixed-supply ERC-20 whose only job is to be an argument to SwapVM
///         opcode 14, `onlyTakerTokenBalanceNonZero`.
///
/// @dev Why this contract exists at all, in one paragraph.
///
/// An Aqua position shipped with no taker restriction is fillable by anyone,
/// which on a mainnet with real funds means "by a bot, immediately, at the
/// worst moment for the maker". Every restriction Aqua offers costs somebody
/// else's permission — a KycNFT gate needs 1inch's issuer, a resolver
/// whitelist needs the resolver set. Opcode 14 is the exception: it accepts an
/// arbitrary token address and requires only that the taker's balance of it is
/// non-zero. Point it at a token whose entire supply we minted to our own
/// taker address and the pool stays permissionless in the protocol sense —
/// there is no gate contract, no allowlist, no privileged caller, anyone MAY
/// call — while in practice only a holder can fill.
///
/// That is a real centralisation and this contract does not pretend otherwise:
/// anyone reading the program sees opcode 14 and a token address, and nothing
/// on chain tells them whether that token is widely held. It is not. The
/// supply is minted once, to one address, in the constructor, and the pool
/// must never be described as "permissionless" without that qualifier. See
/// ../docs/STRATEGIES.md §5 and §6.4.
///
/// @dev Why it is written out rather than inherited from OpenZeppelin.
///
/// This is ~60 lines of ERC-20 with no allowance-race mitigation to argue
/// about, no hooks, no permit, no owner and no upgrade path, and it pulls in
/// no dependency the repository would then have to vendor, license-check and
/// keep current for a contract that guards two demo positions. The audit
/// surface is the whole file and it fits on one screen. The tradeoff runs the
/// other way for anything that holds value; this holds none.
///
/// SECURITY PROPERTIES, all of them by construction rather than by check:
///
///   * `totalSupply` is set once, in the constructor, and no code path
///     anywhere increases or decreases it. There is no `mint`, no `burn`, no
///     `owner`, no `pause`, no `delegatecall`, no `selfdestruct`, no fallback
///     and no `receive`. The contract cannot hold ETH or any other token.
///   * No transfer hook, no callback, no external call of any kind. There is
///     therefore no reentrancy surface — not "guarded", absent.
///   * Balances only ever move between accounts, so the sum of balances is
///     invariant and equals `totalSupply`. Proved by fuzz in the test suite.
///   * `decimals` is 0. The token is a credential, not an amount: one unit is
///     "you may fill", and a fractional credential is meaningless. Opcode 14
///     tests only for non-zero, so the magnitude never matters.
contract GateToken {
    /* ------------------------------------------------------------ metadata */

    string public constant name = "LeekWallet Aqua Gate";
    string public constant symbol = "LWGATE";

    /// @notice Zero, deliberately. This is a credential, not an amount.
    /// @dev Opcode 14 tests `balanceOf(taker) != 0`, so the only distinction
    ///      that has any effect on chain is zero versus non-zero. Giving the
    ///      token 18 decimals would invite a reader to interpret a balance as
    ///      a quantity that means something. It does not.
    uint8 public constant decimals = 0;

    /* --------------------------------------------------------------- state */

    uint256 public immutable totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    /* -------------------------------------------------------------- errors */

    error ZeroAddress();
    error InsufficientBalance(uint256 available, uint256 needed);
    error InsufficientAllowance(uint256 available, uint256 needed);

    /* -------------------------------------------------------------- events */

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /* --------------------------------------------------------- constructor */

    /// @param holder The taker address the entire supply is minted to. This is
    ///        the address that will be permitted to fill the gated positions,
    ///        and it is fixed here because there is no other way to change it.
    /// @param supply The whole supply, minted once. Must be non-zero, since a
    ///        gate token nobody can hold gates the position shut forever.
    constructor(address holder, uint256 supply) {
        require(holder != address(0), ZeroAddress());
        require(supply != 0, InsufficientBalance(0, 1));
        totalSupply = supply;
        balanceOf[holder] = supply;
        /* The mint, as ERC-20 requires it to be observable: from the zero
         * address. Without this, an indexer reconstructing balances from logs
         * would never see the supply come into existence. */
        emit Transfer(address(0), holder, supply);
    }

    /* ------------------------------------------------------------ transfer */

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        /* An infinite allowance is NOT special-cased. Every other ERC-20 skips
         * the decrement when the allowance is `type(uint256).max`, as a gas
         * optimisation that also makes an unlimited approval cheaper to live
         * with. This repository's whole position on approvals is that an
         * unlimited one is never the right answer, so nothing here is built to
         * make one convenient. The decrement always happens. */
        require(allowed >= value, InsufficientAllowance(allowed, value));
        unchecked {
            /* Safe: the branch above proves allowed >= value. */
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Set `spender`'s allowance to exactly `value`.
    /// @dev The classic ERC-20 approve race (a spender front-running a change
    ///      from N to M and spending N+M) is not mitigated here, and that is a
    ///      deliberate non-decision rather than an oversight: this token is
    ///      never approved to anything. It is held, and read by opcode 14. The
    ///      function exists because ERC-20 requires it, and callers who need
    ///      the safe pattern should approve to zero first.
    function approve(address spender, uint256 value) external returns (bool) {
        require(spender != address(0), ZeroAddress());
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /* -------------------------------------------------------------- internal */

    function _transfer(address from, address to, uint256 value) private {
        /* Refused rather than allowed as a burn. A transfer to the zero
         * address would reduce the circulating supply while `totalSupply`
         * stayed constant, which quietly breaks the invariant this contract's
         * whole audit rests on -- and a gate token burned by accident locks
         * the position shut with no way back, since there is no mint. */
        require(to != address(0), ZeroAddress());

        uint256 balance = balanceOf[from];
        require(balance >= value, InsufficientBalance(balance, value));
        unchecked {
            /* Safe: the branch above proves balance >= value, and the
             * credit cannot overflow because every balance is bounded by
             * totalSupply, which is itself a uint256 set once. */
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
