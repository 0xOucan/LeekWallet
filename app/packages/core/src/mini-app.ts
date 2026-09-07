/**
 * The contract a mini-app implements, and nothing else.
 *
 * Types only — there is no runtime here, deliberately. A "framework" with
 * behaviour in it becomes a thing apps depend on the version of, and the whole
 * property being defended is that any single app can be deleted from a release
 * without the others noticing.
 *
 * ---------------------------------------------------------------------------
 * Why this lives in core rather than in an app
 *
 * The first version of this file was inside `packages/apps/aqua`, and the shell
 * registry imported `MiniApp` from there. That quietly made every other app
 * depend on Aqua: deleting Aqua for a release would have broken the build of
 * apps that never mentioned it. The contract has to sit somewhere no app owns,
 * and core is already the one package every app is allowed to import.
 *
 * The dependency graph an app must not violate:
 *
 *     src/apps/registry.ts  ->  each app  ->  @leekwallet/core
 *
 * Never app -> app, and never shell -> app except through the registry. Those
 * two rules are what make "delete the directory and one registry line" the
 * complete removal procedure. See packages/apps/README.md.
 *
 * ---------------------------------------------------------------------------
 * What an app is NOT given
 *
 * `AppContext` carries an `EthRequest`, an address, and a way to *propose*. It
 * does not carry a device client, a signer, a transport or a key, and that is a
 * security boundary rather than an oversight: an app should be structurally
 * incapable of producing a signature, not merely disinclined to.
 *
 * `propose` is not a hole in that. It hands the shell an intent and returns an
 * outcome; the shell decides the signer, the chain, the fees and whether
 * anything is broadcast, and the device draws and confirms the payload before a
 * signature exists. An app holds the ability to ask, never the ability to sign
 * — the difference between the two is set out at length in app-proposal.ts, and
 * the rule it enforces is that a payload nothing can describe in words is
 * refused before it reaches the device.
 *
 * The earlier version of this file said an app gets no signing path at all and
 * should hand back an unsigned transaction for the shell to route. That was the
 * right instinct with no seam to express it: every app that needed a signature
 * would have grown its own arrangement with the shell, and one of them would
 * have been sloppier than the others. One reviewed seam beats three
 * improvisations.
 */

import type { AppProposal, ProposalOutcome } from "./app-proposal.ts";
import type { EthRequest } from "./balances.ts";

/** Everything the shell hands an app when it mounts one. */
export interface AppContext {
  /** The chain the shell is on. An app is only mounted on a chain it listed. */
  chainId: number;
  /** The address being viewed. Never a key, and never a way to get one. */
  address: string;
  /**
   * A read path to the chain, already subject to the shell's failover and
   * endpoint policy (rpc.ts). An app must not construct its own: doing so would
   * route around the user's chosen endpoint and the CSP allowlist with it.
   */
  request: EthRequest;
  /**
   * Host of the endpoint that most recently answered, or undefined before any
   * has. Optional: an app that never dates its figures does not need it.
   *
   * A function rather than a string, and that is the whole point of it. Which
   * operator answers is not knowable at mount — no request has been made yet —
   * and it can change mid-session, because `FailoverRpc` moves to the next
   * endpoint when one goes quiet (rpc.ts, limit 2: whoever answers learns which
   * addresses you asked about, so which one it was has to be visible rather
   * than implicit). A string captured at mount would be either empty or, worse,
   * stale: a provenance line naming an operator that stopped answering three
   * requests ago is a false statement about who saw your data.
   *
   * So it is a getter, called when a figure is rendered rather than when the
   * app starts. Added for the ATS issuer console, whose whole discipline is
   * that no number reaches a screen without the block, the age and the operator
   * arriving beside it.
   */
  endpointHost?: () => string | undefined;
  /**
   * Ask the shell to put a payload in front of the user and, if they agree,
   * through the device.
   *
   * Optional, and absence is a real state rather than a legacy allowance: a
   * shell with no device connected, or a test harness, supplies no `propose`,
   * and an app must say so rather than pretend. An app that never signs simply
   * never calls it.
   *
   * Everything about what may be proposed, what the shell fills in, and why the
   * refusal an app sees is indistinguishable from a user's rejection is in
   * app-proposal.ts. The one line worth repeating here: this returns a result,
   * not a signing capability, and every call costs one press on the hardware.
   */
  propose?: (proposal: AppProposal) => Promise<ProposalOutcome>;

  /**
   * A read path to a chain other than the one the shell is on, or undefined
   * for a chain the shell cannot reach.
   *
   * Optional, and the honest answer is allowed to be "no". An app must not
   * construct its own client — doing so routes around the user's chosen
   * endpoint, the failover policy and the CSP allowlist — so this is the only
   * way an app can read a second chain, and the shell decides which ones it
   * will offer.
   *
   * Added for La Caja, which takes payment on nine chains at once: the
   * customer pays from whichever chain they already hold USDC on, and the
   * terminal has to watch all of them. An app given `undefined` for a chain
   * must render that chain as *not looked at*, never as *nothing there* — the
   * two are different facts and only one of them is safe to tell a customer.
   */
  requestOn?: (chainId: number) => ChainChannel | undefined;
}

/** A read path to one chain, and whoever most recently answered on it. */
export interface ChainChannel {
  request: EthRequest;
  endpointHost?: () => string | undefined;
}

/**
 * One mini-app.
 *
 * An object, not a class and not a module namespace, so that the registry entry
 * is one value and removal is one line.
 */
export interface MiniApp {
  /** Stable, lower-case, unique. Used for the injected stylesheet's element id. */
  id: string;
  /** Shown in whatever list offers the app. */
  name: string;
  /** One line: what the app shows, in the words a user would use. */
  summary: string;
  /**
   * Chains the app is willing to be opened on. The app decides, not the shell:
   * only the app knows where its contracts are deployed, and a shell-side list
   * would be a second copy of that knowledge, free to drift.
   */
  chainIds: readonly number[];
  /**
   * The app's stylesheet, as a string.
   *
   * Carried by the app rather than written into the shell's styles.css so that
   * deleting the directory deletes the CSS too. A rule left behind in a shared
   * stylesheet is dead weight nobody can attribute to anything.
   *
   * Class names must be prefixed with the app's id — the shell injects these
   * into one document and two apps sharing a class name would style each other.
   */
  css: string;
  /**
   * Render into `root`, which the app owns and may clear.
   *
   * Rejecting is allowed and is the honest outcome when the app cannot say
   * anything true; the shell renders the failure. What is not allowed is
   * rendering an empty or zero state when the reason is that a lookup failed.
   */
  mount(root: HTMLElement, context: AppContext): Promise<void>;
}
