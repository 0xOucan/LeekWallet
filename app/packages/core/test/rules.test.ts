/**
 * Rule engine tests.
 *
 * The property the whole file is really defending: nothing in rules.ts ever
 * produces a positive result, and every rule is a pure function of its
 * arguments. So there is not one mock, one fake clock or one stubbed fetch
 * below the async section — if a test here needed mocking, the rule it tests
 * would have grown a dependency it is not allowed to have.
 *
 * In order:
 *
 * 1. Each rule fires on the thing it is for, and — the half that matters more —
 *    stays quiet on the near miss. A rule that fires on ordinary traffic gets
 *    dismissed, and a dismissed rule protects nobody.
 * 2. The domain chainId check specifically, because it is the one finding the
 *    device cannot produce for itself.
 * 3. Address poisoning fires on the lookalike and never on the real address.
 * 4. The async enrichment stays silent when the node does not answer: a failed
 *    eth_getCode is not evidence of an EOA.
 */

import type { TypedRender, TypedField } from "../src/eip712.ts";
import {
  enrichRecipientIsContract, evaluateRules, FAR_FUTURE_SECONDS, FindingCode,
  PERMIT2_ADDRESS, RULES_NOTICE, ruleAddressPoisoning, ruleDeadline, ruleDomainChainId,
  rulePermit2Spender, ruleTokenToTokenContract, ruleUnlimitedApproval, Severity,
  type EthRequest, type Finding, type RuleContext,
} from "../src/rules.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const has = (findings: readonly Finding[], code: string): boolean =>
  findings.some((f) => f.code === code);

const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";
const SPENDER = "0x1111111111111111111111111111111111111111";

const w = (n: bigint) => n.toString(16).padStart(64, "0");
const aw = (a: string) => "0".repeat(24) + a.slice(2).toLowerCase();
const MAX = (1n << 256n) - 1n;

const approve = (spender: string, amount: bigint) => `0x095ea7b3${aw(spender)}${w(amount)}`;
const transfer = (to: string, amount: bigint) => `0xa9059cbb${aw(to)}${w(amount)}`;

const field = (over: Partial<TypedField> & { label: string }): TypedField => ({
  value: "", isAddress: false, unlimited: false, isDeadline: false, ...over,
});
const render = (over: Partial<TypedRender>): TypedRender =>
  ({ primaryType: "Permit", fields: [], ...over });

/* ------------------------------------------------------------------------ */

group("unlimited approvals, on both paths");
{
  const tx: RuleContext = { chainId: 1, tx: { to: USDC, data: approve(SPENDER, MAX) } };
  const found = ruleUnlimitedApproval(tx);
  check(found.length === 1, "an unlimited approve produced no finding");
  check(found[0]?.severity === Severity.High, "an unlimited approval is not high severity");
  check(found[0]?.subject?.toLowerCase() === SPENDER.toLowerCase(),
    "the unlimited approval did not name the spender");

  // A large but specific number is not unlimited: eth-decode.ts draws that
  // line and this rule must not draw a different one.
  const modest = ruleUnlimitedApproval({ chainId: 1, tx: { to: USDC, data: approve(SPENDER, 1000n) } });
  check(modest.length === 0, "a finite approval was called unlimited");

  // A transfer of a huge amount is a specific number, not an allowance.
  const send = ruleUnlimitedApproval({ chainId: 1, tx: { to: USDC, data: transfer(SPENDER, MAX) } });
  check(send.length === 0, "a transfer was reported as an unlimited approval");

  const typed = ruleUnlimitedApproval({
    chainId: 1,
    typed: render({ fields: [field({ label: "details.amount", unlimited: true, value: "1461501637330902918203684832716283019655932542975" })] }),
  });
  check(typed.length === 1 && typed[0]?.code === FindingCode.UnlimitedApproval,
    "an unlimited Permit amount produced no finding");
}

group("the domain chainId cross-check — the one the device cannot make");
{
  const mismatch = ruleDomainChainId({ chainId: 1, typed: render({ chainId: 137n }) });
  check(mismatch.length === 1, "a chainId mismatch was not caught");
  check(mismatch[0]?.severity === Severity.High, "a chainId mismatch is not high severity");
  check(/chain 137/.test(mismatch[0]?.message ?? "") && /chain 1\b/.test(mismatch[0]?.message ?? ""),
    "the mismatch message does not name both chains");

  check(ruleDomainChainId({ chainId: 1, typed: render({ chainId: 1n }) }).length === 0,
    "a matching chainId produced a finding");
  // No chainId is a weaker signature, not a mismatch. Flagging it would train
  // the user to dismiss the real one.
  check(ruleDomainChainId({ chainId: 1, typed: render({}) }).length === 0,
    "an absent domain chainId was reported as a mismatch");
  check(ruleDomainChainId({ chainId: 1 }).length === 0, "a transaction produced a domain finding");
}

group("deadlines: far future, zero, and absent");
{
  const now = 1_700_000_000;
  const far = ruleDeadline({
    chainId: 1, nowSeconds: now,
    typed: render({ fields: [field({ label: "sigDeadline", isDeadline: true, value: String(now + FAR_FUTURE_SECONDS * 60) })] }),
  });
  check(far.length === 1 && far[0]?.code === FindingCode.FarFutureDeadline,
    "a fifty-year deadline produced no finding");

  const soon = ruleDeadline({
    chainId: 1, nowSeconds: now,
    typed: render({ fields: [field({ label: "sigDeadline", isDeadline: true, value: String(now + 600) })] }),
  });
  check(soon.length === 0, "a ten-minute swap deadline was flagged");

  const zero = ruleDeadline({
    chainId: 1, nowSeconds: now,
    typed: render({ fields: [field({ label: "expiration", isDeadline: true, value: "0" })] }),
  });
  check(zero.length === 1 && zero[0]?.code === FindingCode.MissingDeadline,
    "a zero expiry was not reported as no limit");

  const absent = ruleDeadline({ chainId: 1, nowSeconds: now, typed: render({ primaryType: "PermitSingle" }) });
  check(absent.length === 1 && absent[0]?.code === FindingCode.MissingDeadline,
    "a permit with no deadline field produced no finding");

  // Not permit-shaped: most typed data has no deadline and nothing is wrong.
  check(ruleDeadline({ chainId: 1, nowSeconds: now, typed: render({ primaryType: "Order" }) }).length === 0,
    "an ordinary document was flagged for having no deadline");

  // No clock, no guess.
  check(ruleDeadline({
    chainId: 1,
    typed: render({ fields: [field({ label: "sigDeadline", isDeadline: true, value: "99999999999" })] }),
  }).length === 0, "a deadline was judged with no clock supplied");
}

group("Permit2: the spender is the field that matters");
{
  const found = rulePermit2Spender({
    chainId: 1,
    typed: render({
      primaryType: "PermitSingle",
      verifyingContract: PERMIT2_ADDRESS,
      fields: [
        field({ label: "details.token", isAddress: true, value: USDC }),
        field({ label: "spender", isAddress: true, value: SPENDER }),
      ],
    }),
  });
  check(found.length === 1, "a Permit2 document produced no spender finding");
  // subject, not prose: the UI gives this the prominence a recipient gets.
  check(found[0]?.subject?.toLowerCase() === SPENDER.toLowerCase(),
    "the Permit2 spender was not surfaced as the subject");
  check(found[0]?.severity === Severity.Info,
    "an ordinary Permit2 signature was raised as an alarm");

  const elsewhere = rulePermit2Spender({
    chainId: 1, typed: render({ verifyingContract: USDC, fields: [field({ label: "spender", isAddress: true, value: SPENDER })] }),
  });
  check(elsewhere.length === 0, "a non-Permit2 document produced a Permit2 finding");
}

group("tokens sent to a token contract");
{
  const own = ruleTokenToTokenContract({ chainId: 1, tx: { to: USDC, data: transfer(USDC, 1n) } });
  check(own.length === 1 && own[0]?.severity === Severity.High,
    "sending a token to its own contract produced no finding");

  const other = ruleTokenToTokenContract({
    chainId: 1, tx: { to: USDC, data: transfer("0x6B175474E89094C44Da98b954EedeAC495271d0F", 1n) },
    knownTokens: ["0x6b175474e89094c44da98b954eedeac495271d0f"],
  });
  check(other.length === 1, "sending a token to another listed token produced no finding");

  const normal = ruleTokenToTokenContract({ chainId: 1, tx: { to: USDC, data: transfer(ALICE, 1n) }, knownTokens: [USDC] });
  check(normal.length === 0, "an ordinary token transfer was flagged");
  // A native send is not a token transfer, whatever the recipient is.
  check(ruleTokenToTokenContract({ chainId: 1, tx: { to: USDC } }).length === 0,
    "a native send to a token contract was reported as a token transfer");
}

group("address poisoning: the lookalike, never the real one");
{
  const real = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  // Same first four and last four hex characters, different in between.
  const lookalike = "0xd8da000000000000000000000000000000006045";

  const poisoned = ruleAddressPoisoning({ chainId: 1, tx: { to: lookalike }, knownAddresses: [real] });
  check(poisoned.length === 1 && poisoned[0]?.code === FindingCode.AddressPoisoning,
    "a mined lookalike address was not caught");
  check(poisoned[0]?.subject?.toLowerCase() === lookalike.toLowerCase(),
    "the poisoning finding did not name the address being paid");

  const exact = ruleAddressPoisoning({ chainId: 1, tx: { to: real }, knownAddresses: [real] });
  check(exact.length === 0, "paying an address you have used before was flagged as poisoning");

  const unrelated = ruleAddressPoisoning({ chainId: 1, tx: { to: SPENDER }, knownAddresses: [real] });
  check(unrelated.length === 0, "an unrelated address was reported as a lookalike");

  // It reads the token recipient, not the token contract — the poisoned
  // address is the one being paid.
  const inCalldata = ruleAddressPoisoning({
    chainId: 1, tx: { to: USDC, data: transfer(lookalike, 1n) }, knownAddresses: [real],
  });
  check(inCalldata.length === 1, "a lookalike inside ERC-20 calldata was missed");

  check(ruleAddressPoisoning({ chainId: 1, tx: { to: real } }).length === 0,
    "poisoning fired with no history to compare against");
}

group("evaluateRules composes, and says nothing positive");
{
  const clean = evaluateRules({ chainId: 1, tx: { to: ALICE, value: 1n } });
  check(clean.length === 0, "an ordinary send produced findings");
  // The load-bearing assertion of this whole file: an empty list is the only
  // thing "no findings" ever produces. There is no ok/safe/verified value.
  check(Array.isArray(clean), "evaluateRules returned something other than a list");

  const bad = evaluateRules({
    chainId: 1,
    tx: { to: USDC, data: approve(SPENDER, MAX) },
    typed: render({ chainId: 137n, verifyingContract: PERMIT2_ADDRESS, fields: [field({ label: "spender", isAddress: true, value: SPENDER })] }),
    nowSeconds: 1_700_000_000,
  });
  check(has(bad, FindingCode.UnlimitedApproval), "the composed run lost the unlimited approval");
  check(has(bad, FindingCode.DomainChainMismatch), "the composed run lost the chain mismatch");
  check(has(bad, FindingCode.Permit2Spender), "the composed run lost the Permit2 spender");
  // Ordered by cost of missing it: the unlimited approval is read first.
  check(bad[0]?.code === FindingCode.UnlimitedApproval, "the findings are not in severity order");

  check(/not a statement that the transaction is safe/.test(RULES_NOTICE),
    "the notice no longer says that an empty list is not a safety claim");
}

group("the async enrichment: a fact, or silence");
{
  const withCode: EthRequest = async () => "0x6080604052";
  const noCode: EthRequest = async () => "0x";
  const dead: EthRequest = async () => { throw new Error("no endpoint answered"); };
  const junk: EthRequest = async () => ({ nonsense: true });

  const ctx: RuleContext = { chainId: 1, tx: { to: ALICE } };

  const run = async () => {
    check((await enrichRecipientIsContract(withCode, ctx)).length === 1,
      "a contract recipient produced no finding");
    check((await enrichRecipientIsContract(noCode, ctx)).length === 0,
      "an EOA recipient produced a finding");
    // A failed lookup is not evidence of an EOA, and must not become one.
    check((await enrichRecipientIsContract(dead, ctx)).length === 0,
      "a failed eth_getCode produced a finding");
    check((await enrichRecipientIsContract(junk, ctx)).length === 0,
      "a malformed eth_getCode reply was read as code");

    // Calldata means a contract by definition; saying so on every token
    // transfer would be noise.
    check((await enrichRecipientIsContract(withCode, {
      chainId: 1, tx: { to: USDC, data: transfer(ALICE, 1n) },
    })).length === 0, "a contract call was flagged for being addressed to a contract");

    let asked = 0;
    const counting: EthRequest = async () => { asked++; return "0x"; };
    await enrichRecipientIsContract(counting, { chainId: 1, tx: { to: "0xdead" } });
    check(asked === 0, "a malformed recipient was disclosed to an operator");
  };
  await run();
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
