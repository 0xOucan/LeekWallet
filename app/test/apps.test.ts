/**
 * The mini-app framework's rules, enforced by reading the source.
 *
 * The rules exist so any app can be dropped from a release by deleting its
 * directory and one registry line (packages/apps/README.md). Rules of that
 * shape decay silently — one convenient import between two apps costs nothing
 * today and makes removal a code change forever after, and nobody notices until
 * the release where it matters. So they are asserted rather than written down.
 *
 * This reads files instead of importing modules on purpose: what is under test
 * is the shape of the dependency graph, and a test that imported the graph
 * would be part of it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = join(here, "..");
const appsDir = join(appRoot, "packages", "apps");

const listApps = (): string[] =>
  readdirSync(appsDir).filter((name) => {
    try { return statSync(join(appsDir, name, "package.json")).isFile(); } catch { return false; }
  });

const sourcesOf = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); }
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  };
  walk(dir);
  return out;
};

const apps = listApps();

/* ------------------------------------------------------------------------ */

group("each app is a workspace package of the expected shape");
{
  /* Zero apps is a pass, not a failure. A release build that excludes every
   * app is precisely what this framework exists to allow, and a suite that
   * went red on it would be a suite telling people not to do the thing. */
  console.log(`   ${apps.length} app(s): ${apps.join(", ") || "none"}`);
  for (const app of apps) {
    const manifest = JSON.parse(readFileSync(join(appsDir, app, "package.json"), "utf8"));
    check(manifest.name === `@leekwallet/app-${app}`,
      `${app}: package name is ${manifest.name}, expected @leekwallet/app-${app}`);
    check(manifest.private === true, `${app}: an app must be private`);
    check(manifest.exports?.["."] === "./src/index.ts", `${app}: must export ./src/index.ts`);
    check(manifest.dependencies?.["@leekwallet/core"] === "workspace:*",
      `${app}: must depend on @leekwallet/core`);
  }
}

group("no app imports another app");
{
  // The rule that makes deletion safe. Two apps sharing a helper would make
  // removing either of them a code change in the other; shared code goes in
  // core, where it is reviewed as core.
  for (const app of apps) {
    for (const file of sourcesOf(join(appsDir, app, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const other of apps) {
        if (other === app) continue;
        check(!source.includes(`@leekwallet/app-${other}`) && !source.includes(`apps/${other}`),
          `${file} reaches into app "${other}"`);
      }
      check(!/from\s+["']\.\.\/\.\.\//.test(source),
        `${file} escapes its own package with a relative import`);
    }
  }
}

/*
 * The shell must not know an app's ID either.
 *
 * The import check below was not enough: `app.id === "till-waiter"` reached
 * main.ts and passed, because the app list there is directory names and that ID
 * belongs to a second app inside the `till` package. A shell that names an app
 * still compiles once the app is deleted, matches nothing, and shows an empty
 * screen with no error -- so removability becomes a claim rather than a
 * property. Ask through the MiniApp contract instead; `worksWithoutDevice` is
 * the field that exists for exactly this.
 *
 * IDs are read from the packages, not from folder names, which is the mistake
 * that let it through the first time.
 */
group("the shell does not name an app by ID");
{
  const ids = new Set<string>();
  for (const app of apps) {
    for (const file of sourcesOf(join(appsDir, app, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bid:\s*"([a-z0-9-]+)"/g)) {
        ids.add(m[1] as string);
      }
    }
  }
  check(ids.size > 0, "no app IDs were found to check");
  for (const file of sourcesOf(join(appRoot, "src"))) {
    if (file === join(appRoot, "src", "apps", "registry.ts")) continue;
    /* Comments stripped first. The fix for this very rule carries a comment
       explaining why not to name an app, and that comment quotes the ID it is
       warning about — a check on raw text flags the explanation as the
       offence. */
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const id of ids) {
      check(!source.includes(`"${id}"`),
        `${file.slice(appRoot.length + 1)} names the app "${id}" as a literal. ` +
          `Add a field to MiniApp and ask for it instead.`);
    }
  }
}

group("the shell touches apps only through the registry");
{
  // One edge, in one file, so removal is one deletion. Anything else in
  // src/ importing an app would be a second place to remember.
  const registry = join(appRoot, "src", "apps", "registry.ts");
  for (const file of sourcesOf(join(appRoot, "src"))) {
    if (file === registry) continue;
    const source = readFileSync(file, "utf8");
    for (const app of apps) {
      /* An app's ID as a literal, not only its import.
 
         The import check alone let `app.id === "till-waiter"` into main.ts: it
         compiles after that app is deleted, matches nothing, and shows an empty
         screen with no error. A shell that knows an app's name has knowledge to
         leave behind, so removability stops being a property and becomes a
         claim. Ask the app through the MiniApp contract instead -- that is what
         `worksWithoutDevice` is for. */
      check(!source.includes(`@leekwallet/app-${app}`),
        `${file} imports app "${app}" directly instead of via the registry`);
    }
  }

  const source = readFileSync(registry, "utf8");
  for (const app of apps) {
    // Static, not dynamic: a deleted directory must fail at tsc rather than at
    // runtime on a screen nobody opened before shipping.
    check(new RegExp(`^import .*@leekwallet/app-${app}["']`, "m").test(source),
      `the registry does not statically import "${app}"`);
    check(!new RegExp(`import\\s*\\(.*app-${app}`).test(source),
      `the registry imports "${app}" dynamically`);
  }
}

group("the contract lives in core, where no app owns it");
{
  // It was in the Aqua package first, which quietly made every other app
  // depend on Aqua being present. This is the assertion that would catch a
  // future app defining its own MiniApp and the registry following it there.
  const contract = readFileSync(join(appRoot, "packages", "core", "src", "mini-app.ts"), "utf8");
  check(/export interface MiniApp/.test(contract), "core does not define MiniApp");
  check(/export interface AppContext/.test(contract), "core does not define AppContext");
  const registry = readFileSync(join(appRoot, "src", "apps", "registry.ts"), "utf8");
  check(/@leekwallet\/core\/mini-app\.ts/.test(registry),
    "the registry takes its MiniApp type from somewhere other than core");

  /* What AppContext's FIELDS are, exactly. Comments are excluded from the
   * search on purpose: this file's prose is largely about the boundary, and
   * matching it would make the assertion fire on the explanation rather than on
   * the thing.
   *
   * This assertion used to read "no field may mention signing at all", which
   * was right while every app was read-only and became wrong the moment one
   * had to ask for a signature. It was not weakened to let a feature through:
   * it was replaced with the narrower statement that is actually the boundary.
   * An app may PROPOSE — hand over an intent and receive an outcome — and may
   * not hold anything that produces a signature by itself. So the field list is
   * an allowlist, which keeps what the old assertion bought us (a new field is
   * a deliberate diff on this line), and the forbidden words are the
   * capabilities: a key, a transport, a device client, a session.
   *
   * If someone later hands an app raw signing power, it arrives as a field, and
   * a field that is not one of these fails here. */
  const body = /export interface AppContext \{([\s\S]*?)\n\}/.exec(contract)?.[1] ?? "";
  check(body.length > 0, "AppContext's declaration could not be found");
  const fields = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

  /* Each name here is a decision that a capability is safe to hand an app, and
     the failure message is deliberately phrased as "never considered" rather
     than "not allowed": the point is to force the judgement, not to be quieted.
 
     `requestOn` was added for La Caja, which watches nine chains at once. It
     returns { request, endpointHost } -- the same shape and the same power as
     `request`, pointed at another chain. It cannot sign: what backs it is a
     FailoverRpc to a public node, and a public node holds no keys, so
     eth_sendTransaction and eth_sign have nothing to sign with there. An app
     could broadcast an already-signed transaction through it, which is not a
     new capability, because obtaining that signature still requires `propose`
     and a press on the device. */
  /* `scanQr` reads one QR code with the shell's camera and returns what the
     app's own `accept` predicate matched. It is a read capability: it produces
     text, cannot sign, cannot spend, and reaches no key or transport. What it
     returns is untrusted -- a QR code is whatever somebody printed -- so an app
     must validate it, which La Caja's waiter does by refusing any request that
     does not pay its configured address. */
  const ALLOWED_FIELDS =
    ["chainId", "address", "request", "endpointHost", "propose", "requestOn", "scanQr"];
  const declared = [...fields.matchAll(/^\s{2}(\w+)\??[:(]/gm)].map((m) => m[1] as string);
  check(declared.length > 0, "no AppContext fields were found to check");
  for (const field of declared) {
    check(ALLOWED_FIELDS.includes(field),
      `AppContext has grown a field this test has never considered: ${field}`);
  }

  check(!/signer|device|transport|\bkey\b|privateKey|mnemonic|seed|client|session/i.test(fields),
    `AppContext has grown a capability rather than a proposal: ${fields.trim()}`);

  /* And `propose` must be the proposal seam rather than a signer wearing its
   * name. It takes an AppProposal and returns a ProposalOutcome — the types in
   * app-proposal.ts, where the payload is screened against the descriptor rule.
   * A `propose` that took raw bytes, or returned a signature over whatever it
   * was given, would be the design this replaced. */
  check(/propose\?:\s*\(proposal: AppProposal\) => Promise<ProposalOutcome>/.test(fields),
    "AppContext.propose is not the (AppProposal) => ProposalOutcome seam");
}

group("an app cannot reach a key, a transport or the device");
{
  /* The other half of the boundary. AppContext could be spotless and an app
   * could still import the device client itself. These are the core modules
   * that touch hardware, keys or the wire, and no app may name one. */
  const FORBIDDEN_MODULES = [
    "transport.ts", "framing.ts", "device-state.ts", "mock-device.ts",
    "viem-account.ts", "session.ts",
  ];
  /* Call shapes that mean "I found a route to the device anyway". `client.call`
   * is the device RPC, and the four names are what it would be asked for. */
  const FORBIDDEN_CALLS = [
    /\bclient\.call\b/, /\bDeviceClient\b/, /\bnavigator\.bluetooth\b/,
    /["']signTransaction["']/, /["']signTypedData["']/,
    /["']signMessage["']/, /["']signHash["']/,
  ];
  for (const app of apps) {
    for (const file of sourcesOf(join(appsDir, app, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const mod of FORBIDDEN_MODULES) {
        check(!source.includes(`core/${mod}`), `${file} imports ${mod}, which reaches the device`);
      }
      for (const shape of FORBIDDEN_CALLS) {
        check(!shape.test(source), `${file} matches ${shape}, which is a route to a signature`);
      }
    }
  }

  /* The shell side of the same rule: an app is handed `propose` in exactly one
   * place. A second attachment would be a second seam, and an unscreened one. */
  const named = sourcesOf(join(appRoot, "src"))
    .filter((f) => /\bpropose\s*[,:}]/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(appRoot.length + 1))
    .sort();
  for (const file of named) {
    check(["src/apps/mount.ts", "src/apps/propose.ts", "src/main.ts"].includes(file),
      `propose is attached in ${file}, which is not one of the three files that may`);
  }

  /* And the gate is not optional. The shell's proposer must go through
   * screenProposal; a path that built a plan without it would be a payload the
   * descriptor rule never saw. */
  const proposer = readFileSync(join(appRoot, "src", "apps", "propose.ts"), "utf8");
  check(/screenProposal\(/.test(proposer), "the shell's proposer does not screen proposals");
  /* Comments stripped, as in the AppContext check above: that file's prose is
   * about what it must not touch, and matching it would fire on the promise
   * rather than on a breach of it. */
  const proposerCode = proposer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  check(!/client\.call|signPlanned|transport/.test(proposerCode),
    "the shell's proposer reaches the device directly instead of using the review path");
}

group("each app carries its own CSS, prefixed with its id");
{
  for (const app of apps) {
    const index = readFileSync(join(appsDir, app, "src", "index.ts"), "utf8");
    check(/css:/.test(index), `${app}: no css field, so its styles live somewhere undeletable`);
    const shellCss = readFileSync(join(appRoot, "src", "styles.css"), "utf8");
    check(!shellCss.includes(`.${app}-`),
      `${app}: shell styles.css carries app rules that would survive deletion`);
  }
}


/*
 * The set of calls a mini-app may propose without an ERC-7730 descriptor.
 *
 * `app-proposal.ts` says this list is pinned by the suite so it cannot grow by
 * accident. It said so before anything asserted it; this is that assertion.
 *
 * Membership is not a style choice. Each kind here bypasses the rule that a
 * payload must have a descriptor before it can be signed, on the grounds that
 * the DEVICE decodes and draws it instead — a bespoke decoder in
 * src/eth-decode.c, a mirror in eth-decode.ts, and a page in src/ui.c drawing
 * every argument. A kind added here without all three is a call the device
 * will sign and cannot describe, which is the one thing the seam exists to
 * prevent.
 *
 * Read from source rather than imported, like every other rule in this file:
 * the point is that the literal list is reviewable in a diff.
 */
group("device-drawn kinds are a closed set");
{
  const src = readFileSync(join(appRoot, "packages/core/src/app-proposal.ts"), "utf8");
  const block = /DEVICE_DRAWN_KINDS[^=]*=\s*new Set<string>\(\[([^\]]*)\]/.exec(src);
  check(block !== null, "DEVICE_DRAWN_KINDS is no longer a literal Set this test can read");
  /* Strip comments BEFORE splitting. The members are what this test is about;
   * a `/* ... *\/` block explaining why a member was admitted contains commas
   * and full stops, and splitting through it produced a "changed" list made of
   * prose fragments — which is a tripwire that fires correctly and then tells
   * you nothing. Removing comments does not weaken the check: it still
   * compares the exact set of members and still fails on any addition. */
  const members = (block?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  /* ATS issuance added 2026-09-11. All three parts exist and were added
   * together, which is what admits a kind to this set:
   *   firmware decoder  ats_decode_two_strings()  src/eth-decode.c
   *   host mirror       decodeTwoStrings()        packages/core/src/eth-decode.ts
   *   device pages      SIGN_PAGE_ATS_ACTION/_NAME/_SYMBOL  src/ui.c
   * It is admissible at all because the LeekSecurityFactory wrapper freezes a
   * 3,748-byte template on chain, so the two strings the screen shows are the
   * complete set of values the transaction chooses — not a summary of them. */
  const expected = [
    "CallKind.AquaShip",
    "CallKind.AquaDock",
    "CallKind.AtsDeployEquity",
    "CallKind.AtsDeployBond",
  ];
  check(
    members.length === expected.length && expected.every((e) => members.includes(e)),
    `DEVICE_DRAWN_KINDS has changed: ${JSON.stringify(members)}. Every member needs a ` +
      `firmware decoder, a host mirror and a device page. If you added one and all ` +
      `three exist, update this test and say why.`,
  );
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
