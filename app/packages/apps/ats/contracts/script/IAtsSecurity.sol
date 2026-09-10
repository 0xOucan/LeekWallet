// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/**
 * The slice of a deployed ATS security these scripts call.
 *
 * An ATS security is a diamond: `name`, `mint`, `hasRole` and `paused` live on
 * different facets but answer at the one token address. Every signature below
 * was taken from the compiled ABI of the Hashgraph ATS contracts package at
 * 8.0.0, and the same set is what `app/packages/apps/ats/src/abi.ts` calls from
 * the console -- so a security these scripts can drive is one the console can
 * read, by construction rather than by coincidence.
 */
interface IAtsSecurity {
    /* ERC-20 surface (Core facet) */
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);

    /* Cap */
    function getMaxSupply() external view returns (uint256);

    /* Pause */
    function paused() external view returns (bool);

    /* Mint -- requires ROLE_ISSUER or ROLE_AGENT. */
    function mint(address to, uint256 amount) external returns (bool);

    /* AccessControl */
    function hasRole(bytes32 role, address account) external view returns (bool);

    /* SecurityHolders -- the register the console reads. */
    function getTotalSecurityHolders() external view returns (uint256);
}
