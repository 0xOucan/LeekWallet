/**
 * The webview half of the Rust RPC proxy (T62 stage 2).
 *
 * Two ways to reach an RPC node, behind the one `RpcSend` interface the
 * failover client in core already takes:
 *
 * - `fetch`, which the CSP bounds to the reviewed list of curated origins.
 * - `invoke("rpc_call")`, which runs in the Rust process, where the CSP does
 *   not apply. This is the only way a user-typed endpoint can be reached: its
 *   origin is unknown at build time, so no `connect-src` entry can cover it.
 *
 * The proxy is preferred whenever it exists, so that curated and custom chains
 * take the same path in a native build — one code path that gets exercised
 * every day is worth more than a special case that only custom chains use.
 * `fetch` remains for the browser dev server and for a build compiled without
 * the client (see src-tauri/src/rpc.rs on why that is possible).
 *
 * Nothing here decides policy. Every rule — https only, the caps, the redirect
 * limits, JSON-RPC only — is enforced in Rust, because a rule enforced in the
 * webview is a rule an XSS can skip.
 */

import { fetchRpcSend, type RpcSend } from "../packages/core/src/rpc.ts";
import { invoker, type Invoke } from "./tauri-transport.ts";

/** What `rpc_call` answers with. `origin` is who actually served it. */
interface RpcReply {
  status: number;
  body: string;
  origin: string;
}

/**
 * Ask the backend whether it can actually make a request.
 *
 * A capability query, not an inference from the presence of an `invoke`
 * bridge — the same rule `transports()` follows. Offering a custom network on
 * a build that cannot reach it would be a UI claiming something it cannot do,
 * which is the one thing a wallet must not do.
 *
 * A backend too old to know the command answers by rejecting, which is a
 * "no" — and the correct one.
 */
export async function proxyAvailable(invoke: Invoke | null = invoker()): Promise<boolean> {
  if (!invoke) return false;
  try {
    return (await invoke<boolean>("rpc_proxy_available")) === true;
  } catch {
    return false;
  }
}

/**
 * The proxy as an `RpcSend`.
 *
 * `onOrigin` reports the origin the Rust side actually reached, which is not
 * necessarily the one that was asked for: a same-host redirect can change the
 * port. Who ended up hearing the request is what the UI must display, so it is
 * taken from the answer rather than assumed from the request.
 */
export function tauriRpcSend(invoke: Invoke, onOrigin?: (origin: string) => void): RpcSend {
  return async ({ url, body, timeoutMs }) => {
    const reply = await invoke<RpcReply>("rpc_call", { url, body, timeoutMs });
    if (typeof reply?.status !== "number" || typeof reply?.body !== "string") {
      throw new Error("the RPC proxy returned something that is not a reply");
    }
    if (typeof reply.origin === "string" && reply.origin.length > 0) onOrigin?.(reply.origin);
    return { status: reply.status, body: reply.body };
  };
}

/**
 * The transport this build should use, decided once at startup.
 *
 * Resolved eagerly rather than per request so that a single answer is used for
 * the whole session: a transport that silently changed between the nonce
 * lookup and the broadcast would make "who was asked" unanswerable.
 */
export async function resolveRpcSend(
  onOrigin?: (origin: string) => void,
): Promise<{ send: RpcSend; viaProxy: boolean }> {
  const invoke = invoker();
  if (invoke && (await proxyAvailable(invoke))) {
    return { send: tauriRpcSend(invoke, onOrigin), viaProxy: true };
  }
  return { send: fetchRpcSend(), viaProxy: false };
}
