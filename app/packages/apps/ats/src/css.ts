/**
 * The ATS apps' stylesheet, in its own module.
 *
 * Extracted from index.ts when the market became a second manifest
 * (`ats-market`): a mini-app declares its own `css`, and two manifests in one
 * package need one stylesheet both can import without index.ts importing the
 * file that imports it back. Till reached the same shape for the same reason
 * (`till/src/css.ts`, three manifests).
 *
 * Every rule is prefixed so it can be deleted with the package — the shell's
 * styles.css must never carry app rules, and a test asserts it.
 */
export const ATS_CSS = `
.ats-panel { display: flex; flex-direction: column; gap: 0.5rem; }
.ats-panel h3 { margin: 0.75rem 0 0; }
.ats-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
.ats-label { min-width: 11rem; opacity: 0.75; }
.ats-address { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ats-table { border-collapse: collapse; width: 100%; }
.ats-table th, .ats-table td {
  text-align: left; padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--border, #444);
}
.ats-muted { opacity: 0.7; font-size: 0.9em; }
.ats-privileged { font-weight: 700; }
/* "Unavailable" must not be mistakable for a value at a glance, which is
   exactly what a greyed-out zero would be. It gets an italic, dotted treatment
   no real figure ever has, so the difference survives a quick read. */
.ats-uncertain {
  color: var(--warn, #b58900); font-style: italic;
  border-bottom: 2px dotted currentColor;
}
.ats-alarm { color: var(--danger, #dc322f); font-weight: 700; }
.ats-notice {
  border: 1px solid var(--danger, #dc322f); border-radius: 6px;
  padding: 0.4rem 0.6rem; font-size: 0.9em;
}
/* The preview of what the device is about to draw. Framed so it reads as a
   quotation of another screen rather than as this one's own assertion — it is
   host text, and the notice inside it says so. */
.ats-screen {
  border: 1px solid var(--border, #444); border-radius: 6px;
  padding: 0.6rem 0.8rem; margin: 0.5rem 0;
}
.ats-screen-title { font-weight: 700; letter-spacing: 0.03em; margin-bottom: 0.4rem; }
/* The chooser. The fixture sits in the same list as the real securities and is
   labelled in the list itself, not only once it is loaded — a demo that looks
   like the others until you have clicked it is a demo somebody quotes. */
.ats-chooser { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
.ats-demo { font-style: italic; }
`;
