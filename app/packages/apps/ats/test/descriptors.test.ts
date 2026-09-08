/**
 * What a privileged screen says, and when there is no screen at all.
 *
 * The happy paths below are the cheap half. The half that matters starts at
 * "a call with no descriptor refuses": that group deletes a format from the
 * descriptor set and asserts that the console produces a refusal rather than a
 * screen showing a selector. If that assertion ever has to be weakened, the
 * plan's §3 rule has been abandoned and the abandonment should be visible in
 * the diff.
 *
 * No DOM and no network. Calldata is built here, byte for byte, and every
 * expectation is on returned text.
 */

import { selectorOf, addressWord, bytes32Word, word } from "../src/abi.ts";
import { ACTIONS, ROLE_POWER, atsDescriptorJson, atsDescriptors } from "../src/descriptors.ts";
import {
  describePrivilegedCall, renderPrivilegedScreen,
  type PrivilegedRendering, type PrivilegedScreen, type SecurityFacts,
} from "../src/action.ts";
import { ROLES, roleInfo } from "../src/roles.ts";
import { parseDescriptor, parseSignature } from "@leekwallet/core/erc7730.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const CHAIN = 296;
const TOKEN = "0x00000000000000000000000000000000004e5f21";
const ALICE = "0x000000000000000000000000000000000048a1b2";

const FACTS: SecurityFacts = {
  chainId: CHAIN,
  address: TOKEN,
  name: "ACME Equity",
  decimals: 2,
  controlListType: true,
};

const call = (signature: string, args: readonly string[] = []): string =>
  `0x${selectorOf(signature)}${args.join("")}`;

const ROLE_ISSUER = roleInfo("0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f");

/** A screen, or a loud failure. Keeps every assertion below off `undefined`. */
function screenOf(r: PrivilegedRendering, what: string): PrivilegedScreen {
  if (r.state === "screen") return r;
  console.log(`  FAIL: ${what} refused: ${r.why}`);
  failures++;
  return {
    state: "screen", title: "", fields: [], effect: "", selector: "0x", signature: "",
    confidence: "artifact", source: "", advisory: true, unverified: true,
  };
}

const render = (data: string, facts: SecurityFacts = FACTS): PrivilegedRendering =>
  describePrivilegedCall(facts, data);

group("the descriptor set is complete and parses");
{
  check(ROLE_ISSUER?.name === "Issuer", "the Issuer role id moved; every test below is suspect");

  const parsed = parseDescriptor(atsDescriptorJson(CHAIN, TOKEN), "test");
  check(parsed !== null, "the descriptor document does not parse");
  // Every action must survive parsing. A format the engine dropped — a dynamic
  // argument, an unsupported field — is a screen that silently never appears,
  // and "never appears" is indistinguishable from "was never written".
  check(parsed?.formats.length === ACTIONS.length,
        `${parsed?.formats.length} of ${ACTIONS.length} actions survived parsing`);
  for (const a of ACTIONS) {
    check(parseSignature(a.key) !== null, `${a.key} is not a signature the engine accepts`);
  }
  // No two actions may share a selector: the second would be unreachable.
  const selectors = new Set(ACTIONS.map((a) => selectorOf(parseSignature(a.key)!.canonical)));
  check(selectors.size === ACTIONS.length, "two actions share a selector");
}

group("every role has a consequence phrase");
{
  for (const r of ROLES) {
    check(ROLE_POWER[r.name] !== undefined, `no consequence recorded for the ${r.name} role`);
  }
  for (const name of Object.keys(ROLE_POWER)) {
    check(ROLES.some((r) => r.name === name),
          `${name} has a consequence phrase but is not a role`);
  }
  // The phrase is a verb phrase, because both screens prefix it. "Can can
  // issue" would be the visible symptom; this is the cheaper place to catch it.
  for (const [name, phrase] of Object.entries(ROLE_POWER)) {
    check(!/^can\b/i.test(phrase), `the ${name} phrase starts with "can"`);
    check(phrase.length > 0 && phrase === phrase.trim(), `the ${name} phrase is malformed`);
  }
}

group("grantRole and revokeRole name the role and its power");
{
  const data = call("grantRole(bytes32,address)",
                    [bytes32Word(ROLE_ISSUER!.id), addressWord(ALICE)]);
  const s = screenOf(render(data), "grantRole");
  check(s.title === "GRANT ROLE · ACME Equity", `title is ${s.title}`);
  check(s.fields.some((f) => f.label === "Role" && f.value === "Issuer"),
        "the role is not named as Issuer");
  check(s.fields.some((f) => f.label === "To" && f.value.toLowerCase() === ALICE),
        "the grantee is not shown");
  check(s.effect === "can issue new shares to any address, diluting every holder",
        `the effect line is: ${s.effect}`);
  // The whole point: a reader who does not know what "Issuer" means still
  // learns that approving this lets someone dilute them.
  check(renderPrivilegedScreen(s).includes("Effect"), "the rendering has no Effect line");

  const revoked = screenOf(
    render(call("revokeRole(bytes32,address)",
               [bytes32Word(ROLE_ISSUER!.id), addressWord(ALICE)])), "revokeRole");
  check(revoked.title.startsWith("REVOKE ROLE ·"), `revoke title is ${revoked.title}`);
  check(revoked.effect === "can no longer issue new shares to any address, diluting every holder",
        `the revoke effect line is: ${revoked.effect}`);
  check(revoked.fields.some((f) => f.label === "From"),
        "revoke should say From, not To — the direction is the difference");
}

group("KYC screens state what happens to the holder's balance");
{
  /* There is no grant-KYC screen, and that is the artifacts' doing rather than
   * an omission: `IKyc.grantKyc` takes a credential id as a `string`, so the
   * descriptor engine drops it and the console refuses. `grantKyc(address)`
   * exists only on `MockedExternalKycList` — a descriptor for it would draw a
   * confident screen for a function no real security has. Asserted here as a
   * refusal so that anyone who "fixes" it has to argue with a test. */
  const granted = render(call("grantKyc(address)", [addressWord(ALICE)]));
  check(granted.state === "refused", "grantKyc(address) produced a screen; it matches only a mock");
  const real = render(call("grantKyc(address,string,uint256,uint256,address)"));
  check(real.state === "refused" &&
        real.why.includes("variable-length string"),
        `the real grantKyc must refuse with its own reason; it said: ` +
        `${real.state === "refused" ? real.why : "a screen"}`);

  const revoked = screenOf(render(call("revokeKyc(address)", [addressWord(ALICE)])), "revokeKyc");
  // Stranding is the consequence an issuer is least likely to have in mind.
  check(revoked.effect.includes("unmovable"),
        `revoking KYC must say the balance is stranded; it said: ${revoked.effect}`);
  check(revoked.fields.some((f) => f.label === "Holder" && f.value.toLowerCase() === ALICE),
        "the holder is not shown");
}

group("pause and unpause say who is affected");
{
  const paused = screenOf(render(call("pause()")), "pause");
  check(paused.title === "PAUSE REGISTER · ACME Equity", `title is ${paused.title}`);
  check(paused.effect.includes("all transfers") && paused.effect.includes("every holder"),
        `pause must name every holder, not just the register: ${paused.effect}`);
  check(paused.fields.length === 0, "pause takes no arguments");

  const resumed = screenOf(render(call("unpause()")), "unpause");
  check(resumed.effect.includes("again"), `unpause effect: ${resumed.effect}`);
}

group("lock, mint and the supply cap restate amounts in shares");
{
  /* Amount first: that is the compiled ABI's order, and writing it the
   * readable way round is the bug conformance.test.ts caught. */
  const lock = screenOf(
    render(call("lock(uint256,address,uint256)",
               [word(5_000n), addressWord(ALICE), word(1_800_000_000n)])), "lock");
  check(lock.title === "LOCK HOLDER BALANCE · ACME Equity", `title is ${lock.title}`);
  check(lock.effect.includes("cannot move"), `lock effect: ${lock.effect}`);
  const amount = lock.fields.find((f) => f.label === "Amount");
  check(amount?.value === "50 shares (5000 raw)", `lock amount reads: ${amount?.value}`);
  check(lock.fields.some((f) => f.label === "Until" && f.value.startsWith("2027-")),
        "the lock expiry is not a readable date");

  const mint = screenOf(
    render(call("mint(address,uint256)", [addressWord(ALICE), word(100_000n)])), "mint");
  check(mint.effect.includes("dilutes every existing holder"), `mint effect: ${mint.effect}`);
  check(mint.fields.some((f) => f.label === "Amount" && f.value === "1000 shares (100000 raw)"),
        "the minted amount is not restated in shares");

  const cap = screenOf(render(call("setMaxSupply(uint256)", [word(2_000_000n)])), "setMaxSupply");
  check(cap.title === "SET SUPPLY CAP · ACME Equity", `title is ${cap.title}`);
  check(cap.effect.includes("ceiling"), `cap effect: ${cap.effect}`);

  // Without decimals the raw figure stands alone. It is not restated as if it
  // were shares, and it is not hidden: a raw number is true.
  const noDecimals = screenOf(
    render(call("mint(address,uint256)", [addressWord(ALICE), word(100_000n)]),
           { chainId: CHAIN, address: TOKEN, name: "ACME Equity" }), "mint without decimals");
  check(noDecimals.fields.some((f) => f.label === "Amount" && f.value === "100000"),
        "an amount with unknown decimals must stay raw");
}

group("a control-list edit reads in the list's own direction");
{
  const add = call("addToControlList(address)", [addressWord(ALICE)]);
  const remove = call("removeFromControlList(address)", [addressWord(ALICE)]);

  const onAllowlist = screenOf(render(add, { ...FACTS, controlListType: true }), "add/allowlist");
  check(onAllowlist.effect.includes("becomes allowed"), `allowlist add: ${onAllowlist.effect}`);

  const onBlocklist = screenOf(render(add, { ...FACTS, controlListType: false }), "add/blocklist");
  check(onBlocklist.effect.includes("barred"), `blocklist add: ${onBlocklist.effect}`);

  // The same four bytes, opposite meanings. This is why the direction is not
  // allowed to default.
  check(onAllowlist.effect !== onBlocklist.effect,
        "the same calldata read the same way on both list types");
  check(screenOf(render(remove, { ...FACTS, controlListType: false }), "remove/blocklist")
          .effect.includes("no longer barred"), "removing from a blocklist must unbar");
}

group("a privileged call with no descriptor refuses");
{
  /* The plan's H4: remove the descriptor, keep everything else. */
  const doc = atsDescriptorJson(CHAIN, TOKEN) as {
    display: { formats: Record<string, unknown> };
  };
  const formats = { ...doc.display.formats };
  const key = ACTIONS.find((a) => a.key.startsWith("grantRole("))!.key;
  delete formats[key];
  const crippled = parseDescriptor(
    { ...doc, display: { formats } }, "test/without-grantRole");
  check(crippled !== null, "the reduced descriptor set should still parse");

  const data = call("grantRole(bytes32,address)",
                    [bytes32Word(ROLE_ISSUER!.id), addressWord(ALICE)]);
  const r = describePrivilegedCall(FACTS, data, [crippled!]);
  check(r.state === "refused", "grantRole with no descriptor produced a screen");
  if (r.state === "refused") {
    check(r.selector === `0x${selectorOf("grantRole(bytes32,address)")}`,
          "a refusal must name the selector it could not describe");
    check(r.why.includes("no descriptor"), `refusal reason: ${r.why}`);
    // The refusal must not smuggle a description in. If any of the words a
    // screen would have used appear here, the user is being told what the call
    // does by the very path that decided it could not say.
    check(!/Issuer|dilut|grant a role/i.test(r.why),
          "a refusal must not describe the call it refused to describe");
  }
  // And the other actions still render from the same reduced set: the refusal
  // is scoped to the missing descriptor, not a blanket failure that would make
  // the test pass for the wrong reason.
  check(describePrivilegedCall(FACTS, call("pause()"), [crippled!]).state === "screen",
        "removing grantRole should not disable pause");
}

group("everything else that cannot be described honestly also refuses");
{
  const roleArgs = [bytes32Word(ROLE_ISSUER!.id), addressWord(ALICE)];
  const grant = call("grantRole(bytes32,address)", roleArgs);

  const cases: ReadonlyArray<readonly [string, PrivilegedRendering]> = [
    ["a selector nothing describes",
     render(call("selfDestructEverything()"))],
    /* Both halves of the deployment must match. The default descriptor set is
     * built for whatever address it is asked about, so these two pass the set
     * belonging to this security explicitly — which is the real shape of the
     * mistake: descriptors for one contract reused against another. */
    ["the same call on another chain",
     describePrivilegedCall({ ...FACTS, chainId: 1 }, grant, atsDescriptors(CHAIN, TOKEN))],
    ["the same call on another contract",
     describePrivilegedCall(
       { ...FACTS, address: "0x000000000000000000000000000000000000dead" },
       grant, atsDescriptors(CHAIN, TOKEN))],
    ["trailing calldata past the arguments",
     render(`${grant}${word(1n)}`)],
    ["truncated arguments",
     render(grant.slice(0, -64))],
    ["no selector at all",
     render("0x")],
    ["a role id this app does not know",
     render(call("grantRole(bytes32,address)",
                [bytes32Word(`0x${"ab".repeat(32)}`), addressWord(ALICE)]))],
    ["a control-list edit with the list direction unread",
     render(call("addToControlList(address)", [addressWord(ALICE)]),
            { chainId: CHAIN, address: TOKEN, name: "ACME Equity" })],
  ];

  for (const [what, r] of cases) {
    check(r.state === "refused", `${what} should refuse, and did not`);
    if (r.state === "refused") check(r.why.length > 0, `${what} refused with no reason`);
  }
}

group("the title falls back rather than rendering an unsafe name");
{
  // `name()` is attacker-controlled and lands in the line a reader trusts most.
  const s = screenOf(render(call("pause()"), { ...FACTS, name: "‮EMCA" }), "hostile name");
  check(!s.title.includes("‮"), "a direction override reached the title");

  const nameless = screenOf(
    render(call("pause()"), { chainId: CHAIN, address: TOKEN }), "no name");
  check(nameless.title.includes("…"), `a nameless security should show its address: ${nameless.title}`);
}

group("nothing here claims to be verified");
{
  const s = screenOf(render(call("pause()")), "pause");
  check(s.advisory === true && s.unverified === true, "a screen must carry both flags");
  check(s.source.startsWith("local/"),
        "these descriptors are ours, not the registry's, and must say so");
  check(atsDescriptors(CHAIN, TOKEN).length === 1, "the factory should build one descriptor");
}

console.log(failures === 0 ? "\nOK" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
