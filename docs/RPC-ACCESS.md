# How the app reaches an RPC node

Decided, not yet built. This note exists so the implementation inherits the
reasoning instead of rediscovering it.

## The problem

`app/src-tauri/tauri.conf.json` carries a `connect-src` allowlist of exact
origins — sixty-one of them at the time of writing, one pair of independent
operators per curated chain. That list is a security boundary: it is what stops
a compromised or XSS-ed frontend from posting the addresses you are asking about
to a host of its choosing. A test in `app/packages/core/test/chains.test.ts`
fails the build on a wildcard, on a bare `https:`, on an allowlisted origin no
chain uses, and on any curated chain whose origin is missing.

Two wanted features cannot work under it, for the same reason:

- **Custom chains.** A user types in an RPC URL. Its origin is unknown when the
  app is built, so the webview blocks the request.
- **Live Chainlist data.** Fetching current endpoints, and ranking them by
  latency, means talking to origins nobody reviewed.

## The decision: a Rust proxy

RPC calls move behind a `tauri::command`. The webview asks Rust; Rust makes the
HTTP request.

```
webview ──► rpc_call(origin, body) ──► Rust HTTP client ──► RPC node
   │
   └── CSP still applies here, and stays 'self' plus the reviewed list
```

This works because **the CSP governs the webview, not the Rust process**. The
frontend gains no new reach: it can call one command we wrote, and nothing else.
The alternative — allowing any `https:` origin in `connect-src` — would hand
arbitrary network reach to the least trustworthy part of the application, and
it is not recoverable once code depends on it.

### What the proxy owes us

It becomes the gatekeeper the CSP used to be, so it inherits the job:

- **https only**, and no following a redirect to another scheme or to a host the
  caller did not ask for.
- **Caps**: request size, response size, and a timeout. A wallet must not be
  wedged by a node that answers slowly forever.
- **JSON-RPC only** — this is not a general-purpose fetch, and it must never
  become one.
- **The origin actually used is recorded and displayed.** Which third party
  learned that you hold an address is not a detail to leave implicit. The
  existing preview already says "the RPC you pick learns which addresses you are
  asking about; it cannot move funds" — that sentence has to stay true.

### What an RPC can and cannot do

Worth stating plainly, because it sets how much this matters. An RPC **cannot
move funds**: the device signs, and it signs the fields it rendered. What a
hostile or broken RPC can do is lie about nonce, gas price and balance — pushing
you into a stuck or overpriced transaction — and learn which addresses you ask
about. The cost is reliability and privacy, not custody. That is why a user
supplying their own endpoint is acceptable at all, and why it still has to be
visible.

## Two problems, two answers

The **list** and the **nodes** are different origins with different standing.

`ethereum-lists/chains` publishes `chains.json`, which is what chainlist.org
renders. That is one known origin and can be a normal allowlisted fetch,
reviewed like any other entry. Only the calls to the individual RPC nodes it
names need the proxy, because those are the arbitrary ones.

## Latency ranking

Better in Rust than in the webview: no CORS, and real timings rather than
numbers the browser has fuzzed for fingerprinting reasons.

One honest cost — **measuring ping means contacting every candidate**, so each
one learns you exist. Rank on first use and cache the result; do not re-race the
field on every request. A wallet that quietly touches thirty providers to save
40 ms has made a poor trade.

## Sequencing

1. **Failover across the endpoints already shipped.** Every curated chain
   already has two independent operators and both are already allowlisted; the
   app just uses the first. Picking the responsive one fixes the flakiness
   people actually hit, needs no new trust, and needs no CSP change. Do this
   first, because it is most of the benefit for none of the risk.
2. **Then the proxy**, unlocking custom chains and live Chainlist.

## What this does not change

Nothing here touches what the device signs. The chain ID goes into the
transaction and the device displays it; an RPC that lies about fees still cannot
alter the bytes that get signed, because the device re-serialises and re-hashes
the fields it drew (PROTOCOL.md section 1). This is entirely about where the
*app* asks for nonce, fees and balances.
