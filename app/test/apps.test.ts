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

group("the shell touches apps only through the registry");
{
  // One edge, in one file, so removal is one deletion. Anything else in
  // src/ importing an app would be a second place to remember.
  const registry = join(appRoot, "src", "apps", "registry.ts");
  for (const file of sourcesOf(join(appRoot, "src"))) {
    if (file === registry) continue;
    const source = readFileSync(file, "utf8");
    for (const app of apps) {
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

  // No signer among AppContext's FIELDS. A read-only app should be
  // structurally unable to sign, and the moment that changes should be a diff
  // on this line. Comments are excluded from the search on purpose: this file's
  // prose is largely about why signing is absent, and matching it would make
  // the assertion fire on the explanation rather than on the thing.
  const body = /export interface AppContext \{([\s\S]*?)\n\}/.exec(contract)?.[1] ?? "";
  check(body.length > 0, "AppContext's declaration could not be found");
  const fields = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  check(!/signer|sign|device|transport|key/i.test(fields),
    `AppContext has grown a signing capability: ${fields.trim()}`);
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

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
