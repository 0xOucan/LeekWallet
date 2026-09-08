/**
 * The write half of the app: a form that builds a deployment, and a dock
 * button per position.
 *
 * Thin on purpose. Every decision — what may be signed, what the cap is, what
 * to say when half a sequence lands — is in deploy.ts, withdraw.ts and run.ts,
 * which are pure and tested without a DOM. This file reads inputs, calls them,
 * and puts their sentences on screen. A rule implemented here would be a rule
 * only reachable through a browser, which is how the important ones stop being
 * checked (view.ts's header makes the same argument about the read side).
 *
 * Two things it does own, because both are about the screen rather than the
 * chain:
 *
 * - **A refusal replaces the plan, it does not sit beside it.** There is no
 *   state in which a user can see both "this strategy names somebody else" and
 *   a button that signs it.
 * - **A report is not cleared by the next click.** The half-failure message in
 *   particular stays until the view is rebuilt from a fresh read, because it
 *   describes an allowance that is still standing.
 */

import { formatUnits, tokenHint } from "@leekwallet/core/chains.ts";
import { parseUnits } from "@leekwallet/core/balances.ts";
import { fetchAllowances } from "@leekwallet/core/allowances.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { AQUA_MAX_LEGS, AQUA_REGISTRY } from "./registry.ts";
import { planDeployment, type DeployLeg, type DeployStep } from "./deploy.ts";
import { encodeStrategy } from "./strategy.ts";
import { planDock, revokeOffer, type TokenAfterDock } from "./withdraw.ts";
import { outstandingText, runSteps, type RunOutcome } from "./run.ts";
import { verdictFor, type Portfolio } from "./portfolio.ts";

/** What the manage panel needs that it cannot work out for itself. */
export interface ManageContext {
  chainId: number;
  maker: string;
  context: AppContext;
  /** The read this panel reasons about. Never re-derived here. */
  portfolio: Portfolio;
  /** Ask the shell to mount the app again, after something changed on chain. */
  refresh: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const labelled = (text: string, input: HTMLElement): HTMLElement => {
  const wrap = el("label", "aqua-input");
  wrap.append(el("span", "aqua-label", text), input);
  return wrap;
};

const notice = (text: string, tone = "normal"): HTMLElement =>
  el("p", `aqua-notice aqua-tone-${tone}`, text);

/** Decimals from the token list only. A guess is never used to scale input. */
const decimalsOf = (chainId: number, token: string): number | undefined =>
  tokenHint(chainId, token)?.decimals;

/**
 * Read one leg's amount.
 *
 * When the token list knows the decimals the user types token units and
 * `parseUnits` refuses more fractional digits than the token has, rather than
 * truncating — an amount this app cannot represent is one the user had in mind
 * and must not be silently rounded into an approval. When it does not know, the
 * field is raw units and says so, because scaling by an assumption is how a
 * payment becomes a million payments (see chains.ts's TOKEN_HINT_NOTICE).
 */
function readAmount(chainId: number, token: string, text: string): bigint {
  const decimals = decimalsOf(chainId, token);
  return decimals === undefined ? BigInt(text.trim()) : parseUnits(text, decimals);
}

/* ------------------------------------------------------------- deployment */

function deployForm(ctx: ManageContext): HTMLElement {
  const section = el("section", "aqua-deploy");
  section.append(el("h3", undefined, "Deploy a position"));

  const app = el("input");
  app.placeholder = "0x… the Aqua app";
  const config = el("input");
  config.placeholder = "0x… 32-byte strategy config";
  config.value = `0x${"00".repeat(32)}`;
  const program = el("input");
  program.placeholder = "0x… SwapVM program";
  program.value = "0x";

  section.append(
    labelled("Aqua app", app),
    labelled("Strategy config", config),
    labelled("Strategy program", program),
  );

  /* The maker is shown and not editable. It is the address the shell is
   * showing, it is what the strategy will name, and it is what the device will
   * demand matches its own From page. A field the user could change here would
   * be a field they could get wrong. */
  const maker = el("p", "aqua-detail", `Maker: ${ctx.maker} (this wallet)`);
  section.append(maker);

  const legInputs: Array<{ token: HTMLInputElement; amount: HTMLInputElement }> = [];
  const legs = el("div", "aqua-legs");
  for (let i = 0; i < AQUA_MAX_LEGS; i++) {
    const token = el("input");
    token.placeholder = i === 0 ? "0x… token" : "0x… token (optional)";
    const amount = el("input");
    amount.placeholder = "amount";
    legInputs.push({ token, amount });
    const row = el("div", "aqua-leg");
    row.append(labelled(`Token ${i + 1}`, token), labelled("Provide", amount));
    legs.append(row);
  }
  section.append(legs);

  const out = el("div", "aqua-out");
  const build = el("button", undefined, "Build the plan");
  build.type = "button";
  section.append(build, out);

  build.addEventListener("click", () => { void buildPlan(); });

  async function buildPlan() {
    out.replaceChildren();
    let strategy: string;
    let typed: Array<{ token: string; amount: bigint }>;
    try {
      strategy = encodeStrategy(ctx.maker, config.value.trim(), program.value.trim());
      typed = legInputs
        .filter((l) => l.token.value.trim() !== "")
        .map((l) => ({
          token: l.token.value.trim(),
          amount: readAmount(ctx.chainId, l.token.value.trim(), l.amount.value),
        }));
    } catch (e) {
      /* A malformed input is this app's own message, not a refusal: nothing was
       * decided about a strategy, the form could not be read at all. */
      out.append(notice(`That could not be read: ${(e as Error).message}`, "unavailable"));
      return;
    }

    /* Read the allowances the plan will be built against, now, rather than
     * reusing the portfolio's. The portfolio only knows tokens it found
     * positions in, so a first deposit in a new token would arrive at planCap
     * as "nobody could read it" -- which is a true sentence about the wrong
     * thing, and would put ALLOWANCE_UNREADABLE_NOTICE on a screen where the
     * honest answer was simply not looked up yet.
     *
     * A failure here stays undefined and the plan says so. That is planCap's
     * rule and the reason it exists: assuming zero is what produces the silent
     * revert on a USDT-style token. */
    const readings = await fetchAllowances(
      ctx.context.request, ctx.chainId, ctx.maker,
      typed.map((l) => ({ token: l.token, spender: AQUA_REGISTRY, via: "erc20" as const })),
    ).catch(() => undefined);

    const legList: DeployLeg[] = typed.map((l, i) => {
      const reading = readings?.[i];
      const decimals = decimalsOf(ctx.chainId, l.token);
      const hint = tokenHint(ctx.chainId, l.token);
      return {
        token: l.token,
        amount: l.amount,
        ...(reading?.ok ? { allowance: reading.amount } : {}),
        ...(decimals !== undefined ? { decimals } : {}),
        ...(hint?.symbol !== undefined ? { symbol: hint.symbol } : {}),
      };
    });

    const plan = planDeployment({
      maker: ctx.maker, app: app.value.trim(), strategy, legs: legList,
    });
    if (!plan.ok) {
      /* The refusal replaces the plan. There is deliberately no button here. */
      out.append(notice(plan.refusal.notice, "danger"));
      if (plan.refusal.kind === "wrong-maker") {
        out.append(el("code", "aqua-detail",
          `strategy names ${plan.refusal.named}; this wallet is ${plan.refusal.expected}`));
      }
      return;
    }

    for (const text of plan.notices) out.append(notice(text));
    out.append(el("p", "aqua-detail", `Strategy hash: ${plan.strategyHash}`));
    out.append(stepList(plan.steps));

    const sign = el("button", undefined,
      `Sign ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"} on the device`);
    sign.type = "button";
    sign.addEventListener("click", () => {
      sign.disabled = true;
      void run(ctx, plan.steps, out);
    });
    out.append(sign);
  }

  return section;
}

/**
 * The allowance the PORTFOLIO read for a token, if it read one.
 *
 * Used only on the dock side, where the token is one this app already found a
 * position in and therefore already asked about. The deploy form reads afresh
 * instead -- see buildPlan -- because a token being deposited for the first
 * time has no exposure row, and returning "unreadable" for it would put a
 * warning about USDT-style reverts on a screen where nothing had been looked
 * up yet.
 */
function allowanceOf(portfolio: Portfolio, token: string): { allowance?: bigint } {
  const exposure = portfolio.exposures.find(
    (e) => e.token.toLowerCase() === token.toLowerCase(),
  );
  if (!exposure) return {};
  const verdict = verdictFor(exposure);
  if (verdict.kind === "capped") return { allowance: verdict.allowance };
  if (verdict.kind === "none") return { allowance: 0n };
  /* "unlimited" is a real reading and a real number, but planCap only needs to
   * know whether it is non-zero; and "unknown" must stay undefined so the plan
   * says the allowance could not be read rather than assuming zero. */
  if (verdict.kind === "unlimited" && exposure.allowance.ok) {
    return { allowance: exposure.allowance.amount };
  }
  return {};
}

function stepList(steps: readonly DeployStep[]): HTMLElement {
  const list = el("ol", "aqua-steps");
  for (const step of steps) {
    const item = el("li", undefined, step.label);
    item.append(el("code", "aqua-detail", `${step.to} · ${step.data.slice(0, 10)}…`));
    list.append(item);
  }
  return list;
}

/* -------------------------------------------------------------- the walk */

async function run(ctx: ManageContext, steps: readonly DeployStep[], out: HTMLElement) {
  const outcome = await runSteps(ctx.context, steps);
  out.append(report(ctx, outcome));
  /* A refresh only when something reached the chain. Re-reading after a
   * rejection would replace a report the user has not finished reading with a
   * view identical to the one they started from. */
  if (outcome.kind === "done") ctx.refresh();
}

function report(ctx: ManageContext, outcome: RunOutcome): HTMLElement {
  const wrap = el("div", "aqua-report");
  switch (outcome.kind) {
    case "done":
      wrap.append(notice("Every transaction was signed and sent."));
      for (const step of outcome.steps) {
        wrap.append(el("code", "aqua-detail", `${step.step.label}: ${step.result ?? ""}`));
      }
      return wrap;
    case "cannot-ask":
    case "nothing-happened":
      wrap.append(notice(outcome.notice, "unavailable"));
      return wrap;
    default: {
      /* The one that must not be quiet. `danger` is the tone reserved for a
       * figure that can still cost money, which is exactly what this is. */
      wrap.append(notice(outcome.notice, "danger"));
      wrap.append(el("p", "aqua-value",
        `Outstanding: ${outstandingText(outcome.outstanding, (token) => {
          const hint = tokenHint(ctx.chainId, token);
          return hint ? { decimals: hint.decimals, symbol: hint.symbol } : undefined;
        })}`));
      for (const { token, amount } of outcome.outstanding) {
        const revoke = el("button", undefined, "Set this allowance to zero");
        revoke.type = "button";
        revoke.addEventListener("click", () => {
          revoke.disabled = true;
          const offer = revokeOffer({ token, allowance: amount, remainingPositions: 0 });
          if (offer.kind !== "offer") return;
          void run(ctx, [offer.step], wrap);
        });
        wrap.append(revoke);
      }
      return wrap;
    }
  }
}

/* ------------------------------------------------------------- docking */

function dockButtons(ctx: ManageContext): HTMLElement {
  const section = el("section", "aqua-dock");
  if (ctx.portfolio.positions.length === 0) return section;
  section.append(el("h3", undefined, "Withdraw a position"));

  for (const position of ctx.portfolio.positions) {
    const row = el("div", "aqua-position");
    row.append(el("code", "aqua-detail", `${position.app} · ${position.strategyHash}`));

    const out = el("div", "aqua-out");
    const button = el("button", undefined, "Dock (withdraw)");
    button.type = "button";
    button.addEventListener("click", () => {
      button.disabled = true;
      out.replaceChildren();
      const tokens = position.legs.map((leg) => leg.token);
      const dock = planDock({
        app: position.app, strategyHash: position.strategyHash, tokens,
      });
      for (const text of dock.notices) out.append(notice(text));
      void (async () => {
        const outcome = await runSteps(ctx.context, [dock.step]);
        out.append(report(ctx, outcome));
        if (outcome.kind === "done") out.append(revokeSection(ctx, position.strategyHash, tokens));
      })();
    });
    row.append(button, out);
    section.append(row);
  }
  return section;
}

/**
 * After a dock: is anything left in these tokens, and should the approval go?
 *
 * The count of remaining positions is taken from the portfolio this panel was
 * built with, minus the one just docked. That is a claim about a block range
 * rather than about all history (positions.ts's DISCOVERY_NOTICE), so a token
 * whose count cannot be trusted arrives here as `undefined` and produces the
 * `unknown` verdict rather than an offer — which is `revokeOffer`'s rule and
 * not a second one invented here.
 */
function revokeSection(
  ctx: ManageContext, dockedHash: string, tokens: readonly string[],
): HTMLElement {
  const wrap = el("div", "aqua-revoke");
  for (const token of tokens) {
    const state: TokenAfterDock = {
      token,
      ...allowanceOf(ctx.portfolio, token),
      ...remainingPositions(ctx.portfolio, token, dockedHash),
      ...(decimalsOf(ctx.chainId, token) !== undefined
        ? { decimals: decimalsOf(ctx.chainId, token) as number }
        : {}),
    };
    const offer = revokeOffer(state);
    if (offer.kind === "unknown") { wrap.append(notice(offer.notice, "unavailable")); continue; }
    if (offer.kind === "none") continue;

    wrap.append(notice(offer.notice, "danger"));
    wrap.append(el("p", "aqua-value",
      `Standing allowance: ${formatUnits(offer.allowance, decimalsOf(ctx.chainId, token) ?? 0)}`));
    const button = el("button", undefined, "Set it to zero");
    button.type = "button";
    button.addEventListener("click", () => {
      button.disabled = true;
      void run(ctx, [offer.step], wrap);
    });
    wrap.append(button);
  }
  return wrap;
}

function remainingPositions(
  portfolio: Portfolio, token: string, dockedHash: string,
): { remainingPositions?: number } {
  if (!portfolio.discovery.ok) return {};
  let count = 0;
  for (const position of portfolio.positions) {
    if (position.strategyHash === dockedHash) continue;
    for (const leg of position.legs) {
      if (leg.token.toLowerCase() !== token.toLowerCase()) continue;
      /* A leg nobody could read makes the count unknowable: it might be the
       * position that still holds this token. */
      if (!leg.ok) return {};
      if (leg.state === "active" && leg.amount > 0n) count++;
    }
  }
  return { remainingPositions: count };
}

/* ---------------------------------------------------------------- mount */

/**
 * Append the write half to `root`.
 *
 * Absent `propose` is a real state and gets a sentence rather than a disabled
 * form: a build with no device, or a test harness, cannot sign and should not
 * show a button that looks like it might.
 */
export function renderManage(root: HTMLElement, ctx: ManageContext): void {
  if (!ctx.context.propose) {
    root.append(notice(
      "No device is connected, so this app can show your positions but cannot " +
      "ask for a signature. Connect one to deploy or withdraw.",
      "unavailable",
    ));
    return;
  }
  root.append(deployForm(ctx), dockButtons(ctx));
}
