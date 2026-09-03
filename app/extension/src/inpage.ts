/**
 * The EIP-1193 provider the page sees, announced over EIP-6963.
 *
 * WHY NOT `window.ethereum`
 *
 * `window.ethereum` is one slot and every wallet wants it. Whoever writes last
 * wins, which made "install two wallets" a coin toss and pushed extensions
 * into defining the property non-configurably so nobody could overwrite them —
 * a race whose prize is breaking the user's other wallet. EIP-6963 exists to
 * end that: the page fires `eip6963:requestProvider`, every wallet answers
 * with `eip6963:announceProvider`, and the USER picks in the dapp's own
 * connect dialog. So the default here is to announce and otherwise keep our
 * hands off the global. A wallet that breaks MetaMask by existing gets
 * uninstalled before anybody finds out whether it was any good.
 *
 * The opt-in override is kept because dapps that predate 6963 still exist and
 * a hardware wallet that cannot reach them is not much use. It is off by
 * default; it is a setting the user turns on knowing what it does; and even
 * then it defines the property as configurable and writable — taking the slot
 * without welding it shut, because the next extension deserves the same chance
 * to hand it back. It also cannot take the slot synchronously (see
 * `applyConfig` below), which is a second reason it is not the default.
 *
 * WHY A `MAIN` WORLD CONTENT SCRIPT rather than injecting a <script> tag: a
 * document_start MAIN-world script is guaranteed to run before page script,
 * which is what makes the announcement race winnable. Injecting a tag from the
 * isolated world is a frame later and, on a page with a strict `script-src`,
 * is simply blocked — the provider then silently never appears, which is the
 * worst possible failure for a wallet.
 *
 * This file talks to nothing but `window.postMessage`. It holds no keys, no
 * device handle, no session and no state a page could not compute itself. It
 * is a stub in front of a stub in front of the thing that owns the port.
 */

import type {
  PageConfig, PageEvent, PageRequest, PageResponse,
} from "./protocol.ts";

const CHANNEL = "leekwallet";

interface RequestArguments {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

/** The error shape EIP-1193 requires, including the `code` dapps switch on. */
class ProviderRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "ProviderRpcError";
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

const pending = new Map<string, Pending>();

/* These ids are not secrets. They exist to pair a reply with its request
 * inside this one frame, and a page that forges or reuses them can only
 * confuse itself — nothing on the extension side keys off them. */
const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type Listener = (...args: unknown[]) => void;

class LeekWalletProvider {
  readonly isLeekWallet = true;

  /**
   * No `isMetaMask`, and no `isCoinbaseWallet` either.
   *
   * Claiming another wallet's flag is how an extension gets through dapp
   * sniffing it was not meant to pass, and what follows is behaviour the dapp
   * never tested against a device that confirms on its own screen and can say
   * no. If a dapp supports only MetaMask, the honest outcome is that it does
   * not support this, and the user finds that out at the connect button rather
   * than three screens later.
   */

  private readonly listeners = new Map<string, Set<Listener>>();

  /** Cached only so the legacy accessors below can be synchronous. */
  private accounts: string[] = [];
  private chainIdHex: string | null = null;

  async request(args: RequestArguments): Promise<unknown> {
    if (!args || typeof args.method !== "string" || args.method === "") {
      throw new ProviderRpcError(-32602, "request() needs a method");
    }
    /* EIP-1193 allows params to be an array or an object. The wallet's methods
     * are all positional, so an object is wrapped rather than rejected — some
     * dapps send `{}` for a no-argument call and refusing that would break
     * them for no gain. */
    const params = Array.isArray(args.params)
      ? args.params
      : args.params === undefined
        ? []
        : [args.params];

    const id = newId();
    const message: PageRequest = {
      channel: CHANNEL, dir: "req", id, method: args.method, params,
    };

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      /* `"*"` because a sandboxed or `data:` frame has the opaque origin
       * "null", where posting to `location.origin` delivers nothing at all.
       * The message never leaves this window, and it carries only what the
       * page just handed us. */
      window.postMessage(message, "*");
    });
  }

  /* ------------------------------------------------------ legacy surface */

  /**
   * Kept, minimal, and mapped onto `request`.
   *
   * `enable()` and `sendAsync()` were removed from EIP-1193 years ago and are
   * still shipped by enough of the ecosystem — anything built on old web3.js,
   * anything that vendored a connector in 2021 — that omitting them means a
   * blank page rather than a graceful "unsupported". Supporting them costs
   * twenty lines and no security property: everything still goes through
   * `request`, and therefore through the same origin check.
   */
  async enable(): Promise<unknown> {
    return await this.request({ method: "eth_requestAccounts" });
  }

  send(methodOrPayload: unknown, paramsOrCallback?: unknown): unknown {
    if (typeof methodOrPayload === "string") {
      return this.request({
        method: methodOrPayload,
        ...(Array.isArray(paramsOrCallback) ? { params: paramsOrCallback } : {}),
      });
    }
    return this.sendAsync(
      methodOrPayload,
      paramsOrCallback as ((err: unknown, res?: unknown) => void) | undefined,
    );
  }

  sendAsync(payload: unknown, callback?: (err: unknown, res?: unknown) => void): void {
    const p = payload as { id?: unknown; method?: string; params?: unknown[] };
    this.request({ method: p?.method ?? "", ...(p?.params ? { params: p.params } : {}) }).then(
      (result) => callback?.(null, { id: p?.id, jsonrpc: "2.0", result }),
      (error) => callback?.(error),
    );
  }

  /**
   * The legacy synchronous properties.
   *
   * They report the last value this provider was told about and `null` before
   * it has been told anything. Deliberately not derived by asking the wallet —
   * these are getters, they cannot await, and a wallet that guessed here would
   * be guessing about which chain a transaction is for.
   */
  get selectedAddress(): string | null {
    return this.accounts[0] ?? null;
  }

  get chainId(): string | null {
    return this.chainIdHex;
  }

  /**
   * Whether the provider believes it can serve requests.
   *
   * `true` unconditionally, and that is not a lie by omission: EIP-1193
   * defines this as "connected to a chain", the extension can always reach a
   * chain's public endpoints for reads, and whether the DEVICE is plugged in
   * is answered by a 4900 on the first request that needs it. Returning false
   * here would make dapps hide their connect button, which is the one control
   * that leads a user to plugging the device in.
   */
  isConnected(): boolean {
    return true;
  }

  /* -------------------------------------------------------------- events */

  on(event: string, handler: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(handler);
    return this;
  }

  once(event: string, handler: Listener): this {
    const wrapper: Listener = (...args) => {
      this.removeListener(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  addListener(event: string, handler: Listener): this {
    return this.on(event, handler);
  }

  removeListener(event: string, handler: Listener): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  off(event: string, handler: Listener): this {
    return this.removeListener(event, handler);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  /** Internal: fan an extension-side event out to the page's handlers. */
  deliver(event: string, data: unknown): void {
    if (event === "accountsChanged" && Array.isArray(data)) {
      this.accounts = data as string[];
    }
    if (event === "chainChanged" && typeof data === "string") {
      this.chainIdHex = data;
    }
    /* A snapshot of the set, because a handler that calls `removeListener` —
     * which `once` does on every fire — would otherwise mutate the collection
     * being iterated. */
    for (const h of [...(this.listeners.get(event) ?? [])]) {
      try {
        h(data);
      } catch {
        /* A dapp's throwing handler is its own problem and must not become the
         * next handler's. */
      }
    }
  }
}

const provider = new LeekWalletProvider();

/* ------------------------------------------------------------- transport */

window.addEventListener("message", (ev: MessageEvent) => {
  /* Same-window only. A message from an iframe or an opener is not a reply
   * from our content script, whatever it says its channel is. */
  if (ev.source !== window) return;
  const data = ev.data as PageResponse | PageEvent | PageConfig | undefined;
  if (!data || data.channel !== CHANNEL) return;

  if (data.dir === "res") {
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.error) {
      waiter.reject(new ProviderRpcError(data.error.code, data.error.message));
    } else {
      waiter.resolve(data.result);
    }
    return;
  }

  if (data.dir === "event") {
    provider.deliver(data.event, data.data);
    return;
  }

  if (data.dir === "config") applyConfig(data);
});

/* ------------------------------------------------------------- EIP-6963 */

/**
 * The icon is inlined as a data URI because 6963 requires one and a
 * `chrome-extension://` URL would leak the extension id to every page ever
 * visited — the fingerprint that tells a site which wallets are installed
 * whether or not the user ever connects. A data URI says nothing.
 */
const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="2" fill="#0F1210"/>' +
      '<path d="M16 26c0-7 3-11 9-12-1 8-4 12-9 12z" fill="#7ABF6A"/>' +
      '<path d="M16 26C9 26 6 21 6 13c7 1 10 6 10 13z" fill="#3F6E31"/>' +
      '<rect x="15" y="6" width="2" height="20" fill="#7ABF6A"/>' +
      "</svg>",
  );

const info = Object.freeze({
  /* A stable UUID, generated once and written here rather than at load time.
   * 6963 says the uuid identifies this provider, and dapps that remember which
   * wallet the user picked remember it by this — regenerating per page load
   * would forget the choice on every navigation. */
  uuid: "b1f7c0e2-4c2a-4e2b-9b3e-6a1d5f0c7a41",
  name: "LeekWallet",
  rdns: "org.leekwallet.extension",
  icon: ICON,
});

function announce(): void {
  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    }),
  );
}

/* Both halves are required and neither is redundant. The listener answers
 * dapps that ask after we loaded; the immediate call answers dapps that asked
 * before we did, which at document_start should be none but is not worth
 * betting a blank connect dialog on. */
window.addEventListener("eip6963:requestProvider", announce);
announce();

/* -------------------------------------------- optional legacy global */

/**
 * Take `window.ethereum`, if the user asked for that.
 *
 * The config arrives asynchronously, because the MAIN world has no
 * `chrome.storage` to read synchronously and there is no way to hand a
 * document_start script a value before it runs. In practice this lands within
 * a millisecond or two, well before a dapp's bundle has executed. In principle
 * a page that reads `window.ethereum` in its very first inline script beats
 * it. That is the honest reason this is a checkbox and not the default, and
 * the popup says as much next to it.
 *
 * The property is defined writable AND configurable. Wallets that lock the
 * slot down are the reason 6963 had to be written; joining in would be
 * choosing the behaviour this file's header criticises.
 */
function applyConfig(config: PageConfig): void {
  if (!config.overrideWindowEthereum) return;

  const w = window as unknown as Record<string, unknown>;
  const existing = w["ethereum"];
  if (existing === provider) return;

  try {
    Object.defineProperty(window, "ethereum", {
      value: provider,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    /* Another extension defined it non-configurably. Nothing to do, and
     * nothing to report to the page — the 6963 announcement above still
     * stands, and that was always the path that was going to work. */
    return;
  }

  /* Keep whoever was there reachable. Several dapps look for a `providers`
   * array, and losing the user's other wallet entirely is not a trade they
   * agreed to when they ticked one checkbox. */
  if (existing && existing !== provider) {
    (provider as unknown as Record<string, unknown>)["providers"] = [provider, existing];
  }
}
