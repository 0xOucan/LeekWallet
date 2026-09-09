/**
 * L5 navigation — the safety property, pinned (docs/UI-L5-SPEC.md §3).
 *
 * `setShellVisible(false)` used to force-hide every tab-owned panel on lock,
 * disconnect and `invalidateDerived` — a safety behaviour, not a tab-bar
 * detail: a locked device must never leave a Send form or an address on
 * screen. L5 deletes the tab bar and folds Send/Receive/Activity/Apps/
 * Connect into blocks on the wallet menu, reached through `dest` — this test
 * pins that the same safety property survives that rewrite.
 *
 * destHidden() is pure and DOM-free (src/nav.ts), so this runs without a
 * browser: what is under test is the *rule*, not main.ts's DOM wiring.
 */

import { DEST_PANEL_IDS, destHidden, type Dest } from "../src/nav.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const allPanelIds = Object.values(DEST_PANEL_IDS);

group("THE PROPERTY: closing the shell shuts every destination, whichever one was open");
{
  // A user mid-Send-form, then the device locks (or is disconnected, or
  // invalidateDerived runs for any other reason). shellOpen flips to false.
  for (const dest of Object.keys(DEST_PANEL_IDS) as Dest[]) {
    const hidden = destHidden(false, dest);
    for (const id of allPanelIds) {
      check(hidden[id] === true, `dest=${dest}: ${id} still visible with the shell closed`);
    }
  }
}

group("the wallet menu is not exempt from that shutdown");
{
  // The trap the spec calls out by name: it would be easy to special-case
  // #walletmenu as "always safe to show". It is not — a stale account/address
  // is exactly the kind of thing that must go with everything else.
  const hidden = destHidden(false, "walletmenu");
  check(hidden["walletmenu"] === true, "walletmenu stayed visible with the shell closed");
}

group("only one destination is ever on screen once the shell is open");
{
  for (const dest of Object.keys(DEST_PANEL_IDS) as Dest[]) {
    const hidden = destHidden(true, dest);
    const visible = allPanelIds.filter((id) => !hidden[id]);
    check(visible.length === 1 && visible[0] === DEST_PANEL_IDS[dest],
      `dest=${dest}: expected only ${DEST_PANEL_IDS[dest]} visible, got [${visible.join(", ")}]`);
  }
}

group("reopening the shell always lands on the wallet menu, never wherever a block left off");
{
  // setShellVisible(true) always calls goToWalletMenu(), never "whatever
  // `dest` still says" — this is the DOM-free half of that guarantee: with
  // dest reset to "walletmenu", every block-owned panel is hidden and only
  // the wallet menu shows.
  const hidden = destHidden(true, "walletmenu");
  check(hidden["signpanel"] === true, "signpanel visible on the reopened wallet menu");
  check(hidden["addrpanel"] === true, "addrpanel visible on the reopened wallet menu");
  check(hidden["walletmenu"] === false, "walletmenu itself hidden on entry");
}

console.log(failures === 0 ? "all ok" : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
