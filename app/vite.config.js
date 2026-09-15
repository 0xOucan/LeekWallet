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

/**
 * The demo payroll CSV, served by the DEV server only.
 *
 *   LEEK_DEMO_CSV=/somewhere/outside/the/repo/payroll.csv pnpm tauri dev
 *
 * La Caja's "Use example CSV" button fetches `/__demo/payroll.csv`. When the
 * variable points at a file, this answers with it; otherwise 404, and the
 * button falls back to a copy remembered on the machine.
 *
 * Why a dev route rather than anything else: the file holds names and
 * addresses, so it must not be committed, must not be bundled, and must not be
 * picked through a file dialog on a screen that is being recorded -- a picker
 * shows the folder tree. `apply: "serve"` means `vite build` never runs this
 * plugin, so nothing about the file can reach dist/ or a release. It is read
 * from disk on every request, so editing the CSV needs no restart.
 */
function demoPayrollCsv() {
  return {
    name: "demo-payroll-csv",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__demo/payroll.csv", (_req, res) => {
        const path = process.env.LEEK_DEMO_CSV;
        if (!path) { res.statusCode = 404; res.end(); return; }
        try {
          const body = readFileSync(path, "utf8");
          res.setHeader("Content-Type", "text/csv; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

// Tauri expects a fixed dev port and no obfuscation in dev builds.
export default defineConfig({
  root: ".",
  plugins: [shippingCsp(), demoPayrollCsv()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 1420, strictPort: true },
  clearScreen: false,
});
