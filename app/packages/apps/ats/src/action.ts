/**
 * Turning a privileged ATS call into a screen, or refusing to.
 *
 * ---------------------------------------------------------------------------
 * The rule this file exists for
 *
 * **A privileged call with no descriptor must refuse** (plan §3). Not "renders
 * the selector", not "shows the raw calldata with a warning" — refuses, and
 * says which call it could not describe. An unlabelled screen on an
 * irreversible action manufactures confidence: the user sees a wallet that has
 * clearly examined the transaction, and infers that a wallet which examined it
 * and did not object has nothing to object to.
 *
 * Refusal therefore has to be the *default*, reached by every path that does
 * not end in a complete screen: unknown contract, unknown selector, trailing
 * calldata, a role id that is not in `roles.ts`, a consequence line we do not
 * have, a control list whose direction we have not read. Each of those is a
 * separate `refuse()` below and each has a test.
 *
 * ---------------------------------------------------------------------------
 * Why not `Outcome<T>`
 *
 * `Outcome` distinguishes "the contract reverted" from "nobody answered" — it
 * is about a *read that was attempted*. Nothing is attempted here. This is a
 * decision about whether a rendering is honest enough to show, taken with the
 * bytes already in hand, and folding it into `unavailable` would invite the
 * one response that must never follow a refusal: retry.
 *
 * ---------------------------------------------------------------------------
 * What this file is not
 *
 * It does not sign, request a signature, or know how one is requested. It ends
 * at a `PrivilegedScreen`, which is text. Everything in that text is
 * host-derived and unsigned — the descriptor labels, our consequence wording,
 * and the security's own `name()` — so the same rule as `DESCRIPTOR_NOTICE`
 * applies: it may inform a host preview and must never be shown as though the
 * device had attested it.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import { matchDescriptor, type Descriptor, type DescriptorField } from "@leekwallet/core/erc7730.ts";
import { sanitiseText } from "./abi.ts";
import {
  ACTION_BY_SELECTOR, ROLE_POWER, UNRENDERABLE_BY_SELECTOR, actionName,
  atsDescriptors, type SignatureConfidence,
} from "./descriptors.ts";
import { roleInfo } from "./roles.ts";

/** Facts about the security, from a register read. Never from the caller's UI. */
export interface SecurityFacts {
  chainId: number;
  /** The address the console is pointed at. Lower-case 0x hex. */
  address: string;
  /** `name()`, already read. Attacker-controlled text; re-sanitised below. */
  name?: string | undefined;
  /** `decimals()`. Absent means share amounts stay in raw units. */
  decimals?: number | undefined;
  /**
   * `getControlListType()`: true = allowlist, false = blocklist.
   *
   * Absent is not "assume allowlist". The same calldata permits a holder or
   * bars one depending on this bit, so without it a control-list edit refuses.
   */
  controlListType?: boolean | undefined;
}

export interface PrivilegedScreen {
  state: "screen";
  /** "GRANT ROLE · ACME Equity". */
  title: string;
  /** Descriptor-rendered fields, in descriptor order. */
  fields: readonly DescriptorField[];
  /** What this call does to third parties. The point of the screen. */
  effect: string;
  /** 0x-prefixed selector, so a reader can check it against an explorer. */
  selector: string;
  signature: string;
  confidence: SignatureConfidence;
  source: string;
  advisory: true;
  unverified: true;
}

export interface PrivilegedRefusal {
  state: "refused";
  /** Why, in words a user can act on. Never a bare "error". */
  why: string;
  /** The selector we could not describe, when we got far enough to have one. */
  selector?: string;
}

export type PrivilegedRendering = PrivilegedScreen | PrivilegedRefusal;

const refuse = (why: string, selector?: string): PrivilegedRefusal =>
  selector === undefined ? { state: "refused", why } : { state: "refused", why, selector };

/** The sentence that must sit beside any refusal. Retrying is not the remedy. */
export const REFUSAL_NOTICE =
  "This console will not present an unlabelled approval screen for an " +
  "irreversible action. Nothing was signed and nothing was sent; retrying " +
  "will refuse identically.";

const selectorOfCalldata = (data: string): string | undefined =>
  /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10).toLowerCase() : undefined;

/** Word `i` of the arguments, as a bigint, or undefined if it is not there. */
function argWord(data: string, i: number): bigint | undefined {
  const start = 10 + i * 64;
  const hex = data.slice(start, start + 64);
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) return undefined;
  return BigInt(`0x${hex}`);
}

/** The role id in word `i`, in the 32-byte form `roles.ts` is keyed by. */
const roleIdAt = (data: string, i: number): string | undefined => {
  const w = argWord(data, i);
  return w === undefined ? undefined : `0x${w.toString(16).padStart(64, "0")}`;
};

/**
 * The security's name for the title, or its address.
 *
 * Re-sanitised even though `register.ts` sanitised it on the way in, because
 * this is a different screen with a different budget and a title is the line a
 * reader trusts most. A name that does not survive sanitising is dropped
 * entirely rather than shown mangled.
 */
function securityLabel(facts: SecurityFacts): string {
  const clean = facts.name === undefined ? undefined : sanitiseText(facts.name, 32);
  return clean ?? `${facts.address.slice(0, 8)}…${facts.address.slice(-6)}`;
}

/**
 * Restate a raw share count in the security's own decimals.
 *
 * The descriptor prints raw units, which is always true and rarely readable.
 * Decimals are not taken from the descriptor: they come from `decimals()` on
 * the contract being called, which is stronger provenance than any label here,
 * and the raw figure stays alongside so the restatement is checkable.
 */
function withShares(fields: readonly DescriptorField[], label: string, decimals?: number)
  : readonly DescriptorField[] {
  if (decimals === undefined) return fields;
  return fields.map((f) => {
    if (f.label !== label || !/^\d+$/.test(f.value)) return f;
    return { ...f, value: `${formatUnits(BigInt(f.value), decimals)} shares (${f.value} raw)` };
  });
}

/**
 * Render a privileged call, or refuse.
 *
 * `descriptors` is a parameter rather than a module-level constant so a test
 * can hand in a set with one action removed and watch the refusal happen. That
 * test is the reason this signature looks the way it does; see
 * `descriptors.test.ts`.
 */
export function describePrivilegedCall(
  facts: SecurityFacts,
  data: string,
  descriptors: readonly Descriptor[] = atsDescriptors(facts.chainId, facts.address),
): PrivilegedRendering {
  const selector = selectorOfCalldata(data);
  if (selector === undefined) return refuse("the call has no four-byte selector");

  const match = matchDescriptor(descriptors, {
    chainId: facts.chainId,
    to: facts.address,
    data,
  });
  if (match === undefined) {
    /* Same refusal either way — nothing is signed and nothing is sent. The
     * only difference is whether we can name the reason. A call on the known
     * list is one no descriptor can ever describe, and saying so stops the
     * reader looking for a descriptor that could not exist. */
    const known = UNRENDERABLE_BY_SELECTOR.get(selector);
    if (known !== undefined) {
      return refuse(`this call cannot be described on any screen: ${known}`, selector);
    }
    return refuse(
      "no descriptor describes this call on this contract, so there is no " +
        "honest way to say what approving it would do",
      selector,
    );
  }

  const spec = ACTION_BY_SELECTOR.get(match.selector);
  // Unreachable while ACTIONS is the only source of formats, but a descriptor
  // set assembled elsewhere must not fall through into a screen with no title.
  if (spec === undefined) return refuse("this call has no action spec", selector);

  // A descriptor that could not render every field it declared describes the
  // call only partly, and a partly described irreversible action is the case
  // this file refuses. `hiddenFields` is different: the descriptor asked.
  if (match.omittedFields > 0) {
    return refuse(
      `${match.omittedFields} argument(s) of this call could not be rendered`,
      selector,
    );
  }
  if (match.conflicts.length > 0) return refuse(match.conflicts.join(" "), selector);

  const name = securityLabel(facts);
  let fields = match.fields;
  let effect: string;

  switch (actionName(spec)) {
    case "grantRole":
    case "revokeRole": {
      const id = roleIdAt(data, 0);
      const info = id === undefined ? undefined : roleInfo(id);
      // A role id absent from roles.ts is not a role we can describe. It reads
      // on-chain as a role with no members, which is indistinguishable from an
      // unheld role — so naming it "unknown role" and rendering anyway would
      // put an approve button under a sentence nobody wrote.
      if (info === undefined) {
        return refuse(`role ${id ?? "(unreadable)"} is not in this app's role table`, selector);
      }
      const power = ROLE_POWER[info.name];
      if (power === undefined) {
        return refuse(`no consequence is recorded for the ${info.name} role`, selector);
      }
      effect = actionName(spec).startsWith("grant") ? `can ${power}` : `can no longer ${power}`;
      break;
    }

    /* There is no `grantKyc` case, and its absence is the point: the real
     * `IKyc.grantKyc` takes a credential id as a `string`, so it has no
     * descriptor and never reaches this switch. See UNRENDERABLE. */
    case "revokeKyc":
      // Stated as a loss to the holder, not as an administrative state change:
      // the balance does not move, and that is exactly what makes it dangerous.
      effect = "this holder can no longer send or receive shares; their existing balance stays where it is and becomes unmovable";
      break;

    case "pause":
      effect = "blocks all transfers by every holder until the register is unpaused";
      break;

    case "unpause":
      effect = "allows transfers by every holder again";
      break;

    case "lock":
      effect = "this holder cannot move the locked shares until the time shown";
      fields = withShares(fields, "Amount", facts.decimals);
      break;

    case "setMaxSupply":
      // Both directions in one line: the same call raises or lowers, and which
      // one it is depends on a number the reader is looking at.
      effect = "changes the ceiling on shares that can ever exist; a cap above the current supply permits further issuance";
      fields = withShares(fields, "New cap", facts.decimals);
      break;

    case "mint":
      effect = "creates new shares out of nothing and dilutes every existing holder";
      fields = withShares(fields, "Amount", facts.decimals);
      break;

    case "addToControlList":
    case "removeFromControlList": {
      // The same calldata permits or bars depending on the list's direction,
      // so without having read it there is no sentence to write. Refusing is
      // not pedantry: the two readings are exact opposites.
      if (facts.controlListType === undefined) {
        return refuse(
          "the control list's direction has not been read, and adding an " +
            "address to an allowlist is the opposite of adding it to a blocklist",
          selector,
        );
      }
      const adding = actionName(spec).startsWith("add");
      effect = facts.controlListType
        ? adding
          ? "this address becomes allowed to hold and transfer shares"
          : "this address loses permission to hold or transfer shares"
        : adding
          ? "this address is barred from holding or transferring shares"
          : "this address is no longer barred from holding or transferring shares";
      break;
    }

    default:
      return refuse("this call has no consequence wording", selector);
  }

  return {
    state: "screen",
    title: `${spec.title.toUpperCase()} · ${name}`,
    fields,
    effect,
    selector: match.selector,
    signature: match.signature,
    confidence: spec.confidence,
    source: match.source,
    advisory: true,
    unverified: true,
  };
}

/** The screen as lines, in the plan's shape. Used by tests and by any preview. */
export function renderPrivilegedScreen(screen: PrivilegedScreen): string {
  const lines = [screen.title];
  for (const f of screen.fields) lines.push(`${f.label.padEnd(8)}${f.value}`);
  lines.push(`${"Effect".padEnd(8)}${screen.effect}`);
  return lines.join("\n");
}
