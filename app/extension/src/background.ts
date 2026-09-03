/**
 * The service worker: a router, a permission ledger, and nothing else.
 *
 * WHY IT CANNOT BE MORE THAN THAT
 *
 * In Manifest V3 the extension's background is an ephemeral service worker.
 * Chrome starts it for an event and stops it again — the documented idle
 * timeout is thirty seconds, and it is not a suggestion. Every variable in
 * this file's module scope is therefore a cache, not a store, and anything
 * that must survive is written to `chrome.storage`.
 *
 * That constraint decides the architecture. A serial port cannot live here:
 * `navigator.serial` is not exposed to workers at all, and even if it were, a
 * hardware wallet session is a pair of nonce counters that only mean anything
 * while both ends agree. A worker evicted between two frames would leave the
 * device holding a session the browser has forgotten, and every later request
 * would fail to decrypt with nothing on either screen to explain it. Signing
 * takes as long as a human takes to read four pages on an OLED and press a
 * button, which is routinely longer than the worker is allowed to live.
 *
 * So the port lives in an offscreen document (see offscreen.ts) and this file
 * talks to it. The worker dying mid-request costs one request; it does not
 * cost the session, and it does not cost the device's state.
 *
 * WHAT THIS FILE DECIDES
 *
 * Exactly one thing: which origins may see which addresses. That is the only
 * security decision the browser side of a hardware wallet gets to make, and it
 * is made against `sender.origin` — the origin the browser asserts — never
 * against anything a page said about itself.
 *
 * WHAT THIS FILE DOES NOT DECIDE
 *
 * Whether a transaction is safe. That is the device's job, from the device's
 * own decode of the bytes, on the device's own screen. This extension shows no
 * second confirmation dialog for signing, deliberately: a browser-drawn
 * approval screen is drawn by software an attacker who owns the host also
 * owns, and teaching people to read it is teaching them to read the wrong one.
 * The gate here is origin access. The decision is the device's.
 */

import { getChain, allChains, type ChainStore } from "../../packages/core/src/chains.ts";
import {
  FailoverRpc, fetchRpcSend, RpcResponseError,
} from "../../packages/core/src/rpc.ts";
import {
  EIP1193,
  type OwnerCommand, type OwnerEnvelope, type OwnerEvent, type OwnerReply,
  type PageEvent, type PageRequest, type PendingApproval, type PopupCommand,
  type WalletState,
} from "./protocol.ts";

const OFFSCREEN_PATH = "offscreen.html";
const LOG_LIMIT = 40;

/* ------------------------------------------------------------- persistence */

interface Grant {
  /** Addresses this origin may see, lowercased. Order is the user's choice. */
  accounts: string[];
  grantedAt: number;
}

interface Persisted {
  /** Keyed by `sender.origin`, e.g. "https://app.uniswap.org". */
  grants: Record<string, Grant>;
  chainId: number;
  overrideWindowEthereum: boolean;
}

const DEFAULTS: Persisted = {
  grants: {},
  chainId: 1,
  overrideWindowEthereum: false,
};

async function readState(): Promise<Persisted> {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...(stored as Partial<Persisted>) };
}

async function writeState(patch: Partial<Persisted>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/**
 * The activity log.
 *
 * `chrome.storage.session` rather than a module variable, because the popup
 * asks for it after the worker has probably been restarted at least once and
 * an empty log is indistinguishable from a log of nothing happening. Session
 * storage is cleared when the browser closes, which is right: this is a
 * debugging strip, not a record, and a record of which dapps somebody used is
 * not a thing to leave on disk.
 */
async function appendLog(line: string): Promise<void> {
  const { log = [] } = await chrome.storage.session.get({ log: [] as string[] });
  const next = [`${new Date().toLocaleTimeString()}  ${line}`, ...log].slice(0, LOG_LIMIT);
  await chrome.storage.session.set({ log: next });
}

/**
 * A `ChainStore` backed by nothing.
 *
 * `rpc.ts` remembers which endpoint answered so the next request starts there,
 * and it wants `localStorage`, which a service worker does not have. Giving it
 * a per-invocation Map means the preference is forgotten every time the worker
 * restarts. That costs at most one extra attempt against a dead endpoint. The
 * offscreen document, which does the signing and broadcasting, is a real
 * document and gets the real sticky preference.
 */
function memoryStore(): ChainStore {
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
  };
}

/* -------------------------------------------------- talking to the owner */

/**
 * Create the offscreen document if it is not already there.
 *
 * `createDocument` throws if one exists, and two callers can race into it —
 * two tabs asking to connect at the same moment is the ordinary case, not the
 * exotic one — so the in-flight promise is shared. Without that, the loser of
 * the race gets "Only a single offscreen document may be created" and the user
 * gets a failure with no cause they could act on.
 *
 * The `reason` is `WORKERS`, and that deserves a note: Chrome's enumerated
 * reasons do not include "hold a serial port", because the offscreen API was
 * designed around DOM access rather than around device handles. `WORKERS` is
 * the closest honest description — this document exists to run a long-lived
 * background task the worker cannot host. If Chrome ever tightens what it
 * accepts here, this is the line that will need to change, and the
 * `justification` is written for a human reviewer rather than a parser.
 */
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Holds the Web Serial connection to the hardware wallet. A service " +
          "worker cannot: it has no navigator.serial and it is evicted while " +
          "the user is still reading the device's confirmation screen.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

let ownerSeq = 0;

/**
 * Send one command to the port owner and await its answer.
 *
 * Errors come back as strings with an optional device error code, and the code
 * is what matters: 0x0200 is "the user pressed reject on the device", and a
 * dapp told that as a generic internal error will show a red crash toast for
 * what was a deliberate, correct human decision.
 */
class OwnerError extends Error {
  readonly deviceCode: number | undefined;
  constructor(message: string, deviceCode: number | undefined) {
    super(message);
    this.name = "OwnerError";
    this.deviceCode = deviceCode;
  }
}

async function ask<T = unknown>(command: OwnerCommand): Promise<T> {
  await ensureOffscreen();
  const envelope: OwnerEnvelope = {
    to: "leek-owner",
    id: `o${++ownerSeq}-${Date.now()}`,
    command,
  };
  const reply = (await chrome.runtime.sendMessage(envelope)) as OwnerReply | undefined;
  if (!reply) throw new OwnerError("the port owner did not answer", undefined);
  if (reply.err !== undefined) throw new OwnerError(reply.err, reply.errCode);
  return reply.ok as T;
}

/* --------------------------------------------------------- owner mirror */

/**
 * The last snapshot the owner pushed.
 *
 * A cache, and treated as one: every path that matters re-asks. It exists so
 * the popup can render immediately on open instead of showing an empty shell
 * while a round trip happens, which is the difference between a popup that
 * feels instant and one that flickers.
 */
interface OwnerSnapshot {
  connected: boolean;
  label: string | null;
  passkey: string | null;
  confirmed: boolean;
  unlocked: boolean;
  addresses: string[];
  account: number;
}

const EMPTY_SNAPSHOT: OwnerSnapshot = {
  connected: false,
  label: null,
  passkey: null,
  confirmed: false,
  unlocked: false,
  addresses: [],
  account: 0,
};

async function ownerSnapshot(fresh: boolean): Promise<OwnerSnapshot> {
  if (fresh) {
    try {
      const snap = await ask<OwnerSnapshot>({ cmd: "status" });
      await chrome.storage.session.set({ snapshot: snap });
      return snap;
    } catch {
      return EMPTY_SNAPSHOT;
    }
  }
  const { snapshot } = await chrome.storage.session.get({ snapshot: EMPTY_SNAPSHOT });
  return snapshot as OwnerSnapshot;
}

/* ------------------------------------------------------ page-facing events */

/**
 * Push an EIP-1193 event to every frame that has a content script.
 *
 * Broadcast rather than targeted, because a grant is per-origin and an origin
 * can be open in any number of tabs and iframes. The content script drops the
 * event if its own origin has no grant, so a site that was never connected
 * never learns that anything changed — which is the point: `accountsChanged`
 * leaking to an unconnected origin would tell it an address it was never
 * given.
 */
async function broadcast(event: string, data: unknown, onlyOrigins: Set<string>): Promise<void> {
  if (onlyOrigins.size === 0) return;
  const message: PageEvent = {
    channel: "leekwallet",
    dir: "event",
    event,
    data,
    origins: [...onlyOrigins],
  };
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    /* Sent to every frame in every tab and filtered at the far end against
     * each frame's own origin. Filtering here by `tab.url` would be filtering
     * by the TOP-LEVEL document, which says nothing about the origin of an
     * iframe inside it — and it is the iframe case that matters, because a
     * connected dapp embedded in an unconnected page is exactly how an
     * `accountsChanged` would reach somebody it was not meant for. */
    chrome.tabs.sendMessage(tab.id, message).catch(() => {
      /* No content script in that tab — a settings page, a PDF viewer, a tab
       * discarded from memory. Not an error, and not worth a log line. */
    });
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------- approvals */

/**
 * The single in-flight connection request, if any.
 *
 * In module scope, so an evicted worker loses it. That is a real limitation
 * and it is stated in the README rather than papered over: the alternative,
 * persisting a half-answered approval across a restart, would mean a click in
 * the popup could resolve a request whose page has long since navigated away.
 * Losing it costs the dapp one rejected `eth_requestAccounts`, which every
 * connect button in the ecosystem already handles.
 */
let pending: (PendingApproval & {
  resolve: (accounts: string[]) => void;
  reject: (reason: { code: number; message: string }) => void;
}) | null = null;

function clearPending(): void {
  pending = null;
  void chrome.action.setBadgeText({ text: "" });
}

/** The window id of the approval popup, so an unrelated close is not a reject. */
let approvalWindowId: number | null = null;

async function openApprovalWindow(): Promise<void> {
  await chrome.action.setBadgeText({ text: "1" });
  await chrome.action.setBadgeBackgroundColor({ color: "#3F6E31" });
  /* A window rather than `chrome.action.openPopup()`: opening the toolbar
   * popup programmatically is only permitted from a user gesture in the
   * browser's own UI, and there is none here — the gesture happened in the
   * page. A small popup window is what every other wallet does for the same
   * reason. */
  const window = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?view=approve"),
    type: "popup",
    width: 400,
    height: 620,
  });
  approvalWindowId = window.id ?? null;
}

/* ------------------------------------------------------- the EIP-1193 core */

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "RpcError";
  }
}

/**
 * Read-only methods proxied to the chain's public endpoints.
 *
 * A provider that answers only the seven signing methods is not usable: viem,
 * ethers and wagmi all call `eth_call`, `eth_getBalance` and friends through
 * the same provider they connected with, and a dapp whose reads fail is a dapp
 * that looks broken rather than one that looks unsupported.
 *
 * An allowlist rather than a passthrough, and the reason is disclosure, not
 * safety: every proxied call tells a public node operator something about what
 * this browser is looking at. Naming the methods keeps that list short,
 * auditable, and free of the state-changing ones (`eth_sendRawTransaction` is
 * deliberately absent — a raw transaction this extension never saw signed is
 * not something it should relay).
 */
const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
]);

const hexChainId = (id: number): string => `0x${id.toString(16)}`;

async function grantedAccounts(origin: string): Promise<string[]> {
  const { grants } = await readState();
  return grants[origin]?.accounts ?? [];
}

/**
 * Resolve the address a signing request names, or refuse.
 *
 * Case-insensitive, because dapps send checksummed, lowercase and (rarely)
 * uppercase forms of the same address and all three are the same account. But
 * the address must be one this origin was actually granted: an origin that can
 * name any address the device derived could ask for a signature from an
 * account the user never connected to it.
 */
async function indexForAddress(origin: string, address: unknown): Promise<number> {
  if (typeof address !== "string") {
    throw new RpcError(EIP1193.invalidParams, "no address was given");
  }
  const want = address.toLowerCase();
  const granted = await grantedAccounts(origin);
  if (!granted.includes(want)) {
    throw new RpcError(
      EIP1193.unauthorized,
      "that address has not been connected to this site",
    );
  }
  const snap = await ownerSnapshot(true);
  const index = snap.addresses.findIndex((a) => a.toLowerCase() === want);
  if (index < 0) {
    throw new RpcError(
      EIP1193.unauthorized,
      "the device is not currently offering that address — it may be locked, " +
      "or on a different wallet or account than when this site connected",
    );
  }
  return index;
}

/**
 * Every path that needs the device says the same thing when it is missing.
 *
 * Note what is NOT checked here: whether this browser has Web Serial at all.
 * A service worker has a `navigator` with no `serial` on it even in Chrome, so
 * asking the question in this context would answer "unsupported" everywhere
 * and refuse every request on every browser. The question belongs to a
 * document — the popup asks it, and the answer reaches the user as a sentence
 * rather than as a mysterious 4900. From here, "no device" is the whole truth
 * available and the whole truth needed.
 */
async function requireDevice(): Promise<OwnerSnapshot> {
  const snap = await ownerSnapshot(true);
  if (!snap.connected || !snap.confirmed) {
    throw new RpcError(
      EIP1193.disconnected,
      "no LeekWallet device is connected — open the extension and connect it",
    );
  }
  if (!snap.unlocked) {
    throw new RpcError(EIP1193.disconnected, "the device is locked — unlock it to continue");
  }
  return snap;
}

/**
 * A number a dapp gave us, as a bigint, or a refusal.
 *
 * Dapps send quantities as hex strings, as decimal strings, and occasionally
 * as JavaScript numbers that have already lost precision. The first two are
 * accepted; a number is accepted only when it is a safe integer, because
 * silently signing `1e21` rounded to the nearest double is the kind of bug
 * that costs somebody the difference.
 */
function quantity(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    if (typeof value === "string") return BigInt(value).toString();
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("not a safe integer");
      }
      return BigInt(value).toString();
    }
    if (typeof value === "bigint") return value.toString();
  } catch {
    /* fall through to the refusal below */
  }
  throw new RpcError(EIP1193.invalidParams, `${field} is not a quantity this wallet can read`);
}

async function handle(origin: string, method: string, params: unknown[]): Promise<unknown> {
  const state = await readState();

  switch (method) {
    /* ---------------------------------------------------------- accounts */

    case "eth_accounts": {
      /* Never prompts, never touches the device, and returns [] for an
       * unconnected origin. Dapps poll this on every page load to decide
       * whether to show a connect button; making it prompt would put a dialog
       * in front of everyone who merely visited. */
      return await grantedAccounts(origin);
    }

    case "eth_requestAccounts": {
      const already = await grantedAccounts(origin);
      if (already.length > 0) return already;

      await requireDevice();
      /* Derive before asking. The approval window has to show real addresses —
       * a picker of placeholders is one nobody can make a decision from — and
       * deriving ten addresses takes about half a second on the device. */
      await ask<string[]>({ cmd: "derive", count: 10 });

      if (pending) {
        throw new RpcError(
          EIP1193.userRejected,
          "another site is already waiting for a connection decision",
        );
      }

      const approval = await new Promise<string[]>((resolve, reject) => {
        pending = {
          id: `p${Date.now()}`,
          origin,
          method: "eth_requestAccounts",
          resolve,
          reject: (r) => reject(new RpcError(r.code, r.message)),
        };
        void openApprovalWindow();
      }).finally(clearPending);

      const accounts = approval.map((a) => a.toLowerCase());
      /* Re-read rather than merging into the snapshot taken at the top of this
       * function. A human took seconds to answer, and in that time another tab
       * may have been granted or revoked; writing back the old map would
       * silently undo their decision. */
      const fresh = await readState();
      const grants = { ...fresh.grants, [origin]: { accounts, grantedAt: Date.now() } };
      await writeState({ grants });
      await appendLog(`${origin} connected to ${accounts.length} account(s)`);
      await broadcast("accountsChanged", accounts, new Set([origin]));
      await broadcast("connect", { chainId: hexChainId(state.chainId) }, new Set([origin]));
      return accounts;
    }

    /* ------------------------------------------------------------ chain */

    case "eth_chainId":
      return hexChainId(state.chainId);

    case "wallet_switchEthereumChain": {
      const arg = params[0] as { chainId?: unknown } | undefined;
      const requested = arg?.chainId;
      if (typeof requested !== "string") {
        throw new RpcError(EIP1193.invalidParams, "wallet_switchEthereumChain needs a chainId");
      }
      let id: number;
      try {
        id = Number(BigInt(requested));
      } catch {
        throw new RpcError(EIP1193.invalidParams, `${requested} is not a chain id`);
      }
      if (!getChain(id)) {
        /* 4902 is the code dapps special-case to mean "offer to add it". This
         * extension does not implement `wallet_addEthereumChain`: a chain
         * added by a website is a set of RPC endpoints chosen by that website,
         * and an endpoint that lies about nonce, gas price and balance is
         * enough to get an honest user to sign a bad transaction. The curated
         * registry in chains.ts is the answer, and adding to it is a code
         * change somebody reviews. */
        throw new RpcError(
          EIP1193.unrecognizedChain,
          `chain ${id} is not in this wallet's registry, and this wallet does not ` +
          "let a website add one",
        );
      }
      if (id === state.chainId) return null;
      await writeState({ chainId: id });
      await appendLog(`switched to chain ${id}`);
      /* To every connected origin, not only the one that asked. There is a
       * single active chain, so a switch driven by one tab changes what every
       * other tab is talking to, and a dapp that was not told is a dapp
       * building a transaction for the wrong network. */
      await broadcast("chainChanged", hexChainId(id), new Set(Object.keys(state.grants)));
      return null;
    }

    /* ---------------------------------------------------------- signing */

    case "personal_sign": {
      /* Parameter order is (message, address) — the reverse of eth_sign, which
       * is a footgun the ecosystem has simply lived with. Some older dapps get
       * it backwards; rather than guessing, the address is the one of the two
       * that looks like an address. Guessing wrong would sign with the wrong
       * key, which no amount of care further down would catch. */
      const [a, b] = params;
      const isAddr = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
      const address = isAddr(a) ? a : b;
      const payload = isAddr(a) ? b : a;
      const index = await indexForAddress(origin, address);
      await requireDevice();

      if (typeof payload !== "string") {
        throw new RpcError(EIP1193.invalidParams, "personal_sign needs a message");
      }
      /* Hex in, text out. EIP-191 signs bytes; the device renders them as text
       * so the user can read what they are agreeing to, and a message that is
       * not valid UTF-8 is one the device will refuse rather than draw as
       * mojibake. */
      const message = /^0x[0-9a-fA-F]*$/.test(payload) ? hexToUtf8(payload) : payload;
      return await ask<string>({ cmd: "signMessage", index, message });
    }

    case "eth_signTypedData_v4": {
      const [address, doc] = params;
      const index = await indexForAddress(origin, address);
      await requireDevice();
      let parsed: unknown = doc;
      if (typeof doc === "string") {
        try {
          parsed = JSON.parse(doc);
        } catch {
          throw new RpcError(EIP1193.invalidParams, "the typed data is not valid JSON");
        }
      }
      /* The chain the domain names must be the chain this wallet is on. A
       * mismatch is how a signature collected on a testnet gets replayed on
       * mainnet, and the dapp is in a far better position to fix it than the
       * user is to notice it. */
      const domainChain = (parsed as { domain?: { chainId?: unknown } })?.domain?.chainId;
      if (domainChain !== undefined && domainChain !== null) {
        const asNumber = Number(BigInt(domainChain as string | number));
        if (asNumber !== state.chainId) {
          throw new RpcError(
            EIP1193.invalidParams,
            `this typed data names chain ${asNumber} but the wallet is on ` +
            `${state.chainId} — switch chains first`,
          );
        }
      }
      return await ask<string>({ cmd: "signTypedData", index, doc: parsed });
    }

    case "eth_sendTransaction": {
      const tx = params[0] as Record<string, unknown> | undefined;
      if (!tx) throw new RpcError(EIP1193.invalidParams, "eth_sendTransaction needs a transaction");
      const index = await indexForAddress(origin, tx["from"]);
      await requireDevice();

      const to = tx["to"];
      if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        /* Contract creation is refused rather than mishandled. The device has
         * no screen for "this deploys code you cannot read", and signing
         * something it cannot describe is precisely what a hardware wallet
         * exists to prevent. */
        throw new RpcError(
          EIP1193.invalidParams,
          "this wallet does not sign contract creations — every transaction " +
          "must name a recipient the device can show you",
        );
      }
      const data = tx["data"] ?? tx["input"];
      if (data !== undefined && data !== null && typeof data !== "string") {
        throw new RpcError(EIP1193.invalidParams, "calldata must be a hex string");
      }

      /* Each optional field is converted ONCE and only then decided about.
       * Calling the converter inside both halves of a conditional spread reads
       * as harmless and is not: it doubles the refusals a malformed value can
       * throw, and it is the shape of code where the value that was checked
       * and the value that was sent quietly stop being the same one. */
      const value = quantity(tx["value"], "value");
      const gas = quantity(tx["gas"], "gas");
      const maxFee = quantity(tx["maxFeePerGas"], "maxFeePerGas");
      const maxPriority = quantity(tx["maxPriorityFeePerGas"], "maxPriorityFeePerGas");
      const nonce = quantity(tx["nonce"], "nonce");

      const command: OwnerCommand = {
        cmd: "signTransaction",
        index,
        chainId: state.chainId,
        tx: {
          to,
          ...(value !== undefined ? { value } : {}),
          /* `"0x"` is how several libraries spell "no calldata". Passing it
           * through would make a plain transfer look to the device like a
           * contract call with an empty body. */
          ...(typeof data === "string" && data !== "0x" ? { data } : {}),
          ...(nonce !== undefined ? { nonce: Number(nonce) } : {}),
          ...(gas !== undefined ? { gas } : {}),
          ...(maxFee !== undefined ? { maxFeePerGas: maxFee } : {}),
          ...(maxPriority !== undefined ? { maxPriorityFeePerGas: maxPriority } : {}),
        },
        broadcast: true,
      };

      await appendLog(`${origin} asked to send a transaction — check the device`);
      await chrome.storage.session.set({ awaitingDevice: origin });
      try {
        return await ask<string>(command);
      } finally {
        await chrome.storage.session.set({ awaitingDevice: null });
      }
    }

    /* -------------------------------------------------------- read-only */

    default: {
      if (!READ_METHODS.has(method)) {
        throw new RpcError(
          EIP1193.unsupportedMethod,
          `LeekWallet does not implement ${method}`,
        );
      }
      const info = getChain(state.chainId);
      if (!info) {
        throw new RpcError(EIP1193.chainDisconnected, `chain ${state.chainId} has no endpoints`);
      }
      const rpc = new FailoverRpc({
        chainId: info.id,
        rpcUrls: info.rpcUrls,
        send: fetchRpcSend(),
        store: memoryStore(),
      });
      try {
        return await rpc.request({ method, params });
      } catch (e) {
        /* A node's own JSON-RPC error is the dapp's answer, not a wallet
         * fault: a reverted `eth_call` is how every read of a contract's error
         * path looks, and rewriting it as -32603 would make it unreadable. */
        if (e instanceof RpcResponseError) {
          throw new RpcError(e.code, e.message);
        }
        throw new RpcError(EIP1193.internal, String((e as Error).message ?? e));
      }
    }
  }
}

/** Hex bytes to a string, refusing anything that is not valid UTF-8. */
function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(
    (hex.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)),
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RpcError(
      EIP1193.invalidParams,
      "this message is not text the device can display, so it will not be signed",
    );
  }
}

/* ---------------------------------------------------------------- routing */

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  /* Three kinds of sender arrive here and they are told apart by shape rather
   * than by trusting anything in the payload. A content script's message is
   * the only one with a tab behind it, and the only one whose origin is not
   * this extension's own. */
  const msg = message as Record<string, unknown>;

  if (msg?.["from"] === "leek-owner-event") {
    const event = message as OwnerEvent;
    void (async () => {
      if (event.event === "log") await appendLog(String(event.data));
      if (event.event === "state") await chrome.storage.session.set({ snapshot: event.data });
    })();
    return undefined;
  }

  if (msg?.["channel"] === "leekwallet" && msg?.["dir"] === "req") {
    const req = message as PageRequest;
    /* THE origin check. `sender.origin` is asserted by the browser; anything a
     * page said about itself was discarded by the content script before this
     * point and is not present in the message at all. */
    const origin = sender.origin ?? (sender.url === undefined ? undefined : safeOrigin(sender.url));
    if (origin === undefined || sender.tab === undefined) {
      sendResponse({
        channel: "leekwallet", dir: "res", id: req.id,
        error: { code: EIP1193.unauthorized, message: "no verifiable origin for this request" },
      });
      return undefined;
    }
    handle(origin, req.method, Array.isArray(req.params) ? req.params : []).then(
      (result) => sendResponse({ channel: "leekwallet", dir: "res", id: req.id, result }),
      (e: unknown) => sendResponse({
        channel: "leekwallet", dir: "res", id: req.id,
        error: toProviderError(e),
      }),
    );
    return true;
  }

  if (typeof msg?.["pop"] === "string") {
    handlePopup(message as PopupCommand).then(
      (result) => sendResponse({ ok: result }),
      (e: unknown) => sendResponse({ err: String((e as Error)?.message ?? e) }),
    );
    return true;
  }

  return undefined;
});

/**
 * Turn anything thrown inside `handle` into an EIP-1193 error object.
 *
 * The device's 0x0200 becomes 4001. That single mapping is the most
 * user-visible line in this file: 4001 is what dapps read as "the user said
 * no", and every other code is read as "the wallet is broken". Someone who
 * deliberately rejected a transaction on their device should not then be told
 * by the website that something went wrong.
 */
function toProviderError(e: unknown): { code: number; message: string } {
  if (e instanceof RpcError) return { code: e.code, message: e.message };
  if (e instanceof OwnerError) {
    /* ErrorCode.UserRejected and ErrorCode.UserTimeout from core/transport.ts.
     * Not imported, because importing the enum for two constants pulls a
     * module into the worker for no other purpose. */
    if (e.deviceCode === 0x0200) {
      return { code: EIP1193.userRejected, message: "rejected on the device" };
    }
    if (e.deviceCode === 0x0201) {
      return { code: EIP1193.userRejected, message: "the device timed out waiting for approval" };
    }
    return { code: EIP1193.internal, message: e.message };
  }
  return { code: EIP1193.internal, message: String((e as Error)?.message ?? e) };
}

/* ------------------------------------------------------------- the popup */

async function handlePopup(command: PopupCommand): Promise<unknown> {
  switch (command.pop) {
    case "state":
      return await walletState();

    case "grantPort":
      /* Not implemented here. `requestPort()` must run where the user gesture
       * is, which is the popup document itself — see popup.ts. This case
       * exists so that the command type stays a complete description of the
       * popup's vocabulary, and so a future caller gets a clear refusal rather
       * than silence. */
      throw new Error("the port chooser has to be opened by the popup itself");

    case "connect": {
      const snap = await ask<OwnerSnapshot>({ cmd: "connect" });
      await chrome.storage.session.set({ snapshot: snap });
      return await walletState();
    }

    case "confirm": {
      const snap = await ask<OwnerSnapshot>({ cmd: "confirm" });
      await chrome.storage.session.set({ snapshot: snap });
      return await walletState();
    }

    case "unlock": {
      const snap = await ask<OwnerSnapshot>({ cmd: "unlock" });
      await chrome.storage.session.set({ snapshot: snap });
      return await walletState();
    }

    case "disconnect": {
      await ask({ cmd: "disconnect" });
      await chrome.storage.session.set({ snapshot: EMPTY_SNAPSHOT });
      /* Every connected origin is told the accounts are gone. A dapp left
       * holding an address after the device went away would go on offering to
       * sign with it. */
      const { grants } = await readState();
      await broadcast("accountsChanged", [], new Set(Object.keys(grants)));
      await appendLog("disconnected");
      return await walletState();
    }

    case "approve": {
      if (!pending || pending.id !== command.id) {
        throw new Error("that request is no longer waiting — the site may have given up");
      }
      pending.resolve(command.accounts);
      return await walletState();
    }

    case "reject": {
      if (!pending || pending.id !== command.id) return await walletState();
      pending.reject({ code: EIP1193.userRejected, message: "the user rejected the request" });
      return await walletState();
    }

    case "revoke": {
      const { grants } = await readState();
      if (grants[command.origin] === undefined) return await walletState();
      delete grants[command.origin];
      await writeState({ grants });
      await broadcast("accountsChanged", [], new Set([command.origin]));
      await appendLog(`revoked access for ${command.origin}`);
      return await walletState();
    }

    case "setOverride": {
      await writeState({ overrideWindowEthereum: command.value });
      await appendLog(
        command.value
          ? "window.ethereum override enabled — reload open tabs for it to take effect"
          : "window.ethereum override disabled",
      );
      return await walletState();
    }

    case "setChain": {
      if (!getChain(command.chainId)) throw new Error(`chain ${command.chainId} is not known`);
      const { grants } = await readState();
      await writeState({ chainId: command.chainId });
      await broadcast("chainChanged", hexChainId(command.chainId), new Set(Object.keys(grants)));
      await appendLog(`switched to chain ${command.chainId}`);
      return await walletState();
    }
  }
}

async function walletState(): Promise<WalletState> {
  const persisted = await readState();
  const snap = await ownerSnapshot(true);
  const session = await chrome.storage.session.get({
    log: [] as string[],
    awaitingDevice: null as string | null,
  });

  return {
    /* Both of these are placeholders the popup overwrites from its own
     * feature detection. A worker cannot see `navigator.serial` — the API is
     * exposed to documents only — so an answer computed here would be a
     * confident lie. See env.ts and popup.ts. */
    serialSupported: true,
    serialReason: "",
    portGranted: false,
    connected: snap.connected && snap.confirmed,
    passkey: snap.passkey,
    unlocked: snap.unlocked,
    addresses: snap.addresses,
    chainId: persisted.chainId,
    overrideWindowEthereum: persisted.overrideWindowEthereum,
    log: session["log"] as string[],
    grants: Object.entries(persisted.grants).map(([origin, g]) => ({
      origin,
      accounts: g.accounts,
    })),
    pending: pending === null
      ? null
      : { id: pending.id, origin: pending.origin, method: pending.method },
    awaitingDevice: session["awaitingDevice"] as string | null,
  };
}

/* --------------------------------------------------------------- lifecycle */

/**
 * A rejected approval when its window closes.
 *
 * Without this a user who closes the popup instead of clicking Reject leaves
 * the dapp's promise hanging for ever, and a connect button that spins
 * indefinitely is worse than one that says no.
 */
chrome.windows.onRemoved.addListener((windowId) => {
  /* Only OUR window. Rejecting on any close would kill a live request every
   * time the user shut an unrelated browser window, which is a refusal they
   * never made and a dapp error they cannot explain. */
  if (windowId !== approvalWindowId) return;
  approvalWindowId = null;
  if (pending) {
    pending.reject({ code: EIP1193.userRejected, message: "the user closed the window" });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void appendLog(`ready — ${allChains().length} chains in the registry`);
});

export {};
