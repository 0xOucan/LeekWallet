/**
 * RPC failover tests (T62).
 *
 * The transport is injected, so all of this runs with no network: every
 * "endpoint" below is a function that returns whatever the case needs. What is
 * being pinned down is the policy — which failures move to the next operator,
 * which do not, what order the operators are tried in, and that the endpoint
 * which actually answered is both remembered and reported.
 *
 * What is deliberately NOT tested, because it cannot be: a node that answers
 * politely with a wrong nonce. Nothing in the app can tell that from a right
 * one. See the header of src/rpc.ts.
 */

import type { ChainStore } from "../src/chains.ts";
import {
  DEFAULT_RPC_TIMEOUT_MS, endpointOrder, FailoverRpc, judgeResponse, preferredRpc,
  PREFERRED_RPC_KEY, rememberRpc, RpcResponseError, RpcUnavailableError,
} from "../src/rpc.ts";
import type { RpcAttempt, RpcHttpRequest, RpcHttpResult, RpcSend } from "../src/rpc.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const memStore = (): ChainStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

const A = "https://a.invalid";
const B = "https://b.invalid";
const C = "https://c.invalid";

/** A transport driven by a per-URL script, recording what it was asked. */
function scripted(
  answers: Record<string, (req: RpcHttpRequest) => Promise<RpcHttpResult>>,
): { send: RpcSend; asked: string[] } {
  const asked: string[] = [];
  const send: RpcSend = async (req) => {
    asked.push(req.url);
    const fn = answers[req.url];
    if (!fn) throw new Error(`unscripted url ${req.url}`);
    return await fn(req);
  };
  return { send, asked };
}

const ok = (result: unknown) => async (req: RpcHttpRequest): Promise<RpcHttpResult> => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(req.body).id, result }),
});
const dead = () => async (): Promise<RpcHttpResult> => { throw new Error("connection refused"); };
const status = (code: number) => async (): Promise<RpcHttpResult> => ({ status: code, body: "" });

group("a failing endpoint is abandoned for the next one");
{
  const store = memStore();
  const { send, asked } = scripted({ [A]: dead(), [B]: ok("0x2a") });
  const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store });
  const result = await rpc.request({ method: "eth_blockNumber" });
  check(result === "0x2a", `wrong result: ${String(result)}`);
  check(asked.join(",") === `${A},${B}`, `wrong order: ${asked.join(",")}`);
  check(rpc.lastUrl === B, `lastUrl not the one that answered: ${String(rpc.lastUrl)}`);
}

group("every kind of silence fails over, and only silence does");
{
  for (const [name, first] of [
    ["a dead socket", dead()],
    ["a timeout", async () => { throw new Error("The operation timed out"); }],
    ["HTTP 429", status(429)],
    ["HTTP 500", status(500)],
    ["HTTP 404", status(404)],
    ["an HTML error page with a 200", async () => ({ status: 200, body: "<html>oops</html>" })],
    ["a JSON array", async () => ({ status: 200, body: "[]" })],
    ["a body with neither result nor error", async () => ({
      status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    })],
    ["a reply to a different request", async () => ({
      status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x1" }),
    })],
    ["a rate limit dressed as a 200", async () => ({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }),
    })],
    ["an internal error", async () => ({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "internal error" } }),
    })],
  ] as const) {
    const { send, asked } = scripted({ [A]: first as never, [B]: ok("0x1") });
    const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store: memStore() });
    let got: unknown;
    try { got = await rpc.request({ method: "eth_blockNumber" }); } catch (e) { got = e; }
    check(got === "0x1", `${name}: did not fail over (${String(got)})`);
    check(asked.length === 2, `${name}: wrong attempt count ${asked.length}`);
  }
}

group("an answer is an answer: a JSON-RPC error does not shop around");
{
  /* "execution reverted" is information. Retrying it on every operator would
   * disclose the transaction to all of them and then report the same error. */
  const { send, asked } = scripted({
    [A]: async () => ({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, error: { code: -32000, message: "execution reverted" },
      }),
    }),
    [B]: ok("0xdeadbeef"),
  });
  const store = memStore();
  const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store });
  let err: unknown;
  try { await rpc.request({ method: "eth_estimateGas" }); } catch (e) { err = e; }
  check(err instanceof RpcResponseError, `wrong error type: ${String(err)}`);
  check((err as RpcResponseError).code === -32000, `code: ${(err as RpcResponseError).code}`);
  check((err as RpcResponseError).message === "execution reverted", "message lost");
  check(asked.length === 1, `asked ${asked.length} endpoints for an answered call`);
  // It answered, so it is working: it stays the preferred endpoint.
  check(preferredRpc(1, [A, B], store) === A, "an answering node was demoted");
}

group("when nobody answers, the caller is told what each one did");
{
  const { send } = scripted({ [A]: dead(), [B]: status(503) });
  const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store: memStore() });
  let err: unknown;
  try { await rpc.request({ method: "eth_chainId" }); } catch (e) { err = e; }
  check(err instanceof RpcUnavailableError, `wrong error type: ${String(err)}`);
  const attempts = (err as RpcUnavailableError).attempts;
  check(attempts.length === 2, `attempts: ${attempts.length}`);
  check(attempts[0]?.reason === "network", `first reason: ${attempts[0]?.reason}`);
  check(attempts[1]?.reason === "http", `second reason: ${attempts[1]?.reason}`);
  // The hosts are in the message: "the RPC is down" with no name is unactionable.
  check((err as Error).message.includes("a.invalid"), "message names no host");
  check((err as Error).message.includes("b.invalid"), "message names only one host");
}

group("an empty endpoint list is an error, not a hang");
{
  const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [], send: async () => { throw new Error("x"); }, store: memStore() });
  let err: unknown;
  try { await rpc.request({ method: "eth_chainId" }); } catch (e) { err = e; }
  check(err instanceof RpcUnavailableError, `wrong error type: ${String(err)}`);
}

group("the endpoint that answered is preferred next time");
{
  const store = memStore();
  {
    const { send } = scripted({ [A]: dead(), [B]: ok("0x1") });
    await new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store }).request({ method: "eth_chainId" });
  }
  check(preferredRpc(1, [A, B], store) === B, "the working endpoint was not remembered");
  {
    const { send, asked } = scripted({ [A]: dead(), [B]: ok("0x2") });
    const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A, B], send, store });
    await rpc.request({ method: "eth_chainId" });
    check(asked.join(",") === B, `did not start from the remembered endpoint: ${asked.join(",")}`);
  }
  // Per chain, not global: two chains may have different healthy operators.
  check(preferredRpc(137, [A, B], store) === undefined, "a preference leaked across chains");
}

group("a remembered endpoint may reorder the list, never extend it");
{
  /* localStorage is writable by anything that gets script into this origin, so
   * a stored URL is untrusted input. If it could add an endpoint, "remember
   * the last one" would be a way to make the app talk to a host nobody chose —
   * which is precisely the boundary the CSP and the proxy allowlist exist to
   * hold. */
  const evil: ChainStore = {
    getItem: (k) => (k === PREFERRED_RPC_KEY ? JSON.stringify({ "1": "https://evil.invalid" }) : null),
    setItem: () => {},
  };
  check(preferredRpc(1, [A, B], evil) === undefined, "an unlisted endpoint was accepted");
  check(endpointOrder(1, [A, B], evil).join(",") === `${A},${B}`, "order was influenced by junk");

  const junk = (raw: string): ChainStore => ({
    getItem: (k) => (k === PREFERRED_RPC_KEY ? raw : null), setItem: () => {},
  });
  check(preferredRpc(1, [A, B], junk("{not json")) === undefined, "malformed JSON survived");
  check(preferredRpc(1, [A, B], junk("[]")) === undefined, "an array survived");
  check(preferredRpc(1, [A, B], junk("null")) === undefined, "null survived");
}

group("the declared order is otherwise preserved, with no duplicates");
{
  const store = memStore();
  check(endpointOrder(1, [A, B, C], store).join(",") === `${A},${B},${C}`, "declared order not preserved");
  rememberRpc(1, C, store);
  check(endpointOrder(1, [A, B, C], store).join(",") === `${C},${A},${B}`, "preferred not hoisted");
  // The hoisted entry must not also appear in its original position: it would
  // be contacted twice, telling one operator the same thing twice over.
  check(endpointOrder(1, [A, B, C], store).length === 3, "duplicate endpoint in the order");
}

group("the endpoint actually used is reported, so the UI can show it");
{
  /* The sign preview promises "the RPC you pick learns which addresses you are
   * asking about". With failover the one that was used is no longer always the
   * one displayed in the selector, so it has to be observable. */
  const used: string[] = [];
  const failed: RpcAttempt[] = [];
  const { send } = scripted({ [A]: status(500), [B]: ok("0x1") });
  const rpc = new FailoverRpc({
    chainId: 1, rpcUrls: [A, B], send, store: memStore(),
    onEndpoint: (u) => used.push(u),
    onFailover: (a) => failed.push(a),
  });
  await rpc.request({ method: "eth_chainId" });
  check(used.join(",") === B, `reported endpoint: ${used.join(",")}`);
  check(failed.length === 1 && failed[0]?.url === A, "the abandoned endpoint was not reported");
}

group("requests are well-formed JSON-RPC and carry a timeout");
{
  let seen: RpcHttpRequest | undefined;
  const send: RpcSend = async (req) => {
    seen = req;
    return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(req.body).id, result: "0x1" }) };
  };
  const rpc = new FailoverRpc({ chainId: 1, rpcUrls: [A], send, store: memStore() });
  await rpc.request({ method: "eth_getBalance", params: ["0x1", "latest"] });
  const body = JSON.parse(seen?.body ?? "{}");
  check(body.jsonrpc === "2.0", `jsonrpc: ${body.jsonrpc}`);
  check(body.method === "eth_getBalance", `method: ${body.method}`);
  check(Array.isArray(body.params) && body.params[1] === "latest", "params lost");
  check(typeof body.id === "number", `id: ${typeof body.id}`);
  check(seen?.timeoutMs === DEFAULT_RPC_TIMEOUT_MS, `timeout: ${String(seen?.timeoutMs)}`);
  // Absent params become [], not undefined: some nodes reject a missing field.
  await rpc.request({ method: "eth_chainId" });
  check(Array.isArray(JSON.parse(seen?.body ?? "{}").params), "params omitted entirely");
  // A fresh id per request, so a stale reply cannot be mistaken for this one.
  const first = JSON.parse(seen?.body ?? "{}").id;
  await rpc.request({ method: "eth_chainId" });
  check(JSON.parse(seen?.body ?? "{}").id !== first, "the request id did not advance");
}

group("judgeResponse is exhaustive about what it accepts");
{
  const env = (o: object) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 7, ...o }) });
  check(judgeResponse(env({ result: null }), 7).ok, "a null result was rejected");
  check(judgeResponse(env({ result: false }), 7).ok, "a false result was rejected");
  check(judgeResponse(env({ result: 0 }), 7).ok, "a zero result was rejected");
  const idMismatch = judgeResponse(env({ result: "0x1" }), 8);
  check(!idMismatch.ok && idMismatch.failover, "an id mismatch was accepted");
  // 204 is a 2xx, so it is judged on its body — which is empty, and an empty
  // body is not a JSON-RPC answer. Either way it moves on.
  const noBody = judgeResponse({ status: 204, body: "" }, 7);
  check(!noBody.ok && noBody.failover && noBody.reason === "malformed", "204 mishandled");
  const errNoCode = judgeResponse(env({ error: { message: "nope" } }), 7);
  check(!errNoCode.ok && errNoCode.failover === false, "an error without a code failed over");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
