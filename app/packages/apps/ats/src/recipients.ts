/**
 * The recipient book: addresses this console has been told about.
 *
 * ---------------------------------------------------------------------------
 * What it is, and the much more important question of what it is not
 *
 * It is a convenience so that distributing an issue to eight holders does not
 * mean pasting eight addresses twice each — once to mint and once to send. It
 * is a list of strings a user typed.
 *
 * **It is not evidence about anybody.** A name in here is a note the user wrote
 * to themselves; nothing checked that the address exists, that it is KYC'd
 * against any security, that it is on a control list, or that it belongs to the
 * person named. `label` is therefore never shown without the address beside it
 * — an address book that renders "Alice" alone is a phishing surface, because
 * the entry is host data and the only thing a reader can actually verify is the
 * twenty bytes. The device shows the address and nothing else, and this file
 * exists to make sure the console cannot say something the device will not.
 *
 * ---------------------------------------------------------------------------
 * Refusals as values, and storage that is allowed to be absent
 *
 * `add` returns `{ ok: false, reason }` rather than throwing, because every
 * rejection here is a sentence a form needs to print. Persistence is optional
 * and injectable: the store works entirely in memory if no backing is given,
 * and a browser store that throws — a private window, site data blocked — is
 * treated as an absent one rather than as a failure worth stopping for. A lost
 * address book is an inconvenience; a panel that will not open because a
 * storage quota was hit is not.
 */

/** A lower-case 0x address, plus whatever the user called it. */
export interface Recipient {
  address: string;
  /** The user's own note. Never rendered without the address. */
  label: string;
}

export type AddResult =
  | { ok: true; recipient: Recipient; /** True when the entry was already there. */ existing: boolean }
  | { ok: false; reason: string };

/**
 * How many entries are kept.
 *
 * Bounded because the list is drawn in full in a `<select>` and read out of a
 * string store on every mount; there is no paging, and a list past this size is
 * a spreadsheet's job rather than a wallet panel's.
 */
export const MAX_RECIPIENTS = 64;

/** Bound on a label, so a pasted paragraph cannot push the address off the row. */
export const MAX_LABEL_CHARS = 32;

/** The key a browser store keeps the book under. Prefixed like every ats- class. */
export const RECIPIENTS_KEY = "ats-recipients";

export const RECIPIENT_NOTICE =
  "These are addresses somebody typed into this app. Nothing here has been " +
  "checked against a chain: not that the address exists, not that it may hold " +
  "a given security, and not that the name beside it is whose it is. The name " +
  "is a note to yourself and the address is the only part of a row that means " +
  "anything — which is why the device shows you the address and never the name.";

/** The slice of `Storage` this file uses. A test passes a Map-backed stub. */
export interface RecipientStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Printable ASCII, single line, bounded — the same rule `sanitiseText` applies
 * to a symbol read off a chain, applied to text a user typed.
 *
 * A label carrying a direction override reorders the row it sits in, which can
 * make the address next to it appear to be a different address. That is worth
 * refusing whichever side the text came from.
 */
function cleanLabel(label: string): string {
  return [...label.trim()]
    .filter((ch) => {
      const c = ch.codePointAt(0) as number;
      return c >= 0x20 && c <= 0x7e;
    })
    .join("")
    .slice(0, MAX_LABEL_CHARS);
}

/**
 * The book, in memory, optionally mirrored into a store.
 *
 * A class rather than a module-level array so that two panels — mint and send —
 * share one book by being handed the same object, instead of by both reaching
 * for a global that a test cannot reset.
 */
export class RecipientBook {
  private entries: Recipient[] = [];
  /* Written out rather than declared as a constructor parameter property:
   * those are erased by a type checker, not by a stripper, and the test runner
   * here is `node --experimental-strip-types`, which refuses them. */
  private readonly store: RecipientStore | undefined;

  constructor(store?: RecipientStore) {
    this.store = store;
    this.entries = this.load();
  }

  /** A copy, in insertion order. Callers must not be able to edit the book by reference. */
  list(): Recipient[] {
    return this.entries.map((e) => ({ ...e }));
  }

  has(address: string): boolean {
    return this.entries.some((e) => e.address === address.trim().toLowerCase());
  }

  /**
   * Add one address.
   *
   * An address already in the book is `ok` with `existing: true` rather than a
   * refusal: the user asked for it to be there and it is, and an error message
   * for a no-op is a form telling somebody off for being right.
   */
  add(address: string, label = ""): AddResult {
    const trimmed = address.trim();
    if (trimmed === "") return { ok: false, reason: "no address was given" };
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
      return {
        ok: false,
        reason:
          `"${trimmed.slice(0, 24)}" is not a 20-byte address. An address is 0x ` +
          "followed by exactly 40 hexadecimal characters.",
      };
    }
    const lower = trimmed.toLowerCase();
    if (/^0x0{40}$/.test(lower)) {
      return {
        ok: false,
        reason:
          "that is the zero address. Shares sent there are gone and minting to " +
          "it inflates the supply into nothing recoverable.",
      };
    }
    const found = this.entries.find((e) => e.address === lower);
    if (found) return { ok: true, recipient: { ...found }, existing: true };
    if (this.entries.length >= MAX_RECIPIENTS) {
      return {
        ok: false,
        reason: `this book holds ${MAX_RECIPIENTS} addresses; remove one before adding another`,
      };
    }
    const recipient: Recipient = { address: lower, label: cleanLabel(label) };
    this.entries.push(recipient);
    this.save();
    return { ok: true, recipient: { ...recipient }, existing: false };
  }

  /** Remove one. Silent when it was not there — the end state is what was asked for. */
  remove(address: string): void {
    const lower = address.trim().toLowerCase();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.address !== lower);
    if (this.entries.length !== before) this.save();
  }

  /** A row's text, always both halves. See the header. */
  static describe(recipient: Recipient): string {
    return recipient.label === ""
      ? recipient.address
      : `${recipient.address} — ${recipient.label}`;
  }

  private load(): Recipient[] {
    let raw: string | null = null;
    try {
      raw = this.store?.getItem(RECIPIENTS_KEY) ?? null;
    } catch {
      /* A store that throws is an absent store. See the header. */
      return [];
    }
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Recipient[] = [];
      for (const item of parsed) {
        const row = item as { address?: unknown; label?: unknown };
        if (typeof row.address !== "string") continue;
        const lower = row.address.trim().toLowerCase();
        /* Re-validated on the way IN, not only on the way out. The store is
         * shared with anything else running on this origin, so what comes back
         * is untrusted text however it got there. */
        if (!/^0x[0-9a-f]{40}$/.test(lower)) continue;
        if (out.some((e) => e.address === lower)) continue;
        out.push({
          address: lower,
          label: typeof row.label === "string" ? cleanLabel(row.label) : "",
        });
        if (out.length >= MAX_RECIPIENTS) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      this.store?.setItem(RECIPIENTS_KEY, JSON.stringify(this.entries));
    } catch {
      /* Deliberately swallowed: losing the book costs some retyping, and an
       * exception out of `add` would cost the mint the user was in the middle
       * of. The in-memory list is already correct. */
    }
  }
}

/**
 * The browser's `localStorage`, when there is one and it will answer.
 *
 * Probed rather than assumed: the accessor itself throws in some contexts
 * (thumbnail capture, a browser set to block site data), so "is it there" has
 * to be a try/catch and not a truthiness check.
 */
export function browserRecipientStore(): RecipientStore | undefined {
  try {
    const store = (globalThis as { localStorage?: RecipientStore }).localStorage;
    if (!store) return undefined;
    store.getItem(RECIPIENTS_KEY);
    return store;
  } catch {
    return undefined;
  }
}
