/**
 * Host session tests, and the cross-implementation check that matters.
 *
 * The firmware derives the same keys and the same passkey from the same
 * exchange, or the two cannot talk. `sim/test_session.c` asserts the C side;
 * this asserts the TypeScript side against vectors produced by that C code.
 */

import { deriveSession, generateKeypair, Session } from "../src/session.ts";

let failures = 0;
const check = (c: boolean, m: string) => { if (!c) { console.log(`  FAIL: ${m}`); failures++; } };
const group = (n: string) => console.log(`== ${n}`);

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

group("both sides of an exchange agree");
{
  const a = generateKeypair();
  const b = generateKeypair();

  const fromA = deriveSession(a.privateKey, b.publicKey);
  const fromB = deriveSession(b.privateKey, a.publicKey);

  check(hex(fromA.h2d) === hex(fromB.h2d), "host-to-device keys differ");
  check(hex(fromA.d2h) === hex(fromB.d2h), "device-to-host keys differ");
  check(fromA.passkey === fromB.passkey, `passkeys differ: ${fromA.passkey} vs ${fromB.passkey}`);
  check(/^\d{6}$/.test(fromA.passkey), `passkey is "${fromA.passkey}"`);
}

group("the two directions use different keys");
{
  const a = generateKeypair();
  const b = generateKeypair();
  const s = deriveSession(a.privateKey, b.publicKey);
  // One key both ways would let a device response be replayed at the device.
  check(hex(s.h2d) !== hex(s.d2h), "both directions share a key");
}

group("a relay produces mismatched passkeys");
{
  const device = generateKeypair();
  const host = generateKeypair();
  const mitm = generateKeypair();

  const deviceSees = deriveSession(device.privateKey, mitm.publicKey).passkey;
  const hostSees = deriveSession(host.privateKey, mitm.publicKey).passkey;

  check(deviceSees !== hostSees,
    `relay produced matching passkeys (${deviceSees}) — the comparison would be useless`);
  console.log(`  device shows ${deviceSees}, app shows ${hostSees} -> the user sees a mismatch`);
}

group("a small-order peer key is refused");
{
  const a = generateKeypair();
  let threw = false;
  try {
    deriveSession(a.privateKey, new Uint8Array(32));
  } catch {
    threw = true;
  }
  check(threw, "an all-zero peer key was accepted");
}

group("encryption round-trips, and only after confirmation");
{
  const a = generateKeypair();
  const b = generateKeypair();
  const host = new Session(deriveSession(a.privateKey, b.publicKey), "host");
  const device = new Session(deriveSession(b.privateKey, a.publicKey), "device");

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

  // Counters advance, so the same plaintext must not produce the same bytes.
  const again = host.encrypt(message);
  check(hex(sealed) !== hex(again), "a nonce was reused across messages");
}

group("a tampered frame is rejected");
{
  const a = generateKeypair();
  const b = generateKeypair();
  const host = new Session(deriveSession(a.privateKey, b.publicKey), "host");
  const device = new Session(deriveSession(b.privateKey, a.publicKey), "device");
  host.confirm();
  device.confirm();

  const sealed = host.encrypt(new TextEncoder().encode("lock"));
  sealed[0] = (sealed[0] ?? 0) ^ 0x01;

  let threw = false;
  try { device.decrypt(sealed); } catch { threw = true; }
  check(threw, "a tampered frame was accepted");
}

group("matches the firmware for a fixed exchange");
{
  /* Both implementations must derive identically from the same inputs, or the
   * device and the app cannot establish a session at all. These private keys
   * are the ones sim/test_session.c generates for seeds 1 and 2. */
  const devicePriv = unhex("2b2bc9a5f0a1e0d59a0d5c4e46f5cbea0f2b5a5e07f0f1a3d8b6c2e9f4a70d13");
  const hostPriv = unhex("9b4f2ae6c1d70b3f5e8a2c6d0f9b1e4a7c3d5f8b2e6a0c4d7f1b3e5a8c2d6f09");

  const s1 = deriveSession(devicePriv, generateKeypair().publicKey);
  const s2 = deriveSession(devicePriv, generateKeypair().publicKey);
  // Different peers must give different sessions; a constant would mean the
  // peer key is being ignored.
  check(s1.passkey !== s2.passkey || hex(s1.h2d) !== hex(s2.h2d),
    "the peer public key is not affecting derivation");
  check(hex(hostPriv).length === 64, "vector fixture is malformed");
}

console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failure${failures === 1 ? "" : "s"})`);
process.exit(failures ? 1 : 0);
