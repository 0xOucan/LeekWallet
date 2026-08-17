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
import { interpretTransaction } from "../../packages/core/src/tx-interpret.ts";
import {
  APPROVAL_EDIT_NOTICE, inspectApproval, parseCapAmount,
  planCap, SEQUENCE_NEEDS_BROADCAST_NOTICE, type ApprovalCall, type CapStep,
} from "../../packages/core/src/approval-cap.ts";
import { TOKEN_SCALE_NOTICE } from "../../packages/core/src/balances.ts";
import { chainText, resolveChainForDapp } from "./chain-view.ts";
import { drawFindings, renderInterpretation } from "../interpretation-view.ts";
import { evaluateRules, type Finding } from "../../packages/core/src/rules.ts";
import type { TypedRender } from "../../packages/core/src/eip712.ts";
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
  /**
   * Say something to a screen reader now, interrupting whatever is being read.
   *
   * A dapp request arrives without anybody having pressed anything, so nothing
   * in the page draws a screen reader's attention to the card that appeared —
   * and the next thing that happens is a device asking to be confirmed. That
   * is the one arrival a wallet cannot afford to deliver silently.
   */
  announce(text: string): void;
  /** Log a line and announce it: the device is waiting for the user. */
  deviceAttention(line: string): void;
  /** Sign, and broadcast when asked. Returns a tx hash, or the raw tx. */
  signTransaction(tx: PlannedTx, broadcast: boolean): Promise<string>;
  /** EIP-191 personal_sign. Returns a 65-byte 0x signature. */
  signMessage(address: string, message: string): Promise<string>;
  /**
   * EIP-712 typed data. `request` is the document already transcribed into the
   * device's wire encoding by planRequest — the app does not get a second go at
   * interpreting the dapp's JSON, because two transcriptions are two chances to
   * send the device something other than what was previewed.
   */
  signTypedData(address: string, request: Record<string, unknown>): Promise<string>;
  log(line: string): void;
  /**
   * The local facts the Layer A rules compare against (rules.ts).
   *
   * Supplied by the app rather than gathered here, for two reasons. The
   * addresses come from this user's own history and the token addresses from
   * the advisory token list, and both already live in main.ts — a second copy
   * would mean a dapp request and the app's own send form could disagree about
   * whether a recipient is a lookalike. And it keeps this file with no reach
   * into storage: everything a dapp can cause is still answerable by reading
   * the bridge.
   */
  ruleFacts(): { knownAddresses: readonly string[]; knownTokens: readonly string[] };
  /**
   * What the approval editor needs and cannot know on its own: how to scale
   * the amount, and whether an allowance is already outstanding.
   *
   * Both come from outside this file for the same reason `ruleFacts` does —
   * the RPC failover and the token index live in main.ts, and a second route
   * to either would mean this card and the app's own screens could disagree
   * about the same token. `decimals` is self-declared or from an unchecked
   * list and is never evidence (PROTOCOL.md 6d); `current` absent means
   * nobody could read the allowance, which is emphatically not zero.
   */
  approvalFacts(query: {
    standard: "erc20" | "permit2";
    token: string;
    spender: string;
    chainId: number;
  }): Promise<{ decimals?: number; symbol?: string; current?: bigint }>;
  /**
   * Sign a capped approval — one transaction, or the zero-then-set pair.
   *
   * A separate route from `signTransaction` because the pair needs consecutive
   * nonces and a gas limit that does not come from an estimate (the second
   * transaction reverts under estimation while the old allowance is still
   * standing), and only main.ts has the RPC to arrange either. Each step is a
   * full device confirmation; this never batches them into one approval.
   */
  signApprovalCap(
    tx: PlannedTx,
    steps: readonly { data: string; label: string }[],
    broadcast: boolean,
  ): Promise<string>;
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
  /**
   * The approval the user is allowed to cap, and the edit if they made one.
   *
   * `original` is the dapp's calldata, kept verbatim so "restore the dapp's
   * amount" is a restoration rather than a re-encoding of what this app
   * believes the dapp meant. `steps` is present only once an edit has been
   * applied, and its existence is what routes the approval through
   * `signApprovalCap` instead of the ordinary path.
   */
  cap?: {
    call: ApprovalCall;
    original: string;
    facts?: { decimals?: number; symbol?: string; current?: bigint };
    steps?: CapStep[];
  };
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
  /* Whether a pairing has gone through and the dapp has not answered yet.
   *
   * Exists for one message. A scan pairs on its own, so pressing Pair a moment
   * later finds an empty field and used to answer "Nothing to pair with" --
   * which reads as a failure directly underneath a line saying the pairing
   * succeeded. The state is what makes the difference sayable. */
  let pairedAwaitingProposal = false;

  const connection = new WalletConnectConnection({
    onProposal: (p) => { proposal = p; drawProposal(); },
    onRequest: (r) => void receive(r),
    onSessionsChanged: (s) => {
      /* A live session ends the wait, so the Pair button must stop reporting
       * one. Saying "waiting for the dapp" while that very dapp is listed as
       * connected is worse than the message it replaced. */
      if (s.length > 0) pairedAwaitingProposal = false;
      drawSessions(s);
    },
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
      pairedAwaitingProposal = true;
      bridge.log("paired; waiting for the dapp's connection request");
    } catch (e) {
      bridge.log(`walletconnect: ${(e as Error).message}`);
      setStatus((e as Error).message);
    } finally {
      drawProjectId();
    }
  }

  $("wcpair").addEventListener("click", () => {
    const typed = ($("wcuri") as HTMLInputElement).value.trim();
    if (typed === "" && connection.sessions().length > 0) {
      const message = "A dapp is already connected. Paste a new code only to add another.";
      bridge.log(`walletconnect: ${message}`);
      setStatus(message);
      return;
    }
    if (typed === "" && pairedAwaitingProposal) {
      const message =
        "Already paired — waiting for the dapp to send its connection request. " +
        "If nothing arrives, the code may have expired; generate a fresh one.";
      bridge.log(`walletconnect: ${message}`);
      setStatus(message);
      return;
    }
    void pair(($("wcuri") as HTMLInputElement).value);
  });

  /* Both halves of the toggle in one place, because the button's label never
   * changes: pressed state is all a screen-reader user has to tell a running
   * camera from a stopped one. */
  const setScanPressed = (on: boolean): void =>
    $("wcscan").setAttribute("aria-pressed", String(on));

  $("wcscan").addEventListener("click", () => {
    if (scan) { scan.stop(); scan = null; $("wcvideo").hidden = true; setScanPressed(false); return; }
    if (!qrScanningAvailable()) { const m = qrUnavailable(WC_PASTE_INSTEAD); bridge.log(m); setStatus(m); return; }
    const video = $("wcvideo") as HTMLVideoElement;
    video.hidden = false;
    setScanPressed(true);
    /* The `wc:` test that used to live inside the scanner. It stays exactly as
     * strict as it was: a QR code in shot that happens to be a URL is ignored
     * rather than handed to the pairing code, so a poster on the wall behind
     * the laptop cannot interrupt the scan. */
    void scanQr(
      video,
      (raw) => (raw.toLowerCase().startsWith("wc:") ? raw : undefined),
      (uri) => {
        scan = null;
        video.hidden = true;
        setScanPressed(false);
        /* Say that the CAMERA produced this. Without it, a scanned pairing and
         * a pasted one are the same two log lines, and telling them apart was
         * guesswork at exactly the moment it mattered. */
        bridge.log(`scanned a pairing link from the camera (${uri.slice(0, 12)}…)`);
        /* Put it in the field the way a paste would, so what was scanned is
         * visible and the two routes look like the same operation. Pairing
         * still starts on its own -- making someone press Pair after aiming a
         * camera is a second step for no decision -- but the value is on
         * screen either way. */
        ($("wcuri") as HTMLInputElement).value = uri;
        void pair(uri);
      },
      (message) => { scan = null; video.hidden = true; setScanPressed(false); bridge.log(`camera: ${message}`); },
      undefined,
      (status) => bridge.log(`scan: ${status}`),
    )
      .then((handle) => {
        scan = handle;
        bridge.log(`camera ${handle.resolution.width}x${handle.resolution.height} focus=${handle.resolution.focusMode || "unreported"}; point it at the dapp's QR code`);
      })
      .catch((e: unknown) => {
        video.hidden = true;
        setScanPressed(false);
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
    /* Named, not counted: "a dapp wants to connect" with no name is an alert a
     * user can only answer by going to look. The name is dapp-authored and is
     * announced as such, exactly as the card labels it. */
    bridge.announce(
      `A dapp calling itself ${proposal.name} wants to connect. ` +
      `Its request is on screen under Dapps.`,
    );
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

    const queued: Queued = { request, plan };
    /* An `approve` the app could decode is the one request shape where the
     * user has a third answer available: not "sign this unlimited allowance"
     * or "go without the dapp", but "approve this much". Attached before the
     * card is drawn so the box appears with the request rather than popping in
     * underneath a preview somebody is already reading. */
    if (plan.kind === "transaction") {
      const call = inspectApproval({ to: plan.tx.to, data: plan.tx.data });
      if (call) queued.cap = { call, original: plan.tx.data };
    }
    queue.push(queued);
    drawRequest();
    /* The allowance reading and the decimals are a network round trip, so they
     * arrive after the card. Deliberately not awaited before drawing: a dapp
     * request that sat invisible while an RPC timed out would be a request the
     * user never saw. The editor stays usable meanwhile and says what it does
     * not yet know. */
    if (queued.cap) void loadApprovalFacts(queued);
  }

  /* ------------------------------------------------------- approval capping */

  async function loadApprovalFacts(queued: Queued): Promise<void> {
    const cap = queued.cap;
    if (!cap || queued.plan.kind !== "transaction") return;
    try {
      cap.facts = await bridge.approvalFacts({
        standard: cap.call.standard,
        token: cap.call.token,
        spender: cap.call.spender,
        chainId: queued.plan.tx.chainId,
      });
    } catch (e) {
      /* An absent reading is left absent rather than defaulted. planCap treats
       * undefined as "unknown" and says so on the card, which is the honest
       * outcome; a caught error becoming 0n would plan a single transaction
       * against a live allowance and revert on exactly the token this feature
       * was asked for. */
      bridge.log(`approval cap: could not read the current allowance — ${(e as Error).message}`);
    }
    // Only if this is still the request on screen; a queue that moved on while
    // the RPC answered must not have another request's numbers drawn into it.
    if (queue[0] === queued) drawCap();
  }

  /** The dapp's amount, in whatever units this app can honestly offer. */
  function requestedText(queued: Queued): string {
    const cap = queued.cap;
    if (!cap) return "";
    const { call, facts } = cap;
    const raw = `${call.amount} raw units`;
    const scaled = facts?.decimals !== undefined
      ? ` (about ${formatScaled(call.amount, facts.decimals)} ${facts.symbol ?? "tokens"})`
      : "";
    /* "Unlimited" is eth-decode.ts's word, and it is the word the device's own
     * approval screen uses. A second vocabulary here would leave the user
     * matching "no maximum" on one screen against "UNLIMITED" on the other. */
    return call.unlimited
      ? `The dapp asked for an UNLIMITED approval (${raw}) to ${call.spender}.`
      : `The dapp asked to approve ${raw}${scaled} to ${call.spender}.`;
  }

  /* Integer arithmetic, like everything else that scales an amount here: a
   * float would render a figure the calldata does not contain. */
  function formatScaled(raw: bigint, decimals: number): string {
    const unit = 10n ** BigInt(decimals);
    const whole = raw / unit;
    const frac = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac === "" ? whole.toString() : `${whole}.${frac}`;
  }

  function drawCap(): void {
    const section = $("wccap");
    const head = queue[0];
    const cap = head?.cap;
    if (!head || !cap || head.plan.kind !== "transaction") { section.hidden = true; return; }

    $("wccaprequested").textContent = requestedText(head);

    const decimals = cap.facts?.decimals;
    const symbol = cap.facts?.symbol;
    /* The unit goes in the visible label, because it is the difference between
     * approving 500 tokens and approving 500 of the smallest indivisible piece
     * of one, and a hint underneath is not part of the accessible name. */
    $("wccaplabel").textContent = decimals === undefined
      ? "New approval amount (raw units)"
      : `New approval amount (${symbol ?? "token"} units)`;
    $("wccapscale").textContent = decimals === undefined
      ? "Nothing this app can ask told it how many decimals this token uses, so " +
        "the amount is in raw units — the integer the contract stores."
      : `Your amount is multiplied by 10^${decimals} to get the raw units the ` +
        `device will show. ${TOKEN_SCALE_NOTICE}`;

    const notices = $("wccapnotices");
    notices.textContent = "";
    const say = (text: string): void => {
      const li = document.createElement("li");
      li.textContent = text;
      notices.appendChild(li);
    };
    /* Drawn before anything has been edited, not after it is applied. The
     * point of this sentence is to be read while the decision is still open. */
    say(APPROVAL_EDIT_NOTICE);
    if (cap.steps) for (const step of cap.steps) say(step.label);

    ($("wccapreset") as HTMLButtonElement).disabled = cap.steps === undefined;
    section.hidden = false;
  }

  /** Recompute the advisory preview after the calldata has been edited. */
  function redrawEditedPreview(head: Queued): void {
    if (head.plan.kind !== "transaction") return;
    const chain = getChain(head.plan.tx.chainId);
    head.plan.interpretation = interpretTransaction(
      {
        chainId: head.plan.tx.chainId,
        to: head.plan.tx.to,
        value: head.plan.tx.value,
        data: head.plan.tx.data,
        ...(head.plan.tx.gas !== undefined ? { gas: head.plan.tx.gas } : {}),
        ...(head.plan.tx.maxFeePerGas !== undefined
          ? { maxFeePerGas: head.plan.tx.maxFeePerGas }
          : {}),
      },
      chain ? { nativeSymbol: chain.nativeCurrency.symbol } : {},
    );
    drawRequest();
  }

  function applyCap(): void {
    const head = queue[0];
    const cap = head?.cap;
    const status = $("wccapstatus");
    const input = $("wccapamount") as HTMLInputElement;
    if (!head || !cap || head.plan.kind !== "transaction") return;

    const decimals = cap.facts?.decimals ?? 0;
    let amount: bigint;
    try {
      amount = parseCapAmount(input.value, decimals, cap.call.bits);
    } catch (e) {
      /* Refused, never rounded. `aria-invalid` because the message below the
       * field is not announced on its own when focus is still in the field. */
      input.setAttribute("aria-invalid", "true");
      status.textContent = (e as Error).message;
      bridge.announce(`That amount was not accepted: ${(e as Error).message}`);
      return;
    }
    input.removeAttribute("aria-invalid");

    const plan = planCap(cap.call, amount, cap.facts?.current, cap.facts);
    if (plan.zeroFirst && !head.plan.broadcast) {
      status.textContent = SEQUENCE_NEEDS_BROADCAST_NOTICE;
      bridge.announce(SEQUENCE_NEEDS_BROADCAST_NOTICE);
      bridge.log(`approval cap: not applied — ${SEQUENCE_NEEDS_BROADCAST_NOTICE}`);
      return;
    }

    cap.steps = plan.steps;
    /* The first step's calldata is what goes on the wire and into the preview.
     * For the sequence that is the zero, which is what the device will draw
     * first — showing the capped figure here while the device showed zero
     * would be exactly the app-versus-device disagreement this whole path is
     * built to avoid. */
    head.plan.tx.data = plan.steps[0]?.data ?? head.plan.tx.data;
    /* A gas limit measured for the dapp's own call does not necessarily fit a
     * different one, and for the sequence the second transaction cannot be
     * estimated at all. Dropping it hands the choice to main.ts, which knows
     * which step it is signing. */
    delete head.plan.tx.gas;

    const summary = plan.zeroFirst
      ? `Two transactions will be signed: ${plan.steps.map((s) => s.label).join("; ")}.`
      : `The dapp's amount has been replaced with ${amount} raw units.`;
    status.textContent = summary;
    for (const notice of plan.notices) bridge.log(`approval cap: ${notice}`);
    bridge.log(`approval cap: ${summary}`);
    bridge.announce(`${summary} Check the amount on the device before approving there.`);
    redrawEditedPreview(head);
  }

  function resetCap(): void {
    const head = queue[0];
    const cap = head?.cap;
    if (!head || !cap || head.plan.kind !== "transaction") return;
    delete cap.steps;
    head.plan.tx.data = cap.original;
    ($("wccapamount") as HTMLInputElement).value = "";
    $("wccapstatus").textContent = "Back to the amount the dapp asked for.";
    bridge.log("approval cap: restored the dapp's own amount");
    redrawEditedPreview(head);
  }

  $("wccapapply").addEventListener("click", applyCap);
  $("wccapreset").addEventListener("click", resetCap);

  /**
   * The rules' verdict on one pending request.
   *
   * The clock and the local history come from outside the rules so that they
   * stay pure (rules.ts header); this is the one place in the WalletConnect
   * path that supplies them, so a dapp request and the app's own send form are
   * judged against exactly the same facts.
   */
  function findingsFor(
    subject: { tx?: { to: string; value: bigint; data: string }; typed?: TypedRender },
  ): Finding[] {
    const facts = bridge.ruleFacts();
    return evaluateRules({
      chainId: bridge.chainId(),
      ...subject,
      nowSeconds: Math.floor(Date.now() / 1000),
      knownAddresses: facts.knownAddresses,
      knownTokens: facts.knownTokens,
    });
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
    // Redrawn per request; the editor is hidden for everything that is not an
    // approval so an amount box never sits under a transfer.
    $("wccap").hidden = true;

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
        findingsFor({ tx: { to: head.plan.tx.to, value: head.plan.tx.value, data: head.plan.tx.data } }),
      );
      preview.hidden = false;
      drawCap();
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
    } else if (head.plan.kind === "typed-data") {
      /* The device's own summary, then the dapp's document verbatim in a
       * <pre>. No interpretation of either: this app has no more standing to
       * explain a Permit than it has to explain a message, and the screen that
       * matters is the one on the device. */
      const pre = document.createElement("pre");
      pre.className = "wc-message";
      pre.textContent = JSON.stringify(head.plan.document, null, 2);
      body.append(
        `You would be signing this typed data with ${head.plan.address}. ` +
        `The device will show: ${head.plan.summary}`,
        pre,
      );
      /* The Layer A findings go here and nowhere else on this card: this is
       * where a phished Permit actually arrives, and it is the one request
       * shape where the device genuinely cannot make one of the checks for
       * itself — it has no reference chain to compare the domain's chainId
       * against (rules.ts). Still advisory, still drawn in the same list style
       * as a transaction's, and the closing line drawn with them says an empty
       * list is not an all-clear. */
      const list = document.createElement("ul");
      list.className = "preview__warnings";
      drawFindings(list, findingsFor({ typed: head.plan.render }));
      body.append(list);
    } else if (head.plan.kind === "switch-chain") {
      const chain = resolveChainForDapp(head.plan.chainId);
      body.textContent =
        `Wants this wallet to switch to ${chainText(head.plan.chainId)} ` +
        `(${head.plan.chainId})${chain?.testnet ? " — a testnet" : ""}. ` +
        `Nothing is signed by switching, but everything signed afterwards is for that network.`;
    }

    card.hidden = false;
    /* One sentence, not the card. Which dapp and which method is enough to
     * decide whether to go and read the rest; announcing the whole
     * interpretation would bury that in the fee fields. */
    bridge.announce(
      `${head.request.name} is asking for ${head.request.method}. ` +
      `The request is on screen under Dapps` +
      (queue.length > 1 ? `, with ${queue.length - 1} more waiting behind it.` : "."),
    );
  }

  async function settle(approve: boolean): Promise<void> {
    /* Peeked, not shifted. Removing it up front would show the *next* request
     * on the card while the device is still holding this one, and the two
     * would be one mis-click apart. */
    const head = queue[0];
    if (!head || settling) return;
    settling = true;
    const { request, plan } = head;
    const done = (): void => {
      settling = false;
      queue.shift();
      /* The editor's own fields are cleared with the request, not carried on to
       * the next one: a leftover "500" under a different dapp's approval is an
       * amount somebody could apply without reading which token it is for. */
      ($("wccapamount") as HTMLInputElement).value = "";
      ($("wccapamount") as HTMLInputElement).removeAttribute("aria-invalid");
      $("wccapstatus").textContent = "";
      drawRequest();
    };

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
      if (plan.kind === "transaction" && head.cap?.steps) {
        /* A capped approval. The device confirms every step on its own screen,
         * one at a time, and the amount it draws is decoded from the calldata
         * this app re-encoded — so the figure the user checks there is the
         * figure that gets signed, whatever this card said. */
        const steps = head.cap.steps;
        bridge.deviceAttention(
          steps.length > 1
            ? `${request.name}: ${steps.length} transactions to approve on the device, one at a time`
            : `${request.name}: check the capped amount on the device, then approve`,
        );
        const result = await bridge.signApprovalCap(plan.tx, steps, plan.broadcast);
        /* The dapp gets the answer for the approval it asked for — the last
         * step — and is not told the amount changed. It will find out the way
         * any allowance is found out: by reading it. */
        await connection.respond(request.topic, request.id, result);
        bridge.log(
          `${request.name}: approval capped and ${plan.broadcast ? `sent ${result}` : "signed"}`,
        );
      } else if (plan.kind === "transaction") {
        bridge.deviceAttention(`${request.name}: check every page on the device, then approve`);
        const result = await bridge.signTransaction(plan.tx, plan.broadcast);
        await connection.respond(request.topic, request.id, result);
        bridge.log(`${request.name}: ${plan.broadcast ? `sent ${result}` : "signed"}`);
      } else if (plan.kind === "message") {
        bridge.deviceAttention(`${request.name}: confirm the message on the device`);
        const signature = await bridge.signMessage(plan.address, plan.message);
        await connection.respond(request.topic, request.id, signature);
        bridge.log(`${request.name}: message signed`);
      } else if (plan.kind === "typed-data") {
        bridge.log(`${request.name}: check every page on the device, then approve`);
        const signature = await bridge.signTypedData(plan.address, plan.request);
        await connection.respond(request.topic, request.id, signature);
        bridge.log(`${request.name}: typed data signed`);
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
      end.setAttribute("aria-label", `End the session with ${session.name}`);
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
