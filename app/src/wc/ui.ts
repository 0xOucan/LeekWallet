/**
 * The WalletConnect panel (T32, T49) — pairing, sessions, pending requests.
 *
 * There is no address bar in this file and there will not be one. The dapp runs
 * in the user's own browser; what arrives here is structured JSON-RPC and
 * nothing else, so this app never renders a line of dapp HTML or script
 * (PROTOCOL.md 6b). The only dapp-authored strings that reach the screen are
 * its name and its URL, and both are drawn as `textContent` inside elements
 * labelled as "what the dapp calls itself" rather than as facts.
 *
 * The order of operations for a signing request is the load-bearing part:
 *
 *   arrives → planned (requests.ts) → refused here, or shown with the same
 *   advisory preview the app draws for itself → user approves → device shows
 *   its own rendering → device signs.
 *
 * A request the device would refuse never reaches the third step. The user is
 * told here, and the dapp is told immediately, because walking to a device to
 * press a button that will not appear is the worst version of this.
 */

import { DeviceError, ErrorCode } from "../../packages/core/src/transport.ts";
import { getChain } from "../../packages/core/src/chains.ts";
import { chainText, resolveChainForDapp } from "./chain-view.ts";
import { renderInterpretation } from "../interpretation-view.ts";
import { WalletConnectConnection, RELAY_URL, type WcProposal, type WcRequest, type WcSession } from "./connection.ts";
import {
  internalError, USER_REJECTED, DEVICE_TIMEOUT, deviceCannotDisplay,
  type JsonRpcErrorBody,
} from "./errors.ts";
import { planRequest, type PlannedTx, type RequestPlan } from "./requests.ts";
import { qrScanningAvailable, scanQr, qrUnavailable, type QrScan } from "./qr.ts";
import {
  isValidProjectId, resolveProjectId, setStoredProjectId, storedProjectId,
} from "./project-id.ts";

/**
 * Everything this panel needs from the rest of the app.
 *
 * An interface rather than direct imports so the WalletConnect code cannot
 * reach into the device client on its own: every path to the hardware goes
 * through one of these three methods, which is what makes "what can a dapp
 * cause?" answerable by reading this file.
 */
export interface WalletBridge {
  /** Checksummed addresses currently offered, or empty when locked. */
  accounts(): string[];
  /** Does the connected device have blind signing on? See WalletContext. */
  blindSigning(): boolean;
  chainId(): number;
  /** Switch the app's chain, exactly as the selector does. */
  setChainId(chainId: number): void;
  /** Sign, and broadcast when asked. Returns a tx hash, or the raw tx. */
  signTransaction(tx: PlannedTx, broadcast: boolean): Promise<string>;
  /** EIP-191 personal_sign. Returns a 65-byte 0x signature. */
  signMessage(address: string, message: string): Promise<string>;
  log(line: string): void;
}

/* The fallback named when this webview cannot scan. Specific to this panel:
 * the generic message in qr.ts has to serve the send form too, where the
 * workaround is typing an address rather than pasting a link. */
const WC_PASTE_INSTEAD = "Copy the wc: link from the dapp and paste it above instead.";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** A request waiting for the user, with its plan already computed. */
interface Queued {
  request: WcRequest;
  plan: RequestPlan;
}

/**
 * Device errors carry protocol codes; dapps understand JSON-RPC codes. Mapping
 * them is not cosmetic — a dapp that cannot tell "the user said no" from "the
 * wallet broke" retries the wrong one.
 */
function toJsonRpcError(e: unknown): JsonRpcErrorBody {
  if (e instanceof DeviceError) {
    if (e.code === ErrorCode.UserRejected) return USER_REJECTED;
    if (e.code === ErrorCode.UserTimeout) return DEVICE_TIMEOUT;
    if (e.code === ErrorCode.Undecodable) {
      return deviceCannotDisplay("the device refused it at the confirmation screen.");
    }
    return internalError(`The LeekWallet device refused the request: ${e.message}`);
  }
  return internalError((e as Error).message ?? String(e));
}

export function initWalletConnect(bridge: WalletBridge): {
  /** Called when the app's chain changes, so sessions are told. */
  chainChanged(chainId: number): void;
  /** Called when the address list changes, so new sessions get the right ones. */
  accountsChanged(): void;
} {
  const queue: Queued[] = [];
  let proposal: WcProposal | null = null;
  let scan: QrScan | null = null;
  let starting: Promise<void> | null = null;
  /* A second click before the buttons disable would answer the same request
   * twice; the relay drops the duplicate, but the device would be asked to sign
   * twice, which is a confirmation the user did not intend to give. */
  let settling = false;

  const connection = new WalletConnectConnection({
    onProposal: (p) => { proposal = p; drawProposal(); },
    onRequest: (r) => void receive(r),
    onSessionsChanged: (s) => drawSessions(s),
    log: bridge.log,
  });

  /* -------------------------------------------------------------- project id */

  function drawProjectId(): void {
    const state = resolveProjectId();
    const hint = $("wcprojecthint");
    hint.textContent = state.problem !== ""
      ? state.problem
      : `Using the ${state.source} project ID. It identifies this app to the relay and is not a secret.`;
    hint.dataset["problem"] = state.problem !== "" ? "yes" : "no";
    ($("wcprojectid") as HTMLInputElement).value = storedProjectId();
    ($("wcpair") as HTMLButtonElement).disabled = state.id === "";
    ($("wcscan") as HTMLButtonElement).disabled = state.id === "" || !qrScanningAvailable();
  }

  $("wcprojectsave").addEventListener("click", () => {
    const value = ($("wcprojectid") as HTMLInputElement).value;
    if (value.trim() !== "" && !isValidProjectId(value)) {
      bridge.log("that project ID is not 32 hex characters; copy it again from cloud.reown.com");
    }
    setStoredProjectId(value);
    drawProjectId();
    /* Not applied to a running relay client: the SDK builds its socket URL
     * once. Saying so beats silently continuing on the old ID. */
    if (connection.ready) {
      bridge.log("project ID saved — restart the app for it to take effect on the relay");
    } else {
      bridge.log("project ID saved");
    }
  });

  /* ------------------------------------------------------------------ pairing */

  async function ensureStarted(): Promise<void> {
    if (connection.ready) {
      connection.setAccounts(bridge.accounts());
      return;
    }
    const state = resolveProjectId();
    if (state.id === "") throw new Error(state.problem);
    if (!starting) {
      setStatus(`Connecting to the relay at ${new URL(RELAY_URL).host}…`);
      starting = connection.start(state.id, bridge.accounts()).finally(() => { starting = null; });
    }
    await starting;
    setStatus(`Connected to the relay at ${new URL(RELAY_URL).host}.`);
  }

  async function pair(uri: string): Promise<void> {
    ($("wcpair") as HTMLButtonElement).disabled = true;
    try {
      await ensureStarted();
      await connection.pair(uri);
      ($("wcuri") as HTMLInputElement).value = "";
      bridge.log("paired; waiting for the dapp's connection request");
    } catch (e) {
      bridge.log(`walletconnect: ${(e as Error).message}`);
      setStatus((e as Error).message);
    } finally {
      drawProjectId();
    }
  }

  $("wcpair").addEventListener("click", () => {
    void pair(($("wcuri") as HTMLInputElement).value);
  });

  $("wcscan").addEventListener("click", () => {
    if (scan) { scan.stop(); scan = null; $("wcvideo").hidden = true; return; }
    if (!qrScanningAvailable()) { const m = qrUnavailable(WC_PASTE_INSTEAD); bridge.log(m); setStatus(m); return; }
    const video = $("wcvideo") as HTMLVideoElement;
    video.hidden = false;
    /* The `wc:` test that used to live inside the scanner. It stays exactly as
     * strict as it was: a QR code in shot that happens to be a URL is ignored
     * rather than handed to the pairing code, so a poster on the wall behind
     * the laptop cannot interrupt the scan. */
    void scanQr(
      video,
      (raw) => (raw.toLowerCase().startsWith("wc:") ? raw : undefined),
      (uri) => { scan = null; video.hidden = true; void pair(uri); },
      (message) => { scan = null; video.hidden = true; bridge.log(`camera: ${message}`); },
      undefined,
      (status) => bridge.log(`scan: ${status}`),
    )
      .then((handle) => {
        scan = handle;
        bridge.log(`camera ${handle.resolution.width}x${handle.resolution.height} focus=${handle.resolution.focusMode || "unreported"}; point it at the dapp's QR code`);
      })
      .catch((e: unknown) => {
        video.hidden = true;
        bridge.log(`camera: ${(e as Error).message}`);
      });
  });

  /* ---------------------------------------------------------------- proposals */

  function drawProposal(): void {
    const card = $("wcproposal");
    if (!proposal) { card.hidden = true; return; }

    // textContent throughout: the dapp wrote these strings.
    $("wcpropname").textContent = proposal.name;
    $("wcpropurl").textContent = proposal.url || "(no address given)";

    const chains = proposal.chains.map((id) => chainText(id)).join(", ");
    $("wcpropdetail").textContent =
      `Wants to see ${bridge.accounts().length} address(es) on ${chains || "no chain this wallet knows"}, ` +
      `and to ask for signatures. It cannot move anything without a confirmation on the device.`;

    const warn = $("wcpropwarn");
    warn.textContent = "";
    const add = (text: string): void => {
      const li = document.createElement("li");
      li.textContent = text;
      warn.appendChild(li);
    };
    if (bridge.accounts().length === 0) {
      add("The device is locked, so there are no addresses to offer. Unlock it, then pair again.");
    }
    for (const m of proposal.unsupportedMethods) {
      add(`This dapp requires ${m}, which this wallet does not support. Parts of it will not work.`);
    }
    for (const id of proposal.unsupportedChains) {
      add(`This dapp requires chain ${id}, which is not in this wallet's list.`);
    }
    card.hidden = false;
  }

  $("wcpropapprove").addEventListener("click", () => {
    const id = proposal?.id;
    if (id === undefined) return;
    proposal = null;
    drawProposal();
    connection.approveProposal(id).then(
      () => bridge.log("dapp connected"),
      (e: unknown) => bridge.log(`walletconnect: could not approve — ${(e as Error).message}`),
    );
  });

  $("wcpropreject").addEventListener("click", () => {
    const id = proposal?.id;
    if (id === undefined) return;
    proposal = null;
    drawProposal();
    void connection.rejectProposal(id, "The user declined the connection.");
    bridge.log("connection request declined");
  });

  /* ----------------------------------------------------------------- requests */

  async function receive(request: WcRequest): Promise<void> {
    const chainId = request.chainId || bridge.chainId();
    const plan = planRequest(request.method, request.params, {
      accounts: bridge.accounts(),
      chainId,
      blindSigning: bridge.blindSigning(),
    });

    /* Answered from app state, with no device round trip and no prompt. Both
     * are read-only and the dapp already learned them at session time; making
     * the user click for them would train clicking. */
    if (plan.kind === "answer") {
      await connection.respond(request.topic, request.id, plan.result);
      bridge.log(`${request.name}: answered ${request.method}`);
      return;
    }

    /* Refused before the user is involved at all. This is the honest-refusal
     * path of PROTOCOL.md 6bis: the dapp gets a code it can branch on, and the
     * reason is logged where the user can read it. */
    if (plan.kind === "error") {
      await connection.respondError(request.topic, request.id, plan.error);
      bridge.log(`${request.name}: refused ${request.method} — ${plan.error.message}`);
      setStatus(`Refused ${request.method} from ${request.name}: ${plan.error.message}`);
      return;
    }

    queue.push({ request, plan });
    drawRequest();
  }

  function drawRequest(): void {
    const card = $("wcrequest");
    const head = queue[0];
    $("wcqueue").textContent =
      queue.length > 1 ? `${queue.length - 1} more request(s) waiting behind this one.` : "";

    if (!head) { card.hidden = true; return; }

    $("wcreqname").textContent = head.request.name;
    $("wcreqmethod").textContent = head.request.method;

    const body = $("wcreqbody");
    body.textContent = "";
    const preview = $("wcpreview");
    preview.hidden = true;

    if (head.plan.kind === "transaction") {
      const symbol = getChain(head.plan.tx.chainId)?.nativeCurrency.symbol ?? "";
      renderInterpretation(
        {
          summary: $("wcpsummary"),
          fields: $("wcpfields"),
          warnings: $("wcpwarnings"),
          authority: $("wcpauthority"),
        },
        head.plan.interpretation,
        symbol,
      );
      preview.hidden = false;
      body.textContent = head.plan.broadcast
        ? "If you approve, this app broadcasts the signed transaction."
        : "If you approve, the signed transaction is returned to the dapp, which broadcasts it.";
    } else if (head.plan.kind === "message") {
      /* The message verbatim, in a <pre>, with no interpretation of any kind.
       * The device will show the same characters; anything else here would be
       * two different messages competing to be the one you agreed to. */
      const pre = document.createElement("pre");
      pre.className = "wc-message";
      pre.textContent = head.plan.message;
      body.append("You would be signing this message with " + head.plan.address + ":", pre);
    } else if (head.plan.kind === "switch-chain") {
      const chain = resolveChainForDapp(head.plan.chainId);
      body.textContent =
        `Wants this wallet to switch to ${chainText(head.plan.chainId)} ` +
        `(${head.plan.chainId})${chain?.testnet ? " — a testnet" : ""}. ` +
        `Nothing is signed by switching, but everything signed afterwards is for that network.`;
    }

    card.hidden = false;
  }

  async function settle(approve: boolean): Promise<void> {
    /* Peeked, not shifted. Removing it up front would show the *next* request
     * on the card while the device is still holding this one, and the two
     * would be one mis-click apart. */
    const head = queue[0];
    if (!head || settling) return;
    settling = true;
    const { request, plan } = head;
    const done = (): void => { settling = false; queue.shift(); drawRequest(); };

    if (!approve) {
      done();
      await connection.respondError(request.topic, request.id, {
        code: 4001,
        message: "The user rejected the request in the wallet.",
      });
      bridge.log(`${request.name}: ${request.method} rejected here`);
      return;
    }

    for (const button of ["wcapprove", "wcreject"]) {
      ($(button) as HTMLButtonElement).disabled = true;
    }
    try {
      if (plan.kind === "transaction") {
        bridge.log(`${request.name}: check every page on the device, then approve`);
        const result = await bridge.signTransaction(plan.tx, plan.broadcast);
        await connection.respond(request.topic, request.id, result);
        bridge.log(`${request.name}: ${plan.broadcast ? `sent ${result}` : "signed"}`);
      } else if (plan.kind === "message") {
        bridge.log(`${request.name}: confirm the message on the device`);
        const signature = await bridge.signMessage(plan.address, plan.message);
        await connection.respond(request.topic, request.id, signature);
        bridge.log(`${request.name}: message signed`);
      } else if (plan.kind === "switch-chain") {
        bridge.setChainId(plan.chainId);
        // null is the EIP-3326 success value; a dapp checks for its absence.
        await connection.respond(request.topic, request.id, null);
        await connection.emitChainChanged(plan.chainId);
        bridge.log(`${request.name}: switched to chain ${plan.chainId}`);
      }
    } catch (e) {
      const error = toJsonRpcError(e);
      await connection.respondError(request.topic, request.id, error);
      bridge.log(`${request.name}: ${request.method} failed — ${error.message}`);
    } finally {
      for (const button of ["wcapprove", "wcreject"]) {
        ($(button) as HTMLButtonElement).disabled = false;
      }
      done();
    }
  }

  $("wcapprove").addEventListener("click", () => void settle(true));
  $("wcreject").addEventListener("click", () => void settle(false));

  /* ----------------------------------------------------------------- sessions */

  function drawSessions(sessions: WcSession[]): void {
    const list = $("wcsessions");
    list.textContent = "";
    if (sessions.length === 0) {
      list.textContent = "No dapp is connected.";
      return;
    }
    for (const session of sessions) {
      const row = document.createElement("div");
      row.className = "wc-session";

      const name = document.createElement("strong");
      name.textContent = session.name;         // dapp-authored; text only
      const url = document.createElement("span");
      url.className = "muted";
      url.textContent = session.url;
      const chains = document.createElement("span");
      chains.className = "muted";
      chains.textContent = session.chains
        .map((c) => chainText(Number(c.split(":")[1] ?? 0)))
        .join(", ");

      const end = document.createElement("button");
      end.textContent = "End session";
      end.addEventListener("click", () => {
        end.disabled = true;
        connection.disconnect(session.topic).then(
          () => bridge.log(`ended the session with ${session.name}`),
          (e: unknown) => { end.disabled = false; bridge.log(`walletconnect: ${(e as Error).message}`); },
        );
      });

      row.append(name, url, chains, end);
      list.appendChild(row);
    }
  }

  function setStatus(text: string): void {
    $("wcstatus").textContent = text;
  }

  /* ------------------------------------------------------------------- wiring */

  drawProjectId();
  drawSessions([]);
  setStatus(
    `Not connected to the relay. Pairing connects to ${new URL(RELAY_URL).host}, ` +
    `a third party that sees that a dapp and this wallet are talking, and when — ` +
    `never the contents, and never a key.`,
  );
  if (!qrScanningAvailable()) $("wcscanhint").textContent = qrUnavailable(WC_PASTE_INSTEAD);

  return {
    chainChanged(chainId: number): void {
      void connection.emitChainChanged(chainId);
    },
    accountsChanged(): void {
      connection.setAccounts(bridge.accounts());
      drawProposal();
    },
  };
}
