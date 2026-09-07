/**
 * The rails: order, availability, and the L1 warning.
 *
 * The EURC matrix is the assertion that matters. EURC exists on four of the
 * nine chains and a terminal that offered it on the other five would quote a
 * customer a price on a chain that cannot receive it.
 */

import { tokenHint } from "@leekwallet/core/chains.ts";
import {
  breakevenCents, costsMoreThanCard, deploymentFor, railFor,
  railsCheapestFirst, TILL_CHAIN_IDS,
} from "../src/rails.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const eq = (got: unknown, want: unknown, msg: string) =>
  check(got === want, `${msg}: got ${String(got)}, want ${String(want)}`);
const group = (n: string) => console.log(`== ${n}`);

const EURC_CHAINS = [5042002, 84532, 43113, 11155111];

group("nine rails, cheapest first");
{
  const rails = railsCheapestFirst();
  eq(rails.length, 9, "rail count");
  eq(rails[0]?.chainId, 5042002, "Arc leads: it is where the money already is");
  eq(rails[rails.length - 1]?.chainId, 11155111, "Ethereum L1 is last, because it is dearest");
  for (let i = 1; i < rails.length; i++) {
    check((rails[i] as { feeCents: number }).feeCents >= (rails[i - 1] as { feeCents: number }).feeCents,
      `rail ${i} is cheaper than the one before it`);
  }
  eq(TILL_CHAIN_IDS.length, 9, "chainIds matches the rails");
  // Every chain the app offers must be one the wallet knows, or the shell
  // could never mount it there.
  for (const id of TILL_CHAIN_IDS) check(railFor(id) !== undefined, `rail lookup for ${id}`);
}

group("EURC is unavailable on five chains, and says why");
{
  for (const id of TILL_CHAIN_IDS) {
    const usdc = deploymentFor(id, "USDC");
    check(usdc.ok, `USDC must be payable on ${id}`);
    if (usdc.ok) {
      // Decimals come from core's table, never from this app.
      eq(usdc.decimals, tokenHint(id, usdc.address)?.decimals, `decimals for USDC on ${id} come from core`);
      eq(usdc.decimals, 6, `USDC on ${id} is 6 decimals (Arc's ERC-20 face included)`);
    }

    const eurc = deploymentFor(id, "EURC");
    const expected = EURC_CHAINS.includes(id);
    eq(eurc.ok, expected, `EURC availability on ${id}`);
    if (!eurc.ok) check(/not deployed/.test(eurc.reason), `EURC refusal on ${id} must say why`);
  }
  const off = deploymentFor(1, "USDC");
  check(!off.ok, "a chain the terminal does not take must refuse");
}

group("L1 is dearer than a card below a $49 bill");
{
  const l1 = railFor(11155111);
  const base = railFor(84532);
  if (l1 === undefined || base === undefined) { check(false, "rails missing"); }
  else {
    eq(breakevenCents(l1), 4927, "$2.00 / 4.06% = $49.27, rounded up to the cent");
    check(costsMoreThanCard(l1, 1000n), "a $10 bill on L1 costs more than a card");
    check(costsMoreThanCard(l1, 4926n), "$49.26 is still under the break-even");
    check(!costsMoreThanCard(l1, 4927n), "$49.27 reaches it");
    check(!costsMoreThanCard(l1, 30000n), "a $300 bill on L1 is fine");
    // The claim the project actually makes: never true of an L2 or of Arc.
    for (const cents of [1n, 100n, 4926n, 100000n]) {
      check(!costsMoreThanCard(base, cents), `Base Sepolia is never worse than a card (${cents})`);
    }
  }
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
