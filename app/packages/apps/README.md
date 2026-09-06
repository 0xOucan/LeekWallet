# Mini-apps

A mini-app is one directory under `app/packages/apps/`. It renders a view for
the address the shell is showing, using the chain and nothing else.

The rule that shapes everything here:

> **Any app must be removable from a release by deleting its directory and one
> line of `app/src/apps/registry.ts`, at build time.**

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
}
```

An app exports one such object as a named const and as its default export, and
`app/src/apps/registry.ts` lists it.

`AppContext` may be **widened** by an app (Aqua adds an optional `scan` window
for tests) and must never be **narrowed** — the shell only knows how to supply
the shared shape.

### What an app is not given

No signer, no device client, no transport. A read-only app should be
structurally incapable of producing a signature, not merely disinclined to. An
app that needs a transaction returns an unsigned one for the shell to put
through the ordinary device path, the same rule `core/src/allowances.ts` states
for its revoke transactions.

## The dependency graph

```
app/src/apps/registry.ts  ->  each app  ->  @leekwallet/core
```

Two rules, and they are what make removal a two-deletion procedure:

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
