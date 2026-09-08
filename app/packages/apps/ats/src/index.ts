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
 * That is the whole procedure, and it was run: typecheck, build and
 * `app/test/apps.test.ts` all pass with this app absent. Not a flag that hides
 * a screen — an actual absence from the bundle.
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
 * a button. Dividends are E4 and remain absent.
 */

import type { AppContext, MiniApp } from "@leekwallet/core/mini-app.ts";
import type { EthRequest } from "@leekwallet/core/balances.ts";
import { FIXTURE_ADDRESS, FIXTURE_NOTICE, fixtureRequest } from "./fixtures.ts";
import { readRegister, type RegisterView } from "./register.ts";
import { renderRegister } from "./view.ts";
import { atsDescriptors } from "./descriptors.ts";
import { renderPrivilegedPanel } from "./act-view.ts";

export * from "./abi.ts";
export * from "./roles.ts";
export * from "./register.ts";
export * from "./view.ts";
export * from "./fixtures.ts";
export * from "./descriptors.ts";
export * from "./action.ts";
export * from "./act.ts";
export * from "./act-view.ts";

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
const CSS = `
.ats-panel { display: flex; flex-direction: column; gap: 0.5rem; }
.ats-panel h3 { margin: 0.75rem 0 0; }
.ats-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: baseline; }
.ats-label { min-width: 11rem; opacity: 0.75; }
.ats-address { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ats-table { border-collapse: collapse; width: 100%; }
.ats-table th, .ats-table td {
  text-align: left; padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--border, #444);
}
.ats-muted { opacity: 0.7; font-size: 0.9em; }
.ats-privileged { font-weight: 700; }
/* "Unavailable" must not be mistakable for a value at a glance, which is
   exactly what a greyed-out zero would be. It gets an italic, dotted treatment
   no real figure ever has, so the difference survives a quick read. */
.ats-uncertain {
  color: var(--warn, #b58900); font-style: italic;
  border-bottom: 2px dotted currentColor;
}
.ats-alarm { color: var(--danger, #dc322f); font-weight: 700; }
.ats-notice {
  border: 1px solid var(--danger, #dc322f); border-radius: 6px;
  padding: 0.4rem 0.6rem; font-size: 0.9em;
}
/* The preview of what the device is about to draw. Framed so it reads as a
   quotation of another screen rather than as this one's own assertion — it is
   host text, and the notice inside it says so. */
.ats-screen {
  border: 1px solid var(--border, #444); border-radius: 6px;
  padding: 0.6rem 0.8rem; margin: 0.5rem 0;
}
.ats-screen-title { font-weight: 700; letter-spacing: 0.03em; margin-bottom: 0.4rem; }
`;

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
  const state: PanelState = { view: undefined, busy: false, fixture: false };
  root.replaceChildren();

  const controls = document.createElement("div");
  controls.className = "ats-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "0x… security address";
  input.setAttribute("aria-label", "ATS security address on Hedera testnet");
  const load = document.createElement("button");
  load.textContent = "Read register";
  const demo = document.createElement("button");
  demo.className = "ghost";
  demo.textContent = "Load fixture";
  demo.title = "A constructed example, not a chain read";
  const out = document.createElement("div");
  out.className = "ats-panel";
  controls.append(input, load, demo);
  root.append(controls, out);

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
  };

  const read = async (address: string, request: EthRequest, fixture: boolean): Promise<void> => {
    if (state.busy) return;
    state.busy = true;
    state.fixture = fixture;
    // The old view goes as soon as a new read starts. Leaving it up while the
    // new one loads is how a screen ends up showing a role that was revoked
    // thirty seconds ago as if it were current.
    state.view = undefined;
    load.disabled = true;
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
  css: CSS,
  /* Evidence, not authority. Every ATS security is a fresh diamond at a fresh
   * address, so its descriptors cannot be a constant in core and have to be
   * built around the address in front of the user — which is the case
   * `MiniApp.descriptors` exists for. Core still judges what comes back: every
   * argument must render and the reading must not disagree with the firmware's
   * own decoder. See mini-app.ts. */
  descriptors: (chainId, to) => atsDescriptors(chainId, to),
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
