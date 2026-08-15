/**
 * The WalletConnect project ID (T49).
 *
 * The relay will not accept a connection without one, so this is the single
 * value that decides whether dapp connectivity works at all. Two sources, in
 * order: whatever the user typed in settings, then the bundled default.
 *
 * This tree now ships a real bundled default, so dapp connectivity works out of
 * the box. It was empty for a long time on purpose, and that reasoning still
 * holds for anyone forking this: an invented ID fails at the relay with an
 * unhelpful error, and borrowing somebody else's means their quota is spent by
 * every user of your build. The ID below is this project's own, issued for it
 * at cloud.reown.com.
 *
 * A fork should replace it. The user override below exists for the same reason:
 * relay quota is per ID, so anyone running their own build at scale, or who
 * simply does not want their traffic pooled with everyone else's, sets their
 * own and it wins over this one.
 *
 * The ID is not a secret. It is a public client identifier that appears in the
 * relay URL of every WalletConnect wallet, and it grants nothing beyond relay
 * quota. That is why localStorage is an adequate home for the override, and why
 * this file does not pretend otherwise with any encryption theatre.
 */

/**
 * This project's own relay identifier, used unless the user sets their own.
 *
 * Kept as a constant rather than an environment variable so that what a build
 * contains is visible in the source rather than in someone's shell history.
 *
 * Not a secret, and not treated as one: a project ID travels in the relay URL
 * of every WalletConnect wallet, and it grants nothing but relay quota. The
 * only thing it can do is run out.
 */
export const BUNDLED_PROJECT_ID = "770c5799f9be7c042c87985be4b4a2f9";

/** Shown when nothing is configured. Also what a reviewer greps for. */
export const PROJECT_ID_PLACEHOLDER = "REPLACE_WITH_YOUR_WALLETCONNECT_PROJECT_ID";

const KEY = "leek.wc.projectId";

/** IDs are 32 lower-case hex characters. Checked so a paste error is caught here. */
const VALID = /^[0-9a-f]{32}$/;

export function isValidProjectId(id: string): boolean {
  return VALID.test(id.trim().toLowerCase());
}

/** The user's override, or "" when unset. */
export function storedProjectId(): string {
  return localStorage.getItem(KEY) ?? "";
}

/** Empty string clears the override and falls back to the bundled default. */
export function setStoredProjectId(id: string): void {
  const trimmed = id.trim().toLowerCase();
  if (trimmed === "") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, trimmed);
}

export interface ProjectIdState {
  id: string;
  source: "user" | "bundled" | "none";
  /** Non-empty when the app cannot connect, phrased for the user. */
  problem: string;
}

/**
 * Resolve what will actually be used, and why.
 *
 * Returns the problem as text rather than throwing: an unset project ID is an
 * ordinary state for a source build, and the UI should explain it in place
 * rather than surfacing an exception from inside the relay client.
 */
export function resolveProjectId(): ProjectIdState {
  const user = storedProjectId();
  if (isValidProjectId(user)) return { id: user, source: "user", problem: "" };
  if (user !== "") {
    return {
      id: "",
      source: "none",
      problem:
        "The project ID saved in settings is not 32 hex characters. " +
        "Copy it again from cloud.reown.com — it is the value labelled Project ID.",
    };
  }

  if (isValidProjectId(BUNDLED_PROJECT_ID)) {
    return { id: BUNDLED_PROJECT_ID, source: "bundled", problem: "" };
  }

  return {
    id: "",
    source: "none",
    problem:
      "This build has no WalletConnect project ID, so it cannot reach the relay. " +
      "Get a free one at cloud.reown.com (WalletConnect Cloud): sign in, create a project, " +
      "choose the WalletKit/Wallet type, and paste the Project ID below. " +
      "It is a public identifier, not a secret — it only meters relay traffic.",
  };
}
