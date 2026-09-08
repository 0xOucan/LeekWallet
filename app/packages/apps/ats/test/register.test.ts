/**
 * Register-reading tests.
 *
 * One property carries the file, and it is the one in the brief:
 *
 *   **An unreachable RPC must never render as zero, and never as "no
 *   holders".**
 *
 * So the same fixture is read twice — once with a working transport and once
 * with a dead one — and every field is asserted to differ in KIND, not merely
 * in value. A dead read that produced `holders: []` would pass a naive "did it
 * not crash" test and fail here, which is the point.
 *
 * The second property is the freshness one: nothing survives a failed refresh.
 * A view is built whole or not at all, so there is no code path by which a
 * revoked role can still read "admin" off a previous read.
 */

import { freshnessOf } from "@leekwallet/core/balances.ts";
import { fixtureRequest, fixtureSelfCheck, htsLikeRequest } from "../src/fixtures.ts";
import {
  DIAGNOSIS_THRESHOLD, PRIVILEGED_STALE_AFTER_MS, maxSupplyIsCap,
  privilegedFreshness, readRegister, registerDiagnosis, registerProvenance,
  type Outcome, type RegisterView,
} from "../src/register.ts";
import {
  describeOutcome, isUncertain, kycLabel, partitionRoles, supplyLine,
} from "../src/view.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const TOKEN = "0x00000000000000000000000000000000004e5f21";
const HOLDER_A = "0x000000000000000000000000000000000048a1b2";

/** A transport where nothing answers. The failure this app is built around. */
const deadRequest = async (): Promise<never> => {
  throw new Error("no RPC endpoint answered eth_call — testnet.hashio.io: timeout");
};

const okValue = <T>(o: Outcome<T>): T => {
  if (o.state !== "ok") throw new Error(`expected ok, got ${o.state}`);
  return o.value;
};

group("the fixture's own encoding satisfies the production decoder");
{
  check(fixtureSelfCheck() === 1, "fixture aggregate3 encoding is not decodable");
}

const live: RegisterView = await readRegister(fixtureRequest(), 296, TOKEN, () => "fixture");

group("a working read produces every field the dashboard shows");
{
  check(okValue(live.name) === "ACME Equity Series A", `name: ${JSON.stringify(live.name)}`);
  check(okValue(live.symbol) === "ACME", "symbol");
  check(okValue(live.decimals) === 6, "decimals");
  check(okValue(live.totalSupply) === 1_000_000n, "total supply");
  check(okValue(live.maxSupply) === 5_000_000n, "max supply");
  check(maxSupplyIsCap(okValue(live.maxSupply)), "5,000,000 is a cap");
  check(!maxSupplyIsCap(0n), "0 must mean uncapped, not a cap of zero");
  check(okValue(live.paused) === false, "paused");
  check(okValue(live.internalKyc) === true, "internal kyc");
  check(okValue(live.holderCount) === 3n, "holder count");
  check(live.pinnedBlock === 0x2654b23n, "the read was pinned to a block");

  const holders = okValue(live.holders);
  check(holders.length === 3, `expected 3 holders, got ${holders.length}`);
  check(holders[0]?.address === HOLDER_A, "first holder address");
  check(okValue(holders[0]!.balance) === 400_000n, "first holder balance");
  check(okValue(holders[0]!.kycStatus) === 1, "first holder is KYC'd");
  check(okValue(holders[2]!.kycStatus) === 0, "third holder is not KYC'd");
  check(okValue(holders[0]!.inControlList) === true, "first holder is on the control list");
  check(!live.holdersTruncated, "3 of 3 holders is not truncated");

  const cl = okValue(live.controlList);
  check(cl.whitelist && cl.count === 3n && cl.members.length === 3, "control list");

  const roles = okValue(live.roles);
  const controller = roles.find((r) => "name" in r.role && r.role.name === "Controller");
  check(okValue(controller!.memberCount) === 2n, "controller has two members");
  check(okValue(controller!.members).length === 2, "controller members listed");
  const amortization = roles.find((r) => "name" in r.role && r.role.name === "Amortization");
  check(okValue(amortization!.memberCount) === 0n, "an unheld role reads zero, not unavailable");
  check(okValue(amortization!.members).length === 0, "an unheld role has no members");

  const snaps = okValue(live.snapshots);
  check(snaps.rows.length === 2, `expected 2 snapshots, got ${snaps.rows.length}`);
  check(!snaps.truncated, "two snapshots is a complete list");
}

group("an unreachable RPC is never an empty register");
{
  const dead: RegisterView = await readRegister(deadRequest, 296, TOKEN, () => undefined);

  // Every one of these would be a plausible-looking zero if the code had a
  // `?? 0n` or a `catch { return [] }` anywhere in it.
  check(dead.totalSupply.state === "unavailable", `supply: ${dead.totalSupply.state}`);
  check(dead.holderCount.state === "unavailable", `holder count: ${dead.holderCount.state}`);
  check(dead.holders.state === "unavailable", `holders: ${dead.holders.state}`);
  check(dead.paused.state === "unavailable", `paused: ${dead.paused.state}`);
  check(dead.controlList.state === "unavailable", `control list: ${dead.controlList.state}`);
  check(dead.snapshots.state === "unavailable", `snapshots: ${dead.snapshots.state}`);
  check(dead.pinnedBlock === undefined, "a dead node cannot have pinned a block");

  // Roles are a list of rows even when dead, because each row states its own
  // outcome — but not one of them may claim a membership count.
  const roles = okValue(dead.roles);
  check(roles.length === 37, "every role still has a row");
  check(roles.every((r) => r.memberCount.state === "unavailable"),
        "a role's member count must not read 0 when nobody answered");
  check(roles.every((r) => r.members.state === "unavailable"),
        "a role's member list must not read empty when nobody answered");

  // And the words on screen must say so, rather than showing a figure.
  const line = describeOutcome(dead.totalSupply, (v) => String(v));
  check(line.startsWith("unavailable"), `supply rendered as: ${line}`);
  check(!/\b0\b/.test(supplyLine(dead).split("—")[0] ?? ""), `supply line shows a zero: ${supplyLine(dead)}`);
  check(isUncertain(dead.holders), "the holder list must be flagged uncertain");

  // The distinction under test, stated directly: a genuinely empty register
  // and an unreachable one must not produce the same sentence.
  const emptyish = describeOutcome({ state: "ok", value: [] } as Outcome<unknown[]>,
                                   (v) => `${v.length} holders`);
  check(emptyish !== describeOutcome(dead.holders, () => ""),
        "an empty register and an unreachable one read the same");
  check(emptyish === "0 holders", "an actually-empty register may say zero");
}

group("a missing facet is not the same as an unreachable node");
{
  const noControlList = await readRegister(
    fixtureRequest({ missing: ["getControlListType", "getControlListCount", "getControlListMembers"] }),
    296, TOKEN, () => "fixture",
  );
  check(noControlList.controlList.state === "unsupported",
        `a security without the facet should read unsupported, got ${noControlList.controlList.state}`);
  // The rest of the register still reads. One absent facet must not erase it.
  check(okValue(noControlList.totalSupply) === 1_000_000n,
        "an absent facet erased the rest of the register");
  check(describeOutcome(noControlList.controlList, () => "").includes("not supported"),
        "an absent facet must say so, not say unavailable");
}

group("KYC and pause are read fresh, and dated");
{
  const paused = await readRegister(fixtureRequest({ paused: true }), 296, TOKEN, () => "fixture");
  check(okValue(paused.paused) === true, "a paused security reads paused");

  const revoked = await readRegister(
    fixtureRequest({ kycGranted: [] }), 296, TOKEN, () => "fixture",
  );
  const rows = okValue(revoked.holders);
  check(rows.every((r) => okValue(r.kycStatus) === 0),
        "a revoked KYC must show as revoked on the next read");
  check(kycLabel(0) === "not granted" && kycLabel(1) === "granted", "kyc labels");
  check(kycLabel(9).includes("unknown"), "an unknown KYC code is not silently 'no'");

  // Freshness: privileged facts go stale much sooner than a balance does, and
  // the provenance line says so in words rather than leaving it implied.
  const now = live.fetchedAt + PRIVILEGED_STALE_AFTER_MS;
  check(privilegedFreshness(live, now).stale, "a 15s-old role list must read stale");
  check(!freshnessOf(live.fetchedAt, now).stale,
        "the test is only meaningful if core's balance window is still fresh here");
  check(!privilegedFreshness(live, live.fetchedAt + 1000).stale, "a 1s-old view is fresh");
  check(registerProvenance(live, now).startsWith("STALE"), "a stale view is labelled STALE");
  check(registerProvenance(live, live.fetchedAt).includes("block 40192803"),
        `provenance should name the pinned block: ${registerProvenance(live, live.fetchedAt)}`);
  check(registerProvenance(live, live.fetchedAt).includes("fixture"),
        "provenance should name who answered");
}

group("nothing is carried across a failed refresh");
{
  /* The scenario: a register is read successfully, a role is revoked, and the
   * refresh fails. The screen must not still show the role. The mechanism is
   * that readRegister returns a whole new view and merges nothing, so the
   * check is that the failed read shares no `ok` field with the good one. */
  const before = live;
  const after = await readRegister(deadRequest, 296, TOKEN, () => undefined);
  const beforeRoles = okValue(before.roles).filter((r) => r.memberCount.state === "ok" &&
                                                          r.memberCount.value > 0n);
  check(beforeRoles.length > 0, "the good read should have held roles for this to mean anything");
  check(okValue(after.roles).every((r) => r.memberCount.state !== "ok"),
        "a failed refresh must not retain a single member count from the previous one");
  check(after.fetchedAt >= before.fetchedAt, "the new view is dated at its own read");
}

group("a non-ATS address is diagnosed once, not forty times");
{
  /* The HTS trap, as the console meets it. An HTS system contract answers an
   * unknown selector with `success` and non-conforming data (plan §2b), so
   * every call is answered and every answer fails to decode, identically. The
   * old behaviour was forty rows of the same sentence. */
  const view = await readRegister(htsLikeRequest(), 296, TOKEN, () => "testnet.hashio.io");
  const diagnosis = registerDiagnosis(view);
  check(diagnosis !== undefined, "a contract answering nothing decodable produced no diagnosis");
  check((diagnosis?.count ?? 0) >= DIAGNOSIS_THRESHOLD,
        `the diagnosis counted only ${diagnosis?.count} fields`);
  check(diagnosis?.text.includes("does not answer like an ATS security") === true,
        `the diagnosis does not say what it found: ${diagnosis?.text}`);
  // The reason survives. It is said once rather than not at all.
  check(diagnosis?.why.startsWith("undecodable reply:") === true,
        `the diagnosis dropped the reason: ${diagnosis?.why}`);

  /* The measurement the bug report made, inverted into an assertion: how many
   * rows repeat the sentence the banner already gave. Forty before, none now,
   * and the count of what was folded is still reported to the reader. */
  if (view.roles.state === "ok") {
    const { shown, folded } = partitionRoles(view.roles.value, diagnosis);
    check(folded >= DIAGNOSIS_THRESHOLD, `only ${folded} role rows were folded away`);
    check(shown.length === 0,
          `${shown.length} role rows still repeat the diagnosis's own sentence`);
    /* Without the diagnosis the rows come back. The fix must be the banner
     * absorbing them, not a filter that hides roles in general. */
    check(partitionRoles(view.roles.value, undefined).shown.length === folded,
          "the folded rows are not the rows that would otherwise have printed");
  } else {
    check(false, "the roles list itself failed; this test needs the per-role failures");
  }
}

group("an unreachable endpoint is NOT diagnosed as a wrong address");
{
  /* The failure mode of the fix. A dead transport also fails every field the
   * same way, and a banner reading "this address does not answer like an ATS
   * security" would send the user hunting for a better address when what they
   * need is a working connection. Only a reply that ARRIVED and failed to
   * decode is evidence about the address. */
  const dead = await readRegister(deadRequest, 296, TOKEN, () => undefined);
  check(registerDiagnosis(dead) === undefined,
        "an unreachable endpoint was diagnosed as a non-ATS address");
}

group("a healthy register gets no banner at all");
{
  check(registerDiagnosis(live) === undefined,
        "a register that read fine acquired a diagnosis");
}

console.log(failures === 0 ? "PASSED (0 failures)" : `FAILED (${failures})`);
if (failures > 0) process.exit(1);
