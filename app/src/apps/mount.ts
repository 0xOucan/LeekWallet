/**
 * Putting the registered apps on screen.
 *
 * One function, one call site, so the shell's knowledge of mini-apps is a
 * single import in main.ts. It goes through `registry.ts` and never names an
 * app: `apps.test.ts` asserts that, and the assertion is what keeps removal to
 * one directory and one registry line.
 *
 * The chain gate is a display decision, not the exclusion mechanism. An app
 * whose `chainIds` exclude the active chain is not offered — for the ATS
 * console, reading a Hedera security over an Ethereum endpoint would produce a
 * confidently empty register, which is the failure that app is built around —
 * but its code is still in the bundle. Excluding an app is deleting it.
 */

import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { miniAppsForChain, mountMiniApp } from "./registry.ts";

/**
 * Mount every app that applies to `context.chainId` into `container`.
 *
 * Idempotent, and it tears down before it builds: the chain can change under
 * the user, and an app left running against the previous network would keep
 * rendering figures from a chain nobody selected. `MiniApp.mount` returns no
 * disposer by design — the app owns its root and the shell clears it — so
 * teardown is dropping the roots.
 */
export function mountApps(container: HTMLElement, context: AppContext): void {
  container.replaceChildren();
  const apps = miniAppsForChain(context.chainId);
  container.hidden = apps.length === 0;

  for (const app of apps) {
    const panel = document.createElement("section");
    panel.className = "panel";
    const heading = document.createElement("h2");
    heading.textContent = app.name;
    const summary = document.createElement("p");
    summary.className = "muted";
    summary.textContent = app.summary;
    const root = document.createElement("div");
    panel.append(heading, summary, root);
    container.append(panel);

    /* An app that throws while mounting must not take the shell down with it,
     * and must not leave an empty panel that reads as "nothing to show". The
     * failure is rendered where the app would have been. */
    void mountMiniApp(app, root, context).catch((e: unknown) => {
      root.replaceChildren();
      const p = document.createElement("p");
      p.className = "notice notice--danger";
      p.textContent = `${app.name} could not start: ${String((e as Error)?.message ?? e)}`;
      root.append(p);
    });
  }
}
