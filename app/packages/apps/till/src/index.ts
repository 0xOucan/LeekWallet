/**
 * La Caja's terminal, as one object the shell can mount and delete.
 *
 * ---------------------------------------------------------------------------
 * How to remove this app from a release build
 *
 *     rm -rf app/packages/apps/till
 *     # drop the import and the array entry in app/src/apps/registry.ts
 *     # drop "@leekwallet/app-till" from app/package.json dependencies
 *     pnpm --dir app install && pnpm --dir app typecheck && pnpm --dir app test
 *
 * Three edits, as for `ats`, and the third exists because pnpm refuses to
 * install a workspace dependency whose package is gone — a removal that is
 * half-done fails loudly rather than shipping.
 *
 * The nine chains in `packages/core/src/chains.ts` and Circle's descriptors in
 * `erc7730-circle.ts` deliberately do NOT come out with this directory. A chain
 * and a token descriptor are wallet capability; being a payee is what is app.
 *
 * ---------------------------------------------------------------------------
 * Scope: C2 and C3 of docs/apps/ARC-LA-CAJA.md, and nothing past them
 *
 * A waiter enters a total, picks a tip, gets a QR and a link, and then watches
 * the nine rails until the money arrives (watch.ts, watch-view.ts). It ends
 * there. There is no shift grant or staff accounting (C4), no CajaInbox,
 * relayer or CCTP (C5) and no CajaTill (C6). In particular the QR pays the
 * merchant address the shell is showing; C5 replaces that with a per-chain
 * CajaInbox whose destination is immutable, and the two lines that change are
 * the recipient handed to `buildPaymentUri` and the one handed to the watcher.
 *
 * ---------------------------------------------------------------------------
 * The defining constraint: this terminal has no key
 *
 * A waiter is handed this device for a shift. It must be structurally incapable
 * of moving money, not merely lacking a button that would.
 *
 * `AppContext` carries a chain id, an address and a read-only `request`, and
 * `app/test/apps.test.ts` asserts that no field of it names a signer, a device
 * or a transport. This app widens nothing, imports no transport, and reaches
 * for no key: `test/no-signing.test.ts` reads every source file here and fails
 * on any mention of a signing path, on `eth_sendTransaction` or
 * `eth_sign*`/`personal_sign`, and on any import outside `@leekwallet/core` and
 * the QR renderer. So the guarantee is a property of the dependency graph that
 * a test re-derives from the source, rather than a claim in a comment — which
 * is what it has to be, because the person relying on it is a merchant handing
 * a stranger a device that is pointed at their treasury.
 *
 * C3 adds a payment watcher, which is a read: `eth_blockNumber` and
 * `eth_getLogs`, nothing else, on chains the shell hands it a read path to. It
 * widens no context of its own and gains no ability to move anything; the
 * no-signing test now also asserts that every RPC method the mounted app ever
 * issues is one of those two reads.
 *
 * The strongest form of the argument: this app never produces a transaction at
 * all. It produces a URI asking someone ELSE's wallet to produce one, on
 * someone else's device, spending someone else's money into the merchant's
 * address. There is nothing here for a compromised waiter to sign with, and
 * nothing to steal but a request to be paid.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { buildOrder, newMarker, parseCents, TIP_PRESETS, type Cents } from "./order.ts";
import { TILL_CHAIN_IDS, TILL_TOKENS, deploymentFor, railFor, type TillToken } from "./rails.ts";
import { renderCharge, tillView, type TillState } from "./view.ts";
import { PaymentWatcher, type ChainRequest, type WatchTarget } from "./watch.ts";
import { renderWatch, watchView } from "./watch-view.ts";

export * from "./order.ts";
export * from "./rails.ts";
export * from "./uri.ts";
export * from "./view.ts";
export * from "./watch.ts";
export * from "./watch-view.ts";

const CSS = `
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
`;

export const TILL_APP: MiniApp = {
  id: "till",
  name: "La Caja",
  summary: "Take a bill in USDC or EURC. The customer scans and pays; this terminal holds no key.",
  chainIds: TILL_CHAIN_IDS,
  css: CSS,
  async mount(root: HTMLElement, context: AppContext) {
    const state: TillState = {
      merchant: "La Caja",
      recipient: context.address,
      base: null,
      tip: { kind: "percent", percent: 10 },
      token: "USDC",
      /* The chain the shell is on, when this app takes payment there; the
       * customer changes it, since it is their wallet that pays the gas. */
      chainId: railFor(context.chainId) ? context.chainId : (TILL_CHAIN_IDS[0] as number),
      marker: newMarker(),
    };

    root.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "till";
    root.append(panel);

    const keypad = document.createElement("div");
    keypad.className = "till-keypad";
    const amount = document.createElement("input");
    amount.type = "text";
    amount.inputMode = "decimal";
    amount.placeholder = "0.00";
    amount.setAttribute("aria-label", "Bill total");
    keypad.append(amount);

    const tokenPicker = document.createElement("select");
    tokenPicker.setAttribute("aria-label", "Currency");
    for (const token of TILL_TOKENS) {
      const option = document.createElement("option");
      option.value = token;
      option.textContent = token;
      tokenPicker.append(option);
    }
    keypad.append(tokenPicker);
    panel.append(keypad);

    const tips = document.createElement("div");
    tips.className = "till-tips";
    const custom = document.createElement("input");
    custom.type = "text";
    custom.inputMode = "numeric";
    custom.placeholder = "custom %";
    custom.size = 8;
    custom.setAttribute("aria-label", "Custom tip percent");
    const presetButtons = TIP_PRESETS.map((percent) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${percent}%`;
      button.addEventListener("click", () => {
        state.tip = { kind: "percent", percent };
        custom.value = "";
        redraw();
      });
      tips.append(button);
      return [percent, button] as const;
    });
    custom.addEventListener("input", () => {
      const text = custom.value.trim();
      if (text === "") {
        state.tip = { kind: "percent", percent: 0 };
      } else if (/^\d{1,3}$/.test(text)) {
        state.tip = { kind: "percent", percent: Number(text) };
      }
      redraw();
    });
    tips.append(custom);
    panel.append(tips);

    const error = document.createElement("p");
    error.className = "till-error";
    panel.append(error);

    const output = document.createElement("div");
    panel.append(output);
    const watchPanel = document.createElement("div");
    panel.append(watchPanel);

    /* One watcher per distinct charge. Restarting it on every keystroke would
     * throw away the block cursors and re-ask nine operators for the same
     * range, so the key is the payable figure: a different figure is a
     * different bill, and the same figure is the same one. */
    let watcher: PaymentWatcher | undefined;
    let watchKey = "";

    /* The shell's own chain is read through the context; the other eight need
     * a channel it may or may not offer, and a chain it will not offer is one
     * the watcher reports as unknown rather than as unpaid. */
    const channelFor = (chainId: number): ChainRequest | undefined => {
      if (chainId === context.chainId) {
        return context.endpointHost === undefined
          ? { request: context.request }
          : { request: context.request, endpointHost: context.endpointHost };
      }
      return context.requestOn?.(chainId);
    };

    const syncWatcher = (charge: ReturnType<typeof tillView>["charge"]) => {
      const key = charge.ok ? `${state.token}|${state.recipient}|${charge.units}` : "";
      if (key === watchKey) return;
      watchKey = key;
      watcher?.stop();
      watcher = undefined;
      watchPanel.replaceChildren();
      if (!charge.ok || state.base === null) return;

      const target: WatchTarget = {
        recipient: state.recipient,
        token: state.token,
        total: buildOrder(state.base, state.tip).total,
        marker: state.marker,
      };
      watcher = new PaymentWatcher({
        chains: TILL_CHAIN_IDS,
        channelFor,
        target,
        /* MiniApp has no unmount hook — the shell tears an app down by
         * dropping its root (src/apps/mount.ts) — so the root's own
         * connectedness is the signal. `!== false` rather than `=== true`
         * because a stub DOM has no such property and must not be treated as
         * already gone. */
        alive: () => (root as { isConnected?: boolean }).isConnected !== false,
        onUpdate: (snapshot) => renderWatch(watchPanel, watchView(target, snapshot)),
      });
      renderWatch(watchPanel, watchView(target, watcher.snapshot()));
      watcher.start();
    };

    const redraw = () => {
      for (const [percent, button] of presetButtons) {
        button.setAttribute(
          "aria-pressed",
          String(state.tip.kind === "percent" && state.tip.percent === percent),
        );
      }
      const view = tillView(state);
      renderCharge(output, view, (chainId) => {
        state.chainId = chainId;
        redraw();
      });
      syncWatcher(view.charge);
    };

    amount.addEventListener("input", () => {
      const text = amount.value.trim();
      if (text === "") {
        state.base = null;
        error.textContent = "";
      } else {
        const parsed = parseCents(text);
        /* A half-typed amount keeps the last good total on screen rather than
         * blanking the QR on every keystroke; the message says the figure below
         * is not what was just typed. */
        state.base = parsed.ok ? (parsed.cents as Cents) : state.base;
        error.textContent = parsed.ok ? "" : parsed.reason;
      }
      // A new total is a new order, so it gets a new marker: reusing one would
      // let two bills at the same table collide in exactly the way order.ts
      // explains.
      state.marker = newMarker();
      redraw();
    });

    tokenPicker.addEventListener("change", () => {
      state.token = tokenPicker.value as TillToken;
      /* Switching to EURC on a chain that has none must not leave a stale
       * selection behind: move to the cheapest rail that can take it. */
      if (!deploymentFor(state.chainId, state.token).ok) {
        const fallback = TILL_CHAIN_IDS.find((id) => deploymentFor(id, state.token).ok);
        if (fallback !== undefined) state.chainId = fallback;
      }
      redraw();
    });

    redraw();
  },
};

export default TILL_APP;
