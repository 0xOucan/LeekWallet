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
 * `AppContext` carries an `EthRequest` and an address. It does not carry a
 * device client, a signer, or a transport, and that is a security boundary
 * rather than an oversight: a read-only app should be structurally incapable of
 * producing a signature, not merely disinclined to. An app that needs to sign
 * returns an unsigned transaction for the shell to put through the ordinary
 * device path — the same rule allowances.ts states for its remedies, for the
 * same reason: a code path in the companion that produces signatures without a
 * device confirmation is precisely the property this project exists not to
 * have.
 */

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
