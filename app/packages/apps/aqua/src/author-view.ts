/**
 * The tier picker: pick a pair and a risk tier, read the band back in units you
 * know, and ship it — every step through `propose()`.
 *
 * Thin, like manage.ts and for the same reason: every decision is in
 * `tier-plan.ts`, `authoring.ts` and `deploy.ts`, all of which are pure and
 * tested without a DOM. This file reads a form, calls them, and puts their
 * sentences on screen.
 *
 * ---------------------------------------------------------------------------
 * Three things this screen owns
 *
 * 1. **All three tiers are on screen at once, before one is chosen.** The
 *    choice is a trade-off — fee density against impermanent loss against how
 *    soon the band is left — and a dropdown that reveals one sentence at a time
 *    is a dropdown in which nobody compares. None of the three sentences
 *    projects a return; `authoring.ts` says why at length and a test asserts it.
 *
 * 2. **The band is shown as a price range, in the operator's own direction,
 *    before anything is signed.** STRATEGIES.md §3.4: a person reading "2,800
 *    to 5,714 USDC per WETH" catches a decimals error instantly, and nobody
 *    catches it reading a uint256. That read-back is the only real check on the
 *    one class of mistake the code cannot catch, so it is the largest thing on
 *    the screen and it is not collapsible.
 *
 * 3. **The amounts are bounded by what the wallet actually holds**, read from
 *    the chain rather than typed. A leg over the balance refuses in
 *    `tier-plan.ts` before any calldata exists; the balance is shown beside the
 *    field so the refusal is avoidable rather than surprising.
 */

import { formatUnits, TOKEN_HINT_NOTICE } from "@leekwallet/core/chains.ts";
import { parseUnits } from "@leekwallet/core/balances.ts";
import { fetchAllowances } from "@leekwallet/core/allowances.ts";
import { fetchTokenBalancesBatched } from "@leekwallet/core/multicall.ts";
import { capAmountText } from "@leekwallet/core/approval-cap.ts";
import type { AppContext } from "@leekwallet/core/mini-app.ts";
import { AQUA_REGISTRY } from "./registry.ts";
import { TIERS, type RiskTier } from "./authoring.ts";
import { BASE_TOKENS, PAIRS, pairById, type KnownToken } from "./tokens.ts";
import { planTierPosition, type LegInput, type TierPlan } from "./tier-plan.ts";
import { outstandingText, runSteps, type RunOutcome } from "./run.ts";
import type { DeployStep } from "./deploy.ts";
import type { Instruction } from "./program.ts";

/** What the picker needs. The same shape manage.ts takes, minus the portfolio. */
export interface AuthorContext {
  chainId: number;
  maker: string;
  context: AppContext;
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

const notice = (text: string, tone = "normal"): HTMLElement =>
  el("p", `aqua-notice aqua-tone-${tone}`, text);

const labelled = (text: string, input: HTMLElement): HTMLElement => {
  const wrap = el("label", "aqua-input");
  wrap.append(el("span", "aqua-label", text), input);
  return wrap;
};

/**
 * An amount, never as a bare pretty number.
 *
 * The token-units figure is this app's reading of a decimals value nobody
 * verified, so the raw units it was scaled from travel with it everywhere and
 * `TOKEN_HINT_NOTICE` is on the panel. chains.ts's rule, applied here rather
 * than re-argued.
 */
const amountText = (raw: bigint, token: KnownToken): string =>
  `${capAmountText(raw, { decimals: token.decimals, symbol: token.symbol })} ` +
  `(${raw} raw units)`;

const eight = (): Uint8Array => {
  const salt = new Uint8Array(8);
  crypto.getRandomValues(salt);
  return salt;
};

/* ------------------------------------------------------------------ the form */

export function renderAuthor(root: HTMLElement, ctx: AuthorContext): void {
  const section = el("section", "aqua-author");
  section.append(el("h3", undefined, "Ship a position"));

  if (!ctx.context.propose) {
    section.append(notice(
      "No device is connected, so a position can be planned nowhere and signed " +
      "nowhere. Connect one.",
      "unavailable",
    ));
    root.append(section);
    return;
  }

  const pair = el("select");
  for (const p of PAIRS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    pair.append(opt);
  }

  const tier = el("select");
  for (const name of ["low", "medium", "high"] as const) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    tier.append(opt);
  }
  tier.value = "medium";

  const mid = el("input");
  mid.placeholder = "mid price";
  const fee = el("input");
  fee.value = "0.30";
  const hours = el("input");
  hours.value = "2";
  const gate = el("input");
  gate.placeholder = "0x… gate token";

  section.append(
    labelled("Pair", pair),
    labelled("Risk tier", tier),
  );

  /* Every tier's own sentence, all three visible at once. See the header. */
  const tierTable = el("div", "aqua-tiers");
  for (const name of ["low", "medium", "high"] as const) {
    const row = el("div", "aqua-tier");
    row.append(el("span", "aqua-tier-name", name));
    row.append(el("span", undefined, TIERS[name].summary));
    tierTable.append(row);
  }
  section.append(tierTable);

  const midLine = labelled("Mid price", mid);
  section.append(
    midLine,
    labelled("Fee (%)", fee),
    labelled("Expires in (hours)", hours),
    labelled("Gate token", gate),
  );
  section.append(el("p", "aqua-detail",
    "The gate is opcode 14: only an address holding a non-zero balance of that " +
    "token can fill this position. It is what keeps the offer off bots without " +
    "asking anyone's permission."));

  const legRow = el("div", "aqua-legs");
  const legFields = new Map<string, { input: HTMLInputElement; held: HTMLElement }>();
  section.append(legRow);
  section.append(el("p", "aqua-notice aqua-tone-unavailable", TOKEN_HINT_NOTICE));

  const out = el("div", "aqua-out");
  const build = el("button", undefined, "Plan the position");
  build.type = "button";
  section.append(build, out);
  root.append(section);

  /** Balances, per token address, from the chain. Undefined means unread. */
  let balances = new Map<string, bigint>();
  let reading = false;

  const midPlaceholder = (): void => {
    const p = pairById(pair.value);
    if (p === undefined) return;
    const base = BASE_TOKENS[p.midBase] as KnownToken;
    const quote = BASE_TOKENS[p.midQuote] as KnownToken;
    mid.placeholder = `${p.midExample}  (${quote.symbol} per ${base.symbol})`;
    (midLine.firstChild as HTMLElement).textContent =
      `Mid price (${quote.symbol} per ${base.symbol})`;
  };

  /**
   * Rebuild the two amount fields and read the balances behind them.
   *
   * The balance is fetched rather than assumed, and a token that does not
   * answer says so: the plan refuses on an unread balance, and a field that
   * quietly showed nothing would make that refusal look like a bug.
   */
  const rebuildLegs = async (): Promise<void> => {
    const p = pairById(pair.value);
    if (p === undefined) return;
    legRow.replaceChildren();
    legFields.clear();
    const tokens = [p.a, p.b].map((id) => BASE_TOKENS[id] as KnownToken);
    for (const token of tokens) {
      const input = el("input");
      input.placeholder = `${token.symbol} to provide`;
      const held = el("span", "aqua-detail", "reading balance…");
      const row = el("div", "aqua-leg");
      row.append(labelled(`Provide ${token.symbol}`, input), held);
      legRow.append(row);
      legFields.set(token.address, { input, held });
    }

    if (reading) return;
    reading = true;
    let results;
    try {
      results = await fetchTokenBalancesBatched(
        ctx.context.request, ctx.chainId, ctx.maker, tokens.map((t) => t.address),
      );
    } catch {
      results = undefined;
    } finally {
      reading = false;
    }
    balances = new Map();
    for (const token of tokens) {
      const field = legFields.get(token.address);
      if (field === undefined) continue;
      const result = results?.find((r) => r.token.toLowerCase() === token.address);
      if (result === undefined || !result.ok) {
        field.held.className = "aqua-detail aqua-tone-unavailable";
        field.held.textContent = `${token.symbol} balance could not be read`;
        continue;
      }
      balances.set(token.address, result.raw);
      field.held.className = "aqua-detail";
      field.held.textContent = `holds ${amountText(result.raw, token)}`;
      /* Prefilled with the whole balance, because that is the only figure on
       * this screen that is a fact rather than a choice, and because a maker
       * shipping less can only do so by typing less. Zero stays zero: a side
       * with nothing behind it must not arrive pre-filled with a number. */
      if (result.raw > 0n) field.input.value = formatUnits(result.raw, token.decimals);
    }
  };

  pair.addEventListener("change", () => { midPlaceholder(); void rebuildLegs(); });
  midPlaceholder();
  void rebuildLegs();

  build.addEventListener("click", () => { void plan(); });

  async function plan(): Promise<void> {
    out.replaceChildren();
    const p = pairById(pair.value);
    if (p === undefined) return;
    const tokens = [p.a, p.b].map((id) => BASE_TOKENS[id] as KnownToken);

    const hoursValue = Number(hours.value.trim());
    if (!Number.isFinite(hoursValue) || hoursValue <= 0) {
      out.append(notice("The expiry must be a positive number of hours.", "unavailable"));
      return;
    }

    let legs: LegInput[];
    try {
      legs = tokens.map((token) => {
        const raw = (legFields.get(token.address)?.input.value ?? "").trim();
        const amount = raw === "" ? 0n : parseUnits(raw, token.decimals);
        const balance = balances.get(token.address);
        return {
          tokenId: keyOf(token),
          amount,
          ...(balance !== undefined ? { balance } : {}),
        };
      });
    } catch (e) {
      out.append(notice(`That amount could not be read: ${(e as Error).message}`, "unavailable"));
      return;
    }

    /* Allowances are read now rather than reused, exactly as manage.ts does:
     * a first deposit in a token the portfolio never saw would otherwise reach
     * planCap as "nobody could read it", which is a true sentence about the
     * wrong thing. A failed read stays undefined and the plan says so. */
    const funded = legs.filter((l) => l.amount > 0n);
    const readings = funded.length === 0 ? [] : await fetchAllowances(
      ctx.context.request, ctx.chainId, ctx.maker,
      funded.map((l) => ({
        token: (BASE_TOKENS[l.tokenId] as KnownToken).address,
        spender: AQUA_REGISTRY,
        via: "erc20" as const,
      })),
    ).catch(() => undefined);

    const withAllowance: LegInput[] = legs.map((l) => {
      const i = funded.indexOf(l);
      const reading = i === -1 ? undefined : readings?.[i];
      return reading?.ok ? { ...l, allowance: reading.amount } : l;
    });

    const result = planTierPosition({
      maker: ctx.maker,
      pairId: p.id,
      tier: tier.value as RiskTier,
      mid: mid.value.trim(),
      feePercent: fee.value.trim(),
      deadline: BigInt(Math.floor(Date.now() / 1000) + Math.round(hoursValue * 3600)),
      gateToken: gate.value.trim(),
      salt: eight(),
      legs: withAllowance,
    });

    if (!result.ok) {
      /* The refusal replaces the plan. There is deliberately no button. */
      out.append(notice(result.refusal.notice, "danger"));
      return;
    }
    renderPlan(out, ctx, result);
  }
}

/** The table key for a token, so a leg can be lined up with its input. */
const keyOf = (token: KnownToken): string =>
  Object.keys(BASE_TOKENS).find((k) => (BASE_TOKENS[k] as KnownToken).address === token.address) ?? "";

/* ------------------------------------------------------------------ the plan */

function renderPlan(out: HTMLElement, ctx: AuthorContext, plan: TierPlan): void {
  /* The read-back first and biggest. Everything else on this screen is a
   * consequence of it being right. */
  const band = el("div", "aqua-band");
  band.append(el("div", "aqua-band-line", plan.bandText));
  band.append(el("p", "aqua-detail",
    `${plan.tier}: ${plan.tierSummary}`));
  out.append(band);

  out.append(notice(plan.notices[0] as string, "unavailable"));

  const sides = el("p", `aqua-notice aqua-tone-${plan.sides === "one-sided" ? "danger" : "normal"}`);
  sides.textContent = plan.sides === "two-sided"
    ? "Both sides are funded: this is a market in both directions."
    : `One side only. ${plan.emptySide ? `${plan.emptySide.symbol} is empty.` : ""}`;
  out.append(sides);
  for (const text of plan.notices.slice(1)) out.append(notice(text));

  const legs = el("ul", "aqua-steps");
  for (const leg of plan.legs) {
    legs.append(el("li", undefined,
      `${amountText(leg.amount, leg.token)} of ${leg.token.symbol}, ` +
      `of ${amountText(leg.held, leg.token)} held · ${leg.token.address}`));
  }
  out.append(legs);

  out.append(el("p", "aqua-detail", `Strategy hash: ${plan.plan.strategyHash}`));
  out.append(el("p", "aqua-detail",
    `Expires: ${plan.deadline} (${new Date(Number(plan.deadline) * 1000).toISOString()}) — ` +
    "check that against your own clock."));
  if (plan.plan.program !== undefined) out.append(programList(plan.plan.program));

  const steps = el("ol", "aqua-steps");
  for (const step of plan.plan.steps) {
    const item = el("li", undefined, step.label);
    item.append(el("code", "aqua-detail", `${step.to} · ${step.data.slice(0, 10)}…`));
    steps.append(item);
  }
  out.append(steps);

  const sign = el("button", undefined,
    `Sign ${plan.plan.steps.length} transaction${plan.plan.steps.length === 1 ? "" : "s"} on the device`);
  sign.type = "button";
  sign.addEventListener("click", () => {
    sign.disabled = true;
    void run(ctx, plan.plan.steps, out);
  });
  out.append(sign);
}

/** One row per instruction, in program order. Order is security-critical. */
function programList(instructions: readonly Instruction[]): HTMLElement {
  const wrap = el("div", "aqua-program-wrap");
  wrap.append(el("h4", undefined, "Strategy program"));
  const list = el("ol", "aqua-program");
  for (const instr of instructions) list.append(el("li", undefined, instr.fields.name));
  wrap.append(list);
  return wrap;
}

async function run(ctx: AuthorContext, steps: readonly DeployStep[], out: HTMLElement): Promise<void> {
  const outcome = await runSteps(ctx.context, steps);
  out.append(report(outcome));
  if (outcome.kind === "done") ctx.refresh();
}

function report(outcome: RunOutcome): HTMLElement {
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
    default:
      /* The half-failure: an allowance standing with no position behind it.
       * The one state in this app that still costs money after the user has
       * walked away, so it gets the loud tone and the exact figure. */
      wrap.append(notice(outcome.notice, "danger"));
      wrap.append(el("p", "aqua-value", `Outstanding: ${outstandingText(outcome.outstanding)}`));
      return wrap;
  }
}
