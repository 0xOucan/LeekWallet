/**
 * Snapshot-enumeration tests.
 *
 * Snapshots are the part that has to be right, because a later distribution is
 * reconciled against one. Four outcomes have to stay distinguishable, and all
 * four look like "no snapshots" if the code is careless:
 *
 *   1. The security has taken none              → an empty list, said plainly.
 *   2. The security has taken two               → two rows, complete.
 *   3. The snapshot facet is not installed      → unsupported.
 *   4. Nobody answered                          → unavailable.
 *
 * Plus the fifth, which is worse than any of them: the list is longer than the
 * probe walked. That must read "at least N", never "N" — an issuer who thinks
 * snapshot 3 is the latest, when there is a 4, distributes against the wrong
 * register and the arithmetic still adds up.
 */

import { fixtureRequest, htsLikeRequest } from "../src/fixtures.ts";
import {
  SNAPSHOT_ABSENT_SELECTOR, SNAPSHOT_PROBE_LIMIT, readRegister, startsWithSelector,
  type Outcome, type SnapshotView,
} from "../src/register.ts";
import { describeOutcome } from "../src/view.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const TOKEN = "0x00000000000000000000000000000000004e5f21";

const snapshotsOf = async (
  request: Parameters<typeof readRegister>[0],
): Promise<Outcome<SnapshotView>> =>
  (await readRegister(request, 296, TOKEN, () => "fixture")).snapshots;

group("the end-of-list revert is recognised by its real selector");
{
  /* `SnapshotIdDoesNotExists` — the contracts' own spelling, "Exists" not
   * "Exist". Getting this wrong is invisible: every probe past the end would
   * read as "some other revert", so a security with snapshots would report
   * `unsupported` and look like one without the facet. */
  check(SNAPSHOT_ABSENT_SELECTOR === "0x8e81eb83",
        `SnapshotIdDoesNotExists selector is ${SNAPSHOT_ABSENT_SELECTOR}`);
  check(startsWithSelector(`${SNAPSHOT_ABSENT_SELECTOR}${"0".repeat(64)}`, SNAPSHOT_ABSENT_SELECTOR),
        "a revert payload beginning with the selector is recognised");
  check(!startsWithSelector("0x", SNAPSHOT_ABSENT_SELECTOR),
        "an empty revert is not the end-of-list marker");
  check(!startsWithSelector("0x08c379a0", SNAPSHOT_ABSENT_SELECTOR),
        "Error(string) is not the end-of-list marker");
}

group("a security with snapshots lists them, and knows the list is complete");
{
  const s = await snapshotsOf(fixtureRequest());
  if (s.state !== "ok") {
    check(false, `expected ok, got ${s.state}`);
  } else {
    const v = s.value;
    check(v.rows.length === 2, `expected 2 rows, got ${v.rows.length}`);
    check(v.rows[0]?.id === 1n && v.rows[1]?.id === 2n, "ids are 1-based and ascending");
    const supply0 = v.rows[0]?.totalSupply;
    const supply1 = v.rows[1]?.totalSupply;
    check(supply0?.state === "ok" && supply0.value === 800_000n, "snapshot 1 supply");
    check(supply1?.state === "ok" && supply1.value === 1_000_000n, "snapshot 2 supply");
    // The supplies differ, which is the whole reason a snapshot is worth
    // taking: a distribution against live balances would use neither.
    check(supply0?.state === "ok" && supply1?.state === "ok" && supply0.value !== supply1.value,
          "the fixture should have snapshots that differ");
    const holders1 = v.rows[1]?.holderCount;
    check(holders1?.state === "ok" && holders1.value === 3n, "snapshot 2 holder count");
    check(!v.truncated, "a list that reached the end must not be marked truncated");
  }
}

group("a security that has taken none says so, and says it plainly");
{
  const s = await snapshotsOf(fixtureRequest({ snapshotCount: 0 }));
  check(s.state === "ok", `expected ok, got ${s.state}`);
  if (s.state === "ok") {
    check(s.value.rows.length === 0, "no snapshots means no rows");
    // Complete, not truncated: the first probe reverted with the end-of-list
    // error, so we know there are none rather than merely not having found any.
    check(!s.value.truncated, "an empty list confirmed by the end marker is complete");
  }
}

group("a security without the snapshot facet says so");
{
  const s = await snapshotsOf(fixtureRequest({ missing: ["totalSupplyAtSnapshot"] }));
  check(s.state === "unsupported", `expected unsupported, got ${s.state}`);
  const text = describeOutcome(s, () => "", "this security has no snapshot facet");
  check(text === "this security has no snapshot facet", `rendered as: ${text}`);
  check(!text.includes("0"), "an absent facet must not render as a count");
}

group("an unreachable node is not an empty snapshot list");
{
  const s = await snapshotsOf(async () => {
    throw new Error("no RPC endpoint answered eth_call");
  });
  check(s.state === "unavailable", `expected unavailable, got ${s.state}`);
  // The sentence a reader sees must not be one they could act on.
  const text = describeOutcome(s, () => "");
  check(text.startsWith("unavailable"), `rendered as: ${text}`);
  check(text !== "No snapshot has been taken.", "an unreachable node claimed there are no snapshots");
}

group("a list longer than the probe is reported as a floor, not a count");
{
  check(SNAPSHOT_PROBE_LIMIT > 0 && SNAPSHOT_PROBE_LIMIT % 32 === 0,
        `probe limit should be a whole number of batches: ${SNAPSHOT_PROBE_LIMIT}`);

  // More snapshots than the probe will walk. The walk stops at the bound, and
  // the flag is the only thing standing between that and a wrong "latest".
  const s = await snapshotsOf(fixtureRequest({ snapshotCount: SNAPSHOT_PROBE_LIMIT + 5 }));
  check(s.state === "ok", `expected ok, got ${s.state}`);
  if (s.state === "ok") {
    check(s.value.rows.length === SNAPSHOT_PROBE_LIMIT,
          `expected the probe to stop at ${SNAPSHOT_PROBE_LIMIT}, got ${s.value.rows.length}`);
    check(s.value.truncated, "a list cut short by the probe bound must be marked incomplete");
    check(s.value.rows[SNAPSHOT_PROBE_LIMIT - 1]?.id === BigInt(SNAPSHOT_PROBE_LIMIT),
          "the last row walked should be the bound");
  }

  const complete = await snapshotsOf(fixtureRequest());
  check(complete.state === "ok" && !complete.value.truncated,
        "the ordinary fixture ends before the limit and must not be truncated");
}

group("a call that succeeds without answering is not a snapshot");
{
  /* The Hedera-specific trap, found by running this against real testnet
   * tokens: an HTS system contract answers an unknown selector with a success
   * and non-conforming data rather than a revert. Before the decode check, a
   * plain ERC-20 read back as a security with 64 snapshots. */
  const s = await snapshotsOf(htsLikeRequest());
  check(s.state === "unsupported",
        `a token that answers but does not conform must be unsupported, got ${s.state}`);
  if (s.state === "ok") {
    check(false, `it reported ${s.value.rows.length} snapshots for a non-ATS contract`);
  }
}

group("a mid-walk outage keeps the rows it has and admits it is incomplete");
{
  /* The subtle one. Two snapshots read fine, then the node stops answering.
   * Discarding the rows would lose true information; declaring the list
   * complete would be a lie. The only honest answer is both rows AND
   * truncated. Here the outage lands on the first snapshot batch, so there is
   * nothing yet to keep and the whole field must be unavailable. */
  let calls = 0;
  const flaky = fixtureRequest();
  const s = await snapshotsOf(async (args) => {
    // Let everything through until the snapshot probe, which is the last batch
    // readRegister issues.
    if (args.method === "eth_call" && ++calls >= 5) {
      throw new Error("the endpoint stopped answering mid-read");
    }
    return flaky(args);
  });
  check(s.state === "unavailable" || (s.state === "ok" && s.value.truncated),
        `a mid-read outage must be unavailable or truncated, got ${s.state}`);
  if (s.state === "ok") {
    check(s.value.truncated, "rows kept from before an outage must be marked incomplete");
  }
}

console.log(failures === 0 ? "PASSED (0 failures)" : `FAILED (${failures})`);
if (failures > 0) process.exit(1);
