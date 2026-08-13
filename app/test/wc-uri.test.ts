/**
 * `wc:` URI parsing tests (T32).
 *
 * The URI is user-handled input — pasted, or guessed at by a camera — so the
 * interesting cases are all the wrong ones. What is pinned down here is that a
 * bad URI produces a sentence rather than an exception from inside the SDK, and
 * that the pairing key never appears in anything meant for a log.
 */

import { isExpired, parseWcUri, redactWcUri } from "../src/wc/uri.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const TOPIC = "a".repeat(64);
const KEY = "b".repeat(64);
const GOOD = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${KEY}`;

group("a well-formed v2 URI parses into its parts");
{
  const r = parseWcUri(GOOD);
  check(r.ok, "a valid URI was rejected");
  if (r.ok) {
    check(r.uri.topic === TOPIC, "topic wrong");
    check(r.uri.symKey === KEY, "symKey wrong");
    check(r.uri.relayProtocol === "irn", "relay protocol wrong");
    check(r.uri.version === 2, "version wrong");
    check(r.uri.expiryTimestamp === undefined, "invented an expiry");
  }
}

group("whitespace and casing survive a paste");
{
  const r = parseWcUri(`  wc:${TOPIC.toUpperCase()}@2?relay-protocol=irn&symKey=${KEY.toUpperCase()}\n`);
  check(r.ok, "a padded, upper-case URI was rejected");
  // Normalised to lower case so a later comparison cannot fail on casing alone.
  if (r.ok) check(r.uri.topic === TOPIC && r.uri.symKey === KEY, "not normalised to lower case");
}

group("optional fields are read when present");
{
  const r = parseWcUri(`${GOOD}&expiryTimestamp=1700000000&relay-data=xyz`);
  check(r.ok, "extra parameters caused a rejection");
  if (r.ok) {
    check(r.uri.expiryTimestamp === 1700000000, "expiry not read");
    check(r.uri.relayData === "xyz", "relay data not read");
  }
}

group("every malformed URI gives a reason, never an exception");
{
  const bad: Array<[string, string]> = [
    ["", "empty"],
    ["https://app.uniswap.org", "the dapp's own address"],
    [`wc:${TOPIC}`, "no version"],
    [`wc:${TOPIC}@1?bridge=x&key=${KEY}`, "v1"],
    [`wc:${TOPIC}@3?relay-protocol=irn&symKey=${KEY}`, "unknown version"],
    [`wc:short@2?relay-protocol=irn&symKey=${KEY}`, "truncated topic"],
    [`wc:${TOPIC}@2?relay-protocol=irn&symKey=beef`, "truncated key"],
    [`wc:${TOPIC}@2?symKey=${KEY}`, "no relay protocol"],
    [`wc:${TOPIC}@2?relay-protocol=irn`, "no key at all"],
  ];
  for (const [input, what] of bad) {
    const r = parseWcUri(input);
    check(!r.ok, `${what} was accepted`);
    if (!r.ok) {
      check(r.reason.length > 20, `${what}: reason too terse to act on`);
      // A reason a user can read, not a stack trace or a regex.
      check(!r.reason.includes("undefined"), `${what}: reason leaks an undefined`);
    }
  }
}

group("the v1 rejection says what happened to v1");
{
  const r = parseWcUri(`wc:${TOPIC}@1?bridge=https%3A%2F%2Fx&key=${KEY}`);
  check(!r.ok && r.reason.includes("v1"), "the v1 message does not name v1");
  check(!r.ok && /2023|shut down/.test(r.reason), "the v1 message does not say it is gone");
}

group("expiry is checked against a clock the caller supplies");
{
  const r = parseWcUri(`${GOOD}&expiryTimestamp=1000`);
  check(r.ok, "expiry parse failed");
  if (r.ok) {
    check(isExpired(r.uri, 2_000_000), "an expired URI was not noticed");
    check(!isExpired(r.uri, 500_000), "a live URI was called expired");
  }
  const forever = parseWcUri(GOOD);
  // No expiry means the relay decides, not this app.
  if (forever.ok) check(!isExpired(forever.uri, 9e15), "a URI without an expiry was called expired");
}

group("the loggable form never contains the pairing key");
{
  const r = parseWcUri(GOOD);
  check(r.ok, "parse failed");
  if (r.ok) {
    const line = redactWcUri(r.uri);
    check(!line.includes(KEY), "redaction leaked the symKey");
    check(line.includes("redacted"), "redaction is not labelled");
    // The topic is not secret and is what makes a log entry useful at all.
    check(line.includes(TOPIC.slice(0, 8)), "redaction dropped the topic entirely");
  }
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
