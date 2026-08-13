/**
 * The JSON-RPC errors this wallet returns to a dapp (T32).
 *
 * These matter more than they look. A dapp that asks for something this wallet
 * cannot do gets one of exactly three answers: the result, a refusal with a
 * code it can branch on, or nothing at all. The third is the one to avoid —
 * a request left unanswered leaves the dapp spinning forever, and the user
 * concludes the *device* is broken. So every path in requests.ts ends in a
 * result or in one of these.
 *
 * Codes are the standard ones rather than anything invented here, because the
 * whole value of a code is that the dapp already knows it:
 *
 * - EIP-1193 provider errors: 4001 rejected, 4100 unauthorized, 4200
 *   unsupported method.
 * - EIP-3326: 4902 unrecognized chain, which is how a dapp knows to offer
 *   `wallet_addEthereumChain` instead of giving up.
 * - EIP-1474: -32003 "transaction rejected", used for the case that is
 *   genuinely ours — the device will not sign what it cannot display.
 *
 * The message strings are shown to users by many dapps, so they say what
 * happened and, where it is actionable, what to do about it.
 */

export interface JsonRpcErrorBody {
  code: number;
  message: string;
}

/** The user pressed reject here, or on the device. EIP-1193 4001. */
export const USER_REJECTED: JsonRpcErrorBody = {
  code: 4001,
  message: "Rejected on the LeekWallet device.",
};

/** The device did not answer in time — not a refusal, and worth distinguishing. */
export const DEVICE_TIMEOUT: JsonRpcErrorBody = {
  code: 4001,
  message: "No answer from the LeekWallet device before it timed out.",
};

/** Asked to sign for an address this wallet did not offer. EIP-1193 4100. */
export const UNAUTHORIZED_ACCOUNT: JsonRpcErrorBody = {
  code: 4100,
  message: "This wallet has not authorised that address for this session.",
};

/**
 * A method the wallet will not serve at all. EIP-1193 4200.
 *
 * Takes a reason because "unsupported" alone sends users to a support forum.
 * The typed-data case in particular is a firmware gap with a name, and saying
 * so is more useful than a shrug.
 */
export function unsupportedMethod(method: string, why: string): JsonRpcErrorBody {
  return { code: 4200, message: `${method} is not supported by LeekWallet: ${why}` };
}

/**
 * The device would refuse this before showing a confirmation screen.
 *
 * -32003 rather than 4001: nobody rejected anything, and reporting a user
 * rejection that did not happen would be a lie to the dapp. This is the
 * blind-signing boundary from PROTOCOL.md 6bis showing through the API.
 */
export function deviceCannotDisplay(why: string): JsonRpcErrorBody {
  return {
    code: -32003,
    message:
      `The LeekWallet device cannot display this request, so it will not sign it: ${why} ` +
      `Signing something the device cannot show you would be blind signing.`,
  };
}

/** EIP-3326: the dapp may respond by offering to add the chain. */
export function unrecognisedChain(chainId: number): JsonRpcErrorBody {
  return {
    code: 4902,
    message: `This wallet has no entry for chain ${chainId}, so it cannot name the network a signature would be valid on.`,
  };
}

/** Malformed parameters from the dapp. Standard JSON-RPC -32602. */
export function invalidParams(why: string): JsonRpcErrorBody {
  return { code: -32602, message: `Invalid parameters: ${why}` };
}

/** Something failed on this side. -32603, and never used to hide a refusal. */
export function internalError(why: string): JsonRpcErrorBody {
  return { code: -32603, message: why };
}
