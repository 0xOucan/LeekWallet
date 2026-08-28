/**
 * LeekWallet companion — shell.
 *
 * Talks to a Transport, nothing else. The mock is wired in here today; the
 * serial and BLE transports arrive as Rust behind a Tauri command and drop into
 * the same slot. No device logic lives in this file, which is what keeps the
 * shell replaceable.
 */

import { encodeCbor, decodeCbor, type CborValue } from "../packages/core/src/cbor.ts";
import { encodeFrame, FrameDecoder, FrameType } from "../packages/core/src/framing.ts";
import { MockDevice } from "../packages/core/src/mock-device.ts";
import { DeviceError, ErrorCode, type Transport } from "../packages/core/src/transport.ts";
import {
  derivationsInvalidated, UNKNOWN_STATUS, type DeviceStatus,
} from "../packages/core/src/device-state.ts";
import {
  availableTransports, listPorts, TauriSerialTransport, type HardwareKind,
} from "./tauri-transport.ts";
import { BleTransport, scanBle, BLE_NOT_FOUND } from "./ble-transport.ts";
import { createPublicClient, custom, defineChain, parseEther, serializeTransaction,
         isAddress, type Chain, type Hex, type Address } from "viem";
import {
  addCustomChain, allChains, CHAINS, chainLabelDetailed, CUSTOM_CHAIN_NOTICE, formatUnits,
  getChain, loadCustomChains, removeCustomChain, resolveChain, type ChainInfo,
  type CustomChainInput, type TokenHint,
} from "../packages/core/src/chains.ts";
import {
  balanceProvenance, BALANCE_SOURCE_NOTICE, describeTokenAmount, encodeErc20Transfer,
  fetchNativeBalance, fetchTokenBalance, fetchTokenMeta, freshnessOf, parseUnits,
  maxSendableNative, maxSendableToken, MAX_SENDABLE_NOTICE,
  TOKEN_SCALE_NOTICE, type BalanceSnapshot, type EthRequest, type TokenAmountView,
  type TokenMeta,
} from "../packages/core/src/balances.ts";
import qrcodegen from "qrcode-generator";
import { parsePaymentUri } from "../packages/core/src/payment-uri.ts";
import { fetchTokenBalancesBatched } from "../packages/core/src/multicall.ts";
import {
  buildTokenIndex, parseTokenList, refreshTokenList, TOKEN_LIST_NOTICE, TOKEN_LIST_URLS,
  type TokenIndex,
} from "../packages/core/src/token-list.ts";
import { BUNDLED_TOKENS } from "../packages/core/src/token-list-bundled.ts";
import { fetchAllowances } from "../packages/core/src/allowances.ts";
import { qrScanningAvailable, qrUnavailable, scanQr, type QrScan } from "./wc/qr.ts";
import {
  endpointOrder, FailoverRpc, fetchRpcSend, preferredRpc, rememberRpc,
  type RpcSend,
} from "../packages/core/src/rpc.ts";
import { resolveRpcSend } from "./rpc-proxy.ts";
import {
  deriveSession, generateKeypair, generateNonce, verifyCommitment,
  NONCE_BYTES, COMMIT_BYTES, PROTOCOL_VERSION, Session,
} from "../packages/core/src/session.ts";
import {
  checksumAddress, interpretTransaction, type TxInterpretation,
} from "../packages/core/src/tx-interpret.ts";
import { evaluateRules, type Finding, type RuleContext } from "../packages/core/src/rules.ts";
import { simulateTransaction, SIMULATION_NOTICE } from "../packages/core/src/simulate.ts";
import { chunk, renderInterpretation } from "./interpretation-view.ts";
import { initWalletConnect, type WalletBridge } from "./wc/ui.ts";
import { resolveProjectId } from "./wc/project-id.ts";
import type { PlannedTx } from "./wc/requests.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const log = (line: string): void => {
  const el = $("log");
  const stamp = new Date().toLocaleTimeString();
  el.textContent = `${stamp}  ${line}\n${el.textContent === "Nothing yet." ? "" : el.textContent}`;
};

/**
 * Say something out loud, once, to whoever is listening with a screen reader.
 *
 * The region is `role="alert"`, so this interrupts — which is the point, and
 * why the only callers are the moments the hardware is waiting for a person.
 * Everything else belongs in the log, where it can be read at leisure.
 *
 * The cleared-then-set pair is not superstition: assistive technology
 * announces a live region when its contents *change*, and two identical
 * messages in a row — "check every page on the device" for a second
 * transaction, say — are not a change. Clearing first makes the second one
 * arrive, and a repeated instruction that never arrives is precisely the
 * failure mode that matters here.
 */
function announce(text: string): void {
  const region = $("announce");
  region.textContent = "";
  // A microtask is too early: the change has to survive a paint to be noticed.
  setTimeout(() => { region.textContent = text; }, 50);
}

/**
 * The device is waiting for the user. Log it and announce it, same words.
 *
 * Confirming on the device is the security step this whole protocol is built
 * around — comparing a passkey, reading every page of a transaction — and it
 * only works if the user knows they have been asked. A sighted user reads the
 * log; a screen-reader user is given no reason to be in it at that moment, so
 * without this the instruction reaches nobody and the device becomes a button
 * that gets pressed to make the wallet work. That is not an inconvenience, it
 * is the attack the confirmation exists to stop.
 */
const deviceAttention = (line: string): void => { log(line); announce(line); };

/* Errors nobody caught, and resources the CSP refused.
 *
 * The WalletConnect SDK wraps proposal handling in a try/catch that reports
 * through its own logger and then auto-rejects, so a throw in there is invisible
 * here: the dapp is turned away and the app just keeps saying it is waiting.
 * These three listeners are the only way an exception on a phone -- where there
 * is no console to open -- reaches a human.
 *
 * The CSP listener earns its place separately: this app's policy is a security
 * boundary worth keeping tight, which means a legitimate request can be refused
 * by it, and a refusal is otherwise silent. Naming the blocked URI and the
 * directive turns "nothing happened" into a one-line answer.
 */
window.addEventListener("error", (e) => {
  log(`uncaught error: ${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as { message?: string } | undefined;
  log(`unhandled rejection: ${r?.message ?? String(e.reason)}`);
});
document.addEventListener("securitypolicyviolation", (e) => {
  log(`CSP blocked ${e.blockedURI || "(inline)"} — violates ${e.violatedDirective}`);
});

/* The WalletConnect SDK reports the exception it swallowed through its own
 * logger, which writes to the console -- a place with no reader on a phone.
 * Mirroring it into the log panel is what makes that report arrive.
 *
 * Only the first line and only 200 characters: the argument is sometimes a
 * whole rejected payload, and this panel is meant to be pasted into bug
 * reports. The console still gets everything, untouched, for desktop devtools.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  consoleError(...args);
  const first = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : ""))
    .find((t) => t !== "");
  if (first !== undefined) log(`console error: ${(first.split("\n")[0] ?? "").slice(0, 200)}`);
};

/* ------------------------------------------------------------------ client */

/** Minimal request/response client over a Transport. */
class Client {
  private readonly transport: Transport;
  private readonly decoder = new FrameDecoder();
  private pending: ((v: { ok?: Record<string, CborValue>; err?: DeviceError }) => void) | null = null;
  /** Established after the handshake; null while everything is plaintext. */
  private session: Session | null = null;
  /** Serialises requests; see call(). */
  private queue: Promise<void> = Promise.resolve();
  /** True during waitForApproval, when a plaintext 0x0400 means "not yet". */
  private awaitingApproval = false;

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onFrame((frame) => {
      for (const f of this.decoder.push(frame)) {
        let payload = f.payload;

        /* Encrypted replies are unsealed before parsing. A failed tag throws
         * and is surfaced rather than retried: a forged frame means the
         * channel is no longer trustworthy. */
        const encrypted =
          f.type === FrameType.EncryptedResponse || f.type === FrameType.EncryptedError;

        /* An encrypted frame with no session to open it is ciphertext, and
         * ciphertext parsed as CBOR is noise - "unsupported major type 7",
         * "trailing bytes", whatever the random bytes happen to spell. Say
         * what actually happened instead of reporting the shape of the
         * garbage. */
        if (encrypted && !this.session) {
          const resolve = this.pending;
          this.pending = null;
          resolve?.({ err: new DeviceError(
            ErrorCode.SessionRequired,
            "the device replied encrypted but this side has no session; reconnect",
          ) });
          continue;
        }

        if (encrypted && this.session) {
          try {
            payload = this.session.decrypt(payload);
          } catch {
            this.killSession("a reply failed authentication");
            const resolve = this.pending;
            this.pending = null;
            resolve?.({ err: new DeviceError(0x0400, "authentication failed") });
            continue;
          }
        }

        const body = decodeCbor(payload) as Record<string, CborValue>;
        const resolve = this.pending;
        this.pending = null;
        if (!resolve) continue;
        if (f.type === FrameType.Error || f.type === FrameType.EncryptedError) {
          const code = Number(body["code"]);
          /* 0x0400 in PLAINTEXT after a session existed means the device threw
           * the session away - session_decrypt() resets on a failed tag, and a
           * failed tag is indistinguishable from an attack, so failing closed
           * there is right. But it leaves this side holding keys the device has
           * forgotten, and every later request gets the same "decrypt failed"
           * against a session that is already gone. Retrying into that is what
           * made an unlock fail twice and look like the PIN was wrong.
           *
           * One corrupted frame is rare on a cable and entirely ordinary on a
           * radio, which is why this only ever showed up over BLE. */
          /* Not while waiting for the button. A device that has not been
           * confirmed yet answers exactly this, in plaintext, every time it is
           * polled - it means "not yet", not "your session is gone". Killing
           * the session here deleted the one that was about to become valid,
           * and the poll then succeeded in plaintext and reported an encrypted
           * channel that did not exist. */
          if (code === ErrorCode.SessionRequired && f.type === FrameType.Error &&
              !this.awaitingApproval) {
            this.killSession("the device ended the session");
          }
          resolve({ err: new DeviceError(code, String(body["message"])) });
        } else {
          resolve({ ok: body["result"] as Record<string, CborValue> });
        }
      }
    });
  }

  /**
   * Send one request and await its reply, one at a time.
   *
   * The link has no request IDs, so a reply belongs to whichever request went
   * out last. With a background poll running, a user action could overlap it
   * and each would resolve the other's promise — and because the nonce counter
   * advances on a completed exchange, the two ends then drift apart and every
   * later frame fails. That is what "clicked Unlock and it hung" was.
   *
   * Serialising here is the fix rather than removing the poll: the poll exists
   * to notice changes made on the device, which is exactly when a user is also
   * touching the app.
   */
  async call(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    const mine = this.queue.then(() => this.callNow(method, params, timeoutMs));
    // Keep the chain alive even when a call rejects, or one failure wedges
    // every request that follows.
    this.queue = mine.then(() => undefined, () => undefined);
    return mine;
  }

  private async callNow(
    method: string,
    params: Record<string, CborValue> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, CborValue>> {
    /* Waiting longer than the device does is the only safe direction. If the
     * transport gives up first, the device still processes the request and
     * replies to nobody: its counters move, the host's do not, and the session
     * is unrecoverable. That is not a timeout, it is a broken connection with
     * a misleading message. */
    const t = this.transport as { timeoutMs?: number };
    if ("timeoutMs" in t) t.timeoutMs = timeoutMs;

    const reply = new Promise<{ ok?: Record<string, CborValue>; err?: DeviceError }>((r) => {
      this.pending = r;
    });

    /* Flat, per PROTOCOL.md section 4: fields sit beside `method` rather than
     * inside a `params` object. The firmware looks for them at the top level,
     * so a nested request would have had its arguments silently ignored. */
    const body = encodeCbor({ method, ...params });
    const [type, payload] = this.session?.isActive
      ? [FrameType.EncryptedRequest, this.session.encrypt(body)]
      : [FrameType.Request, body];

    try {
      await this.transport.send(encodeFrame(type, payload));
    } catch (e) {
      /* The device may still be processing. Its counters will have moved and
       * ours have not, so the session cannot be reused - fail loudly rather
       * than leaving the next request to die with "decrypt failed". */
      this.session = null;
      this.pending = null;
      throw new Error(
        `${(e as Error).message}. The session is no longer usable; disconnect and reconnect.`,
      );
    }
    const { ok, err } = await reply;
    if (err) throw err;
    return ok ?? {};
  }

  /**
   * Run the commit-then-reveal handshake and return the passkey to compare.
   *
   * Two round trips, and the order is the security property rather than a
   * formality. The device commits to its nonce in `helloAck`; only then does
   * this side reveal its own in `helloReveal`; only then does the device
   * reveal the nonce it committed to. Neither end could have chosen its
   * contribution after seeing the other's, so a relay between them cannot
   * search for a value that makes both screens agree — it is down to one
   * online guess at 1 in 10^6, which is a mismatch the user sees.
   *
   * Every failure below aborts rather than degrades. A handshake that "worked
   * except for the commitment" is exactly the v1 handshake that a relay ground
   * through in 91 seconds.
   */
  async handshake(): Promise<string> {
    const { privateKey, publicKey } = generateKeypair();
    const ack = await this.call("hello", {
      version: PROTOCOL_VERSION,
      hostPubkey: publicKey,
    });

    /* Version before anything else: an old device answers v1 here, and saying
     * so is far more use than the "decrypt failed" three frames later that a
     * missing check used to produce. */
    const theirVersion = ack["version"];
    if (theirVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `this app speaks protocol v${PROTOCOL_VERSION}; the device answered ` +
        `v${typeof theirVersion === "number" ? theirVersion : "none"} — update the older one`,
      );
    }

    const devicePubkey = ack["devicePubkey"];
    if (!(devicePubkey instanceof Uint8Array) || devicePubkey.length !== 32) {
      throw new Error("device did not return a public key");
    }
    const deviceCommit = ack["deviceCommit"];
    if (!(deviceCommit instanceof Uint8Array) || deviceCommit.length !== COMMIT_BYTES) {
      throw new Error("device did not commit to a nonce");
    }

    const hostNonce = generateNonce();
    const revealed = await this.call("helloReveal", { hostNonce });

    const deviceNonce = revealed["deviceNonce"];
    if (!(deviceNonce instanceof Uint8Array) || deviceNonce.length !== NONCE_BYTES) {
      throw new Error("device did not reveal its nonce");
    }

    /* The check that makes the commitment worth having. Failing it means the
     * nonce was chosen after the device saw ours, which is the whole attack —
     * so this is a refusal, never a warning. */
    if (!verifyCommitment(deviceCommit, devicePubkey, publicKey, deviceNonce)) {
      throw new Error(
        "the device's nonce does not match what it committed to — refusing to " +
        "pair; something is relaying this connection",
      );
    }

    this.session = new Session(
      deriveSession(privateKey, devicePubkey, {
        hostPublic: publicKey,
        devicePublic: devicePubkey,
        hostNonce,
        deviceNonce,
      }),
      "host",
    );
    return this.session.passkey;
  }

  /**
   * Wait for the user to approve on the device.
   *
   * There is no "confirmed" message to wait for: the device simply starts
   * accepting encrypted traffic once the button is pressed. So the host tries
   * an encrypted call until one succeeds, which is both the check and the
   * first real use of the channel.
   */
  async waitForApproval(timeoutMs = 60000): Promise<void> {
    if (!this.session) throw new Error("no handshake");
    this.session.confirm();
    this.awaitingApproval = true;
    try {

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        /* The first encrypted call to succeed IS the confirmation - there is
         * no "confirmed" message to wait for. So it must be an encrypted one:
         * getStatus answers in plaintext too, and a plaintext success here
         * would report a channel that was never established. */
        if (!this.session) {
          throw new Error("the session was lost while waiting for confirmation");
        }
        try {
          await this.call("getStatus");
          return;
        } catch {
          if (Date.now() > deadline) {
            throw new Error("timed out waiting for confirmation on the device");
          }
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    } finally {
      this.awaitingApproval = false;
    }
  }

  /**
   * Forget the session. The next call goes out in plaintext and is refused,
   * which is the honest outcome: there is no channel until a new handshake,
   * and quietly re-establishing one would skip the passkey comparison that
   * makes the channel worth anything.
   */
  private killSession(why: string): void {
    if (!this.session) return;
    this.session = null;
    log(`session ended — ${why}. Reconnect to compare a new passkey.`);
    setConnection("connecting", "Session ended — reconnect");
  }

  get encrypted(): boolean {
    return this.session?.isActive ?? false;
  }
}

/* ------------------------------------------------------------------- state */

let transport: Transport | null = null;
let client: Client | null = null;

/**
 * What the backend says it can do. Empty in a browser tab and on Android,
 * where the mock is the only honest option.
 */
let available: HardwareKind[] = [];

type LinkKind = HardwareKind | "mock";

/** Whatever the Link selector currently reads. */
function selectedKind(): LinkKind {
  const value = ($("transport") as HTMLSelectElement).value;
  return value === "usb" || value === "ble" ? value : "mock";
}
let selectedIndex = 0;
const addresses: string[] = [];

/* ---------------------------------------------------------------- accounts */

/*
 * BIP-44 account selection, host side (T45a).
 *
 * The device browses one account on its own screens and reports it in
 * getStatus; until now the app only *followed* that number and hardcoded
 * `m/44'/60'/0'/0/i` into every request it made. Those two facts were
 * compatible only for as long as the device stayed on account 0.
 *
 * "Follow the device" stays the default, and it is the honest default: two
 * accounts off one seed produce address lists that look exactly alike, so a
 * user reading an address here while the device browses elsewhere has nothing
 * on either screen telling them the two disagree. Choosing a number instead is
 * a deliberate act, and the hint under the selector then says the two ends are
 * looking at different identities.
 *
 * Ten, not 2^31, for the same reason the address browser stops at ten: it is
 * what the device's own menus reach and what this app enumerates. The protocol
 * is wider and the firmware bounds it at 2^31; nothing here needs to be.
 */
const ACCOUNT_COUNT = 10;

/** null means "whatever the device is on". */
let chosenAccount: number | null = null;

/** The account the app is actually deriving under, right now. */
function effectiveAccount(): number {
  return chosenAccount ?? lastStatus.account;
}

/**
 * The account `addresses` was derived under, or -1 for "nothing derived".
 *
 * Derived state is valid only for one (unlocked, wallet, passphrase, account)
 * tuple. The first three arrive from the device and `derivationsInvalidated()`
 * watches them; the fourth can now also be moved from this side, and a change
 * the app made itself would otherwise never show up in a status comparison.
 * Recording it here is what lets every signing path refuse rather than sign
 * from an address it derived under a different account.
 */
let derivedAccount = -1;

/** The path a request names, spelled out once so no caller writes it by hand. */
function addressPath(account: number, index: number): string {
  return `m/44'/60'/${account}'/0/${index}`;
}

/**
 * The account to put on a signing request, or a refusal.
 *
 * Every signing call sends `account` explicitly rather than leaning on the
 * device's current selection to happen to match — a default that agrees today
 * and disagrees the moment somebody turns the wheel is not a default, it is a
 * coincidence. And the addresses this app is about to name an index into were
 * derived under one account: if that is no longer the account being asked for,
 * the index means a different key and there is nothing on either screen that
 * would look wrong. Refusing is the only answer; re-deriving silently would
 * sign from an address the user never saw.
 */
function signingAccount(): number {
  const account = effectiveAccount();
  if (derivedAccount !== account) {
    throw new Error(
      "the addresses on screen were derived under a different account — reconnect or reselect before signing",
    );
  }
  return account;
}

/* Last known device state, and a poll to notice changes the app did not cause
 * - an auto-lock on the device's own timer, or a wallet switched by hand. */
let lastStatus: DeviceStatus = UNKNOWN_STATUS;

/* Whether the DEVICE will accept a call it cannot decode.
 *
 * Read from getFeatures rather than assumed, and re-read on every status poll
 * because the setting lives on the device and its owner can change it mid
 * session - which is exactly what someone does the moment a dapp is refused.
 * Defaults to false so a device that has not answered yet is treated as
 * protected: the safe direction to be wrong in. */
let deviceBlindSigning = false;

async function readBlindSigning(): Promise<boolean> {
  try {
    const f = await (client as Client).call("getFeatures");
    return f["blindSigning"] === 1;
  } catch {
    return false;
  }
}
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Bumped whenever a derivation is superseded or discarded. */
let loadGeneration = 0;

async function readStatus(): Promise<DeviceStatus> {
  deviceBlindSigning = await readBlindSigning();
  const s = await (client as Client).call("getStatus");
  return {
    unlocked: s["unlocked"] === 1,
    walletCount: Number(s["walletCount"] ?? 0),
    activeWallet: Number(s["activeWallet"] ?? 0),
    passphrase: s["passphrase"] === 1,
    /* Absent on firmware older than this field. Defaulting to 0 makes such a
     * device look permanently parked on the default account, which is what it
     * effectively is from the host's side: it never reports a change, so
     * nothing is ever invalidated for a reason the app cannot see. */
    account: Number(s["account"] ?? 0),
  };
}

/**
 * Forget everything derived.
 *
 * Called whenever the device state moves in a way that changes derivation. The
 * addresses on screen would otherwise belong to a wallet the device can no
 * longer produce, and nothing about them would look wrong.
 */
function invalidateDerived(reason: string): void {
  // Retire any in-flight derivation as well as the current list.
  loadGeneration++;
  addresses.length = 0;
  /* Back to "nothing derived". Left at its old value it would claim the next
   * signing attempt was checked against an account that no longer applies. */
  derivedAccount = -1;
  $("addrs").textContent = "";
  $("addrdetail").hidden = true;
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("sfrom").textContent = "—";
  clearBalances();
  log(`derived addresses cleared: ${reason}`);
  // A locked device offers no accounts, so a proposal on screen has to say so.
  walletConnect.accountsChanged();
}

let polling = false;

/** Why the previous state no longer applies. Ordered most specific first. */
function invalidationReason(before: DeviceStatus, after: DeviceStatus): string {
  if (!after.unlocked) return "device locked";
  if (!before.unlocked) return "device unlocked";
  if (before.activeWallet !== after.activeWallet) return "wallet changed on device";
  if (before.passphrase !== after.passphrase) {
    return after.passphrase ? "passphrase applied on device" : "passphrase cleared on device";
  }
  if (before.account !== after.account) return `account changed on device to ${after.account}`;
  return "device state changed";
}

/**
 * The one-line wallet state in the header.
 *
 * Account is in here because it is half of which wallet you are in and was
 * previously invisible from this side: two accounts of one seed are different
 * identities that the rest of this bar describes identically.
 */
function walletLabel(s: DeviceStatus): string {
  if (!s.unlocked) return "locked";
  const account = chosenAccount === null || chosenAccount === s.account
    ? `account ${s.account}`
    : `account ${chosenAccount} (device on ${s.account})`;
  return `wallet ${s.activeWallet}/${s.walletCount}` +
    (s.passphrase ? " + passphrase" : "") + ` · ${account}`;
}

async function poll(): Promise<void> {
  if (!client) return;

  /* setInterval does not wait. Deriving ten addresses takes seconds, so
   * without this guard the next tick re-enters while the previous run is still
   * working, and each one starts another derivation. */
  if (polling) return;
  polling = true;

  try {
    const now = await readStatus();
    const changed = derivationsInvalidated(lastStatus, now);

    /* Record the new state *before* the slow part. Updating it afterwards
     * meant every tick during a derivation still compared against the old
     * status, decided things had changed again, and kicked off another
     * derivation - forty-two addresses and climbing. */
    const reason = changed ? invalidationReason(lastStatus, now) : "";
    lastStatus = now;

    $("wallet").textContent = walletLabel(now);
    /* The follow option names the device's number, so it has to be redrawn
     * whenever that number moves - including the move the app did not make. */
    renderAccountSelector();
    $("passpanel").hidden = !now.unlocked;

    if (changed) {
      /* Note that a device-side account change invalidates even when the app
       * has pinned an account of its own and the derivation would come back
       * identical. That is the conservative direction device-state.ts asks for,
       * and the cost is one re-derivation of a list nobody was looking at. */
      invalidateDerived(reason);
      if (now.unlocked) {
        await loadAddresses();
        $("addrpanel").hidden = false;
        $("signpanel").hidden = false;
      }
    }
  } catch {
    /* A poll failing is not itself news; the connection state covers it. */
  } finally {
    polling = false;
  }
}

const setConnection = (state: string, label: string): void => {
  $("dot").dataset["state"] = state;
  $("conn").textContent = label;
};

/**
 * Put the controls back to their disconnected state.
 *
 * Every failure path in connect() must end here. busy(true) disables all four
 * buttons for the duration of an attempt, and an early return that forgets to
 * undo it leaves the user staring at an app whose Unlock does nothing - which
 * is exactly what happened on hardware: a handshake that failed left every
 * control dead and looked like the session had been lost.
 */
const showDisconnected = (): void => {
  ($("connect") as HTMLButtonElement).disabled = false;
  ($("unlock") as HTMLButtonElement).disabled = true;
  ($("disconnect") as HTMLButtonElement).disabled = true;
  ($("sign") as HTMLButtonElement).disabled = true;
  ($("transport") as HTMLSelectElement).disabled =
    ($("transport") as HTMLSelectElement).options.length < 2;
};

const busy = (on: boolean): void => {
  for (const id of ["connect", "unlock", "disconnect", "sign"]) {
    ($(id) as HTMLButtonElement).disabled = on;
  }
};

/* ----------------------------------------------------------------- actions */

/**
 * Find a device on the selected link.
 *
 * Returns null having already explained itself, because the two failures need
 * different explanations: no serial port is usually a cable or a permissions
 * problem, while nothing advertising over BLE is usually a device that is
 * simply in USB mode and therefore silent on the radio (PROTOCOL.md 3b).
 * Collapsing both into "no device found" would send someone hunting a fault
 * that does not exist.
 */
async function findDevice(kind: LinkKind): Promise<Transport | null> {
  if (kind === "usb") {
    /* Enumeration *rejects* rather than returning empty when the platform has
     * something specific to say - on Android, the cable and USB-host checks
     * that a laptop's dialout-group advice would send someone past. Same shape
     * as the BLE branch below, and for the same reason: swallowing the message
     * would leave the user staring at an empty list. */
    let ports;
    try {
      ports = await listPorts();
    } catch (e) {
      setConnection("error", "No device over USB");
      log(String((e as Error).message ?? e));
      return null;
    }
    const port = ports.find((p) => p.likely_device) ?? ports[0];
    if (!port) {
      setConnection("error", "No device over USB");
      log("no USB serial ports; check the cable, and that you are in the dialout group");
      return null;
    }
    /* More than one candidate is unusual and worth saying out loud rather than
     * silently taking the first - the same rule the BLE branch follows. It is
     * not hypothetical on a phone: a USB-C dock or a second dev board is a
     * whole extra Espressif device on the bus, and the user should know a
     * choice was made for them before they approve a signature on it. */
    const candidates = ports.filter((p) => p.likely_device);
    if (candidates.length > 1) {
      log(`${candidates.length} Espressif devices attached; using ${port.name}`);
    } else if (!port.likely_device) {
      log(`no Espressif device among ${ports.length} port(s); trying ${port.name} anyway`);
    }
    log(`found ${port.name} — ${port.description}`);
    /* A port existing does not mean the device is listening on it. With Link
     * set to Bluetooth the firmware drains this port and parses nothing
     * (PROTOCOL.md 3b), so the cable enumerates exactly as it always does and
     * every request goes unanswered. There is no way to ask the device which
     * link it is on over the link it has switched off, so the silence is the
     * signal - see the handshake timeout below. */
    return new TauriSerialTransport(port.name);
  }

  if (kind === "ble") {
    log("scanning for Bluetooth devices…");
    let found;
    try {
      found = await scanBle();
    } catch (e) {
      setConnection("error", "Bluetooth unavailable");
      log(String((e as Error).message ?? e));
      return null;
    }
    const device = found[0];
    if (!device) {
      setConnection("error", "No device over Bluetooth");
      log(BLE_NOT_FOUND);
      return null;
    }
    // More than one is unusual and worth saying out loud rather than silently
    // taking the first: the user should know a choice was made for them.
    if (found.length > 1) {
      log(`${found.length} devices advertising; using ${device.name ?? device.id}`);
    }
    log(`found ${device.name ?? "(unnamed)"} — ${device.id}`);
    return new BleTransport(device);
  }

  /* Latency is deliberate: a mock that answers instantly hides every place
   * the UI forgot to show that it is waiting. `pinEntryMs` is the same idea
   * applied to unlocking - the device only prompts, and the seconds the user
   * spends on the keypad are seconds this app has to keep polling and keep
   * saying so. */
  return new MockDevice({ latencyMs: 250, walletCount: 1, pinEntryMs: 2000 });
}

/**
 * Whether a connection attempt is already in flight.
 *
 * A guard rather than a disabled button, because the button is only disabled
 * once `busy(true)` runs — and that is after the scan has been awaited, which
 * is precisely the several-second window a user is most likely to press it
 * again in. Two attempts overlapping is not two chances at the same thing: each
 * runs its own X25519 handshake, the device resets its session on every
 * handshake and therefore keeps the LAST key, and the app goes on encrypting
 * with the first. Every request after that fails to decrypt, and no amount of
 * retrying helps because both ends are behaving correctly with different keys.
 *
 * That state cost a user a full restart of the companion AND the board to
 * clear. The log said it plainly in hindsight: two "scanning" lines a second
 * apart, then two handshakes offering different passkeys.
 *
 * Set synchronously before the first await, so two clicks in the same tick
 * cannot both pass it.
 */
let connecting = false;

async function connect(): Promise<void> {
  if (connecting) {
    log("already connecting — ignoring that");
    return;
  }
  connecting = true;
  try {
    await connectOnce();
  } finally {
    connecting = false;
  }
}

async function connectOnce(): Promise<void> {
  /* Real hardware over whichever link the user picked, the mock when there is
   * none. All three are interchangeable by construction — if they were not,
   * everything built against the mock would need revisiting the first time a
   * device was plugged in, and everything proven over USB would prove nothing
   * about BLE. */
  const kind = selectedKind();
  const found = await findDevice(kind);
  if (!found) return;
  transport = found;
  client = new Client(transport);
  setMode(transport);

  setConnection("connecting", "Connecting…");
  busy(true);
  try {
    await transport.open();
  } catch (e) {
    setConnection("error", "Connection failed");
    log(String((e as Error).message ?? e));
    transport = null;
    client = null;
    setMode(null);
    showDisconnected();
    return;
  }

  if (kind !== "mock") {
    /* Nothing stale may survive into a new attempt. A passkey left on screen
     * from a previous session is worse than none: the whole point is that the
     * user compares it against the device, and a number the device is not
     * showing invites them to conclude the comparison failed for some other
     * reason - or, worse, to stop checking. */
    $("passkey").textContent = "";
    $("pairing").hidden = true;

    /* Real firmware: derive the passkey from the exchange and wait for the
     * user to compare it against the OLED. */
    let passkey: string;
    try {
      passkey = await client.handshake();
    } catch (e) {
      /* On USB this is nearly always a device whose Link is set to Bluetooth:
       * the port opened, the bytes went out, and nothing was listening. */
      setConnection("error", "Device did not answer");
      if (kind === "usb") {
        log("the port opened but the device never answered.");
        log("if the device's Link setting is Bluetooth, USB is silent by design —");
        log("check Settings → Link on the device, or switch this app to Bluetooth.");
      } else {
        log(`handshake failed: ${String((e as Error).message ?? e)}`);
      }
      await transport.close().catch(() => {});
      transport = null;
      client = null;
      setMode(null);
      showDisconnected();
      return;
    }
    $("passkey").textContent = `${passkey.slice(0, 3)} ${passkey.slice(3)}`;
    $("pairing").hidden = false;
    log(`handshake done — compare ${passkey} with the device screen`);
    log("press ALLOW on the device to continue");
    /* Announced rather than routed through deviceAttention, because the spoken
     * form has to differ from the logged one: the passkey lives in a definition
     * list a screen-reader user has no reason to be in, and six digits read as
     * one number are not a string anybody can compare against a device screen.
     * So it is spoken separately, and separated. */
    announce(
      `Compare the passkey ${passkey.split("").join(" ")} with the device screen, ` +
      `then press ALLOW on the device to continue.`,
    );
    setConnection("connecting", "Confirm on device…");

    try {
      await client.waitForApproval();
    } catch (e) {
      /* Times out after a minute, or the session died while waiting. Either
       * way this attempt is over and the controls must come back - the user
       * has to be able to press Connect again. */
      setConnection("error", "Not confirmed on the device");
      announce("Not confirmed on the device. The connection attempt has ended.");
      log(String((e as Error).message ?? e));
      await transport.close().catch(() => {});
      transport = null;
      client = null;
      setMode(null);
      showDisconnected();
      return;
    }
    log("approved on device; channel encrypted");
  } else {
    /* The mock has no key agreement, so this is not handshake() — but it is
     * still both legs in the right order, because the mock models the state
     * machine and refuses a reveal that no commitment is waiting on. Anything
     * less here would be the demo path quietly proving the protocol works with
     * one round trip. */
    await client.call("hello", { version: PROTOCOL_VERSION });
    const hello = await client.call("helloReveal");
    const passkey = hello["passkey"];
    $("passkey").textContent =
      typeof passkey === "string" ? passkey : "(mock: nothing to compare)";
    $("pairing").hidden = false;
    log(`session established with ${transport.label}`);
  }

  setConnection("connected", transport.label);
  $("devicehint").textContent = kind !== "mock"
    ? `Connected over ${transport.label}. The device confirms everything it signs on its own screen.`
    : "Connected to the mock. Behaviour matches the protocol, but keys and signatures are not real.";
  busy(false);
  ($("connect") as HTMLButtonElement).disabled = true;
  // Switching links mid-session would tear down the device's session anyway;
  // shutting the selector says so before it happens.
  ($("transport") as HTMLSelectElement).disabled = true;
  ($("unlock") as HTMLButtonElement).disabled = false;
  ($("disconnect") as HTMLButtonElement).disabled = false;
}

async function unlock(): Promise<void> {
  if (!client) return;
  busy(true);
  deviceAttention("enter your PIN on the device…");
  try {
    const reply = await client.call("unlock");

    /* The device only *prompts*; the PIN is typed there and never travels, so
     * the reply is `{prompted:1, unlocked:0}` and arrives long before the user
     * has touched the keypad. The status poll is the answer. `{unlocked:1}`
     * comes back only when the device was already unlocked. */
    if (reply["unlocked"] !== 1) {
      log("waiting for the PIN on the device…");
      const deadline = Date.now() + 120000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 750));
        const s = await readStatus();
        if (s.unlocked) break;
        if (Date.now() > deadline) throw new Error("timed out waiting for the PIN");
      }
    }
    log("device unlocked");
    /* Status before derivation, not after: in follow mode the account to
     * derive under is the device's, and reading it afterwards meant the first
     * ten addresses came off account 0 on a device parked anywhere else. */
    lastStatus = await readStatus();
    renderAccountSelector();
    await loadAddresses();
    $("addrpanel").hidden = false;
    $("signpanel").hidden = false;
    $("passpanel").hidden = !lastStatus.unlocked;
    if (!lastStatus.unlocked) {
      log("device is locked — press Unlock, then enter your PIN on the device");
    }
    $("wallet").textContent = walletLabel(lastStatus);

    /* Two seconds is frequent enough that a lock is noticed before the user
     * acts on a stale address, and rare enough not to keep a BLE link busy. */
    if (!pollTimer) pollTimer = setInterval(() => void poll(), 2000);
  } catch (e) {
    // Name the thing that failed. "undefined" was the previous message when
    // the device answered with an error carrying no text.
    const msg = e instanceof DeviceError ? e.message
      : e instanceof Error && e.message ? e.message
      : String(e);
    log(`unlock failed: ${msg}`);
  } finally {
    busy(false);
    ($("connect") as HTMLButtonElement).disabled = true;
  }
}

async function loadAddresses(): Promise<void> {
  if (!client) return;

  /* Each run claims a generation. If another starts while this one is waiting
   * on the device, this one abandons its results rather than appending them to
   * a list it no longer owns. */
  const generation = ++loadGeneration;

  addresses.length = 0;
  const list = $("addrs");
  list.textContent = "Deriving…";

  /* Pinned for the whole run. Reading effectiveAccount() per iteration would
   * let a selector change land halfway down and produce a list stitched from
   * two accounts, which is the one shape of wrong that no address on screen
   * would betray. The generation check already discards a superseded run; this
   * makes sure the run itself is coherent. */
  const account = effectiveAccount();

  const derived: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await client.call("getAddress", { path: addressPath(account, i) });
    if (generation !== loadGeneration) return;   // superseded
    derived.push(String(r["address"]));
  }

  addresses.length = 0;
  addresses.push(...derived);
  derivedAccount = account;

  list.textContent = "";

  const select = $("addrselect") as HTMLSelectElement;
  select.textContent = "";
  addresses.forEach((addr, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    /* Index, path tail and a truncated address. The full value is shown under
     * the selector rather than squeezed into an option, where a middle-elided
     * string is exactly the shape an attacker hides a swap in. */
    opt.textContent = `${i} — ${addr.slice(0, 10)}…${addr.slice(-6)}`;
    select.appendChild(opt);
  });
  if (selectedIndex >= addresses.length) selectedIndex = 0;
  select.value = String(selectedIndex);
  drawSelectedAddress();

  $("sfrom").textContent = addressPath(account, selectedIndex);
  log(`derived ${addresses.length} addresses under account ${account}`);
  walletConnect.accountsChanged();
  /* One of the two moments a fetch happens without being asked for: the app
   * has just learned which address the user is looking at, which is exactly
   * when a balance stops being a stale number about somebody else. */
  clearBalances();
  populateAssets();
  void refreshBalances("addresses derived");
}

/* -------------------------------------------------------------- passphrase */

/*
 * Host-side passphrase entry (T40) — the weaker of the two paths, and labelled
 * as such everywhere it is reachable.
 *
 * The device already accepts `setPassphrase` and already refuses to apply one
 * without a confirmation on its own screen. What was missing was any way to
 * send one, which meant the choice between the two paths was not being offered
 * — and an unoffered choice is not a security decision anyone made.
 *
 * So it is offered, and the accounting is spelled out at the point of use
 * rather than in a document: this app reads every character before encryption
 * touches it, so a compromised host learns the passphrase, and no amount of
 * ChaCha20 on the wire changes that. On-device entry stays the default and the
 * one described first; this lives behind a closed disclosure with the warning
 * inside it.
 *
 * Nothing here keeps the passphrase: it is read out of the field, handed to
 * the transport, and the field is cleared in a finally. It is never logged,
 * never announced, never persisted, and diagnosticsReport() has no path to it.
 */

/** Matches protocol.c: printable ASCII, 1..63 bytes, no empty (that is not "clear"). */
function passphraseComplaint(value: string): string | null {
  if (value.length === 0) return "Nothing to send. An empty passphrase is the base wallet, not a passphrase.";
  /* Byte length, because the device's bound is a 64-byte buffer. Non-ASCII is
   * refused a line below anyway, so this only ever matters for long input. */
  if (new TextEncoder().encode(value).length > 63) return "Too long: the device accepts up to 63 characters.";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      /* Named, not shown: echoing the offending character back into the page
       * would put a piece of the passphrase on screen and into a screenshot. */
      return "Only printable ASCII, the same set the device's own keyboard can type.";
    }
  }
  return null;
}

function initPassphrase(): void {
  const input = $("passinput") as HTMLInputElement;
  const button = $("passapply") as HTMLButtonElement;
  const hint = $("passhint");

  const apply = async (): Promise<void> => {
    if (!client) { hint.textContent = "No device connected."; return; }

    const complaint = passphraseComplaint(input.value);
    if (complaint) { hint.textContent = complaint; return; }

    button.disabled = true;
    hint.textContent = "Waiting for the device…";
    deviceAttention(
      "check the address the device shows, then confirm the passphrase on the device",
    );
    try {
      /* The value goes straight from the field into the call. No local, no
       * closure holding it after this line, and the field is emptied in the
       * finally below whichever way this ends. */
      const reply = await client.call("setPassphrase", { passphrase: input.value }, 150000);

      /* The device answers with the first address of the wallet it derived —
       * the same string it drew on its screen — because that is what the user
       * compares. Older shapes answered with a fingerprint; either is a
       * reference to check, and neither is a secret. */
      const shown = typeof reply["address"] === "string"
        ? String(reply["address"])
        : typeof reply["fingerprint"] === "string" ? String(reply["fingerprint"]) : "";
      hint.textContent = shown
        ? `Applied. The device derived ${shown} — if that is not the wallet you expected, the passphrase was mistyped: lock the device to drop it.`
        : "Applied. Check the first address against the one the device showed.";
      log("passphrase applied from the host and confirmed on the device");

      /* Invalidate by hand rather than waiting for the poll. Replacing one
       * passphrase with another leaves the status flag reading `true` both
       * before and after, so `derivationsInvalidated()` sees no change and the
       * previous wallet's addresses would stay on screen under a wallet the
       * device can no longer produce. That is exactly the case this rule
       * exists for, and it is the one a boolean cannot see. */
      invalidateDerived("passphrase changed from the host");
      lastStatus = await readStatus();
      $("wallet").textContent = walletLabel(lastStatus);
      renderAccountSelector();
      if (lastStatus.unlocked) {
        await loadAddresses();
        $("addrpanel").hidden = false;
        $("signpanel").hidden = false;
      }
    } catch (e) {
      const msg = e instanceof DeviceError ? e.message
        : e instanceof Error && e.message ? e.message
        : String(e);
      /* The device drops an unconfirmed passphrase itself, so a refusal here
       * leaves the base wallet rather than a half-applied one. Say so: "it
       * failed" without "and you are still where you were" is what makes
       * someone try again blind. */
      hint.textContent = `Not applied: ${msg}. The device kept the wallet it was already in.`;
      log(`passphrase not applied: ${msg}`);
    } finally {
      input.value = "";
      button.disabled = false;
    }
  };

  button.addEventListener("click", () => void apply());
  /* Enter in a single-field form is what everyone types, and a field that
   * ignores it gets its contents submitted twice by a user hunting the button. */
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void apply(); }
  });
}

/* ------------------------------------------------------------------ chains */

/*
 * Chain selection (T51). The registry in packages/core/src/chains.ts is the
 * only source of chain facts; nothing about a network is written down here.
 *
 * The choice is persisted because it is the single field a user is most likely
 * to get wrong by inattention: the same address exists on every EVM chain, and
 * a signature that was meant for a testnet but was made on mainnet spends real
 * money. Restoring the last choice is not merely convenient, it means the
 * selector reads the same on every launch instead of quietly resetting.
 */
const CHAIN_KEY = "leek.chainId";

/** Sepolia: the default has to be a testnet, since a mis-click here costs money. */
const DEFAULT_CHAIN_ID = 11155111;

function storedChainId(): number {
  const raw = localStorage.getItem(CHAIN_KEY);
  const id = raw === null ? NaN : Number(raw);
  // resolveChain, not getChain: a custom network the user added is a legitimate
  // thing to have selected last time. It is still marked custom everywhere it
  // is rendered — see chainLabelDetailed.
  return resolveChain(id) ? id : DEFAULT_CHAIN_ID;
}

let chainId = storedChainId();

/** Never undefined: storedChainId() only returns IDs the registry knows. */
function activeChain(): ChainInfo {
  return resolveChain(chainId) ?? (getChain(DEFAULT_CHAIN_ID) as ChainInfo);
}

/**
 * The registry entry as viem wants it. Built per call rather than cached: viem
 * only needs id, currency and a URL, and a stale cache here would mean signing
 * for one chain while broadcasting to another.
 */
function viemChain(info: ChainInfo, endpoint: string): Chain {
  return defineChain({
    id: info.id,
    name: info.name,
    nativeCurrency: info.nativeCurrency,
    rpcUrls: { default: { http: [endpoint] } },
    ...(info.testnet ? { testnet: true } : {}),
  });
}

/** Rebuild the RPC list for whatever chain is selected, preserving nothing. */
function populateRpcs(info: ChainInfo): void {
  const select = $("rpc") as HTMLSelectElement;
  select.textContent = "";
  for (const url of info.rpcUrls) {
    const opt = document.createElement("option");
    opt.value = url;
    // The host, not the full URL: the user is choosing who to tell, and the
    // path is noise in that decision.
    opt.textContent = new URL(url).host;
    select.appendChild(opt);
  }
  /* Show the endpoint that actually worked last time rather than always the
   * first one listed. Otherwise the selector claims a preference the app is no
   * longer acting on, and the whole point of showing it is that it is true. */
  select.value = preferredRpc(info.id, info.rpcUrls) ?? (info.rpcUrls[0] as string);
}

/**
 * Say which operator was actually reached (T62).
 *
 * Failover means the endpoint in the selector is a first choice, not a
 * promise, so "who learned about my addresses" is no longer answered by
 * reading the dropdown. The preview says "the RPC you pick learns which
 * addresses you are asking about"; this line is what keeps that sentence
 * honest when the pick did not answer and somebody else did.
 */
function showRpcUsed(text: string): void {
  $("rpcused").textContent = text;
}

/*
 * How RPC requests leave this process (T62 stage 2).
 *
 * `fetch` until the backend has been asked, then the Rust proxy if this build
 * has one. Held in a module-level variable, and resolved once at startup,
 * because a transport that changed between the nonce lookup and the broadcast
 * would make "who was asked" unanswerable — and that question has to have an
 * answer, since it is the one the sign preview promises.
 *
 * The difference is not cosmetic: a `fetch` is bound by the CSP to the
 * reviewed origins, so on that path a custom network cannot be reached at all.
 */
let rpcSend: RpcSend = fetchRpcSend();
let viaProxy = false;

/** The endpoints the active chain would be tried in, by host. For diagnostics. */
function activeChainOrder(): string[] {
  const info = activeChain();
  return endpointOrder(info.id, info.rpcUrls).map((u) => new URL(u).host);
}

/**
 * A viem client whose transport walks the chain's endpoints in turn.
 *
 * `custom()` rather than `http()`: the failover policy, the timeout and the
 * record of who answered all live in core where they are tested without a
 * network, and stage 2 swaps what `send` is without touching this call site.
 *
 * viem's own retry is switched off. It would re-send the same call to the same
 * endpoint, which for a wallet means disclosing the request again for a
 * failure we are already handling one layer down.
 */
function rpcFor(info: ChainInfo): { chain: Chain; transport: ReturnType<typeof custom>; failover: FailoverRpc } {
  const first = preferredRpc(info.id, info.rpcUrls) ?? (info.rpcUrls[0] as string);
  const failover = new FailoverRpc({
    chainId: info.id,
    rpcUrls: info.rpcUrls,
    send: rpcSend,
    onEndpoint: (url) => showRpcUsed(`Reached ${new URL(url).host}${viaProxy ? "" : " (direct)"}.`),
    onFailover: (a) => {
      showRpcUsed(`${new URL(a.url).host} did not answer (${a.reason}); trying the next endpoint.`);
      log(`rpc: ${new URL(a.url).host} ${a.reason}: ${a.message}`);
    },
  });
  return {
    chain: viemChain(info, first),
    transport: custom({ request: (args) => failover.request(args as { method: string; params?: unknown }) }, {
      retryCount: 0,
    }),
    failover,
  };
}

function applyChain(info: ChainInfo): void {
  populateRpcs(info);
  showRpcUsed("No endpoint contacted yet.");
  $("amountlabel").textContent = `Amount (${info.nativeCurrency.symbol})`;
  $("chainnote").dataset["net"] = info.testnet ? "testnet" : "mainnet";
  const money = info.testnet
    ? `Chain ${info.id}. Testnet — this money is not worth anything. Check the chain ID on the device.`
    : `Chain ${info.id}. MAINNET — real funds. Check the chain ID on the device before approving.`;
  /* A user-added network carries its caveat everywhere it is shown, not just
   * in the selector: nothing about its name, symbol or decimals was checked by
   * anything, and only the chain ID on the device decides which network the
   * signature is valid on. */
  $("chainnote").textContent =
    info.source === "custom" ? `${money} ${CUSTOM_CHAIN_NOTICE}` : money;
  /* The other unprompted fetch. A balance is per chain, so switching networks
   * does not make the figure old, it makes it about a different network
   * entirely — keeping it on screen would be worse than any staleness. */
  clearBalances();
  populateAssets();
  void refreshBalances("chain changed");
  renderPreview();
}

/** Rebuild the chain list: curated first, then custom. The order is the trust order. */
function populateChains(): void {
  const select = $("chain") as HTMLSelectElement;
  select.textContent = "";
  for (const c of allChains()) {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    // chainLabelDetailed, so a user-supplied name cannot reach the list
    // without the "(custom, unverified)" that came with it.
    opt.textContent =
      `${chainLabelDetailed(c.id).text} (${c.id})${c.testnet ? " — testnet" : ""}`;
    select.appendChild(opt);
  }
  select.value = String(chainId);
}

function initChainSelector(): void {
  const select = $("chain") as HTMLSelectElement;
  populateChains();
  select.addEventListener("change", () => {
    const picked = resolveChain(Number(select.value));
    // An unknown value can only come from a tampered DOM; ignore rather than
    // sign against a chain nothing in the app can name.
    if (!picked) return;
    chainId = picked.id;
    localStorage.setItem(CHAIN_KEY, String(chainId));
    applyChain(picked);
    log(`chain: ${chainLabelDetailed(picked.id).text} (${picked.id})`);
    // Sessions are told, or a connected dapp keeps building transactions for
    // the chain this wallet has just left.
    walletConnect.chainChanged(picked.id);
  });

  /* Choosing an endpoint by hand records it as the preferred one, which is
   * what makes the choice survive a reload and outrank whatever answered last.
   * The user picking who to talk to must beat the app's own bookkeeping. */
  const rpcSelect = $("rpc") as HTMLSelectElement;
  rpcSelect.addEventListener("change", () => {
    const info = activeChain();
    if (!info.rpcUrls.includes(rpcSelect.value)) return;
    rememberRpc(info.id, rpcSelect.value);
    showRpcUsed("No endpoint contacted yet.");
    log(`rpc: first choice is now ${new URL(rpcSelect.value).host}`);
  });

  applyChain(activeChain());
  initCustomChains();
}

/* ------------------------------------------------------- custom networks
 *
 * The escape hatch a curated table can never replace, and the reason the Rust
 * proxy exists: an origin the user types in tomorrow cannot be in an allowlist
 * compiled today. See docs/RPC-ACCESS.md.
 *
 * Validation is entirely core's (`validateCustomChain`) — the same function
 * that re-checks whatever is in storage on the way out — so the form cannot
 * accept something a reload would reject, and a second copy of the rules
 * cannot drift from the first. This file only moves strings.
 */

/** Show the entries that exist, each with the marking and a way to remove it. */
function renderCustomChains(): void {
  const list = $("cclist");
  list.textContent = "";
  const customs = loadCustomChains();
  if (customs.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No networks added.";
    list.appendChild(li);
    return;
  }
  for (const c of customs) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    // Never the bare name: it is the user's word, not anybody's finding.
    label.textContent = `${chainLabelDetailed(c.id).text} — chain ${c.id}, ${c.rpcUrls.length} RPC`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove the custom network ${chainLabelDetailed(c.id).text}, chain ${c.id}`);
    remove.addEventListener("click", () => {
      removeCustomChain(c.id);
      /* Removing the network that is selected must not leave the app signing
       * for a chain it can no longer describe. */
      if (chainId === c.id) {
        chainId = DEFAULT_CHAIN_ID;
        localStorage.setItem(CHAIN_KEY, String(chainId));
        applyChain(activeChain());
      }
      populateChains();
      renderCustomChains();
      log(`removed custom network ${c.id}`);
    });
    li.append(label, remove);
    list.appendChild(li);
  }
}

function initCustomChains(): void {
  $("ccnotice").textContent = CUSTOM_CHAIN_NOTICE;
  renderCustomChains();

  $("ccadd").addEventListener("click", () => {
    const errors = $("ccerrors");
    errors.textContent = "";
    const input: CustomChainInput = {
      id: Number(($("ccid") as HTMLInputElement).value.trim()),
      name: ($("ccname") as HTMLInputElement).value,
      nativeCurrency: {
        name: ($("ccurname") as HTMLInputElement).value,
        symbol: ($("ccursym") as HTMLInputElement).value,
        decimals: Number(($("ccurdec") as HTMLInputElement).value.trim()),
      },
      rpcUrls: ($("ccrpcs") as HTMLTextAreaElement).value
        .split("\n").map((s) => s.trim()).filter((s) => s.length > 0),
      explorerUrl: ($("ccexplorer") as HTMLInputElement).value.trim(),
      testnet: ($("cctestnet") as HTMLInputElement).checked,
    };

    const result = addCustomChain(input);
    if (!result.ok) {
      // Every objection at once: a form that reveals them one at a time is one
      // people abandon in favour of pasting an RPC into a browser.
      for (const message of result.errors) {
        const li = document.createElement("li");
        li.textContent = message;
        errors.appendChild(li);
      }
      return;
    }
    populateChains();
    renderCustomChains();
    log(`added custom network ${result.chain.id} (${result.chain.name}) — unverified`);
  });
}

/* --------------------------------------------------------------- balances
 *
 * What the app can and cannot say about a balance (T63).
 *
 * *Can*: "this is the number a public RPC operator gave me at 14:02, and here
 * is which operator." Every figure on this panel is that, and the line under
 * it says so. The device has no idea what any of these balances are — it holds
 * keys, not state — so nothing here is attested by anything.
 *
 * *Cannot*: "you have 5 USDC." `decimals()` and `symbol()` are answered by the
 * contract, so scaling raw units into a friendly figure applies numbers
 * supplied by the thing under suspicion (PROTOCOL.md 6d). Hence the shape core
 * enforces: raw units and the contract address are always drawn, and a scaled
 * figure only ever appears inside a block that carries UNVERIFIED and the
 * notice. Nothing in this file constructs a scaled string itself.
 *
 * Refresh: on connect, on wallet change, on chain change, on address change,
 * after a broadcast, and on the button — never on a timer. Each fetch tells an
 * operator which address the user cares about, and a background poll would
 * turn that one disclosure into a log of when this window is open. What *is*
 * on a timer is the age label, which costs nothing and is what keeps a
 * ten-minute-old figure from reading as current.
 */

/** Watched token contracts, per chain. Addresses only: nothing else is known. */
const TOKENS_KEY = "leek.tokens.v1";

function readWatched(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOKENS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string[]>;
  } catch {
    return {};
  }
}

/**
 * The tokens being watched on a chain.
 *
 * Re-validated on the way out of storage, like custom chains: anything that
 * ever gets script into this origin can write here, and an address that is not
 * an address would end up in calldata.
 */
function watchedTokens(chain: number): string[] {
  const list = readWatched()[String(chain)];
  if (!Array.isArray(list)) return [];
  return list.filter((a): a is string => typeof a === "string" && isAddress(a)).map((a) => a.toLowerCase());
}

function writeWatched(chain: number, list: string[]): void {
  const all = readWatched();
  all[String(chain)] = list;
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  } catch {
    /* A watch list that cannot be saved costs re-typing an address. */
  }
}

/** Balances, keyed `chainId:address` for tokens and `chainId:native`. */
const tokenMetaCache = new Map<string, TokenMeta>();
const tokenBalances = new Map<string, { raw: bigint; snapshot: BalanceSnapshot }>();
let nativeBalance: { wei: bigint; snapshot: BalanceSnapshot } | null = null;

const balKey = (chain: number, token: string): string => `${chain}:${token.toLowerCase()}`;

/** True while a fetch is in flight, so the button cannot stack requests. */
let fetchingBalances = false;

/**
 * An `EthRequest` on the active chain, plus a way to name who answered.
 *
 * Built from the same `rpcFor()` the signing path uses, so a balance and a
 * nonce are fetched by the same failover policy from the same operator list —
 * two mechanisms would mean two answers to "who learned my address".
 */
function balanceRequest(info: ChainInfo): { request: EthRequest; host: () => string | undefined } {
  const { failover } = rpcFor(info);
  return {
    request: (args) => failover.request(args),
    host: () => (failover.lastUrl ? new URL(failover.lastUrl).host : undefined),
  };
}

/**
 * Fetch the selected address's balances on the active chain.
 *
 * One address, not ten. Deriving ten addresses is cheap and local; asking an
 * operator about ten is ten disclosures and ten times the rate-limit pressure
 * for a number nine of which nobody is looking at.
 */
async function refreshBalances(reason: string): Promise<void> {
  const address = addresses[selectedIndex];
  if (!address || fetchingBalances) return;
  const info = activeChain();
  const chain = info.id;
  fetchingBalances = true;
  ($("balrefresh") as HTMLButtonElement).disabled = true;
  $("balnative").textContent = "Fetching…";

  const { request, host } = balanceRequest(info);
  try {
    const wei = await fetchNativeBalance(request, address);
    /* The chain may have been changed while this was in flight. Storing the
     * answer against the chain it was asked on, and checking before drawing,
     * is what stops a Sepolia balance appearing under a mainnet heading. */
    nativeBalance = {
      wei,
      snapshot: { chainId: chain, address, fetchedAt: Date.now(), ...(host() ? { endpointHost: host() as string } : {}) },
    };
  } catch (e) {
    nativeBalance = null;
    log(`balance: ${String((e as Error).message ?? e)}`);
  }

  for (const token of watchedTokens(chain)) {
    try {
      const key = balKey(chain, token);
      if (!tokenMetaCache.has(key)) {
        // Metadata is asked for once per contract per session: it does not
        // change, and re-asking is another disclosure for the same answer.
        tokenMetaCache.set(key, await fetchTokenMeta(request, chain, token));
      }
      const raw = await fetchTokenBalance(request, token, address);
      tokenBalances.set(key, {
        raw,
        snapshot: { chainId: chain, address, fetchedAt: Date.now(), ...(host() ? { endpointHost: host() as string } : {}) },
      });
    } catch (e) {
      tokenBalances.delete(balKey(chain, token));
      log(`token ${token.slice(0, 10)}…: ${String((e as Error).message ?? e)}`);
    }
  }

  fetchingBalances = false;
  ($("balrefresh") as HTMLButtonElement).disabled = false;
  log(`balances refreshed (${reason})`);
  renderBalances();
  populateAssets();
}

/** Forget everything fetched. Called when the answers stop applying. */
function clearBalances(): void {
  nativeBalance = null;
  tokenBalances.clear();
  renderBalances();
}

/** Draw one "UNVERIFIED" block for a scaled figure. Never called for raw. */
function scaledRow(scaled: NonNullable<TokenAmountView["scaled"]>): HTMLElement {
  const box = document.createElement("div");
  box.className = "unverified-amount";
  const tag = document.createElement("span");
  tag.className = "unverified-amount__tag";
  tag.textContent = "UNVERIFIED";
  const text = document.createElement("span");
  // The source is named because "the contract said so" and "this app's own
  // short list said so" are different kinds of nothing.
  text.textContent =
    `≈ ${scaled.text} ${scaled.symbol ?? "units"} ` +
    `(${scaled.decimals} decimals, ${scaled.source === "app-hint" ? "from an unchecked list in this app" : "self-declared by the contract"})`;
  box.append(tag, text);
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = scaled.notice;
  box.appendChild(note);
  return box;
}

/** Redraw the whole balance panel from state. No fetching here. */
function renderBalances(): void {
  const info = activeChain();
  const chain = info.id;
  const address = addresses[selectedIndex];
  const now = Date.now();

  const native = $("balnative");
  const prov = $("balprov");
  if (!address) {
    native.textContent = "—";
    prov.textContent = "";
  } else if (nativeBalance && nativeBalance.snapshot.chainId === chain &&
             nativeBalance.snapshot.address === address) {
    // The gas token's decimals come from the chain registry, not from any
    // contract, so this one figure is as good as the registry entry — which
    // for a custom network is whatever the user typed, and says so already.
    native.textContent =
      `${formatUnits(nativeBalance.wei, info.nativeCurrency.decimals)} ${info.nativeCurrency.symbol}`;
    native.dataset["stale"] = String(freshnessOf(nativeBalance.snapshot.fetchedAt, now).stale);
    prov.textContent =
      `Address ${selectedIndex} · ${balanceProvenance(nativeBalance.snapshot, now)}`;
  } else {
    native.textContent = "not fetched";
    delete native.dataset["stale"];
    prov.textContent = `Address ${selectedIndex} · ${BALANCE_SOURCE_NOTICE}`;
  }

  const list = $("tokenlist");
  list.textContent = "";
  const tokens = watchedTokens(chain);
  if (tokens.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No tokens watched on this network.";
    list.appendChild(li);
    return;
  }

  for (const token of tokens) {
    const key = balKey(chain, token);
    const meta = tokenMetaCache.get(key);
    const held = tokenBalances.get(key);
    const li = document.createElement("li");
    li.className = "token";

    /* The contract address is the heading, and it is never replaced by a name.
     * A name here would be the app asserting an identity it cannot check —
     * the exact substitution PROTOCOL.md 6d rules out. */
    const head = document.createElement("div");
    head.className = "token__addr addr";
    head.textContent = chunk(checksumAddress(token.slice(2)));
    li.appendChild(head);

    const amount = document.createElement("div");
    amount.className = "token__amount";
    if (held && held.snapshot.chainId === chain && held.snapshot.address === address) {
      const view: TokenAmountView = describeTokenAmount(token, held.raw, meta);
      amount.textContent = `${view.rawText} raw units`;
      li.appendChild(amount);
      if (view.scaled) li.appendChild(scaledRow(view.scaled));
      const age = document.createElement("p");
      age.className = "muted";
      age.textContent = balanceProvenance(held.snapshot, now);
      li.appendChild(age);
    } else {
      amount.textContent = "not fetched";
      li.appendChild(amount);
    }

    const row = document.createElement("div");
    row.className = "row";
    const send = document.createElement("button");
    send.type = "button";
    send.className = "secondary";
    send.textContent = "Send this token";
    /* "Send this token" is unambiguous on screen, where the row above it is
     * the context, and meaningless in a list of buttons read out one after
     * another. The contract address is the only identity this app is entitled
     * to use, so it is the one that goes in the label. */
    send.setAttribute("aria-label", `Send token at contract ${token}`);
    send.addEventListener("click", () => {
      ($("asset") as HTMLSelectElement).value = token;
      applyAsset();
      $("signpanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "secondary";
    drop.textContent = "Stop watching";
    drop.setAttribute("aria-label", `Stop watching the token at contract ${token}`);
    drop.addEventListener("click", () => {
      writeWatched(chain, watchedTokens(chain).filter((a) => a !== token));
      tokenBalances.delete(key);
      renderBalances();
      populateAssets();
      log(`stopped watching ${token}`);
    });
    row.append(send, drop);
    li.appendChild(row);
    list.appendChild(li);
  }
}

function initBalances(): void {
  $("balrefresh").addEventListener("click", () => void refreshBalances("button"));

  $("tokenadd").addEventListener("click", () => {
    const field = $("tokenaddr") as HTMLInputElement;
    const value = field.value.trim();
    const err = $("tokenerr");
    if (!isAddress(value)) {
      err.textContent = "That is not a 20-byte address. A token is identified by its contract address here — there is no name lookup, because a name is not something this app can check.";
      return;
    }
    const chain = activeChain().id;
    const list = watchedTokens(chain);
    const lower = value.toLowerCase();
    if (list.includes(lower)) {
      err.textContent = "Already watched on this network.";
      return;
    }
    writeWatched(chain, [...list, lower]);
    field.value = "";
    err.textContent = "";
    renderBalances();
    void refreshBalances("token added");
  });

  /* The age label, and only the age label, is on a timer. No request leaves
   * the process here: this is what makes staleness visible without turning
   * the app into a beacon. */
  setInterval(() => {
    if (!$("addrpanel").hidden) renderBalances();
  }, 15000);

  renderBalances();
}

/* ------------------------------------------------- the selected address
 *
 * One address at a time, shown in full, with a QR and the two ways people
 * actually move an address to somewhere else: the clipboard and a share sheet.
 *
 * The QR is drawn here from what the device reported, which makes it a
 * convenience and not evidence — a tampered app could draw anyone's address.
 * The device draws the same address on its own screen, and that is the copy
 * worth checking before receiving anything. The note beside it says so.
 */

/** Renders a QR as an SVG path. No canvas, no raster, scales to any size. */
function qrSvg(text: string): SVGSVGElement {
  /* Error correction M: a receive address on a screen is not a label on a
   * warehouse crate, so the extra redundancy of Q/H buys little, while a
   * smaller matrix stays readable on a phone held at arm's length. Type 0 lets
   * the library pick the smallest version that fits. */
  const qr = qrcodegen(0, "M");
  qr.addData(text);
  qr.make();

  const n = qr.getModuleCount();
  const quiet = 4;               // the spec's mandatory quiet zone
  const size = n + quiet * 2;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", "220");
  svg.setAttribute("height", "220");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${text}`);

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", String(size));
  bg.setAttribute("height", String(size));
  /* White, always, whatever the page theme is doing. A scanner needs the
   * contrast in the right direction and a dark-mode QR is a support ticket. */
  bg.setAttribute("fill", "#ffffff");
  svg.appendChild(bg);

  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.appendChild(path);
  return svg;
}

/** Draw the selected address: full text, QR, and the buttons beside it. */
function drawSelectedAddress(): void {
  const detail = $("addrdetail");
  const address = addresses[selectedIndex];
  if (!address) { detail.hidden = true; return; }

  detail.hidden = false;
  $("addrfull").textContent = chunk(checksumAddress(address.slice(2)));

  const holder = $("addrqr");
  if (!holder.hidden) {
    holder.textContent = "";
    /* The checksummed form is encoded, not the lower-case one: mixed case
     * carries an EIP-55 checksum, so a scanner that validates it can catch a
     * corrupted read. Our own parsePaymentUri does exactly that. */
    holder.appendChild(qrSvg(checksumAddress(address.slice(2))));
  }

  /* derivedAccount, not effectiveAccount(): this line names the path the
   * address above it actually came from. Labelling a rendered address with the
   * account the selector has moved on to is the mislabelling this whole row
   * exists to prevent. */
  $("sfrom").textContent = addressPath(derivedAccount, selectedIndex);
}

/**
 * Say whether the app and the device are looking at the same identity.
 *
 * Silent while they agree — an extra sentence under every selector is a
 * sentence nobody reads by the time it matters. It speaks up only when the app
 * has been pointed somewhere the device is not, because that is the state in
 * which the address on this screen and the address on the device's screen are
 * both correct and different.
 */
function renderAccountHint(): void {
  const hint = $("accounthint");
  if (!lastStatus.unlocked) { hint.textContent = ""; return; }
  const account = effectiveAccount();
  hint.textContent =
    chosenAccount === null || chosenAccount === lastStatus.account
      ? `Account ${account}, the one the device is browsing.`
      : `Account ${account}. The device's own screens are on account ` +
        `${lastStatus.account}, so its address browser will not match this list. ` +
        `Signing still shows the full path on the device — read it.`;
}

/** Reflect the device's account in the follow option, and the choice in the value. */
function renderAccountSelector(): void {
  const select = $("accountsel") as HTMLSelectElement;
  const follow = select.options[0] as HTMLOptionElement;
  follow.textContent = lastStatus.unlocked
    ? `Follow the device (account ${lastStatus.account})`
    : "Follow the device";
  select.value = chosenAccount === null ? "follow" : String(chosenAccount);
  renderAccountHint();
}

function initAccountSelector(): void {
  const select = $("accountsel") as HTMLSelectElement;
  for (let a = 0; a < ACCOUNT_COUNT; a++) {
    const opt = document.createElement("option");
    opt.value = String(a);
    opt.textContent = `Account ${a} — m/44'/60'/${a}'/0/…`;
    select.appendChild(opt);
  }

  select.addEventListener("change", () => {
    const before = effectiveAccount();
    chosenAccount = select.value === "follow" ? null : Number(select.value);
    renderAccountSelector();
    /* Nothing to redo when the number did not move — picking account 3
     * explicitly while the device is on 3 is the same derivation, and throwing
     * ten addresses away to derive the same ten costs seconds on hardware. */
    if (effectiveAccount() === before && derivedAccount === before) return;
    if (!client || !lastStatus.unlocked) return;
    invalidateDerived(`account changed in the app to ${effectiveAccount()}`);
    void loadAddresses();
  });

  renderAccountSelector();
}

function initAddressActions(): void {
  const hint = $("addrshint");

  /* Share is offered only where a share sheet exists. The Android webview has
   * `navigator.share`; WebKitGTK does not, and a Share button that silently
   * copies instead is a button that lied about what it does. Desktop keeps
   * Copy, which is the thing that always works. */
  const canShare = typeof (navigator as { share?: unknown }).share === "function";
  ($("addrshare") as HTMLButtonElement).hidden = !canShare;

  $("addrqrtoggle").addEventListener("click", () => {
    const holder = $("addrqr");
    const note = $("addrqrnote");
    const showing = !holder.hidden;
    holder.hidden = showing;
    note.hidden = showing;
    const toggle = $("addrqrtoggle") as HTMLButtonElement;
    toggle.textContent = showing ? "Show QR code" : "Hide QR code";
    // The label alone does not say whether the thing it controls is open; a
    // screen reader reads that from aria-expanded or not at all.
    toggle.setAttribute("aria-expanded", String(!showing));
    if (!showing) drawSelectedAddress();   // renders now that it is visible
  });

  ($("addrselect") as HTMLSelectElement).addEventListener("change", (e) => {
    const i = Number((e.target as HTMLSelectElement).value);
    if (!Number.isInteger(i) || i < 0 || i >= addresses.length) return;
    selectedIndex = i;
    drawSelectedAddress();
    hint.textContent = "";
    log(`selected address ${i}`);
    /* A different address has different balances, so the ones on screen are
     * now about somebody else. Clear first, fetch second: showing the previous
     * address's figures under the new address, even for a second, is the kind
     * of thing people act on. */
    clearBalances();
    void refreshBalances("address changed");
    walletConnect.accountsChanged();
  });

  $("addrcopy").addEventListener("click", () => {
    const address = addresses[selectedIndex];
    if (!address) return;
    const text = checksumAddress(address.slice(2));
    void navigator.clipboard?.writeText(text).then(
      () => { hint.textContent = `Copied ${text}. Check it against the device before using it.`; },
      () => { hint.textContent = "This window would not let the app write to the clipboard. Select the address above and copy it by hand."; },
    );
  });

  /* `navigator.share` is present in the Android webview and absent in
   * WebKitGTK, so desktop falls back to the clipboard rather than offering a
   * button that does nothing. Checked at click time, not at startup: the
   * capability does not change, but the fallback message should name what
   * actually happened. */
  $("addrshare").addEventListener("click", () => {
    const address = addresses[selectedIndex];
    if (!address) return;
    const text = checksumAddress(address.slice(2));
    const share = (navigator as { share?: (d: { title?: string; text: string }) => Promise<void> }).share;
    if (typeof share !== "function") {
      void navigator.clipboard?.writeText(text).then(
        () => { hint.textContent = "This window has no share sheet, so the address was copied to the clipboard instead."; },
        () => { hint.textContent = "This window has neither a share sheet nor clipboard access. Copy the address above by hand."; },
      );
      return;
    }
    void share.call(navigator, { title: "My Ethereum address", text })
      .then(() => { hint.textContent = "Shared."; })
      .catch((e: unknown) => {
        // A dismissed share sheet rejects; that is not an error worth shouting.
        const name = (e as { name?: string })?.name;
        hint.textContent = name === "AbortError" ? "" : `Share failed: ${String((e as Error).message ?? e)}`;
      });
  });
}

/* ------------------------------------------------------- token discovery
 *
 * Finding a token you already hold, without typing its contract address.
 *
 * The list is a convenience for *locating* an address, never evidence about
 * one. Every row that comes out of it is `verified: false`, the address stays
 * the heading, and a symbol is only ever shown beside its disclaimer — the
 * same rule the watched-token panel already follows.
 *
 * One Multicall3 call per chunk rather than one eth_call per token: a few
 * hundred separate requests would be a few hundred disclosures to the operator
 * and a rate-limit failure on any public endpoint. It is also the difference
 * between this feature being usable and being a progress bar.
 */

const TOKEN_LIST_STORE = "leekwallet.tokenList.v1";

/** Bundled snapshot, with any user-refreshed list overlaid. Rebuilt on update. */
let tokenIndex: TokenIndex = buildTokenIndex([BUNDLED_TOKENS]);

function loadStoredTokenList(): void {
  try {
    const raw = localStorage.getItem(TOKEN_LIST_STORE);
    if (!raw) return;
    const stored = JSON.parse(raw) as { tokens?: unknown };
    if (!Array.isArray(stored.tokens)) return;
    /* Re-validated on the way in, not trusted because it is ours: what is in
     * local storage was fetched from a third party, and a stored copy is just
     * an old copy of somebody else's file. */
    const parsed = refreshTokenListSync(stored);
    if (parsed) tokenIndex = buildTokenIndex([parsed, BUNDLED_TOKENS]);
  } catch {
    // A corrupt or foreign entry is ignored; the bundled snapshot still works.
  }
}

/** `refreshTokenList` without the promise, for the synchronous load path. */
function refreshTokenListSync(document: unknown): readonly TokenHint[] | undefined {
  try {
    return parseTokenList(document, { chainIds: allChains().map((c) => c.id) }).tokens;
  } catch {
    return undefined;
  }
}

async function discoverTokens(): Promise<void> {
  const note = $("tokendiscovernote");
  const list = $("tokenfound");
  const button = $("tokendiscover") as HTMLButtonElement;
  const address = addresses[selectedIndex];
  if (!address) { note.textContent = "No address is selected."; return; }

  const info = activeChain();
  const candidates = tokenIndex.forChain(info.id);
  list.textContent = "";
  if (candidates.length === 0) {
    note.textContent =
      `The token list has no entries for chain ${info.id}. Add a contract address by hand above.`;
    return;
  }

  button.disabled = true;
  note.textContent =
    `Asking one contract call for ${candidates.length} balances on chain ${info.id}… ` +
    `This tells the RPC operator which address you are asking about.`;

  try {
    const { request } = balanceRequest(info);
    const results = await fetchTokenBalancesBatched(
      request, info.id, address, candidates.map((t) => t.address),
    );
    const held = results.filter((r) => r.ok && r.raw > 0n);
    const failed = results.filter((r) => !r.ok).length;

    if (held.length === 0) {
      note.textContent =
        `No balance found in any of the ${candidates.length} listed contracts on chain ${info.id}` +
        (failed ? ` (${failed} did not answer)` : "") + `. ${TOKEN_LIST_NOTICE}`;
      return;
    }

    for (const result of held) {
      if (!result.ok) continue;
      const hint = tokenIndex.lookup(info.id, result.token);
      const li = document.createElement("li");
      li.className = "token";

      // The address is the heading here too. A list membership is not a name.
      const head = document.createElement("div");
      head.className = "token__addr addr";
      head.textContent = chunk(checksumAddress(result.token.slice(2)));
      li.appendChild(head);

      const view = describeTokenAmount(
        result.token,
        result.raw,
        hint ? { address: result.token, chainId: info.id, symbol: hint.symbol, decimals: hint.decimals, source: "app-hint", verified: false } : undefined,
      );
      const amount = document.createElement("div");
      amount.className = "token__amount";
      amount.textContent = `${view.rawText} raw units`;
      li.appendChild(amount);
      if (view.scaled) li.appendChild(scaledRow(view.scaled));

      const watch = document.createElement("button");
      watch.type = "button";
      watch.className = "secondary";
      const already = watchedTokens(info.id).includes(result.token);
      watch.textContent = already ? "Already watched" : "Watch and send";
      watch.setAttribute("aria-label",
        `${already ? "Already watching" : "Watch and send"} the token at contract ${result.token}`);
      watch.disabled = already;
      watch.addEventListener("click", () => {
        writeWatched(info.id, [...watchedTokens(info.id), result.token]);
        renderBalances();
        populateAssets();
        ($("asset") as HTMLSelectElement).value = result.token;
        applyAsset();
        watch.textContent = "Already watched";
        watch.disabled = true;
        log(`watching ${result.token} (found by list)`);
      });
      const row = document.createElement("div");
      row.className = "row";
      row.append(watch);
      li.appendChild(row);
      list.appendChild(li);
    }

    note.textContent =
      `${held.length} of ${candidates.length} listed contracts returned a balance` +
      (failed ? `; ${failed} did not answer` : "") + `. ${TOKEN_LIST_NOTICE}`;
  } catch (e) {
    note.textContent = `Could not check balances: ${String((e as Error).message ?? e)}`;
  } finally {
    button.disabled = false;
  }
}

/**
 * Fetch the published lists and replace the stored overlay.
 *
 * Opt-in, and never on a timer: asking for a token list tells that server this
 * app is running and roughly when. The bundled snapshot is what makes that a
 * choice rather than a requirement.
 */
async function updateTokenList(): Promise<void> {
  const note = $("tokendiscovernote");
  const button = $("tokenlistupdate") as HTMLButtonElement;
  button.disabled = true;
  note.textContent = `Fetching ${TOKEN_LIST_URLS.length} token lists…`;

  try {
    const chainIds = allChains().map((c) => c.id);
    const merged: TokenHint[] = [];
    const problems: string[] = [];
    for (const { url } of TOKEN_LIST_URLS) {
      try {
        const parsed = await refreshTokenList(async () => {
          const response = await fetch(url, { redirect: "follow" });
          if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
          return await response.json();
        }, { chainIds });
        merged.push(...parsed.tokens);
      } catch (e) {
        problems.push(`${new URL(url).host}: ${String((e as Error).message ?? e)}`);
      }
    }

    if (merged.length === 0) {
      note.textContent =
        `No list could be fetched, so nothing changed — the bundled snapshot is still in use. ` +
        problems.join("; ");
      return;
    }

    localStorage.setItem(TOKEN_LIST_STORE, JSON.stringify({ tokens: merged }));
    tokenIndex = buildTokenIndex([merged, BUNDLED_TOKENS]);
    note.textContent =
      `Token list updated: ${merged.length} entries across ${new Set(merged.map((t) => t.chainId)).size} chains. ` +
      (problems.length ? `Some sources failed (${problems.join("; ")}). ` : "") +
      TOKEN_LIST_NOTICE;
    log(`token list updated (${merged.length} entries)`);
  } catch (e) {
    note.textContent = `Could not update the token list: ${String((e as Error).message ?? e)}`;
  } finally {
    button.disabled = false;
  }
}

function initTokenDiscovery(): void {
  loadStoredTokenList();
  $("tokendiscover").addEventListener("click", () => void discoverTokens());
  $("tokenlistupdate").addEventListener("click", () => void updateTokenList());
}

/* ------------------------------------------------- scanning a recipient
 *
 * The same camera and the same scanner the wc: pairing panel uses; only the
 * parser differs. Scanning is worth having here for a reason specific to
 * addresses: a pasted or retyped address is checked by a human comparing forty
 * hex characters, which is the step people skip. `parsePaymentUri` rejects a
 * mixed-case address whose EIP-55 checksum does not match, so a misread code is
 * refused rather than silently becoming a different valid-looking address.
 *
 * Nothing found in a code is acted on except the recipient. A chain id or an
 * amount is reported and left for the user to apply: silently switching the
 * network or overwriting a typed amount because a QR code said so would make
 * the code, rather than the person, the one deciding where money goes.
 */

let toScan: QrScan | null = null;
let toScanAbort: AbortController | null = null;

const TO_TYPE_INSTEAD = "Type or paste the recipient address instead.";

function stopToScan(): void {
  toScanAbort?.abort();
  toScanAbort = null;
  toScan?.stop();
  toScan = null;
  $("tovideo").hidden = true;
  ($("toscanstop") as HTMLButtonElement).hidden = true;
  /* The button stays "Scan QR" whether the camera is on or off, so pressed
   * state is the only thing that tells a screen-reader user which it is —
   * and whether a camera is running is not a detail to leave unsaid. */
  $("toscan").setAttribute("aria-pressed", "false");
}

function initToScanner(): void {
  const hint = $("toscanhint");
  const button = $("toscan") as HTMLButtonElement;

  if (!qrScanningAvailable()) {
    button.disabled = true;
    hint.textContent = qrUnavailable(TO_TYPE_INSTEAD);
    return;
  }

  $("toscanstop").addEventListener("click", () => {
    stopToScan();
    hint.textContent = "Camera stopped.";
  });

  button.addEventListener("click", () => {
    if (toScan) { stopToScan(); hint.textContent = "Camera stopped."; return; }

    const video = $("tovideo") as HTMLVideoElement;
    video.hidden = false;
    ($("toscanstop") as HTMLButtonElement).hidden = false;
    button.setAttribute("aria-pressed", "true");
    hint.textContent = "Point the camera at an address QR code.";

    /* The abort handle exists before the camera does, so dismissing this while
     * the permission prompt is still up releases the camera when the prompt is
     * finally answered. Without it that window leaks the camera for the life
     * of the page. */
    const controller = new AbortController();
    toScanAbort = controller;

    void scanQr(
      video,
      // Only something that parses as a payment ends the scan; an unrelated
      // code in shot is ignored rather than pasted into the recipient field.
      (raw) => { const r = parsePaymentUri(raw); return r.ok ? r.payment : undefined; },
      (payment) => {
        toScan = null;
        stopToScan();
        ($("to") as HTMLInputElement).value = payment.recipient;

        const extra: string[] = [];
        if (payment.kind === "token-transfer") {
          extra.push(
            `The code asked for a transfer of token ${payment.token}. ` +
            `Select that token above if you meant to send it — the recipient has been filled in, nothing else has.`,
          );
          if (payment.amount !== undefined) extra.push(`It also named ${payment.amount} raw units.`);
        } else if (payment.kind === "native" && payment.value !== undefined) {
          extra.push(`The code also named an amount of ${payment.value} wei. It has not been filled in.`);
        }
        if ("chainId" in payment && payment.chainId !== undefined && payment.chainId !== activeChain().id) {
          extra.push(
            `The code names chain ${payment.chainId}, but this app is set to chain ${activeChain().id}. ` +
            `Nothing was switched — change the network yourself if that is what you meant.`,
          );
        }
        hint.textContent = `Scanned ${payment.recipient}. ${extra.join(" ")}`.trim();
        log(`scanned recipient ${payment.recipient}`);
        renderPreview();
      },
      (message) => {
        toScan = null;
        stopToScan();
        hint.textContent = `Camera: ${message}`;
      },
      controller.signal,
      (status) => log(`scan: ${status}`),
    )
      .then((handle) => {
        toScan = handle;
        log(`camera ${handle.resolution.width}x${handle.resolution.height} focus=${handle.resolution.focusMode || "unreported"}`);
      })
      .catch((e: unknown) => {
        stopToScan();
        hint.textContent = `Camera: ${(e as Error).message ?? String(e)}`;
      });
  });
}

/* ----------------------------------------------------------- the Max button
 *
 * "Send everything" is the one amount a user cannot compute themselves, and
 * getting it wrong is expensive in both directions: too high and the
 * transaction cannot be included, too low and the remainder is stranded.
 *
 * The arithmetic lives in core (`maxSendableNative`/`maxSendableToken`) so the
 * boundary cases are tested without a network. This function's only job is to
 * fetch honest inputs and render what comes back.
 */

/**
 * Gas for a token transfer when the recipient is not yet known.
 *
 * `estimateGas` needs a `to`, so a Max pressed before the address is filled in
 * has nothing to estimate against. This figure is only ever used for the
 * "can you afford the gas" warning — the token amount itself is the whole
 * balance either way — and it is deliberately on the high side, because the
 * failure it guards against is telling someone they can afford a transfer they
 * cannot.
 */
const TOKEN_TRANSFER_GAS_FALLBACK = 100_000n;

async function fillMaxAmount(): Promise<void> {
  const note = $("maxnote");
  const button = $("amountmax") as HTMLButtonElement;
  const address = addresses[selectedIndex] as Address | undefined;
  if (!address) { note.textContent = "No address is selected."; return; }

  const info = activeChain();
  const asset = currentAsset();
  button.disabled = true;
  note.textContent = "Asking the network for the current fee…";

  try {
    const { chain: viemDef, transport } = rpcFor(info);
    const rpc = createPublicClient({ chain: viemDef, transport });
    const { request } = balanceRequest(info);

    /* Fetched fresh rather than read from the balance panel: that figure may
     * be minutes old, and "everything" computed from a stale balance is a
     * transaction that fails at the node for a reason the user cannot see. */
    const fees = await rpc.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? 30_000_000_000n;
    const native = await fetchNativeBalance(request, address);

    if (asset.kind === "native") {
      const result = maxSendableNative(native, { gasLimit: 21_000n, maxFeePerGas });
      if (result.kind === "insufficient-for-gas") {
        note.textContent =
          `This address cannot cover the fee. It holds ${formatUnits(result.balance, info.nativeCurrency.decimals)} ` +
          `${info.nativeCurrency.symbol}, and the reserve alone is ` +
          `${formatUnits(result.required, info.nativeCurrency.decimals)}. ${MAX_SENDABLE_NOTICE}`;
        return;
      }
      ($("amount") as HTMLInputElement).value = formatUnits(result.amount, info.nativeCurrency.decimals);
      note.textContent =
        (result.zero
          ? `The balance covers the fee and nothing more, so the maximum is zero. `
          : ``) +
        `Reserved ${formatUnits(result.reserved, info.nativeCurrency.decimals)} ${info.nativeCurrency.symbol} for gas ` +
        `(21000 × ${maxFeePerGas} wei). ${MAX_SENDABLE_NOTICE}`;
      renderAmountNote();
      renderPreview();
      return;
    }

    // A token: the whole balance is sendable, but the gas is paid in the
    // native token, so the interesting question is whether that is affordable.
    const key = balKey(info.id, asset.address);
    const raw = await fetchTokenBalance(request, asset.address, address);
    tokenBalances.set(key, { raw, snapshot: { chainId: info.id, address, fetchedAt: Date.now() } });

    const to = ($("to") as HTMLInputElement).value.trim();
    let gasLimit = TOKEN_TRANSFER_GAS_FALLBACK;
    let estimated = false;
    if (isAddress(to)) {
      try {
        gasLimit = await rpc.estimateGas({
          account: address,
          to: asset.address as Address,
          data: encodeErc20Transfer(to, raw) as Hex,
        });
        estimated = true;
      } catch {
        // A revert here usually means the transfer itself would fail. The Max
        // figure is still the balance; only the affordability note is weaker.
        gasLimit = TOKEN_TRANSFER_GAS_FALLBACK;
      }
    }

    const result = maxSendableToken(raw, native, { gasLimit, maxFeePerGas });
    if (result.kind !== "sendable") {
      note.textContent = `${result.reason} ${MAX_SENDABLE_NOTICE}`;
      return;
    }

    const decimals = asset.meta?.decimals;
    const unit = ($("amountunit") as HTMLSelectElement).value;
    ($("amount") as HTMLInputElement).value =
      unit === "scaled" && decimals !== undefined ? formatUnits(result.amount, decimals) : result.amount.toString();

    const affordability = result.cannotAffordGas
      ? `You hold this token but not enough ${info.nativeCurrency.symbol} to pay the gas to move it ` +
        `(needs about ${formatUnits(result.reserved, info.nativeCurrency.decimals)}).`
      : `Gas is paid in ${info.nativeCurrency.symbol} and is not deducted from the token amount.`;
    note.textContent =
      `${affordability} Fee estimated with a gas limit of ${gasLimit}` +
      `${estimated ? "" : " (a default — fill in the recipient for a real estimate)"}. ${MAX_SENDABLE_NOTICE}`;
    renderAmountNote();
    renderPreview();
  } catch (e) {
    note.textContent = `Could not work out a maximum: ${String((e as Error).message ?? e)}`;
  } finally {
    button.disabled = false;
  }
}

function initMaxAmount(): void {
  $("amountmax").addEventListener("click", () => void fillMaxAmount());
}

/* ------------------------------------------------------------ what to send
 *
 * Native value, or an ERC-20 `transfer(address,uint256)`. The token path is
 * worth having because the device already decodes that selector and draws the
 * recipient and the raw amount on its own screen (eth-decode.ts) — so it is a
 * send the user can actually verify, unlike an arbitrary call.
 */

type Asset =
  | { kind: "native" }
  | { kind: "token"; address: string; meta: TokenMeta | undefined };

function currentAsset(): Asset {
  const value = ($("asset") as HTMLSelectElement).value;
  if (value === "native" || !isAddress(value)) return { kind: "native" };
  const key = balKey(activeChain().id, value);
  return { kind: "token", address: value.toLowerCase(), meta: tokenMetaCache.get(key) };
}

/** Rebuild the asset list: the gas token, then whatever is watched here. */
function populateAssets(): void {
  const select = $("asset") as HTMLSelectElement;
  const previous = select.value;
  const info = activeChain();
  select.textContent = "";

  const nativeOpt = document.createElement("option");
  nativeOpt.value = "native";
  nativeOpt.textContent = `${info.nativeCurrency.symbol} (this network's gas token)`;
  select.appendChild(nativeOpt);

  for (const token of watchedTokens(info.id)) {
    const opt = document.createElement("option");
    opt.value = token;
    const meta = tokenMetaCache.get(balKey(info.id, token));
    // The address is in the label, always. A symbol may join it, in question
    // marks, never in place of it.
    opt.textContent = meta?.symbol
      ? `${meta.symbol}? (UNVERIFIED) — ${token.slice(0, 10)}…${token.slice(-4)}`
      : `token ${token.slice(0, 10)}…${token.slice(-4)}`;
    select.appendChild(opt);
  }
  select.value = Array.from(select.options).some((o) => o.value === previous) ? previous : "native";
  applyAsset();
}

/**
 * Re-label the amount field for whatever asset is selected.
 *
 * The unit choice is the honest part. A token's scaled unit exists only
 * because a contract claimed a decimals value, so "raw units" stays a
 * first-class option rather than a hidden one, and the note under the field
 * spells out the multiplication at the moment the number is typed.
 */
function applyAsset(): void {
  const asset = currentAsset();
  const unitField = $("unitfield");
  const unit = $("amountunit") as HTMLSelectElement;
  const info = activeChain();

  if (asset.kind === "native") {
    unitField.hidden = true;
    $("amountlabel").textContent = `Amount (${info.nativeCurrency.symbol})`;
    $("assetnote").textContent =
      `Sending the gas token of chain ${info.id}. Its ticker and decimals come from this app's chain registry, not from any contract.`;
    renderAmountNote();
    renderPreview();
    return;
  }

  const decimals = asset.meta?.decimals;
  const previous = unit.value;
  unit.textContent = "";
  if (decimals !== undefined) {
    const scaled = document.createElement("option");
    scaled.value = "scaled";
    scaled.textContent = `${asset.meta?.symbol ?? "token"}? — UNVERIFIED, ×10^${decimals}`;
    unit.appendChild(scaled);
  }
  const rawOpt = document.createElement("option");
  rawOpt.value = "raw";
  rawOpt.textContent = "raw units (exactly what the device shows)";
  unit.appendChild(rawOpt);
  unit.value = Array.from(unit.options).some((o) => o.value === previous) ? previous : (decimals !== undefined ? "scaled" : "raw");
  unitField.hidden = false;

  $("amountlabel").textContent = "Amount";
  $("assetnote").textContent =
    `ERC-20 transfer on contract ${checksumAddress(asset.address.slice(2))}. ` +
    (decimals === undefined
      ? "This contract did not answer decimals() or symbol(), so amounts are in raw units only."
      : "This app asked the contract what it calls itself and how many decimals it uses; a contract can answer whatever it likes, so neither is checked.");
  renderAmountNote();
  renderPreview();
}

/**
 * Say what the typed number will become, under the field, as it is typed.
 *
 * The conversion is the claim nobody can verify, so it is stated where the
 * claim is made rather than in a notice further down the page that a hurried
 * person scrolls past.
 */
function renderAmountNote(): void {
  const note = $("amountnote");
  const asset = currentAsset();
  const text = ($("amount") as HTMLInputElement).value.trim();
  if (asset.kind === "native") {
    note.textContent = "";
    return;
  }
  const unit = ($("amountunit") as HTMLSelectElement).value;
  const decimals = asset.meta?.decimals;
  if (unit === "raw" || decimals === undefined) {
    note.textContent =
      "Raw units — no conversion, and this is the number the device will show on its own screen.";
    return;
  }
  let raw: bigint | undefined;
  try {
    raw = parseUnits(text, decimals);
  } catch (e) {
    note.textContent = String((e as Error).message ?? e);
    return;
  }
  note.textContent =
    `${text} × 10^${decimals} = ${raw} raw units, which is what the device will show. ` +
    `The 10^${decimals} comes from the contract's own decimals(), which nothing checked — ` +
    `if it lied, you are sending a different amount than you think. ${TOKEN_SCALE_NOTICE}`;
}

/** What the form currently describes, or an error naming the field at fault. */
type Planned =
  | { ok: true; to: string; value: bigint; data?: string; gas?: bigint }
  | { ok: false; field: "to" | "amount"; message: string };

function plannedSend(): Planned {
  const toValue = ($("to") as HTMLInputElement).value.trim();
  const amountValue = ($("amount") as HTMLInputElement).value.trim();
  if (!isAddress(toValue)) {
    return { ok: false, field: "to", message: "that is not a valid address" };
  }
  const asset = currentAsset();

  if (asset.kind === "native") {
    let value: bigint;
    try {
      value = parseEther(amountValue);
    } catch {
      return { ok: false, field: "amount", message: "that is not a valid amount" };
    }
    return { ok: true, to: toValue, value, gas: 21000n };
  }

  const unit = ($("amountunit") as HTMLSelectElement).value;
  const decimals = asset.meta?.decimals;
  let raw: bigint;
  try {
    raw = unit === "scaled" && decimals !== undefined
      ? parseUnits(amountValue, decimals)
      : parseUnits(amountValue, 0);
  } catch (e) {
    return { ok: false, field: "amount", message: String((e as Error).message ?? e) };
  }
  /* `to` becomes the contract and the recipient moves into calldata — which is
   * exactly what the device decodes and renders, so the screen the user checks
   * still names the person being paid. */
  return { ok: true, to: asset.address, value: 0n, data: encodeErc20Transfer(toValue, raw) };
}

/* ---------------------------------------------------------------- preview */

/**
 * Addresses this wallet has paid before — the basis of the poisoning rule.
 *
 * Local, and only ever written from a send this user actually completed. It is
 * deliberately not a reputation feed: asking a service whether an address is
 * known would hand that service every address the user touches, which
 * docs/ANTI-SCAM.md rules out on privacy grounds, and would make a warning
 * depend on somebody else's uptime.
 *
 * Untrusted on the way back in, like every other value that survives in
 * storage: anything that can write to this origin can write here, and a
 * poisoned history could only ever produce a false *warning*, never suppress a
 * real one, because the rule fires on near-misses and stays quiet on matches.
 * Entries that are not addresses are dropped rather than compared.
 */
const RECIPIENTS_KEY = "leekwallet.recipients.v1";
const MAX_REMEMBERED_RECIPIENTS = 64;

function knownRecipients(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECIPIENTS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));
  } catch {
    return [];
  }
}

function rememberRecipient(address: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  try {
    const seen = knownRecipients().filter((a) => a.toLowerCase() !== address.toLowerCase());
    seen.unshift(address);
    localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(seen.slice(0, MAX_REMEMBERED_RECIPIENTS)));
  } catch {
    /* A history that cannot be saved costs one missed lookalike warning. */
  }
}

/**
 * Everything the pure rules are allowed to look at, gathered in one place.
 *
 * The clock is read here rather than inside the rules so that they stay pure
 * and testable without freezing time — see the header of rules.ts. The token
 * list is the advisory one (`verified: false` by construction), which is
 * enough to raise a warning about a recipient and not enough to suppress one.
 *
 * This wallet's own addresses go in beside the paid ones, because sending to a
 * lookalike of your OWN other account is the same mistake with the same cost.
 */
function ruleContext(
  tx: { to?: string; value?: bigint; data?: string },
  typed?: RuleContext["typed"],
): RuleContext {
  return {
    chainId,
    tx,
    ...(typed !== undefined ? { typed } : {}),
    nowSeconds: Math.floor(Date.now() / 1000),
    knownAddresses: [...knownRecipients(), ...addresses],
    knownTokens: tokenIndex.forChain(chainId).map((t) => t.address),
  };
}

/**
 * Draw the advisory interpretation of whatever is currently in the form.
 *
 * It updates as the user types rather than appearing at the moment they press
 * Sign, so an unlimited approval or a refusal is read while there is still
 * something to do about it. Everything here is host-side and therefore
 * untrustworthy by construction: the notice at the bottom is not decoration,
 * it is the only accurate statement on the card. See PROTOCOL.md 6c.
 */
function renderPreview(fee?: { gas: bigint; maxFeePerGas: bigint }): void {
  const panel = $("preview");

  // An incomplete or unparseable form has nothing worth summarising, and a
  // half-summary of a half-typed address invites reading it as if it were
  // complete. A token amount that will not parse is reported under the field
  // by renderAmountNote, not by a preview of a transaction nobody described.
  const plan = plannedSend();
  if (!plan.ok) {
    panel.hidden = true;
    return;
  }

  /* The same interpreter, whether this is a native send or an ERC-20
   * transfer: for the token case it decodes the calldata this app just built
   * with the decoder that mirrors the firmware, so the preview is reading the
   * bytes rather than being told about them. */
  const view: TxInterpretation = interpretTransaction(
    {
      chainId,
      to: plan.to,
      value: plan.value,
      ...(plan.data !== undefined ? { data: plan.data } : {}),
      ...(fee ? { gas: fee.gas, maxFeePerGas: fee.maxFeePerGas } : {}),
    },
    // Symbol from the chain registry, for descriptor `amount` fields. The
    // descriptor set itself is the bundled one and is never fetched here.
    { nativeSymbol: activeChain().nativeCurrency.symbol },
  );

  renderInterpretation(
    {
      summary: $("psummary"),
      fields: $("pfields"),
      warnings: $("pwarnings"),
      authority: $("pauthority"),
    },
    view,
    activeChain().nativeCurrency.symbol,
    /* Layer A findings, drawn into the same warnings list as the
     * interpreter's own: both are host-side advisory judgements of identical
     * standing, and nothing about either is a safety result. Passed even when
     * empty, because the renderer's closing line has to appear either way —
     * "these rules had no opinion" is the honest reading of an empty list and
     * the UI must not let it read as an all-clear. */
    evaluateRules(ruleContext({
      to: plan.to,
      value: plan.value,
      ...(plan.data !== undefined ? { data: plan.data } : {}),
    })),
  );
  panel.hidden = false;
}

/**
 * Ask the RPC what this transaction would actually do, and say so — including
 * when the answer is that nobody could tell us.
 *
 * Only at signing time, never on every keystroke: a simulation is a request to
 * an operator carrying the whole transaction, and firing one per character
 * typed would disclose a dozen half-formed drafts to buy nothing.
 *
 * Nothing here blocks or gates. A simulation that fails, times out, or lands
 * on an endpoint without `eth_simulateV1` is reported as an absence in the
 * log and the signing run continues — refusing to sign on a missing preview
 * would teach the user that this app decides what is safe, and it does not.
 */
async function logSimulation(
  info: ChainInfo,
  call: { from: string; to?: string; value?: bigint; data?: string },
): Promise<void> {
  const outcome = await simulateTransaction(
    (urls) => new FailoverRpc({ chainId: info.id, rpcUrls: urls, send: rpcSend }),
    { rpcUrls: info.rpcUrls, call },
  );

  if (outcome.kind === "unavailable") {
    // A stated absence, in the log, in words. Never a spinner that stops.
    log(`simulation unavailable: ${outcome.why}`);
    return;
  }
  if (outcome.kind === "reverted") {
    log(`simulation: this transaction would fail on chain — ${outcome.why}`);
    return;
  }
  /* The gas token's units are known without asking anyone: 18 decimals and a
   * symbol from this app's own chain registry, neither of which a contract
   * gets to disagree with. So a native movement is written the way the user
   * thinks about it. A token's are not known here -- the decimals would have
   * to come from the contract, and that is the disclosure and the trust the
   * preview deliberately avoids -- so those stay raw beside their address,
   * which is the same rule the transaction preview already follows. */
  const describe = (t: { amount: bigint; token?: string }): string =>
    t.token
      ? `${t.amount} raw units of ${t.token}`
      : `${formatUnits(t.amount, info.nativeCurrency.decimals)} ${info.nativeCurrency.symbol}`;

  for (const t of outcome.leaving) {
    log(`simulation: LEAVES ${describe(t)} → ${t.to}`);
  }
  for (const t of outcome.arriving) {
    log(`simulation: arrives ${describe(t)} ← ${t.from}`);
  }
  if (outcome.transfers.length === 0) {
    /* Said explicitly rather than left as silence: an empty transfer list is
     * a result ("the node saw no value move") and not the same thing as no
     * simulation, and neither of them means the transaction is harmless. */
    log("simulation: the node saw no value move. That is not a safety result.");
  }
  log(SIMULATION_NOTICE);
}

/**
 * Ask the device to sign.
 *
 * There is deliberately no "simulate rejection" button any more. It worked by
 * swapping the live transport for a mock configured to refuse - and never
 * swapped it back, so every later request went to a fake device while the
 * badge still read "hardware". A control that silently replaces your hardware
 * connection is worse than no control; the rejection path is covered by the
 * mock-device tests, where it belongs.
 */
async function sign(): Promise<void> {
  if (!transport || !client) return;

  $("txresult").textContent = "";

  /* One description of what the form means, shared with the preview. Two would
   * eventually disagree, and the one that mattered would be the one that got
   * signed rather than the one that got shown. */
  const plan = plannedSend();
  for (const id of ["to", "amount"]) $(id).removeAttribute("aria-invalid");
  if (!plan.ok) {
    $(plan.field).setAttribute("aria-invalid", "true");
    log(plan.message);
    return;
  }
  const { to: toValue, value, data } = plan;

  busy(true);
  try {
    const from = addresses[selectedIndex] as Address | undefined;
    if (!from) throw new Error("no address selected");

    /* Chain state comes from a public RPC, which is untrusted like any other
     * host input. A wrong nonce or fee produces a stuck or replaced
     * transaction, not a stolen one - the device still shows what it signs.
     * Worth knowing that this query tells the RPC operator which addresses
     * you are interested in. */
    /* Snapshot the chain for the whole of this signing run. Re-reading the
     * selector after the device has been asked would let a mid-flight change
     * broadcast to a network other than the one that was signed for. */
    const chain = activeChain();
    /* Every endpoint the registry lists for this chain, tried in turn: one
     * operator being down or rate-limiting is the failure people actually hit,
     * and it must not take the chain out. Which one answered is reported next
     * to the selector, because a failover changes who learned the address. */
    const { chain: viemDef, transport, failover } = rpcFor(chain);
    const rpc = createPublicClient({ chain: viemDef, transport });
    log(`fetching nonce and fees via ${new URL(failover.order()[0] as string).host}…`);

    const [nonce, fees] = await Promise.all([
      rpc.getTransactionCount({ address: from }),
      rpc.estimateFeesPerGas(),
    ]);
    const maxFeePerGas = fees.maxFeePerGas ?? 30000000000n;
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1000000000n;

    log(`nonce ${nonce}, max fee ${maxFeePerGas} wei`);

    /* A plain send is always 21000; a token transfer's cost depends on the
     * contract's storage, so it has to be estimated. That estimate is another
     * disclosure to the operator — it hands them the calldata — but the
     * alternative is a guessed limit, and a token transfer that runs out of
     * gas still costs the gas. An estimate that reverts is reported as-is
     * rather than retried: "execution reverted" usually means the balance is
     * not there, which the user needs to read. */
    const gas = plan.gas ?? await rpc.estimateGas({
      account: from,
      to: toValue as Address,
      value,
      ...(data !== undefined ? { data: data as Hex } : {}),
    });

    /* Re-draw the preview now that the fee ceiling is known, and repeat any
     * warnings in the log — the panel can be scrolled off, and an unlimited
     * approval is worth saying twice. Nothing here blocks: refusing to send
     * would only teach the user that the app decides what is safe. */
    renderPreview({ gas, maxFeePerGas });
    for (const w of interpretTransaction({
      chainId: chain.id, to: toValue, value, ...(data !== undefined ? { data } : {}),
    }).warnings) {
      log(`warning: ${w.message}`);
    }
    /* The rule findings alongside them, in the same log, at the same weight.
     * A finding that only ever appeared in a panel the user has scrolled past
     * is a finding that was not shown. */
    for (const f of evaluateRules(ruleContext({
      to: toValue, value, ...(data !== undefined ? { data } : {}),
    }))) {
      log(`finding (${f.severity}): ${f.message}${f.subject ? ` — ${f.subject}` : ""}`);
    }

    /* Awaited rather than fired off: the point of a preview is that it is read
     * before the device is touched, and a result that lands after the user has
     * already pressed approve is decoration. It cannot hang — simulate.ts has
     * its own deadline and every path out of it settles. */
    await logSimulation(chain, {
      from,
      to: toValue,
      value,
      ...(data !== undefined ? { data } : {}),
    });

    /* Before the user is told to walk to the device, not after: a refusal that
     * arrives while someone is already reading the confirmation screen is a
     * refusal they will read as a glitch. */
    const account = signingAccount();

    deviceAttention("check every page on the device, then approve");

    const SIGN_TIMEOUT_MS = 150000;   // the device gives the user 120 s
    const tx = {
      chainId: chain.id,
      nonce,
      to: toValue as Address,
      value,
      ...(data !== undefined ? { data: data as Hex } : {}),
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559" as const,
    };

    const reply = await client.call("signTransaction", {
      index: selectedIndex,
      account,
      chainId: chain.id,
      nonce,
      to: hexBytes(toValue),
      value: weiBytes(value),
      /* The recipient and the amount live in here for a token send. The device
       * decodes this itself and draws them; it is not taking this app's word
       * for what the bytes mean. */
      ...(data !== undefined ? { data: hexBytes(data) } : {}),
      gas: weiBytes(gas),
      maxFeePerGas: weiBytes(maxFeePerGas),
      maxPriorityFeePerGas: weiBytes(maxPriorityFeePerGas),
    }, SIGN_TIMEOUT_MS);

    const r = reply["r"];
    const sv = reply["s"];
    if (!(r instanceof Uint8Array) || !(sv instanceof Uint8Array)) {
      throw new Error("device returned no signature");
    }
    /* Reassemble here rather than on the device: the signature covers the
     * digest the device computed from its own parse, so the serialised form
     * either matches or the network rejects it. */
    /* The device sends yParity directly. Deriving it from a legacy v by
     * masking the low bit inverts the value, which produces a signature that
     * recovers to an address with no funds - a failure that reads as "you
     * are broke" rather than "the signature is wrong". */
    const yParity = reply["yParity"];
    if (yParity !== 0 && yParity !== 1) {
      throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
    }

    const raw = serializeTransaction(tx, { r: toHex(r), s: toHex(sv), yParity });

    log("broadcasting…");
    const hash = await rpc.sendRawTransaction({ serializedTransaction: raw });

    log(`sent: ${hash}`);
    /* Only once it is actually on the wire, and only the address the user was
     * paying: the poisoning rule compares against addresses this person really
     * transacted with, so remembering an abandoned draft would seed the
     * history with an address they never chose. For a token send that is the
     * recipient inside the calldata, not the token contract. */
    rememberRecipient(interpretTransaction({
      chainId: chain.id, to: toValue, value, ...(data !== undefined ? { data } : {}),
    }).recipient ?? toValue);
    $("txresult").innerHTML =
      `Sent. <a href="${chain.explorerUrl}/tx/${hash}" target="_blank" rel="noreferrer">View on explorer</a>`;

    /* Whatever is on screen is now certainly wrong — one of these balances
     * just changed. This is the one automatic refresh in the app, and it is
     * automatic because the user's own action is what invalidated the number.
     * It runs after the broadcast rather than after inclusion, so the figure
     * may still be the pre-transaction one; the age line is what makes that
     * readable rather than misleading. */
    void refreshBalances("after broadcast");
  } catch (e) {
    /* How a signing attempt ended is as much a device event as the request to
     * confirm it was: somebody who was told to walk to the device has to be
     * told what happened when they got there. */
    if (e instanceof DeviceError && e.code === 0x0200) {
      deviceAttention("rejected on the device");
    } else if (e instanceof DeviceError && e.code === 0x0201) {
      deviceAttention("timed out waiting for an answer on the device");
    } else if (e instanceof DeviceError) {
      log(`declined: ${e.message}`);
    } else {
      log(String((e as Error).message ?? e));
    }
  } finally {
    busy(false);
  }
}

/* ----------------------------------------------------- walletconnect bridge
 *
 * The only route from a dapp to the hardware. Everything a dapp can cause is
 * one of the three methods below, which is what makes the question "what can a
 * connected dapp do?" answerable by reading one screen of code.
 *
 * Note what is *not* here: no path that hands the device a pre-built hash, no
 * path that bypasses the device confirmation, and no path that lets a dapp pick
 * an RPC endpoint. The endpoint always comes from the registry, so a dapp
 * cannot use this app as a proxy to an arbitrary host.
 */

/** Minimal-length big-endian bytes, as the wire format wants. */
const weiBytes = (v: bigint): Uint8Array => {
  if (v === 0n) return new Uint8Array(0);
  let hexDigits = v.toString(16);
  if (hexDigits.length % 2) hexDigits = "0" + hexDigits;
  return new Uint8Array((hexDigits.match(/../g) ?? []).map((h) => parseInt(h, 16)));
};

const hexBytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));

const toHex = (b: Uint8Array): Hex =>
  ("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")) as Hex;

/** Index of an address in the derived list, or -1. Case-insensitive. */
function addressIndex(address: string): number {
  const want = address.toLowerCase();
  return addresses.findIndex((a) => a.toLowerCase() === want);
}

/**
 * Reassemble the device's `{r, s, yParity}` into a 65-byte signature.
 *
 * The mock still answers `signMessage` with a flat `{signature}` (divergence 2
 * in PROTOCOL.md 6e is closed for the firmware but not in the mock), so both
 * shapes are accepted rather than letting the app work against one and break
 * against the other.
 */
function signatureFrom(reply: Record<string, CborValue>): Hex {
  const flat = reply["signature"];
  if (flat instanceof Uint8Array && flat.length === 65) return toHex(flat);

  const r = reply["r"];
  const s = reply["s"];
  const yParity = reply["yParity"];
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
    throw new Error("device returned no signature");
  }
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
  }
  // v = 27 + yParity, the encoding every EIP-191 verifier expects.
  return (toHex(r) + toHex(s).slice(2) + (27 + yParity).toString(16)) as Hex;
}

/**
 * Sign a transaction a dapp asked for, and broadcast it if it asked for that.
 *
 * Nonce and fees are filled from the registry's RPC when the dapp left them
 * out. A dapp-supplied nonce or fee is honoured — getting either wrong costs a
 * stuck transaction, not funds, and the device still shows what it signs.
 */
async function signPlannedTransaction(tx: PlannedTx, broadcast: boolean): Promise<string> {
  if (!client) throw new Error("no device connected");
  const index = addressIndex(tx.from);
  if (index < 0) throw new Error("that address is not one this device has derived");
  const account = signingAccount();

  const info = getChain(tx.chainId);
  if (!info) throw new Error(`this wallet has no RPC for chain ${tx.chainId}`);
  // Same failover as the manual path: a dapp-driven signature must not fail
  // because the first-listed operator is having an afternoon.
  const { chain: viemDef, transport, failover } = rpcFor(info);
  const rpc = createPublicClient({ chain: viemDef, transport });

  const from = addresses[index] as Address;
  const nonce = tx.nonce ?? (await rpc.getTransactionCount({ address: from }));

  let maxFeePerGas = tx.maxFeePerGas;
  let maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    const fees = await rpc.estimateFeesPerGas();
    maxFeePerGas = maxFeePerGas ?? fees.maxFeePerGas ?? 30000000000n;
    maxPriorityFeePerGas = maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas ?? 1000000000n;
  }

  /* Estimating is a query to the RPC, which learns what is about to be signed.
   * That is the same disclosure the nonce lookup already makes, and the
   * alternative — guessing a gas limit for arbitrary calldata — produces
   * transactions that revert after spending the gas. */
  const gas = tx.gas ?? (await rpc.estimateGas({
    account: from,
    to: tx.to as Address,
    value: tx.value,
    data: tx.data as Hex,
  }));

  log("check every page on the device, then approve");
  const reply = await client.call("signTransaction", {
    index,
    account,
    chainId: tx.chainId,
    nonce,
    to: hexBytes(tx.to),
    value: weiBytes(tx.value),
    data: hexBytes(tx.data),
    gas: weiBytes(gas),
    maxFeePerGas: weiBytes(maxFeePerGas),
    maxPriorityFeePerGas: weiBytes(maxPriorityFeePerGas),
  }, 150000);

  const r = reply["r"];
  const s = reply["s"];
  const yParity = reply["yParity"];
  if (!(r instanceof Uint8Array) || !(s instanceof Uint8Array)) {
    throw new Error("device returned no signature");
  }
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`device returned yParity ${String(yParity)}, expected 0 or 1`);
  }

  const raw = serializeTransaction(
    {
      chainId: tx.chainId,
      nonce,
      to: tx.to as Address,
      value: tx.value,
      data: tx.data as Hex,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: "eip1559" as const,
    },
    { r: toHex(r), s: toHex(s), yParity },
  );

  if (!broadcast) return raw;
  // `lastUrl` once anything has been asked, the head of the order before that:
  // either way this names the endpoint the broadcast is about to start at, not
  // a stale pick from the selector.
  log(`broadcasting via ${new URL(failover.lastUrl ?? (failover.order()[0] as string)).host}…`);
  return await rpc.sendRawTransaction({ serializedTransaction: raw });
}

/** EIP-191 message signing. The device renders the message and signs its own digest. */
async function signPlannedMessage(address: string, message: string): Promise<string> {
  if (!client) throw new Error("no device connected");
  const index = addressIndex(address);
  if (index < 0) throw new Error("that address is not one this device has derived");
  const reply = await client.call(
    "signMessage",
    { index, account: signingAccount(), message },
    150000,
  );
  return signatureFrom(reply);
}

/**
 * EIP-712 typed data. The device rebuilds the digest from these fields.
 *
 * `request` is what planRequest already transcribed from the dapp's JSON, and
 * it is passed through untouched: re-deriving it here would be a second
 * transcription, and the one the user was shown a preview of is the one that
 * has to reach the device.
 */
async function signPlannedTypedData(
  address: string,
  request: Record<string, unknown>,
): Promise<string> {
  if (!client) throw new Error("no device connected");
  const index = addressIndex(address);
  if (index < 0) throw new Error("that address is not one this device has derived");
  const reply = await client.call(
    "signTypedData",
    /* Which key signs is decided after the spread, never inside it. `request`
     * is transcribed from a dapp's JSON, so an `account` or `index` key
     * arriving in there would otherwise choose the signing path — the one
     * decision on this call that the dapp does not get to make. */
    { ...(request as Record<string, CborValue>), index, account: signingAccount() },
    150000,
  );
  return signatureFrom(reply);
}

/**
 * What the approval editor needs from the chain: the scale, and what is
 * already outstanding.
 *
 * Both readings go out over the same failover client every other query uses,
 * so capping an approval discloses the token and the address to the same
 * operator a balance refresh already would, and to no additional one. Neither
 * answer is trusted: `decimals` decides only how a number is rendered next to
 * the raw units, and the allowance decides only whether a zero step is
 * planned. A lying RPC costs a badly-shaped plan and a revert, never custody —
 * the device still decodes and draws whatever calldata is finally sent.
 */
async function approvalFacts(query: {
  standard: "erc20" | "permit2";
  token: string;
  spender: string;
  chainId: number;
}): Promise<{ decimals?: number; symbol?: string; current?: bigint }> {
  const info = getChain(query.chainId);
  const owner = addresses[selectedIndex];
  if (!info || !owner) return {};
  const { request } = balanceRequest(info);

  const meta = await fetchTokenMeta(request, info.id, query.token).catch(() => undefined);

  /* Read through the same batched path the approvals list uses rather than a
   * bare eth_call, so there is one implementation of "what is the allowance"
   * and one place for it to be wrong. A failed read comes back as absent, and
   * approval-cap.ts is explicit that absent is not zero. */
  const [result] = await fetchAllowances(request, info.id, owner, [
    { token: query.token, spender: query.spender, via: query.standard },
  ]).catch(() => []);

  return {
    ...(meta?.decimals !== undefined ? { decimals: meta.decimals } : {}),
    ...(meta?.symbol !== undefined ? { symbol: meta.symbol } : {}),
    ...(result?.ok ? { current: result.amount } : {}),
  };
}

/**
 * A gas limit for an approval this app re-encoded, chosen rather than
 * estimated.
 *
 * The zero-then-set sequence cannot be estimated: while the old allowance is
 * still standing, `eth_estimateGas` on the second transaction runs against a
 * chain state where a USDT-style `approve` reverts, so the estimate fails and
 * a failed estimate would cancel the very sequence that exists to avoid the
 * revert. An `approve` is one storage write and one event on every ERC-20 in
 * circulation; this is generous for that, and EIP-1559 refunds whatever is not
 * burned, so an over-estimate costs nothing while an under-estimate costs the
 * whole fee for a transaction that runs out.
 */
const APPROVE_GAS_LIMIT = 120000n;

/**
 * Sign a capped approval, one device confirmation per step.
 *
 * The nonces are consecutive and assigned here, which is the reason this is not
 * two ordinary calls to `signPlannedTransaction`: that function reads the nonce
 * from the chain each time, and the second read would land before the first
 * transaction was mined and hand back the same number — the second approval
 * would then *replace* the zero rather than follow it, leaving the allowance at
 * zero and the user believing it was capped. Sent back to back with n and n+1,
 * the ordering is the chain's own and the second executes with the first
 * already applied.
 */
async function signApprovalCap(
  tx: PlannedTx,
  steps: readonly { data: string; label: string }[],
  broadcast: boolean,
): Promise<string> {
  const info = getChain(tx.chainId);
  if (!info) throw new Error(`this wallet has no RPC for chain ${tx.chainId}`);
  const from = addresses[addressIndex(tx.from)];
  if (!from) throw new Error("that address is not one this device has derived");

  const base = tx.nonce ?? await (async () => {
    const { chain: viemDef, transport } = rpcFor(info);
    return createPublicClient({ chain: viemDef, transport })
      .getTransactionCount({ address: from as Address });
  })();

  let last = "";
  for (const [i, step] of steps.entries()) {
    log(`approval cap: ${step.label}`);
    last = await signPlannedTransaction(
      { ...tx, data: step.data, nonce: base + i, gas: APPROVE_GAS_LIMIT },
      broadcast,
    );
  }
  return last;
}

const walletBridge: WalletBridge = {
  // Locked means no accounts, which is what stops a dapp asking for a
  // signature the device could not produce anyway.
  accounts: () => [...addresses],
  /* The device's setting, not the app's opinion of it. Refusing here a call
   * the owner has explicitly allowed on the device would be the app overruling
   * them, invisibly - they would opt in and see the identical refusal. */
  blindSigning: () => deviceBlindSigning,
  chainId: () => chainId,
  setChainId: (id: number) => {
    const picked = getChain(id);
    if (!picked) return;
    chainId = picked.id;
    localStorage.setItem(CHAIN_KEY, String(chainId));
    ($("chain") as HTMLSelectElement).value = String(chainId);
    applyChain(picked);
    log(`chain: ${picked.name} (${picked.id})`);
  },
  signTransaction: signPlannedTransaction,
  approvalFacts,
  signApprovalCap,
  signMessage: signPlannedMessage,
  signTypedData: signPlannedTypedData,
  log,
  announce,
  deviceAttention,
  /* The same local facts the send form's own preview is judged against, so a
   * dapp request and a hand-typed send cannot disagree about whether a
   * recipient is a lookalike. Nothing here is fetched, and nothing leaves. */
  ruleFacts: () => ({
    knownAddresses: [...knownRecipients(), ...addresses],
    knownTokens: tokenIndex.forChain(chainId).map((t) => t.address),
  }),
};

const walletConnect = initWalletConnect(walletBridge);

async function disconnect(): Promise<void> {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastStatus = UNKNOWN_STATUS;
  await transport?.close();
  transport = null;
  client = null;
  setConnection("disconnected", "Disconnected");
  setMode(null);
  // Back to whatever the build allows: a single-option selector stays shut.
  ($("transport") as HTMLSelectElement).disabled =
    ($("transport") as HTMLSelectElement).options.length < 2;
  $("addrpanel").hidden = true;
  $("signpanel").hidden = true;
  $("passpanel").hidden = true;
  $("pairing").hidden = true;
  /* The field holds nothing between calls, but a disconnect is exactly when a
   * half-typed one would otherwise be left sitting in the DOM. */
  ($("passinput") as HTMLInputElement).value = "";
  $("passhint").textContent = "";
  derivedAccount = -1;
  renderAccountSelector();
  $("wallet").textContent = "";
  ($("connect") as HTMLButtonElement).disabled = false;
  ($("unlock") as HTMLButtonElement).disabled = true;
  ($("disconnect") as HTMLButtonElement).disabled = true;
  log("disconnected; session secrets cleared");
}

/* ------------------------------------------------------------------- wiring */

const LINK_NAMES: Record<LinkKind, string> = {
  usb: "USB cable",
  ble: "Bluetooth",
  mock: "Mock device",
};

/**
 * Say what the badge actually knows, and no more.
 *
 * Before a connection it can only report what this build could do; after one
 * it names the live transport. Naming it matters: a user comparing an address
 * against the device screen is checking that the thing on the desk produced
 * it, and "hardware" alone does not say which wire that answer came down.
 */
function setMode(active: Transport | null): void {
  const badge = $("mode");
  if (active) {
    const hardware = active.kind !== "mock";
    badge.textContent = hardware
      ? `hardware · ${active.kind.toUpperCase()}`
      : "mock";
    badge.dataset["mode"] = hardware ? "hardware" : "mock";
    badge.title = hardware
      ? `Connected to real hardware over ${LINK_NAMES[active.kind]}`
      : "Simulated device — nothing here is signed by hardware";
    /* A `title` is a mouse hover and nothing else. Whether the signature you
     * are about to trust came from hardware or from a simulation is the last
     * thing that should be reachable only with a pointer. */
    badge.setAttribute("aria-label", badge.title);
    return;
  }

  const hasHardware = available.length > 0;
  badge.textContent = hasHardware ? "no link" : "mock";
  badge.dataset["mode"] = hasHardware ? "idle" : "mock";
  badge.title = hasHardware
    ? "Not connected. The badge names the transport once a device answers."
    : "This build has no device transport; the mock is the only option";
  badge.setAttribute("aria-label", badge.title);
}

/* Say plainly what this window can talk to, before anything is connected. The
 * label used to read "Connect mock device" unconditionally, so a native window
 * talking to real hardware still claimed to be a simulation. */
async function initEnvironment(): Promise<void> {
  available = await availableTransports();

  const select = $("transport") as HTMLSelectElement;
  select.textContent = "";
  /* The mock is offered only when there is no real transport. On a desktop
   * build it would be an option sitting one mis-click away from the hardware
   * one, and a fake device the user believes is real is worse than no device
   * at all. */
  const kinds: LinkKind[] = available.length > 0 ? [...available] : ["mock"];
  for (const kind of kinds) {
    const opt = document.createElement("option");
    opt.value = kind;
    opt.textContent = LINK_NAMES[kind];
    select.appendChild(opt);
  }
  /* USB first: it is the link the device ships selected, and the one a user
   * with a cable in hand is most likely to want. */
  select.value = kinds[0] as string;
  select.disabled = kinds.length < 2;

  ($("connect") as HTMLButtonElement).textContent =
    available.length > 0 ? "Connect device" : "Connect mock device";

  $("devicehint").textContent = available.length > 0
    ? "Pick the link the device is set to, then Connect. The device serves only one at a time — if it is set to USB it will not appear over Bluetooth, and the reverse. Confirm the passkey on the device when asked."
    /* Reaches a browser tab and an Android window alike, so it cannot name a
     * cause it does not know. What matters is the same either way: nothing
     * here is signed by a device. */
    : "No device transport available, so this uses the built-in mock. It speaks the same protocol as the firmware and the interface behaves identically — but nothing is signed by real hardware, and no address shown here is one you should send funds to.";

  setMode(null);
  ($("connect") as HTMLButtonElement).disabled = false;
}

/**
 * Ask the backend once whether RPC calls can go through it, and say so.
 *
 * The answer decides whether a custom network is offerable at all: without the
 * proxy the request leaves the webview, where the CSP allows only the reviewed
 * origins, and a user-typed endpoint is simply blocked. Saying that in the
 * form beats letting someone fill it in and meet a console error.
 */
async function initRpcTransport(): Promise<void> {
  const resolved = await resolveRpcSend();
  rpcSend = resolved.send;
  viaProxy = resolved.viaProxy;

  const add = $("ccadd") as HTMLButtonElement;
  add.disabled = !viaProxy;
  $("customchainstatus").textContent = viaProxy
    ? "Requests go through this app's backend, so a network you add here is reachable. Whoever you name learns which addresses you ask about."
    : "This build sends RPC requests straight from the window, which may only reach the endpoints reviewed at build time. A network added here could not be contacted, so adding one is switched off.";
}

/* Held shut until the backend has answered. Clicking through an unpopulated
 * selector would read as "mock" and quietly connect to a simulation on a
 * machine that has a device attached. */
($("connect") as HTMLButtonElement).disabled = true;
void initEnvironment();
initChainSelector();
initBalances();
initAddressActions();
initAccountSelector();
initPassphrase();
initTokenDiscovery();
initToScanner();
initMaxAmount();
populateAssets();
void initRpcTransport();

$("connect").addEventListener("click", () => void connect());
$("unlock").addEventListener("click", () => void unlock());
$("disconnect").addEventListener("click", () => void disconnect());
$("sign").addEventListener("click", () => void sign());
$("usenext").addEventListener("click", () => {
  // Sending to your own next address is the safest possible live test.
  const other = addresses[selectedIndex === 0 ? 1 : 0];
  if (other) ($("to") as HTMLInputElement).value = other;
  renderPreview();
});

for (const id of ["to", "amount"]) {
  $(id).addEventListener("input", () => { renderAmountNote(); renderPreview(); });
}
$("asset").addEventListener("change", () => applyAsset());
$("amountunit").addEventListener("change", () => { renderAmountNote(); renderPreview(); });
/* ------------------------------------------------------------------- theme */

/* Three states, not two. "System" has to be reachable, or a user who toggles
 * once can never get back to following their OS. Reading the computed --bg and
 * comparing it to a literal would also break the moment the palette moves. */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "leek.theme";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    delete root.dataset["theme"];
  } else {
    root.dataset["theme"] = theme;
  }
  const btn = $("theme");
  btn.textContent = THEME_ICON[theme];
  btn.setAttribute("aria-label", `Theme: ${theme}. Click to change.`);
  btn.title = `Theme: ${theme}`;
}

function currentTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

applyTheme(currentTheme());

/* ------------------------------------------------------------ diagnostics */

/**
 * Everything a bug report needs, as plain text.
 *
 * Every bug report on this project so far has been the log, hand-copied off a
 * screen. This assembles it with the state that makes it readable — which
 * transport, which chain, which addresses — formatted for a chat box rather
 * than as JSON, because the person reading it is a human and the person
 * sending it is on a phone.
 *
 * ---------------------------------------------------------------------------
 * What it must never contain, and why. This list is a decision, not an
 * oversight, and it is short because the app holds no seed, PIN or key — those
 * never leave the device (PROTOCOL.md 6). What is left is:
 *
 * - **The session passkey.** Excluded. It is the value the user compares
 *   against the device screen to prove the encrypted channel reaches *that*
 *   device and not something in the middle; it is short-lived and it is a
 *   comparison secret. Pasting it into a chat while the session is live hands
 *   it to whoever reads the chat, and its only job is to be compared, never
 *   transmitted. It is also useless in a bug report: what matters is whether
 *   the pairing succeeded, and the log already says that.
 * - **The WalletConnect project ID.** Excluded. It is the user's own relay
 *   credential — attributable and rate-limited against them — and a bug is
 *   never explained by its 32 hex digits. Whether one is configured is worth
 *   knowing, so that is what gets reported.
 * - **The pairing URI / symKey.** Excluded, and already excluded upstream: the
 *   loggable form of a wc: URI never contains the key (see wc-uri.ts and its
 *   test), so the log below cannot carry one.
 * - **Whatever is typed into the form fields.** Excluded. A half-typed
 *   recipient is not state, and the amount someone is about to send is theirs.
 *
 * Included on purpose: **addresses**. They are public by construction — they
 * are what the user hands out to be paid — and "address 3 came back wrong" is
 * precisely the bug this button exists to report. The user agent is included
 * because "which Android" is the first question anyone will ask.
 */
function diagnosticsReport(): string {
  const L: string[] = [];
  const chain = activeChain();
  const rpc = ($("rpc") as HTMLSelectElement).value;

  L.push("LeekWallet companion — diagnostics");
  L.push(new Date().toISOString());
  L.push(`User agent: ${navigator.userAgent}`);
  /* The webview capabilities WalletConnect leans on, because the frontend
   * bundle is byte-identical on both platforms: when a pairing works on the
   * desktop and not on the phone, the difference is here and not in our code.
   * `isSecureContext` gates `crypto.subtle`, and IndexedDB is where the SDK
   * persists pairings -- either one missing is invisible until a session
   * silently fails to arrive. Presence only; nothing is read out. */
  L.push(
    `Webview: origin ${location.origin}, secureContext ${String(window.isSecureContext)}, ` +
      `crypto.subtle ${crypto?.subtle ? "yes" : "NO"}, ` +
      `indexedDB ${typeof indexedDB !== "undefined" && indexedDB !== null ? "yes" : "NO"}, ` +
      `WebSocket ${typeof WebSocket !== "undefined" ? "yes" : "NO"}`,
  );
  L.push("");

  L.push("== Connection");
  L.push(`State:      ${$("conn").textContent ?? "?"}`);
  L.push(`Backend:    ${$("mode").textContent ?? "?"}`);
  L.push(`Link:       ${LINK_NAMES[selectedKind()]} (selected)`);
  L.push(`Transports: ${available.length > 0 ? available.join(", ") : "none — mock only"}`);
  L.push(
    `Device:     ${lastStatus.unlocked ? "unlocked" : "locked"}, ` +
      `wallet ${lastStatus.activeWallet}, ` +
      /* Whether one is applied, never a character of it — the passphrase has
       * no path into this report and must not grow one. The account is here
       * because a report describing the wrong identity's addresses reads as a
       * derivation bug. */
      `passphrase ${lastStatus.passphrase ? "on" : "off"}, ` +
      `account ${lastStatus.account} on device / ` +
      `${chosenAccount === null ? "following" : String(chosenAccount)} in the app, ` +
      `blind signing ${deviceBlindSigning ? "ON" : "off"}`,
  );
  L.push("");

  L.push("== Chain");
  L.push(`${chain.name} (${chain.id})${chain.testnet ? " — testnet" : ""}, ${chain.source}`);
  L.push(`RPC first choice: ${rpc || "none selected"}`);
  // The order, not just the pick: "it worked on the second endpoint" is the
  // kind of thing a bug report needs and nobody remembers to mention.
  L.push(`RPC order: ${activeChainOrder().join(" -> ")}`);
  L.push(`RPC last reached: ${$("rpcused").textContent ?? "?"}`);
  // Which path the request took decides what it could reach at all, so a bug
  // report saying "my network does not work" is unreadable without it.
  L.push(`RPC path: ${viaProxy ? "backend proxy" : "webview fetch (CSP-bound)"}`);
  L.push(`Custom networks: ${loadCustomChains().length}`);
  L.push("");

  L.push("== Addresses");
  if (addresses.length === 0) {
    L.push("None derived. (Device locked, or not connected.)");
  } else {
    // Unchunked, so the line pastes straight into an explorer. The chunked
    // form is for comparing against the device screen, which is a different
    // job done by a different surface.
    addresses.forEach((a, i) => L.push(`${i === selectedIndex ? ">" : " "} [${i}] ${a}`));
    /* -1 is the sentinel for "these addresses are no longer known to be
     * valid" -- set when the wallet, passphrase or account changes. Rendering
     * it into the path produced `m/44'/60'/-1'/0/i`, which is not a path any
     * BIP-44 wallet can derive, in a report meant to be pasted into a bug
     * thread. The honest line is that the list is stale. */
    L.push(
      derivedAccount < 0
        ? "Derivation: unknown — these addresses are stale, reconnect to re-derive"
        : `Derivation: ${addressPath(derivedAccount, 0).slice(0, -1)}i`,
    );
  }
  L.push("");

  L.push("== Dapps (WalletConnect)");
  /* Presence, never the value — and read through the module that owns the key
   * so this cannot start reporting on a key nothing writes any more. */
  L.push(`Project ID: ${resolveProjectId().source} (value withheld)`);
  L.push($("wcstatus").textContent || "(no status)");
  /* Read back from the rendered list rather than from the WalletConnect client:
   * what the user is reporting is what they are looking at, and a second source
   * for the same list could disagree with the screen. Dapp-authored names come
   * through as text and stay text. */
  const sessions = Array.from($("wcsessions").querySelectorAll(".wc-session"))
    .map((row) =>
      Array.from(row.children)
        .filter((el) => el.tagName !== "BUTTON")
        .map((el) => el.textContent?.trim() ?? "")
        .filter((s) => s.length > 0)
        .join(" · "),
    );
  L.push(sessions.length > 0 ? sessions.map((s) => `- ${s}`).join("\n") : "No dapp is connected.");
  L.push("");

  L.push("== Device log (newest first)");
  L.push($("log").textContent ?? "");

  return L.join("\n");
}

type CopyRoute = "tauri" | "async-clipboard" | "exec-command" | "manual";

/**
 * Put text on the clipboard, trying every route this app can reach.
 *
 * There are three because none of them works everywhere:
 *
 * 1. **Tauri's clipboard plugin**, if the native build has it. It is the only
 *    route that is unambiguously correct inside an Android webview. NOTE: as
 *    of this commit `src-tauri/capabilities/default.json` grants only
 *    `core:default`, so the plugin is *not* registered and this probe will
 *    miss; it is written first anyway so that adding the plugin on the Rust
 *    side is the only change needed to light it up.
 * 2. **`navigator.clipboard`**, which requires a secure context. A Tauri
 *    Android window is served from `http://tauri.localhost`, which is not one
 *    of the origins browsers treat as secure, so this may well be undefined
 *    there. It is the right answer on desktop and in a dev browser tab.
 * 3. **`document.execCommand("copy")`** over a hidden textarea. Deprecated,
 *    and still the thing that actually works in an Android webview under a
 *    user gesture — which a button click is.
 *
 * If all three fail the text is put on screen, selected, and the caller says
 * so. A copy button that silently does nothing is worse than no button: the
 * user pastes stale clipboard content and nobody finds out for an hour.
 */
async function copyText(text: string): Promise<CopyRoute> {
  const tauri = (window as unknown as {
    __TAURI__?: { clipboardManager?: { writeText?: (t: string) => Promise<void> } };
  }).__TAURI__?.clipboardManager?.writeText;
  if (tauri) {
    try {
      await tauri(text);
      return "tauri";
    } catch { /* fall through: a failed plugin call is not a reason to give up */ }
  }

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return "async-clipboard";
    } catch { /* permission denied or no gesture; try the old way */ }
  }

  /* The textarea has to be in the document, visible to the layout engine and
   * focused for the selection to be real, so it is placed off-screen rather
   * than hidden — `display: none` cannot be selected. */
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return "exec-command";
  } catch { /* fall through to manual */ }

  const out = $("copyout") as HTMLTextAreaElement;
  out.value = text;
  out.hidden = false;
  out.focus();
  out.select();
  return "manual";
}

$("copydiag").addEventListener("click", () => {
  const text = diagnosticsReport();
  const out = $("copyout") as HTMLTextAreaElement;
  out.hidden = true;
  const status = $("copystatus");
  status.textContent = "Copying…";

  void copyText(text).then(
    (route) => {
      const lines = text.split("\n").length;
      status.textContent =
        route === "manual"
          ? "This build could not reach the clipboard. The text is below and selected — copy it by hand."
          : `Copied ${lines} lines (${route}). No passkey, passphrase, project ID or form input is included.`;
      log(`diagnostics copied via ${route}`);
    },
    (e: unknown) => {
      status.textContent = `Copy failed: ${(e as Error).message}`;
      log(`diagnostics copy failed: ${(e as Error).message}`);
    },
  );
});

$("theme").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length] ?? "system";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  log(`theme: ${next}`);
});
