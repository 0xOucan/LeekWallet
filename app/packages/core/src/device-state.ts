/**
 * Tracking device state on the host, and knowing when to forget it.
 *
 * The device clears the passphrase whenever it locks, switches wallet, or
 * disconnects. Anything the host derived under that passphrase is then stale,
 * and stale is not a cosmetic problem here: the addresses on screen belong to a
 * wallet the device can no longer produce, and the user has no way to tell by
 * looking.
 *
 * So the rule is narrow and absolute: **derived state is only valid for the
 * exact (unlocked, wallet, passphrase) tuple it was derived under.** Any change
 * invalidates it, including a change the user made on the device without
 * telling the app.
 */

export interface DeviceStatus {
  unlocked: boolean;
  walletCount: number;
  activeWallet: number;
  /** Whether a passphrase is applied. Never *which* one — see docs/VAULT.md. */
  passphrase: boolean;
}

export const UNKNOWN_STATUS: DeviceStatus = {
  unlocked: false,
  walletCount: 0,
  activeWallet: 0,
  passphrase: false,
};

/**
 * Does moving from `before` to `after` invalidate anything derived earlier?
 *
 * Deliberately conservative: it answers yes on any transition that could change
 * a derivation, including locking. Being wrong in the other direction means
 * showing someone an address that is not theirs.
 */
export function derivationsInvalidated(before: DeviceStatus, after: DeviceStatus): boolean {
  if (before.unlocked && !after.unlocked) return true;      // locked
  if (!before.unlocked && after.unlocked) return true;      // fresh unlock, passphrase may differ
  if (before.activeWallet !== after.activeWallet) return true;
  if (before.passphrase !== after.passphrase) return true;
  return false;
}

/**
 * Never persist derived addresses.
 *
 * A passphrase wallet leaves no trace on the device by design, and writing its
 * addresses into host storage undoes exactly that: anyone reading the app's
 * data learns a hidden wallet exists, which is the fact the passphrase was
 * protecting. Keep them in memory, drop them on invalidation, and never write
 * them anywhere.
 */
export const PERSIST_DERIVED_ADDRESSES = false;
