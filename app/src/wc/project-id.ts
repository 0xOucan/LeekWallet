/**
 * The WalletConnect project ID (T49).
 *
 * The relay will not accept a connection without one, so this is the single
 * value that decides whether dapp connectivity works at all. Two sources, in
 * order: whatever the user typed in settings, then the bundled default.
 *
 * **There is no bundled default in this tree, on purpose.** A project ID is
 * issued to a person or an organisation at cloud.reown.com and is rate-limited
 * per ID; committing one invented here would either be a fake string that fails
 * at the relay with an unhelpful error, or somebody else's real ID being spent
 * by every user of this app. So `BUNDLED_PROJECT_ID` is empty, the app says so
 * plainly instead of failing at connect time, and whoever ships a build fills
 * it in — see app/README.md.
 *
 * The ID is not a secret. It is a public client identifier that appears in the
 * relay URL of every WalletConnect wallet, and it grants nothing beyond relay
 * quota. That is why localStorage is an adequate home for the override, and why
 * this file does not pretend otherwise with any encryption theatre.
 */

/**
 * Filled in by whoever builds a release. Empty here.
 *
 * Kept as a constant rather than an environment variable so that what a build
 * contains is visible in the source rather than in someone's shell history.
 */
export const BUNDLED_PROJECT_ID = "";

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
