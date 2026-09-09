# The eth-decode mirror is maintained by discipline, not proved

## The claim

`app/packages/core/src/eth-decode.ts` describes itself as "a mirror of
`src/eth-decode.c`", and says drifting from that C file "is the bug this mirror
exists to catch". Its test says:

> the mock-conformance vectors are what prove the two agree

## The finding (2026-09-09)

**They do not.** The two decoders are never mechanically compared on the same
calldata.

- `app/packages/core/test/conformance-vectors.json` holds **53 protocol frames**
  — `{name, setup, frameType, request, replyType, reply}` — emitted by
  `sim/test_protocol` via `make -C sim conformance`. It pins the **transport and
  RPC layer**: that a request frame produces a given reply frame.
- The **calldata decoders** are tested by two independent suites over the same
  intended behaviour: `sim/test_eth_decode.c` and
  `app/packages/core/test/eth-decode.test.ts`. Neither reads nor emits a shared
  vector file — `grep` for `emit-vectors`, `fopen`, `json` in the C test returns
  zero hits, and the TS test reads no shared file.

So agreement between the C and TS decoders rests on a human keeping two files in
step, and on comments asking them to. That is real discipline and the files are
unusually well commented, but it is **not** what the code claims.

## Why it matters more now

B3's whole safety argument is that **the host may never render a program the
firmware would refuse** — the host's accepted set must be a subset of the
firmware's. `docs/AQUA-B3-SPEC.md` §7 asserts the conformance vectors prove it.
They cannot: they do not cover calldata decoding at all.

Every existing decode path has the same exposure. It has simply never been
exercised by a drift, because one person wrote both sides at the same time.

## What would close it

A shared calldata-vector file, generated the way the protocol vectors already
are — recorded from the C decoder, then replayed by the TS suite:

1. `sim/test_eth_decode.c` gains `--emit-vectors <path>`, writing, for a corpus
   of calldata inputs, what `eth_decode()` produced: accepted or refused, and on
   acceptance every field the screen draws.
2. A Makefile target emits it, and `scripts/check.sh` runs that **before** the
   app tests — the same ordering and the same reasoning the protocol vectors
   already use ("re-made from today's `protocol.c` or the mock is being compared
   against a memory").
3. `eth-decode.test.ts` replays the file and asserts the TS decoder agrees on
   every entry, including **every refusal**. A refusal that only one side makes
   is exactly the drift worth catching.
4. The corpus must include the refusals, not just the happy paths: truncated
   calldata, bad offsets, an unknown selector, and — once B3 lands — an unknown
   opcode.

Until that exists, `eth-decode.ts`'s claim should read "kept in step by hand"
rather than "proved", and `AQUA-B3-SPEC.md` §7's appeal to conformance vectors
is an appeal to something that does not yet cover it.
