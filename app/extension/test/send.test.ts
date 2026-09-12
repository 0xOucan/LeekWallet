/**
 * The send planner: what it builds, and what it refuses.
 *
 * Every refusal here is a mistake that costs money if it is guessed at. The
 * tests are written as the loss they prevent, not as the branch they cover.
 */

import { planSend } from "../src/send.ts";
import { CallKind, decodeCall } from "../../packages/core/src/eth-decode.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const group = (name: string): void => console.log(`\n== ${name}`);
const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16)));

const ALICE = "0xA17c4e2f9B0d3856c1e74Af20B93D6851Fc0A2e7";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

group("a native payment names the recipient directly");
{
  const r = planSend({ recipient: ALICE, amount: "1.5" });
  check(r.ok, `refused a good native send: ${r.ok ? "" : r.reason}`);
  if (r.ok) {
    check(r.plan.to.toLowerCase() === ALICE.toLowerCase(), "to is not the recipient");
    check(r.plan.value === 1_500_000_000_000_000_000n, `wrong wei: ${r.plan.value}`);
    check(r.plan.data === undefined, "a plain transfer must carry no calldata");
  }
}

group("an ERC-20 payment sends to the TOKEN, with the recipient inside");
{
  /* THE PROPERTY, and the confusion that loses the most money: `to` is the
     token contract, the recipient is an argument, and `value` must be zero.
     Getting it backwards sends native currency to a token contract. */
  const r = planSend({
    recipient: ALICE, amount: "2.50",
    token: { address: USDC, decimals: 6 },
  });
  check(r.ok, `refused a good token send: ${r.ok ? "" : r.reason}`);
  if (r.ok) {
    check(r.plan.to.toLowerCase() === USDC, "to must be the token contract");
    check(r.plan.value === 0n, "an ERC-20 transfer must send no native value");
    check(r.plan.recipient.toLowerCase() === ALICE.toLowerCase(), "recipient was lost");
    check(r.plan.units === 2_500_000n, `wrong units: ${r.plan.units}`);
  }
}

group("the device can read what this builds");
{
  /* Not a second opinion from a second encoder: `decodeCall` mirrors
     `eth-decode.c` and is held to it by the shared conformance vectors. If the
     device cannot decode this, it refuses it, and the send is dead on arrival. */
  const r = planSend({
    recipient: ALICE, amount: "7", token: { address: USDC, decimals: 6 },
  });
  check(r.ok, "planning failed");
  if (r.ok && r.plan.data) {
    const call = decodeCall(bytesOf(r.plan.data));
    check(call.kind === CallKind.Erc20Transfer,
      `the device would not recognise this call: ${String(call.kind)}`);
    /* `address` is what the decoder calls the counterparty of a transfer. */
    check(call.address?.toLowerCase() === ALICE.toLowerCase(),
      `the device would draw ${String(call.address)}, not the recipient the form used`);
    check(call.amount === 7_000_000n,
      `the device would draw ${String(call.amount)}, not 7000000`);
  }
}

group("what it refuses");
{
  const bad = (label: string, r: ReturnType<typeof planSend>, match: RegExp): void => {
    check(!r.ok, `${label} was accepted`);
    if (!r.ok) check(match.test(r.reason), `${label}: unhelpful reason "${r.reason}"`);
  };

  bad("a truncated address", planSend({ recipient: "0xA17c4e2f", amount: "1" }), /address/i);
  bad("an address with a typo'd length",
    planSend({ recipient: `${ALICE}00`, amount: "1" }), /address/i);
  bad("the zero address",
    planSend({ recipient: `0x${"0".repeat(40)}`, amount: "1" }), /zero address|gone/i);
  bad("a zero amount", planSend({ recipient: ALICE, amount: "0" }), /greater than zero/i);
  bad("an empty amount", planSend({ recipient: ALICE, amount: "" }), /decimal|amount/i);
  bad("a non-numeric amount", planSend({ recipient: ALICE, amount: "1,5" }), /decimal|amount/i);

  /* THE ONE THAT MATTERS MOST: more decimals than the token has. Truncating
     0.0000001 USDC to 0 sends nothing and reports success. core's parseUnits
     refuses instead, and this asserts the refusal survives the wrapper. */
  bad("more decimals than the token carries",
    planSend({ recipient: ALICE, amount: "1.0000001", token: { address: USDC, decimals: 6 } }),
    /decimal places|claims only/i);

  bad("a token address that is not an address",
    planSend({ recipient: ALICE, amount: "1", token: { address: "0xnope", decimals: 6 } }),
    /token contract/i);
}

group("a token with no decimals at all still works");
{
  /* decimals() = 0 is legal and rare, which is exactly when an assumption of
     18 silently multiplies a payment by 10^18. */
  const r = planSend({
    recipient: ALICE, amount: "5", token: { address: USDC, decimals: 0 },
  });
  check(r.ok, `refused a 0-decimal token: ${r.ok ? "" : r.reason}`);
  if (r.ok) check(r.plan.units === 5n, `wrong units for 0 decimals: ${r.plan.units}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
