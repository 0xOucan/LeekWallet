/**
 * What decides whether a dangerous button is live.
 *
 * The flasher installs the code that holds the keys, so the interesting logic
 * is not the flashing — espflash does that — but the gate in front of it. This
 * pins the gate: a build that cannot flash, a user who has not acknowledged
 * what an unprotected device means, a missing device, a missing image. Each
 * returns a sentence rather than a boolean, because a button that is disabled
 * with no explanation is a button people file bugs about.
 */

import { describeProgress, flashBlockedReason, type FlashCapability } from "../src/flasher.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const CAN: FlashCapability = { available: true, secureBoot: false, warning: "…" };
const CANNOT: FlashCapability = { available: false, secureBoot: false, warning: "…" };

const state = (o: Partial<Parameters<typeof flashBlockedReason>[0]>) => ({
  capability: CAN, acknowledged: true, port: "/dev/ttyACM0", imageBytes: 1_200_000, busy: false, ...o,
});

group("every gate in front of the flash button holds");
{
  check(flashBlockedReason(state({})) === "", "a fully satisfied state still blocked");

  const notBuilt = flashBlockedReason(state({ capability: CANNOT }));
  check(notBuilt !== "", "a build that cannot flash offered the button anyway");
  /* The reason must say this is deliberate. "Cannot flash" alone reads as a
   * bug and invites someone to go looking for the broken part. */
  check(/deliberate|secure boot/i.test(notBuilt), `the reason does not explain itself: ${notBuilt}`);

  check(flashBlockedReason(state({ acknowledged: false })) !== "",
    "flashing was offered before the warning was accepted");
  check(flashBlockedReason(state({ port: "" })) !== "", "flashing was offered with no device chosen");
  check(flashBlockedReason(state({ imageBytes: 0 })) !== "", "flashing was offered with no image");
  check(flashBlockedReason(state({ busy: true })) !== "", "a second flash could start during the first");

  // Order matters: an unbuilt backend must be reported before the smaller
  // omissions, or the user is told to tick a box that will not help.
  const both = flashBlockedReason(state({ capability: CANNOT, acknowledged: false, port: "" }));
  check(/deliberate|secure boot/i.test(both), `the most fundamental blocker is not reported first: ${both}`);
}

group("progress says what is happening and what not to do");
{
  const writing = describeProgress({ stage: "writing", current: 600_000, total: 1_200_000 });
  check(writing.includes("50%"), `percentage wrong: ${writing}`);
  /* The one instruction that matters during a flash. Pulling the cable between
   * erase and verify is how a device ends up unbootable. */
  check(/do not unplug/i.test(writing), `writing progress does not warn against unplugging: ${writing}`);

  check(/verif/i.test(describeProgress({ stage: "verifying", current: 1, total: 1 })),
    "the verifying stage does not say so");
  check(describeProgress({ stage: "done", current: 1, total: 1 }).length > 20,
    "the done message is too terse to be reassuring");

  // A zero-length total must not produce NaN% on screen.
  check(describeProgress({ stage: "writing", current: 0, total: 0 }).includes("0%"),
    "an empty image produced a nonsense percentage");
}

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("PASSED (0 failures)");
