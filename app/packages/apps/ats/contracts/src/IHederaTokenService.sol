// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/**
 * The sliver of Hedera's token-service system contract this market needs.
 *
 * Hedera exposes HTS at the fixed address 0x167. Both USDC options on testnet
 * are HTS tokens, and an HTS token cannot be received by an account that is not
 * associated with it. A freshly deployed contract has no auto-association
 * slots, so without this call every payment leg reverts -- and it presents as
 * "the market is broken", not as a platform rule.
 */
interface IHederaTokenService {
    /// @return responseCode 22 (SUCCESS) on success. Anything else is a failure.
    function associateToken(address account, address token) external returns (int64 responseCode);
}

address constant HTS_PRECOMPILE = address(0x167);

// HTS ResponseCodeEnum.SUCCESS.
int64 constant HTS_SUCCESS = 22;

// HTS ResponseCodeEnum.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT.
int64 constant HTS_ALREADY_ASSOCIATED = 194;
