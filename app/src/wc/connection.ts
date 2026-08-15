/**
 * The WalletConnect v2 relay connection (T32).
 *
 * A thin wrapper over `@walletconnect/sign-client`. Thin on purpose: the SDK
 * owns the relay socket, the double-ratchet-ish envelope encryption and the
 * pairing state store, and reimplementing any of that would be a security
 * liability with no upside. What this file adds is the parts the SDK correctly
 * refuses to decide — which chains and methods this wallet is willing to
 * approve, and what happens to a request once it arrives.
 *
 * Two things to know about the relay, both stated in the UI as well:
 *
 * - **It is a third party.** It sees that a wallet and a dapp are talking, and
 *   the size and timing of what they say. Payloads are encrypted end to end
 *   with the key from the `wc:` URI, so it does not see transactions, and it
 *   never sees a private key — those never leave the device at all.
 * - **It is a network dependency.** The relay origin is in the CSP allowlist by
 *   exact name (see src-tauri/tauri.conf.json). No wildcard: a wildcard there
 *   would let any compromised dependency exfiltrate to any host it liked.
 *
 * The SDK is loaded with a dynamic import so that a build without it — or one
 * where the chunk fails to load — degrades to an app that still signs its own
 * transactions, rather than a white screen.
 */

import { CHAINS, getChain } from "../../packages/core/src/chains.ts";
import { SUPPORTED_EVENTS, SUPPORTED_METHODS } from "./requests.ts";
import type { JsonRpcErrorBody } from "./errors.ts";
import { parseWcUri, isExpired, redactWcUri } from "./uri.ts";

type SignClientInstance = InstanceType<
  typeof import("@walletconnect/sign-client").SignClient
>;

/**
 * The default WalletConnect relay.
 *
 * Named here and in the CSP, in both places, deliberately. Whoever changes one
 * has to find the other, which is the point of an exact-origin allowlist.
 */
export const RELAY_URL = "wss://relay.walletconnect.org";

/**
 * What dapps see about this wallet. `url` must be a real https URL or some
 * dapps refuse the session; it identifies the wallet, not the user.
 */
const METADATA = {
  name: "LeekWallet",
  description: "LeekWallet hardware wallet companion. Every request is confirmed on the device.",
  url: "https://github.com/leekwallet",
  icons: [] as string[],
};

/** A live session, flattened to what the session list needs to draw. */
export interface WcSession {
  topic: string;
  name: string;
  /** The dapp's own origin. Shown because it is the one identity worth reading. */
  url: string;
  /** Unix seconds. */
  expiry: number;
  /** CAIP-2 ids, e.g. `eip155:1`. */
  chains: string[];
  methods: string[];
}

/** A proposal awaiting the user. Held rather than auto-approved. */
export interface WcProposal {
  id: number;
  name: string;
  url: string;
  /** Chain ids the dapp requires and this wallet knows. */
  chains: number[];
  /** Required things this wallet cannot serve. Non-empty means a warning. */
  unsupportedMethods: string[];
  unsupportedChains: number[];
  methods: string[];
}

export interface WcRequest {
  id: number;
  topic: string;
  method: string;
  params: unknown;
  chainId: number;
  /** Dapp name, for the card. Untrusted text — render as a name, never as fact. */
  name: string;
}

export interface WcHandlers {
  onProposal(proposal: WcProposal): void;
  onRequest(request: WcRequest): void;
  onSessionsChanged(sessions: WcSession[]): void;
  log(line: string): void;
}

interface ProposalRecord {
  id: number;
  /** Namespaces to approve with, computed when the proposal arrived. */
  namespaces: Record<string, {
    chains: string[];
    accounts: string[];
    methods: string[];
    events: string[];
  }>;
  hasApprovableChain: boolean;
}

/** Every chain id in the registry, as CAIP-2. */
const knownCaip2 = (): string[] => CHAINS.map((c) => `eip155:${c.id}`);

/** Chains named either by a `chains` array or by the namespace key itself. */
function namespaceChains(key: string, ns: { chains?: string[] }): string[] {
  if (ns.chains && ns.chains.length > 0) return ns.chains;
  return key.includes(":") ? [key] : [];
}

/** The slice of the SDK's relayer this app watches; it is not in the public types. */
interface RelayerEvents {
  on(event: string, listener: (arg: unknown) => void): unknown;
  connected?: boolean;
}

export class WalletConnectConnection {
  private client: SignClientInstance | null = null;
  private readonly handlers: WcHandlers;
  private readonly proposals = new Map<number, ProposalRecord>();
  /** Addresses this wallet offers. Empty until the device is unlocked. */
  private accounts: string[] = [];

  constructor(handlers: WcHandlers) {
    this.handlers = handlers;
  }

  get ready(): boolean {
    return this.client !== null;
  }

  /**
   * Start the relay client.
   *
   * Safe to call twice; the second call is a no-op. Throws with a readable
   * message rather than the SDK's, because "Error: Missing or invalid" tells
   * a user nothing about what to do next.
   */
  async start(projectId: string, accounts: readonly string[]): Promise<void> {
    this.accounts = [...accounts];
    if (this.client) return;

    let SignClient: typeof import("@walletconnect/sign-client").SignClient;
    try {
      ({ SignClient } = await import("@walletconnect/sign-client"));
    } catch (e) {
      throw new Error(
        `WalletConnect support is not present in this build (${(e as Error).message}).`,
      );
    }

    this.client = await SignClient.init({
      projectId,
      relayUrl: RELAY_URL,
      metadata: METADATA,
    });

    this.wire(this.client);
    this.handlers.onSessionsChanged(this.sessions());
  }

  /** Update the offered accounts. Existing sessions keep what they were given. */
  setAccounts(accounts: readonly string[]): void {
    this.accounts = [...accounts];
  }

  private wire(client: SignClientInstance): void {
    /* The relay socket is the one thing in this app that reaches the network
     * from inside the webview -- every other call is proxied through Rust. That
     * makes it the only path whose health says nothing about the others', and
     * on Android it had never been observed at all: a pairing that subscribes
     * and hears nothing looks identical whether the socket is up or was never
     * opened, because `pair()` queues subscriptions and resolves either way.
     *
     * These four lines are the difference between "it does not work" and
     * knowing which half is broken. They carry no payload -- only the fact that
     * a transition happened -- so they are safe to leave on in a release. */
    const relayer = (client.core as { relayer?: RelayerEvents }).relayer;
    if (relayer && typeof relayer.on === "function") {
      relayer.on("relayer_connect", () => this.handlers.log("relay: connected"));
      relayer.on("relayer_disconnect", () => this.handlers.log("relay: disconnected"));
      relayer.on("relayer_error", (e: unknown) =>
        this.handlers.log(`relay: error — ${(e as Error)?.message ?? String(e)}`),
      );
    } else {
      this.handlers.log("relay: this SDK exposes no relayer events to watch");
    }

    client.on("session_proposal", (event) => {
      this.clearProposalWatchdog();
      try {
        this.handleProposal(event);
      } catch (e) {
        this.handlers.log(`walletconnect: could not read that proposal — ${(e as Error).message}`);
      }
    });

    client.on("session_request", (event) => {
      const chainId = Number(event.params.chainId.split(":")[1] ?? 0);
      /* `get` throws for a topic the store does not know rather than returning
       * undefined, and a request whose session vanished mid-flight must still
       * reach the user rather than taking the handler down. */
      let name = "a dapp";
      try {
        name = client.session.get(event.topic).peer.metadata.name || name;
      } catch { /* keep the placeholder */ }

      this.handlers.onRequest({
        id: event.id,
        topic: event.topic,
        method: event.params.request.method,
        params: event.params.request.params,
        chainId,
        name,
      });
    });

    /* Both ends can end a session, and a dapp doing so while the user is
     * looking at the list is exactly when a stale entry misleads. */
    client.on("session_delete", () => this.handlers.onSessionsChanged(this.sessions()));
    client.on("session_expire", () => this.handlers.onSessionsChanged(this.sessions()));
  }

  private handleProposal(event: {
    id: number;
    params: {
      proposer: { metadata: { name?: string; url?: string } };
      requiredNamespaces: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
      optionalNamespaces?: Record<string, { chains?: string[]; methods: string[]; events: string[] }>;
    };
  }): void {
    const { requiredNamespaces, optionalNamespaces = {} } = event.params;

    const wantedChains = new Set<string>();
    const wantedMethods = new Set<string>();
    const requiredChains = new Set<string>();
    const requiredMethods = new Set<string>();

    for (const [key, ns] of Object.entries(requiredNamespaces)) {
      if (!key.startsWith("eip155")) continue;
      for (const c of namespaceChains(key, ns)) { wantedChains.add(c); requiredChains.add(c); }
      for (const m of ns.methods) { wantedMethods.add(m); requiredMethods.add(m); }
    }
    for (const [key, ns] of Object.entries(optionalNamespaces)) {
      if (!key.startsWith("eip155")) continue;
      for (const c of namespaceChains(key, ns)) wantedChains.add(c);
      for (const m of ns.methods) wantedMethods.add(m);
    }

    /* If a dapp asks for nothing in particular, offer everything the registry
     * knows — that is the AppKit default and refusing it would break most
     * modern dapps for no gain. */
    const known = new Set(knownCaip2());
    const approvedChains = [...wantedChains].filter((c) => known.has(c));
    const chains = approvedChains.length > 0 ? approvedChains : knownCaip2();

    const approvedMethods = [...wantedMethods].filter((m) => SUPPORTED_METHODS.includes(m));
    const methods = approvedMethods.length > 0 ? approvedMethods : [...SUPPORTED_METHODS];

    /* Accounts are the cross product: every address on every approved chain.
     * The same key controls the same address on all of them, which is exactly
     * why the device insists on displaying the chain (PROTOCOL.md 6d). */
    const accounts = chains.flatMap((c) => this.accounts.map((a) => `${c}:${a}`));

    this.proposals.set(event.id, {
      id: event.id,
      namespaces: { eip155: { chains, accounts, methods, events: [...SUPPORTED_EVENTS] } },
      hasApprovableChain: chains.length > 0 && this.accounts.length > 0,
    });

    this.handlers.onProposal({
      id: event.id,
      name: event.params.proposer.metadata.name ?? "a dapp",
      url: event.params.proposer.metadata.url ?? "",
      chains: chains.map((c) => Number(c.split(":")[1] ?? 0)),
      /* Named rather than silently dropped. A dapp that *requires* typed data
       * will fail later, and the user deserves to know that before pairing
       * rather than at the first signature. */
      unsupportedMethods: [...requiredMethods].filter((m) => !SUPPORTED_METHODS.includes(m)),
      unsupportedChains: [...requiredChains]
        .filter((c) => !known.has(c))
        .map((c) => Number(c.split(":")[1] ?? 0)),
      methods,
    });
  }

  /**
   * How long a pairing may sit with no proposal before the app says so.
   *
   * A pairing that subscribes successfully and then hears nothing is the one
   * failure this app cannot detect from the inside: a `wc:` code is single-use,
   * so if another wallet already paired with the same QR, the dapp has sent its
   * one proposal and settled, and our subscribe is listening to a finished
   * conversation. The relay reports no error for that -- there is nothing
   * wrong with the subscription. Silence is the only symptom.
   *
   * Twenty seconds is well past a healthy dapp, which proposes within about a
   * second of the pairing appearing, and short enough that the user has not yet
   * concluded the app is broken. It is a message, never a teardown: a slow dapp
   * that answers at second thirty still connects normally.
   */
  private static readonly PROPOSAL_TIMEOUT_MS = 20_000;

  private proposalWatchdog: ReturnType<typeof setTimeout> | null = null;

  /** Stop waiting out loud. Safe to call when no wait is in flight. */
  private clearProposalWatchdog(): void {
    if (this.proposalWatchdog === null) return;
    clearTimeout(this.proposalWatchdog);
    this.proposalWatchdog = null;
  }

  /** Feed a pasted or scanned URI to the relay. Rejects with a user-readable reason. */
  async pair(rawUri: string): Promise<void> {
    if (!this.client) throw new Error("WalletConnect is not connected to the relay yet.");
    const parsed = parseWcUri(rawUri);
    if (!parsed.ok) throw new Error(parsed.reason);
    if (isExpired(parsed.uri)) {
      throw new Error("That pairing link has expired. Ask the dapp for a new QR code.");
    }
    // The redacted form only: the symKey decrypts the session proposal.
    this.handlers.log(`pairing with ${redactWcUri(parsed.uri)}`);
    await this.client.pair({ uri: rawUri.trim() });

    const relayer = (this.client.core as { relayer?: { connected?: boolean } }).relayer;
    this.handlers.log(
      `relay socket at pairing: ${relayer?.connected === true ? "connected" : "NOT connected"}`,
    );

    /* Only one wait is ever outstanding: pairing again replaces the previous
     * one, so a second attempt cannot fire a stale warning about the first. */
    this.clearProposalWatchdog();
    this.proposalWatchdog = setTimeout(() => {
      this.proposalWatchdog = null;
      this.handlers.log(
        "walletconnect: paired, but the dapp has not sent a connection request. " +
          "A QR code works only once — if another wallet already scanned this one, " +
          "or the dapp page was reloaded, press its Connect button for a fresh code.",
      );
    }, WalletConnectConnection.PROPOSAL_TIMEOUT_MS);
  }

  async approveProposal(id: number): Promise<void> {
    const client = this.client;
    const record = this.proposals.get(id);
    if (!client || !record) throw new Error("That connection request is no longer pending.");
    if (!record.hasApprovableChain) {
      throw new Error("Unlock the device first — there are no addresses to offer.");
    }
    this.proposals.delete(id);
    const { acknowledged } = await client.approve({ id, namespaces: record.namespaces });
    await acknowledged();
    this.handlers.onSessionsChanged(this.sessions());
  }

  async rejectProposal(id: number, reason: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.proposals.delete(id);
    // 5000 is the WalletConnect SDK's USER_REJECTED; dapps display it as such.
    await client.reject({ id, reason: { code: 5000, message: reason } });
  }

  /** Answer a request. One of `result` or `error`, never neither. */
  async respond(topic: string, id: number, result: unknown): Promise<void> {
    if (!this.client) return;
    await this.client.respond({
      topic,
      response: { id, jsonrpc: "2.0", result: result as never },
    });
  }

  async respondError(topic: string, id: number, error: JsonRpcErrorBody): Promise<void> {
    if (!this.client) return;
    await this.client.respond({ topic, response: { id, jsonrpc: "2.0", error } });
  }

  sessions(): WcSession[] {
    if (!this.client) return [];
    return this.client.session.getAll().map((s) => ({
      topic: s.topic,
      name: s.peer.metadata.name || "(unnamed dapp)",
      url: s.peer.metadata.url || "",
      expiry: s.expiry,
      chains: s.namespaces["eip155"]?.chains ?? [],
      methods: s.namespaces["eip155"]?.methods ?? [],
    }));
  }

  async disconnect(topic: string): Promise<void> {
    if (!this.client) return;
    // 6000 is USER_DISCONNECTED; the dapp shows "wallet disconnected".
    await this.client.disconnect({
      topic,
      reason: { code: 6000, message: "Disconnected by the user." },
    });
    this.handlers.onSessionsChanged(this.sessions());
  }

  /**
   * Tell every session the chain changed.
   *
   * Required by EIP-1193 semantics: a dapp that is not told keeps signing
   * against the old chain in its own UI while this wallet has moved.
   */
  async emitChainChanged(chainId: number): Promise<void> {
    if (!this.client) return;
    if (!getChain(chainId)) return;
    for (const session of this.client.session.getAll()) {
      const caip2 = `eip155:${chainId}`;
      if (!(session.namespaces["eip155"]?.chains ?? []).includes(caip2)) continue;
      try {
        await this.client.emit({
          topic: session.topic,
          chainId: caip2,
          event: { name: "chainChanged", data: chainId },
        });
      } catch (e) {
        this.handlers.log(`walletconnect: could not notify ${session.peer.metadata.name}: ${(e as Error).message}`);
      }
    }
  }
}
