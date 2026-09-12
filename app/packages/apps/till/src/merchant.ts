/**
 * The address this terminal will accept a bill for.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and why the waiter configures nothing
 *
 * A waiter carries this on a phone. `TILL_WAITER_APP` declares
 * `worksWithoutDevice: true` for exactly that reason — there is no hardware
 * wallet attached and no account to select. The expected address used to come
 * from `context.address`, the connected device, which is "" when there is no
 * device: the terminal then refused every request it was ever shown. The two
 * facts contradicted each other and the refusal won.
 *
 * So the terminal LEARNS the restaurant from the first well-formed request it
 * is shown, remembers it, and checks every later one against it. The waiter
 * scans; that is the whole procedure.
 *
 * ---------------------------------------------------------------------------
 * What this does and does not protect against
 *
 * It catches the mixup: a phone carrying yesterday's venue, a code from the
 * restaurant next door, a request altered after issue. Those are refused with
 * the address they would have paid printed on screen, which is the thing a
 * person can actually check.
 *
 * It does NOT stop whoever holds the terminal from clearing the setting and
 * teaching it a new address. Nothing here can: there is no key on a till to
 * sign a policy with — the device is in a safe — so a terminal cannot prove
 * who issued a request, and `request.ts` says so plainly. What bounds that is
 * the same thing that bounds a paper bill pad: the customer is standing there
 * and the amount is on the screen they are about to pay.
 *
 * The honest summary: a MISCONFIGURATION check, not a defence against a
 * malicious employee. Stated rather than implied, because the digest in a
 * request is a checksum and not a signature, and it would be easy to read this
 * file as if it were one.
 */

const MERCHANT_KEY = "leek.till.merchant";

/** Just enough of `localStorage` to keep one string. */
export interface MerchantStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The browser's `localStorage`, when there is one and it will answer.
 *
 * Probed rather than assumed: the accessor itself throws in some contexts, so
 * "is it there" has to be a try/catch and not a truthiness check. Same shape
 * as `browserRecipientStore` in the ATS app, for the same reason.
 */
export function browserMerchantStore(): MerchantStore | undefined {
  try {
    const store = (globalThis as { localStorage?: MerchantStore }).localStorage;
    if (!store) return undefined;
    store.getItem(MERCHANT_KEY);
    return store;
  } catch {
    return undefined;
  }
}

/** A 20-byte hex address, case-insensitive. The only shape worth storing. */
export function isAddress(text: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(text.trim());
}

/**
 * The configured address, or "" when there is none.
 *
 * Re-validated on the way out, never trusted because it was trusted once:
 * storage is editable by anything else running in this origin, and a value
 * that is not an address would be handed to `acceptRequest` as if it were one.
 */
export function loadMerchant(store: MerchantStore | undefined): string {
  if (!store) return "";
  let raw: string | null = null;
  try {
    raw = store.getItem(MERCHANT_KEY);
  } catch {
    return "";
  }
  if (raw === null) return "";
  const text = raw.trim();
  return isAddress(text) ? text : "";
}

/**
 * Remember an address, or forget it when given something that is not one.
 *
 * Returns what is now configured, so a caller cannot end up rendering a value
 * the store rejected.
 */
export function saveMerchant(store: MerchantStore | undefined, text: string): string {
  const trimmed = text.trim();
  if (!store) return isAddress(trimmed) ? trimmed : "";
  try {
    if (!isAddress(trimmed)) {
      store.removeItem(MERCHANT_KEY);
      return "";
    }
    store.setItem(MERCHANT_KEY, trimmed);
    return trimmed;
  } catch {
    /* A terminal that cannot persist still works for this shift; it just asks
     * again tomorrow. Losing the setting is not losing money. */
    return isAddress(trimmed) ? trimmed : "";
  }
}
