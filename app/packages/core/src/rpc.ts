/**
 * Talking to an RPC node, with more than one node to talk to (T62 stage 1).
 *
 * Every curated chain in chains.ts already lists two independent operators,
 * and both are already in the CSP allowlist. Until now the app used
 * `rpcUrls[0]` and gave up if that operator was down, rate-limiting, or slow —
 * which is the failure people actually hit, and it needs no new trust to fix.
 * See docs/RPC-ACCESS.md.
 *
 * Two deliberate limits on what this can promise:
 *
 * 1. **It detects silence, not lies.** Failing over covers "no answer": a
 *    dropped connection, an HTTP error, a timeout, a body that is not a
 *    JSON-RPC response. It cannot cover a well-formed *wrong* answer. There is
 *    no way, from inside this app, to tell a truthful nonce from a fabricated
 *    one — the only thing that could is another node, and cross-checking two
 *    public endpoints just means both learn your address and you still have to
 *    decide which one to believe when they disagree. So: a hostile endpoint
 *    that answers politely is not caught here, and nothing below pretends
 *    otherwise. What keeps that survivable is that a wrong nonce, fee or
 *    balance costs a stuck or overpriced transaction, not custody — the device
 *    re-serialises and re-hashes the fields it drew (PROTOCOL.md section 1).
 *
 * 2. **Whoever answers learns which addresses you asked about.** Failover
 *    means that can now be either operator rather than always the first, so
 *    which one it actually was has to be visible rather than implicit; that is
 *    what `onEndpoint` and `lastUrl` are for, and the UI is expected to show
 *    it. Note that a failed attempt still disclosed the request to whoever
 *    received it — moving on does not take that back.
 *
 * The transport is injected (`RpcSend`) rather than calling `fetch` directly,
 * because stage 2 swaps the webview's fetch for a Rust command without any of
 * the policy here changing, and because it makes all of this testable under
 * plain Node with no network.
 */

import type { ChainStore } from "./chains.ts";
import { defaultChainStore } from "./chains.ts";

/** One HTTP POST. Everything network-shaped lives behind this. */
export interface RpcHttpRequest {
  url: string;
  /** Already-serialised JSON-RPC request body. */
  body: string;
  timeoutMs: number;
}

export interface RpcHttpResult {
  /** HTTP status. A transport that never saw a response must reject instead. */
  status: number;
  body: string;
}

export type RpcSend = (req: RpcHttpRequest) => Promise<RpcHttpResult>;

/** Where the last endpoint that worked is remembered, per chain. */
export const PREFERRED_RPC_KEY = "leekwallet.rpcPreferred.v1";

/** 15 s. A wallet must not be wedged by a node that answers slowly forever. */
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

/** Why an endpoint was abandoned. Carried into the error and the log. */
export type RpcFailureReason =
  | "network"        // the request never produced a response
  | "timeout"
  | "http"           // a response, but not a 2xx
  | "malformed"      // a 2xx that is not a JSON-RPC response object
  | "overloaded";    // a JSON-RPC error that means "ask someone else"

export interface RpcAttempt {
  url: string;
  reason: RpcFailureReason;
  message: string;
}

/** Every endpoint refused to answer. Carries what each one did. */
export class RpcUnavailableError extends Error {
  readonly attempts: readonly RpcAttempt[];
  constructor(method: string, attempts: readonly RpcAttempt[]) {
    const detail = attempts
      .map((a) => `${hostOf(a.url)}: ${a.reason} (${a.message})`)
      .join("; ");
    super(
      attempts.length === 0
        ? `no RPC endpoint is configured for ${method}`
        : `no RPC endpoint answered ${method} — ${detail}`,
    );
    this.name = "RpcUnavailableError";
    this.attempts = attempts;
  }
}

/**
 * The node answered, and the answer was an error.
 *
 * Not a failover trigger: this is a reply, not silence, and re-asking a second
 * operator would usually produce the same reply a second later. "execution
 * reverted" from `eth_estimateGas` is the common case and it is *information*
 * — hiding it behind a retry loop would turn a clear message into a slow one.
 */
export class RpcResponseError extends Error {
  readonly code: number;
  readonly url: string;
  constructor(message: string, code: number, url: string) {
    super(message);
    this.name = "RpcResponseError";
    this.code = code;
    this.url = url;
  }
}

/**
 * JSON-RPC error codes that mean "this node cannot serve you", as opposed to
 * "your request is answered and the answer is no".
 *
 * Kept to an explicit two rather than a range. -32000..-32099 is the
 * server-error range in EIP-1474, but in practice -32000 is what nodes return
 * for `execution reverted`, and treating that as a node fault would mean every
 * failing gas estimate silently disclosing the transaction to every operator
 * on the list before reporting the same error anyway.
 */
const RETRYABLE_RPC_CODES: ReadonlySet<number> = new Set([
  -32005,   // limit exceeded (EIP-1474) — the polite form of rate limiting
  -32603,   // internal error — the node is broken, not the request
]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type PreferredMap = Record<string, string>;

function readPreferred(store: ChainStore): PreferredMap {
  try {
    const raw = store.getItem(PREFERRED_RPC_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as PreferredMap;
  } catch {
    return {};
  }
}

/**
 * The endpoint that worked last time for this chain, if it is still one of the
 * candidates.
 *
 * The membership test is the security-relevant half: storage is writable by
 * anything that ever gets script into this origin, so a remembered URL is
 * untrusted input and may only ever *reorder* the caller's list, never add to
 * it. Same reasoning as re-validating custom chains on the way out of storage.
 */
export function preferredRpc(
  chainId: number,
  candidates: readonly string[],
  store: ChainStore = defaultChainStore(),
): string | undefined {
  const url = readPreferred(store)[String(chainId)];
  return url !== undefined && candidates.includes(url) ? url : undefined;
}

/** Remember the endpoint that answered. Best-effort: storage may be full. */
export function rememberRpc(
  chainId: number,
  url: string,
  store: ChainStore = defaultChainStore(),
): void {
  try {
    const map = readPreferred(store);
    if (map[String(chainId)] === url) return;
    map[String(chainId)] = url;
    store.setItem(PREFERRED_RPC_KEY, JSON.stringify(map));
  } catch {
    /* A preference that cannot be saved costs one extra attempt next launch. */
  }
}

/**
 * The order endpoints are tried in: the one that answered last time first,
 * then the rest in the order the registry declares them.
 *
 * Sticky rather than round-robin, and rather than racing. Round-robin would
 * spread every address you look up across every operator, which is worse for
 * privacy for no reliability gain, and racing contacts all of them by
 * definition. Sticky means the steady state is one operator learning your
 * addresses instead of several — and the declared order is otherwise
 * preserved, so a chain's first-listed operator stays the default.
 */
export function endpointOrder(
  chainId: number,
  candidates: readonly string[],
  store: ChainStore = defaultChainStore(),
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const first = preferredRpc(chainId, candidates, store);
  if (first !== undefined) {
    out.push(first);
    seen.add(first);
  }
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** A JSON-RPC response, as far as we are willing to assume anything about it. */
interface JsonRpcEnvelope {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * What to do with one endpoint's reply: take it, or move on and why.
 *
 * Split out from the loop so the policy is a pure function and can be tested
 * exhaustively without a network or a clock.
 */
export type Verdict =
  | { ok: true; result: unknown }
  | { ok: false; failover: true; reason: RpcFailureReason; message: string }
  | { ok: false; failover: false; code: number; message: string };

export function judgeResponse(
  http: RpcHttpResult,
  expectedId: number,
): Verdict {
  if (http.status < 200 || http.status >= 300) {
    // 429 and 5xx are the ones that matter, but any non-2xx from a JSON-RPC
    // endpoint means it did not serve the call, so all of them move on.
    return { ok: false, failover: true, reason: "http", message: `HTTP ${http.status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(http.body);
  } catch {
    // Captive portals and error pages answer 200 with HTML. That is not an
    // answer from a node.
    return { ok: false, failover: true, reason: "malformed", message: "response is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failover: true, reason: "malformed", message: "response is not a JSON-RPC object" };
  }

  const env = parsed as JsonRpcEnvelope;

  // An id that does not match means the reply is to some other request. Treat
  // it as no answer rather than as this call's result.
  if (env.id !== expectedId) {
    return {
      ok: false, failover: true, reason: "malformed",
      message: `response id ${String(env.id)} does not match request id ${expectedId}`,
    };
  }

  if (env.error !== undefined && env.error !== null) {
    const code = typeof env.error.code === "number" ? env.error.code : 0;
    const message = typeof env.error.message === "string" ? env.error.message : "RPC error";
    if (RETRYABLE_RPC_CODES.has(code)) {
      return { ok: false, failover: true, reason: "overloaded", message: `${message} (${code})` };
    }
    return { ok: false, failover: false, code, message };
  }

  if (!("result" in env)) {
    return { ok: false, failover: true, reason: "malformed", message: "response has neither result nor error" };
  }
  return { ok: true, result: env.result };
}

export interface FailoverOptions {
  chainId: number;
  /** Candidate endpoints, in the registry's declared preference order. */
  rpcUrls: readonly string[];
  send: RpcSend;
  store?: ChainStore;
  timeoutMs?: number;
  /** Called with the endpoint that answered. The UI shows this to the user. */
  onEndpoint?: (url: string) => void;
  /** Called for each endpoint given up on, so the log can say what happened. */
  onFailover?: (attempt: RpcAttempt) => void;
}

/**
 * An EIP-1193-shaped `request` that walks a list of endpoints.
 *
 * Shaped that way on purpose: viem's `custom()` transport takes exactly this,
 * so the whole of the app's chain access gets failover without any call site
 * learning that endpoints are plural.
 */
/**
 * The grace a hung transport gets beyond its own deadline before this layer
 * gives up on it.
 *
 * A transport that honours `timeoutMs` finishes well inside this and never
 * reaches it; the margin exists so a healthy-but-slow endpoint is not cut off
 * by the safety net a moment before it would have answered.
 */
export const SEND_DEADLINE_GRACE_MS = 5_000;

/**
 * `send`, but it cannot hang for ever.
 *
 * `timeoutMs` is passed down and every transport is expected to honour it —
 * `fetchRpcSend` does, with `AbortSignal.timeout`. That expectation is not
 * something this layer can check, and when it is wrong the failure is invisible:
 * the promise never settles, so there is no rejection to catch, no failover to
 * the next endpoint, and no log line. The UI simply stops, mid-signing, with
 * "fetching nonce and fees…" as the last thing it ever says.
 *
 * That happened. The deadline now lives here as well, so a transport that
 * forgets it costs one slow request instead of the session.
 */
function withDeadline(promise: Promise<RpcHttpResult>, timeoutMs: number): Promise<RpcHttpResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the transport did not answer or time out within ${timeoutMs + SEND_DEADLINE_GRACE_MS}ms`));
    }, timeoutMs + SEND_DEADLINE_GRACE_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error as Error); },
    );
  });
}

export class FailoverRpc {
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
  private readonly send: RpcSend;
  private readonly store: ChainStore;
  private readonly timeoutMs: number;
  private readonly onEndpoint?: (url: string) => void;
  private readonly onFailover?: (attempt: RpcAttempt) => void;
  private nextId = 1;
  /** The endpoint that most recently answered. Undefined until one has. */
  lastUrl: string | undefined;

  constructor(opts: FailoverOptions) {
    this.chainId = opts.chainId;
    this.rpcUrls = [...opts.rpcUrls];
    this.send = opts.send;
    this.store = opts.store ?? defaultChainStore();
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    if (opts.onEndpoint) this.onEndpoint = opts.onEndpoint;
    if (opts.onFailover) this.onFailover = opts.onFailover;
  }

  /** The order this client will try, right now. Exposed for the UI and tests. */
  order(): string[] {
    return endpointOrder(this.chainId, this.rpcUrls, this.store);
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    const attempts: RpcAttempt[] = [];
    const order = this.order();

    for (const url of order) {
      const id = this.nextId++;
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: params ?? [],
      });

      let http: RpcHttpResult;
      try {
        http = await withDeadline(this.send({ url, body, timeoutMs: this.timeoutMs }), this.timeoutMs);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        // A caller-side abort and a dead socket are indistinguishable at this
        // layer beyond the name, and both mean the same thing: move on.
        const reason: RpcFailureReason =
          /abort|timeout|timed out/i.test(message) ? "timeout" : "network";
        const attempt = { url, reason, message };
        attempts.push(attempt);
        this.onFailover?.(attempt);
        continue;
      }

      const verdict = judgeResponse(http, id);
      if (verdict.ok) {
        this.lastUrl = url;
        rememberRpc(this.chainId, url, this.store);
        this.onEndpoint?.(url);
        return verdict.result;
      }
      if (!verdict.failover) {
        // The node answered. Remember it — it is working — and report the
        // answer rather than shopping the request around.
        this.lastUrl = url;
        rememberRpc(this.chainId, url, this.store);
        this.onEndpoint?.(url);
        throw new RpcResponseError(verdict.message, verdict.code, url);
      }
      const attempt = { url, reason: verdict.reason, message: verdict.message };
      attempts.push(attempt);
      this.onFailover?.(attempt);
    }

    throw new RpcUnavailableError(method, attempts);
  }
}

/**
 * The webview's own `fetch`, as an `RpcSend`.
 *
 * Bound by the CSP's connect-src allowlist, which is exactly why it can only
 * serve curated chains — the stage-2 Rust proxy exists for the rest. Non-2xx
 * is returned rather than thrown so the policy above, not this function,
 * decides what a status means.
 */
export function fetchRpcSend(fetchImpl: typeof fetch = fetch): RpcSend {
  return async ({ url, body, timeoutMs }) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // No cookies or auth to a third-party node, ever: this is a public
      // endpoint and an ambient credential could only identify the user.
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}
