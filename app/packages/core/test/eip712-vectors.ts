/**
 * The typed-data documents both implementations are checked against.
 *
 * Shared rather than duplicated because they exist to be compared: the same
 * three documents appear byte for byte in sim/test_eip712.c, and the digests
 * asserted there are the ones this file's tests recompute with viem. Two
 * independent implementations agreeing on a published vector is evidence; one
 * implementation agreeing with itself is not.
 *
 * `mail` is the worked example from EIP-712 itself, digests and all — the one
 * vector here whose expected values come from the specification rather than
 * from another library. The other two are the shapes that actually get signed
 * in anger: an ERC-2612 `Permit` with an infinite allowance, and a Permit2
 * `PermitSingle`, which is a nested struct and so exercises the referenced-type
 * ordering that a flat document never touches.
 */

export interface TypedDataVector {
  readonly name: string;
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
  /** keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)). */
  readonly digest: `0x${string}`;
}

const DOMAIN_NVC = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** EIP-712's own example. Every value below is quoted from the EIP. */
export const MAIL: TypedDataVector = {
  name: "mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    EIP712Domain: DOMAIN_NVC,
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
  digest: "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
};

/**
 * ERC-2612 `Permit` against USDC, for an unlimited allowance.
 *
 * This is the drainer's document. No gas, no transaction in the victim's
 * history, and the spender can empty the token at leisure afterwards — which is
 * why `value` here is 2^256-1 and why both implementations have to name that as
 * unlimited rather than printing seventy-eight digits.
 */
export const PERMIT: TypedDataVector = {
  name: "permit",
  domain: {
    name: "USD Coin",
    version: "2",
    chainId: 1,
    verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  types: {
    EIP712Domain: DOMAIN_NVC,
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  message: {
    owner: "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4",
    spender: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    value: 2n ** 256n - 1n,
    nonce: 0n,
    deadline: 1893456000n,
  },
  digest: "0x423a958ec72daf496fde79b12e292dd6ede371ac0707c0cc848dfe6d7d45d111",
};

/**
 * Permit2 `PermitSingle`, the nested case.
 *
 * `details` is a struct, so encodeType has to emit `PermitSingle(...)` followed
 * by `PermitDetails(...)` — referenced types sorted by name after the primary,
 * which is the rule a flat document never exercises and the one that silently
 * moves the digest when it is wrong. Note the domain carries no `version`:
 * Permit2's really does not, and a device that assumed one would compute a
 * different separator than the contract.
 */
export const PERMIT2: TypedDataVector = {
  name: "permit2",
  domain: {
    name: "Permit2",
    chainId: 1,
    verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
  },
  primaryType: "PermitSingle",
  message: {
    details: {
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: 2n ** 160n - 1n,
      expiration: 1735689600n,
      nonce: 0n,
    },
    spender: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    sigDeadline: 1735689600n,
  },
  digest: "0x4187039f3504daf157ed1635c74914209db8d42bc4c0e6984c0c9686647a4c78",
};

export const VECTORS: readonly TypedDataVector[] = [MAIL, PERMIT, PERMIT2];
