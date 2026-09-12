/**
 * The recipient book.
 *
 * It is a list of strings somebody typed, and the tests are mostly about that:
 * nothing here is evidence about anybody, so the checks are that a bad address
 * cannot enter the book, that a label cannot repaint the row its address sits
 * in, and that what comes back out of a shared browser store is re-validated
 * rather than trusted for having been written by us.
 *
 * The other property is that a store which will not answer is an ABSENT store,
 * never an error: losing an address book costs some retyping, while an
 * exception out of `add` costs whoever was halfway through a mint.
 */

import {
  MAX_LABEL_CHARS, MAX_RECIPIENTS, RECIPIENTS_KEY, RecipientBook,
  browserRecipientStore, type RecipientStore,
} from "../src/recipients.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const A = "0xbDEB381a7c77040bf2a99E2990C116774CCb339f";
const B = "0x9c77c6fafc1eb0821F1De12972Ef0199C97C6e45";

const memoryStore = (): RecipientStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
};

group("what may enter the book");
{
  const book = new RecipientBook();
  check(book.list().length === 0, "a fresh book is not empty");

  const added = book.add(A, "Device");
  check(added.ok && !added.existing, "a new address was not added");
  /* Stored lower-case, because a case-different duplicate is the same address
   * and a book that holds both makes a person choose between them. */
  check(book.list()[0]?.address === A.toLowerCase(), "the address was not lower-cased");
  check(book.has(`0x${A.slice(2).toUpperCase()}`), "lookup is case-sensitive");

  /* `0x` + upper-case body: the same address typed differently. The prefix
   * itself stays lower-case, because `0X…` is not an address any tool emits. */
  const again = book.add(`0x${A.slice(2).toUpperCase()}`, "Device again");
  check(again.ok && again.existing, "re-adding an address was not reported as already there");
  check(book.list().length === 1, "re-adding an address duplicated it");

  for (const bad of ["", "0x123", "not an address", `${A}ff`, "0x".padEnd(42, "z")]) {
    const result = book.add(bad);
    check(!result.ok, `"${bad}" was accepted as an address`);
  }
  const zero = book.add("0x0000000000000000000000000000000000000000");
  check(!zero.ok && /zero address/.test(zero.reason), "the zero address was accepted");

  book.remove(A);
  check(book.list().length === 0, "remove did not remove");
  book.remove(A);
  check(book.list().length === 0, "removing an absent address changed the book");
}

group("a label cannot repaint the row it sits in");
{
  const book = new RecipientBook();
  book.add(A, "Alice‮evil");
  check(!(book.list()[0]?.label ?? "").includes("‮"),
    "a direction override survived into a label");
  book.add(B, "x".repeat(MAX_LABEL_CHARS + 40));
  check((book.list()[1]?.label.length ?? 0) <= MAX_LABEL_CHARS, "a label was not bounded");

  /* The address is always in the rendered row. A book that renders "Alice"
   * alone is a phishing surface: the name is a note, the address is the fact. */
  const described = RecipientBook.describe(book.list()[0] as { address: string; label: string });
  check(described.includes(A.toLowerCase()), "a described row omits the address");
  const unlabelled = RecipientBook.describe({ address: A.toLowerCase(), label: "" });
  check(unlabelled === A.toLowerCase(), "an unlabelled row is not just its address");
}

group("the book is bounded");
{
  const book = new RecipientBook();
  /* From 1: address zero is refused on its own merits, and filling the book
   * with it would be testing the bound against the wrong refusal. */
  for (let i = 1; i <= MAX_RECIPIENTS; i++) {
    const filler = `0x${i.toString(16).padStart(40, "0")}`;
    check(book.add(filler).ok, `filling the book failed at ${i}`);
  }
  const over = book.add(A);
  check(!over.ok && /remove one/.test(over.reason), "the book grew past its bound");
}

group("persistence, and a store that is allowed to be absent or hostile");
{
  const store = memoryStore();
  const first = new RecipientBook(store);
  first.add(A, "Device");
  first.add(B, "Issuer");
  check(store.map.get(RECIPIENTS_KEY) !== undefined, "nothing was written to the store");

  const second = new RecipientBook(store);
  check(second.list().length === 2, "the book did not come back from the store");
  check(second.list()[0]?.address === A.toLowerCase(), "the order was not preserved");

  /* What comes back is untrusted text however it got there: the store is shared
   * with everything else on this origin. */
  store.map.set(RECIPIENTS_KEY, JSON.stringify([
    { address: "not an address", label: "x" },
    { address: A, label: "ok" },
    { address: A.toLowerCase(), label: "dupe" },
    { address: 42, label: "x" },
    { address: B, label: "Bad‮Label" },
  ]));
  const third = new RecipientBook(store);
  check(third.list().length === 2, `${third.list().length} entries survived, expected 2`);
  check(!(third.list()[1]?.label ?? "").includes("‮"),
    "a stored label was not re-cleaned on the way in");

  store.map.set(RECIPIENTS_KEY, "{ not json");
  check(new RecipientBook(store).list().length === 0, "unparseable storage was not ignored");
  store.map.set(RECIPIENTS_KEY, JSON.stringify({ nope: true }));
  check(new RecipientBook(store).list().length === 0, "a non-array in storage was not ignored");

  /* A store that throws is an absent store, on read and on write. */
  const hostile: RecipientStore = {
    getItem: () => { throw new Error("site data blocked"); },
    setItem: () => { throw new Error("quota exceeded"); },
  };
  const resilient = new RecipientBook(hostile);
  check(resilient.list().length === 0, "a throwing store produced entries");
  const result = resilient.add(A);
  check(result.ok, "a throwing store made add fail");
  check(resilient.list().length === 1, "the in-memory book lost an entry a store could not save");

  /* No `localStorage` in node, and probing for it must not throw. */
  check(browserRecipientStore() === undefined,
    "a browser store was reported where there is none");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
