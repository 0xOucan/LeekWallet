/**
 * Atomic device wipe (T5, AUDIT S7).
 *
 * Wiping touches two independent NVS namespaces: "leek_pin" holds the PIN hash
 * and the attempt counter, "colibri" holds the encrypted mnemonics. Erasing
 * them is two calls, and a power cut between them leaves the device in a state
 * neither call intended — ciphertext with no PIN guarding it, or a PIN
 * protecting nothing. The UI remembered to make both calls at all three call
 * sites, which is exactly the kind of thing that stays correct until it does
 * not.
 *
 * There is no transaction across two namespaces, so this does the next best
 * thing: it writes an intent marker to a third namespace before touching
 * anything and clears it only once both erases have committed. A wipe
 * interrupted anywhere in the middle leaves the marker set, and the next boot
 * finishes the job before the user can do anything else.
 *
 * The invariant is one-directional and worth stating plainly: once a wipe has
 * begun, the device will complete it. It will not come back half-wiped and
 * usable, because a half-wiped device that still unlocks is a device whose
 * owner believes their seed is gone when it is not.
 */

#ifndef DEVICE_WIPE_H
#define DEVICE_WIPE_H

#include <stdbool.h>

/**
 * Erase every secret on the device: wallets first, then the PIN.
 *
 * Idempotent, and safe to call on an already-wiped device. Callers are
 * responsible for confirmation — this function asks nothing.
 *
 * Wallets go first deliberately. If only one of the two can survive a crash,
 * the seed is the one that must not.
 */
void device_wipe(void);

/**
 * Finish an interrupted wipe. Call once at boot, before the UI can unlock.
 *
 * Returns true if a wipe was pending and has now been completed, which the
 * caller may want to tell the user about: they asked for a wipe and are
 * entitled to know it took two attempts.
 */
bool device_wipe_resume(void);

/** Whether a wipe is recorded as started but not finished. */
bool device_wipe_pending(void);

#endif /* DEVICE_WIPE_H */
