/**
 * The bill: what the waiter typed, the tip, and the exact number of raw token
 * units the customer must send.
 *
 * ---------------------------------------------------------------------------
 * No floats, anywhere, ever
 *
 * A tip is a percentage of a price, which is the classic place to introduce a
 * float and then pay someone the result of it. `284.53 * 1.15` is
 * 327.20949999999996 in IEEE 754, and a terminal that rounds that at the wrong
 * moment produces a total that does not equal base + tip — which a customer
 * will notice, and which makes shift-close reconciliation (C4) an argument
 * instead of a sum. So every quantity below is a bigint of CENTS from the
 * moment the waiter's keystrokes are parsed, the tip is computed by integer
 * multiply-and-divide, and the total is literally `base + tip`. No Number
 * touches a payable figure between the keypad and the QR.
 *
 * Rounding on the tip is half-up on the cent, the rule people already expect
 * from every till they have used. It is applied once, to the tip, so that
 * base + tip = total by construction rather than by luck.
 *
 * ---------------------------------------------------------------------------
 * Sub-cent entropy, and why the total is not round
 *
 * $284.53 is charged as $284.5317. The extra hundredths of a cent are not a
 * fee and nobody's margin: they are how the payment watcher (C3) tells two
 * open tables apart. A customer pays from their own wallet, on a chain of their
 * choosing, to one merchant address — so the only thing distinguishing table
 * four's payment from table nine's, before per-order addresses exist, is the
 * amount. Two tables that both owe $284.53 would produce two identical
 * transfers and the terminal would have no way to say which one arrived; it
 * would mark the wrong table paid, and the second customer would be asked to
 * pay again for something the merchant already has.
 *
 * A hundredth of a cent is the right size for that marker: 100 distinct open
 * orders, and a customer overpaying by at most $0.0099 — below the resolution
 * of any currency involved, and far below the gas they are already paying.
 * Sub-cent digits also survive the trip through the URI exactly, because the
 * units are integers all the way down.
 *
 * This needs at least 4 decimals of token precision. USDC and EURC have 6, so
 * there are two spare digits; a hypothetical 2-decimal token gets no marker
 * rather than a mangled amount, and the watcher would then have to fall back
 * on something else.
 */

/** Cents, exact. `284.53` is `28453n`. */
export type Cents = bigint;

/** The presets a waiter can hit without typing. Percentages, whole numbers. */
export const TIP_PRESETS: readonly number[] = [10, 15] as const;

export type Tip =
  | { kind: "percent"; percent: number }
  /** A waiter-typed amount, already in cents. Not a percentage of anything. */
  | { kind: "amount"; cents: Cents };

export interface Order {
  base: Cents;
  tip: Cents;
  total: Cents;
}

export type ParseResult =
  | { ok: true; cents: Cents }
  | { ok: false; reason: string };

/**
 * "284.53" → 28453n. Refuses rather than truncates.
 *
 * Written by hand instead of via Number so that a third decimal place is an
 * error a waiter can see and fix, not a cent that silently disappears out of
 * somebody's takings.
 */
export function parseCents(input: string): ParseResult {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return { ok: false, reason: "Enter an amount." };
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) {
    return {
      ok: false,
      reason: /^\d+\.\d{3,}$/.test(text)
        ? "Amounts are in cents; that has more than two decimal places."
        : `"${text.slice(0, 16)}" is not an amount.`,
    };
  }
  const whole = BigInt(m[1] as string);
  const frac = (m[2] ?? "").padEnd(2, "0");
  return { ok: true, cents: whole * 100n + BigInt(frac) };
}

/** 28453n → "284.53". Integer arithmetic; the string is built, not formatted. */
export function formatCents(cents: Cents): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * The tip in cents. Half-up on the cent, computed once.
 *
 * `(base * percent + 50) / 100` with bigint division truncating toward zero is
 * exactly half-up for non-negative inputs, and the amounts here are never
 * negative — a negative bill is not a thing a till can produce.
 */
export function tipCents(base: Cents, tip: Tip): Cents {
  if (tip.kind === "amount") return tip.cents;
  return (base * BigInt(tip.percent) + 50n) / 100n;
}

export function buildOrder(base: Cents, tip: Tip): Order {
  const t = tipCents(base, tip);
  // Not a rounded product: the total IS base + tip, so the three figures on
  // the screen add up in front of the customer.
  return { base, tip: t, total: base + t };
}

/**
 * Cents → the token's raw units, plus the sub-cent order marker.
 *
 * `marker` is 0–99 hundredths of a cent. The caller picks it (the watcher will
 * own the allocation in C3); this function only places it, so the encoding of
 * an order id into an amount is one line in one place.
 */
export function payableUnits(total: Cents, decimals: number, marker: number): bigint {
  if (!Number.isInteger(marker) || marker < 0 || marker > 99) {
    throw new RangeError("order marker must be 0..99");
  }
  if (decimals < 2) throw new RangeError("a token with fewer than 2 decimals cannot carry a cent");
  const cents = total * 10n ** BigInt(decimals - 2);
  // Below 4 decimals there is no room under the cent; charge the round figure
  // rather than corrupting it, and let matching fall back to something else.
  if (decimals < 4 || marker === 0) return cents;
  return cents + BigInt(marker) * 10n ** BigInt(decimals - 4);
}

/**
 * A marker for a new order. Random rather than sequential: a terminal that
 * restarts loses its counter and would then reissue markers it has open bills
 * against, which is the collision this exists to prevent.
 */
export function newMarker(random: () => number = Math.random): number {
  return Math.floor(random() * 100) % 100;
}
