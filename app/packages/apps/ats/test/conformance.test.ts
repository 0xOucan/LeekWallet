/**
 * Every signature and every role id in this app, checked against the Studio's
 * own compiled contracts.
 *
 * ---------------------------------------------------------------------------
 * What this test is for
 *
 * `docs/SDK-POLICY.md` says to use the sponsor's SDK for everything it does
 * well and to replace only its wallet layer. The thing the ATS SDK does better
 * than anything we could write is *know what the contracts look like*, and it
 * carries that knowledge as a pinned dependency:
 * `@hashgraph/asset-tokenization-contracts` at exactly 8.0.0. So that package
 * is installed here as a devDependency and this file re-derives, from its
 * compiled ABI, every function signature and every role constant the app
 * relies on.
 *
 * It found two real bugs the first time it ran, both of which had been reviewed
 * by a human and read fine:
 *
 *   - `lock` had its arguments in the readable order rather than the contracts'
 *     order (`uint256 _amount` first).
 *   - `grantKyc(address)` existed only on `MockedExternalKycList`; the real
 *     `IKyc.grantKyc` takes five arguments, one of them a `string`.
 *
 * Neither could have been caught by reading, and neither would have shown up as
 * a failing screen in testing — both produce a selector nothing matches, so the
 * symptom is a call that refuses, which is also what a correct refusal looks
 * like.
 *
 * ---------------------------------------------------------------------------
 * A devDependency and not a runtime one, deliberately
 *
 * The artifacts are ~100 MB of JSON and none of it belongs in a wallet's
 * bundle. What the app ships is the four-byte selectors keccak derives from the
 * strings this test verified. The dependency lives in this app's own
 * package.json, so `rm -rf app/packages/apps/ats` takes it out with everything
 * else and the three-deletion removal procedure is unchanged.
 *
 * ---------------------------------------------------------------------------
 * If this test cannot find the package
 *
 * It fails. It does not skip. A conformance test that quietly passes when its
 * authority is absent is worse than no test, because the claim in
 * descriptors.ts — "re-extracted from the compiled ABI" — would go on being
 * printed while nothing checked it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ACTIONS, UNRENDERABLE, actionName } from "../src/descriptors.ts";
import { ROLES } from "../src/roles.ts";
import { parseSignature } from "@leekwallet/core/erc7730.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const require = createRequire(import.meta.url);
const contractsRoot = dirname(
  require.resolve("@hashgraph/asset-tokenization-contracts/package.json"),
);

/* --------------------------------------------------- read the compiled ABI */

/** Canonical signature of one ABI entry, tuples included. */
const typeOf = (i: { type: string; components?: unknown[] }): string =>
  i.type.startsWith("tuple")
    ? `(${(i.components as Array<{ type: string }>).map(typeOf).join(",")})${i.type.slice(5)}`
    : i.type;

/** canonical signature -> the parameter names the contracts gave it. */
const declared = new Map<string, string[]>();

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!path.endsWith(".json") || path.endsWith(".dbg.json")) continue;
    let artifact: { abi?: unknown };
    try {
      artifact = JSON.parse(readFileSync(path, "utf8")) as { abi?: unknown };
    } catch { continue; }
    if (!Array.isArray(artifact.abi)) continue;
    for (const f of artifact.abi as Array<Record<string, unknown>>) {
      if (f["type"] !== "function") continue;
      const inputs = f["inputs"] as Array<{ type: string; name: string; components?: unknown[] }>;
      const sig = `${String(f["name"])}(${inputs.map(typeOf).join(",")})`;
      if (!declared.has(sig)) declared.set(sig, inputs.map((i) => i.name));
    }
  }
}
walk(join(contractsRoot, "artifacts"));

group("the compiled artifacts were actually read");
{
  // A silently empty index would make every assertion below vacuously true,
  // which is the exact failure this file exists to not have.
  check(declared.size > 500,
    `only ${declared.size} functions found in the artifacts; the package layout changed`);
}

/* ---------------------------------------------------------- the write surface */

group("every action's signature is a function these contracts declare");
{
  for (const spec of ACTIONS) {
    const parsed = parseSignature(spec.key);
    check(parsed !== null, `${spec.key} is not a signature the descriptor engine accepts`);
    if (parsed === null) continue;

    const names = declared.get(parsed.canonical);
    check(names !== undefined,
      `${parsed.canonical} is declared by NO contract in ` +
      `@hashgraph/asset-tokenization-contracts — the descriptor would never fire`);
    if (names === undefined) continue;

    /* Names matter as much as types here. The types decide the selector, but
     * the field paths ("#._account") resolve against the NAMES, so a key with
     * the right types and a renamed parameter renders nothing and reports
     * `omittedFields`, which action.ts refuses. Copying the contracts' names
     * verbatim is what makes that impossible. */
    const ours = parsed.params.map((p) => p.name ?? "");
    check(ours.length === names.length && ours.every((n, i) => n === names[i]),
      `${spec.key}: parameter names differ from the ABI, which declares ` +
      `(${names.join(", ")})`);

    check(spec.confidence === "artifact",
      `${spec.key}: every surviving action is artifact-verified; ${spec.confidence} is stale`);
  }
}

group("the actions cover the privileged surface we claim to cover");
{
  /* Not "every privileged function exists in ACTIONS" — the list is meant to
   * be shorter than the contracts, and it grows when somebody decides what a
   * screen should say. What is asserted is the other direction: the actions we
   * DO offer are the ones the plan names, so a silent deletion is a failure. */
  const offered = new Set(ACTIONS.map(actionName));
  for (const required of [
    "grantRole", "revokeRole", "revokeKyc", "pause", "unpause", "lock",
    "addToControlList", "removeFromControlList",
  ]) {
    check(offered.has(required), `the plan's §3 surface lost ${required}`);
  }
}

group("the unrenderable list names real functions, and none of them parse");
{
  for (const u of UNRENDERABLE) {
    check(declared.has(u.signature),
      `${u.signature} is on the unrenderable list but no contract declares it`);
    /* The list's whole claim is "no descriptor is possible for this". If the
     * engine started accepting one of them, the honest response is to write a
     * descriptor, not to keep refusing — so this failing is good news. */
    check(parseSignature(u.signature) === null,
      `${u.signature} is now a signature the engine accepts; give it a descriptor ` +
      "instead of leaving it on the unrenderable list");
  }
}

/* ---------------------------------------------------------------- the roles */

group("all 37 role ids match contracts/constants/roles.sol");
{
  const sol = readFileSync(join(contractsRoot, "contracts/constants/roles.sol"), "utf8");
  const byId = new Map<string, string>();
  for (const m of sol.matchAll(/bytes32\s+constant\s+(\w+)\s*=\s*(0x[0-9a-fA-F]{64})/g)) {
    byId.set((m[2] as string).toLowerCase(), m[1] as string);
  }
  check(byId.size === ROLES.length - 1,
    `roles.sol declares ${byId.size} constants; roles.ts has ${ROLES.length} ` +
    "entries (one of which is DEFAULT_ADMIN_ROLE, declared by OpenZeppelin)");

  for (const role of ROLES) {
    if (role.constant === "DEFAULT_ADMIN_ROLE") {
      check(/^0x0{64}$/.test(role.id), "DEFAULT_ADMIN_ROLE must be a full zero word");
      continue;
    }
    const found = byId.get(role.id.toLowerCase());
    /* A wrong id reads on chain as a role with no members, which is
     * indistinguishable from an unheld role — the mistake renders as a
     * reassuring blank. See roles.ts. */
    check(found === role.constant,
      `${role.constant} (${role.name}): roles.sol maps ${role.id} to ${found ?? "nothing"}`);
    byId.delete(role.id.toLowerCase());
  }
  check(byId.size === 0, `roles.sol has constants roles.ts does not: ${[...byId.values()].join(", ")}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
