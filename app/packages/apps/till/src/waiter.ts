/**
 * The waiter's half of La Caja: scan the cashier's request, show it, watch for
 * the money.
 *
 * ---------------------------------------------------------------------------
 * What this screen can do, and what it structurally cannot
 *
 * It can: read a request, display it, list every chain the customer may pay on,
 * render the QR codes, and watch nine chains for the arrival.
 *
 * It cannot: change the amount, change the recipient, invent a request, or move
 * money. Those are not disabled controls — this module has no code that
 * constructs a `PaymentRequest`. It imports `acceptRequest`, which only ever
 * parses, and every figure below is read out of the object that came back. The
 * amount displayed is arithmetic over `sealed.request.total`, and the only
 * input on the screen is the scanner.
 *
 * That distinction is the entire reason the roles were split, so it is asserted
 * rather than described: `test/waiter.test.ts` drives the mounted app, types
 * hostile values into every input it can find, fires every listener, and checks
 * that the payable units and the recipient in the emitted URI are byte-identical
 * to the ones the cashier sealed.
 *
 * ---------------------------------------------------------------------------
 * Why the chain the waiter taps is not a change to the request
 *
 * The customer picks a chain, because it is their wallet and their gas. Tapping
 * a chain here only decides which token contract the one-scan QR addresses; the
 * recipient and the payable figure are the same on all of them, and the other
 * eight stay on screen with their own amounts. A "selection" that removed the
 * others would be the terminal choosing for the customer, and this app's whole
 * claim is that it does not.
 *
 * ---------------------------------------------------------------------------
 * Still no key
 *
 * Same as the cashier's side and for the same reason: a waiter is a stranger
 * holding a device pointed at the restaurant's treasury. `test/no-signing.test.ts`
 * covers both apps in this package.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import { formatUnits } from "@leekwallet/core/chains.ts";
import { formatCents, payableUnits } from "./order.ts";
import { acceptRequest, type SealedRequest } from "./request.ts";
import { TILL_CSS } from "./css.ts";
import { deploymentFor, railFor, TILL_CHAIN_IDS } from "./rails.ts";
import { buildPaymentUri, shareMessage, whatsappLink } from "./uri.ts";
import { qrSvg } from "./view.ts";
import { PaymentWatcher, type ChainRequest, type WatchTarget } from "./watch.ts";
import { renderWatch, watchView } from "./watch-view.ts";

/** One accepted chain, as the customer sees it. */
export interface AcceptedChain {
  chainId: number;
  name: string;
  /** The exact figure to send on this chain, marker included. */
  amountText: string;
  /** False when the request's token has no deployment here. */
  payable: boolean;
  /** Why not. Present exactly when `payable` is false. */
  reason?: string;
  /** True for the chain whose one-scan QR is currently shown. Cosmetic only. */
  showing: boolean;
}

export interface WaiterView {
  merchant: string;
  /** "Total to pay" — the prominent figure, marker included, everywhere. */
  headline: string;
  /** The bill total in cents, for the line under the headline. */
  billText: string;
  recipient: string;
  /** The issue checksum, so a cashier and a waiter can compare by eye. */
  digest: string;
  chains: AcceptedChain[];
  /** EIP-681 URI for the chain being shown, or undefined when it is unpayable. */
  uri?: string;
  share?: string;
  whatsapp?: string;
  notices: string[];
}

/**
 * The exact payable figure on one chain, or a reason there is none.
 *
 * Derived from the sealed total with the same `payableUnits` the cashier used
 * and the decimals from core's table, so the waiter's screen and the cashier's
 * cannot print different numbers for the same request.
 */
function amountOn(sealed: SealedRequest, chainId: number):
  | { ok: true; units: bigint; text: string; token: string; decimals: number }
  | { ok: false; reason: string } {
  const deployment = deploymentFor(chainId, sealed.request.token);
  if (!deployment.ok) return { ok: false, reason: deployment.reason };
  const units = payableUnits(sealed.request.total, deployment.decimals, sealed.request.marker);
  return {
    ok: true,
    units,
    text: `${formatUnits(units, deployment.decimals)} ${sealed.request.token}`,
    token: deployment.address,
    decimals: deployment.decimals,
  };
}

export function waiterView(sealed: SealedRequest, showingChainId: number): WaiterView {
  const { request } = sealed;
  const chains: AcceptedChain[] = request.chains.map((chainId) => {
    const amount = amountOn(sealed, chainId);
    const row: AcceptedChain = {
      chainId,
      name: railFor(chainId)?.name ?? `chain ${chainId}`,
      amountText: amount.ok ? amount.text : "—",
      payable: amount.ok,
      showing: chainId === showingChainId,
    };
    if (!amount.ok) row.reason = amount.reason;
    return row;
  });

  /* The headline is the figure that has to arrive, not the rounded bill: a
   * customer who types the round number pays an amount that does not match and
   * the watcher lists it as somebody else's payment. Every chain here carries
   * the same total, so any payable one gives the headline. */
  const shown = chains.find((c) => c.chainId === showingChainId && c.payable)
    ?? chains.find((c) => c.payable);
  const headline = shown === undefined ? "Nothing on this request can be paid" : shown.amountText;

  const view: WaiterView = {
    merchant: request.merchant,
    headline,
    billText: `${formatCents(request.total)} ${request.token} before the order marker`,
    recipient: request.recipient,
    digest: sealed.digest,
    chains,
    notices: [
      `This request came from the cashier. This terminal cannot change the amount ` +
        `or the address on it — it can only display it and watch for the payment.`,
      `Pay on any chain listed. The figure is the same on all of them and the ` +
        `hundredths of a cent are how this bill is told apart from the next table.`,
      `The checksum ${sealed.digest} is an integrity check, not a signature. It ` +
        `proves the request was not altered after issue; it does not prove who issued it.`,
    ],
  };

  const target = shown === undefined ? undefined : amountOn(sealed, shown.chainId);
  if (target !== undefined && target.ok && shown !== undefined) {
    view.uri = buildPaymentUri({
      chainId: shown.chainId,
      token: target.token,
      recipient: request.recipient,
      amount: target.units,
    });
    view.share = shareMessage({
      merchant: request.merchant,
      totalText: formatUnits(target.units, target.decimals),
      token: request.token,
      chainName: shown.name,
      uri: view.uri,
    });
    view.whatsapp = whatsappLink(view.share);
  }
  return view;
}

/* -------------------------------------------------------------------- DOM */

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls !== undefined) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Draw the client-facing screen.
 *
 * `textContent` throughout: the merchant name arrives from a scanned QR, which
 * is untrusted text from a camera, and it is displayed rather than parsed.
 */
export function renderWaiter(
  root: HTMLElement,
  view: WaiterView,
  onShowChain: (chainId: number) => void,
): void {
  root.replaceChildren();
  root.className = "till-waiter";

  root.append(el("p", "till-waiter-merchant", view.merchant));
  /* "Total to pay" is the headline, and the exact figure is what follows it —
     the property C3 fixed and this screen inherits rather than re-decides. */
  root.append(el("p", "till-waiter-label", "Total to pay"));
  root.append(el("p", "till-waiter-total", view.headline));
  root.append(el("p", "till-waiter-bill", view.billText));

  const codes = el("div", "till-codes");
  if (view.uri !== undefined) {
    const exact = el("div", "till-code");
    exact.append(el("p", "till-code-label", "Pay exactly — one scan"));
    exact.append(qrSvg(view.uri));
    exact.append(el("p", "till-code-note", "If your wallet does not read this, use the code beside it."));
    codes.append(exact);
  }
  const plain = el("div", "till-code");
  plain.append(el("p", "till-code-label", "Or scan the address"));
  plain.append(qrSvg(view.recipient));
  plain.append(el("p", "till-code-note", `Then send ${view.headline} yourself.`));
  codes.append(plain);
  root.append(codes);

  root.append(el("p", "till-amount", `${view.headline} to ${view.recipient}`));

  const chains = el("div", "till-rails");
  chains.append(el("h4", undefined, "Accepted on any of these chains"));
  for (const chain of view.chains) {
    /* Every accepted chain is on screen with its own figure, not just the one
     * whose QR is showing: the customer chooses, and a list of one is not a
     * choice. */
    const button = document.createElement("button");
    button.type = "button";
    button.className = `till-rail${chain.showing ? " till-rail-selected" : ""}`;
    button.disabled = !chain.payable;
    button.append(el("span", "till-rail-name", chain.name));
    button.append(el("span", "till-rail-cost", chain.amountText));
    if (chain.reason !== undefined) button.append(el("span", "till-rail-reason", chain.reason));
    if (chain.payable) button.addEventListener("click", () => onShowChain(chain.chainId));
    chains.append(button);
  }
  root.append(chains);

  if (view.whatsapp !== undefined) {
    const actions = el("div", "till-actions");
    const share = document.createElement("a");
    share.className = "till-share";
    share.href = view.whatsapp;
    share.target = "_blank";
    share.rel = "noreferrer noopener";
    share.textContent = "Send on WhatsApp";
    actions.append(share);
    root.append(actions);
  }

  const notices = el("div", "till-notices");
  for (const note of view.notices) notices.append(el("p", undefined, note));
  root.append(notices);
}

export const TILL_WAITER_APP: MiniApp = {
  id: "till-waiter",
  name: "La Caja — waiter",
  summary:
    "Scan the cashier's request, show the customer what to pay on any accepted chain, and watch it arrive. Cannot change the bill.",
  chainIds: TILL_CHAIN_IDS,
  /* The same stylesheet as the cashier's app: one product, two devices, one
   * set of classes. The shell installs it under this app's own id, so a phone
   * that mounts only this app is still styled. */
  css: TILL_CSS,
  async mount(root: HTMLElement, context: AppContext) {
    /* The only mutable state on this device. There is no amount here, no tip
     * and no recipient — a request is received whole or not at all. */
    let sealed: SealedRequest | undefined;
    let showingChainId = context.chainId;

    root.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "till";
    root.append(panel);

    const scanRow = document.createElement("div");
    scanRow.className = "till-keypad";
    const scan = document.createElement("input");
    scan.type = "text";
    scan.placeholder = "caja1|…";
    /* The one input on this screen, and it takes a request, never a number.
     * test/waiter.test.ts asserts there is no other. */
    scan.setAttribute("aria-label", "Scan the cashier's request");
    scanRow.append(scan);

    /* The camera, which is how this is actually used: a waiter points a phone
     * at the cashier's screen. The text field stays, because a request also
     * travels by message and because a camera can be absent, refused, or dark.
     *
     * `accept` runs inside the shell's scan loop, so a code that is not one of
     * our requests is ignored rather than pasted here — the field cannot be
     * filled with something the app did not recognise. Still a *decode*, not a
     * trust decision: acceptRequest below is what refuses a request that pays
     * somebody else. */
    if (context.scanQr) {
      const camera = document.createElement("button");
      camera.type = "button";
      camera.textContent = "Scan with camera";
      camera.addEventListener("click", () => {
        void context.scanQr?.((raw) => {
          /* The same gate the pasted field goes through, so the camera cannot
             become a second, laxer way in. A code that is not a request this
             terminal would accept is left in shot rather than filled in. */
          return acceptRequest(raw.trim(), context.address).ok ? raw.trim() : undefined;
        }).then((raw) => {
          if (raw === null) return;
          scan.value = raw;
          scan.dispatchEvent(new Event("input"));
        });
      });
      scanRow.append(camera);
    }

    panel.append(scanRow);

    const error = document.createElement("p");
    error.className = "till-error";
    panel.append(error);

    const output = document.createElement("div");
    panel.append(output);
    const watchPanel = document.createElement("div");
    panel.append(watchPanel);

    const channelFor = (chainId: number): ChainRequest | undefined => {
      if (chainId === context.chainId) {
        return context.endpointHost === undefined
          ? { request: context.request }
          : { request: context.request, endpointHost: context.endpointHost };
      }
      return context.requestOn?.(chainId);
    };

    let watcher: PaymentWatcher | undefined;
    let watchKey = "";

    const syncWatcher = () => {
      const key = sealed === undefined ? "" : sealed.text;
      if (key === watchKey) return;
      watchKey = key;
      watcher?.stop();
      watcher = undefined;
      watchPanel.replaceChildren();
      if (sealed === undefined) return;

      /* Watched on every chain the request names, not only the one showing:
       * the customer may pay anywhere on that list and the waiter has to see
       * it wherever it lands. */
      const target: WatchTarget = {
        recipient: sealed.request.recipient,
        token: sealed.request.token,
        total: sealed.request.total,
        marker: sealed.request.marker,
      };
      const request = sealed;
      watcher = new PaymentWatcher({
        chains: request.request.chains,
        channelFor,
        target,
        alive: () => (root as { isConnected?: boolean }).isConnected !== false,
        onUpdate: (snapshot) => renderWatch(watchPanel, watchView(target, snapshot)),
      });
      renderWatch(watchPanel, watchView(target, watcher.snapshot()));
      watcher.start();
    };

    const redraw = () => {
      if (sealed === undefined) {
        output.replaceChildren();
        return;
      }
      renderWaiter(output, waiterView(sealed, showingChainId), (chainId) => {
        showingChainId = chainId;
        redraw();
      });
    };

    scan.addEventListener("input", () => {
      const text = scan.value.trim();
      if (text === "") {
        error.textContent = "";
        return;
      }
      const accepted = acceptRequest(text, context.address);
      if (!accepted.ok) {
        /* A refused request leaves the previous one on screen. Blanking it
         * would lose the bill a customer is standing in front of because a
         * scanner caught a half-frame. */
        error.textContent = accepted.reason;
        return;
      }
      error.textContent = "";
      sealed = accepted.sealed;
      const first = sealed.request.chains.find((id) => deploymentFor(id, (sealed as SealedRequest).request.token).ok);
      showingChainId = sealed.request.chains.includes(showingChainId) ? showingChainId : (first ?? showingChainId);
      redraw();
      syncWatcher();
    });

    redraw();
  },
};

export default TILL_WAITER_APP;
