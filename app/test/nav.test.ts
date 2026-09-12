/**
 * The home accordion — the safety property, pinned (docs/UI-L5-SPEC.md §3,
 * carried forward by docs/UI-L6-SPEC.md §3).
 *
 * A locked or disconnected device must never leave a Send form or an address
 * on screen. L5 enforced that by hiding every destination panel; L6 replaces
 * those destinations with collapsible sections, which introduces a new way to
 * get it wrong — a section that is merely *collapsed* is still in the DOM, and
 * a header strip left behind on lock is still a piece of the wallet on screen.
 * So the test is stronger than L5's: with the shell closed, every wrapper,
 * every header and every body is hidden, whichever section was expanded.
 *
 * sectionHidden() is pure and DOM-free (src/nav.ts), so this runs without a
 * browser: what is under test is the *rule*, not main.ts's DOM wiring.
 */

import {
  SECTIONS, SECTION_HEADER_IDS, SECTION_PANEL_IDS, SECTION_WRAPPER_IDS,
  sectionHidden, toggleSection, type Section,
} from "../src/nav.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const allIds = [
  ...Object.values(SECTION_WRAPPER_IDS),
  ...Object.values(SECTION_HEADER_IDS),
  ...Object.values(SECTION_PANEL_IDS),
];

/** Every state the accordion can be in: nothing open, or one section open. */
const everyOpenState: (Section | null)[] = [null, ...SECTIONS];

group("THE PROPERTY: closing the shell hides every section, expanded or not");
{
  // A user mid-Send-form, or mid-mini-app, and the device locks (or is
  // disconnected, or invalidateDerived runs for any other reason).
  for (const open of everyOpenState) {
    const hidden = sectionHidden(false, open);
    for (const id of allIds) {
      check(hidden[id] === true, `open=${open}: ${id} still visible with the shell closed`);
    }
  }
}

group("collapsing is not enough on lock — the headers go too");
{
  // The trap L6 introduces: a header is a permanent-looking strip, and it
  // would be easy to leave the row of headers up and merely collapse the
  // bodies. A bare "Balances / Send / Receive" rail on a locked device is
  // still the wallet on screen.
  const hidden = sectionHidden(false, null);
  for (const s of SECTIONS) {
    check(hidden[SECTION_HEADER_IDS[s]] === true, `${s}: header survived the lock`);
    check(hidden[SECTION_WRAPPER_IDS[s]] === true, `${s}: wrapper survived the lock`);
  }
}

group("balances is not exempt from that shutdown");
{
  // Named because it is the section carrying the account line and address —
  // exactly the stale thing that must go with everything else.
  const hidden = sectionHidden(false, "balances");
  check(hidden[SECTION_PANEL_IDS["balances"]] === true, "walletmenu stayed visible with the shell closed");
}

group("open shell: every header shows, and exactly the open section's body");
{
  for (const open of everyOpenState) {
    const hidden = sectionHidden(true, open);
    for (const s of SECTIONS) {
      check(hidden[SECTION_HEADER_IDS[s]] === false, `open=${open}: ${s}'s header hidden with the shell open`);
      check(hidden[SECTION_WRAPPER_IDS[s]] === false, `open=${open}: ${s}'s wrapper hidden with the shell open`);
    }
    const bodiesShown = SECTIONS.filter((s) => !hidden[SECTION_PANEL_IDS[s]]);
    const expected = open === null ? [] : [open];
    check(JSON.stringify(bodiesShown) === JSON.stringify(expected),
      `open=${open}: expected [${expected.join(", ")}] expanded, got [${bodiesShown.join(", ")}]`);
  }
}

group("single-open: clicking a header opens it, clicking it again collapses it");
{
  check(toggleSection(null, "send") === "send", "opening from collapsed did not open send");
  check(toggleSection("send", "send") === null, "clicking the open section did not collapse it");
  check(toggleSection("send", "connect") === "connect", "opening connect did not replace send");
  // The user's own words: open Send, click Send again, and Receive or
  // Connect a site is one click below rather than behind a Back button.
  check(toggleSection(toggleSection("send", "send"), "receive") === "receive",
    "collapse-then-open did not land on receive");
}

group("reopening the shell starts from a fixed point, never where the last session left off");
{
  // setShellVisible() always writes openSection itself (null on close,
  // "balances" on open) rather than reusing whatever was expanded before —
  // this is the DOM-free half of that guarantee: whatever it writes, only
  // that one body is expanded, and with null none is.
  const hidden = sectionHidden(true, null);
  for (const s of SECTIONS) {
    check(hidden[SECTION_PANEL_IDS[s]] === true, `${s}'s body was expanded on a freshly opened shell`);
  }
}

group("the id maps agree with each other");
{
  for (const s of SECTIONS) {
    check(typeof SECTION_PANEL_IDS[s] === "string", `${s} has no panel id`);
    check(typeof SECTION_HEADER_IDS[s] === "string", `${s} has no header id`);
    check(typeof SECTION_WRAPPER_IDS[s] === "string", `${s} has no wrapper id`);
  }
  check(new Set(allIds).size === allIds.length, "two sections share an element id");
}

console.log(failures === 0 ? "all ok" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
