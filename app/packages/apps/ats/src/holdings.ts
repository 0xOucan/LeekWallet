/**
 * What this wallet holds, and what it is allowed to do, per security.
 *
 * ---------------------------------------------------------------------------
 * Why the issuer role is READ rather than assumed
 *
 * The retired pilot in `securities.ts` is the whole argument: it was deployed
 * with `DEFAULT_ADMIN_ROLE` and nothing else, its register reads entirely
 * normally, and `mint` reverts on chain — after the press — with
 * `AccountHasNoRole`. Nothing visible on a dashboard distinguishes it from a
 * security this wallet can mint. `hasRole(ROLE_ISSUER, account)` does, it costs
 * one word in a batch that is already going out, and so it is asked every time
 * rather than inferred from "we deployed this" or from holding a balance.
 *
 * And the answer has three states, not two. `unsupported` (the facet reverted)
 * and `unavailable` (nobody answered) are NOT "you are not the issuer": a mint
 * form greyed out because the RPC was down would teach its user that they lost
 * a role they still hold. `canMint()` below returns `true` only for a read that
 * came back `ok: true`, and the view prints the other two as what they are.
 *
 * ---------------------------------------------------------------------------
 * Why the plain transfer lives here too
 *
 * Sending shares to a holder is not an issuer power — it is an ordinary ERC-20
 * `transfer` of something this wallet owns, and it belongs beside the balance
 * that makes it possible rather than inside the privileged table. Folding it
 * into `ACTIONS` (descriptors.ts) would put it in front of
 * `describePrivilegedCall`, which would then owe it a consequence line about an
 * authority it does not confer — the same reasoning market.ts gives for keeping
 * `approve` out of that table.
 *
 * It needs a descriptor of its own for the same reason every other call does:
 * with none, `screenProposal` refuses and nothing is signed. `transfer(address,
 * uint256)` is all static arguments, so the shared engine renders it in full.
 */

import { AbiError, type EthRequest } from "@leekwallet/core/balances.ts";
import { parseDescriptor, type Descriptor } from "@leekwallet/core/erc7730.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import type { Call3 } from "@leekwallet/core/multicall.ts";
import {
  addressWord, bytes32Word, decodeString, decodeUint, decodeUint8, encode, selectorOf, word,
} from "./abi.ts";
import { callBatch, mapOutcome, unavailable, type Outcome, type ReadContext } from "./register.ts";
import { ROLES } from "./roles.ts";

/* ------------------------------------------------------------------- roles */

/**
 * `ROLE_ISSUER`, taken from the role table by name rather than pasted.
 *
 * roles.ts explains why the ids are copied from the contracts and never
 * derived; taking one out of that table by its own name means this file cannot
 * hold a second, differently-wrong copy of 32 bytes of hex. A missing entry
 * throws at module load, where it is a build failure, rather than producing a
 * role nobody holds — which reads on screen as "you are not the issuer".
 */
export const ROLE_ISSUER = ((): string => {
  const found = ROLES.find((r) => r.name === "Issuer");
  if (!found) throw new Error("the role table has no Issuer role");
  return found.id;
})();

/* ---------------------------------------------------------------- the read */

/** Everything one row of the holdings table is built from. Each field its own outcome. */
export interface Holding {
  address: string;
  /** `balanceOf(account)` in raw units. Never scaled here; decimals travel beside it. */
  balance: Outcome<bigint>;
  /** `decimals()`. A label for the balance, and absent means the balance stays raw. */
  decimals: Outcome<number>;
  /** `hasRole(ROLE_ISSUER, account)`. Three states; see the header. */
  issuer: Outcome<boolean>;
  /** `totalSupply()`, so a zero balance in a zero-supply security reads as one. */
  totalSupply: Outcome<bigint>;
  /**
   * `name()` and `symbol()`, READ FROM THE CONTRACT.
   *
   * This console used to print a symbol from a table checked into this repo and
   * say, honestly but uselessly, that it was "this app's own note". A note is
   * what you write when you cannot ask. You can ask: these are ordinary view
   * functions and every RPC answers them, verified source or not — verification
   * lets a human read the source on an explorer and has nothing to do with
   * reading a value.
   *
   * Still untrusted text: `decodeString` bounds the length and refuses anything
   * that is not printable, because a contract chooses its own name and a name
   * with a right-to-left override in it is a name that lies on screen. A
   * security that will not say what it is called is shown by address, which is
   * the only identifier that was ever load-bearing.
   *
   * `undefined` INSIDE an ok outcome is its own third state, matching
   * register.ts: the call answered, and what it answered was not a string this
   * app will put on a screen. That is different from nobody answering.
   */
  name: Outcome<string | undefined>;
  symbol: Outcome<string | undefined>;
}

export const HOLDINGS_NOTICE =
  "Every figure in this table came from the chain at the block named above it. " +
  "A row that says it could not be read is not a row that says zero: a " +
  "balance nobody answered for and a balance of nothing are different facts, " +
  "and only one of them means you have nothing to sell.";

/**
 * Read balance, decimals, issuer role and supply for each security, in order.
 *
 * One `aggregate3`, four calls per security, always returned in the order given
 * — a caller zips this against its own list and must never have to check
 * whether the lengths still line up. `callBatch` discards a batch whose length
 * disagrees rather than aligning it optimistically, which is what makes that
 * promise keepable.
 *
 * `ctx.token` is unused by this function: every call names its own target,
 * because the whole point is that the targets differ. It is set to the first
 * security so the context is well-formed rather than half-built.
 */
export async function readHoldings(
  request: EthRequest,
  chainId: number,
  account: string,
  securities: readonly string[],
  block = "latest",
  host: () => string | undefined = () => undefined,
): Promise<Holding[]> {
  addressWord(account);
  if (securities.length === 0) return [];
  const ctx: ReadContext = {
    request, chainId, token: securities[0] as string, block, host,
  };

  const calls: Call3[] = [];
  for (const security of securities) {
    addressWord(security);
    calls.push({ target: security, allowFailure: true, callData: encode("balanceOf", [addressWord(account)]) });
    calls.push({ target: security, allowFailure: true, callData: encode("decimals") });
    calls.push({
      target: security, allowFailure: true,
      callData: encode("hasRole", [bytes32Word(ROLE_ISSUER), addressWord(account)]),
    });
    calls.push({ target: security, allowFailure: true, callData: encode("totalSupply") });
    calls.push({ target: security, allowFailure: true, callData: encode("name") });
    calls.push({ target: security, allowFailure: true, callData: encode("symbol") });
  }
  const out = await callBatch(ctx, calls);
  const at = (i: number): Outcome<string> =>
    out[i] ?? unavailable<string>("the multicall returned no entry for this call");

  return securities.map((address, i) => ({
    address: address.toLowerCase(),
    balance: mapOutcome(at(i * 6), decodeUint),
    decimals: mapOutcome(at(i * 6 + 1), decodeUint8),
    /* `decodeBool` would do, and this is the same check written where the
     * three-state reading matters: only an explicit 1 is "yes". */
    issuer: mapOutcome(at(i * 6 + 2), (d) => {
      const v = decodeUint(d);
      if (v > 1n) throw new AbiError("hasRole answered with neither 0 nor 1");
      return v === 1n;
    }),
    totalSupply: mapOutcome(at(i * 6 + 3), decodeUint),
    /* Same bound register.ts uses: a symbol is short, and one that is not is
     * not a symbol. */
    name: mapOutcome(at(i * 6 + 4), (d) => decodeString(d)),
    symbol: mapOutcome(at(i * 6 + 5), (d) => decodeString(d, 16)),
  }));
}

/**
 * May this wallet mint into this security?
 *
 * `true` only on a read that came back. Everything else — a revert, an
 * unreachable node, a missing row — is `false` HERE and must be rendered by the
 * caller as "not known", never as "no". The two are kept apart by
 * `mintRefusal` below, which is the sentence a view prints.
 */
export const canMint = (holding: Holding): boolean =>
  holding.issuer.state === "ok" && holding.issuer.value;

/** Why a mint is not offered, in words, or undefined when it is. */
export function mintRefusal(holding: Holding): string | undefined {
  const role = holding.issuer;
  if (role.state === "ok") {
    return role.value
      ? undefined
      : "this wallet does not hold ROLE_ISSUER on this security, so a mint would " +
        "revert on chain after the press. Granting it is the admin's own call.";
  }
  if (role.state === "unsupported") {
    return (
      "this security's access-control facet reverted when asked whether this " +
      "wallet is an issuer. That is a fact about the deployment, not an answer, " +
      "and no mint is offered against a security this console could not question."
    );
  }
  return (
    `nobody answered whether this wallet holds ROLE_ISSUER here (${role.why}). ` +
    "That is not the same as being told no, and it is not a reason to show a " +
    "form that would revert — read again."
  );
}

/** Has this wallet anything to sell here? Same three-state rule as above. */
export const canSell = (holding: Holding): boolean =>
  holding.balance.state === "ok" && holding.balance.value > 0n;

/* ---------------------------------------------------------------- transfer */

export interface TransferCall {
  to: string;
  data: string;
  label: string;
}

/**
 * A plain ERC-20 transfer of shares this wallet already holds.
 *
 * Throws on a malformed input rather than returning a refusal, matching
 * `encodePrivileged`: every argument here has been through a form, and a bad
 * address at this depth is a programming mistake. `runTransfer` turns the throw
 * into an outcome so nothing escapes as an exception.
 */
export function encodeSecurityTransfer(
  security: string, to: string, amount: bigint,
): TransferCall {
  if (amount <= 0n) throw new AbiError("a transfer of nothing moves nothing");
  return {
    to: security.toLowerCase(),
    data: `0x${selectorOf("transfer(address,uint256)")}${addressWord(to)}${word(amount)}`,
    label: `transfer ${amount} raw units to ${to}`,
  };
}

export const TRANSFER_DESCRIPTOR_SOURCE = "local/ats-security-transfer";

/**
 * The descriptor without which a transfer cannot be signed.
 *
 * Built around the security's address, like every other descriptor in this app,
 * because each issuance is a fresh diamond at a fresh address and no constant
 * in core could name them all. Both arguments are static, so the engine renders
 * the call in full and `screenProposal` has nothing to omit.
 *
 * The amount is `raw`, not `amount`: an `amount` format is rendered against the
 * chain's native decimals, and a security here has six of its own. A share
 * count shown against eighteen decimals is off by a factor of a trillion, which
 * is the same class of mistake market.ts refuses for a price.
 */
export function securityTransferDescriptors(
  chainId: number, security: string,
): readonly Descriptor[] {
  const parsed = parseDescriptor(
    {
      context: { contract: { deployments: [{ chainId, address: security.toLowerCase() }] } },
      metadata: { owner: "ATS security", contractName: "ATS security" },
      display: {
        formats: {
          "transfer(address to, uint256 amount)": {
            intent: "Send shares",
            fields: [
              { label: "To", path: "#.to", format: "addressName" },
              { label: "Shares (raw)", path: "#.amount", format: "raw" },
            ],
          },
        },
      },
    },
    TRANSFER_DESCRIPTOR_SOURCE,
  );
  return parsed === null ? [] : [parsed];
}

/** What one attempted transfer did. Same vocabulary as act.ts. */
export type TransferOutcome =
  | { kind: "sent"; result: string; call: TransferCall }
  | { kind: "refused"; reason: string }
  | { kind: "declined"; notice: string; call: TransferCall }
  | { kind: "cannot-ask"; notice: string };

export const TRANSFER_NO_DEVICE_NOTICE =
  "Nothing was asked for and nothing was signed: this build has no way to " +
  "reach a device. Connect one and try again.";

export const TRANSFER_DECLINED_NOTICE =
  "The wallet did not sign this transfer. That covers a rejection on the " +
  "device, a wallet that would not describe the call, and a device that is no " +
  "longer connected — an app is not told which, and the reason is in the " +
  "wallet's own log. Nothing was sent.";

/**
 * Ask for one transfer. One press, no retry.
 *
 * A share transfer is subject to the security's own control list, KYC, pause
 * and freeze rules, exactly as a market fill is, and nothing here can tell in
 * advance whether the recipient may hold these shares: the contract decides at
 * execution, on chain, after the press. The view says so; this function does
 * not pretend to know.
 */
export async function runTransfer(
  context: AppContext,
  security: string,
  to: string,
  amount: bigint,
): Promise<TransferOutcome> {
  let call: TransferCall;
  try {
    call = encodeSecurityTransfer(security, to, amount);
  } catch (e) {
    return { kind: "refused", reason: String((e as Error)?.message ?? e) };
  }
  const propose = context.propose;
  if (!propose) return { kind: "cannot-ask", notice: TRANSFER_NO_DEVICE_NOTICE };

  const outcome = await propose({
    kind: "call",
    to: call.to,
    data: call.data,
    reason: `send shares: ${call.label}`.slice(0, 120),
  });
  if (!outcome.ok || outcome.kind !== "call") {
    return { kind: "declined", notice: TRANSFER_DECLINED_NOTICE, call };
  }
  return { kind: "sent", result: outcome.result, call };
}
