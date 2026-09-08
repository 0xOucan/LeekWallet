# L1: two implementations, and why one was chosen

Two agents independently built the same milestone. Keeping the record because
the difference between them is a real hazard, not a style preference.

| | A — `235328c` *(merged)* | B — `56e241c` *(discarded)* |
|---|---|---|
| Shape | `preConnectDest` state machine | launcher gate over the tab bar |
| Diff | 190 lines, 4 files | 157 lines, 3 files |
| Bundle | +0.62 KB JS, +0.97 KB CSS | +3.2 KB |
| **Back during a live session** | calls `disconnect()` | **returns to the tiles, session stays up** |

B is smaller and its structure is arguably tidier. It was still wrong, for one
reason:

```js
function closeLauncherBlock(): void {
  launcherOpen = null;
  applyLauncherGate();
}
```

Back resets the view and nothing else. Press it after connecting but before the
wallet screen appears — during the handshake, or while the device is waiting for
a PIN — and the app shows **"Connect device"** over a connection that is still
open. That is the same class of lie as rendering an unreachable balance as `0`:
the screen states something the system knows to be false.

A reuses the teardown that already exists rather than inventing a second one:

- Back calls the same `disconnect()` the visible Disconnect button calls.
- Guarded by the existing `connecting` flag — the one that already stops two
  handshakes racing — plus a `backingOut` flag so a double-click cannot start
  two overlapping disconnects.
- `disconnect()` ends with `goToLauncher()`, so Back and Disconnect land in the
  same place. Symmetric with connect's "the app moves itself to the wallet
  screen".

Both agents independently found the subtler trap and both avoided it:
`invalidateDerived()` calls `setShellVisible(false)` **mid-session** on an
on-device account or wallet switch. Reinstating the launcher there would show
"Connect device" over a connected, unlocked device. Neither did.

## The honest limit

Neither implementation is covered by an executed test of the
connect → unlock → disconnect → reconnect cycle. No harness drives `main.ts`'s
DOM flow. Both agents traced the call graph and said so plainly rather than
implying coverage they did not have.

**That cycle is therefore a manual test**, and it is the first thing to try on
hardware: connect, unlock, press Back mid-handshake, disconnect, reconnect.
