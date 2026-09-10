# Mini-apps — the hackathon surface, and what removing it does

These packages exist **for the hackathon**. They are meant to be deletable
afterwards without unpicking the wallet. That goal shapes where things live.

## The rule

**Everything an app owns lives under its own package.** Source, tests,
documentation, and **smart contracts**:

```
app/packages/apps/<app>/
  src/          the app itself
  test/         its tests
  docs/         its documentation
  contracts/    its Solidity, deploy scripts and ABIs
  package.json
```

A contract that exists to serve one mini-app belongs in that mini-app's
`contracts/`, never at the repo root. The root is the wallet; the apps are
guests.

## What removing an app actually removes

Deleting `app/packages/apps/<app>/` removes the app, its tests, its docs and
its contracts. It does **not** remove three things, and that is not an
oversight:

1. **The framework** — `core/mini-app.ts` and `core/app-proposal.ts`. These
   define the contract an app is written against. They are generic and outlive
   any app.
2. **Firmware decoding for device-drawn calls** — `src/eth-decode.c`,
   `src/eth-decode.h`, `src/ui.c`. A call the device *draws* must be decoded
   *by the device*, and firmware cannot live in a TypeScript package. This is
   inherent: it is the price of a screen the host cannot forge.
3. **The host mirror of that decoding** — `core/eth-decode.ts`, plus the
   shared calldata vectors that prove the two agree.

The boundary already has a name in the code: `DEVICE_DRAWN_KINDS` in
`core/app-proposal.ts`, a closed set with a test pinning it. Whatever is in
that set has firmware behind it. Whatever is not, does not.

So after removing every app, the residue is: a generic app framework, and
decoders for call shapes nothing asks for any more. Dead, small, harmless —
and each one is a `CallKind` that can be deleted deliberately, with its
vectors, when someone decides to.

## Why the apps are quarantined at all

`app/test/apps.test.ts` enforces the isolation mechanically, not by
convention. It pins that no app imports another, that the shell never names an
app by ID, that an app cannot reach a key, a transport or the device, and that
`DEVICE_DRAWN_KINDS` is a closed set. Those tests are what make "delete the
folder" a safe operation rather than a hopeful one.
