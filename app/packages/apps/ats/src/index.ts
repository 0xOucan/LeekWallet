/**
 * The Hedera ATS issuer console, as one object the shell can mount and delete.
 *
 * ---------------------------------------------------------------------------
 * How to remove this app from a release build
 *
 *     rm -rf app/packages/apps/ats
 *     # drop the import and the array entry in app/src/apps/registry.ts
 *     # drop "@leekwallet/app-ats" from app/package.json dependencies
 *     pnpm --dir app install && pnpm --dir app typecheck && pnpm --dir app build
 *
 * That is the whole procedure. It was run at E2 — typecheck, build and
 * `app/test/apps.test.ts` all passed with this app absent. Not a flag that
 * hides a screen; an actual absence from the bundle.
 *
 * E3 added a devDependency on `@hashgraph/asset-tokenization-contracts` for
 * `test/conformance.test.ts`, and it was put in THIS package's manifest rather
 * than the workspace's precisely so the count stays at three: it is inside the
 * directory that gets deleted. That has not been re-verified by deleting the
 * directory again — what was checked is that nothing outside this package
 * mentions either `app-ats` or the contracts package, other than the two edits
 * named above.
 *
 * Three edits rather than the two `packages/apps/README.md` describes, because
 * the shell also names the app as a workspace dependency and `pnpm install`
 * fails on a dependency whose package is gone. That is a feature of the same
 * kind as the static registry import: the removal is refused loudly at install
 * time rather than half-done quietly.
 *
 * The rules that keep it to those edits are asserted by `apps.test.ts`; the
 * one worth repeating is that this app imports `@leekwallet/core` and no other
 * app, ever.
 *
 * This was got wrong once, in a way worth recording because the mistake looked
 * like the fix. The manifest type was first declared here and re-exported by
 * the shell registry, and deleting this directory then left the shell
 * referring to a type that no longer existed — the removal procedure broke the
 * build. Moving the declaration to `app/src/apps/types.ts` fixed that and
 * introduced a subtler version of the same error: a package under
 * `packages/apps/` reached up into `app/src/`, so the app could not build
 * without the shell and the dependency arrow pointed backwards. The contract
 * belongs in `@leekwallet/core/mini-app.ts`, where no app owns it and every
 * app may import it. `MiniApp` and `AppContext` come from there below.
 *
 * The chain-296 entry in `packages/core/src/chains.ts` and its two CSP origins
 * deliberately do NOT come out with this directory. A chain is a wallet
 * capability, not an app's private resource.
 *
 * ---------------------------------------------------------------------------
 * Scope
 *
 * Read-only (milestones E1–E2 of docs/apps/HEDERA-ATS.md). It renders the
 * register; it signs nothing, and `AppContext` gives it nothing it could sign
 * with.
 *
 * `descriptors.ts` and `action.ts` say what a `grantRole`, `pause` or
 * `revokeKyc` screen SAYS, and — more to the point — when there is no honest
 * screen and the call must refuse. `act.ts` (E3) connects that to
 * `AppContext.propose`, and `act-view.ts` is the form. The order those were
 * written in is the order they are listed: the screen existed and was reviewed
 * before any button could reach it, because shipping the button first is the
 * exact failure the plan is written to avoid.
 *
 * This app still holds no device, no key and no transport. It can ask; the
 * shell screens the ask a second time, the device draws it, and a human presses
 * a button.
 *
 * `dividend.ts` and `dividend-view.ts` (E4 / C3) add the one lifecycle
 * operation: a dividend declared against a snapshot, refused unless its total
 * equals per-share × snapshot supply, and paid out one holder and one press at
 * a time against a record that makes the payout resumable. `docs/ATS.md` is the
 * written half of it.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import { FIXTURE_ADDRESS, FIXTURE_NOTICE, fixtureRequest } from "./fixtures.ts";
import { readRegister, type RegisterView } from "./register.ts";
import { renderRegister } from "./view.ts";
import { atsDescriptors } from "./descriptors.ts";
import { factsFrom, renderPrivilegedPanel } from "./act-view.ts";
import { renderDistributionPanel } from "./dividend-view.ts";
import {
  KNOWN_SECURITIES, RETIRED_SECURITIES, SECURITY_LABEL_NOTICE, retiredAt,
} from "./securities.ts";
import { ATS_MARKET, marketDescriptors, securityApproveDescriptors } from "./market.ts";
import { renderMarketPanel } from "./market-view.ts";
import { renderDiscoverPanel, renderIssuePanel } from "./issue-view.ts";
import { renderHoldingsPanel } from "./mint-view.ts";
import { securityTransferDescriptors } from "./holdings.ts";
import { mergeSecurities, type SecurityChoice } from "./discover.ts";

export * from "./abi.ts";
export * from "./roles.ts";
export * from "./register.ts";
export * from "./view.ts";
export * from "./fixtures.ts";
export * from "./descriptors.ts";
export * from "./action.ts";
export * from "./dividend.ts";
export * from "./act.ts";
export * from "./act-view.ts";
export * from "./dividend-view.ts";
export * from "./securities.ts";
export * from "./market.ts";
export * from "./market-view.ts";
export * from "./market-app.ts";
export * from "./issue.ts";
export * from "./discover.ts";
export * from "./holdings.ts";
export * from "./recipients.ts";
export * from "./issue-view.ts";
export * from "./mint-view.ts";

/** The chain this app is about. Hedera testnet; see chains.ts for the entry. */
export const ATS_CHAIN_ID = 296;

/**
 * Class names are all `ats-` prefixed.
 *
 * Not a convention — a requirement. The shell injects every app's stylesheet
 * into one document, so an unprefixed `.row` here would restyle the wallet and
 * every other app. Carried as a string so that deleting this directory deletes
 * the CSS with it; a rule left in the shell's styles.css would be dead weight
 * nobody could attribute to anything.
 */
import { ATS_CSS } from "./css.ts";

/**
 * State the panel holds between renders.
 *
 * One field, and it is the whole view. There is no per-field cache, and no
 * merge step — see the freshness section of register.ts. A refresh either
 * produces a complete new view or leaves the previous one visibly dated; it
 * can never produce a view whose role list is from one read and whose supply
 * is from another.
 */
interface PanelState {
  view: RegisterView | undefined;
  /** True while a read is in flight, so the button cannot stack requests. */
  busy: boolean;
  /** Set when the panel is reading the built-in fixture rather than a chain. */
  fixture: boolean;
  /** Set when the address being read is a pilot that cannot be used. */
  retired: { symbol: string; address: string; why: string } | undefined;
}

/**
 * Build the panel.
 *
 * Split from `mount` so a test can drive it without the registry, and so the
 * disposer is expressible: `MiniApp.mount` returns `Promise<void>` rather than
 * a teardown function, and the shell's contract is that the app owns `root` and
 * the shell clears it. Everything here hangs off `root`, so clearing it is the
 * teardown.
 */
export function buildPanel(root: HTMLElement, context: AppContext): void {
  const state: PanelState = {
    view: undefined, busy: false, fixture: false, retired: undefined,
  };
  root.replaceChildren();

  const controls = document.createElement("div");
  controls.className = "ats-chooser";
  /* The four real securities, by name, and the fixture beside them labelled as
   * what it is. The address field stays and is still the only thing that
   * decides which contract is read — what changed is the default, which used to
   * be "the fixture or nothing". See securities.ts. */
  const chooser = document.createElement("select");
  chooser.setAttribute("aria-label", "Security to read");
  for (const s of KNOWN_SECURITIES) {
    const opt = document.createElement("option");
    opt.value = s.address;
    opt.textContent = `${s.symbol} — ${s.name}`;
    chooser.append(opt);
  }
  for (const s of RETIRED_SECURITIES) {
    const opt = document.createElement("option");
    opt.value = s.address;
    opt.className = "ats-demo";
    opt.textContent = `RETIRED — ${s.symbol} (cannot be minted)`;
    chooser.append(opt);
  }
  {
    const opt = document.createElement("option");
    opt.value = FIXTURE_ADDRESS;
    opt.className = "ats-demo";
    opt.textContent = "DEMO — built-in fixture (not a chain read)";
    chooser.append(opt);
  }
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "0x… security address";
  input.setAttribute("aria-label", "ATS security address on Hedera testnet");
  input.value = KNOWN_SECURITIES[0]?.address ?? "";
  chooser.addEventListener("change", () => { input.value = chooser.value; });
  const load = document.createElement("button");
  load.textContent = "Read register";
  const demo = document.createElement("button");
  demo.className = "ghost";
  demo.textContent = "Load fixture";
  demo.title = "A constructed example, not a chain read";
  const out = document.createElement("div");
  out.className = "ats-panel";
  controls.append(chooser, input, load, demo);
  const labels = document.createElement("p");
  labels.className = "ats-muted";
  labels.textContent = SECURITY_LABEL_NOTICE;
  const retired = document.createElement("p");
  retired.className = "ats-notice";
  const paintRetired = (): void => {
    const dead = state.retired;
    retired.hidden = dead === undefined;
    retired.textContent = dead === undefined ? "" : `${dead.symbol} ${dead.address}: ${dead.why}`;
  };
  /* The issue / discover / holdings half sits ABOVE the register controls,
   * because it is where a user arrives: "what can I act on, and what do I
   * hold". The register, the privileged form, the distribution panel and the
   * market all hang off one address, and choosing that address is what this
   * half is for. It is filled in below, once `read` exists — a row in it can
   * load a security into the console, and that is the console's own function. */
  const top = document.createElement("div");
  top.className = "ats-panel";
  root.append(top, controls, labels, retired, out);
  paintRetired();

  const paint = (): void => {
    out.replaceChildren();
    if (state.view === undefined) {
      const p = document.createElement("p");
      p.className = "ats-muted";
      p.textContent = state.busy
        ? "Reading the register…"
        : "Enter a security address, or load the fixture to see the shape of it.";
      out.append(p);
      return;
    }
    out.append(
      renderRegister(state.view, Date.now(), state.fixture ? FIXTURE_NOTICE : undefined),
    );
    /* The write half only exists once a read has produced facts for it: the
     * security's name, its decimals and the direction of its control list all
     * come from the register, never from the form. A console that offered to
     * freeze a holder before it had read the security would be describing a
     * contract it had never looked at. */
    renderPrivilegedPanel(out, state.view, context);
    /* The distribution panel needs everything the privileged form needs and a
     * snapshot besides, so it comes after it and reads the same facts. */
    renderDistributionPanel(out, state.view, factsFrom(state.view), context);
    /* The market is last: what a lot is worth is a decision made against the
     * register above it, and a sell form above the holder list would be a form
     * filled in without reading one. The fixture never reaches it — there is no
     * escrow market behind a constructed example, and a market panel drawing
     * fixture prices would be the one screen where FIXTURE_NOTICE stopped being
     * enough. */
    if (!state.fixture) renderMarketPanel(out, state.view, context);
  };

  const read = async (address: string, request: EthRequest, fixture: boolean): Promise<void> => {
    if (state.busy) return;
    /* A retired pilot is read like any other — the register is real — but the
     * panel says what cannot be done with it, and keeps saying it: the notice
     * lives above `out`, which every repaint clears. */
    state.retired = retiredAt(address);
    state.busy = true;
    state.fixture = fixture;
    // The old view goes as soon as a new read starts. Leaving it up while the
    // new one loads is how a screen ends up showing a role that was revoked
    // thirty seconds ago as if it were current.
    state.view = undefined;
    load.disabled = true;
    paintRetired();
    paint();
    try {
      state.view = await readRegister(
        request,
        fixture ? ATS_CHAIN_ID : context.chainId,
        address,
        // The getter, not a captured string: which operator answered is not
        // known until a request has been made, and failover can change it
        // mid-read. See AppContext.endpointHost in core.
        fixture ? () => "fixture" : (context.endpointHost ?? (() => undefined)),
      );
    } catch (e) {
      const p = document.createElement("p");
      p.className = "ats-notice";
      // A throw out of readRegister means the address itself was rejected,
      // before anything went to the network. Everything else is an Outcome.
      p.textContent = `Could not read that address: ${String((e as Error)?.message ?? e)}`;
      out.replaceChildren(p);
      return;
    } finally {
      state.busy = false;
      load.disabled = false;
    }
    paint();
  };

  /* The merged list, held here rather than inside either panel: the discovery
   * panel produces it and the holdings panel consumes it, and neither should
   * own a copy the other cannot see. It starts as the hard-coded table alone —
   * never as an empty list, which would read as "nothing to act on". */
  let choices: readonly SecurityChoice[] = mergeSecurities(
    { ok: false, reason: "logs-unavailable", why: "not scanned yet" },
  );
  const select = (address: string): void => {
    input.value = address;
    chooser.value = address;
    void read(address, context.request, false);
  };
  renderIssuePanel(top, context);
  renderDiscoverPanel(top, context, select, (next) => { choices = next; });
  renderHoldingsPanel(top, context, () => choices, select);

  load.addEventListener("click", () => void read(input.value.trim(), context.request, false));
  demo.addEventListener("click", () => {
    input.value = FIXTURE_ADDRESS;
    void read(FIXTURE_ADDRESS, fixtureRequest(), true);
  });
  paint();
}

/** The manifest the registry lists. The only export the shell needs. */
export const ATS_APP: MiniApp = {
  id: "ats",
  name: "Issuer console",
  summary:
    "The register of a Hedera Asset Tokenization Studio security: holders, " +
    "supply, roles, KYC, control list and snapshots.",
  chainIds: [ATS_CHAIN_ID],
  css: ATS_CSS,
  /* Evidence, not authority. Every ATS security is a fresh diamond at a fresh
   * address, so its descriptors cannot be a constant in core and have to be
   * built around the address in front of the user — which is the case
   * `MiniApp.descriptors` exists for. Core still judges what comes back: every
   * argument must render and the reading must not disagree with the firmware's
   * own decoder. See mini-app.ts. */
  /* Three descriptor sets, chosen by what is being called, never merged: the
   * privileged table (built around the security's address, because every
   * issuance is a fresh diamond), the escrow market's own three calls (one
   * constant address), and the plain ERC-20 approve a listing needs first. An
   * approval folded into the privileged table would owe a consequence line
   * about an issuer power it does not confer — see market.ts. */
  descriptors: (chainId, to) =>
    to.toLowerCase() === ATS_MARKET
      ? marketDescriptors(chainId, to)
      : [
          ...atsDescriptors(chainId, to),
          ...securityApproveDescriptors(chainId, to),
          /* A plain `transfer` of shares. Not privileged, so not in the ATS
           * table — holdings.ts says why — and it still needs a descriptor,
           * because without one `screenProposal` refuses and nothing is sent. */
          ...securityTransferDescriptors(chainId, to),
        ],
  async mount(root, context) {
    if (context.chainId !== ATS_CHAIN_ID) {
      /* Refused rather than rendered empty. Reading an ATS security over a
       * different chain's endpoint would produce a confidently empty register,
       * which is the one thing this app is built not to show. */
      root.replaceChildren();
      const p = document.createElement("p");
      p.className = "ats-uncertain";
      p.textContent =
        `This console reads Hedera testnet (chain ${ATS_CHAIN_ID}); ` +
        `the wallet is on chain ${context.chainId}.`;
      root.append(p);
      return;
    }
    buildPanel(root, context);
  },
};

export default ATS_APP;
