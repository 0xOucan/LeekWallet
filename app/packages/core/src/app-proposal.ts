/**
 * The one way a mini-app can ask for a signature (T-apps-signing).
 *
 * Pure: no network, no clock, no DOM, no device. This file decides whether a
 * payload an app wants signed is one this wallet is willing to *describe*, and
 * nothing else. The shell does the rest, through the path it already had.
 *
 * ---------------------------------------------------------------------------
 * Propose, never sign
 *
 * An app gets `propose(...)` and gets back an outcome. It never gets a function
 * that returns a signature over bytes it chose, because such a function is a
 * capability: hold it and you can sign, at a time of your choosing, whatever
 * you can encode. What an app holds here is the ability to *ask* — and an ask
 * that is screened here, drawn on the user's screen, drawn again on the
 * device's, and confirmed with a button press before anything is signed. The
 * distinction is not stylistic: it is why a compromised app dependency costs a
 * refused proposal rather than a drained account.
 *
 * The result an app receives is a transaction hash, a raw signed transaction,
 * or a signature over a document the user approved on hardware. That is a
 * *result*, not a capability — produced once, for one payload, with a human in
 * the loop, and useless for producing a second one.
 *
 * ---------------------------------------------------------------------------
 * What an app may set, and what only the shell may set
 *
 * A proposal carries `to`, `data`, `value` and a short `reason`, and there are
 * deliberately no other fields — not ignored fields, *absent* ones, so the
 * compiler is the enforcement rather than a runtime filter somebody can forget
 * to update when the type grows.
 *
 * The shell alone supplies:
 *
 *   - `from`. An app that could pick `from` could ask the user to sign as an
 *     address they are not looking at — another account in the same wallet, on
 *     a screen that says nothing about which one. The signer is whichever
 *     address the shell is currently showing, always.
 *   - `chainId`. The app was mounted on a chain it declared; proposing on
 *     another one would be signing for a network the screen is not about. The
 *     descriptor match is chain-scoped as well, so this is also what stops a
 *     testnet descriptor from describing a mainnet call.
 *   - nonce, gas, fees, and whether the result is broadcast. Those are the
 *     shell's existing signing path (`signPlannedTransaction`), and a second
 *     implementation of them for apps is exactly the second signing path this
 *     design exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * The rule
 *
 *   If the device cannot render it, we do not sign it.
 *
 * For a call, "describable" means one of two things, and the second is the
 * narrower:
 *
 *   1. An ERC-7730 descriptor bundled with this app matches the chain, the
 *      contract and the selector, renders every argument, and does not
 *      disagree with the firmware-mirroring decoder about what the calldata
 *      says.
 *   2. The FIRMWARE itself decodes the call and draws every argument on its own
 *      screen — `DEVICE_DRAWN_KINDS` below. A descriptor is only ever the
 *      host's evidence that a payload is describable; this is the device's own,
 *      and it is better evidence, not a relaxation. The set is confined to
 *      calls for which a descriptor is impossible, because erc7730.ts refuses
 *      any signature with a dynamic argument.
 *
 * For typed data it means the device's own mirror (`inspectTypedData`) returns
 * `ok`: every field showable, on its screen, in its character set.
 *
 * `unrenderable` typed data is refused here even when the device owner has
 * blind signing switched on. That hatch exists for a dapp the owner chose to
 * connect to and can stop connecting to; an app ships inside the wallet, and
 * letting one lean on the hatch would make "an app can only ask for things you
 * can read" untrue for whoever left the setting on.
 *
 * Screening lives in core rather than in the shell because a rule enforced in
 * UI code is a rule a second UI, a test harness or a headless build can skip.
 * `screenProposal` is the only constructor of the value the shell will act on,
 * so there is no route to the device that has not been through it.
 */

import {
  describeTypedData, inspectTypedData, toDeviceTypedData, type TypedRender,
} from "./eip712.ts";
import {
  DEFAULT_DESCRIPTORS, interpretTransaction, type TxInterpretation,
} from "./tx-interpret.ts";
import { CallKind } from "./eth-decode.ts";
import type { Descriptor, DescriptorMatch } from "./erc7730.ts";
import type { CborValue } from "./cbor.ts";

/** A contract call an app would like signed. No `from`, no `chainId`: see above. */
export interface CallProposal {
  kind: "call";
  /** The contract. Contract creation is not proposable — nothing describes it. */
  to: string;
  /** ABI-encoded calldata. Must match a bundled descriptor, or this is refused. */
  data: string;
  /** Native value, default 0. */
  value?: bigint;
  /**
   * One line, in the app's own words, for the shell's log.
   *
   * App-authored text, so it is never rendered as a fact about the call and
   * never beside the numbers. The screens that decide are the interpretation
   * preview and the device; this only says which app is asking and what for,
   * which is the one thing neither of those can know.
   */
  reason: string;
}

/** An EIP-712 document an app would like signed. */
export interface TypedDataProposal {
  kind: "typed-data";
  /** The document, in the ordinary `{types, primaryType, domain, message}` shape. */
  document: Record<string, unknown>;
  /** As `CallProposal.reason`. */
  reason: string;
}

export type AppProposal = CallProposal | TypedDataProposal;

/**
 * The only sentence an app ever gets back from a refusal.
 *
 * A constant so that a reviewer can grep for every place an app could learn
 * something about *why*, and find one.
 */
export const PROPOSAL_DECLINED = "The wallet declined this request." as const;

/**
 * What an app learns.
 *
 * One refusal shape for every no, and the app is not told which no it was.
 *
 * The argument for telling it: a developer chasing a missing descriptor would
 * find it faster, and an app could write a better sentence than "declined".
 * The argument against, which wins: an app that can tell "no descriptor" from
 * "the user pressed reject" can search. It can walk selectors until one is
 * describable, or — easier and worse — detect a rejection and immediately
 * re-ask, which is how consent gets ground down. Neither is worth accepting for
 * a debugging convenience the shell log already provides: the *user* sees the
 * real reason, every time, in words. That asymmetry is the design. What is
 * invisible to the app is visible to the person whose money it is.
 */
export type ProposalOutcome =
  | { ok: true; kind: "call"; /** Tx hash when broadcast, else the raw signed tx. */ result: string }
  | { ok: true; kind: "typed-data"; signature: string }
  | { ok: false; text: typeof PROPOSAL_DECLINED };

/** The single no. Refusal and user-reject are the same value on purpose. */
export const declined = (): ProposalOutcome => ({ ok: false, text: PROPOSAL_DECLINED });

/**
 * Calls the DEVICE decodes and draws itself, field by field, with no
 * descriptor in the picture.
 *
 * Exported so the rule can be read and asserted rather than inferred from a
 * branch. Every member must have a bespoke decoder in `src/eth-decode.c`, a
 * mirror in `eth-decode.ts`, and a page in `src/ui.c` that draws every
 * argument — the three together are what "the device can render it" means
 * here, and mock-conformance vectors are what prove the first two agree.
 */
export const DEVICE_DRAWN_KINDS: ReadonlySet<string> = new Set<string>([
  CallKind.AquaShip,
  CallKind.AquaDock,
]);

/** The shell-owned facts a proposal is screened against. */
export interface ScreenContext {
  /** The chain the app was mounted on. Not the app's to choose. */
  chainId: number;
  /** The address the shell is showing. Not the app's to choose. */
  from: string;
  /** Defaults to DEFAULT_DESCRIPTORS. A test passes a reduced set. */
  descriptors?: readonly Descriptor[];
  /** Gas-token ticker for descriptor `amount` fields. From chains.ts only. */
  nativeSymbol?: string;
}

/**
 * A proposal that passed screening, in the shape the shell's signing path
 * wants.
 *
 * Not constructible anywhere but `screenProposal` — that is what makes
 * "screened" mean something. `from` and `chainId` are stamped in from the
 * context here, so even a proposal object that somehow carried them could not
 * have supplied them.
 */
export type ScreenedProposal =
  | {
      kind: "call";
      from: string;
      chainId: number;
      to: string;
      data: string;
      value: bigint;
      reason: string;
      /**
       * The reading this proposal was screened against, carried forward so the
       * card draws the interpretation the gate actually judged.
       *
       * Re-deriving it in the shell would be a second reading of the same
       * calldata, and two readings are two chances to show the user something
       * other than what was screened. `interpretation.descriptor` is the
       * ERC-7730 match, and it is never absent here — a missing one is a
       * refusal above.
       */
      interpretation: TxInterpretation;
      /**
       * The same match, named, so a caller cannot reach the card without it.
       *
       * Absent for the one route that does not go through a descriptor at all:
       * a call the FIRMWARE's own decoder reads field by field and draws on its
       * own screen (`DEVICE_DRAWN_KINDS` below). A caller must render the
       * interpretation either way; what it must not do is treat a missing
       * descriptor as a missing description.
       */
      descriptor?: DescriptorMatch;
    }
  | {
      kind: "typed-data";
      from: string;
      chainId: number;
      document: Record<string, unknown>;
      /** The device's wire encoding, so nothing is transcribed twice. */
      request: Record<string, unknown>;
      /** What the device's own screens will say. */
      summary: string;
      render: TypedRender;
      reason: string;
    };

export type ScreenResult =
  | { kind: "ok"; screened: ScreenedProposal }
  /** `why` is for the user's log. It is never handed to the app. */
  | { kind: "refused"; why: string };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/** An app gets one logged line. Bound it so it cannot become a wall of text. */
const MAX_REASON = 120;

/**
 * Decide whether a proposal is one this wallet will describe.
 *
 * Deliberately not simulated. `simulate.ts` exists and this could call it, but
 * making describability depend on a simulation would make it depend on an RPC
 * operator being up and supporting `eth_simulateV1` — a boundary that opens and
 * closes with somebody else's uptime is not a boundary. It would also disclose
 * the payload to that operator before the user has decided to sign anything,
 * and a green simulation reads as an endorsement of a call the descriptor may
 * still be describing wrongly. Simulation stays what it is: an advisory the
 * user can ask for once the payload is on screen, never a gate.
 */
export function screenProposal(
  proposal: AppProposal,
  context: ScreenContext,
): ScreenResult {
  if (typeof proposal.reason !== "string" || proposal.reason.trim() === "") {
    return { kind: "refused", why: "the app gave no reason for the request" };
  }
  if (proposal.reason.length > MAX_REASON) {
    return { kind: "refused", why: "the app's reason is too long to log honestly" };
  }
  if (!HEX_ADDRESS.test(context.from)) {
    return { kind: "refused", why: "no address is selected to sign with" };
  }

  if (proposal.kind === "call") {
    if (!HEX_ADDRESS.test(proposal.to)) {
      /* Contract creation included: an app that could deploy could deploy
       * anything, and no descriptor describes a constructor. */
      return { kind: "refused", why: "the proposed call has no contract address" };
    }
    if (!HEX_DATA.test(proposal.data) || proposal.data.length < 10) {
      return { kind: "refused", why: "the proposed calldata is not a function call" };
    }
    const value = proposal.value ?? 0n;
    if (value < 0n) return { kind: "refused", why: "the proposed value is negative" };

    /* The same function the send preview and the WalletConnect card use, so the
     * gate cannot pass something those two would draw differently. Its
     * `descriptor` field is the ERC-7730 match, already cross-checked against
     * the firmware-mirroring decoder. */
    const interpretation = interpretTransaction(
      { chainId: context.chainId, to: proposal.to, data: proposal.data, value },
      {
        descriptors: context.descriptors ?? DEFAULT_DESCRIPTORS,
        ...(context.nativeSymbol !== undefined ? { nativeSymbol: context.nativeSymbol } : {}),
      },
    );
    const descriptor = interpretation.descriptor;

    /* The second route past the gate, and the narrower of the two.
     *
     * The rule is "if the device cannot render it, we do not sign it". A
     * bundled descriptor is a PROXY for that: it is how the host convinces
     * itself the payload is describable. For the kinds below the device does
     * not need a proxy, because it decodes the call itself, in C, from the
     * signature it hashed, and draws every field on its own screen. That is
     * strictly stronger evidence than an unsigned registry file — the
     * descriptor is host data the device has never seen, and this is the
     * device's own reading.
     *
     * It is deliberately not "any kind the firmware decodes". Widening it to
     * ERC-20 transfer and approve would let an app propose those with no
     * descriptor, which is a policy change and not this one. What is here is
     * the set for which a descriptor is IMPOSSIBLE: erc7730.ts refuses any
     * signature with a dynamic argument (see parseSignature), so Aqua's ship
     * and dock can never have one, and without this route an app could not
     * propose a call the device is perfectly able to draw. Adding a kind here
     * is a decision about what a mini-app may ask for, and the test suite
     * pins the list so it cannot grow by accident.
     */
    if (DEVICE_DRAWN_KINDS.has(interpretation.kind)) {
      /* Still gated on the decoder having actually read it: `interpret`
       * reports `deviceWillRefuse` from the same mirror the device runs, and a
       * kind without a decode behind it is not reachable — but the check is
       * free and the alternative is a route that assumes. */
      if (interpretation.deviceWillRefuse) {
        return { kind: "refused", why: "the device's own decoder could not read that call" };
      }
      return {
        kind: "ok",
        screened: {
          kind: "call",
          from: context.from,
          chainId: context.chainId,
          to: proposal.to,
          data: proposal.data,
          value,
          reason: proposal.reason,
          interpretation,
          ...(descriptor !== undefined ? { descriptor } : {}),
        },
      };
    }

    if (!descriptor) {
      return {
        kind: "refused",
        why:
          `no bundled ERC-7730 descriptor describes ${proposal.data.slice(0, 10)} at ` +
          `${proposal.to} on chain ${context.chainId}`,
      };
    }
    if (descriptor.omittedFields > 0) {
      /* A partial rendering is a payload with arguments nobody was shown. The
       * dapp path may show one with a caveat, because refusing a dapp the
       * device would accept means overruling the owner invisibly; an app is
       * ours and gets the stricter rule. */
      return { kind: "refused", why: "the descriptor cannot render every argument of this call" };
    }
    if (descriptor.conflicts.length > 0) {
      /* One of the two readings is wrong and we do not know which. Signing on
       * the strength of whichever we happen to prefer is the whole failure. */
      return { kind: "refused", why: `descriptor and decoder disagree: ${descriptor.conflicts[0]}` };
    }

    return {
      kind: "ok",
      screened: {
        kind: "call",
        from: context.from,
        chainId: context.chainId,
        to: proposal.to,
        data: proposal.data,
        value,
        reason: proposal.reason,
        interpretation,
        descriptor,
      },
    };
  }

  /* Typed data: describable means the device's own mirror can show all of it.
   * `toDeviceTypedData` throws on anything not shaped like a document. */
  let request: Record<string, CborValue>;
  try {
    request = toDeviceTypedData(proposal.document);
  } catch (e) {
    return { kind: "refused", why: `that is not a typed-data document: ${(e as Error).message}` };
  }
  const verdict = inspectTypedData(request);
  if (verdict.kind !== "ok") {
    return {
      kind: "refused",
      why:
        verdict.kind === "unrenderable"
          /* Named separately in the log because it is the one refusal a user
           * might otherwise blame on the device's blind-signing setting. */
          ? `the device could not show every field, and an app may not use blind signing: ${verdict.why}`
          : `the device could not sign that document: ${verdict.why}`,
    };
  }

  /* The domain's chainId is neither overridden nor defaulted. A document
   * claiming a different chain than the app was mounted on is left claiming it,
   * and rules.ts is what tells the user so — rewriting it here would be this
   * file quietly making a phishing document look consistent. */
  return {
    kind: "ok",
    screened: {
      kind: "typed-data",
      from: context.from,
      chainId: context.chainId,
      document: proposal.document,
      request,
      summary: describeTypedData(verdict.render),
      render: verdict.render,
      reason: proposal.reason,
    },
  };
}
