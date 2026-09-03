/**
 * The popup, and the connection-approval window: the same document, two views.
 *
 * WHY THE POPUP IS THE ONE THAT ASKS FOR THE PORT
 *
 * `navigator.serial.requestPort()` opens a browser-drawn chooser and therefore
 * requires user activation. Neither the service worker (no `navigator.serial`
 * at all) nor the offscreen document (no user, therefore no gesture) can call
 * it. The popup can, because there is a real click behind it.
 *
 * That is not a workaround. A granted port is remembered against the
 * extension's ORIGIN, so once the human has chosen the device here, the
 * offscreen document's `getPorts()` returns it from then on, across browser
 * restarts, with no further prompting. The human authorises; the background
 * holds. See offscreen.ts.
 *
 * WHAT THIS POPUP REFUSES TO BE
 *
 * A transaction approval screen. There is no "confirm send" dialog here, and
 * that is deliberate: a browser-drawn confirmation is drawn by the same
 * software an attacker who owns the host already owns, and a wallet that
 * trains people to read it has taught them to read the wrong screen. The
 * device decodes the bytes itself and renders them on hardware the host cannot
 * write to. So when a signature is in flight this popup says one thing —
 * check the device — and gets out of the way.
 *
 * The one decision that IS made here is which addresses a website may see.
 * That is a browser-side question by nature: the device has no idea what a
 * website is.
 */

import "../../src/tokens.css";
import "./popup.css";
import { serialSupport, DEVICE_FILTERS } from "./env.ts";
import { allChains, chainLabel } from "../../packages/core/src/chains.ts";
import type { PopupCommand, WalletState } from "./protocol.ts";

const root = document.getElementById("root") as HTMLElement;

/**
 * The approval window and the toolbar popup differ by one query parameter.
 *
 * One document rather than two, because the approval window needs everything
 * the popup needs — the device may be unplugged, locked, or on the wrong
 * wallet at the moment a site asks to connect — plus one extra question. Two
 * files would be two copies of the connection flow, and the copy nobody looks
 * at is the one that rots.
 */
const isApprovalView = new URLSearchParams(location.search).get("view") === "approve";
if (isApprovalView) document.body.classList.add("view-approve");

/* ------------------------------------------------------------ DOM helpers */

type Child = string | Node | null | undefined | false;

/**
 * Elements are built, never parsed.
 *
 * No `innerHTML` anywhere in this file. Some of what it renders — an origin, a
 * device label — comes from outside, and the moment a string is parsed as
 * markup the question of whether it was safe becomes a question somebody has
 * to keep answering. `textContent` never has to be audited.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function button(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls ? { class: cls } : {}, label);
  b.addEventListener("click", onClick);
  return b;
}

/** Middles are where an address swap hides, so both ends are always shown. */
const short = (address: string): string => `${address.slice(0, 8)}…${address.slice(-6)}`;

/* --------------------------------------------------------- worker traffic */

async function send<T = unknown>(command: PopupCommand): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(command)) as
    | { ok?: unknown; err?: string }
    | undefined;
  if (!reply) throw new Error("the extension did not answer");
  if (reply.err !== undefined) throw new Error(reply.err);
  return reply.ok as T;
}

/* -------------------------------------------------------------- rendering */

let state: WalletState | null = null;
let busyWith: string | null = null;
let lastError: string | null = null;

/**
 * Run a command, keep the UI honest about it, and never leave it stuck.
 *
 * A wallet popup that shows a spinner for ever after a failure is one people
 * force-quit and distrust. The `finally` is the point of this wrapper.
 */
async function act(label: string, command: PopupCommand): Promise<void> {
  busyWith = label;
  lastError = null;
  render();
  try {
    state = await send<WalletState>(command);
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
  } finally {
    busyWith = null;
    await refresh();
  }
}

async function refresh(): Promise<void> {
  try {
    const next = await send<WalletState>({ pop: "state" });
    /* The worker cannot answer these two — it has no `navigator.serial`. This
     * document can, so the truth is stitched in here rather than guessed
     * there. */
    const support = serialSupport();
    next.serialSupported = support.supported;
    next.serialReason = support.reason;
    next.portGranted = support.supported
      ? (await navigator.serial.getPorts()).length > 0
      : false;
    state = next;
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
  }
  render();
}

/**
 * Ask the human to choose the device.
 *
 * Cancelling the chooser throws, and it is caught and dropped rather than
 * reported: closing a picker is a decision, not an error, and a red banner
 * after it would be the extension arguing with the user.
 */
async function grantPort(): Promise<void> {
  lastError = null;
  try {
    await navigator.serial.requestPort({ filters: DEVICE_FILTERS });
  } catch {
    await refresh();
    return;
  }
  await act("Connecting…", { pop: "connect" });
}

function render(): void {
  root.textContent = "";
  if (!state) {
    root.append(el("p", { class: "muted" }, lastError ?? "Loading…"));
    return;
  }
  root.append(header(state));
  if (lastError !== null) {
    root.append(el("section", { class: "notice bad" }, el("p", {}, lastError)));
  }
  if (!state.serialSupported) {
    root.append(unsupportedSection(state));
    return;
  }
  if (isApprovalView) {
    root.append(approvalSection(state));
    return;
  }
  root.append(
    connectionSection(state),
    state.awaitingDevice !== null ? awaitingSection(state) : accountsSection(state),
    chainSection(state),
    sitesSection(state),
    settingsSection(state),
    logSection(state),
  );
}

function header(s: WalletState): HTMLElement {
  const on = s.connected && s.unlocked;
  return el(
    "h1",
    {},
    el("span", { class: `dot ${on ? "on" : "off"}`, "aria-hidden": "true" }),
    "LeekWallet",
    el(
      "span",
      { class: "muted grow", style: "text-align:right;font-weight:400" },
      /* The word, not only the dot. Colour alone is not a status. */
      !s.serialSupported ? "unavailable" : on ? "ready" : s.connected ? "locked" : "not connected",
    ),
  );
}

function unsupportedSection(s: WalletState): HTMLElement {
  return el(
    "section",
    { class: "notice bad" },
    el("h2", {}, "This browser cannot reach the device"),
    el("p", {}, s.serialReason),
  );
}

/**
 * Connect, compare, unlock — in that order, one step visible at a time.
 *
 * The passkey step is the security-critical one and it is given the whole
 * panel when it is live. Six digits shown next to five other controls is six
 * digits nobody compares.
 */
function connectionSection(s: WalletState): HTMLElement {
  const box = el("section", {}, el("h2", {}, "Device"));

  if (s.passkey !== null) {
    box.append(
      el("p", {}, "Check that these six digits match the ones on the device screen."),
      el("div", { class: "passkey" }, s.passkey),
      el(
        "p",
        { class: "muted" },
        "If they differ, do not approve: something is relaying the connection. " +
          "Unplug the device and start again.",
      ),
      el(
        "div",
        { class: "row" },
        button("They match — I approved on the device", () => {
          void act("Waiting for the device…", { pop: "confirm" });
        }, "primary"),
        button("Cancel", () => void act("Disconnecting…", { pop: "disconnect" })),
      ),
    );
    return box;
  }

  if (busyWith !== null) {
    box.append(el("p", { class: "muted" }, busyWith));
    return box;
  }

  if (!s.connected) {
    box.append(
      el(
        "p",
        { class: "muted" },
        s.portGranted
          ? "A device has been authorised. Plug it in and connect."
          : "Choose the device's serial port. Chrome will ask you once; after " +
            "that the extension reconnects without prompting.",
      ),
      el(
        "div",
        { class: "row" },
        s.portGranted
          ? button("Connect", () => void act("Connecting…", { pop: "connect" }), "primary")
          : button("Choose device…", () => void grantPort(), "primary"),
        s.portGranted && button("Choose a different device…", () => void grantPort(), "link"),
      ),
    );
    return box;
  }

  if (!s.unlocked) {
    box.append(
      el("p", {}, "The device is locked. Unlocking asks for the PIN on the device itself — it never travels to the browser."),
      el(
        "div",
        { class: "row" },
        button("Unlock", () => void act("Enter the PIN on the device…", { pop: "unlock" }), "primary"),
        button("Disconnect", () => void act("Disconnecting…", { pop: "disconnect" })),
      ),
    );
    return box;
  }

  box.append(
    el("p", { class: "muted" }, "Connected and unlocked over an encrypted channel."),
    el("div", { class: "row" }, button("Disconnect", () => void act("Disconnecting…", { pop: "disconnect" }))),
  );
  return box;
}

function awaitingSection(s: WalletState): HTMLElement {
  return el(
    "section",
    { class: "notice" },
    el("h2", {}, "Waiting for the device"),
    el("p", {}, `${s.awaitingDevice ?? "A site"} asked for a signature.`),
    el(
      "p",
      { class: "muted" },
      "Read every page on the device's own screen before you approve. The " +
        "device decodes the transaction itself — what it shows you is not " +
        "what this extension says the transaction is.",
    ),
  );
}

function accountsSection(s: WalletState): HTMLElement {
  const box = el("section", {}, el("h2", {}, "Addresses"));
  if (!s.connected || !s.unlocked) {
    box.append(el("p", { class: "muted" }, "Connect and unlock the device to see addresses."));
    return box;
  }
  if (s.addresses.length === 0) {
    box.append(el("p", { class: "muted" }, "No addresses derived yet. A site asking to connect will trigger derivation."));
    return box;
  }
  const list = el("ul", {});
  s.addresses.forEach((address, i) => {
    list.append(
      el(
        "li",
        { class: "account" },
        el("span", { class: "muted mono" }, String(i)),
        el("code", { class: "grow" }, address),
      ),
    );
  });
  box.append(list);
  return box;
}

function chainSection(s: WalletState): HTMLElement {
  const select = el("select", { class: "grow" }) as HTMLSelectElement;
  for (const chain of allChains()) {
    const option = el("option", { value: String(chain.id) }, chainLabel(chain.id));
    if (chain.id === s.chainId) option.setAttribute("selected", "selected");
    select.append(option);
  }
  select.addEventListener("change", () => {
    void act("Switching…", { pop: "setChain", chainId: Number(select.value) });
  });

  return el(
    "section",
    {},
    el("h2", {}, "Network"),
    el("div", { class: "row" }, select),
    el(
      "p",
      { class: "muted" },
      /* Said plainly because it is a disclosure, not a detail: somebody has to
       * answer the reads, and whoever it is learns what this browser is
       * looking at. */
      "Reads go to that chain's public endpoints, which learn which addresses " +
        "you look at. None of them can move anything.",
    ),
  );
}

function sitesSection(s: WalletState): HTMLElement {
  const box = el("section", {}, el("h2", {}, "Connected sites"));
  if (s.grants.length === 0) {
    box.append(el("p", { class: "muted" }, "No site has been given an address."));
    return box;
  }
  const list = el("ul", {});
  for (const grant of s.grants) {
    list.append(
      el(
        "li",
        { class: "site" },
        el(
          "span",
          { class: "grow" },
          el("span", { class: "mono" }, grant.origin),
          el("br"),
          el("span", { class: "muted mono" }, grant.accounts.map(short).join(", ")),
        ),
        button("Revoke", () => void act("Revoking…", { pop: "revoke", origin: grant.origin }), "link"),
      ),
    );
  }
  box.append(list);
  return box;
}

function settingsSection(s: WalletState): HTMLElement {
  const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
  checkbox.checked = s.overrideWindowEthereum;
  checkbox.addEventListener("change", () => {
    void act("Saving…", { pop: "setOverride", value: checkbox.checked });
  });

  return el(
    "section",
    {},
    el("h2", {}, "Compatibility"),
    el(
      "label",
      { class: "check" },
      checkbox,
      el(
        "span",
        {},
        el("strong", {}, "Also claim window.ethereum"),
        el("br"),
        el(
          "span",
          { class: "muted" },
          "Off by default. LeekWallet announces itself with EIP-6963, which " +
            "lets it sit beside MetaMask and lets you pick per site. Turn this " +
            "on only for an older site that has no wallet chooser — it competes " +
            "with your other wallets for one slot, it does not always win, and " +
            "open tabs must be reloaded for it to take effect.",
        ),
      ),
    ),
  );
}

function logSection(s: WalletState): HTMLElement {
  const box = el("section", {}, el("h2", {}, "Activity"));
  if (s.log.length === 0) {
    box.append(el("p", { class: "muted" }, "Nothing yet."));
    return box;
  }
  const strip = el("div", { class: "log" });
  for (const line of s.log) strip.append(el("div", {}, line));
  box.append(strip);
  return box;
}

/* ------------------------------------------------------- approval view */

/**
 * "Site X wants an address."
 *
 * The whole decision, and nothing else on the screen. Note what is not offered
 * here: any way to approve while the device is locked or absent. An approval
 * granted against addresses nobody could see would be an approval of nothing
 * in particular.
 */
function approvalSection(s: WalletState): HTMLElement {
  if (s.pending === null) {
    return el(
      "section",
      {},
      el("h2", {}, "Nothing to approve"),
      el("p", { class: "muted" }, "The request was withdrawn or has already been answered."),
      el("div", { class: "row" }, button("Close", () => window.close())),
    );
  }

  const pending = s.pending;
  const box = el(
    "section",
    {},
    el("h2", {}, "Connection request"),
    el("p", {}, el("code", {}, pending.origin), " wants to see your addresses."),
    el(
      "p",
      { class: "muted" },
      "Giving a site an address lets it read your balance and ask you to sign. " +
        "It cannot sign anything by itself — every signature is approved on the " +
        "device, on the device's own screen.",
    ),
  );

  if (s.addresses.length === 0) {
    box.append(
      el("p", { class: "danger" }, "The device is not offering any addresses right now."),
      el("div", { class: "row" }, button("Reject", () => reject(pending.id), "primary")),
    );
    return box;
  }

  /* First address pre-selected, the rest not. Most sites want one, and a
   * dialog that pre-ticks everything is a dialog that hands over more than the
   * person reading it intended. */
  const boxes: HTMLInputElement[] = [];
  const list = el("ul", {});
  s.addresses.forEach((address, i) => {
    const check = el("input", { type: "checkbox", id: `a${i}` }) as HTMLInputElement;
    check.checked = i === 0;
    check.value = address;
    boxes.push(check);
    list.append(
      el("li", { class: "account" }, check, el("label", { for: `a${i}` }, el("code", {}, address))),
    );
  });

  box.append(
    list,
    el(
      "div",
      { class: "row" },
      button("Connect", () => {
        const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
        if (chosen.length === 0) {
          lastError = "Choose at least one address, or reject the request.";
          render();
          return;
        }
        void approve(pending.id, chosen);
      }, "primary"),
      button("Reject", () => reject(pending.id)),
    ),
  );
  return box;
}

async function approve(id: string, accounts: string[]): Promise<void> {
  try {
    await send({ pop: "approve", id, accounts });
    window.close();
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    await refresh();
  }
}

function reject(id: string): void {
  /* Closing the window would also reject — the worker treats a closed approval
   * window as a refusal — but saying so explicitly means the dapp is told at
   * once rather than when the window manager gets around to it. */
  void send({ pop: "reject", id }).catch(() => {}).then(() => window.close());
}

/* ------------------------------------------------------------- lifecycle */

/**
 * Repaint while things are moving.
 *
 * The interesting states — waiting for a passkey comparison, waiting for a PIN
 * on the device, waiting for a signature — all resolve somewhere else, and the
 * popup has no way to be told. Polling twice a second is coarse and it is the
 * honest fit for a surface that only exists while someone is looking at it.
 */
setInterval(() => {
  if (busyWith === null) void refresh();
}, 500);

void refresh();
