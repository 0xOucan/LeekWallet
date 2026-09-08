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

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { miniAppsForChain, mountMiniApp } from "./registry.ts";

/**
 * Mount every app that applies to `context.chainId` into `container`, one
 * visible at a time behind a tab strip.
 *
 * Idempotent, and it tears down before it builds: the chain can change under
 * the user, and an app left running against the previous network would keep
 * rendering figures from a chain nobody selected. `MiniApp.mount` returns no
 * disposer by design — the app owns its root and the shell clears it — so
 * teardown is dropping the roots.
 *
 * `proposerFor` is optional and is how an app gets a `propose` at all. It is a
 * per-app factory rather than one function in `context` because a proposal is
 * attributed: the review card names the app that asked, and a shared closure
 * could only name the shell. Omitting it mounts every app without a `propose`,
 * which is the honest shape for a build with no signing path — an app must cope
 * with its absence, and that is stated in mini-app.ts.
 */
export function mountApps(
  container: HTMLElement,
  context: AppContext,
  proposerFor?: (app: MiniApp) => AppContext["propose"],
): void {
  container.replaceChildren();
  const apps = miniAppsForChain(context.chainId);
  container.hidden = apps.length === 0;
  if (apps.length === 0) return;

  /* One app on screen at a time, chosen by a tab.
   *
   * Stacking every app down one page was the first shape and it was wrong for
   * the thing this is mostly used for: showing one app to somebody. A demo of
   * La Caja should not have an issuer console under it, and a screenshot of the
   * portfolio should not be half a point-of-sale.
   *
   * The tab strip is skipped entirely when only one app applies to the chain,
   * because a single tab is a label pretending to be a control. */
  const tabs = document.createElement("div");
  tabs.className = "apptabs";
  tabs.setAttribute("role", "tablist");
  if (apps.length > 1) container.append(tabs);

  const panels: HTMLElement[] = [];

  const show = (index: number): void => {
    panels.forEach((panel, i) => { panel.hidden = i !== index; });
    Array.from(tabs.children).forEach((tab, i) => {
      tab.classList.toggle("on", i === index);
      tab.setAttribute("aria-selected", String(i === index));
    });
  };

  apps.forEach((app, index) => {
    if (apps.length > 1) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "apptab";
      tab.setAttribute("role", "tab");
      tab.textContent = app.name;
      tab.addEventListener("click", () => show(index));
      tabs.append(tab);
    }

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
    panels.push(panel);

    /* An app that throws while mounting must not take the shell down with it,
     * and must not leave an empty panel that reads as "nothing to show". The
     * failure is rendered where the app would have been. */
    const propose = proposerFor?.(app);
    /* A fresh object per app: two apps sharing one context would share a
     * `propose` bound to whichever name was built last. */
    const appContext: AppContext = { ...context, ...(propose ? { propose } : {}) };

    void mountMiniApp(app, root, appContext).catch((e: unknown) => {
      root.replaceChildren();
      const p = document.createElement("p");
      p.className = "notice notice--danger";
      p.textContent = `${app.name} could not start: ${String((e as Error)?.message ?? e)}`;
      root.append(p);
    });
  });

  show(0);
}
