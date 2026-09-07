# Mini-apps

A mini-app is one directory under `app/packages/apps/`. It renders a view for
the address the shell is showing, using the chain and nothing else.

The rule that shapes everything here:

> **Any app must be removable from a release by deleting its directory, its two
> lines of `app/src/apps/registry.ts`, and its line of `app/package.json` — at
> build time.**

Not hidden by a runtime flag. A flag leaves the code — and its RPC endpoints,
and its CSS — shipped to everyone, which is the opposite of what "excludable
from a release" has to mean for a wallet.

## The contract

`@leekwallet/core/mini-app.ts` — types only, no runtime. Read it; it is short
and its comments carry the reasoning.

```ts
export interface MiniApp {
  id: string;                  // stable, lower-case, unique
  name: string;
  summary: string;             // one line, in a user's words
  chainIds: readonly number[]; // the app decides, not the shell
  css: string;                 // travels with the app; classes prefixed with id
  mount(root: HTMLElement, context: AppContext): Promise<void>;
}

export interface AppContext {
  chainId: number;
  address: string;
  request: EthRequest;         // the shell's failover RPC. Do not build your own.
  propose?: (p: AppProposal) => Promise<ProposalOutcome>;  // see "Signing", below
  endpointHost?: () => string | undefined;      // who answered, at render time
  requestOn?: (id: number) => ChainChannel | undefined;  // a read path to another chain
}
```

`requestOn` may return `undefined`, and an app must render that chain as **not
looked at**, never as **nothing there** — La Caja watches nine chains for a
payment, and "we could not ask" told to a customer as "you have not paid"
invites them to pay twice.

An app exports one such object as a named const and as its default export, and
`app/src/apps/registry.ts` lists it.

`AppContext` may be **widened** by an app (Aqua adds an optional `scan` window
for tests) and must never be **narrowed** — the shell only knows how to supply
the shared shape.

### What an app is not given

No signer, no device client, no transport, no key, no session. An app should be
structurally incapable of producing a signature, not merely disinclined to.
`app/test/apps.test.ts` asserts both halves of that: the fields `AppContext` may
carry, and the fact that no app source imports a core module that touches
hardware, keys or the wire, or names a device signing method.

## Signing: propose, never sign

> **If the device cannot render it, we do not sign it.**

An app that needs a signature calls `context.propose(...)`. It hands over an
*intent* and gets back an *outcome*. It never holds a function that turns bytes
it chose into a signature — that is a capability, and holding one means a
compromised dependency can sign at a time of its choosing. Proposing means every
signature costs a screening pass, a card the user reads, a device screen, and a
press.

`@leekwallet/core/app-proposal.ts` is the contract and carries the full
reasoning. In short:

```ts
const outcome = await context.propose?.({
  kind: "call",              // or "typed-data", with a `document`
  to: POOL,                  // the contract
  data: encoded,             // ABI-encoded calldata
  reason: "ship the order",  // one line, logged as the app's words
});
if (!outcome?.ok) return;    // one no, whatever the reason was
```

**What an app may set:** `to`, `data`, `value`, `reason` — and for typed data,
the `document`. That is the whole list, and the other fields are absent from the
type rather than ignored at runtime.

**What only the shell may set:** the signer (`from`), the chain, the nonce, the
gas, the fees, and whether the result is broadcast. An app that could pick
`from` could ask the user to sign as an account they are not looking at; an app
that could pick the chain could get a signature valid on a network the screen is
not about. The signer is always the address the shell is currently showing, and
the chain is always the one it is on.

**The descriptor rule.** A `call` proposal is refused unless a bundled ERC-7730
descriptor matches the chain, the contract *and* the selector, renders every
argument, and agrees with the firmware-mirroring decoder about what the calldata
says. A typed-data proposal is refused unless the device's own mirror
(`inspectTypedData`) can show every field — including when the device owner has
blind signing switched on, because that hatch is for dapps the owner chose to
connect to, not for code we shipped inside the wallet. So **an app that wants to
sign a new call ships the descriptor for it**, and until it does, the call
cannot be proposed. Refusal happens in `screenProposal`, in core, before
anything reaches the device.

**Every no looks the same.** `{ ok: false }` covers a missing descriptor, an
undescribable document, a device refusal and a user pressing reject, and an app
cannot tell which it got. An app that could would be able to walk selectors
until one is describable, or detect a rejection and immediately re-ask. The
*user* sees the real reason, in words, in the shell log, every time. That
asymmetry is deliberate.

**Not simulated.** A proposal is not run through `core/src/simulate.ts` before
it is shown. Making describability depend on a simulation would make it depend
on an RPC operator's uptime, would disclose the payload before the user had
decided anything, and would put a green tick next to a call the descriptor may
still be describing wrongly.

`propose` is optional, and its absence is a real state — no device, or a test
harness. An app must say so rather than pretend, and an app that never signs
never calls it.

The shell side is `app/src/apps/propose.ts`: it stamps in the shell-owned facts
and hands the screened proposal to the same review card a WalletConnect request
goes through. There is one review-and-sign path, and it was not duplicated.

## The dependency graph

```
app/src/apps/registry.ts  ->  each app  ->  @leekwallet/core
```

Two rules, and they are what make removal a three-deletion procedure:

1. **Nothing outside an app's directory imports anything inside it, except the
   registry.** One edge, in one file.
2. **No app imports another app.** Two apps sharing a helper would make deleting
   either of them a code change in the other. If two apps need the same thing,
   it goes in core, where it is reviewed as core.

`app/test/apps.test.ts` enforces both by reading the source. It will fail the
suite, not merely warn.

## Adding an app

1. `app/packages/apps/<id>/` with `package.json`
   (`"name": "@leekwallet/app-<id>"`, `"private": true`, `"type": "module"`,
   `exports: {".": "./src/index.ts"}`, depend on `@leekwallet/core`).
   `packages/apps/*` is already a workspace glob and `tsconfig.json` already
   includes `packages/apps/*/src` and `/test`.
2. Add `"@leekwallet/app-<id>": "workspace:*"` to `app/package.json` so the
   shell can resolve it, and run `pnpm --dir app install`.
3. Implement `MiniApp` in `src/index.ts`.
4. Add the import and the array entry in `app/src/apps/registry.ts`. Two lines,
   and they are the two you delete to remove it.
5. Tests run with `node --experimental-strip-types`, listed in the package's
   `test` script; `pnpm -r test` picks them up.

## Removing an app

```
rm -r app/packages/apps/<id>
```

then delete its `import` and its entry in `app/src/apps/registry.ts`, and its
line in `app/package.json`. The registry entry is a **static** import on
purpose: a directory deleted without the entry fails at `tsc`, not at runtime.
A release that compiles and then breaks on a screen is worse than one that will
not compile until somebody has looked.

## The house rule every app inherits

**A zero and an unavailable must never render the same.**

Every number an app shows came from an unverified RPC operator answering for a
contract nobody checked. A user who reads "0" and believes their funds are gone
does something expensive and irreversible; a user who reads "unavailable"
refreshes. So:

- lookups return discriminated unions, never `bigint | undefined`;
- no code path substitutes `0n` for an absent answer;
- the *renderer* is where this is provable, so keep the view model pure and
  assert on the text (`packages/apps/aqua/test/view.test.ts` is the pattern:
  an unavailable field may not contain a renderable amount, and its tone
  differs from a real zero's);
- an empty state is a statement, and it must say what was looked at. Aqua's
  names the block range it scanned.

`core/src/multicall.ts` states the same rule for balances and is worth reading
before writing a reader.
