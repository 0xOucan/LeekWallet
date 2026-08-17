/**
 * `eth_simulateV1`: what leaves, what arrives — asked of the node the user
 * already chose.
 *
 * This is the "pre-sign panel" other wallets buy from a third-party scanner.
 * Buying it would mean telling a stranger every address this user is about to
 * touch, which docs/ANTI-SCAM.md rules out on privacy grounds. `eth_simulateV1`
 * is a standard execution-api method (Geth 1.14+), so the same answer comes
 * from the endpoint that is already going to see the transaction anyway. It
 * discloses nothing new.
 *
 * `scripts/check-rpc-simulate.mjs` is the evidence this is buildable: 29 of 53
 * registry endpoints answer it, every publicnode one does — and those are the
 * first choice on most chains — while drpc's free tier paywalls it and one
 * endpoint returns -32601. That spread is the whole design problem, and it is
 * why this file is mostly about the absent case rather than the working one.
 *
 * ---------------------------------------------------------------------------
 * Four rules, each of which was a mistake available to make
 *
 * 1. **It goes through rpc.ts, as a plain JSON-RPC call.** Not through viem's
 *    client, transport or `simulateBlocks`. viem would open its own connection:
 *    straight past the Rust proxy, straight past the CSP allowlist the proxy
 *    exists to widen, past the failover list, and past the deadline in
 *    `withDeadline`. viem is used here for nothing at all; encode/decode is
 *    hand-rolled below against bounds-checked bytes, the same posture
 *    multicall.ts takes with attacker-supplied return data.
 *
 * 2. **`validation: false`.** A wallet previews a transaction *before* its fee
 *    fields are final — that is the point of previewing. With validation on,
 *    the node rejects the call for "max fee per gas less than block base fee"
 *    and the user is told nothing about what the transaction would do. The
 *    probe script's header records this exact discovery.
 *
 * 3. **Capability is detected per endpoint and cached.** -32601 and a paywall
 *    message both mean "this operator cannot serve you"; they are not errors
 *    about the transaction. Both mark the endpoint and fall through to the
 *    next. Without the cache, every preview on a chain whose preferred
 *    endpoint cannot simulate pays a full round trip to learn the same thing
 *    again, on every keystroke.
 *
 * 4. **An endpoint that cannot simulate produces a STATED ABSENCE.** Never a
 *    spinner. `{ kind: "unavailable", why }` is a value the UI has to render,
 *    with a sentence saying simulation did not happen — because this project
 *    lost a week to a hang that looked like silence (see `withDeadline` in
 *    rpc.ts, which exists because of it). Every path out of this module
 *    settles: there is an outer deadline around the whole attempt, so a
 *    transport that forgets its own still costs one slow preview and not the
 *    session.
 *
 * And the framing that outranks all four: a simulation is a *convenience*. It
 * runs on an untrusted host against an answer from an untrusted operator, and
 * it must never gate, weaken or substitute for what the device decides. A
 * simulation that shows nothing alarming is not a safety result, and there is
 * no value in this file that says one.
 */

import { checksumAddress } from "./tx-interpret.ts";

/* ------------------------------------------------------------------ shapes */

/** The transaction to preview. Fee fields deliberately absent: validation is off. */
export interface SimulationCall {
  from: string;
  /** Absent means contract creation, which the device refuses anyway. */
  to?: string | undefined;
  value?: bigint | undefined;
  data?: string | undefined;
}

/** One movement of value the simulation produced. */
export interface SimulatedTransfer {
  /**
   * Native coin or a token. `traceTransfers` reports native movements as
   * synthetic ERC-20 `Transfer` logs from the zero address, so this is derived
   * from the log's emitting contract — a classification, where the addresses
   * and the amount below are what the node actually said.
   */
  asset: "native" | "token";
  /** The token contract, for `asset: "token"`. EIP-55 checksummed. */
  token?: string;
  from: string;
  to: string;
  /** Raw units. Decimals are not knowable here, and are never guessed. */
  amount: bigint;
}

export type SimulationOutcome =
  /** It ran. `transfers` may legitimately be empty — that is not "nothing happens". */
  | {
      kind: "ok";
      /** Which operator answered. The UI names it: it learned the transaction. */
      endpoint?: string;
      transfers: SimulatedTransfer[];
      /** Transfers away from `call.from`. */
      leaving: SimulatedTransfer[];
      /** Transfers towards `call.from`. */
      arriving: SimulatedTransfer[];
      gasUsed?: bigint;
    }
  /** It ran and the transaction would fail. Information, not a scare. */
  | { kind: "reverted"; endpoint?: string; why: string }
  /**
   * It did not run. The UI must SAY so — this is the stated absence, and the
   * whole reason the union has three arms instead of two.
   */
  | { kind: "unavailable"; why: string };

/**
 * A client that can send one JSON-RPC call. `FailoverRpc` satisfies it.
 *
 * Structural rather than a concrete import so the tests drive this with a
 * plain object and no network, and so nothing here can reach into failover
 * policy that belongs to rpc.ts.
 */
export interface SimulatorRpc {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  /** The endpoint that most recently answered, if the client tracks one. */
  lastUrl?: string | undefined;
}

/** Builds a client bound to exactly these endpoints, in this order. */
export type SimulatorFactory = (urls: readonly string[]) => SimulatorRpc;

/* ------------------------------------------------------- capability cache */

/**
 * Endpoints known not to serve `eth_simulateV1`, and why.
 *
 * Deliberately negative-only and in memory only. Negative-only because a
 * method that worked once can be withdrawn on the next plan change, and a
 * cached "yes" would turn that into a confusing failure rather than a fresh
 * attempt. In memory only because persisting it would let anything that can
 * write to storage mark every endpoint unsupported and quietly delete the
 * feature — a small thing to lose, but lost silently, which is the part that
 * matters.
 */
const unsupported = new Map<string, string>();

/** Why this endpoint was written off, or undefined if it has not been. */
export const simulationUnsupportedReason = (url: string): string | undefined =>
  unsupported.get(url);

export function markSimulationUnsupported(url: string, why: string): void {
  if (!unsupported.has(url)) unsupported.set(url, why);
}

/** For tests, and for a settings screen that wants to try everything again. */
export const resetSimulationCapability = (): void => { unsupported.clear(); };

/**
 * "This operator cannot serve you", as opposed to "your transaction fails".
 *
 * The same classification `scripts/check-rpc-simulate.mjs` makes, and it has to
 * stay the same: the probe's header records that the first version of that
 * script read "intrinsic gas too high" as a refusal, when it is in fact proof
 * the method ran. Getting this backwards here would either write off working
 * endpoints or retry a missing method on every one of them in turn.
 */
export function isCapabilityRefusal(code: number, message: string): boolean {
  if (code === -32601) return true;
  return /does not exist|method not found|not supported|not available|free plan|upgrade to paid|payment required/i
    .test(message);
}

/* ----------------------------------------------------------- the RPC shape */

const hexQuantity = (n: bigint): string => `0x${n.toString(16)}`;

/**
 * The params for one call in one block.
 *
 * No `gas`, no fee fields, and `validation: false` beside them — see rule 2 in
 * the header. `traceTransfers` is the entire reason for the call: without it
 * the result is a return value and a gas number, which is not something a user
 * can read as "what leaves and what arrives".
 */
export function simulateParams(call: SimulationCall): unknown[] {
  const inner: Record<string, unknown> = { from: call.from.toLowerCase() };
  if (call.to !== undefined) inner["to"] = call.to.toLowerCase();
  inner["value"] = hexQuantity(call.value ?? 0n);
  if (call.data !== undefined && call.data !== "0x") inner["input"] = call.data;
  return [
    {
      blockStateCalls: [{ calls: [inner] }],
      validation: false,
      traceTransfers: true,
    },
    "latest",
  ];
}

/* -------------------------------------------------------------- decoding */

/** keccak256("Transfer(address,address,uint256)"), the only topic read here. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A topic word carrying a left-padded address, or undefined if it is not one. */
function addressFromTopic(topic: unknown): string | undefined {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined;
  // Non-zero padding means the word is not an address. Reading the low twenty
  // bytes anyway would invent a party to a transfer that never had one — the
  // same refusal eth-decode.ts makes about ABI address arguments.
  if (!/^0x0{24}/.test(topic)) return undefined;
  return checksumAddress(topic.slice(26));
}

/** The `data` field of a Transfer log: exactly one uint256, or nothing usable. */
function amountFromData(data: unknown): bigint | undefined {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return undefined;
  return BigInt(data);
}

/**
 * Transfers out of one call's logs.
 *
 * Skips anything it cannot read completely rather than half-reading it. A log
 * whose topics do not decode is a log this app has nothing true to say about,
 * and a transfer rendered with a missing party or a guessed amount would be
 * worse than a shorter list — the user is reading this to answer "does more
 * leave than I expect", and a wrong row answers it wrongly.
 */
export function transfersFromLogs(logs: unknown): SimulatedTransfer[] {
  if (!Array.isArray(logs)) return [];
  const out: SimulatedTransfer[] = [];
  for (const entry of logs) {
    if (!isRecord(entry)) continue;
    const topics = entry["topics"];
    if (!Array.isArray(topics) || topics.length < 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;

    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    const amount = amountFromData(entry["data"]);
    if (from === undefined || to === undefined || amount === undefined) continue;

    const emitter = typeof entry["address"] === "string" ? entry["address"] : "";
    /* Native movements arrive as synthetic Transfer logs attributed to the
     * zero address. Everything else is a real contract's own event. */
    const native = emitter === "" || emitter.toLowerCase() === ZERO_ADDRESS;
    out.push(
      native
        ? { asset: "native", from, to, amount }
        : { asset: "token", token: checksumAddress(emitter.slice(2)), from, to, amount },
    );
  }
  return out;
}

/** The one call result inside the one block, or a reason there is none. */
function readOutcome(result: unknown, from: string, endpoint?: string): SimulationOutcome {
  if (!Array.isArray(result) || result.length === 0) {
    return { kind: "unavailable", why: "the node answered eth_simulateV1 with nothing this app can read" };
  }
  const block = result[0];
  const calls = isRecord(block) ? block["calls"] : undefined;
  if (!Array.isArray(calls) || calls.length === 0) {
    return { kind: "unavailable", why: "the simulation came back without a result for the call" };
  }
  const call = calls[0];
  if (!isRecord(call)) {
    return { kind: "unavailable", why: "the simulation result is not an object" };
  }

  /* status is a quantity: 0x1 succeeded, 0x0 reverted. A missing status is
   * treated as unavailable rather than as success, because "it worked" is the
   * one thing this module must never assume on incomplete evidence. */
  const status = call["status"];
  if (typeof status !== "string") {
    return { kind: "unavailable", why: "the simulation result has no status" };
  }
  if (BigInt(status) === 0n) {
    const error = call["error"];
    const why = isRecord(error) && typeof error["message"] === "string"
      ? error["message"]
      : "the transaction would fail on chain";
    return { kind: "reverted", ...(endpoint !== undefined ? { endpoint } : {}), why };
  }

  const transfers = transfersFromLogs(call["logs"]);
  const me = from.toLowerCase();
  const gas = call["gasUsed"];
  return {
    kind: "ok",
    ...(endpoint !== undefined ? { endpoint } : {}),
    transfers,
    leaving: transfers.filter((t) => t.from.toLowerCase() === me),
    arriving: transfers.filter((t) => t.to.toLowerCase() === me),
    ...(typeof gas === "string" ? { gasUsed: BigInt(gas) } : {}),
  };
}

/* ------------------------------------------------------------ the attempt */

/** How long the whole attempt gets, across every endpoint tried. */
export const SIMULATION_DEADLINE_MS = 20_000;

export interface SimulateOptions {
  /** Candidate endpoints for this chain, in the registry's declared order. */
  rpcUrls: readonly string[];
  call: SimulationCall;
  /** Overall wall-clock budget. Past it the answer is a stated absence. */
  deadlineMs?: number;
}

interface RpcErrorish { code?: unknown; message?: unknown; url?: unknown }

/**
 * Simulate one transaction, or say plainly that it could not be simulated.
 *
 * The loop is over *endpoints that have not already refused*, and it rebuilds
 * the client each time so rpc.ts keeps owning failover — an endpoint written
 * off here is simply not in the list handed to the next client, which is the
 * only way to skip one without reaching into that module's ordering.
 *
 * Note what is NOT retried: an ordinary JSON-RPC error, which is a working
 * node's answer about this transaction and would be the same from the next
 * operator a second later, having disclosed the transaction twice for it.
 */
export async function simulateTransaction(
  factory: SimulatorFactory,
  options: SimulateOptions,
): Promise<SimulationOutcome> {
  const deadline = options.deadlineMs ?? SIMULATION_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /* The outer deadline. Every arm of the race settles, so there is no path
   * where the caller is left with a promise that never resolves — see rule 4. */
  const expiry = new Promise<SimulationOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({
        kind: "unavailable",
        why: `simulation did not finish within ${deadline}ms — this is not a result, it is a timeout`,
      }),
      deadline,
    );
  });

  try {
    return await Promise.race([attempt(factory, options), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function attempt(
  factory: SimulatorFactory,
  options: SimulateOptions,
): Promise<SimulationOutcome> {
  const params = simulateParams(options.call);
  let remaining = options.rpcUrls.filter((u) => !unsupported.has(u));
  if (remaining.length === 0) {
    return {
      kind: "unavailable",
      why: options.rpcUrls.length === 0
        ? "no endpoint is configured for this chain, so nothing was simulated"
        : "simulation is unavailable on every endpoint this app has for this chain",
    };
  }

  // Bounded by the candidate count: each pass either returns or removes one.
  for (let pass = remaining.length; pass > 0 && remaining.length > 0; pass--) {
    const rpc = factory(remaining);
    try {
      const result = await rpc.request({ method: "eth_simulateV1", params });
      return readOutcome(result, options.call.from, rpc.lastUrl);
    } catch (e) {
      const error = e as RpcErrorish;
      const code = typeof error.code === "number" ? error.code : 0;
      const message = String((e as Error)?.message ?? e);
      const url = typeof error.url === "string" ? error.url : rpc.lastUrl;

      if (!isCapabilityRefusal(code, message)) {
        /* Either every endpoint went silent (rpc.ts already walked them all and
         * threw) or this one answered with an error about the transaction.
         * Both are "no simulation", stated as such. */
        return { kind: "unavailable", why: `simulation failed: ${message}` };
      }

      if (url === undefined) {
        // The refusal cannot be attributed, so it cannot be cached and the
        // next pass would ask the same endpoint again forever.
        return { kind: "unavailable", why: `simulation unavailable on this endpoint: ${message}` };
      }
      markSimulationUnsupported(url, message);
      remaining = remaining.filter((u) => u !== url);
    }
  }

  return {
    kind: "unavailable",
    why: "simulation is unavailable on every endpoint this app has for this chain",
  };
}

/**
 * The sentence shown beside any simulation, present or absent.
 *
 * A constant so it cannot be softened on one screen, and so a reviewer can
 * grep for whether it is drawn. Note it says what an empty transfer list does
 * NOT mean: the failure mode this module could most easily cause is a user
 * reading "no transfers" as "nothing can go wrong".
 */
export const SIMULATION_NOTICE =
  "Simulated by the RPC node against current chain state, at this app's " +
  "request. It is a preview, not a promise: state changes between now and " +
  "inclusion, the node is not trusted, and a simulation showing nothing " +
  "unusual is not a safety check. Only the device screen decides what is signed.";
