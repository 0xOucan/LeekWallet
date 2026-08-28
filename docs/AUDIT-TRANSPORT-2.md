# Transport audit, second pass — verifying the v2 handshake

The first pass (`docs/AUDIT-TRANSPORT.md`) found C-1: the v1 passkey was a pure function of the
X25519 shared secret, so a relay could grind offline for a private key reproducing the digits the
device was already showing. That has been replaced by a commit-then-reveal handshake. This pass
exists to check the replacement rather than to admire it, and it does not repeat the first
document — where a finding is unchanged it is named and left alone.

Everything below was measured on this tree unless it says otherwise. Line numbers are as of the
commit this document lands in.

---

## 0. Summary

The new handshake **holds up**. I attacked it on paper along five axes — binding, hiding,
reordering, cross-session replay, reflection — and found no way to recover the offline search.
The commitment is binding over both public keys and the device nonce, the transcript is the HKDF
salt, and the state machine answers exactly one reveal per commitment. The rerun of the attack
confirms it: the search that worked against v1 finds nothing against v2.

What this pass found instead is five defects, a coverage gap, and a set of documentation
mismatches — and **the serious one is not in the handshake at all**. It is a signature taken
under a wallet the approval screen never showed, reachable by dropping a BLE link at the right
moment, which is the one invariant a signing device exists to hold.

| | | |
|---|---|---|
| **H-1** | A signature can be taken under a wallet the approval screen never showed | Fixed |
| **M-1** | `helloReveal` — the leg that actually paints — was not covered by the M-2 gate | Fixed |
| **M-2** | `ble_connect` drops a live transport without unsubscribing | Fixed |
| **M-3** | `recv` leaves partial reassembly state after a timeout, poisoning the next request | Fixed |
| **L-1** | Rust reassembler accepts body-less chunks; firmware and TypeScript refuse them | Fixed |
| **F-1** | The v2 handshake was constructed by the fuzzer but never fuzzed | Fixed |
| **D-1** | `PROTOCOL.md` frame-type table describes a protocol the firmware does not speak | Fixed |
| **D-2** | `PROTOCOL.md` claimed a nonce-reuse abort that does not exist | Fixed |
| **D-3** | The version is not inside the transcript — safe today, a trap for v3 | Documented |
| **R-1** | `attach` error paths orphan a BLE link on both backends | Recommended |
| **R-2** | Host frame bound is 4096; the device's is 1024 | Recommended |
| **R-3** | Android trusts a peer-reported MTU upward | Recommended |
| **R-4** | An unsolicited disconnect is invisible to the host UI | Recommended |

Changed-vs-recommended is kept strictly separate: section 9 lists every file I touched, section 10
everything I am leaving to the owner, and section 11 what only hardware can settle.

`./scripts/check.sh` passes on this tree, firmware included — RAM 17.3%, Flash 27.0%.

---

## 1. The handshake, attacked

`src/session.c`, `src/session.h`, `src/protocol.c:303-437`, `app/src/main.ts:320-375`.

### Is the commitment binding?

`Cb = SHA-256("leek-session-commit-v2" ‖ PKb ‖ PKa ‖ Nb)` — `src/session.c:59-83`.

**Binding: yes.** SHA-256 collision resistance, over three fixed-width fields, so there is no
second `(PKb, PKa, Nb)` triple that re-parses the same byte string. The variable-length-field
ambiguity that makes ad-hoc concatenation dangerous cannot arise here: every field is 32, 32 and
16 bytes, known in advance to both ends.

**Hiding: yes,** and this is the half that is easy to get wrong. A commitment to a low-entropy
value is not hiding — an attacker just enumerates. `Nb` is 16 bytes from `random_buffer`
(`src/session.c:225`), so recovering it from `Cb` is a 2^128 preimage search. The device also
does not reveal `Nb` until after `Na` has arrived (`session_reveal`, `src/session.c:255`), which
is the ordering the whole scheme rests on.

**Both public keys are inside it,** as in LESC's `f4`. Without `PKa` a commitment could be
replayed under a substituted host key; without `PKb` it would not pin the key the digits are
computed over. Both are there.

### Can a relay reorder, or get a second derivation?

No, and the state machine is the reason rather than a check bolted on.

- A `helloReveal` with no commitment outstanding: `sess.state != SESSION_AWAITING_REVEAL` →
  refused (`src/session.c:244-246`), surfaced as `0x0400` (`src/protocol.c:430`). Tested at
  `sim/test_protocol.c:780`.
- A **second** `helloReveal` against one commitment: the first moved the state to
  `SESSION_PENDING`, so the second hits the same refusal. This is the important one — a second
  derivation against a nonce the peer has already seen is precisely the search the round trip
  exists to prevent. Tested at `sim/test_protocol.c:803`.
- A fresh `hello` mid-handshake: `session_begin` calls `session_reset` first
  (`src/session.c:212`), so the peer gets a new key and a new nonce and nothing carries across.
  It cannot accumulate commitments and pick the best one.

### Replay across sessions?

No. `session_begin` generates both the ephemeral private key and `Nb` fresh per `hello`
(`src/session.c:216-225`). Replaying a captured `hello` gets a different `PKb` and `Nb`;
replaying a captured `helloReveal` mixes an old `Na` into a new transcript, so every derived
value differs and the digits do not match. There is no session resumption on either side and no
cached key material to resume from — `app/src/main.ts:855` runs the handshake unconditionally.

### Reflection?

The device cannot be made to see `PKa == PKb`: it generates `PKb` at random *after* receiving
`PKa`. On the host side there is no explicit check that `devicePubkey != hostPubkey`
(`app/src/main.ts:339` validates type and length only). It is **not exploitable** — a relay
reflecting `PKa` back does not know the host's private key, so it cannot compute
`X25519(a, PKa)` either, and it still cannot produce a `deviceCommit` binding a nonce it must
reveal before it can grind. The property is emergent from commit-then-reveal rather than local.
A two-line guard would make it local; see R-5.

Degenerate keys are refused on both ends: `src/session.c:141-150` (all-zero shared secret) and
`app/packages/core/src/session.ts:170`.

### Is the transcript complete?

This is the sharpest question and the answer is **almost**.

`T = SHA-256("leek-session-transcript-v2" ‖ PKa ‖ PKb ‖ Na ‖ Nb)` (`src/session.c:86-97`), used
as the HKDF-Extract salt (`src/session.c:104-129`) for all three outputs. All four values either
side contributes to the *cryptography* are in it, ordered by role rather than by who is
computing, so both ends hash identical bytes.

Two things are contributed and are **not** in it:

1. **The `version` field.** Both ends send it and both ends check it (`src/protocol.c:329-338`,
   `app/src/main.ts:330`), but neither hashes it. It is bound only indirectly, by the `-v2` in
   the five KDF labels (`src/session.c:51-55`). That is airtight *today* because exactly one
   version is accepted at each end: there is no version a relay could substitute that both ends
   would still derive under. It stops being airtight the moment a v3 accepts `{2, 3}` — a relay
   could then offer v2 to a v3 device and v3 to a v2 host and nothing inside `T` would record
   the downgrade. **Recorded in `PROTOCOL.md` §7 as a constraint on whoever adds v3**, because
   the code will not complain when that assumption is broken.

2. **The messages themselves.** `T` binds four values, not the bytes that carried them. Unknown
   CBOR keys in `hello`/`helloReveal` are ignored rather than hashed (`cbor_map_find` looks up by
   name; nothing rejects extras). ZRTP hashes the actual messages (RFC 6189 §4.5.2); this hashes
   a summary. Nothing in v2 reads a field outside `T`, so there is nothing to substitute — but it
   is an invariant to preserve, and an added field would break it quietly. Also recorded.

Neither is a live vulnerability. Both are the kind of thing that becomes one in the change that
does not think about it.

### What the relay is left with

One online guess at 1 in 10^6, in front of a user reading the OLED. That is the property LESC
numeric comparison and ZRTP's SAS have, and it is what the code now implements.

---

## 2. The attack, re-run

`sim/passkey_grind.c`, built with `-O2` and no sanitizers. Both modes, verbatim.

**v1 — the protocol C-1 was found in:**

```
== v1: no nonce, no commitment, passkey = f(shared secret)

the device will display 579252
20000 derivations in 3.40 s — 5881/s
expected work for a chosen 6-digit passkey: 10^6 derivations, about 170 s on this machine
run with --v1 --search to do it for real
```

**v2 — the protocol that replaced it:**

```
== v2: fresh nonces from both parties, device commits first, passkey bound to the transcript

the device will display 389734
  (fixed only once the device revealed its nonce — by which point
   the relay's own key and nonce were already on the wire)

the relay now looks for its own keypair and nonce making the APP
show 389734. In v1 this search was offline and free. Here it must
commit before the host's nonce exists, so what follows is the
search it would LIKE to run, with the host's nonce handed to it:

  20000 derivations in 5.13 s — 3897/s, 0 match(es)

under the protocol's actual ordering the relay must pick first.
  50000 committed attempts, 0 undetected — 0.000000% (1 in 10^6 is 0.000100%)

the relay is reduced to guessing, and every wrong guess is a
mismatch on two screens the user is comparing. There is no offline
phase left to run: the value it would search for does not exist
until after its own inputs are committed.
```

**Reading the numbers.** The v1 rate — 5881 derivations/s on one core against trezor-crypto's
deliberately slow reference X25519 — puts an offline search for a chosen 6-digit passkey at about
170 s on this machine, and a real attacker with an optimised multicore implementation is in the
single-digit seconds. That is the attack, and it is entirely offline: nothing crosses the wire
while it runs and no attempt fails for anyone to notice.

Against v2 the same code manages **0 matches in 20 000 derivations**, and the run says why: the
search is being handed inputs it would not have under the real ordering. The honest measurement
is the second one — **50 000 committed attempts, 0 undetected**, against the 1-in-10⁶ a blind
guess would give (5 expected; 0 observed is unremarkable at that rate). The point is not the
count but that committed attempts are the only kind available.

**A documentation defect fell out of this.** Three files cite this experiment and two of them
disagree: `docs/AUDIT-TRANSPORT.md:336` records the measured `425364 derivations in 91.32 s`,
`src/session.h` repeats 91 s, and `PROTOCOL.md` said **38 seconds**, twice, with no run behind it.
This machine gives a third figure again. Corrected to cite the measured 91 s with the machine
dependence stated, because a number quoted in three places and measured in one is a number that
will drift again.

---

## 3. Version negotiation

Verified in both directions.

**Host too old (v1, which sends no `version` field at all):** `src/protocol.c:324-338` reads
`version` and compares before touching `hostPubkey`; an absent field leaves `offered = 0`, which
is a mismatch and is named as one — `0x0002` in plaintext, carrying both numbers. Nothing is
derived and no state is created. Tested at `sim/test_protocol.c:752` (absent), `:757` (v1),
`:760` (v99).

**Device too old (answers v1, i.e. no `version` and no `deviceCommit`):** `app/src/main.ts:330`
checks the answered version **first**, before reading the public key, and throws. The throw
reaches `connectOnce`'s handler at `main.ts:856`, which tears the transport down. Nothing is
derived.

The ordering is right in both directions: the version check precedes every field read and every
derivation, so a mismatch surfaces as a mismatch rather than as "decrypt failed" three frames
later. The labels carry `-v2` as a second line of defence (`src/session.c:51-55`), so even a
bypassed check could not produce an accidentally-working channel.

---

## 4. M-2, and the leg it did not cover — **finding M-1**

**`hello` was gated. `helloReveal` was not, and `helloReveal` is the leg that paints.**

The gate at `src/protocol.c:318` defers `hello` with `0x0401` while `ui_user_is_answering()`.
That is correct and it is tested (`sim/test_protocol.c:818`). But `hello` deliberately puts
nothing on screen — the passkey does not exist until the reveal, and the comment at
`src/protocol.c:373-375` says so explicitly. The call that replaces whatever the user is looking
at is `ui_request_session_confirm()` in `handle_hello_reveal`, and that had no gate.

`session_confirm_pending` is honoured unconditionally by the UI task (`src/ui.c:5026-5043`) — it
interrupts any screen. So the interruption M-2 closed was reachable in two moves:

1. Send `hello` at a quiet moment. The device commits and enters `SESSION_AWAITING_REVEAL`.
   Nothing appears on screen. **Nothing times this out**, and USB has no disconnect, so the
   half-open handshake can sit there indefinitely.
2. Wait for the user to be reading something the device asked them. Send `helloReveal`. The
   screen is replaced.

Measured before the fix, via a test that opens a handshake, sets the answering flag, then
reveals:

```
== the second handshake leg also waits for the user (M-2b)
  FAIL: a helloReveal while the user is answering: frame type 0x02, wanted 0x7F
  FAIL: a helloReveal while the user is answering: reply carries no error code
  FAIL: a reveal replaced the screen the user was reading
  FAIL: the deferred reveal threw the commitment away (state 2)
  FAIL: the reveal was still refused after the user answered
```

State 2 is `SESSION_PENDING`: the reveal was answered, the keys were derived, and the pairing
prompt went up over whatever the user was reading.

**Fixed** at `src/protocol.c:385-402`: the same `ui_user_is_answering()` deferral, placed
*before* `session_reveal()` so the outstanding commitment survives. The cost to an honest host is
one retry rather than a whole new handshake — a deferral, matching the reasoning already made for
`hello`.

### Is the screen list right?

`ui_user_is_answering()` (`src/ui.c:4770-4800`) covers `SCREEN_SIGN_CONFIRM`,
`SCREEN_HOST_PASSPHRASE_CONFIRM`, `SCREEN_PASSPHRASE_CONFIRM`, `SCREEN_WIPE_CONFIRM`,
`SCREEN_MNEMONIC_DISPLAY`, `SCREEN_MNEMONIC_VERIFY`, plus the two pending flags so a request
handed to the UI task but not yet rendered still counts. `SCREEN_SESSION_CONFIRM` is correctly
absent, with a good reason given in the comment.

The screens I checked that are *not* listed, and why most of them do not need to be:

- **`SCREEN_ENTROPY` and the whole of wallet creation — covered by something stronger.**
  `screen_entropy_enter()` calls `transport_suspend()` (`src/ui.c:2857`), which tears the session
  down and stops both endpoints (`src/transport.c:119-137`). Nothing is listening for the
  collection, the generation, the words on screen or their verification. This is better than a
  gate and it should stay that way.
- **`SCREEN_PIN_UNLOCK` / `PIN_SETUP` / `PIN_CHANGE` — a real but small gap.** These have
  `.exit = forget_pin_entry` (`src/ui.c:179, 186`), so a stolen screen wipes half-typed digits.
  The wipe itself is correct — digits should not survive a screen change — and no failed-attempt
  counter is touched (`src/ui.c:632-640` clears buffers and nothing else), so this is **not** a
  remote path to the three-strikes wipe. What is left is a peer able to clear a PIN in progress,
  repeatedly. Annoying, not dangerous.
- **`SCREEN_MNEMONIC_ENTRY` reached from Import Wallet — the one I would add.** Unlike creation,
  the import path does not suspend the transport (`src/ui.c:1639`, `:2654` go straight to the
  screen), and `.exit = forget_mnemonic_entry` (`src/ui.c:621-627`) clears the words. So a peer
  can wipe a half-typed 24-word recovery phrase at will, which is the same class as the
  seed-on-display case that *is* listed. It destroys work rather than leaking anything.
  **Recommended, not changed** — see R-6; adding a screen to that list is a judgement about which
  interruptions matter, and that is the owner's.

Note that the gate is not the only thing that can end a session: any peer with write access can
kill a live one with a garbage `0x11` frame, because a failed tag tears the session down
(`src/session.c:344-352`). That is deliberate and fail-closed, and it does not steal the screen.
It is a denial of service available to anyone who can already write, which is the same population
the gate is about.

---

## 5. **H-1** — a signature under a wallet the screen never showed

This is the most serious thing in this pass and it is not in the handshake.

T47 established that "what was approved and what was signed must be the same object", and the
**path** satisfies it: `sign_path` is captured before the prompt and used unchanged for the
signature (`src/protocol.c:869`, `:900`), with the comment at `:895-898` saying exactly why.

The **wallet** does not. A passphrase is global state rather than part of a path, and a
host-supplied one is dropped by `session_reset()` → `host_passphrase_forget()` →
`wallet_clear_passphrase()` (`src/protocol.c:472-480`). `session_reset()` is called from
NimBLE's GAP handler on disconnect (`src/ble.c:377`) — **a different task from the one blocked in
`wait_for_user()`** (`src/protocol.c:547-561`, up to 120 s).

So the approval window is exactly when the wallet underneath the prompt can move, and it is the
two minutes in a session when a disconnect is *most* likely: the user has just picked the device
up and walked away from the phone.

Measured, with the drop injected at the moment the endpoint hands the address to the screen:

```
== a wallet that moves during approval voids the approval (T47)
  FAIL: the device signed after the wallet moved out from under the approval:
        it showed 0x0100001aaaaaabbbbbbbbccccccccddddddddeee
        and signed as 0x0100000aaaaaabbbbbbbbccccccccddddddddeee
```

The OLED showed an address in the hidden wallet; the signature was taken in the base one. The
user approves X and signs with Y. Whether an attacker forces the drop or the radio does it by
itself, the invariant the device exists to hold does not hold.

**Fixed** at `src/protocol.c:582-611` (`approval_still_holds`) and its three call sites,
`signTransaction`, `signMessage` and `signTypedData`. After the button, the address is re-derived
at the approved path and compared with the one that was displayed; a mismatch is refused with
`0x0200`. It costs one BIP32 derivation on a path just derived anyway, and it can only refuse —
there is no branch that signs something it otherwise would not.

It compares the **rendered address** rather than tracking the state that moved. Whatever moves
the key in future — a wallet switch, a lock, an account change — moves the address too, so this
catches it without anyone having to remember to add a flag.

---

## 6. Host-side state that survives a disconnect

The reported bug (a teardown that did not unsubscribe, so BlueZ believed the client was still
subscribed and the next subscribe was a no-op) is genuinely fixed on both backends:
`app/transport-ble/src/android.rs:280` and `transport.rs:210` both unsubscribe before
disconnecting, and both deliberately ignore the unsubscribe result. What I found is that the fix
landed on the *explicit* teardown path and not on the others.

**M-2 (fixed) — `ble_connect` drops a live transport without disconnecting.**
`app/src-tauri/src/ble.rs` assigned `*state.0.lock().await = Some(transport)` over whatever was
there. Neither backend implements `Drop` (confirmed: no `impl Drop` anywhere in
`app/transport-ble/src` or `app/src-tauri/src`), so the CCCD is never cleared and `disconnect()`
never runs — **the identical bug, reached by the implicit path**. It is reachable in ordinary use
because the frontend guard at `main.ts:800` prevents concurrent connects but not a Connect after
a drop the frontend never noticed (see R-4, which composes with this). Fixed by taking and
disconnecting the old transport first, tolerating its failure: it is gone either way, and
refusing a new connection because a corpse would not close cleanly is the wrong trade.

**M-3 (fixed) — `recv` leaves half-received state after a failure.** Both backends returned
`Err(Timeout)` with `self.reassembler` mid-frame and `self.decoder` holding a partial body
(`android.rs:254-272`, `transport.rs:164-189`). The transport is reused for the next request, so
the device's next first chunk arrives as seq 0, mismatches, and the caller is told about chunk
ordering rather than the timeout that actually happened. Worse, leftover decoder bytes get
prepended to the next frame and can decode into a boundary the device never sent — the one thing
`FrameDecoder`'s length check exists to prevent. Timeouts are the *common* case here, since a
full notification channel drops chunks by design (`android.rs:212`). Fixed on both backends by
splitting out `recv_inner` and resetting both on any error.

**L-1 (fixed) — body-less chunks.** The firmware refuses a chunk with a header and no payload
(`src/ble-chunk.c:54-60`) and so does the TypeScript reference
(`app/packages/core/src/framing.ts:161-165`); the Rust reassembler did not
(`app/transport-ble/src/wire.rs`). `more` chunks carrying no body advance `expected_seq` forever
without growing `parts`, so the `MAX_FRAME` cap never bites and `recv` stalls to the caller's
timeout. No memory growth, so a stall rather than a DoS — but `wire.rs` names the TypeScript file
as the reference these must match, and here they did not. Fixed, with a test covering both the
first-chunk and mid-frame cases.

**Correctly scoped, worth recording.** The TypeScript side is clean on this axis and I checked it
rather than assuming: `FrameDecoder` and `Session` are both fields of `Client`
(`app/src/main.ts:156-159`), and `client = new Client(transport)` runs per connect
(`main.ts:825`) with `client = null` on every failure path. `txCounter`/`rxCounter` are
initialised in the `Session` constructor (`session.ts:223, 226`) and there is no way to rebind
keys to an existing one, so counters reset per session by construction rather than by a call
someone could forget. `localStorage` holds chains, tokens and RPC preferences and nothing
session-derived. There is no resumption path to reuse a stale session even if one survived.

Smaller leaks, all recommended rather than changed: the passkey stays in the DOM after
`disconnect()` (`main.ts:3288` hides the panel without clearing the node, where `connect` clears
it at `:848`), and `disconnect()` does not call `invalidateDerived()`, so the previous device's
addresses are briefly still treated as "mine" for lookalike detection — bounded, because
`lastStatus = UNKNOWN_STATUS` at `:3276` forces invalidation on the next poll.

---

## 7. The open items, re-ranked

The first pass left four things open. They are not equally important now, and the order has
changed because the handshake fix changed what the rest of the system is protecting.

**1. `getStatus` answers anyone, over the radio, with no session and no interaction.**
`src/protocol.c:655-673` is reachable in plaintext with no `request_is_authenticated()` gate, and
the BLE characteristics carry no `BLE_GATT_CHR_F_*_ENC` flag (`src/ble.c:265, 270`) — no pairing,
no bonding, no filter list. So anyone in radio range who connects gets `walletCount`,
`activeWallet`, `account`, `unlocked`, and **`passphrase`**.

That last field is the one that has become the top open item. A BIP39 passphrase's entire purpose
is deniability: the point of a hidden wallet is that nobody can establish it exists. This device
announces it to a stranger on the pavement, without the owner touching anything and without any
trace on the device. Combined with M-4 from the first pass — a public static address and a
user-chosen name in the scan response make the device a stable, self-identifying beacon — it is
not merely a disclosure but a *targeting* oracle: this specific person, at this address, is
carrying a hardware wallet holding N seeds, currently unlocked, with a hidden wallet in use.

It was ranked L-3 last time and that was too low. It is remotely reachable, needs no interaction,
and it defeats a security property the product otherwise sells. The fix is a decision rather than
a patch — `getStatus` pre-session is what lets the app show something useful before pairing — but
the `passphrase` flag in particular does not need to be in the pre-session answer.

**2. Header bytes outside the AEAD.** Unchanged and still Low. `alen = 0` in both directions
(`src/session.c:335, 369` — the third argument to `rfc7539_finish` is the AAD length). A type-byte flip turns an encrypted request into a dropped one; a
length change fails closed. It is hardening, and it has to land on both ends in one change.

**3. No rate limit or record of a denied passkey comparison.** `src/ui.c:3372-3381`: DENY calls
`session_reset()` and writes one `ESP_LOGW`. Nothing is counted, nothing persists, nothing is
shown to the user next time.

I had this ranked higher until I checked whether the app auto-reconnects. It does not — there is
no retry path in `app/src/main.ts`; every attempt costs a deliberate human press. So a relay
grinding 1-in-10⁶ online is not the realistic threat, and I am not going to claim it is.

What is left is **observability**, and that is still worth something. Forty denials in a minute
is an attack in progress, and the device's entire response is a log line nobody is reading. A
persistent counter surfaced on the pairing screen ("3 refused since you last connected") costs
almost nothing and turns an invisible campaign into a visible one. Medium, on those grounds
rather than on brute-force arithmetic.

**4. No counter-overflow check.** Still the lowest of the four, and unreachable: 2^32 frames is
weeks of unbroken traffic. Both ends wrap silently (`src/session.c:311-318`,
`app/packages/core/src/session.ts:195-202`), so they at least wrap *together*. The reason it is
worth a two-line refusal anyway is D-2: `PROTOCOL.md` asserted a nonce-reuse abort that did not
exist, which is how an unreachable case becomes a case someone thinks is handled.

---

## 8. Fuzzing — and the surface it was not covering

### The gap

`sim/fuzz_transport.c` is a homegrown seeded-PRNG mutator, not libFuzzer (`:614-638`), so there
are no coverage or corpus statistics to report. Sanitizers are unconditional in the Makefile rule
(`sim/Makefile:296-298`): `-fsanitize=address,undefined -fno-omit-frame-pointer`.

**The new handshake was constructed by the fuzzer but never fuzzed.** `hello` and `helloReveal`
appear only inside `open_session()` (`:214-253`), which drives both legs with always-valid
messages to get a channel up for the session target — `hello_leg()` (`:172-209`) hardcodes a
well-formed three-key map with `version` always equal to `PROTOCOL_VERSION` (`:182-183`), a
32-byte `hostPubkey` from a real scalarmult (`:227`), and a correctly sized `hostNonce` (`:239`).
It is a fixture, not a target.

`build_corpus()` seeded `getStatus`, `getAddress`, `signTransaction`, `signMessage`,
`signTypedData` and `setPassphrase` — **no handshake entry**. `mutate()` only ever starts from a
corpus entry or from pure random bytes, so the mutator had no handshake to walk away from. The
one indirect route is `fuzz_frames()`, which emits plaintext type `0x01` frames one time in eight
(`:456`) — but reaching `handle_hello` requires the mutated CBOR to spell the text key `"method"`
with the value `"hello"`, and random bytes do not produce `"helloReveal"`.

So the parsing surface the first pass never saw — a `version` of any CBOR width, a `hostPubkey`
or `hostNonce` of any type or length, and the commit/reveal state machine behind them — was
reachable by an attacker and by nothing in this file. It was covered by hand-written cases in
`sim/test_protocol.c` and by nothing that mutates.

**Closed** (`sim/fuzz_transport.c`): two `add_corpus()` entries for `hello` and `helloReveal`, and
`"hostNonce"`, `"version"`, `"deviceCommit"` added to the `fuzz_cbor` key list. `CORPUS_MAX`
raised from 8 to 10 to fit. Test-only, and it is what makes the numbers below mean something they
did not mean before.

### Results, with the handshake in the corpus

Six seeds × 1 000 000 iterations per target (so 2 000 000 for cbor and chunk, 1 000 001 for
frames, 500 001 for session, 125 001 for usb, per the divisors at `:628-632`):

```
seed 1          no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
seed 2          no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
seed 3          no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
seed 7          no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
seed 31337      no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
seed 20260828   no crashes, no invariant violations  | ASan hits: 0  UBSan reports: 32 (non-chacha: 0)
```

Exit code 0. **No ASan finding, no leak, no heap or stack overflow, no invariant violation, and
nothing in the handshake handlers.**

The 32 UBSan reports are all one known thing, all in vendored code:

```
../components/trezor-crypto/chacha20poly1305/chacha_merged.c:145:10: runtime error: load of
misaligned address 0x5b8294fa47a5 for type 'u32', which requires 4 byte alignment
```

— repeating across `:145-160` (loads) and `:168-183` (stores), and documented as expected in
`sim/Makefile:238-239`: `protocol.c` decrypts in place at `rx_buf + 5`, so the ciphertext is never 4-byte
aligned. It is real undefined behaviour by the letter of the standard and benign on both x86 and
the ESP32-S3's RISC-V core, which permit unaligned word access. Not mine to fix — it is
trezor-crypto — but worth recording that the count is stable at 32 and that **every one of them
is in that file**, so a new UBSan report from this fuzzer is signal rather than noise.

---

## 9. What I changed

Every change is either a refusal that did not exist or a document corrected to match the code.
Nothing here alters the protocol, adds a message, or changes a derivation.

| File | Change |
|---|---|
| `src/protocol.c` | `handle_hello_reveal` defers on `ui_user_is_answering()`, before consuming the commitment (**M-1**) |
| `src/protocol.c` | `approval_still_holds()`, called after approval in all three signing paths (**H-1**) |
| `sim/test_protocol.c` | Two tests: the M-1 bypass, and the approval/signature address mismatch |
| `sim/fuzz_transport.c` | `hello`/`helloReveal` corpus entries and three handshake keys (**F-1**) |
| `app/src-tauri/src/ble.rs` | `ble_connect` disconnects the previous transport before replacing it (**M-2**) |
| `app/transport-ble/src/android.rs` | `recv` resets reassembler and decoder on any failure (**M-3**) |
| `app/transport-ble/src/transport.rs` | Same, desktop backend (**M-3**) |
| `app/transport-ble/src/wire.rs` | Body-less chunks refused, matching firmware and TypeScript; one test (**L-1**) |
| `docs/PROTOCOL.md` §2 | Frame-type table corrected: `0x7E` added, `0x13 Event` removed, "pre-session only" removed (**D-1**) |
| `docs/PROTOCOL.md` §3 | Nonce-reuse-abort claim replaced with what the code does (**D-2**); both handshake legs described as gated; the unguarded import path named |
| `docs/PROTOCOL.md` §5 | The post-approval re-derivation (**H-1**) |
| `docs/PROTOCOL.md` §6 | `0x0400`'s description no longer promises nonce-reuse detection |
| `docs/PROTOCOL.md` §7 | The version and the messages are outside the transcript (**D-3**) |

The two device-side fixes are both fail-closed: each can only refuse something that previously
succeeded, and neither has a branch that permits anything new.

---

## 10. Recommended, not changed

These are real, and each is either a judgement about behaviour or a change wider than an audit
should make on its own.

**R-1 — `attach`'s error paths orphan a BLE link.** `app/transport-ble/src/android.rs:171-214`
and `transport.rs:97-124`: six paths return `Err` after `connect()` has succeeded, none of them
disconnecting. The frontend cannot clean up either, because `ble_connect` failed before the
`Connection` state was set, so a later `ble_disconnect` is a no-op. Since the device serves one
peer at a time, this locks out reconnection until the stack times out — and it is reachable by a
hostile peer that advertises `SERVICE_UUID` and then omits a characteristic. This is the
highest-value item on this list. Left alone because the right shape is a guard object or a
`Drop`, not six copies of a cleanup call, and choosing between those is a design decision.

**R-2 — one frame bound, three numbers.** `app/transport-ble/src/wire.rs:20` and
`app/packages/core/src/framing.ts:16` both say 4096; `src/protocol.h:35` says 1024, and
`BLE_CHUNK_MAX_FRAME` correctly derives from it. So the host buffers up to 4× — and up to 8× in
the decoder, which caps at `MAX_FRAME * 2` — of a hostile peer's bytes for frames the real device
can never send, and will happily encode a 4093-byte payload the device refuses. `ble-chunk.h:32`
records that this constant has drifted before. All three should derive from one number, which
means deciding where that number lives.

**R-3 — Android trusts a peer-reported MTU upward.** `android.rs:221` clamps only from below
(`.max(MIN_MTU)`). A peer reporting an inflated MTU gets the host to write oversized chunks that
the controller truncates silently, which arrives as a corrupt frame rather than an error. Desktop
is immune by being pessimistic (`transport.rs:138` hardcodes `MIN_MTU`). A clamp to 247 would
close it; verifying it does not break real Android links needs a phone.

**R-4 — an unsolicited disconnect is invisible.** Nothing subscribes to link-down: `poll()`
swallows every error (`app/src/main.ts:658`) and Android explicitly passes
`OnDisconnectHandler::None` (`android.rs:164`). The UI keeps claiming an encrypted channel to a
device that is gone, with derived addresses still on screen. It composes with M-2 above — that is
how the user ends up pressing Connect on a link the host still holds.

**R-5 — no reflection check on the host.** `app/src/main.ts:339` accepts a `devicePubkey` equal
to `hostPubkey`. Not exploitable (§1), but a two-line guard makes the property local instead of
emergent.

**R-6 — `SCREEN_MNEMONIC_ENTRY` is not in `ui_user_is_answering()`.** §4. A peer can clear a
half-typed recovery phrase on the import path. Adding it is one line; deciding which
interruptions matter is not mine to decide.

**R-7 — no timeout on `SESSION_AWAITING_REVEAL`.** A half-open handshake sits there indefinitely,
holding an ephemeral private key in RAM until the next `session_reset()`. With M-1 fixed it is no
longer a way to time an interruption, so this is now hygiene rather than a finding — but a
handshake that has not completed in thirty seconds is not one that is going to.

**R-8 — the passkey persists in the DOM and in the log after disconnect.** `main.ts:3288` hides
the pairing panel without clearing the node; `connect` clears it at `:848` but `disconnect` does
not. The log line at `:876` also keeps it indefinitely, and the log is meant to be pasted into
bug reports.

**R-9 — the three open items from §7 that remain open**, in the order given there.

---

## 11. What needs hardware

Everything above is either static analysis or a host-side test. These cannot be settled here:

1. **R-3, the Android MTU clamp.** Needs a phone and a real negotiation. The desktop path cannot
   exercise it at all, since it never reads a peer-reported MTU.
2. **R-1's practical impact.** How long a BlueZ or Android stack holds an orphaned link before
   timing out decides whether this is an annoyance or a lockout. Reproduce with a peripheral that
   advertises the service UUID and omits `CHAR_NOTIFY_UUID`.
3. **The two device-side fixes, on the device.** Both are covered by the host suite, but M-1's
   deferral involves the real UI task and H-1's involves a real BLE disconnect landing on NimBLE's
   host task while the protocol worker is blocked. The host suite models both; only hardware
   proves the tasks interleave the way the model assumes. H-1 specifically: pair, apply a host
   passphrase, start a `signTransaction`, kill the BLE link while the approval is on screen, then
   press ALLOW. The expected result is `0x0200` and no signature.
4. **M-2's fix under BlueZ.** The original bug was found in live testing, not in a test suite, and
   the implicit path deserves the same treatment: connect, drop the link without disconnecting,
   press Connect again, and confirm notifications arrive.
5. **The `getStatus` disclosure as an actual radio observation.** §7 argues from the code; a scan
   from a phone in a public place is what would make the case.

