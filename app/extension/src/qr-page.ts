/**
 * The QR scan tab. The one context in this extension that holds a camera.
 *
 * WHO OWNS THE CAMERA, AND WHY IT IS THIS TAB
 *
 * An MV3 extension has four places code can run, and only one of them can
 * hold a camera for the length of a scan:
 *
 *   - The service worker has no DOM and no `navigator.mediaDevices`. It is
 *     also evicted after about thirty seconds idle, and pairing or signing
 *     over QR takes as long as a person takes to fetch the device, open the
 *     right screen and hold it steady.
 *
 *   - The toolbar popup is destroyed the instant it loses focus. The camera
 *     permission prompt takes focus, and so does reaching for the device.
 *     The serial chooser already taught this codebase that lesson (popup.ts).
 *
 *   - The offscreen document can in principle: `chrome.offscreen.Reason`
 *     has USER_MEDIA. But an offscreen document is invisible and cannot show
 *     a permission prompt, so the permission would still have to be granted
 *     from a visible page first. The user must also SEE two things - the
 *     preview, to aim, and for signing the animated request QR the device
 *     has to scan - and a hidden document can show neither. It is also the
 *     serial owner, created with the WORKERS reason; a camera in the process
 *     that holds the device session is blast radius for no gain.
 *
 *   - An extension page in a tab of a normal window can do all of it. It
 *     lives until it is closed, it has the extension's origin, so the camera
 *     permission is granted once to the extension and remembered, and its
 *     prompt has an address bar to anchor to. A `type: "popup"` window was
 *     rejected for the same reason the serial chooser rejected it: Chrome
 *     anchors device and permission prompts to a tab.
 *
 * So the worker opens this page for one job at a time and waits. The page is
 * a dumb terminal: it draws the view the worker built, scans the UR type the
 * worker named, and sends back the CBOR body. It verifies nothing and decides
 * nothing; the worker checks the body against state this page never held.
 *
 * Closing the tab is an answer. The worker treats it as the user rejecting
 * the request, so a dapp is never left waiting on a tab that is gone.
 */

import "../../src/tokens.css";
import "./popup.css";
import { DEFAULT_FRAGMENT, QrCancelled, scanUr, showUr } from "../../src/qr-airgap.ts";
import { qrSvg } from "./receive.ts";
import type { PopupCommand, QrDoneReply, QrJobView } from "./protocol.ts";

/** Below the worker's idle timeout with room to spare. */
const PING_MS = 20_000;

/** Offered fragment sizes. Smaller frames have bigger modules and more of them. */
const FRAGMENT_SIZES = [40, 60, DEFAULT_FRAGMENT, 120];

const root = document.getElementById("qr-root");
const jobId = new URLSearchParams(location.search).get("job") ?? "";

async function send<T>(command: PopupCommand): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(command)) as
    | { ok?: unknown; err?: string }
    | undefined;
  if (!reply) throw new Error("the extension did not answer");
  if (reply.err !== undefined) throw new Error(reply.err);
  return reply.ok as T;
}

type Child = string | Node | null | undefined | false;

/* Built, never parsed: the summary lines carry dapp-supplied values. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string): Uint8Array =>
  new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

async function main(): Promise<void> {
  if (root === null) return;
  const controller = new AbortController();
  let view: QrJobView | null;
  try {
    view = await send<QrJobView | null>({ pop: "qrJob", id: jobId });
  } catch {
    view = null;
  }
  root.textContent = "";
  if (view === null) {
    root.append(el("section", { class: "notice bad" },
      el("h2", {}, "Nothing to scan"),
      el("p", {}, "This request is no longer waiting. You can close this tab.")));
    return;
  }
  const job = view;
  document.title = `LeekWallet — ${job.title}`;

  const ping = setInterval(() => { void send({ pop: "qrPing", id: job.id }).catch(() => {}); }, PING_MS);
  const cancel = (): void => {
    controller.abort();
    clearInterval(ping);
    void send({ pop: "qrCancel", id: job.id }).catch(() => {}).finally(() => window.close());
  };

  const instr = el("p", {});
  const progress = el("p", { class: "muted" });
  const holder = el("div", { class: "qr-display" });
  const video = el("video", { class: "qr-video", muted: "", playsinline: "" });
  video.hidden = true;
  const error = el("p", { class: "warn" });
  const actions = el("div", { class: "row" });
  const cancelButton = el("button", {}, "Cancel");
  cancelButton.addEventListener("click", cancel);

  root.append(
    el("h1", {}, "LeekWallet", el("span", { class: "muted grow", style: "text-align:right;font-weight:400" }, job.title)),
    job.summary.length === 0 ? "" : el("section", {},
      el("p", { class: "muted" },
        "What this extension built, for your reference. The device decodes the request itself; " +
        "check its screen, not this one."),
      el("ul", {}, ...job.summary.map((line) => el("li", { class: "mono break" }, line)))),
    el("section", {}, instr, holder, video, progress, error, actions),
  );

  if (job.show !== undefined) {
    const show = job.show;
    const cbor = unhex(show.cbor);
    let frames: AbortController | null = null;
    const select = el("select", { "aria-label": "Fragment size" });
    for (const n of FRAGMENT_SIZES) {
      const o = el("option", { value: String(n) }, `${n} bytes per frame`);
      if (n === DEFAULT_FRAGMENT) o.selected = true;
      select.append(o);
    }
    const draw = (): void => {
      frames?.abort();
      frames = new AbortController();
      const f = frames;
      controller.signal.addEventListener("abort", () => f.abort(), { once: true });
      const size = Number(select.value) || DEFAULT_FRAGMENT;
      const { frames: n } = showUr(holder, show.type, cbor, size,
        (text) => qrSvg(text, { size: 360, label: `QR code, ${show.type}`, mode: "Alphanumeric" }),
        f.signal);
      progress.textContent = n > 1
        ? `${cbor.length} bytes in ${n} fragments, animated. A smaller size is easier for the device's camera.`
        : `${cbor.length} bytes, one frame.`;
    };
    select.addEventListener("change", draw);
    draw();
    instr.textContent = show.instructions;
    const next = el("button", { class: "primary" }, "The device has signed — scan its answer");
    actions.append(next, select, cancelButton);
    await new Promise<void>((resolve) => next.addEventListener("click", () => resolve(), { once: true }));
    (frames as AbortController | null)?.abort();
    holder.textContent = "";
    actions.textContent = "";
  }

  actions.append(cancelButton);
  instr.textContent = job.scan.instructions;
  /* Scan until the worker accepts, or the user gives up. A refusal - most
   * often a signature for an earlier request still on the device's screen -
   * is said out loud and the camera keeps going. */
  for (;;) {
    let cbor: Uint8Array;
    try {
      cbor = await scanUr(video, job.scan.type, (t) => { progress.textContent = t; },
        controller.signal, () => {});
    } catch (e) {
      if (e instanceof QrCancelled) return;
      error.textContent = `The camera could not scan: ${String((e as Error)?.message ?? e)}`;
      return;
    }
    progress.textContent = "Checking…";
    let reply: QrDoneReply;
    try {
      reply = await send<QrDoneReply>({ pop: "qrDone", id: job.id, cbor: hex(cbor) });
    } catch (e) {
      reply = { done: false, error: String((e as Error)?.message ?? e), retry: false };
    }
    if (reply.done) {
      clearInterval(ping);
      progress.textContent = "Done. This tab will close.";
      return;
    }
    if (reply.retry) {
      error.textContent = `${reply.error}. Scanning again.`;
      continue;
    }
    error.textContent = `${reply.error}. You can close this tab.`;
    clearInterval(ping);
    return;
  }
}

void main();
