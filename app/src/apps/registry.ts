/**
 * The mini-app registry: the only place the shell knows an app exists.
 *
 * An app is a directory under `app/packages/apps/` plus one entry in the array
 * below. Removing it from a release is deleting both — and because the entry is
 * a static import, a directory deleted without the entry fails at `tsc` rather
 * than at runtime. That is deliberate: a release that compiles and then breaks
 * on a screen is worse than one that will not compile until somebody looks.
 *
 * The array is empty: the apps written against this framework were built for a
 * hackathon and have been deleted. The framework itself is generic and stays,
 * so the shell keeps exactly one edge to apps rather than growing a new one
 * the next time somebody writes one. Nothing outside this file may import an
 * app module directly.
 *
 * Apps are excluded from the *bundle*, not hidden by a flag. A runtime toggle
 * would leave the code — and its RPC endpoints, and its CSS — shipped to
 * everyone, which is the opposite of what "excludable from a release" has to
 * mean for a wallet.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";

export type { AppContext, MiniApp };

/** Every app in this build. Add a line to register one. */
export const MINI_APPS: readonly MiniApp[] = [];

export const findMiniApp = (id: string): MiniApp | undefined =>
  MINI_APPS.find((app) => app.id === id);

/** Apps offered on a chain. An app decides for itself; the shell does not. */
export const miniAppsForChain = (chainId: number): MiniApp[] =>
  MINI_APPS.filter((app) => app.chainIds.includes(chainId));

/**
 * Put an app's stylesheet in the document once, keyed by id.
 *
 * Apps carry their CSS as a string so it is deleted with them (rule 3 in
 * mini-app.ts). Injecting it here rather than in the app keeps the app from
 * touching `document` before it is mounted.
 */
export function installMiniAppStyles(app: MiniApp, doc: Document = document): void {
  const id = `mini-app-style-${app.id}`;
  if (doc.getElementById(id)) return;
  const style = doc.createElement("style");
  style.id = id;
  style.textContent = app.css;
  doc.head.append(style);
}

/** Install styles and hand the app its root. The shell's whole API surface. */
export async function mountMiniApp(
  app: MiniApp,
  root: HTMLElement,
  context: AppContext,
): Promise<void> {
  installMiniAppStyles(app);
  await app.mount(root, context);
}
