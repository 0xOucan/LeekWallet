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
import { addressQr } from "./receive.ts";
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
const view = new URLSearchParams(location.search).get("view");
const isApprovalView = view === "approve";

/*
 * Is this document a real window, or the toolbar popup?
 *
 * It decides where `navigator.serial.requestPort()` may be called, and getting
 * it wrong looks exactly like a dead button. A toolbar popup is destroyed the
 * instant it loses focus, and opening the browser's serial chooser takes focus
 * — so the popup closes, this script's context is torn down with it, and the
 * promise nobody is left to await simply vanishes. The chooser may not even
 * paint. Reported as "I click choose device and nothing happens", which is
 * precisely what it looks like from outside.
 *
 * A `chrome.windows.create` popup is an ordinary window and survives. The
 * service worker already opens one for connection approvals; the port chooser
 * uses the same door.
 */
const inOwnWindow = view !== null;
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
/*
 * Ask with no filter at all.
 *
 * A filtered chooser that comes back empty and an unfiltered one that comes
 * back empty mean completely different things — the first says the four vendor
 * IDs are wrong for this board, the second says the browser cannot see any
 * serial device at all and the fault is below us. There is no way to tell them
 * apart from the outside, because both look like a dialog that offered nothing.
 *
 * So it is offered as its own action rather than inferred. It is also
 * genuinely useful: a board behind a bridge nobody listed still deserves to be
 * pickable, and the handshake is what decides whether the thing on the other
 * end is a wallet.
 */
async function grantAnyPort(): Promise<void> {
  await grantPort({ unfiltered: true });
}

async function grantPort(opts: { unfiltered?: boolean } = {}): Promise<void> {
  lastError = null;

  /* From the toolbar popup, hand the job to a window that will still exist
     when the chooser closes. See `inOwnWindow`. */
  /*
   * A visible trace, because the failures here are all silent.
   *
   * Every way this can go wrong -- no API, a chooser that opens empty, a
   * chooser that never opens, a click that arrived without user activation --
   * produces the same nothing on screen, and asking someone to open devtools on
   * the right one of four extension contexts has already cost two rounds. So
   * the window says what it did, in order, where the person clicking can read
   * it.
   */
  const trace: string[] = [];
  const note = (line: string) => {
    trace.push(line);
    lastError = trace.join("\n");
    render();
  };

  note(`serial API: ${navigator.serial ? "present" : "MISSING"}`);
  try {
    note(`already granted: ${(await navigator.serial.getPorts()).length} port(s)`);
  } catch (e) {
    note(`getPorts threw: ${(e as Error)?.message ?? e}`);
  }
  note(`context: ${inOwnWindow ? "window (chooser allowed)" : "toolbar popup"}`);

  if (!inOwnWindow) {
    /*
     * A tab, not a popup window.
     *
     * Chrome anchors the serial chooser to a tab. A `type: "popup"` window has
     * none, so requestPort() there resolves as NotFoundError with no dialog
     * ever drawn -- indistinguishable from a user closing an empty chooser, and
     * it cost several rounds to tell the two apart. The website's own flasher
     * working from an ordinary page is what pointed at the difference.
     *
     * The approval flow keeps its popup window: it shows a passkey and takes a
     * click, and never opens a chooser.
     */
    await chrome.tabs.create({
      url: chrome.runtime.getURL("popup.html?view=connect"),
    });
    /* Closing explicitly rather than letting focus do it: the window opening
       is the answer to the click, and leaving both on screen invites someone
       to press Choose device twice. */
    window.close();
    return;
  }

  note(`calling requestPort(${opts.unfiltered ? "no filter" : "filtered"})…`);
  try {
    await navigator.serial.requestPort(
      opts.unfiltered ? {} : { filters: DEVICE_FILTERS },
    );
    note("a port was chosen");
  } catch (e) {
    /*
     * Cancelling the chooser and failing to open it are different events, and
     * catching both silently made them indistinguishable — the button appeared
     * dead either way, with nothing on screen and nothing in the console. That
     * cost a debugging round trip on real hardware.
     *
     * A cancelled picker throws NotFoundError and is a decision, not a fault:
     * dropped without comment, because a red banner after someone closes a
     * dialog is the extension arguing with them. Anything else is a fault and
     * is shown, including the one that matters here — a chooser that opened
     * with nothing in it still resolves as NotFoundError, so the empty case is
     * called out separately rather than looking like a cancellation.
     */
    const err = e as DOMException;
    if (err?.name === "NotFoundError") {
      const ports = await navigator.serial.getPorts();
      if (ports.length === 0) {
        lastError = trace.join("\n") + "\n\n" +
          "No serial device was chosen. If the list was empty, the browser " +
          "cannot see the board: check the cable carries data, and that this " +
          "browser is allowed to reach it — a Flatpak or Snap browser often " +
          "cannot without extra permission.";
      }
    } else {
      lastError = trace.join("\n") + `\n\n${err?.name ?? "Error"}: ${err?.message ?? String(e)}`;
    }
    await refresh();
    return;
  }
  await act("Connecting…", { pop: "connect" });
}

/**
 * Which connected site's address picker is open, or null.
 *
 * Popup state, deliberately not persisted: the popup is destroyed every time
 * it closes, and an editor that reopened half-finished would invite a click on
 * Save for a decision made minutes ago about a site the user has forgotten.
 */
let changingOrigin: string | null = null;

/** Which address's receive panel is open, or null. Popup-lifetime only. */
let receiveIndex: number | null = null;

/**
 * The send form, if one is open.
 *
 * Held here rather than read off the DOM so a redraw cannot silently reset a
 * half-typed recipient -- and a recipient that changes between being read and
 * being sent is the failure this whole screen exists to avoid.
 */
let sending: {
  index: number;
  recipient: string;
  amount: string;
  /** Empty for the chain's native currency. */
  token: string;
  /** Filled in by a contract read, never assumed. */
  meta?: { decimals: number; symbol: string } | undefined;
  balance?: string | undefined;
  note?: string | undefined;
} | null = null;

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
        button("Show every serial device", () => void grantAnyPort(), "link"),
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
    const showing = receiveIndex === i;
    list.append(
      el(
        "li",
        { class: "account" },
        el("span", { class: "muted mono" }, String(i)),
        el("code", { class: "grow" }, address),
        button(showing ? "Hide" : "Receive", () => {
          receiveIndex = showing ? null : i;
          render();
        }, "link"),
        button(sending?.index === i ? "Close" : "Send", () => {
          sending = sending?.index === i
            ? null
            : { index: i, recipient: "", amount: "", token: "" };
          render();
        }, "link"),
      ),
    );
    if (showing) list.append(el("li", { class: "receive" }, receivePanel(address, s)));
    if (sending?.index === i) list.append(el("li", { class: "receive" }, sendPanel(address, s)));
  });
  box.append(list);
  return box;
}

/**
 * The QR, and the sentence that makes it safe to use.
 *
 * A receiving address has no signature in it, so the device's "nothing is
 * signed except what I drew" guarantee does not reach this screen: the
 * addresses were read over the session and rendered by software on a computer.
 * A compromised host cannot spend from them or extract a key; what it can do is
 * show somebody else's address so that money meant for you is paid to them.
 * Nothing in this popup can detect that, because a convincing lie here looks
 * exactly like the truth.
 *
 * The device answers it. It has a View Address screen of its own, drawn from
 * its own key on a display the browser cannot reach, so the instruction is to
 * compare — and it is on the screen next to the QR rather than in a document
 * nobody opens.
 */
function receivePanel(address: string, s: WalletState): HTMLElement {
  const panel = el("div", { class: "receive-panel" });
  panel.append(addressQr(address));
  panel.append(el("p", { class: "mono break" }, address));
  panel.append(el("p", { class: "muted" },
    `On ${chainLabel(s.chainId)}. The code carries the address only — no chain ` +
    `and no amount — so it cannot send a payer to the wrong network.`));
  panel.append(el("p", { class: "warn" },
    "Before you are paid anything that matters, check this address on the " +
    "device itself: Menu → View Address. This popup is software on a computer, " +
    "and a computer that has been tampered with can show you somebody else's " +
    "address. The device draws its own from its own key, and comparing the two " +
    "settles it."));
  panel.append(button("Copy", () => {
    void navigator.clipboard?.writeText(address).then(
      () => { lastError = "Address copied. Compare it on the device before use."; render(); },
      () => { lastError = "This window would not let the popup copy. Select the address instead."; render(); },
    );
  }, "link"));
  return panel;
}

/**
 * The send form.
 *
 * The one thing this screen must not do is look authoritative. Everything on
 * it -- the balance, the symbol, the recipient the user pasted -- is rendered
 * by software on a computer, and the guarantee a hardware wallet offers is
 * that the DEVICE decides, not the browser. So the form composes a proposal
 * and the last word on the screen is an instruction to read the device.
 *
 * `transfer(address,uint256)` is in the firmware's own decode table, so the
 * device draws the recipient and the amount itself from the calldata. A
 * tampered popup can ask to pay somebody else; it cannot make the device say
 * it is paying you.
 */
function sendPanel(from: string, s: WalletState): HTMLElement {
  const f = sending as NonNullable<typeof sending>;
  const panel = el("div", { class: "receive-panel" });

  const native = s.chainId;
  panel.append(el("p", { class: "muted" },
    `From ${short(from)} on ${chainLabel(native)}.`));

  const recipient = el("input", {
    type: "text", placeholder: "0x… recipient", value: f.recipient, class: "grow mono",
  }) as HTMLInputElement;
  recipient.addEventListener("input", () => { f.recipient = recipient.value; });
  panel.append(el("label", {}, "To", recipient));

  const token = el("input", {
    type: "text", placeholder: "blank for the chain's own coin", value: f.token, class: "grow mono",
  }) as HTMLInputElement;
  token.addEventListener("input", () => { f.token = token.value; });
  panel.append(el("label", {}, "Token contract", token));

  panel.append(button("Read token", () => {
    const address = f.token.trim();
    if (address === "") {
      f.meta = undefined;
      f.note = "Sending the chain's own coin.";
      render();
      return;
    }
    void (async () => {
      /* decimals() comes off the contract. Assuming 18 for a token that uses 6
       * sends a million times the intended amount, and the mistake is
       * irreversible the moment it is signed. */
      const got = await send<{ decimals?: number; symbol?: string; error?: string }>(
        { pop: "tokenInfo", token: address });
      if (got.error !== undefined || got.decimals === undefined) {
        f.meta = undefined;
        f.note = got.error ?? "That address did not answer decimals().";
      } else {
        f.meta = { decimals: got.decimals, symbol: got.symbol ?? "TOKEN" };
        f.note = `${f.meta.symbol}, ${f.meta.decimals} decimals — read from the contract.`;
      }
      render();
    })();
  }, "link"));

  panel.append(button("Check balance", () => {
    void (async () => {
      const got = await send<{ units?: string; error?: string }>({
        pop: "balanceOf", address: from,
        ...(f.token.trim() === "" ? {} : { token: f.token.trim() }),
      });
      /* Reported, never defaulted to zero: "you hold nothing" and "we could not
       * ask" are different facts, and showing the first for the second sends
       * somebody to fund an address that is already funded. */
      f.balance = got.error !== undefined ? got.error : got.units;
      render();
    })();
  }, "link"));

  if (f.balance !== undefined) {
    panel.append(el("p", { class: "muted mono break" }, `balance: ${f.balance} raw units`));
  }
  if (f.note !== undefined) panel.append(el("p", { class: "muted" }, f.note));

  const amount = el("input", {
    type: "text", placeholder: "0.0", value: f.amount, class: "grow mono",
  }) as HTMLInputElement;
  amount.addEventListener("input", () => { f.amount = amount.value; });
  panel.append(el("label", {}, "Amount", amount));
  panel.append(el("p", { class: "muted" },
    "In whole units, the way you would say it out loud. An amount with more "
    + "decimal places than the token has is refused, not rounded."));

  panel.append(button("Send", () => {
    const tokenAddress = f.token.trim();
    if (tokenAddress !== "" && f.meta === undefined) {
      lastError = "Read the token first, so its decimals come from the contract rather than a guess.";
      render();
      return;
    }
    void act("Check the device…", {
      pop: "send", index: f.index, recipient: f.recipient.trim(), amount: f.amount.trim(),
      ...(tokenAddress === "" ? {} : { token: tokenAddress }),
    });
  }));

  panel.append(el("p", { class: "warn" },
    "The device draws the recipient and the amount from the transaction itself "
    + "and signs only what it drew. Read them THERE, not here — this popup is "
    + "software on a computer, and comparing the two is the whole point of the "
    + "device."));
  return panel;
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
    /* Expanded in place rather than in a second window: the decision is "which
     * of these addresses", and the addresses are already on this screen. */
    const editing = changingOrigin === grant.origin;
    const row = el(
      "li",
      { class: "site" },
      el(
        "span",
        { class: "grow" },
        el("span", { class: "mono" }, grant.origin),
        el("br"),
        el("span", { class: "muted mono" }, grant.accounts.map(short).join(", ")),
      ),
      button(editing ? "Cancel" : "Change", () => {
        changingOrigin = editing ? null : grant.origin;
        render();
      }, "link"),
      button("Revoke", () => void act("Revoking…", { pop: "revoke", origin: grant.origin }), "link"),
    );
    list.append(row);

    if (editing) {
      const granted = new Set(grant.accounts.map((a) => a.toLowerCase()));
      const boxes: HTMLInputElement[] = [];
      const picker = el("ul", { class: "accounts" });
      if (s.addresses.length === 0) {
        picker.append(el("li", { class: "muted" },
          "Connect and unlock the device to change which addresses this site sees."));
      }
      s.addresses.forEach((address, i) => {
        const check = el("input", { type: "checkbox", id: `c${i}` }) as HTMLInputElement;
        check.checked = granted.has(address.toLowerCase());
        boxes.push(check);
        picker.append(el("li", { class: "account" }, check,
          el("label", { for: `c${i}` }, el("code", {}, address))));
      });
      if (s.addresses.length > 0) {
        picker.append(el("li", {},
          button("Save", () => {
            const chosen = s.addresses.filter((_, i) => boxes[i]?.checked === true);
            changingOrigin = null;
            void act("Updating…", { pop: "setAccounts", origin: grant.origin, accounts: chosen });
          }),
          /* Said out loud because it is not obvious that a site finds out at
             all, and because unticking everything is a disconnect. */
          el("span", { class: "muted" },
            " The site is told immediately, through accountsChanged. " +
            "Unticking every address disconnects it."),
        ));
      }
      list.append(el("li", { class: "site-editor" }, picker));
    }
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
