# Transport audit — the device↔companion link

Scope: the USB and BLE links between the ESP32-S3 and the companion app, on
desktop and Android. The session handshake, the record layer, the framing, the
CBOR parser, and the two radios' own properties. Not in scope: the vault, the
PIN, the RNG, and anything above the command dispatcher.

Everything below is either quoted from the source with a line reference, or
produced by a program in `sim/` that anyone can re-run. Where a claim could not
be checked without hardware it says so rather than guessing.

---

## 1. The handshake as it really is

Not as `docs/PROTOCOL.md` §3 describes it. The document's sequence diagram shows
a `Confirm {passkey}` message travelling from host to device and a `sessionId`
coming back; neither exists in the firmware or the client. What actually runs:

```
host                                                device
 ── 0x01 Request { method:"hello", hostPubkey:32B } ────▶
                                     session_begin(): fresh X25519 keypair
 ◀── 0x02 Response { result:{ devicePubkey:32B, version:1 } }
      both: X25519 → HKDF-SHA256(salt=0^32, info=label) → k_h2d, k_d2h, passkey
 ◀── OLED shows six digits; app shows its own six digits
 ── user presses ALLOW on the device ──▶  session_confirm(): PENDING → ACTIVE
 ── 0x11 encrypted traffic ────────────▶
```

- `src/protocol.c:1237` dispatches `hello`; `src/protocol.c:292` is the handler.
- `src/session.c:135` `session_begin`, `src/session.c:82` `session_derive`.
- `app/src/main.ts:312` `handshake()`, `app/src/main.ts:333` `waitForApproval()`.
- `src/ui.c:3320` is the button press that promotes PENDING to ACTIVE.

The host never sees a confirmation message. `waitForApproval` polls an encrypted
`getStatus` every 750 ms until one succeeds (`app/src/main.ts:349`); the first
encrypted call to be answered *is* the confirmation.

### What kind of agreement is this

**Unauthenticated ephemeral Diffie-Hellman plus a human comparison.** There is
no long-term device key, no certificate, no attestation, and nothing signed.
Both sides generate a fresh X25519 keypair per connection (`src/session.c:143`,
`app/packages/core/src/session.ts:73`), and the only thing standing between the
raw exchange and an impostor is the six digits.

### What the passkey binds

The shared secret, and nothing else:

```c
hkdf_sha256(shared, sizeof(shared), LABEL_PASSKEY, pk);   /* session.c:108 */
n = pk[0..3] as big-endian u32;  n %= 1000000;
```

Not the transcript, not the two public keys as an ordered pair, not a nonce
from either side, and not any commitment. It is a pure function of the X25519
output. That is the single most important fact in this document, and §4 below
is what follows from it.

### Replay, reordering, and the counters

Per-direction keys and per-direction counters, both monotonic, neither ever
reset inside a session:

- `k_h2d` and `k_d2h` come from distinct HKDF labels (`src/session.c:46-48`),
  so the two directions never share a keystream.
- Nonce is `0x00 * 8 ‖ counter:u32` big-endian at bytes 8..11
  (`src/session.c:203`, mirrored at `app/packages/core/src/session.ts:79`).
- The device advances `rx_counter` only on a successful tag check
  (`src/session.c:245`) and `tx_counter` on every seal (`src/session.c:264`).
- A replayed frame decrypts under the *next* counter, so its tag fails, and a
  failed tag calls `session_reset()` (`src/session.c:241`) — the session dies
  rather than the frame being skipped. Reordering is the same event.
- Nothing survives a connection: BLE connect and disconnect both call
  `session_reset()` (`src/ble.c:353`, `src/ble.c:371`), and so does a transport
  switch (`src/transport.c:62`). Keys are ephemeral per connection, so a frame
  captured in one session cannot decrypt or authenticate in any later one.

Counters are `uint32_t`. At one frame per millisecond a wrap needs seven weeks
of unbroken session, so overflow is not reachable; it is also not *checked*,
which is worth a line of code someday (§7).

### Downgrade

- **Forcing plaintext:** a plaintext frame is always accepted and dispatched
  (`src/protocol.c:1228`), but nine of the twelve methods call
  `request_is_authenticated()` first (`src/protocol.c:284`), and that asks
  whether *this frame* arrived encrypted rather than whether a session exists.
  So an attacker who strips encryption gets `ping`, `getFeatures`, `getStatus`
  and `hello` and nothing else. No signing, no addresses, no passphrase.
- **Forcing a re-handshake mid-session: yes, and it is unauthenticated.** A
  plaintext `hello` is honoured at any time. `session_begin()` calls
  `session_reset()` on its first line (`src/session.c:138`), so anyone who can
  write to the live transport destroys an established session at will and puts
  a "Connect?" screen in front of the user — including on top of a signing
  approval screen (`src/ui.c:4847`). See M-2.
- The concurrent-handshake bug the brief mentions is fixed and stays fixed:
  the device keeps exactly one session, a second `hello` replaces the first
  outright, and the UI repaints so the user compares the *new* digits
  (`src/ui.c:4850-4856`). Two hosts cannot end up on different keys because
  the device only ever holds one.
- **Version negotiation does not exist.** `PROTOCOL.md` §7 says "Hello carries a
  major version. Mismatch is a hard failure." The `hello` request carries only
  `hostPubkey` (`app/src/main.ts:314`); the `version:1` in the reply
  (`src/protocol.c:317`) is never read by the client. Nothing to downgrade
  today, because there is only one version — but the protection the document
  claims is not implemented.

---

## 2. The record layer as it really is

| | |
|---|---|
| Cipher | ChaCha20-Poly1305, RFC 7539 (`src/session.c:223`, `@noble/ciphers` on the host) |
| KDF | HKDF-SHA256, salt = 32 zero bytes, one 32-byte block, `info` = the label (`src/session.c:55`) |
| Keys | `k_h2d`, `k_d2h`, `passkey` — three independent labels over one secret |
| Nonce | 8 zero bytes ‖ u32 counter, per direction |
| AAD | **none** — `rfc7539_finish(&ctx, 0, body, tag)`, `alen = 0` |
| Tag check | constant time (`src/session.c:234-240`) |
| Degenerate key | all-zero shared secret refused on both sides (`src/session.c:97`, `session.ts:57`) |

### Can a nonce repeat under one key?

On the device, no. `tx_counter` advances on every `session_encrypt` with no
path that skips it, and it is only ever reset by `session_reset()`, which also
throws the key away (`memzero(&sess, ...)`, `src/session.c:182`).

On the host, **it could**, and this was the one finding in the record layer.
The host deliberately holds its send counter back until a reply arrives
(`app/packages/core/src/session.ts:154`, and the comment above it), so that a
request rejected while the user has not yet pressed ALLOW can be retried
without drifting. Retrying the *same* bytes is safe. Sealing a *different*
message at the same counter is a total break — the keystreams XOR to the
plaintexts and the Poly1305 key falls out.

Nothing in `Session` enforced the difference. The shipping app happens not to
trigger it (calls are serialised through `Client.queue`, `app/src/main.ts:255`,
and the 2-second status poll is not started until after the connect flow
finishes, `app/src/main.ts:914`), but that is a property of today's caller,
invisible to anyone else importing `@leekwallet/core`, and one UI change away
from being false. Fixed — see §6.

### Does integrity cover the header?

**No.** The two-byte length and the one-byte frame type sit outside the AEAD.
Consequences, worked through rather than assumed:

- Changing the length changes how many bytes are fed to Poly1305, so the tag
  fails and the session is torn down. Fail-closed, and an attacker who can flip
  those bits can cut the wire anyway.
- Flipping `0x11` to `0x01` turns an encrypted request into a plaintext one.
  The device then CBOR-parses ciphertext, fails, and answers a plaintext
  `0x0001 malformed` — no counter moves on either side, so the session survives
  and the request is silently lost. That is an attacker-triggerable request
  drop that does not look like tampering. Low severity (the host times out and
  the user retries), but it is the one thing an AAD over the header would make
  impossible. See L-1.

### The "a reply can never inherit the previous frame's encryption" claim

Verified. `protocol_handle_frame()` clears `reply_encrypted = false` as its
first statement (`src/protocol.c:1207`), sets it only between a successful
`session_decrypt()` and the end of that frame's `dispatch()`
(`src/protocol.c:1257-1259`), and clears it again immediately after. Every send
path consults it: `send_error_ex` at `src/protocol.c:222` and the response path
at `src/protocol.c:1146`. There is no `goto`, no early return between the set
and the clear, and no other writer of the flag in the file. The stronger
property the code actually has is the useful one: an encrypted reply is
produced *only* for a request that decrypted, so the two sides' counters cannot
be walked apart by an attacker sending plaintext into a live session.

---

## 3. Threat model per transport

### Passive sniffer (radio, or a logic analyser on the cable)

Gets: that a LeekWallet exists, its BLE address and advertised name, the
service UUID `6c65656b-…-01`, the timing and length of every frame, and the
plaintext handshake including both public keys. Frame lengths are not padded,
so request *sizes* distinguish `getStatus` from `signTypedData` and leak
roughly how large a typed-data document is.

Does not get: any payload of an established session. Keys are ephemeral, so
recording today and compromising the device tomorrow yields nothing (forward
secrecy holds — there is no long-term key to compromise).

### Malicious host process (dialout on `/dev/ttyACM0`, or another app on the phone)

This is the case USB users should actually think about, and the honest answer
is that the port is **not** an access-control boundary. Any process in the
`dialout` group can open the same character device concurrently with the real
app. What it gets:

- **Read `ping`, `getFeatures`, `getStatus` with no session and no user
  action.** `getStatus` reports the active wallet index, the account the
  device's screens are on, whether a passphrase is applied, whether the device
  is unlocked, and how many wallets exist (`src/protocol.c:511-529`). That is a
  fingerprint of the owner's setup, readable by any local process, and it is
  deliberate — `sim/test_protocol.c` has a test named "status is public but
  thin". It should be a documented decision, not an accident, and today
  `PROTOCOL.md` §4 lists `getStatus` as tier "always" without saying what it
  discloses.
- **Destroy the real app's session at will** by writing one plaintext `hello`
  (M-2), and put a Connect? prompt on the device's screen.
- **Race for the reply.** Two readers on one tty split the byte stream, so a
  hostile process can steal frames the real app then never sees. The frames are
  ciphertext, so this is denial of service, not disclosure.
- **Console text.** The port carries `ESP_LOG` output. Nothing secret is logged
  — checked across `src/*.c`; the closest is `pin.c` reporting the remaining
  attempt count — but lock state and PIN-attempt count do leak.

What it does **not** get: any signing, any address, any passphrase operation.
All of those require a frame that decrypts under a session the user approved by
pressing a button while looking at six digits. **The app-layer session, not the
device node's permissions, is what protects the user.** That is the right
design and it holds.

Transport exclusivity was checked directly: `transport_apply()`
(`src/transport.c:60`) resets the session, detaches the writer, and then, for
the BLE branch, turns the USB endpoint off *before* starting the radio, and for
the USB branch stops the radio *before* turning the endpoint on. There is no
ordering in that function where both are reachable, not even transiently. The
boot default is off rather than on (`src/protocol.c:91`), which closes the
window a previous crash was reached through, and `sim/test_protocol.c` asserts
it before any fixture runs.

### Active MITM between host and device

**This is the finding.** See §4.

### Malicious BLE peer

There is **no link-layer pairing and no bonding**. `ble_hs_cfg.sm_*` is never
configured, no characteristic carries an encryption or authentication
permission (`src/ble.c:248-268`: `BLE_GATT_CHR_F_WRITE | WRITE_NO_RSP` and
`F_NOTIFY`, no `_ENC` or `_AUTHEN` flags), and `sdkconfig.defaults` sets no
security-manager options.

Is that right? **Yes, on the merits, and it should be written down as a
decision rather than left as an absence.** BLE Secure Connections would add a
second, weaker numeric comparison over the same physical user, its Just Works
fallback is negotiable by the peer, and bonding would let a paired phone
reconnect silently — which is exactly what the per-connection passkey exists to
prevent. Doing key agreement at the application layer means the same code and
the same user gesture protect USB and BLE identically, which is why
`sim/test_protocol.c` can run every conformance case down both channels. The
weakness in the app-layer session (§4) is not fixed by adding link-layer
pairing underneath it; it is fixed in §4's terms.

What a malicious central gets today:

- **Connect freely.** Advertising is undirected and open (`src/ble.c:328`),
  there is no whitelist, and no filter accept list. Any central in range can
  connect the moment the device is advertising.
- **Kill the session and drop queued work.** Connect and disconnect both call
  `session_reset()` and `ble_drop_queued_requests()`. Since NimBLE stops
  advertising once connected and `ble_advertise()` is only re-armed in the
  disconnect handler, two centrals cannot be connected at once — but an
  attacker who wins the reconnect race after every disconnect keeps the owner's
  phone out indefinitely. That is a clean, unauthenticated denial of service
  against a device left on BLE. Unverified on hardware; read from the code path
  and from NimBLE's documented advertising lifecycle.
- **Nothing above the session.** Same nine gated methods as USB.
- **Metadata.** The service UUID is in the advertisement and the name is in the
  scan response (`src/ble.c:299-318`). The device address comes from
  `ble_hs_id_infer_auto` with no privacy configuration, so it is a **stable
  identifier** — a wallet left on BLE is trackable across time and place by
  anyone with a scanner, and the UUID says what kind of device it is. The
  document already argues (§3b, point 3) that "a wallet that does not advertise
  announces nothing"; the corollary — that one which does advertise announces
  quite a lot — is not stated. See M-4.

Reassembly (`src/ble-chunk.c`) stood up to everything thrown at it: see §5.

---

## 4. C-1 — the passkey does not stop a machine-in-the-middle

**Severity: critical (defeats the only defence the protocol claims against an
active MITM). Confirmed by execution, not by argument.**

`PROTOCOL.md` §1 states:

> | Active MITM between host and device | Passkey-confirmed key exchange (§3) | **Yes** |

and §3 calls it "the standard numeric-comparison pattern". It is not the
standard pattern, and the answer in that table is no.

In BLE Secure Connections numeric comparison, and in ZRTP's short
authentication string, each side contributes a **random nonce** and the
initiator is **committed** to its value before the responder reveals theirs.
That commitment is the entire point: it stops the man in the middle from
searching for a value it likes, and reduces it to one online guess with a
1-in-10^6 chance and an observable failure.

Here there is no nonce and no commitment. The passkey is
`HKDF(X25519(a, B), "leek-session-passkey-v1")[0..3] mod 10^6` — a deterministic
function of a secret the relay computes for itself, using a private key it is
free to choose. So the relay does not guess. It **searches**:

1. It relays the host's `hello` to the device using its own key `a`, and reads
   `devicePubkey` from the reply. The device's OLED now shows a fixed
   six-digit value the relay can compute.
2. Offline, with no packets on the wire and no user involvement, it tries
   candidate private keys `b` against the *host's* public key until
   `passkey(b, HostPub)` equals the digits the device is displaying.
3. It sends that `b`'s public key to the host as the device's. Both screens
   now show the same six digits. The user compares them, they match, and the
   user presses ALLOW.

The relay then holds both sessions, reads and rewrites every request and
response, and there is no second check anywhere: the on-device confirmation
screens render from the device's own parsed state, but the relay chose what
that state is asked to be.

Measured, on one core of the audit machine, using the firmware's own
`session_derive` and trezor-crypto's 32-bit reference X25519 — the slowest
implementation an attacker would ever use:

```
$ make -C sim build/passkey_grind && ./sim/build/passkey_grind --search
the device will display 579252
425364 derivations in 91.32 s — 4658/s
FOUND after 425364 tries: the host would display 579252 too
both screens agree; the user sees nothing wrong
```

**91 seconds.** A real attacker uses a 64-bit optimised X25519 (an order of
magnitude faster per core) across every core it has, which puts the expected
10^6 derivations in the low single-digit seconds. There is no rate limit to
hit, because the search never touches the device: nothing is sent, nothing
fails, and there is no failed comparison for anyone to notice. The user sees
one connection attempt that works.

The related questions from the brief, answered against the code:

- **Is the MITM forced to commit before seeing the passkey?** Only on the
  device-facing leg, and that costs it nothing: it grinds the *host*-facing leg
  afterwards, which is the leg the user reads from a screen the relay can also
  compute. If it were willing to open repeated handshakes with the device as
  well, a birthday search brings the total to roughly 2×10^3 operations, but it
  does not need to.
- **Is there a retry limit?** No. `hello` is unauthenticated, unlimited, and
  ungated; `handle_hello` (`src/protocol.c:292`) has no counter, no delay and
  no lockout.
- **What happens on a failed comparison?** The user presses DENY,
  `session_reset()` runs (`src/ui.c:3326`), and *nothing else*. No attempt is
  recorded, no backoff is applied, and the next `hello` gets a fresh screen
  immediately. So even the online 1-in-10^6 guess is retryable at will, on top
  of the offline search that makes retrying unnecessary.

This needs a protocol change and therefore a human decision (§7). It is not
something to patch on judgement inside an audit.

---

## 5. Parser robustness, fuzzing and ASan

A fuzzer did not exist; `sim/fuzz_transport.c` is new. It is ASan+UBSan-built
by `make -C sim fuzz`, takes a seed and an iteration count, prints the seed so
any hit reproduces, and drives five targets:

| Target | What it feeds |
|---|---|
| `cbor` | mutated and random buffers into `cbor_map_find`, `cbor_skip`, `cbor_text_copy`, including a one-byte destination |
| `chunk` | random chunk sequences into `ble_chunk_push`, with the reassembler's invariants asserted after every call, and every completed frame handed to `protocol_handle_frame` the way `ble.c` does |
| `usb` | arbitrary byte streams with sync markers sprinkled in, split across random read boundaries, through the real `consume()` |
| `frame` | structured frames whose declared length is deliberately a lie: 0, 0xFFFF, one over, one under, random |
| `session` | mutated CBOR sealed under a *confirmed* session — the only path that reaches `dispatch()`, `eth-decode` and `eip712` with bytes the peer chose |

The corpus is built with the real CBOR writer from six valid requests
(`getStatus`, `getAddress`, `signTransaction`, `signMessage`, `signTypedData`
with nested maps in arrays in maps, `setPassphrase`) and mutated by bit flips,
CBOR-head substitution, truncation, extension, splicing and stretching to the
frame bound.

Results:

```
$ make -C sim fuzz FUZZ_SEED=1 FUZZ_ITERS=60000     # and seeds 2, 3, 12345, 987654321
transport fuzzer: seed 1, 60000 iterations per target
== cbor reader
== ble reassembly
== usb byte stream
== frame decoder
== inside a session

no crashes, no invariant violations
```

Roughly 1.2 million iterations across five seeds. **No ASan finding, no UBSan
finding, no invariant violation, no hang.** The only UBSan output is the
already-documented misaligned `u32` store inside trezor-crypto's
`chacha_merged.c`, which the Makefile calls out by name and which is benign on
both hosts this builds for. The existing `make -C sim asan` target is also
green.

Reading the parsers alongside that:

- **Length arithmetic.** `consume()` bounds the declared body at
  `MAX_FRAME - 4` before buffering anything (`src/protocol.c:1285`), and
  `protocol_handle_frame` re-derives and re-checks `body + 2 != len`
  (`src/protocol.c:1216`) rather than trusting the transport that found the
  boundary. The 1024-accepted / 1025-dropped behaviour from hardware testing is
  exactly what those two bounds produce.
- **CBOR.** Indefinite lengths, 64-bit arguments, reserved additional-info
  values, tags and major type 7 are all refused rather than interpreted
  (`src/cbor.c:164`, `src/cbor.c:204`). `cbor_read` refuses a string longer
  than the remaining buffer before advancing (`src/cbor.c:193`). Recursion is
  bounded at depth 8 (`src/cbor.c:18`), and `cbor_skip` counts from itself,
  which the EIP-712 walker is aware of and compensates for.
- One latent overflow in `cbor_text_copy`: `item->value + 1 > out_size`
  computes in `uint32_t`, and `value == 0xFFFFFFFF` wraps to zero and turns the
  bound into a permission. Unreachable — nothing can produce a text item that
  long — so this is arithmetic being made incapable of the mistake, not a bug.
  Changed; see §6.
- **BLE reassembly.** `ble_chunk_push` refuses an out-of-sequence chunk, a
  header-only chunk, a chunk that would overrun the buffer, a declared total
  outside `[4, sizeof(buf)]`, a last chunk that does not land exactly on the
  declared end, and a completed frame shorter than a header — and every one of
  those refusals resets, so a peer cannot leave a prefix behind for the next
  one to be appended to. The fuzzer asserted that reset property on every
  rejection and never saw it violated. It cannot be wedged: `complete` is
  cleared by the next push, so no state is permanent.

---

## 6. What was changed

Three defects, all unambiguous and low-risk. Everything else in this document
is a report, not a patch.

1. **`app/packages/core/src/session.ts` — refuse to seal two different
   messages under a held nonce.** The host's deferred counter is safe for an
   identical retry and catastrophic for anything else; the rule now lives with
   the nonce instead of depending on the caller. Identical retries still return
   identical bytes, which the retry loop relies on. Test: "a held nonce may not
   seal two different messages".
2. **`app/packages/core/src/framing.ts` — bound `ChunkReassembler`.** It had no
   cap on total reassembled size and accepted body-less chunks, so a peer
   holding `more` set forever grew the buffer without limit — without needing
   to send any payload at all. Now capped at `MAX_FRAME_BYTES` and refusing an
   empty body, matching the firmware, which was already the stricter of the
   two. The Rust BLE transport was already bounded; this class is exported
   from `@leekwallet/core` and used by the tests, so the hole was in library
   code rather than on today's live path. Test: "a hostile peer cannot grow the
   reassembler without end".
3. **`src/cbor.c` — overflow-proof the `cbor_text_copy` bound**, as above. Same
   semantics on every reachable input.

New, not a fix: `sim/fuzz_transport.c` and the `fuzz` target;
`sim/passkey_grind.c` and its target, which is the measurement behind C-1 and
is deliberately outside `make test` because it measures rather than asserts.

`./scripts/check.sh` passes.

---

## 7. Findings, and what needs a human

### Critical

**C-1 — the six-digit passkey is chosen by the attacker, not guessed.**
§4. `PROTOCOL.md` §1 claims an active MITM is defended against and §3 claims
this is the standard numeric-comparison pattern; both are false as written, and
a 91-second single-core search is the evidence. **Human decision required** —
this is a protocol change and the options trade off against each other:

- *Bind the transcript.* Derive the passkey over both public keys in a fixed
  order (and ideally the frames as sent) rather than over the raw shared
  secret. Cheap, and it removes the relay's freedom to search only one leg —
  but on its own it still leaves a 10^6 offline search over its own keypair.
- *Add a commitment, which is what the standard pattern actually is.* Device
  sends `H(devicePubkey ‖ device_nonce)` first, host reveals its nonce, device
  then reveals; the passkey is derived from both nonces and both keys. This is
  what reduces the relay to one online 1-in-10^6 guess. It costs one extra
  round trip and a real change on both sides.
- *Rate-limit and record failures*, whichever of the above is chosen, so that
  the online guess is not free and a DENY is remembered.
- *Widen the code.* Independent of the above and much weaker on its own: eight
  digits is 26 bits, which multiplies the search by 100 and does not change its
  nature.

Until something changes, `PROTOCOL.md` §1's table should say **No**, and the
app should not describe the passkey comparison as protection against a relay.
That documentation correction is itself a decision for the owner, which is why
it is listed here rather than applied.

### Medium

**M-2 — an unauthenticated `hello` destroys a live session.** Anyone who can
write to the selected transport — any local process on USB, the connected
central on BLE — resets an established session at any moment
(`src/session.c:138` via `src/protocol.c:1237`) and interrupts whatever is on
the device's screen, including a pending signing approval (`src/ui.c:4847`).
Recommended, not changed: refuse or defer `hello` while a session is ACTIVE and
while a confirmation is pending, or require the user to dismiss the current
session first. It changes reconnect behaviour, so it is the owner's call.

**M-3 — BLE frames cap at 512 bytes while USB caps at 1024, so `signTypedData`
is transport-dependent.** `BLE_CHUNK_MAX_FRAME` is 512 (`src/ble-chunk.h:29`)
and its comment says "Matches MAX_FRAME in protocol.c", which was true before
`PROTOCOL_MAX_FRAME` was raised to 1024 (`src/protocol.h:35`).
`PROTOCOL.md` §2 says "the device's own buffer is 1024 bytes and it refuses
anything larger" — not true over the radio. Measured:

```
PROTOCOL_MAX_FRAME=1024 BLE_CHUNK_MAX_FRAME=512
largest frame BLE reassembles: 512 bytes; 516 refused
```

`sim/test_eip712.c` reports a Permit2 `PermitSingle` request at 569 bytes of
CBOR, which is 588 on the wire once the type byte, the length and the
Poly1305 tag are added. **A Permit2 signature that works on the cable is
impossible over Bluetooth**, and the raised limit exists precisely for that
request. Not changed, because the fix is not free: raising the constant grows
a static `BleReassembler` by 512 bytes and, more importantly, grows the
`out[]` buffer in `ble_chunk_split` on the caller's stack, and the BLE worker
task has already overflowed once in this codebase's history. The right change
is to raise `BLE_CHUNK_MAX_FRAME` to `PROTOCOL_MAX_FRAME` *and* give
`on_rx_write`'s single-write staging buffer its own smaller constant, which
wants a hardware check. Owner's call.

**M-4 — a device left on BLE is a stable, self-identifying beacon.** Public
static address, no privacy/RPA configuration (`src/ble.c:392`), a service UUID
that names the product, and a user-chosen name in the scan response. Anyone in
range can track it and knows it is a hardware wallet. This is a real trade
against usability and the document already reasons in this direction for
§3b; it should be stated in `PROTOCOL.md` under the T56 section, and
resolvable private addresses considered.

**M-5 — an unauthenticated central can hold the radio.** No pairing means no
filter accept list, and advertising is only re-armed on disconnect, so an
attacker who wins the reconnect race keeps the owner out. Unverified on
hardware. Any fix here is a usability trade (a connection the user must accept
on the device before the peer can write, say), so it is a decision rather than
a patch.

### Low / informational

**L-1 — the frame header is outside the AEAD.** `alen = 0` at
`src/session.c:227` and `src/session.c:261`. A type-byte flip turns an
encrypted request into a silently dropped one; a length change fails closed.
Authenticating the three header bytes as AAD costs one `rfc7539_auth()` call
per frame on each side and would have to land on both at once.

**L-2 — `PROTOCOL.md` §3's handshake diagram describes a protocol that does not
exist**: a `Confirm {passkey}` message, a `sessionId`, a `deviceId`, and a
`version` in `hello`. None are implemented. §7's version-mismatch protection is
likewise aspirational. The frame-type table omits `0x7E`, which the firmware
sends, and lists `0x13 Event`, which it does not. Documentation, so it is the
owner's to correct alongside C-1.

**L-3 — `getStatus` is readable by any local process or any BLE peer**, and
discloses the active wallet index, the current account, passphrase state, lock
state and wallet count. Deliberate and tested for; undocumented as a
disclosure.

**L-4 — no counter-overflow check.** `session_encrypt` will happily wrap
`tx_counter` past `0xFFFFFFFF` and reuse nonce 0 under the same key. Not
reachable (weeks of unbroken session), and a two-line refusal would make it
unreachable by construction rather than by arithmetic.

**L-5 — the Rust host reassembler accepts body-less chunks**
(`app/transport-ble/src/wire.rs:135`), so a hostile peripheral can stall a
frame indefinitely with zero-payload writes. Bounded by the caller's timeout
and it cannot grow memory, unlike the TypeScript case fixed in §6. The firmware
refuses these; the Rust side could match it in one line.

### Verified sound, worth recording

- Transport exclusivity, including the boot default and the ordering inside
  `transport_apply()`.
- The reply-encryption rule in `protocol_handle_frame()`, and the stronger
  property it actually enforces.
- Directional key separation, per-direction monotonic counters, ephemeral keys,
  session teardown on every one of the four paths that ends a session.
- Constant-time tag comparison and fail-closed teardown on a bad tag.
- Small-order peer key rejection on both sides.
- The nine authentication gates on `dispatch()`, and that they test *this
  frame* rather than the session's existence.
- Frame and CBOR parsing against 1.2M fuzz iterations under ASan and UBSan.
