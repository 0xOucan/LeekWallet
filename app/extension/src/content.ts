/**
 * The relay. Runs in the ISOLATED world, in every frame, at document_start.
 *
 * It exists because the two things that need to talk cannot: a MAIN-world
 * script has no `chrome.*` and an extension message has no way to reach page
 * script directly. So this sits between them and does three things, none of
 * which involve understanding what is being said.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not attach an origin. A page can put whatever it likes in a
 * `postMessage` and this script forwards none of it as identity — the origin
 * the service worker acts on is `sender.origin`, which the browser asserts
 * about this frame and which no script on either side can influence. A dapp
 * that claims to be app.uniswap.org therefore cannot reuse app.uniswap.org's
 * approvals, and that property comes from not implementing the alternative.
 *
 * It does not interpret methods. Validation belongs in one place, and that
 * place is the worker, where the permission ledger is. A second half-copy of
 * the rules here is a second thing to keep in sync and a second thing to get
 * wrong.
 *
 * THE ONE CHECK IT DOES MAKE
 *
 * An inbound event carries the list of origins it was meant for, and this
 * script drops it unless this frame's own origin is on it. `chrome.tabs
 * .sendMessage` addresses a tab, and a tab's frames can be anybody —
 * forwarding an `accountsChanged` blindly would tell an embedded third-party
 * iframe which address the user is using on the page hosting it.
 */

import type {
  PageConfig, PageEvent, PageRequest, PageResponse,
} from "./protocol.ts";

const CHANNEL = "leekwallet";

/* ------------------------------------------------------- page -> worker */

window.addEventListener("message", (ev: MessageEvent) => {
  /* Same-window only. A message from an opener, an iframe or a popup is not
   * this frame's provider talking, whatever channel name it puts on itself. */
  if (ev.source !== window) return;
  const data = ev.data as PageRequest | undefined;
  if (!data || data.channel !== CHANNEL || data.dir !== "req") return;
  if (typeof data.id !== "string" || typeof data.method !== "string") return;

  const request: PageRequest = {
    channel: CHANNEL,
    dir: "req",
    id: data.id,
    method: data.method,
    /* Rebuilt rather than passed through, so that only these four fields ever
     * cross into the extension. A page that decorates its message with extra
     * keys — `origin`, `approved`, anything — finds them dropped here. */
    params: Array.isArray(data.params) ? data.params : [],
  };

  chrome.runtime.sendMessage(request).then(
    (reply: PageResponse | undefined) => {
      if (!reply) {
        /* No reply and no thrown error means the worker was torn down between
         * receiving the request and answering it. Say so, rather than leaving
         * the dapp's promise pending for the life of the page. */
        respond({
          channel: CHANNEL, dir: "res", id: request.id,
          error: { code: -32603, message: "the wallet did not answer; try again" },
        });
        return;
      }
      respond({ ...reply, id: request.id });
    },
    (e: unknown) => {
      /* The extension was reloaded or uninstalled mid-request. 4900 is
       * "disconnected", which is exactly what happened. */
      respond({
        channel: CHANNEL, dir: "res", id: request.id,
        error: { code: 4900, message: String((e as Error)?.message ?? e) },
      });
    },
  );
});

function respond(message: PageResponse): void {
  /* `"*"` rather than `location.origin`, because a frame can have an opaque
   * origin — a sandboxed iframe, a `data:` document — where `location.origin`
   * is the string "null" and posting to it silently delivers nothing. The
   * message goes to this window and no other, it is a reply to something this
   * window asked for, and it contains nothing the page did not already have.
   */
  window.postMessage(message, "*");
}

/* ------------------------------------------------------- worker -> page */

chrome.runtime.onMessage.addListener((message: unknown) => {
  const event = message as PageEvent | undefined;
  if (!event || event.channel !== CHANNEL || event.dir !== "event") return undefined;

  /* This frame's own origin, asserted by the browser rather than read from
   * anything the page controls. */
  if (event.origins !== undefined && !event.origins.includes(window.location.origin)) {
    return undefined;
  }

  const { origins: _dropped, ...forPage } = event;
  window.postMessage(forPage satisfies PageEvent, "*");
  return undefined;
});

/* ------------------------------------------------------------ settings */

/**
 * Hand the injected provider the one setting it cannot read for itself.
 *
 * This is asynchronous and the provider has already run by the time it lands.
 * That is a real race and it is not hidden: it is exactly why `window.ethereum`
 * takeover is the OPT-IN path and EIP-6963 is the default. The announcement
 * happens synchronously at document_start and wins every time; the takeover
 * lands a few milliseconds later, before any dapp's own script has run in
 * practice, but "in practice" is not a guarantee and the setting's description
 * in the popup says so.
 */
void chrome.storage.local.get({ overrideWindowEthereum: false }).then((stored) => {
  const config: PageConfig = {
    channel: CHANNEL,
    dir: "config",
    overrideWindowEthereum: stored["overrideWindowEthereum"] === true,
  };
  window.postMessage(config, "*");
});
