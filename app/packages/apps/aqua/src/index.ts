/**
 * The Aqua mini-app, as one object the shell can mount and delete.
 *
 * ---------------------------------------------------------------------------
 * How to remove this app from a release build
 *
 * Delete `app/packages/apps/aqua/` and delete its entry from
 * `app/src/apps/registry.ts`. That is the whole procedure, and the build then
 * compiles with no aqua code in it at all — not a flag that hides a screen, an
 * actual absence from the bundle.
 *
 * Three rules make that true and each of them is a rule rather than a habit:
 *
 * 1. **Nothing outside this directory imports anything inside it, except the
 *    registry.** One edge, in one file, so removal is one deletion. Grep for
 *    `apps/aqua` to check; the registry entry should be the only hit.
 * 2. **This app imports no other app.** Apps talk to `@leekwallet/core` and to
 *    nothing else of the companion's. Two apps that share a helper would make
 *    deleting either of them a code change in the other.
 * 3. **Its stylesheet travels with it, as a string.** A rule in the shell's
 *    `styles.css` would survive the directory being deleted and would be dead
 *    CSS nobody could attribute. The registry injects `AQUA_APP.css` when it
 *    mounts; delete the app and the CSS goes with it.
 *
 * The registry entry is a static import on purpose. A dynamic `import()` keyed
 * by a string would let the app be dropped without touching the registry, but
 * it would also mean a deleted directory fails at runtime instead of at
 * `tsc` — and a release that compiles and then 404s on a screen is worse than
 * one that will not compile until someone has looked.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { fetchPortfolio } from "./portfolio.ts";
import { isAquaChain, AQUA_CHAIN_IDS } from "./registry.ts";
import { portfolioView, renderPortfolio } from "./view.ts";
import type { ScanOptions } from "./positions.ts";

export * from "./registry.ts";
export * from "./positions.ts";
export * from "./portfolio.ts";
export * from "./view.ts";

/**
 * This app's context: the shared one, plus a scan window.
 *
 * The extra field is optional and the shell never sets it — it exists for tests
 * and for a caller that knows Aqua's deployment block on a chain. An app is
 * free to widen `AppContext` this way; it must not narrow it, because the shell
 * only knows how to supply the shared shape.
 *
 * Note what is still absent: no signer, no device client. This milestone is
 * read-only and is structurally incapable of producing a signature. Q2 adding a
 * signing path is the reviewable moment at which that stops being true.
 */
export interface AquaContext extends AppContext {
  scan?: ScanOptions;
}

const CSS = `
.aqua-portfolio { display: flex; flex-direction: column; gap: 0.75rem; }
.aqua-portfolio h3 { margin: 0.5rem 0 0; }
.aqua-portfolio h4 { margin: 0 0 0.25rem; }
.aqua-exposure, .aqua-position {
  border: 1px solid var(--border, #444); border-radius: 6px; padding: 0.6rem;
  display: flex; flex-direction: column; gap: 0.3rem;
}
.aqua-field { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
.aqua-label { min-width: 12rem; opacity: 0.75; }
.aqua-value { font-weight: 600; }
.aqua-detail { font-size: 0.8em; opacity: 0.7; word-break: break-all; }
.aqua-scanned { font-size: 0.85em; opacity: 0.7; margin: 0; }
.aqua-notices p { font-size: 0.85em; opacity: 0.8; }
/* The four tones are visually distinct on purpose: "unavailable" must not be
   mistakable for a value at a glance, which is what a greyed-out zero would
   be. It gets a hatched, italic treatment no real figure ever has. */
.aqua-tone-normal .aqua-value { color: var(--fg, inherit); }
.aqua-tone-zero .aqua-value { color: var(--muted, #999); }
.aqua-tone-docked .aqua-value { color: var(--muted, #999); font-style: italic; }
.aqua-tone-unavailable .aqua-value {
  color: var(--warn, #b58900); font-style: italic;
  border-bottom: 2px dotted currentColor;
}
.aqua-tone-danger .aqua-value { color: var(--danger, #dc322f); font-weight: 700; }
`;

export const AQUA_APP: MiniApp = {
  id: "aqua",
  name: "Aqua",
  summary: "Your 1inch Aqua positions, and the approval that decides what they can cost.",
  chainIds: AQUA_CHAIN_IDS,
  css: CSS,
  async mount(root, context) {
    if (!isAquaChain(context.chainId)) {
      /* Refused rather than rendered empty: "no positions on a chain Aqua is
       * not on" is the zero-versus-unavailable confusion in another costume. */
      root.replaceChildren();
      const p = document.createElement("p");
      p.className = "aqua-tone-unavailable";
      p.textContent = `Aqua is not deployed on chain ${context.chainId}.`;
      root.append(p);
      return;
    }
    const portfolio = await fetchPortfolio(
      context.request, context.chainId, context.address,
      (context as AquaContext).scan ?? {},
    );
    renderPortfolio(root, portfolioView(portfolio));
  },
};

export default AQUA_APP;
