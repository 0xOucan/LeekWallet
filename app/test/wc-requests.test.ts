/**
 * Dapp request planning tests (T32).
 *
 * This is the trust boundary, so the tests are mostly about refusals. Three
 * properties matter more than the rest:
 *
 * - **Nothing falls through.** Every method produces a plan or an error; a
 *   request that produced neither would leave a dapp waiting forever.
 * - **The device's own limits are enforced here first.** A call outside the
 *   decodable set, or a message the screen cannot render, is refused before
 *   anyone walks to the device (PROTOCOL.md 6bis).
 * - **A dapp cannot widen its own authority.** Not the address it signs with,
 *   not the chain, not the set of methods.
 */

import { planRequest, parseCaip2ChainId, SUPPORTED_METHODS } from "../src/wc/requests.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TOKEN = "0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48";
const ctx = { accounts: [A], chainId: 11155111 };

/** ERC-20 transfer(to, amount) — inside the decodable set. */
const transferData = (to: string, amount: bigint) =>
  "0xa9059cbb" + "0".repeat(24) + to.slice(2).toLowerCase() +
  amount.toString(16).padStart(64, "0");

const hexMessage = (text: string) =>
  "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * An ERC-2612 Permit for an infinite allowance, as a dapp sends one: JSON, with
 * the uint256 as a decimal string because it has no JavaScript number.
 *
 * This is the document behind most permit-drain incidents — no gas, no entry in
 * the victim's transaction history, and an allowance an attacker redeems later.
 * The same values are hashed against viem in packages/core/test/eip712.test.ts
 * and against the firmware in sim/test_eip712.c.
 */
const PERMIT_JSON = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Permit",
  domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: TOKEN },
  message: {
    owner: A,
    spender: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    value: (2n ** 256n - 1n).toString(),
    nonce: "0",
    deadline: "1893456000",
  },
};

group("read-only methods are answered from app state");
{
  const accounts = planRequest("eth_accounts", [], ctx);
  check(accounts.kind === "answer", "eth_accounts was not answered");
  if (accounts.kind === "answer") {
    // EIP-55 casing, the same rendering the device produces.
    check(JSON.stringify(accounts.result) === JSON.stringify([A]), "eth_accounts returned the wrong list");
  }

  const chain = planRequest("eth_chainId", [], ctx);
  check(chain.kind === "answer" && chain.result === "0xaa36a7", "eth_chainId is not hex-quantity encoded");
}

group("a native transfer becomes a signing plan with an advisory reading");
{
  const plan = planRequest("eth_sendTransaction", [{
    from: A, to: B, value: "0xde0b6b3a7640000",
  }], ctx);
  check(plan.kind === "transaction", "a plain transfer was not planned");
  if (plan.kind === "transaction") {
    check(plan.broadcast, "eth_sendTransaction should broadcast");
    check(plan.tx.value === 1000000000000000000n, "value is not exact bigint");
    check(plan.tx.chainId === 11155111, "chain did not default to the session's");
    // The summary is the app's own interpretation, not anything the dapp said.
    check(plan.interpretation.advisory === true, "the interpretation is not marked advisory");
    check(plan.interpretation.summary.includes("Sepolia"), "the summary does not name the chain");
  }

  const unsigned = planRequest("eth_signTransaction", [{ from: A, to: B, value: "0x1" }], ctx);
  check(unsigned.kind === "transaction" && !unsigned.broadcast, "eth_signTransaction should not broadcast");
}

group("an unlimited approval still carries its warning through the dapp path");
{
  const max = (1n << 256n) - 1n;
  const plan = planRequest("eth_sendTransaction", [{
    from: A, to: TOKEN,
    data: "0x095ea7b3" + "0".repeat(24) + B.slice(2).toLowerCase() + max.toString(16).padStart(64, "0"),
  }], ctx);
  check(plan.kind === "transaction", "an approval was refused");
  if (plan.kind === "transaction") {
    check(plan.interpretation.unlimited, "the approval was not read as unlimited");
    check(
      plan.interpretation.warnings[0]?.code === "unlimited-approval",
      "the unlimited-approval warning is not first",
    );
  }
}

group("a token transfer is planned with its calldata intact");
{
  const data = transferData(B, 1000000n);
  const plan = planRequest("eth_sendTransaction", [{ from: A, to: TOKEN, data }], ctx);
  check(plan.kind === "transaction", "an ERC-20 transfer was refused");
  if (plan.kind === "transaction") {
    check(plan.tx.data === data, "calldata was altered on the way through");
    check(plan.interpretation.tokenAmountRaw === 1000000n, "raw units lost");
  }
}

group("calls the device cannot decode are refused here, not at the device");
{
  // An unknown selector: exactly the 0x0202 case in eth-decode.
  const unknown = planRequest("eth_sendTransaction", [{
    from: A, to: TOKEN, data: "0xdeadbeef" + "0".repeat(128),
  }], ctx);
  check(unknown.kind === "error", "an undecodable call was planned for signing");
  if (unknown.kind === "error") {
    check(unknown.error.code === -32003, "the refusal is not a transaction-rejected error");
    check(/blind signing/i.test(unknown.error.message), "the refusal does not explain itself");
    // Never reported as a user rejection: nobody rejected anything.
    check(unknown.error.code !== 4001, "a capability refusal was reported as a user rejection");
  }

  const creation = planRequest("eth_sendTransaction", [{ from: A, data: "0x60606040" }], ctx);
  check(creation.kind === "error", "contract creation was planned for signing");
}

group("typed data: v4 is planned, the older spellings are refused by name");
{
  /* v4 is advertised because the device can now serve it: it recomputes the
   * digest from the structure and refuses what it could not display (T12b). A
   * dapp picks typed data over personal_sign on the strength of this list, and
   * until the device could sign one that choice led nowhere. */
  check(SUPPORTED_METHODS.includes("eth_signTypedData_v4"), "v4 is served but not advertised");
  check(!SUPPORTED_METHODS.includes("eth_signTypedData_v3"), "v3 is advertised but refused");

  const permit = planRequest("eth_signTypedData_v4", [A, JSON.stringify(PERMIT_JSON)], ctx);
  check(permit.kind === "typed-data", `a Permit was not planned: ${JSON.stringify(permit)}`);
  if (permit.kind === "typed-data") {
    check(/UNLIMITED value/.test(permit.summary),
          `the preview does not name the infinite allowance: ${permit.summary}`);
    check(/0xA0b86991/.test(permit.summary), "the preview does not name the contract");
    /* Transcribed once, here, and carried to the device untouched: the document
     * previewed and the one hashed have to be the same object, or the preview
     * is describing something else. */
    const message = permit.request["message"] as Record<string, unknown>;
    check(message["value"] instanceof Uint8Array, "the allowance was not transcribed to bytes");
  }

  /* Dapps do not reliably send [address, document] in that order. */
  const swapped = planRequest("eth_signTypedData_v4", [JSON.stringify(PERMIT_JSON), A], ctx);
  check(swapped.kind === "typed-data", "the arguments were only accepted one way round");

  const stranger = planRequest("eth_signTypedData_v4", [B, JSON.stringify(PERMIT_JSON)], ctx);
  check(stranger.kind === "error", "an unauthorised address was planned for signing");

  /* An array: the device cannot compute the digest at all, so this refusal is
   * permanent and is not the same refusal as the one below. */
  const arrayDoc = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Batch: [{ name: "amounts", type: "uint256[]" }],
    },
    primaryType: "Batch",
    domain: { name: "Batch" },
    message: { amounts: ["1", "2"] },
  };
  const array = planRequest("eth_signTypedData_v4", [A, JSON.stringify(arrayDoc)], ctx);
  check(array.kind === "error", "an array document was planned for signing");

  /* Hashable but unshowable: refused by default, planned once the DEVICE
   * reports blind signing on. The app must never overrule its owner — they
   * would opt in and see the identical refusal with no way to tell which layer
   * said no. */
  const wideDoc = {
    types: {
      EIP712Domain: [{ name: "name", type: "string" }],
      Wide: Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, type: "uint256" })),
    },
    primaryType: "Wide",
    domain: { name: "Wide" },
    message: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}`, String(i)])),
  };
  const wide = planRequest("eth_signTypedData_v4", [A, JSON.stringify(wideDoc)], ctx);
  check(wide.kind === "error", "an unshowable structure was planned without blind signing");
  const wideBlind = planRequest("eth_signTypedData_v4", [A, JSON.stringify(wideDoc)],
                                { ...ctx, blindSigning: true });
  check(wideBlind.kind === "typed-data", "blind signing did not reopen an unshowable structure");
  const arrayBlind = planRequest("eth_signTypedData_v4", [A, JSON.stringify(arrayDoc)],
                                 { ...ctx, blindSigning: true });
  check(arrayBlind.kind === "error",
        "blind signing reopened a document with no computable digest");

  const junk = planRequest("eth_signTypedData_v4", [A, "not json"], ctx);
  check(junk.kind === "error", "unparseable typed data was planned for signing");

  for (const method of ["eth_signTypedData", "eth_signTypedData_v3"]) {
    const plan = planRequest(method, [A, "{}"], ctx);
    check(plan.kind === "error", `${method} was not refused`);
    if (plan.kind === "error") {
      // 4200 is EIP-1193 "unsupported method" — what a dapp branches on to
      // fall back to something this wallet does serve.
      check(plan.error.code === 4200, `${method}: wrong code ${plan.error.code}`);
      check(/eth_signTypedData_v4/.test(plan.error.message),
            `${method}: no fallback suggested`);
    }
  }
}

group("methods the firmware cannot serve are refused by name");
{
  const eth_sign = planRequest("eth_sign", [A, "0x" + "11".repeat(32)], ctx);
  check(eth_sign.kind === "error" && eth_sign.error.code === 4200, "eth_sign was not refused");

  const nonsense = planRequest("eth_somethingInvented", [], ctx);
  check(nonsense.kind === "error" && nonsense.error.code === 4200, "an unknown method was not refused");
}

group("personal_sign is limited to what the device screen can render");
{
  const ok = planRequest("personal_sign", [hexMessage("Sign in to Example"), A], ctx);
  check(ok.kind === "message", "a plain ASCII message was refused");
  if (ok.kind === "message") {
    check(ok.message === "Sign in to Example", "the message was not decoded from hex");
    check(ok.address === A, "the address was not checksummed back");
  }

  // Argument order is reversed by a long tail of dapps; both must work.
  const swapped = planRequest("personal_sign", [A, hexMessage("hello")], ctx);
  check(swapped.kind === "message" && swapped.message === "hello", "reversed arguments were not handled");

  const long = planRequest("personal_sign", [hexMessage("x".repeat(121)), A], ctx);
  check(long.kind === "error" && long.error.code === -32003, "an over-long message was accepted");

  const emoji = planRequest("personal_sign", [hexMessage("gm ☕"), A], ctx);
  check(emoji.kind === "error", "a non-ASCII message was accepted");
  if (emoji.kind === "error") check(/ASCII/.test(emoji.error.message), "the refusal does not say why");

  const newline = planRequest("personal_sign", [hexMessage("two\nlines"), A], ctx);
  check(newline.kind === "error", "a message with a newline was accepted");
}

group("a dapp cannot sign with an address this wallet did not offer");
{
  const other = planRequest("personal_sign", [hexMessage("hi"), B], ctx);
  check(other.kind === "error" && other.error.code === 4100, "an unauthorised address was accepted");

  const tx = planRequest("eth_sendTransaction", [{ from: B, to: A, value: "0x1" }], ctx);
  check(tx.kind === "error" && tx.error.code === 4100, "an unauthorised `from` was accepted");

  // Locked device: no accounts, so nothing is authorised.
  const locked = planRequest("eth_sendTransaction", [{ from: A, to: B, value: "0x1" }],
    { accounts: [], chainId: 1 });
  check(locked.kind === "error" && locked.error.code === 4100, "a locked wallet still planned a signature");
}

group("a chain this wallet cannot name is refused, never defaulted");
{
  const tx = planRequest("eth_sendTransaction", [{ from: A, to: B, value: "0x1", chainId: "0x1a4" }], ctx);
  check(tx.kind === "error" && tx.error.code === 4902, "an unknown chain was signed for anyway");

  const switched = planRequest("wallet_switchEthereumChain", [{ chainId: "0x1a4" }], ctx);
  check(switched.kind === "error" && switched.error.code === 4902, "switching to an unknown chain was allowed");

  const known = planRequest("wallet_switchEthereumChain", [{ chainId: "0x1" }], ctx);
  check(known.kind === "switch-chain" && known.chainId === 1, "switching to a known chain failed");

  // The dapp does not get to describe a network to this wallet.
  const added = planRequest("wallet_addEthereumChain", [{ chainId: "0x1a4", rpcUrls: ["https://evil"] }], ctx);
  check(added.kind === "error" && added.error.code === 4200, "wallet_addEthereumChain was not refused");
}

group("malformed parameters are an error, not a crash");
{
  for (const params of [undefined, [], [null], ["nonsense"], [{}], [{ from: A, to: "0xzz" }]]) {
    const plan = planRequest("eth_sendTransaction", params, ctx);
    check(plan.kind === "error", `params ${JSON.stringify(params)} did not error`);
  }
  const badValue = planRequest("eth_sendTransaction", [{ from: A, to: B, value: "banana" }], ctx);
  check(badValue.kind === "error" && badValue.error.code === -32602, "a junk value was not an invalid-params error");
}

group("CAIP-2 chain ids are parsed, and only EVM ones");
{
  check(parseCaip2ChainId("eip155:8453") === 8453, "a valid CAIP-2 id failed");
  check(parseCaip2ChainId("solana:mainnet") === undefined, "a non-EVM namespace was accepted");
  check(parseCaip2ChainId("eip155:") === undefined, "an empty reference was accepted");
  check(parseCaip2ChainId("1") === undefined, "a bare number was accepted");
}

group("every refusal carries a message a person could act on");
{
  const plans = [
    planRequest("eth_signTypedData_v4", [A, "{}"], ctx),
    planRequest("eth_sign", [A, "0x00"], ctx),
    planRequest("wallet_addEthereumChain", [{}], ctx),
    planRequest("eth_sendTransaction", [{ from: A, to: TOKEN, data: "0xdeadbeef" }], ctx),
  ];
  for (const plan of plans) {
    check(plan.kind === "error", "expected a refusal");
    if (plan.kind === "error") {
      check(plan.error.message.length > 30, `terse refusal: ${plan.error.message}`);
      check(!/undefined|null/.test(plan.error.message), `refusal leaks a placeholder: ${plan.error.message}`);
    }
  }
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
