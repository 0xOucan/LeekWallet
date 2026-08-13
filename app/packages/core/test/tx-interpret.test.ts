/**
 * Host-side interpretation tests (T48).
 *
 * Two things are being pinned down. First, arithmetic: wei is bigint and any
 * float in the ether formatting or the fee ceiling silently changes an amount,
 * which is the kind of bug nobody notices until it is on-chain. Second, the
 * warnings — an unlimited approval that fails to be flagged is the exact
 * failure this module exists to prevent.
 *
 * Nothing here asserts that a transaction is safe, because the module is not
 * entitled to say so.
 */

import { CallKind } from "../src/eth-decode.ts";
import {
  ADVISORY_NOTICE, checksumAddress, formatEther, interpretTransaction,
  WarningCode, WarningSeverity,
} from "../src/tx-interpret.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const SEL_TRANSFER = "a9059cbb";
const SEL_APPROVE = "095ea7b3";
const ADDR = "d8da6bf26964af9d7eed9e03e53415d37aa96045";
const TOKEN = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ZERO = "0".repeat(40);

const call = (selector: string, addr: string, amount: bigint | string) => {
  const word = typeof amount === "string" ? amount : amount.toString(16).padStart(64, "0");
  return "0x" + selector + "0".repeat(24) + addr + word;
};

const codes = (tx: Parameters<typeof interpretTransaction>[0]) =>
  interpretTransaction(tx).warnings.map((w) => w.code);

group("wei formats exactly, without floating point");
check(formatEther(0n) === "0", `zero: ${formatEther(0n)}`);
check(formatEther(10n ** 18n) === "1", `one ether: ${formatEther(10n ** 18n)}`);
check(formatEther(1n) === "0.000000000000000001", `one wei: ${formatEther(1n)}`);
check(formatEther(1500000000000000000n) === "1.5", `1.5: ${formatEther(1500000000000000000n)}`);
// 2^53 + 1 wei: the first place a double stops counting. If this ever reads
// with a trailing 0 instead of 1, something turned the value into a Number.
check(
  formatEther(9007199254740993n) === "0.009007199254740993",
  `precision boundary: ${formatEther(9007199254740993n)}`,
);
check(
  formatEther(123456789012345678901234567890n) === "123456789012.34567890123456789",
  `large: ${formatEther(123456789012345678901234567890n)}`,
);

group("native transfer");
{
  const i = interpretTransaction({
    chainId: 1, to: "0x" + ADDR, value: 10n ** 17n,
    gas: 21000n, maxFeePerGas: 30000000000n,
  });
  check(i.advisory === true, "not marked advisory");
  check(i.kind === CallKind.Empty, "not a native transfer");
  check(i.recipient === checksumAddress(ADDR), `recipient ${i.recipient}`);
  check(i.valueWei === 10n ** 17n, "value lost");
  check(i.valueEther === "0.1", `ether ${i.valueEther}`);
  check(i.chainName === "Ethereum", `chain name ${i.chainName}`);
  check(i.maxFeeWei === 630000000000000n, `fee ${i.maxFeeWei}`);
  check(i.maxFeeEther === "0.00063", `fee in ether ${i.maxFeeEther}`);
  check(i.deviceWillRefuse === false, "plain transfer said to be refused");
  check(i.warnings.length === 0, `unexpected warnings: ${codes({ chainId: 1, to: "0x" + ADDR })}`);
  check(i.tokenAmountRaw === undefined, "native transfer carries a token amount");
}

group("addresses render exactly as the device renders them");
/* EIP-55, matching eth_format_address() in src/eth-tx.c. The user is asked to
 * compare this against the device screen; a lowercase address here would make
 * two identical addresses look different and teach them to ignore case.
 *
 * The vector is deliberately the same one sim/test_eth_tx.c:202 pins for the
 * firmware, so the two implementations are held to one string rather than
 * agreeing by coincidence. */
{
  const canonical = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  for (const input of [canonical, canonical.toLowerCase(), "0x" + canonical.slice(2).toUpperCase()]) {
    check(
      interpretTransaction({ chainId: 1, to: input }).recipient === canonical,
      `${input} rendered as ${interpretTransaction({ chainId: 1, to: input }).recipient}`,
    );
  }
  /* Bytes from the wire must land in the same casing as a string would. */
  const bytes = Uint8Array.from(
    (canonical.slice(2).match(/../g) as string[]).map((b) => Number.parseInt(b, 16)),
  );
  check(
    interpretTransaction({ chainId: 1, to: bytes }).recipient === canonical,
    "a 20-byte address did not render checksummed",
  );
}
check(
  interpretTransaction({ chainId: 1, to: "0x1234" }).recipient === undefined,
  "a short string was accepted as an address",
);

group("fee is a ceiling, and absent when unknowable");
check(
  interpretTransaction({ chainId: 1, to: "0x" + ADDR, gas: 21000n }).maxFeeWei === undefined,
  "fee invented without a price",
);
check(
  interpretTransaction({ chainId: 1, to: "0x" + ADDR, maxFeePerGas: 1n }).maxFeeWei === undefined,
  "fee invented without a gas limit",
);
// Pre-1559 requests still have a ceiling; gasPrice is the fallback, not a peer.
check(
  interpretTransaction({ chainId: 1, to: "0x" + ADDR, gas: 21000n, gasPrice: 2n }).maxFeeWei
    === 42000n,
  "gasPrice ignored",
);
check(
  interpretTransaction({
    chainId: 1, to: "0x" + ADDR, gas: 21000n, gasPrice: 2n, maxFeePerGas: 3n,
  }).maxFeeWei === 63000n,
  "maxFeePerGas did not win over gasPrice",
);

group("erc-20 transfer: raw units, contract kept separate from recipient");
{
  const i = interpretTransaction({
    chainId: 8453, to: "0x" + TOKEN, data: call(SEL_TRANSFER, ADDR, 1000000n),
  });
  check(i.kind === CallKind.Erc20Transfer, "not a token transfer");
  check(i.recipient === checksumAddress(ADDR), `recipient ${i.recipient}`);
  check(i.contract === checksumAddress(TOKEN), `contract ${i.contract}`);
  check(i.tokenAmountRaw === 1000000n, `amount ${i.tokenAmountRaw}`);
  check(i.summary.includes("raw token units"), `summary hides the scale: ${i.summary}`);
  check(i.chainName === "Base", `chain ${i.chainName}`);
  check(i.warnings.length === 0, `unexpected warnings: ${i.warnings.map((w) => w.code)}`);
}

group("unlimited approval is the first and loudest warning");
for (const word of ["f".repeat(64), "8" + "0".repeat(63)]) {
  const i = interpretTransaction({
    chainId: 1, to: "0x" + TOKEN, data: call(SEL_APPROVE, ADDR, word),
  });
  check(i.unlimited === true, "not flagged unlimited");
  check(i.warnings[0]?.code === WarningCode.UnlimitedApproval, "not the first warning");
  check(i.warnings[0]?.severity === WarningSeverity.High, "unlimited approval not high severity");
  check(i.warnings[0]?.message.includes(checksumAddress(ADDR)) === true,
      "warning does not name the spender");
  check(i.summary.includes("UNLIMITED"), `summary is calm about it: ${i.summary}`);
}
check(
  !codes({ chainId: 1, to: "0x" + TOKEN, data: call(SEL_APPROVE, ADDR, 1n) })
    .includes(WarningCode.UnlimitedApproval),
  "a 1-unit approval warned as unlimited",
);

group("calls the device will refuse are announced before the walk to the device");
{
  const i = interpretTransaction({
    chainId: 1, to: "0x" + TOKEN, data: call("23b872dd", ADDR, 1n),
  });
  check(i.deviceWillRefuse === true, "transferFrom not marked as refused");
  check(i.warnings.some((w) => w.code === WarningCode.DeviceWillRefuse), "no refusal warning");
  check(i.kind === CallKind.Unknown, "unknown selector decoded anyway");
}
{
  const i = interpretTransaction({ chainId: 1, data: "0x60806040" });
  check(i.deviceWillRefuse === true, "contract creation not marked as refused");
  const w = i.warnings.find((x) => x.code === WarningCode.DeviceWillRefuse);
  check(w?.message.includes("Contract creation") === true, `message: ${w?.message}`);
}

group("zero address");
check(
  codes({ chainId: 1, to: "0x" + ZERO, value: 1n }).includes(WarningCode.ZeroAddress),
  "native burn not flagged",
);
check(
  codes({ chainId: 1, to: "0x" + TOKEN, data: call(SEL_TRANSFER, ZERO, 5n) })
    .includes(WarningCode.ZeroAddress),
  "token burn not flagged",
);
check(
  !codes({ chainId: 1, to: "0x" + ADDR, value: 1n }).includes(WarningCode.ZeroAddress),
  "an ordinary address flagged as zero",
);

group("chains the app cannot name are said to be unnamed, never guessed");
{
  const i = interpretTransaction({ chainId: 424242, to: "0x" + ADDR });
  check(i.chainName === undefined, `invented a name: ${i.chainName}`);
  check(i.summary.includes("chain 424242"), `summary hides the chain: ${i.summary}`);
  const w = i.warnings.find((x) => x.code === WarningCode.UnknownChain);
  check(w !== undefined, "unknown chain not warned about");
  check(w?.severity === WarningSeverity.Info, "unknown chain treated as a fund-loss risk");
}
check(
  !codes({ chainId: 11155111, to: "0x" + ADDR }).includes(WarningCode.UnknownChain),
  "Sepolia reported as unknown",
);
// A missing chainId is not chain 0 in any meaningful sense, but it is also not
// something to paper over: it must warn rather than default to Ethereum.
check(
  codes({ to: "0x" + ADDR }).includes(WarningCode.UnknownChain),
  "an absent chainId silently assumed a chain",
);

group("several warnings coexist, unlimited approval still first");
{
  const i = interpretTransaction({
    chainId: 999999, to: "0x" + TOKEN, data: call(SEL_APPROVE, ZERO, "f".repeat(64)),
  });
  const c = i.warnings.map((w) => w.code);
  check(c[0] === WarningCode.UnlimitedApproval, `order: ${c.join(",")}`);
  check(c.includes(WarningCode.ZeroAddress), "zero spender not flagged");
  check(c.includes(WarningCode.UnknownChain), "unknown chain not flagged");
  check(!c.includes(WarningCode.DeviceWillRefuse), "a decodable approval marked as refused");
}

group("the module never claims authority");
{
  const blob = JSON.stringify(
    interpretTransaction({ chainId: 1, to: "0x" + ADDR, value: 1n }),
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  ).toLowerCase();
  for (const word of ["verified", "safe", "trusted", "secure"]) {
    check(!blob.includes(word), `interpretation contains the word "${word}"`);
  }
  check(ADVISORY_NOTICE.includes("device"), "the advisory notice does not mention the device");
  check(ADVISORY_NOTICE.includes("not trusted"), "the advisory notice does not disclaim trust");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
