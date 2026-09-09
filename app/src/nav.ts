/**
 * Post-unlock navigation (L5, docs/UI-L5-SPEC.md).
 *
 * Pure and DOM-free on purpose. main.ts owns the actual `.hidden` writes and
 * the side effects (rendering the wallet menu, fetching balances) that go
 * with entering or leaving it; what belongs here is only the *rule* — which
 * panel is visible for a given (shellOpen, dest) pair — because that rule is
 * a safety property (docs/UI-L5-SPEC.md §3: a locked device must never leave
 * a Send form or an address on screen) and safety properties are worth
 * pinning with a test that does not need a browser to run.
 */

/** The wallet menu itself, plus everything reachable from one of its blocks.
 * "apps" names the block, not the `#apps` div nested inside `waiterdest` —
 * that div keeps deciding its own visibility from mounted content
 * (mountApps(), src/apps/mount.ts), independent of this module. */
export type Dest = "walletmenu" | "send" | "receive" | "activity" | "apps" | "connect";

export const DEST_PANEL_IDS: Record<Dest, string> = {
  walletmenu: "walletmenu",
  send: "signpanel",
  receive: "addrpanel",
  activity: "activitypanel",
  apps: "waiterdest",
  connect: "wcpanel",
};

/**
 * Which of `DEST_PANEL_IDS`'s panels should be hidden.
 *
 * `shellOpen` is the outer gate: while it is false (locked, disconnected, or
 * never unlocked) every one of these panels is hidden, `dest` notwithstanding
 * — that is the property that replaces `setShellVisible(false)`'s old
 * blanket hide. While it is true, exactly the panel named by `dest` is
 * shown and the rest stay hidden: only one destination is ever on screen.
 */
export function destHidden(shellOpen: boolean, dest: Dest): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [d, id] of Object.entries(DEST_PANEL_IDS) as [Dest, string][]) {
    out[id] = !shellOpen || dest !== d;
  }
  return out;
}
