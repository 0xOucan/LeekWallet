import { defineConfig } from "vite";

/**
 * The shared half of the extension build.
 *
 * There are three Vite builds rather than one, and the reason is a hard
 * platform rule rather than taste: **a content script cannot be an ES module.**
 * Chrome injects `content_scripts` entries as classic scripts, so an `import`
 * anywhere in `content.js` or `inpage.js` is a syntax error at injection time
 * and the provider silently never appears — the worst failure mode a wallet
 * has, because the page looks normal and the wallet simply is not there.
 *
 * Extension PAGES are the opposite: the popup, the offscreen document and an
 * MV3 service worker declared `"type": "module"` all want real modules, and
 * want to share chunks (viem and @noble are large and both the popup and the
 * offscreen document pull from `packages/core`).
 *
 * So: one module build for the pages and the worker, and one single-file IIFE
 * build per content script. `build.mjs` runs them in order and copies the
 * static files. This file holds only what all three agree on.
 */
export default defineConfig({
  /* `import.meta.dirname` rather than `__dirname`: Vite's native config loader
   * does not define the CommonJS globals, and the fallback that does is on its
   * way out. */
  root: import.meta.dirname,
  build: {
    outDir: "dist",
    target: "es2022",
    /* Readable output. A reviewer — and the Chrome Web Store's own reviewers —
     * has to be able to read what a wallet ships, and a minified bundle is a
     * thing nobody audits. The whole extension is well under a megabyte. */
    minify: false,
    sourcemap: true,
  },
  /* Vite injects `import.meta.env` values as literals; naming the mode keeps
   * anything downstream that branches on it from thinking it is in dev. */
  define: { "process.env.NODE_ENV": '"production"' },
});
