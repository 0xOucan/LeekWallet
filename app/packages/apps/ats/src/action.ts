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
  ACTION_BY_SELECTOR, ATS_DESCRIPTOR_SOURCE, DYNAMIC_ACTION_BY_SELECTOR, ROLE_POWER,
  UNRENDERABLE_BY_SELECTOR, actionName, atsDescriptors,
  type DynamicActionSpec, type SignatureConfidence,
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

/** Hex characters of argument word `i` (64 of them), or undefined if absent. */
function hexWordAt(data: string, i: number): string | undefined {
  const start = 10 + i * 64;
  const hex = data.slice(start, start + 64);
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex : undefined;
}

/**
 * Decode a call's `bytes`/`string` tail arguments, or refuse.
 *
 * This is the bounds-checked decoder `UNRENDERABLE`'s header promises, and the
 * bound it checks against is not "inside the calldata somewhere" — it is
 * "exactly where a canonical ABI encoder must have put it". A standard encoder
 * lays the tail out in head order, tightly packed, each segment a length word
 * followed by `ceil(length / 32)` words of content with any partial final word
 * zero-padded. Nothing else a real transaction-builder emits looks any other
 * way, so this function does not accept any other way either:
 *
 *  - every dynamic slot's offset must equal where the PREVIOUS segment ended,
 *    not merely some in-bounds word — an offset that skips ahead, doubles
 *    back, or overlaps another segment refuses instead of being "followed";
 *  - a segment's declared length must leave enough calldata for its own
 *    content, and the padding bytes past that length must be zero — nonzero
 *    padding is bytes hiding outside the length the encoder claims to have
 *    written, which is exactly the kind of mismatch a naive offset-follower
 *    would silently drop;
 *  - after the last segment, not one hex character may be left over — trailing
 *    calldata is calldata this decode did not account for, the same rule
 *    `matchDescriptor` enforces for static calls.
 *
 * There is therefore no offset here that is "trusted": every one is first
 * predicted from the shape `DynamicActionSpec` declares and the lengths
 * encountered so far, and the actual bytes are checked against the
 * prediction rather than walked on their own authority. Anything that does
 * not match refuses as a whole; nothing is partly decoded.
 */
function decodeDynamicTail(
  data: string,
  spec: DynamicActionSpec,
): readonly string[] | undefined {
  const headWords = spec.params.length;
  const argHex = data.slice(10);
  if (argHex.length % 64 !== 0) return undefined; // not a whole number of words
  const totalWords = argHex.length / 64;
  if (totalWords < headWords) return undefined;

  let cursor = headWords; // next word the encoder must use, canonically
  const out: string[] = [];
  for (const slot of spec.dynamic) {
    const offset = argWord(data, slot);
    if (offset === undefined) return undefined;
    if (offset % 32n !== 0n) return undefined;
    if (offset !== BigInt(cursor) * 32n) return undefined; // not tightly packed

    const length = argWord(data, cursor);
    if (length === undefined) return undefined;
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const lengthN = Number(length);
    const dataWords = Math.ceil(lengthN / 32);

    let content = "";
    for (let w = 0; w < dataWords; w++) {
      const hex = hexWordAt(data, cursor + 1 + w);
      if (hex === undefined) return undefined; // truncated tail
      content += hex;
    }
    const hexLen = lengthN * 2;
    const padding = content.slice(hexLen);
    // Padding beyond the declared length must be exactly zero: any other
    // value is bytes the length prefix does not account for.
    if (!/^0*$/.test(padding)) return undefined;
    out.push(content.slice(0, hexLen));

    cursor += 1 + dataWords;
  }

  // Every hex character must belong to a head word or an accounted-for tail
  // segment. Anything past the last segment is unexplained calldata.
  if (cursor !== totalWords) return undefined;
  return out;
}

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

/** The address in word `i`, or undefined if the high 12 bytes are not zero. */
function addressWordAt(data: string, i: number): string | undefined {
  const w = argWord(data, i);
  if (w === undefined || w >> 160n) return undefined;
  return `0x${w.toString(16).padStart(40, "0")}`;
}

/**
 * A dynamic field's bytes, shown as hex and never interpreted.
 *
 * `_data` and `_operatorData` on `controllerTransfer` are arbitrary,
 * issuer-chosen bytes with no declared meaning in the contracts — there is no
 * honest summary of them, only the bytes themselves. Long enough content is
 * truncated for the screen (never for the bounds check, which already ran
 * over the whole thing in `decodeDynamicTail`), and the truncation says so
 * rather than silently dropping bytes a reader would assume were shown.
 */
function opaqueBytes(hex: string, maxBytes = 48): string {
  if (hex.length === 0) return "(empty)";
  if (hex.length <= maxBytes * 2) return `0x${hex}`;
  return `0x${hex.slice(0, maxBytes * 2)}… (${hex.length / 2} bytes total, opaque)`;
}

/** A calldata word as a uint256 decimal string, for a raw-format field. */
const decimalWord = (data: string, i: number): string | undefined => argWord(data, i)?.toString();

/** Seconds since epoch, ISO-8601, or undefined if out of `Date`'s usable range. */
function isoDate(secs: bigint): string | undefined {
  if (secs > 8_640_000_000_000n) return undefined;
  return new Date(Number(secs) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * A forced transfer: the Controller role moving a holder's shares to another
 * address without that holder's signature. This is the call the plan calls
 * out by name, and the screen says so in exactly those words rather than
 * describing it as an ordinary transfer with an extra approver.
 */
function renderControllerTransfer(
  data: string,
  facts: SecurityFacts,
  spec: DynamicActionSpec,
  selector: string,
): PrivilegedRendering {
  const from = addressWordAt(data, 0);
  const to = addressWordAt(data, 1);
  const amount = decimalWord(data, 2);
  if (from === undefined || to === undefined || amount === undefined) {
    return refuse("controllerTransfer's static arguments are not well-formed", selector);
  }

  const tail = decodeDynamicTail(data, spec);
  if (tail === undefined) {
    return refuse(
      "the operator-data fields of this forced transfer are not the canonical " +
        "ABI encoding this console can bounds-check, so it will not guess what " +
        "bytes they point to",
      selector,
    );
  }
  const [transferData, operatorData] = tail as [string, string];

  let fields: readonly DescriptorField[] = [
    { label: "From", value: from, format: "addressName" },
    { label: "To", value: to, format: "addressName" },
    { label: "Amount", value: amount, format: "raw" },
    { label: "Data", value: opaqueBytes(transferData), format: "raw" },
    { label: "Operator data", value: opaqueBytes(operatorData), format: "raw" },
  ];
  fields = withShares(fields, "Amount", facts.decimals);

  return {
    state: "screen",
    title: `${spec.title.toUpperCase()} · ${securityLabel(facts)}`,
    fields,
    effect:
      "moves this holder's shares to another address WITHOUT their consent — " +
      "a forced transfer, not an ordinary one. The Data and Operator data " +
      "fields above are arbitrary bytes this console cannot interpret and " +
      "shows only as opaque hex; they carry no meaning this screen can vouch for",
    selector,
    signature: spec.signature,
    confidence: spec.confidence,
    source: ATS_DESCRIPTOR_SOURCE,
    advisory: true,
    unverified: true,
  };
}

/**
 * Granting KYC: the one refusal the earlier version of this file argued for
 * by name, in a comment daring a future reader to "fix" it. What changed is
 * not the argument — a credential id IS attacker/issuer-controlled text next
 * to numbers, exactly the risk `sanitiseText` exists for — but that the risk
 * turned out to be the same one `name()` already carries onto a screen, with
 * the same treatment: bounded, control-character-stripped, and never trusted
 * as anything more than a label.
 */
function renderGrantKyc(
  data: string,
  facts: SecurityFacts,
  spec: DynamicActionSpec,
  selector: string,
): PrivilegedRendering {
  const account = addressWordAt(data, 0);
  const validFrom = argWord(data, 2);
  const validTo = argWord(data, 3);
  const issuer = addressWordAt(data, 4);
  if (account === undefined || validFrom === undefined || validTo === undefined || issuer === undefined) {
    return refuse("grantKyc's static arguments are not well-formed", selector);
  }
  const from = isoDate(validFrom);
  const to = isoDate(validTo);
  if (from === undefined || to === undefined) {
    return refuse("grantKyc's validity window is not a usable date", selector);
  }

  const tail = decodeDynamicTail(data, spec);
  if (tail === undefined) {
    return refuse(
      "the credential id in this KYC grant is not the canonical ABI encoding " +
        "this console can bounds-check, so it will not guess what bytes it " +
        "points to",
      selector,
    );
  }
  const [vcIdHex] = tail as [string];
  const vcIdBytes = new Uint8Array(vcIdHex.length / 2);
  for (let i = 0; i < vcIdBytes.length; i++) {
    vcIdBytes[i] = Number.parseInt(vcIdHex.slice(i * 2, i * 2 + 2), 16);
  }
  const vcId = sanitiseText(new TextDecoder("utf-8", { fatal: false }).decode(vcIdBytes), 64)
    ?? "(empty or unprintable credential id)";

  return {
    state: "screen",
    title: `${spec.title.toUpperCase()} · ${securityLabel(facts)}`,
    fields: [
      { label: "Holder", value: account, format: "addressName" },
      { label: "Credential id", value: vcId, format: "raw" },
      { label: "Valid from", value: from, format: "date" },
      { label: "Valid to", value: to, format: "date" },
      { label: "Issuer", value: issuer, format: "addressName" },
    ],
    effect:
      "this holder gains KYC status for the window shown and can send and " +
      "receive shares, subject to any other restriction still in force. The " +
      "credential id is decoded text supplied in the calldata, not a value " +
      "this console has verified against any registry",
    selector,
    signature: spec.signature,
    confidence: spec.confidence,
    source: ATS_DESCRIPTOR_SOURCE,
    advisory: true,
    unverified: true,
  };
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
    /* Calls with a dynamic argument never reach `matchDescriptor`: the shared
     * engine drops any signature it cannot bounds-check, on principle, for
     * every descriptor set that uses it. `controllerTransfer` and `grantKyc`
     * are rendered anyway, by a decoder built for exactly these two shapes —
     * see `decodeDynamicTail` and `DYNAMIC_ACTIONS`'s header for why this does
     * not weaken the engine's rule. */
    const dynamicSpec = DYNAMIC_ACTION_BY_SELECTOR.get(selector);
    if (dynamicSpec !== undefined) {
      return dynamicSpec.signature.startsWith("controllerTransfer")
        ? renderControllerTransfer(data, facts, dynamicSpec, selector)
        : renderGrantKyc(data, facts, dynamicSpec, selector);
    }

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

    case "takeSnapshot":
      effect = "records every holder's balance at this instant, permanently, as a numbered snapshot";
      break;

    case "setDividend": {
      /* The amount's scale is in the calldata, one word after the amount, so
       * the restatement is derived from the same bytes the device will draw
       * rather than from anything the console was told. The security's own
       * `decimals()` is deliberately NOT used here: this figure is denominated
       * in the payment token, which is a different contract with a different
       * scale, and applying the share scale to it would be off by orders of
       * magnitude in a number nobody could check by eye. */
      const scale = argWord(data, 3);
      if (scale === undefined || scale > 77n) {
        return refuse("the dividend's amount scale is not a usable number of decimals", selector);
      }
      fields = fields.map((f) =>
        f.label === "Total" && /^\d+$/.test(f.value)
          ? { ...f, value: `${formatUnits(BigInt(f.value), Number(scale))} (${f.value} raw units)` }
          : f);
      /* Two sentences because this call does two surprising things: it moves
       * no money, and the snapshot it will use is not the one the console
       * reconciled against — the register takes its own at the record date. */
      effect =
        "declares a dividend on this register; it transfers nothing by itself, and " +
        "each holder is paid by a separate transfer that needs its own approval";
      break;
    }

    case "unpause":
      effect = "allows transfers by every holder again";
      break;

    case "freezePartialTokens":
      effect = "these shares stay in the holder's balance and cannot be moved by them";
      fields = withShares(fields, "Amount", facts.decimals);
      break;

    case "unfreezePartialTokens":
      effect = "the holder can move these shares again";
      fields = withShares(fields, "Amount", facts.decimals);
      break;

    case "setAddressFrozen": {
      /* Read from the calldata, not from the label: the effect line and the
       * rendered field must come from the same bytes, and the two sentences
       * here are opposites. Anything other than a clean 0 or 1 in the word is
       * not a bool this console will describe. */
      const flag = argWord(data, 1);
      if (flag !== 0n && flag !== 1n) {
        return refuse("the frozen flag is neither true nor false", selector);
      }
      effect = flag === 1n
        ? "blocks every transfer by this holder, of their whole balance, until they are unfrozen"
        : "lets this holder transfer again";
      break;
    }

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
