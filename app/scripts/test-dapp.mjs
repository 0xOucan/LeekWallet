#!/usr/bin/env node
/**
 * A dapp, for testing this wallet against.
 *
 *   node app/scripts/test-dapp.mjs permit2      # the 588-byte case
 *   node app/scripts/test-dapp.mjs permit       # EIP-2612, five leaves
 *   node app/scripts/test-dapp.mjs unlimited    # a drainer-shaped permit
 *   node app/scripts/test-dapp.mjs personal     # personal_sign
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 *
 * The signing paths that matter most are the ones only a real dapp exercises,
 * and real dapps are a poor test rig: Uniswap hides testnets behind a settings
 * toggle, Aave never offers a custom approval amount, and none of them can be
 * asked to send the one payload you want to see. Testing against them means
 * waiting for someone else's frontend to be in the mood.
 *
 * This is the dapp half of WalletConnect and nothing else. It prints a pairing
 * code, waits for the wallet, sends exactly the request named on the command
 * line, and then does the thing a real dapp does last and this project could
 * never check by hand: it **verifies the signature came back from the address
 * the wallet claims to be**. A device that renders a Permit beautifully and
 * signs a different digest passes every test in this repo and fails here.
 *
 * Deliberately not in check.sh: it needs a human, a device and a radio.
 */

import { SignClient } from "@walletconnect/sign-client";
import qrcode from "qrcode-generator";
import { verifyTypedData, hashTypedData, recoverAddress } from "viem";

/* This project's own relay identifier, the same one the companion bundles.
 * A test rig that needs its own account before it will run is a test rig
 * nobody runs. */
const PROJECT_ID = "770c5799f9be7c042c87985be4b4a2f9";

/* Base Sepolia: where this project's on-chain testing already happens, so the
 * addresses below are ones a tester may already recognise. */
const CHAIN_ID = 84532;
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SPENDER = "0x2626664c2603336E57B271c5C0b26F421741e481";

const MAX_UINT160 = (1n << 160n) - 1n;
const HOUR = 3600;

/** Payloads chosen for what each one proves, not for variety. */
function payload(kind, owner, now) {
  switch (kind) {
    /* The case that could not cross BLE until the frame limits were made one
     * number: 588 bytes on the wire, six leaves, exactly at the device's
     * display limit. */
    case "permit2":
      return {
        method: "eth_signTypedData_v4",
        typed: {
          domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
          types: {
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
              token: USDC,
              amount: 1_000_000n,          // 1 USDC, deliberately NOT unlimited
              expiration: now + 24 * HOUR,
              nonce: 0,
            },
            spender: SPENDER,
            sigDeadline: BigInt(now + HOUR),
          },
        },
      };

    /* Five leaves, comfortably renderable: the shape a device should show in
     * full with no refusal. */
    case "permit":
      return {
        method: "eth_signTypedData_v4",
        typed: {
          domain: { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
          types: {
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
            owner,
            spender: SPENDER,
            value: 5_000_000n,
            nonce: 0n,
            deadline: BigInt(now + HOUR),
          },
        },
      };

    /* What a drainer actually sends: the maximum a uint160 holds, and a
     * deadline far enough out to be submitted whenever it suits. The device
     * should name the amount UNLIMITED -- judged against the argument's own
     * width, since 2^160-1 is unremarkable inside 256 bits -- and the year
     * should be legible on the deadline page. */
    case "unlimited":
      return {
        method: "eth_signTypedData_v4",
        typed: {
          domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 },
          types: {
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
            details: { token: USDC, amount: MAX_UINT160, expiration: 2_000_000_000, nonce: 0 },
            spender: SPENDER,
            sigDeadline: 2_000_000_000n,
          },
        },
      };

    case "personal":
      return { method: "personal_sign", text: "LeekWallet test-dapp: prove this device signs what it showed." };

    default:
      throw new Error(`unknown payload "${kind}" — try permit2, permit, unlimited or personal`);
  }
}

function showQr(uri) {
  const qr = qrcode(0, "L");
  qr.addData(uri);
  qr.make();
  const n = qr.getModuleCount();
  /* Two spaces per module, and a quiet zone: a terminal cell is roughly twice
   * as tall as it is wide, so one space per module scans as a squashed code
   * that phones refuse. */
  const pad = "  ".repeat(n + 4);
  const rows = ["", pad, pad];
  for (let r = 0; r < n; r++) {
    let line = "    ";
    for (let c = 0; c < n; c++) line += qr.isDark(r, c) ? "██" : "  ";
    rows.push(line + "    ");
  }
  rows.push(pad, pad, "");
  /* Dark modules must print dark-on-light, so invert the terminal. */
  console.log("\x1b[7m" + rows.join("\n") + "\x1b[0m");
}

const kind = process.argv[2] ?? "permit2";
const now = Math.floor(Date.now() / 1000);

const client = await SignClient.init({
  projectId: PROJECT_ID,
  metadata: {
    name: "LeekWallet test-dapp",
    description: "A local rig for exercising signing paths",
    url: "https://github.com/leekwallet",
    icons: [],
  },
});

const { uri, approval } = await client.connect({
  optionalNamespaces: {
    eip155: {
      chains: [`eip155:${CHAIN_ID}`],
      methods: ["eth_signTypedData_v4", "personal_sign", "eth_sendTransaction"],
      events: ["chainChanged", "accountsChanged"],
    },
  },
});

console.log(`\nScan this with the companion, or paste it in:\n`);
showQr(uri);
console.log(uri + "\n");

/* Also to a file. A wc: URI is one long line with a symKey at the end, and the
 * first thing that happened to one was a paste that lost the tail: the wallet
 * refused it as truncated, which was correct and told nobody the cause was the
 * copy. `cat` it, or pipe it to a clipboard tool, and nothing has a chance to
 * wrap it. */
try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/leek-pairing-uri.txt", uri + "\n");
  console.log("also written to /tmp/leek-pairing-uri.txt");
  console.log("  copy it with:  xclip -sel c < /tmp/leek-pairing-uri.txt\n");
} catch { /* the URI is on screen either way */ }
console.log("waiting for the wallet to approve the session…");

const session = await approval();
const account = session.namespaces.eip155.accounts[0];
const owner = account.split(":")[2];
console.log(`connected: ${owner}\n`);

const req = payload(kind, owner, now);
let params, signature;

if (req.method === "personal_sign") {
  const hex = "0x" + Buffer.from(req.text, "utf8").toString("hex");
  params = [hex, owner];
  console.log(`asking for personal_sign of: ${req.text}`);
} else {
  /* JSON.stringify cannot carry a bigint, and the wire format is a string, so
   * they are rendered here rather than left for the wallet to guess at. */
  const json = JSON.stringify(req.typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  params = [owner, json];
  console.log(`asking for ${kind} (${json.length} bytes of typed data)`);
  console.log("check every page on the device before approving.\n");
}

try {
  signature = await client.request({
    topic: session.topic,
    chainId: `eip155:${CHAIN_ID}`,
    request: { method: req.method, params },
  });
} catch (e) {
  console.log(`\nthe wallet refused: ${e.message}`);
  console.log("(a refusal can be the correct answer — see PROTOCOL.md 6bis)");
  process.exit(1);
}

console.log(`signature: ${signature}`);

if (req.method === "eth_signTypedData_v4") {
  /* The check no amount of on-device rendering can make for itself: does this
   * signature belong to the address the wallet says it is, over the structure
   * that was actually sent? A device that draws the right pages and signs a
   * different digest fails exactly here and nowhere else. */
  const ok = await verifyTypedData({ ...req.typed, address: owner, signature });
  const digest = hashTypedData(req.typed);
  const recovered = await recoverAddress({ hash: digest, signature });
  console.log(`\ndigest:    ${digest}`);
  console.log(`recovered: ${recovered}`);
  console.log(`expected:  ${owner}`);
  console.log(ok ? "\nPASS — the signature is over the structure that was sent, by that address."
                 : "\nFAIL — the device signed something other than what was sent.");
  process.exit(ok ? 0 : 1);
}

console.log("\nPASS — signature returned. (personal_sign is not verified here.)");
process.exit(0);
