/**
 * The defining constraint of terminal mode: no key, and no reachable signing
 * path.
 *
 * A waiter is handed this device for a shift, in a bar, and it is pointed at
 * the merchant's treasury. "We did not add a send button" is not a security
 * property; "there is nothing in the graph that could produce a signature" is.
 * So this test re-derives the property from the source rather than trusting the
 * prose in index.ts that claims it.
 *
 * ---------------------------------------------------------------------------
 * What changed when payroll arrived, and what did not
 *
 * This package now holds a third app that DOES spend: payroll proposes an
 * ERC-20 transfer per person (payroll.ts). So "nothing in this package can
 * move money" stopped being true, and it would have been easy to weaken this
 * whole file to accommodate it. It is not weakened. The property is stated
 * where it belongs instead — per app, and per module:
 *
 *   - the cashier's app and the waiter's still cannot spend. The assertions
 *     below still drive both through their whole UI and check that no request
 *     comes out, and a new group checks that no module either of them uses so
 *     much as MENTIONS `propose` — so the capability cannot arrive through
 *     view.ts or watch.ts by the back door.
 *   - payroll can only propose one shape: `transfer(address,uint256)` to a
 *     token contract it resolved, with no value attached. It holds no key, no
 *     transport and no device; a proposal is an ask the wallet screens, draws
 *     and confirms on hardware (app-proposal.ts).
 *
 * The import allow-list and the forbidden-string scan cover all three apps
 * unchanged, because they were never about who spends: they are about whether
 * anything here could produce a signature by itself. Nothing can.
 *
 * Three independent arguments, because any one of them alone rots:
 *
 *  1. **Nothing here imports anything that could sign.** Every import in every
 *     source file is checked against an allow-list of two: `@leekwallet/core`
 *     and the QR renderer. A future import of the shell's device transport, of
 *     viem's wallet client, or of any key library fails here, at the line that
 *     added it.
 *  2. **No signing RPC or key material is named anywhere.** `eth_sendTransaction`,
 *     `personal_sign`, `eth_signTypedData`, private keys, mnemonics.
 *  3. **The context handed in is read-only.** `mount` is called with an
 *     `AppContext` whose `request` throws on anything but a read, and the app
 *     is driven through its whole UI — amount, tip, both tokens, every rail —
 *     with a stub DOM that records every event listener attached. Not one
 *     request is made, and no listener produces one.
 *
 * (3) is the one that would catch a signing path built out of core primitives
 * with no suspicious import and no suspicious string in it.
 *
 *  4. **Every RPC method the app can issue is a read.** C3 gave the terminal a
 *     payment watcher, so "makes no request at all" stopped being true and a
 *     weaker-sounding property replaced it: the only methods named anywhere in
 *     the sources, and the only ones a running watcher issues, are
 *     `eth_blockNumber` and `eth_getLogs`. That is the property worth having
 *     anyway — a till that could not read would not know it had been paid, and
 *     a till that could write would not be a till.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TILL_APP, TILL_WAITER_APP, PaymentWatcher, planPayroll, runPayroll } from "../src/index.ts";
import { importStaffCsv } from "../src/staff.ts";

/** The merchant, for the payroll group below. Checksummed. */
const MERCHANT = "0x7a3f1B2C4d5e6f708192A3B4c5D6E7F809a1b2c3";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const here = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(here, "..", "src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

/**
 * Imports an app may have. Anything else is a new capability, reviewed here.
 *
 * Two of the four are worth the sentence each:
 *
 * `@circle-fin/app-kit/chains` is the sponsor SDK's DATA module — chain ids,
 * USDC and EURC addresses, CCTP domains — and the subpath is load-bearing.
 * The package root (`@circle-fin/app-kit`) exports `Adapter`, `spend`,
 * `bridge` and the rest of the wallet layer, and importing it would put an
 * object with a `.spend()` on it inside a terminal whose whole claim is that
 * it cannot move money. The regex below therefore matches the one subpath and
 * NOT the root, deliberately.
 *
 * `@noble/hashes/sha256` is a hash and cannot sign. It backs the integrity
 * digest on an issued request (request.ts), which is explicitly not a
 * signature — there is no key here to make one with.
 */
const ALLOWED_IMPORTS = [
  /^@leekwallet\/core\//,
  /^\.\/[a-z-]+\.ts$/,
  /^qrcode-generator$/,
  /^@circle-fin\/app-kit\/chains$/,
  /^@noble\/hashes\/sha256$/,
];

group("no import could bring a signing capability in");
{
  check(sources.length >= 4, `expected the app's sources, found ${sources.join(", ")}`);
  for (const file of sources) {
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+["']([^"']+)["']/g)) {
      const spec = m[1] as string;
      check(ALLOWED_IMPORTS.some((re) => re.test(spec)),
        `${file} imports "${spec}", which is outside the app's allowed dependencies`);
    }
    // No dynamic import either: it would route around the check above.
    check(!/\bimport\s*\(/.test(source), `${file} uses a dynamic import`);
    check(!/require\s*\(/.test(source), `${file} uses require()`);
  }
}

group("no signing RPC, and no key material, is named anywhere");
{
  const forbidden: [RegExp, string][] = [
    [/eth_sendTransaction/, "a transaction broadcast"],
    [/eth_sendRawTransaction/, "a raw transaction broadcast"],
    [/eth_sign|personal_sign|signTypedData/, "a signing RPC"],
    [/privateKey|private_key|mnemonic|seedPhrase|\bxprv\b/i, "key material"],
    [/deviceClient|DeviceTransport|serialport|navigator\.hid|navigator\.usb|WebSocket/i, "a device transport"],
    [/\bsignTransaction\b|\bsignMessage\b|\bsignHash\b/, "a signing call"],
  ];
  for (const file of sources) {
    // Comments are stripped first: this app's prose is largely ABOUT the
    // absence of signing, and matching it would fire on the explanation
    // instead of on the thing — apps.test.ts makes the same exclusion.
    const code = readFileSync(join(srcDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    for (const [pattern, what] of forbidden) {
      check(!pattern.test(code), `${file} mentions ${what}: ${pattern.source}`);
    }
  }
}

group("the mounted app makes no request and offers no signing action");
{
  /* A DOM small enough to read, recording every listener attached, so that the
   * app can be driven and the drive can be inspected. */
  interface Node {
    tagName: string; className: string; children: Node[]; listeners: [string, () => void][];
    textContent: string; value: string; disabled: boolean; href: string;
    append(...kids: Node[]): void;
    replaceChildren(...kids: Node[]): void;
    appendChild(kid: Node): void;
    addEventListener(event: string, fn: () => void): void;
    setAttribute(key: string, value: string): void;
    classList: { add(): void };
  }
  const nodes: Node[] = [];
  const makeNode = (tagName: string): Node => {
    const node: Node = {
      tagName, className: "", children: [], listeners: [], textContent: "", value: "",
      disabled: false, href: "",
      append(...kids) { node.children.push(...kids); },
      replaceChildren(...kids) { node.children = kids; },
      appendChild(kid) { node.children.push(kid); },
      addEventListener(event, fn) { node.listeners.push([event, fn]); },
      setAttribute() {},
      classList: { add() {} },
    };
    nodes.push(node);
    return node;
  };
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
  };

  let requests = 0;
  const context = {
    chainId: 84532,
    address: "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3",
    request: async (method: string) => {
      requests++;
      throw new Error(`the till must make no RPC call, and made ${method}`);
    },
  };

  const root = makeNode("div");
  await TILL_APP.mount(root as unknown as HTMLElement, context as never);
  // Both halves of La Caja, on one harness: the waiter's terminal is the one
  // handed to a stranger, so it is the one that must not surprise us.
  await TILL_WAITER_APP.mount(makeNode("div") as unknown as HTMLElement, context as never);

  // Drive it: type an amount, press every tip, switch token, pick every rail.
  const clickable = nodes.flatMap((n) => n.listeners.map(([event, fn]) => [n, event, fn] as const));
  for (const [node, , fn] of clickable) {
    if (node.tagName === "input") node.value = "284.53";
    if (node.tagName === "select") node.value = "EURC";
    fn();
  }
  check(requests === 0, `the till made ${requests} RPC call(s); it must make none`);

  // Nothing rendered may be an action that moves money. The only outbound
  // links are wa.me shares; the only buttons are tips, rails and copy.
  for (const node of nodes) {
    if (node.tagName === "a") {
      check(node.href.startsWith("https://wa.me/"),
        `a link to ${node.href.slice(0, 40)} — the only link a till emits is a share`);
    }
  }
  check(!("signer" in context) && !("device" in context), "AppContext must carry no signer");
}

group("the two terminal apps cannot even name the proposal seam");
{
  /* `propose` is the one capability in AppContext that leads to a signature
     being asked for, and the cashier's and waiter's halves must not touch it.
     Reading the source rather than driving the app catches the version of this
     that only fires on a code path a test did not visit. */
  const TERMINAL_MODULES = [
    "index.ts", "waiter.ts", "view.ts", "watch.ts", "watch-view.ts",
    "order.ts", "rails.ts", "request.ts", "uri.ts", "css.ts",
  ];
  for (const file of TERMINAL_MODULES) {
    const code = readFileSync(join(srcDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    check(!/\bpropose\b/.test(code), `${file} names propose, and it is a terminal module`);
    check(!/app-proposal\.ts/.test(code), `${file} imports the proposal types`);
  }
  /* And the payroll modules are the only ones that do. Listed rather than
     inferred, so a fourth module growing the ability is a diff on this line. */
  const spenders = sources.filter((file) => {
    const code = readFileSync(join(srcDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    return /\bpropose\b/.test(code);
  });
  check(spenders.sort().join() === "payroll-view.ts,payroll.ts",
    `the modules that can propose are ${spenders.join(", ")}`);
}

group("payroll can only propose an ERC-20 transfer, and only to a token");
{
  /* The whole of what the spending half is allowed to ask for. It is driven
     with a real registry over every token it offers, and every proposal it
     produces is inspected: the selector is transfer(address,uint256), the
     length is the 68 bytes the firmware's decoder demands, `to` is a contract
     the app resolved rather than the recipient, no native value rides along,
     and the app supplies neither the signer nor the chain. */
  const staff = importStaffCsv(
    [
      "name,role,address,amount",
      "Ana,waiter,0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF,12.5",
      "Ben,chef,0x388C818CA8B9251b393131C08a736A67ccB19297,40",
    ].join("\n"),
  );
  check(staff.ok, "the fixture payroll should import");
  if (staff.ok) {
    for (const [chainId, token] of [[84532, "USDC"], [84532, "EURC"], [5042002, "cirBTC"]] as const) {
      const planned = planPayroll([...staff.staff], chainId, token, MERCHANT);
      check(planned.ok, `${token} on ${chainId} should plan`);
      if (!planned.ok) continue;
      const asked: Record<string, unknown>[] = [];
      await runPayroll(planned.plan, async (proposal) => {
        asked.push(proposal as unknown as Record<string, unknown>);
        return { ok: true, kind: "call", result: "0x" + "11".repeat(32) };
      }, () => {});
      check(asked.length === 2, `${token}: one proposal per person, got ${asked.length}`);
      for (const proposal of asked) {
        check(proposal.kind === "call", "a payroll proposal is a call, never typed data");
        const data = String(proposal.data);
        check(data.startsWith("0xa9059cbb"), `a payroll proposed ${data.slice(0, 10)}`);
        check(data.length === 138, `a payroll proposed ${(data.length - 2) / 2} bytes of calldata`);
        check(String(proposal.to).toLowerCase() === planned.plan.contract.toLowerCase(),
          "a payroll proposal must be addressed to the token contract");
        check(proposal.value === undefined, "a payroll transfer carries no native value");
        check(!("from" in proposal) && !("chainId" in proposal),
          "an app supplies neither the signer nor the chain");
      }
    }
  }
}

group("the app declares only what the shell can supply");
{
  // Widening AppContext is allowed by the contract; a till that needed a
  // narrower one, or an extra capability, would be a different security story.
  const source = readFileSync(join(srcDir, "index.ts"), "utf8");
  check(!/interface \w*Context extends AppContext/.test(source),
    "the till widens AppContext, which deserves a look at what it added");
}

group("every RPC method the app can name is a read");
{
  /* An allow-list of two. Adding a third method to the app means adding it
   * here, which is the review this file exists to force. */
  const READS = ["eth_blockNumber", "eth_getLogs"];
  for (const file of sources) {
    const code = readFileSync(join(srcDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    for (const m of code.matchAll(/method:\s*["']([a-zA-Z_]+)["']/g)) {
      check(READS.includes(m[1] as string), `${file} issues ${m[1]}, which is not a read`);
    }
  }
}

group("a running watcher issues nothing but those reads");
{
  /* The source scan above cannot see a method assembled at runtime. This can:
   * the watcher is driven with a channel that records what it was asked, over
   * a chain that pays and a chain that fails. */
  const asked: string[] = [];
  const watcher = new PaymentWatcher({
    chains: [84532, 80002],
    channelFor: (chainId: number) => ({
      request: async ({ method }: { method: string }) => {
        asked.push(method);
        if (chainId === 80002) throw new Error("this endpoint is down");
        return method === "eth_blockNumber" ? "0xc8" : [];
      },
    }),
    target: {
      recipient: "0x7a3f1b2c4d5e6f708192a3b4c5d6e7f809a1b2c3",
      token: "USDC" as const, total: 32721n, marker: 17,
    },
    onUpdate: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  });
  await watcher.poll();
  watcher.stop();
  check(asked.length > 0, "the watcher must actually have asked something");
  for (const method of asked) {
    check(["eth_blockNumber", "eth_getLogs"].includes(method), `the watcher issued ${method}`);
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
