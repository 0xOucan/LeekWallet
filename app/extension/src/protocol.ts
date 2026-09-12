/**
 * The message vocabulary spoken across the extension's four processes.
 *
 * There are four of them because MV3 gives no single place that can both see a
 * web page and hold a serial port open, and pretending otherwise is how this
 * design would have gone wrong:
 *
 *   page (MAIN world)  --window.postMessage-->  content script (ISOLATED)
 *   content script     --chrome.runtime------->  service worker
 *   service worker     --chrome.runtime------->  port owner (offscreen doc)
 *
 * Every hop is a trust boundary and the direction of trust only ever narrows.
 * The page names no origin in its messages, and if it did the content script
 * would throw the claim away: `sender.origin` from `chrome.runtime` is the only
 * origin the service worker will believe, because it is the one the browser
 * asserts rather than the one a script asked for. A dapp that says it is
 * app.uniswap.org must not be able to reuse app.uniswap.org's approvals.
 *
 * Request ids are per-hop-independent. The page's id is echoed back by the
 * content script and is never used as a key anywhere else, so a page that
 * reuses or forges ids can only confuse itself.
 *
 * None of these messages ever carries a private key, a seed, a session key or
 * a passkey. The passkey the popup displays is derived in the offscreen
 * document and travels to the popup only as six digits the human compares
 * against the device's own screen; it authenticates the channel, it does not
 * unlock anything.
 */

/* ------------------------------------------------------- page <-> content */

/** What a page asks for. Params are whatever JSON-RPC shape the dapp sent. */
export interface PageRequest {
  channel: "leekwallet";
  dir: "req";
  id: string;
  method: string;
  params: unknown[];
}

export interface PageResponse {
  channel: "leekwallet";
  dir: "res";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Unsolicited pushes to the page: accountsChanged, chainChanged, connect. */
export interface PageEvent {
  channel: "leekwallet";
  dir: "event";
  event: string;
  data: unknown;
  /**
   * Which origins this event is for, on the extension-internal hop only.
   *
   * `chrome.tabs.sendMessage` addresses a TAB, and a tab contains frames from
   * origins that have nothing to do with the top-level document — an embedded
   * widget, an ad, an iframe a dapp does not control. Filtering by the tab's
   * URL alone would hand `accountsChanged` to every one of them, telling an
   * origin the user never connected to which address they are using.
   *
   * So the intended origins travel with the event and each content script
   * checks the list against its OWN `location.origin` before relaying. The
   * field is deleted on the way to the page: a dapp has no business seeing
   * which other sites are connected.
   */
  origins?: string[];
}

/**
 * Settings the injected script cannot read for itself.
 *
 * The MAIN world has no `chrome.*`, so anything the provider needs from
 * extension storage has to be handed to it. It arrives asynchronously — see
 * the race note in inpage.ts, which is the honest reason EIP-6963 is the
 * supported path and `window.ethereum` is not.
 */
export interface PageConfig {
  channel: "leekwallet";
  dir: "config";
  overrideWindowEthereum: boolean;
}

/* ------------------------------------------------- worker <-> port owner */

/**
 * Commands the port owner understands.
 *
 * Deliberately device-shaped rather than dapp-shaped. The port owner knows
 * about frames, sessions and BIP44 paths; it knows nothing about origins or
 * permissions. Keeping the dapp's vocabulary out of it means an EIP-1193 bug
 * cannot become a signing bug.
 */
export type OwnerCommand =
  | { cmd: "status" }
  /** Open the port the popup already obtained permission for, and handshake. */
  | { cmd: "connect" }
  /** The human has compared the passkey against the device screen. */
  | { cmd: "confirm" }
  | { cmd: "unlock" }
  | { cmd: "derive"; count: number }
  | { cmd: "disconnect" }
  | { cmd: "signMessage"; index: number; message: string }
  | { cmd: "signTypedData"; index: number; doc: unknown }
  | {
      cmd: "signTransaction";
      index: number;
      chainId: number;
      tx: {
        to: string;
        value?: string;
        data?: string;
        nonce?: number;
        gas?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
      };
      /** Sign only, or sign then broadcast through the chain's public RPC. */
      broadcast: boolean;
    };

export interface OwnerEnvelope {
  to: "leek-owner";
  id: string;
  command: OwnerCommand;
}

export interface OwnerReply {
  from: "leek-owner";
  id: string;
  ok?: unknown;
  err?: string;
  /**
   * The device's own error code, when the failure came from the device.
   *
   * Carried separately rather than folded into `err`, because 0x0200 —
   * "the user pressed reject" — has to reach the dapp as EIP-1193's 4001 and
   * not as a generic internal error. A refusal that a dapp renders as a crash
   * teaches people that refusing is broken.
   */
  errCode?: number;
}

/** Pushed by the port owner when the device's own state moves under us. */
export interface OwnerEvent {
  from: "leek-owner-event";
  event: "state" | "log";
  data: unknown;
}

/* --------------------------------------------------- popup <-> worker */

/**
 * Everything the popup renders, assembled by the service worker.
 *
 * A single snapshot rather than a set of getters: the popup is destroyed and
 * rebuilt every time it opens, so there is no incremental state for it to keep
 * up to date, and a half-applied set of individual reads is a popup that shows
 * "connected" beside "no device".
 */
export interface WalletState {
  /** Whether this browser can talk to hardware at all. */
  serialSupported: boolean;
  /** Why not, when it cannot. Shown verbatim — see env.ts. */
  serialReason: string;
  /** A port has been granted by the user and remembered by Chrome. */
  portGranted: boolean;
  connected: boolean;
  /** Set between handshake and confirmation — compare it against the device. */
  passkey: string | null;
  unlocked: boolean;
  addresses: string[];
  chainId: number;
  /** Whether the user opted in to also taking over `window.ethereum`. */
  overrideWindowEthereum: boolean;
  /** Newest first, capped. Shown in the popup's activity strip. */
  log: string[];
  /** Origins that have been granted account access, and to which accounts. */
  grants: { origin: string; accounts: string[] }[];
  /** A dapp waiting on the human, if any. */
  pending: PendingApproval | null;
  /** Set while the device is drawing a confirmation screen of its own. */
  awaitingDevice: string | null;
}

/**
 * A dapp request waiting on the human, here.
 *
 * Only `eth_requestAccounts` ever produces one. Everything that moves value or
 * produces a signature is approved on the device's own screen, from the
 * device's own decode of the bytes — putting a second approval dialog in the
 * browser would train people to read the one that a compromised host can draw
 * whatever it likes into. So this type stays deliberately thin, and there is
 * no queue: a second request arriving while one is on screen is rejected
 * rather than stacked, because a stack of approval dialogs is the shape of UI
 * where somebody clicks through the one they meant to read.
 */
export interface PendingApproval {
  id: string;
  origin: string;
  method: "eth_requestAccounts";
}

export type PopupCommand =
  | { pop: "state" }
  /** Must be called from the popup: `requestPort` needs a user gesture. */
  | { pop: "grantPort" }
  | { pop: "connect" }
  | { pop: "confirm" }
  | { pop: "unlock" }
  | { pop: "disconnect" }
  | { pop: "approve"; id: string; accounts: string[] }
  | { pop: "reject"; id: string }
  | { pop: "revoke"; origin: string }
  /* Re-pick which addresses a site already connected to may see. Separate from
   * `approve`, which answers a request the site is waiting on; this one is
   * unprompted, so the site learns through accountsChanged like any wallet. */
  | { pop: "setAccounts"; origin: string; accounts: string[] }
  | { pop: "setOverride"; value: boolean }
  | { pop: "setChain"; chainId: number };

/**
 * EIP-1193 / EIP-1474 error codes.
 *
 * Spelled out rather than imported so that a dapp always gets the code the
 * spec says it gets: `4001` in particular is the one every wallet-connect
 * button in the ecosystem special-cases to mean "the user said no, don't show
 * a red toast", and returning anything else there is a worse user experience
 * than the refusal itself.
 */
export const EIP1193 = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  /** wallet_switchEthereumChain: the chain is not one we know how to reach. */
  unrecognizedChain: 4902,
  internal: -32603,
  invalidParams: -32602,
} as const;
