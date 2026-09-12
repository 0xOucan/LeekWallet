/**
 * Balances, the issuer role, and the plain transfer.
 *
 * The property this file is about is the one the retired pilot in
 * securities.ts teaches: **a role that could not be read is not a role you do
 * not have.** `hasRole` has three outcomes, a mint form is offered for exactly
 * one of them, and the other two get sentences of their own rather than a
 * greyed-out button. A console that hid the mint form because the RPC was down
 * would tell an issuer they had lost a power they still hold.
 *
 * The second group is the descriptor. `screenProposal` refuses any call no
 * bundled ERC-7730 descriptor renders in full, so the transfer this app builds
 * is put through the real gate here rather than discovered on a device.
 */

import { screenProposal } from "@leekwallet/core/app-proposal.ts";
import { DEFAULT_DESCRIPTORS } from "@leekwallet/core/tx-interpret.ts";
import {
  ROLE_ISSUER, canMint, canSell, encodeSecurityTransfer, mintRefusal,
  readHoldings, runTransfer, securityTransferDescriptors, type Holding,
} from "../src/holdings.ts";
import { addressWord, selectorOf, word } from "../src/abi.ts";
import { ROLES } from "../src/roles.ts";
import { KNOWN_SECURITIES } from "../src/securities.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const CHAIN = 296;
const ACCOUNT = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const RECIPIENT = "0x9c77c6fafc1eb0821f1de12972ef0199c97c6e45";
const A = KNOWN_SECURITIES[0]?.address as string;
const B = KNOWN_SECURITIES[1]?.address as string;

/** `(bool,bytes)[]`, the aggregate3 return, as the production decoder wants it. */
const encodeResults = (results: readonly { success: boolean; returnData: string }[]): string => {
  const bodies = results.map((r) => {
    const body = r.returnData.slice(2);
    const len = body.length / 2;
    return word(r.success ? 1n : 0n) + word(64n) + word(BigInt(len))
      + body.padEnd(Math.ceil(len / 32) * 64, "0");
  });
  let cursor = BigInt(results.length) * 32n;
  let offsets = "";
  for (const b of bodies) { offsets += word(cursor); cursor += BigInt(b.length / 2); }
  return `0x${word(32n)}${word(BigInt(results.length))}${offsets}${bodies.join("")}`;
};

const uint = (v: bigint): { success: true; returnData: string } =>
  ({ success: true, returnData: `0x${word(v)}` });
const reverted = { success: false, returnData: "0x" } as const;

/** An ABI-encoded `string` return: offset, length, then the padded bytes. */
const abiString = (text: string): { success: true; returnData: string } => {
  const bytes = new TextEncoder().encode(text);
  const body = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const padded = body.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return {
    success: true,
    returnData: "0x"
      + (32).toString(16).padStart(64, "0")
      + bytes.length.toString(16).padStart(64, "0")
      + padded,
  };
};

const run = async (): Promise<void> => {
  group("the issuer role id comes out of the role table");
  {
    check(ROLE_ISSUER === ROLES.find((r) => r.name === "Issuer")?.id,
      "ROLE_ISSUER is a second copy of the id rather than the table's");
    check(/^0x[0-9a-f]{64}$/.test(ROLE_ISSUER), "ROLE_ISSUER is not a 32-byte word");
  }

  group("six reads per security, in order, with each field its own outcome");
  {
    let seen = "";
    const request = async (req: { method: string; params?: unknown }): Promise<unknown> => {
      seen = ((req.params as Array<Record<string, string>>)[0]?.data ?? "");
      return encodeResults([
        /* A: balance 250, decimals 6, issuer yes, supply 2500, then name and
         * symbol — read from the contract now rather than taken from this
         * repo's table, which is why there are six calls and not four. */
        uint(250n), uint(6n), uint(1n), uint(2_500n), abiString("Acme Equity"), abiString("ACME"),
        /* B: balance reverted, decimals 6, issuer no, supply 0, and a name
         * nobody answered for — a security that will not say what it is
         * called is still a security, shown by address. */
        reverted, uint(6n), uint(0n), uint(0n), reverted, reverted,
      ]);
    };
    const holdings = await readHoldings(request as never, CHAIN, ACCOUNT, [A, B]);
    check(holdings.length === 2, "one row per security was not returned");
    check(holdings[0]?.address === A, "the rows are not in the order they were asked for");
    check(holdings[0]?.balance.state === "ok", "an answered balance is not ok");
    check(holdings[0]?.balance.state === "ok" && holdings[0].balance.value === 250n,
      "the balance is wrong");
    check(canMint(holdings[0] as Holding), "an issuer was not offered a mint");
    check(canSell(holdings[0] as Holding), "a wallet holding 250 units cannot sell");
    check(mintRefusal(holdings[0] as Holding) === undefined,
      "an issuer got a refusal sentence anyway");

    /* Name and symbol come off the chain, not out of a table. */
    check(holdings[0]?.name.state === "ok" && holdings[0].name.value === "Acme Equity",
      "the name was not read from the contract");
    check(holdings[0]?.symbol.state === "ok" && holdings[0].symbol.value === "ACME",
      "the symbol was not read from the contract");
    check(holdings[1]?.symbol.state !== "ok",
      "a security that refused to name itself was given a name anyway");

    /* The whole point: a reverted balance is NOT zero. */
    check(holdings[1]?.balance.state === "unsupported",
      "a reverted balance was reported as a figure");
    check(!canSell(holdings[1] as Holding), "a security whose balance reverted was offered for sale");
    check(!canMint(holdings[1] as Holding), "a wallet without the role was offered a mint");
    check(/does not hold ROLE_ISSUER/.test(mintRefusal(holdings[1] as Holding) as string),
      "an explicit no does not say the role is missing");

    /* The batch asked for exactly what it claims to have asked for. */
    check(seen.includes(selectorOf("balanceOf(address)")), "no balanceOf in the batch");
    check(seen.includes(selectorOf("hasRole(bytes32,address)")), "no hasRole in the batch");
    check(seen.includes(ROLE_ISSUER.slice(2)), "the issuer role id is not in the batch");
    check(seen.includes(addressWord(ACCOUNT)), "the account is not in the batch");
  }

  group("a role nobody answered for is not a role you do not have");
  {
    const dead = async (): Promise<never> => { throw new Error("hashio: timeout"); };
    const holdings = await readHoldings(dead as never, CHAIN, ACCOUNT, [A]);
    const row = holdings[0] as Holding;
    check(row.issuer.state === "unavailable", "a dead read did not come back unavailable");
    check(row.balance.state === "unavailable", "a dead read produced a balance");
    check(!canMint(row), "a dead read offered a mint form");
    const why = mintRefusal(row) as string;
    check(/not the same as being told no/.test(why),
      "an unreadable role is worded as a refusal by the contract");
    check(!/does not hold/.test(why), "an unreadable role is worded as 'you do not have it'");

    /* And the revert case gets its own wording again — three states, three
     * sentences, because collapsing any two of them is the bug. */
    const revertRequest = async (): Promise<unknown> =>
      encodeResults([uint(0n), uint(6n), reverted, uint(0n), abiString("X"), abiString("X")]);
    const [facetless] = await readHoldings(revertRequest as never, CHAIN, ACCOUNT, [A]);
    check(/facet reverted|reverted when asked/.test(mintRefusal(facetless as Holding) as string),
      "a reverting access-control facet is not described as one");
  }

  group("the transfer, and the descriptor without which it cannot be signed");
  {
    const call = encodeSecurityTransfer(A, RECIPIENT, 1_000n);
    check(call.to === A, "the transfer is not aimed at the security");
    check(call.data === `0x${selectorOf("transfer(address,uint256)")}${addressWord(RECIPIENT)}${word(1_000n)}`,
      "the transfer calldata is not transfer(to, amount)");
    check((call.data.length - 2) / 2 === 68, "a transfer is not 68 bytes");

    let threw = false;
    try { encodeSecurityTransfer(A, RECIPIENT, 0n); } catch { threw = true; }
    check(threw, "a transfer of nothing was encoded");

    /* The real gate, with this app's descriptors offered as evidence. */
    const screened = screenProposal(
      { kind: "call", to: call.to, data: call.data, reason: "test" },
      {
        chainId: CHAIN, from: ACCOUNT,
        descriptors: [...DEFAULT_DESCRIPTORS, ...securityTransferDescriptors(CHAIN, A)],
      },
    );
    check(screened.kind === "ok",
      `the transfer was refused by the gate: ${screened.kind === "refused" ? screened.why : ""}`);

    /* And without the descriptor it must refuse, which is what makes the
     * descriptor load-bearing rather than decorative. */
    const bare = screenProposal(
      { kind: "call", to: call.to, data: call.data, reason: "test" },
      { chainId: CHAIN, from: ACCOUNT, descriptors: [] },
    );
    check(bare.kind === "refused", "a transfer with no descriptor was allowed through");

    /* A descriptor for security A must not describe a call to security B: each
     * issuance is a fresh diamond and the match is address-scoped. */
    const wrongAddress = screenProposal(
      { kind: "call", to: B, data: call.data, reason: "test" },
      { chainId: CHAIN, from: ACCOUNT, descriptors: securityTransferDescriptors(CHAIN, A) },
    );
    check(wrongAddress.kind === "refused", "one security's descriptor described another's call");
  }

  group("asking for a transfer without a device, and being declined");
  {
    const base = { chainId: CHAIN, address: ACCOUNT, request: async () => undefined } as
      unknown as AppContext;
    const cannot = await runTransfer(base, A, RECIPIENT, 1n);
    check(cannot.kind === "cannot-ask", `no device gave ${cannot.kind}`);

    const badAmount = await runTransfer(base, A, RECIPIENT, 0n);
    check(badAmount.kind === "refused", "a zero transfer was asked about");

    const declining = {
      ...base, propose: async () => ({ ok: false as const, text: "declined" as never }),
    } as unknown as AppContext;
    check((await runTransfer(declining, A, RECIPIENT, 1n)).kind === "declined",
      "a declining wallet did not produce a decline");

    const signing = {
      ...base,
      propose: async () => ({ ok: true as const, kind: "call" as const, result: "0xfeed" }),
    } as unknown as AppContext;
    const sent = await runTransfer(signing, A, RECIPIENT, 1n);
    check(sent.kind === "sent" && sent.result === "0xfeed", "the transaction hash was lost");
  }

  console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
