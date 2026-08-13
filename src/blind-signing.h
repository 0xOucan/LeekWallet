/**
 * Blind signing: the opt-in escape hatch (ROADMAP T16, PROTOCOL.md 6bis).
 *
 * The device refuses calldata it cannot put into words. That refusal is the
 * feature, and it is also a wall: a dapp the decoder has never heard of — an
 * Aave testnet faucet, say — is simply unusable. Ledger hit this wall and
 * shipped a toggle; the difference worth keeping is *where the toggle lives*
 * and *what it admits to*.
 *
 * Three rules this module exists to enforce:
 *
 *   1. Off by default. A device out of the box refuses.
 *   2. Changed on the device only. There is deliberately no command for this,
 *      and there must never be one: a host that can switch the protection off
 *      is a host the protection was never protecting you from.
 *   3. Reported honestly. getFeatures answers with the real state, so the app
 *      and any dapp can see the device is in the weaker mode.
 *
 * What it unlocks is exactly one thing: calldata the decoder does not
 * understand, on a transaction that still has a recipient. It does not unlock
 * contract creation (nothing to name), oversized calldata (the device would be
 * signing bytes it never held), or a message the screen cannot render (the
 * confirmation would carry no information). Each of those is refused for a
 * reason a warning screen cannot repair.
 */

#ifndef BLIND_SIGNING_H
#define BLIND_SIGNING_H

#include <stdbool.h>

/**
 * Is blind signing on?
 *
 * Loads from NVS on first use, so callers on any task get the persisted answer
 * without an ordering requirement between the UI and protocol tasks.
 */
bool blind_signing_enabled(void);

/**
 * Turn it on or off, and persist.
 *
 * Only the on-device settings flow may call this, and only after the warning
 * screen has been read and confirmed. Returns false if the setting could not
 * be written, in which case the in-memory state is left unchanged — a device
 * that says "on" and comes back "off" after a reboot is worse than one that
 * says it failed.
 */
bool blind_signing_set(bool enabled);

/**
 * Forget the cached value, for after a wipe.
 *
 * A wipe erases NVS underneath this module; without this the cache would keep
 * answering "on" for a device that no longer has the setting stored, and the
 * next boot would silently disagree with the running one.
 */
void blind_signing_forget(void);

#endif /* BLIND_SIGNING_H */
