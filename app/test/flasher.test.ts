/**
 * What decides whether a dangerous button is live.
 *
 * The flasher installs the code that holds the keys and erases the vault on the
 * way, so the interesting logic is not the flashing — espflash does that — but
 * the gate in front of it. This pins the gate: a build that cannot flash, an
 * image whose digest is not the one the user checked, an image built for the
 * other board, a missing device, a missing acknowledgement. Each returns a
 * sentence rather than a boolean, because a button that is disabled with no
 * explanation is a button people file bugs about.
 *
 * The two refusals — digest and chip — are the ones worth being strict about:
 * both have a tempting "warn and continue" version, and neither has a case
 * where continuing is right.
 */

import {
  chipRefusal,
  describeProgress,
  digestRefusal,
  flashBlockedReason,
  imageChipId,
  sha256Hex,
  type DetectedChip,
  type FlashCapability,
} from "../src/flasher.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const CAN: FlashCapability = { available: true, secureBoot: false, warning: "…", erases: "…" };
const CANNOT: FlashCapability = { available: false, secureBoot: false, warning: "…", erases: "…" };

const state = (o: Partial<Parameters<typeof flashBlockedReason>[0]>) => ({
  capability: CAN,
  acknowledged: true,
  port: "/dev/ttyACM0",
  imageBytes: 1_200_000,
  digestRefusal: "",
  chipRefusal: "",
  busy: false,
  ...o,
});

/** A minimal ESP image header for a given chip id. */
const image = (chipId: number): Uint8Array => {
  const img = new Uint8Array(64);
  img[0] = 0xe9;
  img[12] = chipId & 0xff;
  img[13] = chipId >> 8;
  return img;
};

const S3 = 0x0009;
const C3 = 0x0005;

group("every gate in front of the flash button holds");
{
  check(flashBlockedReason(state({})) === "", "a fully satisfied state still blocked");

  const notBuilt = flashBlockedReason(state({ capability: CANNOT }));
  check(notBuilt !== "", "a build that cannot flash offered the button anyway");
  /* The reason must say this is deliberate. "Cannot flash" alone reads as a bug
   * and invites someone to go looking for the broken part. */
  check(/deliberate|secure boot/i.test(notBuilt), `the reason does not explain itself: ${notBuilt}`);

  check(flashBlockedReason(state({ acknowledged: false })) !== "",
    "flashing was offered before the warning was accepted");
  check(flashBlockedReason(state({ port: "" })) !== "", "flashing was offered with no device chosen");
  check(flashBlockedReason(state({ imageBytes: 0 })) !== "", "flashing was offered with no image");
  check(flashBlockedReason(state({ busy: true })) !== "", "a second flash could start during the first");
  check(flashBlockedReason(state({ digestRefusal: "no" })) !== "", "a digest refusal did not block");
  check(flashBlockedReason(state({ chipRefusal: "no" })) !== "", "a chip refusal did not block");

  // Order matters: an unbuilt backend must be reported before the smaller
  // omissions, or the user is told to tick a box that will not help.
  const both = flashBlockedReason(state({ capability: CANNOT, acknowledged: false, port: "" }));
  check(/deliberate|secure boot/i.test(both), `the most fundamental blocker is not reported first: ${both}`);

  // And a refusal outranks a missing port: someone holding the wrong file
  // should learn that, not be sent to pick a device first.
  const wrongFile = flashBlockedReason(state({ digestRefusal: "REFUSED", port: "" }));
  check(wrongFile === "REFUSED", `the refusal was buried behind a smaller omission: ${wrongFile}`);
}

group("a digest that does not match is refused, not warned");
{
  const digest = await sha256Hex(new Uint8Array([1, 2, 3]));
  check(digest === "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    `SHA-256 is wrong: ${digest}`);

  check(digestRefusal("", digest) === "", "an empty expectation should not block");
  check(digestRefusal(`  ${digest.toUpperCase()} \n`, digest) === "",
    "a pasted digest was rejected over case or whitespace");

  const mismatch = digestRefusal("0".repeat(64), digest);
  check(/refus/i.test(mismatch), `a mismatch did not refuse: ${mismatch}`);
  /* No "continue anyway" anywhere near this. A wallet image whose hash does not
   * match the one the user checked is one nobody should install. */
  check(!/anyway|continue|proceed/i.test(mismatch), `the refusal offers a way past it: ${mismatch}`);

  check(/64 hexadecimal/.test(digestRefusal("deadbeef", digest)),
    "half a pasted line was reported as a mismatch rather than as a typo");
}

group("an image for the other board is refused");
{
  check(imageChipId(image(S3)) === S3, "the chip id was not read out of the header");
  check(imageChipId(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])) === null,
    "a file that is not an ESP image reported a chip id");

  const c3: DetectedChip = { chip: "esp32c3", chipId: C3, revision: "v0.4", flashSize: "4MB" };
  const s3: DetectedChip = { chip: "esp32s3", chipId: S3, revision: null, flashSize: "16MB" };
  const other: DetectedChip = { chip: "esp32c6", chipId: null, revision: null, flashSize: "8MB" };

  check(chipRefusal(S3, s3) === "", "a matching image and board were refused");
  check(chipRefusal(S3, null) === "", "an unconnected device blocked on a chip it has not reported");

  const crossed = chipRefusal(S3, c3);
  check(/ESP32-S3/.test(crossed) && /ESP32-C3/.test(crossed), `both chips must be named: ${crossed}`);
  /* This is why it is a refusal and not a warning: the wrong image writes
   * cleanly and then does not boot, which reads as a hardware fault. */
  check(/broken cable/.test(crossed), `the failure mode is not explained: ${crossed}`);

  check(/esp32c6/.test(chipRefusal(S3, other)), "an unknown board was not named in the refusal");
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
