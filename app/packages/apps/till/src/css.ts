/**
 * The stylesheet both halves of La Caja draw with.
 *
 * One string, shared by the cashier's app and the waiter's, because they are
 * one product on two devices and a second copy would drift the day somebody
 * restyled a rail row. The shell installs it per app id (registry.ts), so a
 * waiter's phone that mounts only the waiter app still gets it.
 */

export const TILL_CSS = `
.till { display: flex; flex-direction: column; gap: 0.9rem; }
.till-keypad { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.till-keypad input { font-size: 1.4rem; width: 8rem; padding: 0.3rem 0.5rem; }
.till-tips { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.till-tips button[aria-pressed="true"] { outline: 2px solid var(--accent, #268bd2); }
.till-error { color: var(--danger, #dc322f); margin: 0; }
.till-totals { display: flex; flex-direction: column; gap: 0.2rem; }
.till-line { display: flex; gap: 0.6rem; justify-content: space-between; }
.till-line:last-child .till-value { font-size: 1.3rem; font-weight: 700; }
.till-label { opacity: 0.75; }
.till-tone-muted .till-value { color: var(--muted, #999); }
.till-tone-warn .till-value { color: var(--warn, #b58900); }
.till-tone-unavailable .till-value {
  color: var(--warn, #b58900); font-style: italic; border-bottom: 2px dotted currentColor;
}
.till-rails { display: flex; flex-direction: column; gap: 0.35rem; }
.till-rails h4 { margin: 0.3rem 0 0; }
.till-rail {
  display: flex; flex-direction: column; gap: 0.15rem; text-align: left;
  padding: 0.5rem; border: 1px solid var(--border, #444); border-radius: 6px;
  background: none; color: inherit; font: inherit; cursor: pointer;
}
.till-rail-selected { outline: 2px solid var(--accent, #268bd2); }
/* A rail that cannot take this token must not look like one that can, at any
   glance length. Struck through, not merely faded. */
.till-rail:disabled { cursor: not-allowed; opacity: 0.55; }
.till-rail:disabled .till-rail-name { text-decoration: line-through; }
.till-rail-cost { font-size: 0.85em; opacity: 0.7; }
.till-rail-reason { font-size: 0.8em; font-style: italic; color: var(--warn, #b58900); }
.till-rail-warning { font-size: 0.8em; color: var(--danger, #dc322f); }
.till-charge { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-start; }
.till-amount { font-weight: 700; margin: 0; word-break: break-all; }
.till-uri { font-size: 0.75em; opacity: 0.75; word-break: break-all; }
.till-codes { display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: flex-start; }
.till-code { display: grid; gap: 0.4rem; justify-items: center; max-width: 15rem; }
.till-code-label { font-size: 0.8em; font-weight: 600; margin: 0; }
.till-code-note { font-size: 0.72em; opacity: 0.7; margin: 0; text-align: center; }
.till-actions { display: flex; gap: 0.5rem; align-items: center; }
.till-watch { display: flex; flex-direction: column; gap: 0.4rem; }
.till-watch-rows { display: flex; flex-direction: column; gap: 0.25rem; }
.till-watch-row { display: flex; flex-direction: column; }
.till-watch-chain { font-weight: 600; }
.till-watch-detail { font-size: 0.75em; opacity: 0.7; word-break: break-all; }
.till-watch-headline { font-size: 1.1rem; font-weight: 700; margin: 0.4rem 0 0; }
/* The five tones are visually distinct on purpose, and "unknown" is styled
   like nothing else on the screen: a greyed-out "no payment" and an outage
   that looked the same at a glance is the failure this app is built around.
   The words differ too — see watch-view.ts; the colour is the second line of
   defence, never the first. */
.till-watch-paid { color: var(--ok, #859900); font-weight: 700; }
.till-watch-seen { color: var(--accent, #268bd2); }
.till-watch-none { color: var(--muted, #999); }
.till-watch-unpayable { color: var(--muted, #999); font-style: italic; }
.till-watch-unknown {
  color: var(--warn, #b58900); font-style: italic;
  border-bottom: 2px dotted currentColor;
}
.till-notices p { font-size: 0.8em; opacity: 0.75; margin: 0.2rem 0; }
/* The waiter's screen is read at a table, upside down, by somebody deciding
   what to send. The payable figure is the largest thing on it and the label
   above it says what it is; everything else is smaller than the number. */
.till-waiter { display: flex; flex-direction: column; gap: 0.5rem; }
.till-waiter-merchant { font-size: 1rem; font-weight: 600; margin: 0; }
.till-waiter-label { font-size: 0.8em; opacity: 0.75; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; }
.till-waiter-total { font-size: 2rem; font-weight: 700; margin: 0; word-break: break-all; }
.till-waiter-bill { font-size: 0.8em; opacity: 0.7; margin: 0; }
`;
