/**
 * One renderer for the advisory transaction preview.
 *
 * Extracted because there are now two places a transaction is shown before it
 * is signed — the app's own send form, and a request arriving from a dapp over
 * WalletConnect — and they must look identical. Not for tidiness: a dapp
 * request that rendered in a different, friendlier style than the app's own
 * preview would read as more authoritative than it is, and the whole point of
 * PROTOCOL.md 6c is that neither of them is authoritative at all. Same fields,
 * same warnings, same closing sentence, whoever asked.
 *
 * Nothing here takes text from a dapp. Everything drawn comes from
 * `interpretTransaction`, which reads only the transaction fields.
 */

import { TOKEN_HINT_NOTICE, formatUnits, tokenHint } from "../packages/core/src/chains.ts";
import { DESCRIPTOR_NOTICE, type DescriptorMatch } from "../packages/core/src/erc7730.ts";
import { RULES_NOTICE, type Finding } from "../packages/core/src/rules.ts";
import { ADVISORY_NOTICE, type TxInterpretation } from "../packages/core/src/tx-interpret.ts";

/** The four slots a preview card needs. Ids differ between the two cards. */
export interface PreviewTargets {
  summary: HTMLElement;
  fields: HTMLElement;
  warnings: HTMLElement;
  authority: HTMLElement;
}

/** Group into fours so a human can actually compare two addresses. */
export const chunk = (addr: string): string => {
  const body = addr.replace(/^0x/, "").match(/.{1,4}/g) ?? [];
  return `0x ${body.join(" ")}`;
};

/**
 * Draw an interpretation into a card.
 *
 * `symbol` is the gas token of the chain, from the registry — never from a
 * dapp, and never from a token list.
 */
export function renderInterpretation(
  targets: PreviewTargets,
  view: TxInterpretation,
  symbol: string,
  findings?: readonly Finding[],
): void {
  targets.summary.textContent = view.summary;

  const fields = targets.fields;
  fields.textContent = "";
  const row = (label: string, text: string): void => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = text;
    fields.append(dt, dd);
  };

  row("App reads it as", view.action);
  if (view.recipient) row("To", chunk(view.recipient));
  row("Value", `${view.valueEther} ${symbol}`);
  row("Chain", view.chainName ? `${view.chainId} (${view.chainName})` : String(view.chainId));
  // Raw units, never scaled: the device cannot call decimals() and neither can
  // this app claim to know them.
  if (view.tokenAmountRaw !== undefined) {
    row("Token amount", `${view.tokenAmountRaw} raw units (decimals unknown)`);
  }
  /* The contract address comes first and is never replaced by a name. A hint,
   * if there is one, is an extra line that says out loud that nothing checked
   * it — a host-supplied symbol relabelling a worthless contract is exactly
   * the attack PROTOCOL.md 6d describes, and this app is that host. */
  if (view.contract) {
    row("Token contract", chunk(view.contract));
    const hint = tokenHint(view.chainId, view.contract);
    if (hint) {
      row(
        "Possibly (UNVERIFIED)",
        view.tokenAmountRaw === undefined
          ? `${hint.symbol}?`
          : `${formatUnits(view.tokenAmountRaw, hint.decimals)} ${hint.symbol}? — ${TOKEN_HINT_NOTICE}`,
      );
    }
  }
  row(
    "Max fee",
    view.maxFeeEther === undefined
      ? "not known until fees are fetched"
      : `up to ${view.maxFeeEther} ${symbol} (${view.maxFeeWei} wei)`,
  );

  drawDescriptor(targets.fields, view.descriptor);

  const list = targets.warnings;
  list.textContent = "";
  for (const w of view.warnings) {
    const li = document.createElement("li");
    li.dataset["severity"] = w.severity;
    li.textContent = w.message;
    list.appendChild(li);
  }
  if (findings !== undefined) drawFindings(list, findings);

  targets.authority.textContent = ADVISORY_NOTICE;
}

/**
 * Draw the rule engine's findings into a warnings list.
 *
 * Same list as `interpretTransaction`'s own warnings, on purpose: both are
 * host-side advisory judgements of exactly the same standing, and giving the
 * newer ones their own prettier box would be this app rating its own opinions.
 *
 * Two things this must never do, both of them from docs/ANTI-SCAM.md:
 *
 *   - Show anything green, ticked, or worded as a pass. The closing line drawn
 *     below says "had no opinion" when the list is empty, because "no findings"
 *     is a statement about this app's rules and not about the transaction, and
 *     a green tick that means "our scanner had no opinion" is worse than no
 *     tick at all.
 *   - Let the absence of that line be possible. `RULES_NOTICE` is appended
 *     whether or not there is anything above it, so a caller cannot draw the
 *     findings and quietly drop the caveat.
 *
 * Exported separately because the WalletConnect typed-data card has no
 * interpretation to render around it — a Permit is not a transaction — and it
 * needs the same rows, in the same shape, with the same closing line.
 */
export function drawFindings(list: HTMLElement, findings: readonly Finding[]): void {
  for (const f of findings) {
    const li = document.createElement("li");
    li.dataset["severity"] = f.severity;
    li.dataset["source"] = "rules";
    li.textContent = f.message;
    /* The subject on its own line, grouped in fours. For the Permit2 spender
     * this IS the finding — the sentence explains why the address matters, and
     * the address is the thing the user has to actually look at, so it gets
     * the same treatment a transfer recipient gets in the field list above. */
    if (f.subject !== undefined) {
      const code = document.createElement("code");
      code.className = "finding__subject";
      code.textContent = chunk(f.subject);
      li.append(document.createElement("br"), code);
    }
    list.appendChild(li);
  }

  const note = document.createElement("li");
  note.dataset["severity"] = "note";
  note.textContent = findings.length === 0
    ? `This app's rules had no opinion on this. ${RULES_NOTICE}`
    : RULES_NOTICE;
  list.appendChild(note);
}

/**
 * Draw the ERC-7730 descriptor block, in its own box, below the fields.
 *
 * It is a sibling of the field list rather than more rows inside it, because
 * the rows above come from the transaction itself and are the same facts the
 * device computes, and these do not: they are unsigned text from a public
 * registry that the device has never seen. Two sources of very different
 * standing in one `<dl>`, in one typeface, would be the app asserting they are
 * equally checked — the same failure PROTOCOL.md 6d describes for token
 * symbols. So this follows the pattern already set by the UNVERIFIED token
 * hint: separate box, the word UNVERIFIED on the box and (via CSS) on every
 * label in it, provenance named, and a closing sentence saying what it is.
 *
 * `textContent` throughout, never innerHTML: every string here is third-party.
 */
function drawDescriptor(fields: HTMLElement, match: DescriptorMatch | undefined): void {
  // Rebuilt from scratch each draw; a stale block left behind would describe
  // the previous transaction next to the current one's numbers.
  fields.parentElement?.querySelector(":scope > .unverified-desc")?.remove();
  if (!match) return;

  const box = document.createElement("section");
  box.className = "unverified-desc";

  const tag = document.createElement("div");
  tag.className = "unverified-desc__tag";
  tag.textContent = "UNVERIFIED — public contract description, not checked by the device";
  box.appendChild(tag);

  const intent = document.createElement("p");
  intent.className = "unverified-desc__intent";
  const who = match.owner ?? match.contractName;
  intent.textContent = who ? `${who}: ${match.intent}` : match.intent;
  box.appendChild(intent);

  const dl = document.createElement("dl");
  dl.className = "kv";
  const row = (label: string, text: string): void => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = text;
    dl.append(dt, dd);
  };
  for (const f of match.fields) row(f.label, f.value);
  // The function this claims to be, spelled out, so the reader can compare it
  // against the selector the device will show for an undecodable call.
  row("Claims to be", `${match.signature} (${match.selector})`);
  if (match.hiddenFields > 0 || match.omittedFields > 0) {
    row(
      "Not shown",
      `${match.hiddenFields} field(s) the description hides, ` +
        `${match.omittedFields} this app will not render. This list is incomplete.`,
    );
  }
  row("Source", match.source);
  box.appendChild(dl);

  /* Disagreements ride inside this box and are also raised as a warning by
   * interpretTransaction. Both, deliberately: the warning list is where a
   * hurried user looks, and the detail belongs next to the text it doubts. */
  if (match.conflicts.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "unverified-desc__conflicts";
    for (const c of match.conflicts) {
      const li = document.createElement("li");
      li.textContent = c;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  const notice = document.createElement("p");
  notice.className = "unverified-desc__notice";
  notice.textContent = DESCRIPTOR_NOTICE;
  box.appendChild(notice);

  fields.after(box);
}
