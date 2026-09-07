/**
 * The shell half of the proposal seam: an app's intent → the card it already
 * had → the device.
 *
 * `packages/core/src/app-proposal.ts` decides whether a payload is describable;
 * this file decides nothing. It stamps in the facts an app is not allowed to
 * choose, turns a screened proposal into the same `RequestPlan` a dapp request
 * becomes, and hands it to `review()` — the WalletConnect card's own queue. One
 * review-and-sign path, and this is not a second one: no `client`, no
 * transport and no signing call appears below, and the only thing an app's
 * intent can reach is a function that draws a card and waits for a press.
 *
 * The alternative that was rejected: give apps their own approval dialog. It
 * would have been less plumbing and it would have meant two screens where a
 * user learns what they are about to sign, drifting apart from each other,
 * with the rules (`rules.ts`), the interpretation preview and the approval
 * editor implemented once on the dapp side and forgotten on the app side.
 */

import { getChain } from "@leekwallet/core/chains.ts";
import {
  declined, screenProposal,
  type AppProposal, type ProposalOutcome, type ScreenedProposal,
} from "@leekwallet/core/app-proposal.ts";
import type { RequestPlan } from "../wc/requests.ts";
import type { LocalRequest } from "../wc/ui.ts";

/** What the proposer needs from the shell, as functions so nothing goes stale. */
export interface ProposeHost {
  /** The chain the shell is on *now*, not when the app mounted. */
  chainId(): number;
  /** The address the shell is showing now. Empty when locked. */
  address(): string;
  /** Put a planned request on the review card and wait. */
  review(request: LocalRequest): Promise<unknown>;
  log(line: string): void;
}

/** A screened proposal in the shape the card and the signing path already take. */
function planOf(screened: ScreenedProposal): RequestPlan {
  if (screened.kind === "call") {
    return {
      kind: "transaction",
      /* Broadcast, always. The alternative is handing the app a raw signed
       * transaction, which is a signature over a live payload sitting in app
       * code with nobody watching whether it is ever sent, sent twice, or sent
       * in three weeks. The device confirmed an action; the shell completes it. */
      broadcast: true,
      tx: {
        from: screened.from,
        to: screened.to,
        value: screened.value,
        data: screened.data,
        chainId: screened.chainId,
      },
      /* The reading the gate judged, not a fresh one. */
      interpretation: screened.interpretation,
    };
  }
  return {
    kind: "typed-data",
    address: screened.from,
    request: screened.request,
    summary: screened.summary,
    render: screened.render,
    document: screened.document,
  };
}

/**
 * Build the `propose` an app is handed, bound to that app's identity.
 *
 * `mountedChainId` and `mountedAddress` are what the app was given at mount.
 * They are compared against the live ones on every proposal, and a mismatch is
 * a refusal: it means the user changed chain or account while the app was
 * mid-flow, and the payload was built for a screen that is no longer on the
 * display. Signing it would be signing something an app computed about a state
 * nobody is looking at any more. The shell remounts on a chain change, so this
 * should be unreachable — which is exactly why it is checked rather than
 * assumed.
 */
export function appProposer(
  app: { id: string; name: string },
  mounted: { chainId: number; address: string },
  host: ProposeHost,
): (proposal: AppProposal) => Promise<ProposalOutcome> {
  return async (proposal: AppProposal): Promise<ProposalOutcome> => {
    /* Every refusal below logs the real reason for the user and returns the
     * same opaque no to the app. See app-proposal.ts on why the asymmetry. */
    const refuse = (why: string): ProposalOutcome => {
      host.log(`${app.name}: proposal refused — ${why}`);
      return declined();
    };

    const chainId = host.chainId();
    const address = host.address();
    if (chainId !== mounted.chainId) return refuse("the wallet has changed chain since this app was opened");
    if (address === "" || address.toLowerCase() !== mounted.address.toLowerCase()) {
      return refuse("the wallet has changed account since this app was opened");
    }

    const screened = screenProposal(proposal, {
      chainId,
      /* The signer. Not a field on the proposal, not derived from anything the
       * app said — the address the user is looking at. */
      from: address,
      /* Ticker for descriptor `amount` fields, from the chain registry only:
       * a symbol taken from a contract is a string the contract chose. */
      ...(getChain(chainId)?.nativeCurrency.symbol !== undefined
        ? { nativeSymbol: getChain(chainId)?.nativeCurrency.symbol as string }
        : {}),
    });
    if (screened.kind === "refused") return refuse(screened.why);

    const s = screened.screened;
    /* The app's own sentence, logged as the app's and nowhere near the figures.
     * The card shows the interpretation and the device shows the payload; this
     * only records which app asked and what it said it was for. */
    host.log(`${app.name} proposes: ${s.reason}`);

    let result: unknown;
    try {
      result = await host.review({
        name: app.name,
        method: s.kind === "call" ? "app proposal: transaction" : "app proposal: typed data",
        plan: planOf(s),
      });
    } catch (e) {
      /* Reject, device refusal, timeout, no device connected: all one no to the
       * app, all a real sentence in the user's log. */
      return refuse((e as Error).message);
    }

    if (typeof result !== "string") {
      // The card answered with something no branch of ours produces.
      return refuse("the wallet produced no result for that proposal");
    }
    return s.kind === "call"
      ? { ok: true, kind: "call", result }
      : { ok: true, kind: "typed-data", signature: result };
  };
}
