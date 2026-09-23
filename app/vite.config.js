import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

/**
 * Serve the shipping Content-Security-Policy during development.
 *
 * Tauri injects `app.security.csp` as a header when it serves the built app
 * over its own protocol. In development the webview navigates straight to this
 * Vite server instead, so there is no Tauri response to inject into and the app
 * runs with no policy at all. That gap cost real debugging time: WalletConnect
 * pairing worked on a developer's desktop and failed on a phone, and the
 * "platform difference" was in truth a production build meeting a policy that
 * no dev run had ever applied. The desktop release build would have failed the
 * same way -- users get a bundled binary, never `pnpm dev`.
 *
 * The policy is read from tauri.conf.json rather than repeated here, because
 * two copies of a security policy is one copy that silently goes stale, and a
 * dev server that enforces a *weaker* rule than production recreates the exact
 * blind spot this exists to remove.
 */
function shippingCsp() {
  const config = JSON.parse(readFileSync("./src-tauri/tauri.conf.json", "utf8"));
  const csp = config?.app?.security?.csp;
  if (typeof csp !== "string" || csp === "") {
    // Loud rather than silently unprotected: a dev server with no policy is
    // precisely the state that hid the bug.
    throw new Error("no app.security.csp in tauri.conf.json to mirror in dev");
  }
  return {
    name: "shipping-csp",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader("Content-Security-Policy", csp);
        next();
      });
    },
  };
}

// Tauri expects a fixed dev port and no obfuscation in dev builds.
export default defineConfig({
  root: ".",
  plugins: [shippingCsp()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
