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

  const list = targets.warnings;
  list.textContent = "";
  for (const w of view.warnings) {
    const li = document.createElement("li");
    li.dataset["severity"] = w.severity;
    li.textContent = w.message;
    list.appendChild(li);
  }

  targets.authority.textContent = ADVISORY_NOTICE;
}
