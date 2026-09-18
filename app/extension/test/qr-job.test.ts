/**
 * How a QR job ends. Each ending that is the user saying no - Cancel, or
 * closing the tab - must reach the dapp as 4001 and never leave it waiting;
 * a scan that is refused must leave the job open for a rescan; and nothing
 * but the open job's own id may answer it.
 */

import { QrJobError, QrJobs, type QrTabs } from "../src/qr-job.ts";

let failures = 0;
const check = (ok: boolean, why: string): void => {
  if (!ok) { failures++; console.log(`  FAIL: ${why}`); }
};
const group = (name: string): void => console.log(`\n== ${name}`);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeTabs(): QrTabs & { opened: string[]; closed: number[] } {
  let next = 100;
  const t = {
    opened: [] as string[],
    closed: [] as number[],
    async open(id: string) { t.opened.push(id); return next++; },
    close(tabId: number) { t.closed.push(tabId); },
  };
  return t;
}

const VIEW = { title: "t", summary: [], scan: { type: "eth-signature", instructions: "" } };

/** Settle a promise into a plain record, so a test can look without awaiting forever. */
function watch<T>(p: Promise<T>): { state: "pending" | "ok" | "err"; value?: T; error?: unknown } {
  const w: { state: "pending" | "ok" | "err"; value?: T; error?: unknown } = { state: "pending" };
  p.then((v) => { w.state = "ok"; w.value = v; }, (e) => { w.state = "err"; w.error = e; });
  return w;
}

group("closing the job's tab rejects the dapp with 4001");
{
  const tabs = fakeTabs();
  const jobs = new QrJobs(tabs);
  const w = watch(jobs.run(VIEW, async () => "raw"));
  await tick();
  jobs.tabClosed(999);                         // someone else's tab
  await tick();
  check(w.state === "pending", "an unrelated tab closing ended the job");
  jobs.tabClosed(100);
  await tick();
  check(w.state === "err", "closing the job's tab left the dapp waiting");
  check(w.error instanceof QrJobError && (w.error as QrJobError).code === 4001,
    "a closed tab was not reported as the user rejecting");
}

group("Cancel rejects with 4001 and closes the tab; a wrong id does nothing");
{
  const tabs = fakeTabs();
  const jobs = new QrJobs(tabs);
  const w = watch(jobs.run(VIEW, async () => "raw"));
  await tick();
  jobs.cancel("not-the-job");
  await tick();
  check(w.state === "pending", "a cancel naming another job ended this one");
  jobs.cancel(tabs.opened[0]!);
  await tick();
  check(w.state === "err" && (w.error as QrJobError).code === 4001, "cancel was not a 4001");
  check(tabs.closed.includes(100), "the tab was left open after cancel");
}

group("a refused scan keeps the job open; an accepted one resolves it");
{
  const tabs = fakeTabs();
  const jobs = new QrJobs(tabs);
  let calls = 0;
  const w = watch(jobs.run(VIEW, async (cbor) => {
    calls++;
    if (cbor[0] !== 0xaa) throw new Error("that signature answers a different request");
    return "signed";
  }));
  await tick();
  const id = tabs.opened[0]!;
  const bad = await jobs.done(id, "bb");
  check(!bad.done && bad.retry, "a refused scan did not ask for a rescan");
  check(w.state === "pending", "a refused scan ended the dapp's request");
  const stranger = await jobs.done("q0-forged", "aa");
  check(!stranger.done && !stranger.retry, "a done for another job id was accepted");
  check(calls === 1, "a done for another job id reached the check");
  const good = await jobs.done(id, "aa");
  await tick();
  check(good.done, "the right scan was not accepted");
  check(w.state === "ok" && w.value === "signed", "the dapp did not get the accepted value");
  check(!jobs.isOpen(id), "the job stayed open after it was answered");
}

group("only one job at a time");
{
  const jobs = new QrJobs(fakeTabs());
  void jobs.run(VIEW, async () => 1).catch(() => {});
  const second = watch(jobs.run(VIEW, async () => 2));
  await tick();
  check(second.state === "err", "a second QR job was allowed while one was open");
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
if (failures > 0) process.exit(1);
