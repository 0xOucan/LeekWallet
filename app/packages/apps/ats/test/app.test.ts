/**
 * The manifest, and the one place this app asked core's contract to change.
 *
 * `AppContext.endpointHost` is a getter — `() => string | undefined` — rather
 * than the snapshot string the rest of the context carries, and this file is
 * why. Which operator answered is not knowable when an app mounts, because no
 * request has been made yet; and it can change during a single read, because
 * `FailoverRpc` moves to the next endpoint when one goes quiet. A value
 * captured at mount would therefore be empty at best and, once failover has
 * happened, a false statement about who saw the data.
 *
 * That matters here more than it would in most apps: this console's entire
 * discipline is that no figure reaches a screen without the block, the age and
 * the operator arriving beside it. A provenance line naming the wrong operator
 * is exactly the kind of confident-but-wrong label the register code spends
 * three hundred lines avoiding elsewhere.
 *
 * No DOM. The properties below are properties of data and strings, and a test
 * that needed jsdom to reach them would be a test nobody runs.
 */

import { ATS_APP, ATS_CHAIN_ID } from "../src/index.ts";
import { fixtureRequest } from "../src/fixtures.ts";
import { readRegister, registerProvenance } from "../src/register.ts";

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string): void => console.log(`== ${n}`);

const TOKEN = "0x00000000000000000000000000000000004e5f21";

group("the manifest is what the registry expects");
{
  check(ATS_APP.id === "ats", `id is ${ATS_APP.id}`);
  check(ATS_APP.chainIds.length === 1 && ATS_APP.chainIds[0] === ATS_CHAIN_ID,
        "the app should offer itself on Hedera testnet only");
  check(ATS_APP.summary.length > 0 && !ATS_APP.summary.includes("\n"),
        "summary should be one line");
  check(typeof ATS_APP.mount === "function", "mount is not a function");

  // Every rule in the stylesheet must be prefixed. The shell injects all apps'
  // CSS into one document, so an unprefixed `.row` here would restyle the
  // wallet and every other app.
  const selectors = ATS_APP.css.match(/^\s*\.[A-Za-z][\w-]*/gm) ?? [];
  check(selectors.length > 0, "the stylesheet has no class selectors to check");
  for (const sel of selectors) {
    check(sel.trim().startsWith(".ats-"), `unprefixed selector in the app CSS: ${sel.trim()}`);
  }
}

group("the endpoint host is read when a figure is rendered, not at mount");
{
  /* A getter whose answer changes, which is what failover looks like from an
   * app's side. The view must carry the value as of the read that produced it. */
  let current: string | undefined;
  const host = (): string | undefined => current;

  current = undefined; // nothing has answered yet — the state at mount time
  const request = fixtureRequest();
  // The host becomes known only once requests start; simulate that by moving
  // it on before the read completes.
  const readPromise = readRegister(request, ATS_CHAIN_ID, TOKEN, host);
  current = "testnet.hashio.io";
  const view = await readPromise;

  check(view.endpointHost === "testnet.hashio.io",
        `the view captured ${String(view.endpointHost)}, not the host at read time`);
  check(registerProvenance(view, view.fetchedAt).includes("testnet.hashio.io"),
        "the provenance line must name the operator that answered");

  // And a later failover must not silently rewrite a view already rendered:
  // the view holds the host as of ITS read, not whatever the getter says now.
  current = "296.rpc.thirdweb.com";
  check(view.endpointHost === "testnet.hashio.io",
        "an already-read view must not follow the getter after the fact");

  // A host that is genuinely unknown says so rather than naming nobody in
  // particular as if it were somebody.
  const blind = await readRegister(fixtureRequest(), ATS_CHAIN_ID, TOKEN, () => undefined);
  check(blind.endpointHost === undefined, "an unknown host must stay undefined");
  check(registerProvenance(blind, blind.fetchedAt).includes("an RPC endpoint"),
        "an unknown host must be described, not omitted");
}

console.log(failures === 0 ? "PASSED (0 failures)" : `FAILED (${failures})`);
if (failures > 0) process.exit(1);
