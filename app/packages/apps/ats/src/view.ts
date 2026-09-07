/**
 * Turning a `RegisterView` into text and DOM.
 *
 * Split from register.ts so the interesting half — which sentence a given
 * outcome produces — is a pure function a test can pin without a document.
 * `describeOutcome` is the single place where an outcome becomes words, which
 * is how "unavailable never reads as empty" stays true across a dozen fields
 * instead of being re-decided at each one.
 *
 * Rendering rules that are not style:
 *
 *   - Every unavailable field says so IN PLACE. Not a banner at the top, not a
 *     greyed-out zero: the cell where the number would have been.
 *   - Addresses are middle-truncated but always carry the full value in
 *     `title` and in the DOM, so a reader comparing against a block explorer
 *     is comparing the whole thing.
 *   - `name` and `symbol` come from the contract and are inserted with
 *     `textContent`, never markup. They are attacker-controlled strings on a
 *     screen full of numbers.
 */

import { formatUnits } from "@leekwallet/core/chains.ts";
import {
  maxSupplyIsCap, privilegedFreshness, registerProvenance,
  type ControlListView, type HolderRow, type Outcome, type RegisterView,
  type RoleRow, type SnapshotView,
} from "./register.ts";

/** What a field says when it is not `ok`. Never a number, never a blank. */
export function describeOutcome<T>(
  o: Outcome<T>,
  render: (value: T) => string,
  absent = "not supported by this security",
): string {
  switch (o.state) {
    case "ok":
      return render(o.value);
    case "unsupported":
      return absent;
    case "unavailable":
      // The reason is included because "unavailable" alone invites a reload
      // loop against an endpoint that is answering perfectly and refusing.
      return `unavailable — ${o.why}`;
  }
}

/** True when the outcome is one the UI must not let a reader treat as data. */
export const isUncertain = <T>(o: Outcome<T>): boolean => o.state !== "ok";

export const shortAddress = (a: string): string => `${a.slice(0, 8)}…${a.slice(-6)}`;

/** KYC as a word. An unknown code is shown as a code, never as "no". */
export function kycLabel(status: number): string {
  return status === 1 ? "granted" : status === 0 ? "not granted" : `unknown status ${status}`;
}

/**
 * Supply against cap, as one line.
 *
 * A cap of 0 means uncapped in the contracts. Rendering that as "0" would say
 * the security may not issue a single share, which is the opposite of true —
 * the kind of inversion that only shows up when someone acts on it.
 */
export function supplyLine(view: RegisterView): string {
  const decimals = view.decimals.state === "ok" ? view.decimals.value : 0;
  const fmt = (v: bigint): string => formatUnits(v, decimals);
  const supply = describeOutcome(view.totalSupply, fmt);
  const cap = describeOutcome(view.maxSupply, (v) => (maxSupplyIsCap(v) ? fmt(v) : "uncapped"));
  return `${supply} of ${cap}`;
}

/* ------------------------------------------------------------------- DOM */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (label: string, value: string, uncertain: boolean): HTMLElement => {
  const wrap = el("div", "ats-row");
  wrap.appendChild(el("span", "ats-muted", label));
  const v = el("span", uncertain ? "ats-uncertain" : undefined, value);
  wrap.appendChild(v);
  return wrap;
};

function addressCell(address: string): HTMLElement {
  const span = el("span", "ats-address", shortAddress(address));
  span.title = address;
  // The full value in a data attribute as well, so copying the DOM (which is
  // what a bug report does) carries the address rather than the ellipsis.
  span.dataset["address"] = address;
  return span;
}

function holdersSection(view: RegisterView): HTMLElement {
  const section = el("section", "ats-panel");
  section.appendChild(el("h4", undefined, "Holders"));
  section.appendChild(
    row("Registered holders", describeOutcome(view.holderCount, (v) => String(v)),
        isUncertain(view.holderCount)),
  );

  if (view.holders.state !== "ok") {
    // The whole point: no table, and no "0 holders". A sentence saying we do
    // not know, where the table would have been.
    section.appendChild(el("p", "ats-notice",
      describeOutcome(view.holders, () => "")));
    return section;
  }
  if (view.holders.value.length === 0) {
    section.appendChild(el("p", "ats-muted", "The register is empty — nobody holds this security."));
    return section;
  }

  const decimals = view.decimals.state === "ok" ? view.decimals.value : 0;
  const table = el("table", "ats-table");
  const head = el("tr");
  for (const h of ["Holder", "Balance", "KYC", "Control list"]) {
    head.appendChild(el("th", undefined, h));
  }
  table.appendChild(head);
  for (const holder of view.holders.value) {
    table.appendChild(holderRow(holder, decimals, view.controlList));
  }
  section.appendChild(table);
  if (view.holdersTruncated) {
    section.appendChild(el("p", "ats-muted",
      "More holders exist than were fetched; this is the first page."));
  }
  return section;
}

function holderRow(
  holder: HolderRow, decimals: number, controlList: Outcome<ControlListView>,
): HTMLElement {
  const tr = el("tr");
  const first = el("td");
  first.appendChild(addressCell(holder.address));
  tr.appendChild(first);
  tr.appendChild(el("td", undefined,
    describeOutcome(holder.balance, (v) => formatUnits(v, decimals))));
  tr.appendChild(el("td", undefined, describeOutcome(holder.kycStatus, kycLabel)));
  // The same bit means opposite things depending on the list's type, so the
  // type has to be in hand to say what it means. Without it, say the bit.
  tr.appendChild(el("td", undefined, describeOutcome(holder.inControlList, (inList) => {
    if (controlList.state !== "ok") return inList ? "listed" : "not listed";
    return controlList.value.whitelist
      ? inList ? "allowed" : "NOT allowed"
      : inList ? "BLOCKED" : "not blocked";
  })));
  return tr;
}

function rolesSection(roles: Outcome<RoleRow[]>): HTMLElement {
  const section = el("section", "ats-panel");
  section.appendChild(el("h4", undefined, "Roles"));
  if (roles.state !== "ok") {
    section.appendChild(el("p", "ats-notice", describeOutcome(roles, () => "")));
    return section;
  }
  // Only roles that are held, or whose membership could not be read. Listing
  // thirty-seven empty rows buries the two that matter.
  const shown = roles.value.filter(
    (r) => isUncertain(r.memberCount) || (r.memberCount.state === "ok" && r.memberCount.value > 0n),
  );
  if (shown.length === 0) {
    section.appendChild(el("p", "ats-muted", "No role has any member."));
    return section;
  }
  for (const r of shown) {
    const name = "name" in r.role ? r.role.name : r.role.id;
    const privileged = "privileged" in r.role && r.role.privileged;
    const line = el("div", "ats-row");
    line.appendChild(el("span", privileged ? "ats-privileged" : "ats-muted",
      privileged ? `${name} (privileged)` : name));
    if (r.members.state === "ok") {
      for (const m of r.members.value) line.appendChild(addressCell(m));
      if (r.members.value.length === 0) line.appendChild(el("span", "ats-muted", "no members"));
    } else {
      line.appendChild(el("span", "ats-uncertain", describeOutcome(r.members, () => "")));
    }
    section.appendChild(line);
  }
  return section;
}

function snapshotsSection(snapshots: Outcome<SnapshotView>, decimals: number): HTMLElement {
  const section = el("section", "ats-panel");
  section.appendChild(el("h4", undefined, "Snapshots"));
  section.appendChild(el("p", "ats-muted",
    "A snapshot freezes every balance at one instant. A distribution paid " +
    "against a snapshot can be reconciled exactly; one paid against live " +
    "balances cannot."));
  if (snapshots.state !== "ok") {
    section.appendChild(el("p", "ats-notice",
      describeOutcome(snapshots, () => "", "this security has no snapshot facet")));
    return section;
  }
  if (snapshots.value.rows.length === 0) {
    section.appendChild(el("p", "ats-muted", "No snapshot has been taken."));
    return section;
  }
  const table = el("table", "ats-table");
  const head = el("tr");
  for (const h of ["#", "Total supply", "Holders"]) head.appendChild(el("th", undefined, h));
  table.appendChild(head);
  for (const s of snapshots.value.rows) {
    const tr = el("tr");
    tr.appendChild(el("td", undefined, String(s.id)));
    tr.appendChild(el("td", undefined,
      describeOutcome(s.totalSupply, (v) => formatUnits(v, decimals))));
    tr.appendChild(el("td", undefined, describeOutcome(s.holderCount, (v) => String(v))));
    table.appendChild(tr);
  }
  section.appendChild(table);
  if (snapshots.value.truncated) {
    // "At least", never a count. An issuer reconciling against what they think
    // is the last snapshot, when it is not, distributes against the wrong set.
    section.appendChild(el("p", "ats-notice",
      `At least ${snapshots.value.rows.length} snapshots — the scan stopped ` +
      "before reaching the end, so this list is not known to be complete."));
  }
  return section;
}

/** The whole dashboard, rebuilt from scratch. Never patched in place. */
export function renderRegister(view: RegisterView, now: number, notice?: string): HTMLElement {
  const root = el("div", "ats-panel");
  if (notice !== undefined) root.appendChild(el("p", "ats-notice", notice));

  const title = el("h3");
  const name = view.name.state === "ok" ? view.name.value : undefined;
  const symbol = view.symbol.state === "ok" ? view.symbol.value : undefined;
  title.textContent = name ?? shortAddress(view.address);
  if (symbol !== undefined) title.appendChild(el("span", "ats-muted", symbol));
  root.appendChild(title);

  const addressLine = el("p", "ats-muted");
  addressLine.appendChild(document.createTextNode("Security "));
  addressLine.appendChild(addressCell(view.address));
  addressLine.appendChild(document.createTextNode(` on chain ${view.chainId}`));
  root.appendChild(addressLine);

  // Provenance sits directly under the heading, above every figure it dates.
  // A timestamp at the bottom of a long page is a timestamp nobody reads, and
  // this one is what stops a revoked role being believed.
  const fresh = privilegedFreshness(view, now);
  root.appendChild(el("p", fresh.stale ? "ats-notice" : "ats-muted",
    registerProvenance(view, now)));

  root.appendChild(row("Supply", supplyLine(view),
    isUncertain(view.totalSupply) || isUncertain(view.maxSupply)));
  root.appendChild(row("Paused", describeOutcome(view.paused, (v) => (v ? "YES — transfers are halted" : "no")),
    isUncertain(view.paused)));
  root.appendChild(row("Internal KYC", describeOutcome(view.internalKyc, (v) => (v ? "on" : "off")),
    isUncertain(view.internalKyc)));
  root.appendChild(row("Control list",
    describeOutcome(view.controlList, (c) =>
      `${c.whitelist ? "allowlist" : "blocklist"}, ${c.count} member(s)${c.truncated ? " (first page shown)" : ""}`),
    isUncertain(view.controlList)));

  root.appendChild(holdersSection(view));
  root.appendChild(rolesSection(view.roles));
  root.appendChild(snapshotsSection(view.snapshots,
    view.decimals.state === "ok" ? view.decimals.value : 0));
  return root;
}
