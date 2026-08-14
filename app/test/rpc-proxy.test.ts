/**
 * The webview half of the RPC proxy (T62 stage 2).
 *
 * The policy — https only, the caps, the redirect rules, JSON-RPC only — is
 * enforced in Rust and tested there (src-tauri/src/rpc.rs), because a rule
 * enforced in the webview is a rule an XSS can skip. What is being pinned down
 * here is the small amount this side is responsible for: that the proxy is
 * only claimed when the backend says it has one, that the origin the backend
 * reports is the one surfaced, and that a malformed answer from the command is
 * an error rather than something that flows on as a result.
 */

import { FailoverRpc } from "../packages/core/src/rpc.ts";
import { proxyAvailable, tauriRpcSend } from "../src/rpc-proxy.ts";
import type { Invoke } from "../src/tauri-transport.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

/** An invoke that answers from a table and records what it was asked. */
function fakeInvoke(
  answers: Record<string, (args?: Record<string, unknown>) => unknown>,
): { invoke: Invoke; calls: { cmd: string; args?: Record<string, unknown> }[] } {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, ...(args ? { args } : {}) });
    const fn = answers[cmd];
    if (!fn) throw new Error(`no such command: ${cmd}`);
    return fn(args);
  }) as Invoke;
  return { invoke, calls };
}

group("the proxy is only claimed when the backend says it has one");
{
  const yes = fakeInvoke({ rpc_proxy_available: () => true });
  check(await proxyAvailable(yes.invoke) === true, "an available proxy was not claimed");

  const no = fakeInvoke({ rpc_proxy_available: () => false });
  check(await proxyAvailable(no.invoke) === false, "an unavailable proxy was claimed");

  // A backend too old to know the command rejects. That is a "no", and it must
  // not become an exception on the way to the UI.
  const old = fakeInvoke({});
  check(await proxyAvailable(old.invoke) === false, "a rejecting backend was treated as a yes");

  // No bridge at all: a browser tab.
  check(await proxyAvailable(null) === false, "a browser tab claimed a proxy");

  // Anything other than a literal true is a no: a backend that answers with a
  // string or a null has not said it can make requests.
  for (const answer of [null, undefined, "true", 1, {}]) {
    const odd = fakeInvoke({ rpc_proxy_available: () => answer });
    check(await proxyAvailable(odd.invoke) === false, `${String(answer)} was read as a yes`);
  }
}

group("the request is handed to the command unaltered");
{
  const { invoke, calls } = fakeInvoke({
    rpc_call: () => ({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}', origin: "https://a.invalid" }),
  });
  const send = tauriRpcSend(invoke);
  const out = await send({ url: "https://a.invalid/rpc", body: '{"id":1}', timeoutMs: 4000 });
  check(calls[0]?.cmd === "rpc_call", `wrong command: ${calls[0]?.cmd}`);
  check(calls[0]?.args?.["url"] === "https://a.invalid/rpc", "url not forwarded");
  check(calls[0]?.args?.["body"] === '{"id":1}', "body not forwarded");
  // The timeout is forwarded rather than left to a default, so the one figure
  // the caller reasoned about is the one Rust clamps.
  check(calls[0]?.args?.["timeoutMs"] === 4000, "timeout not forwarded");
  check(out.status === 200 && out.body.includes("0x1"), "reply not returned");
}

group("the origin reported is the backend's, not the one that was asked for");
{
  /* A same-host redirect can change the port, and the sign preview promises
   * the user knows who learned about their addresses. So the displayed origin
   * comes from the answer, never from the request. */
  const seen: string[] = [];
  const { invoke } = fakeInvoke({
    rpc_call: () => ({
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":"0x1"}',
      origin: "https://a.invalid:8545",
    }),
  });
  const send = tauriRpcSend(invoke, (o) => seen.push(o));
  await send({ url: "https://a.invalid/rpc", body: "{}", timeoutMs: 1000 });
  check(seen.join(",") === "https://a.invalid:8545", `origin reported: ${seen.join(",")}`);
}

group("a malformed answer from the command is an error, not a result");
{
  for (const reply of [null, undefined, {}, { status: "200", body: "x" }, { status: 200 }, "hello"]) {
    const { invoke } = fakeInvoke({ rpc_call: () => reply });
    let threw = false;
    try {
      await tauriRpcSend(invoke)({ url: "https://a.invalid", body: "{}", timeoutMs: 1000 });
    } catch {
      threw = true;
    }
    check(threw, `accepted a reply of ${JSON.stringify(reply) ?? "undefined"}`);
  }
}

group("a refusal from Rust reaches the failover policy as a failed attempt");
{
  /* The proxy's refusals — https only, the caps, JSON-RPC only — arrive as a
   * rejected invoke. They must be classified the same as a dead socket, so one
   * unreachable endpoint moves on to the next rather than ending the call. */
  const { invoke } = fakeInvoke({
    rpc_call: (args) => {
      if (String(args?.["url"]).startsWith("https://bad")) {
        throw new Error("only https is allowed, not http");
      }
      const id = JSON.parse(String(args?.["body"])).id;
      return {
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id, result: "0x7" }),
        origin: "https://good.invalid",
      };
    },
  });
  const client = new FailoverRpc({
    chainId: 999,
    rpcUrls: ["https://bad.invalid", "https://good.invalid"],
    send: tauriRpcSend(invoke),
    store: { getItem: () => null, setItem: () => {} },
  });
  const result = await client.request({ method: "eth_chainId" });
  check(result === "0x7", `did not fail over past a refusal: ${String(result)}`);
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
