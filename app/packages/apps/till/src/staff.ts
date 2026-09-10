/**
 * The staff registry, and the CSV parser that fills it.
 *
 * ---------------------------------------------------------------------------
 * This file is a security boundary, not a convenience
 *
 * Everything else in La Caja moves money *towards* the merchant: a bill, a QR,
 * a watcher. Payroll is the first thing here that moves money *away*, and the
 * list of who gets paid arrives as a file somebody was handed. A payroll file
 * is therefore untrusted input that decides recipients and totals, which puts
 * it in the same category as a scanned QR (see `acceptRequest` in request.ts)
 * and not in the same category as a spreadsheet import.
 *
 * The threat is not "the file is corrupt". It is: a row that renders on screen
 * as one thing and pays another. Three concrete versions of it, and what stops
 * each one:
 *
 *  1. **Columns in an order the reader assumed.** `name,role,address,amount`
 *     and `name,role,amount,address` are both plausible files, and a parser
 *     that guessed by position would read the amount as an address on one of
 *     them — or, worse, an address as an amount. So a HEADER IS REQUIRED, the
 *     four names are matched by name, and an unknown, missing or repeated
 *     column fails the import. Nothing here infers a layout.
 *
 *  2. **An amount that is not the number it looks like.** `1e3`, `0x10`,
 *     `1,000`, ` 12 `, `12.3456789` in a 6-decimal token, `-5`. Every one of
 *     those has a "reasonable" coercion and every coercion is somebody being
 *     paid a figure nobody typed. The shape is pinned by a regular expression,
 *     the arithmetic is integer (core's `parseUnits`), and a scale the token
 *     cannot hold is refused rather than truncated.
 *
 *  3. **A name that lies about the row.** A right-to-left override or a
 *     newline inside a quoted field can make a rendered line read as a
 *     different row than the one that pays. Text fields are restricted to
 *     printable ASCII, and control characters and bidi marks are a refusal.
 *
 * ---------------------------------------------------------------------------
 * Reject, never repair, and never skip
 *
 * One bad row fails the whole import, with the reason and the 1-based line
 * number of the offending line. The alternatives were both considered:
 *
 *   - *Skip the bad rows and import the rest.* Then the total on the approval
 *     screen is a total over a set the user never chose, and the person whose
 *     row was dropped is simply not paid — silently, on a screen that looks
 *     successful. A payroll that quietly pays 11 of 12 people is worse than one
 *     that refuses to load.
 *   - *Repair.* Trim the address, drop the thousands separator, round the
 *     amount to the token's decimals. Each is a guess about intent applied to
 *     money, and the file can be edited and re-imported in seconds.
 *
 * So the return type is "everything, or a line number and a sentence". There
 * is no partial success in this module.
 *
 * ---------------------------------------------------------------------------
 * Why CSV and not PDF
 *
 * The brief asked for "CSV or a PDF or anything". PDF is not implemented and
 * should not be, and the reasoning belongs next to the parser rather than in a
 * commit message:
 *
 *   - A PDF parser is a runtime dependency of tens of thousands of lines
 *     (pdf.js and friends), inside a wallet whose mini-apps are audited by an
 *     import allow-list of five entries (test/no-signing.test.ts). It is
 *     historically one of the richest sources of memory-safety and
 *     content-spoofing bugs in client software.
 *   - Text extraction from a PDF is *lossy and ambiguous by design*. Column
 *     order comes from glyph coordinates, not from structure; two visually
 *     identical documents can extract to different column orders; a glyph can
 *     be drawn at a position that has nothing to do with its logical order.
 *     Rule (1) above — never infer a layout — cannot be honoured against a
 *     format whose layout must be inferred.
 *   - The failure mode is exactly the one this file exists to prevent: a
 *     document that *renders* as "Ana — 500 USDC" and extracts as something
 *     else. The user would be approving what they read, not what would be sent.
 *
 * The mitigation people usually reach for — show the extracted rows for
 * confirmation — is what CSV gives already, without the dependency. So the app
 * takes CSV, and takes pasted text as the same parser, and says so on screen.
 * If a payroll arrives as a PDF, the correct answer is to export it as CSV in
 * whatever produced it, where the column mapping is decided by someone who can
 * see both.
 */

import { AbiError, parseUnits } from "@leekwallet/core/balances.ts";
import { checksumAddress } from "@leekwallet/core/tx-interpret.ts";

/* ------------------------------------------------------------------ bounds */

/**
 * The most people one payroll run may carry.
 *
 * This is a count of BUTTON PRESSES ON THE DEVICE, not a rendering limit: the
 * shell has no batch call (see payroll.ts), so a run of N people is N
 * proposals and N hardware confirmations. Thirty-two is already a long sitting;
 * beyond it nobody reads the screens, which turns hardware confirmation into a
 * clicking exercise and removes the only defence that matters.
 *
 * A file above the cap is REFUSED, never truncated. Truncation would pay the
 * first 32 people and silently drop the rest.
 */
export const MAX_STAFF = 32;

/** Bounds on the two host-side labels. Long enough for a real name, short
 *  enough that a row cannot become a paragraph that pushes the total off screen. */
export const MAX_NAME = 40;
export const MAX_ROLE = 24;

/**
 * The largest file this will look at, in UTF-16 code units of the decoded
 * text. A cap before parsing rather than after: an unbounded string from a
 * file picker is a memory question, and 256 KB is two orders of magnitude more
 * than `MAX_STAFF` rows can occupy.
 */
export const MAX_INPUT_CHARS = 256 * 1024;

/* ------------------------------------------------------------------- types */

/**
 * One person on the payroll.
 *
 * `name` and `role` are HOST-SIDE TEXT and nothing more. They come from a file
 * the host read; the device has never seen them and cannot attest to them, so
 * no screen may present them as though it had. The only fact that decides
 * where money goes is `address`, and the device draws that itself. The view
 * layer states this in words rather than relying on this comment.
 */
export interface StaffMember {
  /** 1-based line in the imported text; 0 for a row typed into the app. */
  readonly line: number;
  readonly name: string;
  readonly role: string;
  /** EIP-55 checksummed, 20 bytes, non-zero. */
  readonly address: string;
  /** The amount exactly as written, validated. Scaled to units in payroll.ts. */
  readonly amount: DecimalAmount;
}

/**
 * A decimal amount held as the text that was typed, plus its scale.
 *
 * Not a number, and deliberately not units either. Units require the token's
 * decimals, and the token can be changed on the screen after the file is
 * imported — a row converted at import time would be a stale figure the moment
 * somebody switched USDC for cirBTC (6 decimals versus 8). So the row keeps
 * the exact characters, and conversion happens once, at the point the calldata
 * is built, where the deployment is known.
 */
export interface DecimalAmount {
  /** The literal text, e.g. "1250.75". Digits and at most one dot. */
  readonly text: string;
  /** Digits after the dot. A token with fewer decimals cannot pay this row. */
  readonly scale: number;
}

/** A recipient that appears more than once. Reported, never merged. */
export interface Duplicate {
  readonly address: string;
  /** Every line it appeared on, in order. Length is always >= 2. */
  readonly lines: readonly number[];
}

export type ImportResult =
  | {
      ok: true;
      staff: readonly StaffMember[];
      /**
       * Non-empty only when the caller passed `allowDuplicates`. Present so
       * the screen can say "3 recipients appear twice" over the run it is
       * about to approve, rather than the user discovering it in a block
       * explorer.
       */
      duplicates: readonly Duplicate[];
    }
  | {
      ok: false;
      /** 1-based line in the input, or 0 for a whole-file complaint. */
      line: number;
      reason: string;
    };

export interface ImportOptions {
  /**
   * Accept a file in which one address is paid twice.
   *
   * Off by default and it must stay a deliberate act: a duplicated row is
   * usually a copy-paste, and paying somebody twice is not recoverable by the
   * app. When it is on, every duplicate is reported back so the confirmation
   * can name the count.
   */
  readonly allowDuplicates?: boolean;
}

/* ------------------------------------------------------------- field rules */

/** Exactly 20 bytes of hex with the prefix. Length is checked here, not implied. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/** The zero address: a valid-looking hex string that burns whatever is sent. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * A positive decimal, written plainly.
 *
 * No exponent, no sign, no separators, no hex, no leading dot. Twelve integer
 * digits is a trillion units of anything, which is past any payroll and short
 * of the point where a uint256 is in question. Eighteen fractional digits is
 * the most decimals any ERC-20 in this wallet's tables claims.
 */
const AMOUNT_SHAPE = /^\d{1,12}(?:\.\d{1,18})?$/;

/**
 * Printable ASCII only, for `name` and `role`.
 *
 * The exclusion is the point rather than the inclusion: C0/C1 control codes,
 * the bidi overrides (U+202A..U+202E, U+2066..U+2069) and the zero-width marks
 * can all make a rendered row read as a different row than the one that pays.
 * A restaurant with accented names in its payroll will hit this and can widen
 * it — deliberately, in a diff, with somebody looking at what a widened set
 * lets a row do to a line of text.
 */
const TEXT_SHAPE = /^[ -~]*$/;

/**
 * Leading characters a spreadsheet treats as the start of a formula.
 *
 * A name of `=HYPERLINK(...)` is inert here and becomes live the moment
 * somebody exports the run and opens it in Excel. Refusing at import costs a
 * legitimate row starting with `-` (nobody's name) and removes this app from
 * the middle of a CSV-injection chain.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** The four columns, and the only four. */
const COLUMNS = ["name", "role", "address", "amount"] as const;
type Column = (typeof COLUMNS)[number];

/* -------------------------------------------------------------- CSV lexing */

/**
 * Split CSV text into rows of fields.
 *
 * A minimal RFC 4180 subset — comma separator, `"` quoting, `""` for a literal
 * quote — written here rather than pulled in, because a CSV dependency would
 * be a runtime dependency in a package whose imports are an audited list of
 * five, and because every liberty a general parser takes (other delimiters,
 * sniffed encodings, ragged rows) is a liberty taken with a payment list.
 *
 * An unterminated quote is an error with the line it opened on, not a field
 * that swallows the rest of the file — that swallow is precisely how a
 * malicious row hides the rows below it from the screen.
 */
function lexCsv(text: string): { ok: true; rows: string[][]; lines: number[] } | { ok: false; line: number; reason: string } {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteOpenedAt = 1;
  let line = 1;
  let rowStart = 1;
  /* True once anything belonging to the current row has been consumed, so that
   * the terminating newline at the end of a file is a terminator rather than
   * an empty final row. */
  let pending = false;

  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    lines.push(rowStart);
    row = [];
    pending = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      /* Only at the start of a field. A quote in the middle of unquoted text
       * is a malformed row, not a quote to be interpreted generously. */
      if (field !== "") return { ok: false, line, reason: `a quote appears in the middle of a field` };
      quoted = true;
      quoteOpenedAt = line;
      pending = true;
      continue;
    }
    if (c === ",") { row.push(field); field = ""; pending = true; continue; }
    if (c === "\r") {
      // CRLF only; a lone CR is an old-Mac line ending and this refuses to guess.
      if (text[i + 1] !== "\n") return { ok: false, line, reason: `a carriage return that is not part of a line ending` };
      continue;
    }
    if (c === "\n") { endRow(); line++; rowStart = line; continue; }
    field += c;
    pending = true;
  }
  if (quoted) return { ok: false, line: quoteOpenedAt, reason: `a quoted field is never closed` };
  // A trailing newline is a terminator, not an empty final row.
  if (pending) endRow();

  return { ok: true, rows, lines };
}

/* ------------------------------------------------------------ field checks */

/** A text field, or the reason it is not one. */
function checkText(value: string, what: string, max: number): { ok: true; text: string } | { ok: false; reason: string } {
  /* Surrounding spaces are removed and nothing else is: a name is a label and
   * an editor adding a space after a comma is not a claim about anything. The
   * ADDRESS and the AMOUNT are trimmed by the same rule and then have to match
   * their shapes exactly, so no trim can turn a bad value into a good one. */
  const text = value.trim();
  if (text === "") return { ok: false, reason: `${what} is empty` };
  if (text.length > max) return { ok: false, reason: `${what} is longer than ${max} characters` };
  if (!TEXT_SHAPE.test(text)) {
    return { ok: false, reason: `${what} contains a character that is not printable ASCII` };
  }
  if (FORMULA_LEAD.test(text)) {
    return { ok: false, reason: `${what} starts with a character a spreadsheet reads as a formula` };
  }
  return { ok: true, text };
}

/**
 * An address, or the reason it is not one.
 *
 * The EIP-55 rule is the interesting one: a MIXED-CASE address carries a
 * checksum, and a checksum that does not verify means a character was changed
 * after the address was written. An all-lower-case (or all-upper-case) address
 * carries no checksum and cannot be checked at all — it is accepted, and
 * returned in checksummed form so that everything downstream, including the
 * screen, shows the one canonical spelling.
 */
export function checkAddress(value: string): { ok: true; address: string } | { ok: false; reason: string } {
  const raw = value.trim();
  if (!ADDRESS_SHAPE.test(raw)) {
    return { ok: false, reason: `"${raw.slice(0, 24)}" is not a 20-byte 0x address` };
  }
  const address = checksumAddress(raw.slice(2));
  if (address.toLowerCase() === ZERO_ADDRESS) {
    return { ok: false, reason: `the zero address cannot be paid` };
  }
  const body = raw.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && raw !== address) {
    return { ok: false, reason: `${raw.slice(0, 12)}… fails its EIP-55 checksum, so a character in it is wrong` };
  }
  return { ok: true, address };
}

/** An amount, or the reason it is not one. Shape only; scale is applied later. */
export function checkAmount(value: string): { ok: true; amount: DecimalAmount } | { ok: false; reason: string } {
  const text = value.trim();
  if (!AMOUNT_SHAPE.test(text)) {
    return {
      ok: false,
      reason:
        `"${text.slice(0, 24)}" is not a plain positive decimal amount ` +
        `(no sign, no exponent, no thousands separator)`,
    };
  }
  const dot = text.indexOf(".");
  const scale = dot === -1 ? 0 : text.length - dot - 1;
  /* "0", "0.00" and "0.000000" all pass the shape and are all a transfer of
   * nothing, which is a press on the device and a fee for no effect. */
  if (/^0*(\.0*)?$/.test(text)) return { ok: false, reason: `an amount of zero is not a payment` };
  return { ok: true, amount: { text, scale } };
}

/**
 * Raw token units for a row, or the reason this token cannot pay it.
 *
 * Integer arithmetic throughout — core's `parseUnits`, which refuses a
 * fractional part longer than the token's decimals rather than truncating it.
 * That refusal is the whole reason conversion is deferred to here: 0.5 USDC is
 * payable, 0.000000001 USDC is not, and which it is depends on a token the
 * user can still change.
 */
export function unitsFor(amount: DecimalAmount, decimals: number): { ok: true; units: bigint } | { ok: false; reason: string } {
  try {
    return { ok: true, units: parseUnits(amount.text, decimals) };
  } catch (e) {
    if (e instanceof AbiError) return { ok: false, reason: e.message };
    throw e;
  }
}

/* ------------------------------------------------------------------ import */

/**
 * Parse a payroll file into a registry, or refuse it with a line number.
 *
 * The only entry point. Hand-entered rows go through `staffFromFields` below,
 * which shares every rule so a row typed in cannot be one the file could not
 * have carried.
 */
export function importStaffCsv(input: string, options: ImportOptions = {}): ImportResult {
  if (input.length > MAX_INPUT_CHARS) {
    return { ok: false, line: 0, reason: `that file is larger than ${MAX_INPUT_CHARS} characters` };
  }
  /* A UTF-8 BOM is an encoding artefact rather than data — it is what a
   * Windows spreadsheet writes — and leaving it in would make the first header
   * cell "﻿name", which is a rejection nobody could act on. Removing it is
   * the one normalisation in this file and it can only affect the first
   * character of the header. */
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === "") return { ok: false, line: 0, reason: `the file is empty` };

  const lexed = lexCsv(text);
  if (!lexed.ok) return { ok: false, line: lexed.line, reason: lexed.reason };

  /* Blank lines are dropped BEFORE the header is located, so a file that opens
   * with an empty line is not a file whose header is missing. A line that is
   * blank carries no row and no claim; a line with a stray comma does, and
   * fails the column count below. */
  const rows: { fields: string[]; line: number }[] = [];
  for (let i = 0; i < lexed.rows.length; i++) {
    const fields = lexed.rows[i] as string[];
    if (fields.every((f) => f.trim() === "")) continue;
    rows.push({ fields, line: lexed.lines[i] as number });
  }
  if (rows.length === 0) return { ok: false, line: 0, reason: `the file has no rows` };

  /* --- the header, which is required. See rule (1) in the file header. --- */
  const header = rows[0] as { fields: string[]; line: number };
  const names = header.fields.map((f) => f.trim().toLowerCase());
  const index: Partial<Record<Column, number>> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    if (!(COLUMNS as readonly string[]).includes(name)) {
      return {
        ok: false,
        line: header.line,
        reason:
          `the header names a column this app does not know: "${name.slice(0, 24)}". ` +
          `The header must be name, role, address and amount, in any order.`,
      };
    }
    if (index[name as Column] !== undefined) {
      return { ok: false, line: header.line, reason: `the header names "${name}" twice` };
    }
    index[name as Column] = i;
  }
  for (const column of COLUMNS) {
    if (index[column] === undefined) {
      return {
        ok: false,
        line: header.line,
        reason:
          `the header has no "${column}" column. A payroll file must say which ` +
          `column is which; this app will not guess from the order.`,
      };
    }
  }

  const body = rows.slice(1);
  if (body.length === 0) return { ok: false, line: header.line, reason: `the file has a header and no people` };
  if (body.length > MAX_STAFF) {
    return {
      ok: false,
      line: (body[MAX_STAFF] as { line: number }).line,
      reason:
        `${body.length} people, and this app pays at most ${MAX_STAFF} in one run — ` +
        `every payment is a separate confirmation on the device. Split the file.`,
    };
  }

  const staff: StaffMember[] = [];
  const seen = new Map<string, number[]>();
  for (const { fields, line } of body) {
    if (fields.length !== names.length) {
      return {
        ok: false,
        line,
        reason: `this row has ${fields.length} fields and the header has ${names.length}`,
      };
    }
    const name = checkText(fields[index.name as number] as string, "the name", MAX_NAME);
    if (!name.ok) return { ok: false, line, reason: name.reason };
    const role = checkText(fields[index.role as number] as string, "the role", MAX_ROLE);
    if (!role.ok) return { ok: false, line, reason: role.reason };
    const address = checkAddress(fields[index.address as number] as string);
    if (!address.ok) return { ok: false, line, reason: address.reason };
    const amount = checkAmount(fields[index.amount as number] as string);
    if (!amount.ok) return { ok: false, line, reason: amount.reason };

    const key = address.address.toLowerCase();
    seen.set(key, [...(seen.get(key) ?? []), line]);
    staff.push({ line, name: name.text, role: role.text, address: address.address, amount: amount.amount });
  }

  const duplicates: Duplicate[] = [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([address, lines]) => ({ address: checksumAddress(address.slice(2)), lines }));

  if (duplicates.length > 0 && options.allowDuplicates !== true) {
    const first = duplicates[0] as Duplicate;
    return {
      ok: false,
      line: first.lines[1] as number,
      reason:
        `${duplicates.length} recipient${duplicates.length === 1 ? "" : "s"} appear more than once ` +
        `(${first.address.slice(0, 10)}… on lines ${first.lines.join(", ")}). ` +
        `Paying an address twice is not something this app will assume you meant.`,
    };
  }

  return { ok: true, staff, duplicates };
}

/**
 * A hand-entered row, held to every rule the file is held to.
 *
 * Shared rather than re-implemented so that "typed in" is never a way past a
 * check — the add form and the importer are the same validator with different
 * plumbing.
 */
export function staffFromFields(
  fields: { name: string; role: string; address: string; amount: string },
): { ok: true; member: StaffMember } | { ok: false; reason: string } {
  const name = checkText(fields.name, "the name", MAX_NAME);
  if (!name.ok) return { ok: false, reason: name.reason };
  const role = checkText(fields.role, "the role", MAX_ROLE);
  if (!role.ok) return { ok: false, reason: role.reason };
  const address = checkAddress(fields.address);
  if (!address.ok) return { ok: false, reason: address.reason };
  const amount = checkAmount(fields.amount);
  if (!amount.ok) return { ok: false, reason: amount.reason };
  return {
    ok: true,
    member: { line: 0, name: name.text, role: role.text, address: address.address, amount: amount.amount },
  };
}

/** Every address paid more than once in a registry. Same shape as an import's. */
export function duplicatesIn(staff: readonly StaffMember[]): Duplicate[] {
  const seen = new Map<string, number[]>();
  for (let i = 0; i < staff.length; i++) {
    const member = staff[i] as StaffMember;
    const key = member.address.toLowerCase();
    // Index within the registry when the row was typed rather than imported:
    // a line number of 0 for three hand-entered rows would name none of them.
    seen.set(key, [...(seen.get(key) ?? []), member.line === 0 ? -(i + 1) : member.line]);
  }
  return [...seen.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([address, lines]) => ({ address: checksumAddress(address.slice(2)), lines }));
}
