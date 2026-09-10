// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import { ERC20 } from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/**
 * A stand-in for an ATS security that enforces the guards that actually matter
 * to the market: frozen addresses, a KYC requirement, and a global pause.
 *
 * The point is not to reimplement ERC-1400. It is to make the market's reverts
 * REAL in tests rather than mocked away, so "a frozen buyer cannot fill" is
 * proved by a transfer that genuinely refuses.
 */
contract MockSecurity is ERC20 {
    error AddressFrozen(address who);
    error KycMissing(address who);
    error SecurityPaused();

    mapping(address => bool) public frozen;
    mapping(address => bool) public kyc;
    bool public kycRequired;
    bool public paused;

    uint8 private immutable _dec;

    constructor(uint8 d) ERC20("Mock Equity", "MEQ") {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setFrozen(address who, bool v) external {
        frozen[who] = v;
    }

    function setKyc(address who, bool v) external {
        kyc[who] = v;
    }

    function setKycRequired(bool v) external {
        kycRequired = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert SecurityPaused();
        if (from != address(0) && frozen[from]) revert AddressFrozen(from);
        if (to != address(0) && frozen[to]) revert AddressFrozen(to);
        if (kycRequired) {
            if (from != address(0) && !kyc[from]) revert KycMissing(from);
            if (to != address(0) && !kyc[to]) revert KycMissing(to);
        }
        super._update(from, to, value);
    }
}

/// A plain 6-decimal payment token. On a local chain 0x167 has no code and
/// association is not a concept, which the market handles by construction.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}
