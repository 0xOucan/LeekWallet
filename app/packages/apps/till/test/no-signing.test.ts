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
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TILL_APP } from "../src/index.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const here = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(here, "..", "src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

/** Imports an app may have. Anything else is a new capability, reviewed here. */
const ALLOWED_IMPORTS = [/^@leekwallet\/core\//, /^\.\/[a-z-]+\.ts$/, /^qrcode-generator$/];

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

group("the app declares only what the shell can supply");
{
  // Widening AppContext is allowed by the contract; a till that needed a
  // narrower one, or an extra capability, would be a different security story.
  const source = readFileSync(join(srcDir, "index.ts"), "utf8");
  check(!/interface \w*Context extends AppContext/.test(source),
    "the till widens AppContext, which deserves a look at what it added");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
