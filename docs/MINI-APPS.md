# Mini-apps: the architecture, and how to bring one back

Aqua, ATS and La Caja were removed in `5a2b8bd`. **The framework was not.** This
records what the three of them taught, so a fourth does not relearn it, and
where to find them when one is wanted for another chain or another event.

## Getting them back

Nothing was thrown away; git has all of it.

```sh
git show 5a2b8bd --stat                 # what went, and its reasoning
git checkout 5a2b8bd~1 -- app/packages/apps/aqua
git show 82c5163 --stat                 # the docs that went with them
```

`5a2b8bd~1` is the last commit where all three exist and pass. Aqua carries its
whole Foundry tree — deploy scripts, broadcast records, an audit report — under
`app/packages/apps/aqua/contracts/`, per the rule that a mini-app's contracts
live in the mini-app's folder so the app can be deleted whole.

## What stayed, and why

| Kept | Why |
|---|---|
| `core/mini-app.ts`, `core/app-proposal.ts` | The framework outlives any app. Keeping it means the shell has exactly one edge to apps rather than growing a new one later. |
| `src/apps/{registry,mount,propose}.ts` | Same. `MINI_APPS` is now `[]`. |
| `docs/AQUA-B3-SPEC.md` | Despite the name it specifies the SwapVM decoder in `src/eth-decode.c`, which is still shipping firmware. |
| The `CallKind` entries and their shared vectors | A call the device *draws* must be decoded by the device. Removing those changes firmware behaviour and is its own decision. |

## The five rules the three apps proved

**1. An app cannot reach a key, a transport, or the device.** It builds calldata
and hands it to `screenProposal`. Everything else is the shell's. `app/test/`
enforced that no app imported another and that each carried its own CSS, so any
of them could be deleted whole — which is exactly what happened.

**2. A host-side descriptor cannot make a call signable.** Learned the hard way:
the escrow market's `fill()` was refused by the firmware with a valid ERC-7730
descriptor in place. Supporting a new call means extending the **device**.

**3. Three tiers, and the cost is wildly different.** A static-typed call is one
row in the firmware table. A dynamic-typed one is a hand-written decoder, its
host mirror, device pages and shared vectors — days. Anything else is blind
signing, off by default. Budget by tier before promising a feature.

**4. What cannot be drawn should not be signed, and raising the limit does not
help.** ATS's `deployEquity` is 3,748 bytes against `ETH_MAX_DATA` of 768. A
screen saying "deploy equity, approve?" over 3.7 KB nobody can read is blind
signing with better manners. The fix was to move the payload into verified
on-chain code so name and symbol *are* the decision.

**5. A parser fed by a file is a security boundary.** La Caja's CSV parser ends
in a transfer amount, so it refuses rather than coerces.

## If you write a fourth

1. New package under `app/packages/apps/<name>/`, its own CSS, no import of any
   other app, contracts in its own folder.
2. Add it to `MINI_APPS` in `src/apps/registry.ts` — one line, and one line to
   remove it again.
3. Decide the decoding tier **first**. If the device cannot draw the call, the
   app is not finished, however good the preview looks.
4. Contracts follow the standing rule: written against
   https://ethskills.com/security/SKILL.md and https://ethskills.com/audit/SKILL.md.
5. Expect to delete it. All three of these were written to be removable and all
   three were removed without touching the wallet.
