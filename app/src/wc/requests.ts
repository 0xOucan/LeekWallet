/**
 * Dapp request → what this wallet will actually do (T32).
 *
 * This is the whole trust boundary of WalletConnect support, in one pure
 * function. Everything arriving here was written by a dapp — the amounts, the
 * addresses, the calldata, and any friendly description that came with it. None
 * of it is believed. What comes out is a *plan*: either an answer this app can
 * give from its own state, a signing job described in terms the device will be
 * asked to confirm, or a refusal with a code the dapp understands.
 *
 * Three rules the shape enforces:
 *
 * 1. **No dapp-supplied prose reaches the user as fact.** The summary shown on
 *    the pending-request card is `interpretTransaction`'s, the same advisory
 *    preview the app draws for its own send form, carrying the same
 *    `ADVISORY_NOTICE`. A dapp cannot inject a sentence into it. See
 *    PROTOCOL.md 6c.
 * 2. **Refusals happen here, not after the walk to the device.** If the device
 *    would answer `0x0202` — calldata outside the decodable set, contract
 *    creation, a message it cannot render — the plan is a refusal and the dapp
 *    is told immediately. Sending the user to press a button that will not
 *    appear is a worse experience than an honest no (PROTOCOL.md 6bis).
 * 3. **Every branch terminates.** There is no fall-through that leaves a
 *    request unanswered; the default case is an explicit refusal.
 *
 * Pure: no network, no clock, no DOM. Tested directly.
 */

import { resolveChainForDapp } from "./chain-view.ts";
import {
  checksumAddress, interpretTransaction, type TxInterpretation,
} from "../../packages/core/src/tx-interpret.ts";
import {
  describeTypedData, inspectTypedData, toDeviceTypedData,
} from "../../packages/core/src/eip712.ts";
import type { CborValue } from "../../packages/core/src/cbor.ts";
import {
  deviceCannotDisplay, invalidParams, unrecognisedChain, unsupportedMethod,
  UNAUTHORIZED_ACCOUNT, type JsonRpcErrorBody,
} from "./errors.ts";

/** What the app knows that the dapp does not get to decide. */
export interface WalletContext {
  /** Addresses this wallet has offered, any casing. Empty means locked. */
  accounts: readonly string[];
  /** The chain the session is currently on. */
  chainId: number;
  /**
   * Whether the DEVICE has blind signing switched on, as reported by
   * `getFeatures`.
   *
   * The app must not refuse a call the device would accept. The hatch is a
   * setting on the device, turned on by its owner with five deliberate
   * presses; refusing here anyway would mean the app silently overruling that
   * decision, and the owner would see the same refusal after opting in and
   * have no way to tell which layer said no. It happened.
   *
   * This never makes the app more permissive than the device: the device
   * re-checks and still refuses contract creation, oversized calldata and
   * unrenderable messages whatever this says.
   */
  blindSigning?: boolean;
}

/** A transaction as the device will be asked to sign it. Amounts are bigint. */
export interface PlannedTx {
  from: string;
  /** Absent means contract creation, which never reaches here — it is refused. */
  to: string;
  value: bigint;
  data: string;
  chainId: number;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
}

export type RequestPlan =
  /** Answerable from app state alone; no device round trip. */
  | { kind: "answer"; result: unknown }
  | {
      kind: "transaction";
      /** eth_sendTransaction broadcasts; eth_signTransaction returns the raw tx. */
      broadcast: boolean;
      tx: PlannedTx;
      /** Advisory, drawn by this app. Never a verdict. */
      interpretation: TxInterpretation;
    }
  | { kind: "message"; address: string; message: string }
  | {
      kind: "typed-data";
      address: string;
      /** The request as the device parses it, already transcribed from JSON. */
      request: Record<string, unknown>;
      /** What the device's own screens will say, for the pending-request card. */
      summary: string;
      /** The dapp's document, verbatim, for the card's detail view. */
      document: Record<string, unknown>;
    }
  | { kind: "switch-chain"; chainId: number }
  | { kind: "error"; error: JsonRpcErrorBody };

/**
 * The EVM methods this wallet advertises in its session namespace.
 *
 * `eth_signTypedData_v4` is here as of T12b: the device has a `signTypedData`
 * command, it recomputes the digest from the structure the dapp sent, and it
 * refuses anything it could not put on its screen. Advertising it is honest in
 * a way it was not before — a dapp picks typed data over `personal_sign` on the
 * strength of this list, and until the device could sign one that choice led
 * nowhere.
 *
 * The older spellings stay off the list and are still refused by name below.
 */
export const SUPPORTED_METHODS: readonly string[] = [
  "eth_accounts",
  "eth_chainId",
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_signTypedData_v4",
  "personal_sign",
  "wallet_switchEthereumChain",
] as const;

/** Session events this wallet emits. Both are things the user can cause. */
export const SUPPORTED_EVENTS: readonly string[] = ["chainChanged", "accountsChanged"] as const;

/* The device's message screen: six rows of twenty characters, printable ASCII
 * only. Mirrored from PROTOCOL.md 6e rather than guessed, because being *more*
 * permissive here means promising the dapp a signature the device then refuses. */
const MAX_MESSAGE_BYTES = 120;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** `eip155:1` → 1. Undefined for anything that is not an EVM CAIP-2 id. */
export function parseCaip2ChainId(caip2: string): number | undefined {
  const [namespace, reference] = caip2.split(":");
  if (namespace !== "eip155" || reference === undefined || !/^\d+$/.test(reference)) {
    return undefined;
  }
  return Number(reference);
}

/** `0x…` or decimal string or number → bigint. Undefined when unparseable. */
function toBigInt(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  try {
    // BigInt() accepts "0x…" and decimal, and throws on anything else — which
    // is the validation, not a shortcut around it.
    const n = BigInt(s);
    return n >= 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

const isHexAddress = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Case-insensitive membership, returning the checksummed form we will show. */
function authorised(accounts: readonly string[], address: string): string | undefined {
  const want = address.toLowerCase();
  const hit = accounts.find((a) => a.toLowerCase() === want);
  return hit === undefined ? undefined : checksumAddress(hit.slice(2));
}

/**
 * Hex-encoded UTF-8 → text. `personal_sign` sends hex in practice, but plenty
 * of dapps send a bare string, and rejecting those would be pedantry that
 * breaks real sites.
 */
function decodeMessage(raw: string): string | undefined {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(raw)) return raw;
  const bytes = new Uint8Array((raw.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not text at all. Signing it would be signing bytes nobody read.
    return undefined;
  }
}

/**
 * Plan a dapp request.
 *
 * `method` and `params` are untrusted input; `ctx` is what this app knows.
 */
export function planRequest(
  method: string,
  params: unknown,
  ctx: WalletContext,
): RequestPlan {
  const args = Array.isArray(params) ? params : [];

  switch (method) {
    case "eth_accounts":
      return { kind: "answer", result: ctx.accounts.map((a) => checksumAddress(a.slice(2))) };

    case "eth_chainId":
      return { kind: "answer", result: `0x${ctx.chainId.toString(16)}` };

    case "personal_sign":
      return planMessage(args, ctx);

    /* eth_sign is "sign these 32 bytes", the original blind-signing footgun.
     * The device refuses hashes unless blind signing is explicitly enabled, and
     * this app does not offer a route to it over a relay. */
    case "eth_sign":
      return {
        kind: "error",
        error: unsupportedMethod(
          "eth_sign",
          "it signs an opaque hash, which is the blind signing this wallet exists to avoid. Ask for personal_sign instead.",
        ),
      };

    case "eth_signTypedData_v4":
      return planTypedData(args, ctx);

    /* v1 and v3 stay refused, and the reasons are different for each.
     *
     * v1 is not a typed-data document at all: it is an array of
     * {name, type, value} triples with no domain, so there is no
     * verifyingContract and no chainId — nothing binding the signature to a
     * contract or a network. The device's typed-data screen leads with exactly
     * those two facts and would have nothing true to put there.
     *
     * v3 is v4 without nested structs or arrays, and every dapp that speaks it
     * speaks v4. Accepting it would mean a second encoding to get right for no
     * dapp that needs it, and a wrong one produces a valid signature over a
     * document nobody wrote.
     *
     * Refusing by name means the dapp can fall back rather than hang. */
    case "eth_signTypedData":
    case "eth_signTypedData_v3":
      return {
        kind: "error",
        error: unsupportedMethod(
          method,
          method === "eth_signTypedData_v3"
            ? "this wallet signs eth_signTypedData_v4 only — ask for that instead."
            : "the v1 form carries no domain, so the device cannot show which contract or chain the signature is for. Ask for eth_signTypedData_v4.",
        ),
      };

    case "eth_sendTransaction":
      return planTransaction(args, ctx, true);

    case "eth_signTransaction":
      return planTransaction(args, ctx, false);

    case "wallet_switchEthereumChain": {
      const first = args[0] as { chainId?: unknown } | undefined;
      const requested = toBigInt(first?.chainId);
      if (requested === undefined) return { kind: "error", error: invalidParams("no chainId given.") };
      const id = Number(requested);
      /* An unknown id is refused rather than accepted as a bare number. This
       * app has to name the network in the preview, and a chain it cannot name
       * is one it cannot warn about (PROTOCOL.md 6d). */
      if (!resolveChainForDapp(id)) return { kind: "error", error: unrecognisedChain(id) };
      return { kind: "switch-chain", chainId: id };
    }

    /* Refused on purpose. Adding a chain means taking a chain id, a name and an
     * RPC URL from the dapp — the network name in every later preview would
     * then be dapp-supplied text presented as fact, and the RPC would be a host
     * outside the CSP allowlist. Chains belong in the registry, reviewed. */
    case "wallet_addEthereumChain":
      return {
        kind: "error",
        error: unsupportedMethod(
          "wallet_addEthereumChain",
          "chains come from this wallet's own reviewed list, not from a dapp. Networks are added by updating the app.",
        ),
      };

    default:
      return {
        kind: "error",
        error: unsupportedMethod(method, "this wallet serves only the standard EVM signing methods."),
      };
  }
}

function planMessage(args: unknown[], ctx: WalletContext): RequestPlan {
  /* Argument order is [message, address] per the spec, but a long tail of
   * dapps sends them the other way round, so pick by shape. Guessing here is
   * safe in a way that guessing about amounts is not: whichever one is an
   * address is checked against the authorised list either way. */
  const [a, b] = args;
  const address = isHexAddress(a) ? a : isHexAddress(b) ? b : undefined;
  const raw = isHexAddress(a) ? b : a;

  if (address === undefined || typeof raw !== "string") {
    return { kind: "error", error: invalidParams("personal_sign needs a message and an address.") };
  }

  const from = authorised(ctx.accounts, address);
  if (from === undefined) return { kind: "error", error: UNAUTHORIZED_ACCOUNT };

  const message = decodeMessage(raw);
  if (message === undefined) {
    return {
      kind: "error",
      error: deviceCannotDisplay("the message is not text, so there is nothing to put on the screen."),
    };
  }

  /* Refused here, before the user walks to the device, which would answer
   * 0x0202 for exactly these two reasons. */
  const bytes = new TextEncoder().encode(message).length;
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      kind: "error",
      error: deviceCannotDisplay(
        `the message is ${bytes} bytes and the device screen holds ${MAX_MESSAGE_BYTES}.`,
      ),
    };
  }
  if (!PRINTABLE_ASCII.test(message)) {
    return {
      kind: "error",
      error: deviceCannotDisplay(
        "the message contains characters the device screen cannot render (it shows printable ASCII only).",
      ),
    };
  }

  return { kind: "message", address: from, message };
}

/**
 * Plan an `eth_signTypedData_v4`.
 *
 * Two conversions and one prediction. The document is transcribed into the
 * device's wire encoding driven by its own declared types, then run through the
 * same inspection the firmware performs, so a structure the device would refuse
 * is refused here — before the user walks over to press a button that will not
 * appear (PROTOCOL.md 6bis).
 *
 * The prediction can only ever refuse what the device refuses, never more: the
 * unrenderable case is reopened by `ctx.blindSigning`, exactly as protocol.c
 * reopens it, because that setting belongs to the device's owner and an app
 * that overruled it would produce an identical refusal after they opted in.
 */
function planTypedData(args: unknown[], ctx: WalletContext): RequestPlan {
  /* [address, document] per the spec, and the document arrives as a JSON
   * string from about half of the dapps that send one. */
  const [a, b] = args;
  const address = isHexAddress(a) ? a : isHexAddress(b) ? b : undefined;
  const raw = isHexAddress(a) ? b : a;
  if (address === undefined) {
    return { kind: "error", error: invalidParams("eth_signTypedData_v4 needs an address.") };
  }

  const from = authorised(ctx.accounts, address);
  if (from === undefined) return { kind: "error", error: UNAUTHORIZED_ACCOUNT };

  let document: unknown = raw;
  if (typeof raw === "string") {
    try {
      document = JSON.parse(raw);
    } catch {
      return { kind: "error", error: invalidParams("the typed data is not valid JSON.") };
    }
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { kind: "error", error: invalidParams("the typed data is not an object.") };
  }

  let request: Record<string, CborValue>;
  try {
    request = toDeviceTypedData(document);
  } catch (e) {
    /* A document this app could not transcribe faithfully is one the device
     * would hash differently from what the dapp meant, so it is refused rather
     * than approximated. */
    return {
      kind: "error",
      error: invalidParams(e instanceof Error ? e.message : "the typed data cannot be read."),
    };
  }

  const verdict = inspectTypedData(request);
  if (verdict.kind === "malformed") {
    return { kind: "error", error: invalidParams(verdict.why) };
  }
  if (verdict.kind === "unhashable") {
    return {
      kind: "error",
      error: deviceCannotDisplay(
        `${verdict.why} — the device computes the digest itself and will not take one from this app.`,
      ),
    };
  }
  if (verdict.kind === "unrenderable" && !ctx.blindSigning) {
    return { kind: "error", error: deviceCannotDisplay(verdict.why) };
  }

  const summary = verdict.kind === "ok"
    ? describeTypedData(verdict.render)
    : `${verdict.render.primaryType} — the device cannot show this in full`;

  return {
    kind: "typed-data",
    address: from,
    request: request as Record<string, unknown>,
    summary,
    document: document as Record<string, unknown>,
  };
}

function planTransaction(args: unknown[], ctx: WalletContext, broadcast: boolean): RequestPlan {
  const tx = args[0] as Record<string, unknown> | undefined;
  if (!tx || typeof tx !== "object") {
    return { kind: "error", error: invalidParams("no transaction object.") };
  }

  if (!isHexAddress(tx["from"])) {
    return { kind: "error", error: invalidParams("the transaction has no `from` address.") };
  }
  const from = authorised(ctx.accounts, tx["from"]);
  if (from === undefined) return { kind: "error", error: UNAUTHORIZED_ACCOUNT };

  /* A dapp may name a chain other than the session's. Honouring it silently is
   * how a signature meant for a testnet ends up valid on mainnet, so a
   * mismatch with a chain we do not know is refused, and one we do know is
   * carried into the interpretation where the preview names it out loud. */
  const declared = tx["chainId"] === undefined ? undefined : toBigInt(tx["chainId"]);
  if (tx["chainId"] !== undefined && declared === undefined) {
    return { kind: "error", error: invalidParams("the transaction's chainId is not a number.") };
  }
  const chainId = declared === undefined ? ctx.chainId : Number(declared);
  const chain = resolveChainForDapp(chainId);
  if (!chain) return { kind: "error", error: unrecognisedChain(chainId) };

  const data = typeof tx["data"] === "string" ? tx["data"] : "0x";
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    return { kind: "error", error: invalidParams("`data` is not an even-length hex string.") };
  }

  const value = tx["value"] === undefined ? 0n : toBigInt(tx["value"]);
  if (value === undefined) return { kind: "error", error: invalidParams("`value` is not a number.") };

  const to = tx["to"];
  const interpretation = interpretTransaction({
    chainId,
    ...(isHexAddress(to) ? { to } : {}),
    value,
    data,
    ...(toBigInt(tx["gas"]) !== undefined ? { gas: toBigInt(tx["gas"]) } : {}),
    ...(toBigInt(tx["maxFeePerGas"]) !== undefined
      ? { maxFeePerGas: toBigInt(tx["maxFeePerGas"]) }
      : {}),
    ...(toBigInt(tx["gasPrice"]) !== undefined ? { gasPrice: toBigInt(tx["gasPrice"]) } : {}),
  }, {
    /* The gas-token ticker comes from the chain registry, never from the dapp
     * — it is the one string in the descriptor block this app is entitled to
     * put there. Descriptors themselves come from the bundled registry subset
     * (the default), so no dapp can supply one either. */
    nativeSymbol: chain.nativeCurrency.symbol,
  });

  /* The one place the interpretation is allowed to decide something. It is
   * still not a safety judgement — `deviceWillRefuse` mirrors the firmware's
   * own decodable set, so this is predicting a refusal, not making one. */
  if (interpretation.deviceWillRefuse && !ctx.blindSigning) {
    const why = interpretation.warnings.find((w) => w.code === "device-will-refuse");

    /* Name the selector that was refused.
     *
     * "Outside the decodable set" tells the user nothing they can act on and
     * tells us nothing about what to support next. The first four bytes are
     * the function being called, so a refusal that quotes them turns "this
     * dapp does not work" into a specific, answerable question. It costs one
     * line and it is how the set grows from evidence rather than guesswork. */
    const selector =
      typeof data === "string" && data.length >= 10 ? data.slice(0, 10) : undefined;
    const detail = selector
      ? `${why?.message ?? "it is outside the decodable set."} (function selector ${selector})`
      : (why?.message ?? "it is outside the decodable set.");
    return { kind: "error", error: deviceCannotDisplay(detail) };
  }
  if (!isHexAddress(to)) {
    // Unreachable via deviceWillRefuse above, but the type needs it and a
    // second guard costs nothing next to a contract creation slipping through.
    return { kind: "error", error: deviceCannotDisplay("there is no recipient to name.") };
  }

  const planned: PlannedTx = { from, to, value, data, chainId };
  const gas = toBigInt(tx["gas"]);
  if (gas !== undefined) planned.gas = gas;
  const maxFee = toBigInt(tx["maxFeePerGas"]) ?? toBigInt(tx["gasPrice"]);
  if (maxFee !== undefined) planned.maxFeePerGas = maxFee;
  const priority = toBigInt(tx["maxPriorityFeePerGas"]);
  if (priority !== undefined) planned.maxPriorityFeePerGas = priority;
  const nonce = toBigInt(tx["nonce"]);
  if (nonce !== undefined) planned.nonce = Number(nonce);

  return { kind: "transaction", broadcast, tx: planned, interpretation };
}
