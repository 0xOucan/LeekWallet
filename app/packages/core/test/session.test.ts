/**
 * Host session tests, and the cross-implementation check that matters.
 *
 * The firmware derives the same keys and the same passkey from the same
 * exchange, or the two cannot talk. `sim/test_session.c` asserts the C side;
 * this asserts the TypeScript side against vectors produced by that C code.
 */

import {
  commitment, deriveSession, generateKeypair, generateNonce, verifyCommitment,
  NONCE_BYTES, Session, type SessionTranscript,
} from "../src/session.ts";

let failures = 0;
const check = (c: boolean, m: string) => { if (!c) { console.log(`  FAIL: ${m}`); failures++; } };
const group = (n: string) => console.log(`== ${n}`);

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

/**
 * Both ends of one handshake: a matching pair of Sessions over a shared
 * transcript.
 *
 * Written once because every test below needs it and because getting it wrong
 * is invisible — a transcript assembled per-end rather than per-handshake
 * still produces two Sessions, they simply never agree. `hostFirst` is the
 * ordering the derivation depends on and it is fixed by role, not by caller.
 */
function pair(hostNonce = generateNonce(), deviceNonce = generateNonce()) {
  const host = generateKeypair();
  const device = generateKeypair();
  const transcript: SessionTranscript = {
    hostPublic: host.publicKey,
    devicePublic: device.publicKey,
    hostNonce,
    deviceNonce,
  };
  return {
    host, device, transcript,
    fromHost: () => deriveSession(host.privateKey, device.publicKey, transcript),
    fromDevice: () => deriveSession(device.privateKey, host.publicKey, transcript),
  };
}

group("both sides of an exchange agree");
{
  const p = pair();
  const fromA = p.fromHost();
  const fromB = p.fromDevice();

  check(hex(fromA.h2d) === hex(fromB.h2d), "host-to-device keys differ");
  check(hex(fromA.d2h) === hex(fromB.d2h), "device-to-host keys differ");
  check(fromA.passkey === fromB.passkey, `passkeys differ: ${fromA.passkey} vs ${fromB.passkey}`);
  check(/^\d{6}$/.test(fromA.passkey), `passkey is "${fromA.passkey}"`);
}

group("the two directions use different keys");
{
  const s = pair().fromHost();
  // One key both ways would let a device response be replayed at the device.
  check(hex(s.h2d) !== hex(s.d2h), "both directions share a key");
}

group("a relay produces mismatched passkeys");
{
  /* Two legs, two transcripts, because a relay runs two separate handshakes
   * and each end contributes a fresh nonce to its own. */
  const device = generateKeypair();
  const host = generateKeypair();
  const mitm = generateKeypair();

  const deviceLeg: SessionTranscript = {
    hostPublic: mitm.publicKey, devicePublic: device.publicKey,
    hostNonce: generateNonce(), deviceNonce: generateNonce(),
  };
  const hostLeg: SessionTranscript = {
    hostPublic: host.publicKey, devicePublic: mitm.publicKey,
    hostNonce: generateNonce(), deviceNonce: generateNonce(),
  };

  const deviceSees = deriveSession(device.privateKey, mitm.publicKey, deviceLeg).passkey;
  const hostSees = deriveSession(host.privateKey, mitm.publicKey, hostLeg).passkey;

  check(deviceSees !== hostSees,
    `relay produced matching passkeys (${deviceSees}) — the comparison would be useless`);
  console.log(`  device shows ${deviceSees}, app shows ${hostSees} -> the user sees a mismatch`);
}

group("a small-order peer key is refused");
{
  const a = generateKeypair();
  const t: SessionTranscript = {
    hostPublic: a.publicKey, devicePublic: new Uint8Array(32),
    hostNonce: generateNonce(), deviceNonce: generateNonce(),
  };
  let threw = false;
  try {
    deriveSession(a.privateKey, new Uint8Array(32), t);
  } catch {
    threw = true;
  }
  check(threw, "an all-zero peer key was accepted");
}

/* C-1. Every transcript field must move the digits, or it is binding nothing
 * and the relay is free to vary it. The shared secret is deliberately held
 * constant across all four variants — that constancy was exactly the freedom
 * the v1 derivation handed an attacker. */
group("the passkey moves when any part of the transcript moves");
{
  const host = generateKeypair();
  const device = generateKeypair();
  const other = generateKeypair();
  const base: SessionTranscript = {
    hostPublic: host.publicKey, devicePublic: device.publicKey,
    hostNonce: generateNonce(), deviceNonce: generateNonce(),
  };
  const reference = deriveSession(host.privateKey, device.publicKey, base).passkey;

  const variants: [string, SessionTranscript][] = [
    ["the host's public key", { ...base, hostPublic: other.publicKey }],
    ["the device's public key", { ...base, devicePublic: other.publicKey }],
    ["the host's nonce", { ...base, hostNonce: generateNonce() }],
    ["the device's nonce", { ...base, deviceNonce: generateNonce() }],
  ];
  for (const [what, t] of variants) {
    const got = deriveSession(host.privateKey, device.publicKey, t).passkey;
    check(got !== reference, `changing ${what} left the passkey at ${reference}`);
  }

  /* And a transcript of the wrong shape is a caller bug, not a weaker
   * binding: deriving over a short nonce would quietly halve the freshness. */
  let threw = false;
  try {
    deriveSession(host.privateKey, device.publicKey,
                  { ...base, deviceNonce: new Uint8Array(4) });
  } catch { threw = true; }
  check(threw, "a 4-byte nonce was accepted into the transcript");
}

group("the commitment opens only to what was committed");
{
  const host = generateKeypair();
  const device = generateKeypair();
  const other = generateKeypair();
  const nonce = generateNonce();

  const c = commitment(device.publicKey, host.publicKey, nonce);
  check(c.length === 32, "the commitment is not 32 bytes");
  check(verifyCommitment(c, device.publicKey, host.publicKey, nonce),
    "a commitment did not verify against its own inputs");
  check(!verifyCommitment(c, device.publicKey, host.publicKey, generateNonce()),
    "a different nonce opened the commitment — the relay may choose it after ours");
  check(!verifyCommitment(c, other.publicKey, host.publicKey, nonce),
    "the same nonce under another device key opened the commitment");
  check(!verifyCommitment(c, device.publicKey, other.publicKey, nonce),
    "the same nonce against another host key opened the commitment");
  check(!verifyCommitment(new Uint8Array(31), device.publicKey, host.publicKey, nonce),
    "a short commitment was accepted");
}

group("nonces are fresh");
{
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) seen.add(hex(generateNonce()));
  check(seen.size === 64, "generateNonce repeated a value in 64 draws");
  check([...seen][0]!.length === NONCE_BYTES * 2, "a nonce is the wrong width");
}

group("encryption round-trips, and only after confirmation");
{
  const p = pair();
  const host = new Session(p.fromHost(), "host");
  const device = new Session(p.fromDevice(), "device");

  let threw = false;
  try { host.encrypt(new Uint8Array([1])); } catch { threw = true; }
  check(threw, "encrypted before the passkey was confirmed");

  host.confirm();
  device.confirm();

  const message = new TextEncoder().encode("getStatus");
  const sealed = host.encrypt(message);
  check(hex(sealed) !== hex(message), "ciphertext equals plaintext");

  const opened = device.decrypt(sealed);
  check(new TextDecoder().decode(opened) === "getStatus", "round trip failed");

  /* A full exchange advances both ends: request out, reply back. Only after
   * the host has opened a reply does its next request use a fresh nonce. */
  const reply = device.encrypt(new TextEncoder().encode("ok"));
  check(new TextDecoder().decode(host.decrypt(reply)) === "ok", "reply did not decrypt");

  const again = host.encrypt(message);
  check(hex(sealed) !== hex(again), "a nonce was reused after a completed exchange");

  const retryHost = new Session(p.fromHost(), "host");
  retryHost.confirm();
  const first = retryHost.encrypt(message);
  const retried = retryHost.encrypt(message);
  check(hex(first) === hex(retried),
    "a retry advanced the counter; the peer never saw the first frame");

  const freshDevice = new Session(p.fromDevice(), "device");
  freshDevice.confirm();
  check(new TextDecoder().decode(freshDevice.decrypt(retried)) === "getStatus",
    "a retried frame did not decrypt at the peer");
}

group("a tampered frame is rejected");
{
  const p = pair();
  const host = new Session(p.fromHost(), "host");
  const device = new Session(p.fromDevice(), "device");
  host.confirm();
  device.confirm();

  const sealed = host.encrypt(new TextEncoder().encode("lock"));
  sealed[0] = (sealed[0] ?? 0) ^ 0x01;

  let threw = false;
  try { device.decrypt(sealed); } catch { threw = true; }
  check(threw, "a tampered frame was accepted");
}

group("matches the firmware, byte for byte, on a fixed exchange");
{
  /* The same known-answer vector as the `kat()` case in sim/test_session.c.
   *
   * The previous version of this group checked only that derivation depended
   * on the peer key at all, which no plausible bug would have failed. There is
   * a great deal here for two implementations to disagree about and every one
   * of them fails silently, as a device that will not pair rather than a
   * compile error: the label strings, the field order inside the transcript
   * hash, the nonce width, whether the transcript is the HKDF salt or its
   * info, and which four bytes of the passkey block are reduced mod 10^6. So
   * the inputs are fixed and the outputs are pinned on both sides.
   *
   * Regenerate after an intentional change with:
   *   make -C sim build/test_session && ./sim/build/test_session --emit-kat
   */
  const devicePriv = unhex("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");
  const hostPriv = unhex("404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f");
  const devicePublic = unhex("358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254");
  const hostPublic = unhex("79a631eede1bf9c98f12032cdeadd0e7a079398fc786b88cc846ec89af85a51a");

  const transcript: SessionTranscript = {
    hostPublic,
    devicePublic,
    hostNonce: unhex("000102030405060708090a0b0c0d0e0f"),
    deviceNonce: unhex("f0e0d0c0b0a090807060504030201000"),
  };

  const fromHost = deriveSession(hostPriv, devicePublic, transcript);
  const fromDevice = deriveSession(devicePriv, hostPublic, transcript);

  check(fromHost.passkey === "585036", `passkey ${fromHost.passkey}, expected 585036`);
  check(hex(fromHost.h2d) ===
    "e608000f21aa91b6435f2e31463f33af2cd933104d620792863512ff91bd7aa0",
    `h2d ${hex(fromHost.h2d)}`);
  check(hex(fromHost.d2h) ===
    "504a692870f51dd74e1f5dae5d192336f5351f5167f98d3d4a9b7d4fb71e3e5d",
    `d2h ${hex(fromHost.d2h)}`);
  check(hex(commitment(devicePublic, hostPublic, transcript.deviceNonce)) ===
    "32a52cc07e0fc6e729838810f7dd77fe1699fd60623d1a8034902a51d4aaaad2",
    "the commitment does not match the firmware's");

  /* Mirrored inputs, identical answers — the transcript is by role, so both
   * ends reach the same place from opposite sides. */
  check(fromHost.passkey === fromDevice.passkey, "the two ends disagree on the passkey");
  check(hex(fromHost.h2d) === hex(fromDevice.h2d), "the two ends disagree on h2d");
}

group("a held nonce may not seal two different messages");
{
  /* The host defers its send counter until a reply arrives, so a retry reuses
   * the nonce. That is safe for an identical retry and catastrophic for
   * anything else: one key, one nonce, two plaintexts hands an eavesdropper
   * both messages and the authentication key. */
  const p = pair();
  const host = new Session(p.fromHost(), "host");
  const device = new Session(p.fromDevice(), "device");
  host.confirm();
  device.confirm();

  const first = new TextEncoder().encode("getStatus");
  const same = host.encrypt(first);
  check(hex(host.encrypt(first)) === hex(same), "an identical retry changed bytes");

  let threw = false;
  try {
    host.encrypt(new TextEncoder().encode("signTransaction"));
  } catch {
    threw = true;
  }
  check(threw, "a second, different message was sealed under the held nonce");

  /* Once the reply lands the counter moves and the next message is free. */
  device.decrypt(same);
  host.decrypt(device.encrypt(new TextEncoder().encode("ok")));
  let sealedAfter = true;
  try {
    host.encrypt(new TextEncoder().encode("signTransaction"));
  } catch {
    sealedAfter = false;
  }
  check(sealedAfter, "the session stayed stuck after the reply arrived");
}

console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures ? 1 : 0);
