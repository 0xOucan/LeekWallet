/**
 * The log scan, and the one property it exists for.
 *
 * **A failed scan must never render as "you have issued nothing."** That is the
 * mistake the sibling log-scanning app records at length, and the reason this
 * file's heaviest group is the failure one: a security that exists but was not
 * seen is a row that is simply not on the screen, and there is no visual
 * treatment for an absent row. So one bad chunk refuses the whole discovery,
 * and `mergeSecurities` is written so that a failed `Discovery` cannot be
 * flattened into an empty array on the way to a view.
 *
 * The other group is the filter. Both topics are checked on the way out (the
 * node is asked for this caller's deployments only) and again on the way back
 * (a log whose caller is not the one asked for refuses the scan, rather than
 * being quietly dropped) — a relay that answers about somebody else has not
 * answered the question, and reporting its reply minus the odd rows would be
 * reporting a number this app made up.
 */

import {
  DEFAULT_SCAN_BLOCKS, LOG_CHUNK_BLOCKS, LOG_CHUNK_RETRIES, MAX_LOG_CHUNKS,
  FACTORY_DEPLOY_BLOCK, decodeDeployedData, discoverIssued, mergeSecurities,
} from "../src/discover.ts";
import { ISSUE_TOPIC } from "../src/issue.ts";
import { KNOWN_SECURITIES } from "../src/securities.ts";

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); failures++; }
};
const group = (n: string) => console.log(`== ${n}`);

const FACTORY = "0x1111111111111111111111111111111111111111";
const ISSUER = "0xbdeb381a7c77040bf2a99e2990c116774ccb339f";
const STRANGER = "0x9c77c6fafc1eb0821f1de12972ef0199c97c6e45";
const NEW_EQUITY = "0x2222222222222222222222222222222222222222";

const topicOf = (address: string): string => `0x${"0".repeat(24)}${address.slice(2)}`;

/** Two `string` fields, ABI-encoded exactly as the event emits them. */
const logData = (symbol: string, isin: string): string => {
  const tail = (text: string): string => {
    const hex = [...new TextEncoder().encode(text)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    /* Byte length, not character count: the ABI measures a string in bytes and
     * a helper that measured characters would encode a length the decoder is
     * right to reject. */
    return new TextEncoder().encode(text).length.toString(16).padStart(64, "0")
      + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  };
  const first = tail(symbol);
  const head = (0x40).toString(16).padStart(64, "0")
    + (0x40 + first.length / 2).toString(16).padStart(64, "0");
  return `0x${head}${first}${tail(isin)}`;
};

const equityLog = (caller: string, security: string, block: number) => ({
  topics: [ISSUE_TOPIC.deployEquity, topicOf(caller), topicOf(security)],
  data: logData("ACME", "ZZ0000000017"),
  blockNumber: `0x${block.toString(16)}`,
});

/** A request stub: head at `head`, and whatever `logs` says per chunk. */
const stub = (
  head: number,
  logs: (from: bigint, to: bigint) => unknown,
  calls?: Array<Record<string, unknown>>,
) => async (req: { method: string; params?: unknown }): Promise<unknown> => {
  if (req.method === "eth_blockNumber") return `0x${head.toString(16)}`;
  if (req.method === "eth_getLogs") {
    const filter = (req.params as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    calls?.push(filter);
    return logs(BigInt(filter.fromBlock as string), BigInt(filter.toBlock as string));
  }
  throw new Error(`unexpected ${req.method}`);
};

const run = async (): Promise<void> => {
  group("the window, and the constants that bound it");
  {
    /* The block of the deployment transaction recorded in issue.ts. Nothing
     * the factory emitted can be older, so this is where a full scan starts. */
    check(FACTORY_DEPLOY_BLOCK === 40_397_299n,
      `FACTORY_DEPLOY_BLOCK is ${FACTORY_DEPLOY_BLOCK}, not the deployment block`);
    /* The default span must fit inside the ceiling, or every default scan is
     * refused as range-too-large before it starts. */
    check(DEFAULT_SCAN_BLOCKS / LOG_CHUNK_BLOCKS + 1n <= BigInt(MAX_LOG_CHUNKS),
      "the default window needs more chunks than the ceiling allows");
    check(LOG_CHUNK_RETRIES >= 1, "a chunk gets no retry, so one transient 500 loses the scan");

    /* The default start: the deployment block while the head is near it, and a
     * clamp to a bounded window once the chain has moved past. Either way the
     * window comes back with the result, so a clamped scan is visible rather
     * than implied. */
    const near = await discoverIssued(
      stub(Number(FACTORY_DEPLOY_BLOCK as bigint) + 10, () => []) as never,
      ISSUER, FACTORY,
    );
    check(near.ok && near.window.fromBlock === FACTORY_DEPLOY_BLOCK,
      "a scan near the deployment did not start at the deployment block");

    const far = await discoverIssued(
      stub(Number(FACTORY_DEPLOY_BLOCK as bigint) + 1_000_000, () => []) as never,
      ISSUER, FACTORY,
    );
    check(far.ok && far.window.fromBlock ===
        (far.ok ? far.window.toBlock - DEFAULT_SCAN_BLOCKS : 0n),
      "a scan far past the deployment was not clamped to the default window");
    check(far.ok && far.window.fromBlock > (FACTORY_DEPLOY_BLOCK as bigint),
      "a clamped scan claimed to reach back to the deployment block");
  }

  group("an unset factory is refused, and is not an empty list");
  {
    const none = await discoverIssued(stub(100, () => []) as never, ISSUER, "");
    check(!none.ok && none.reason === "factory-unset", "an unset factory did not refuse");
    check(!none.ok && /not a statement about what this wallet has issued/.test(none.why),
      "the refusal does not say it is not an answer about this wallet");
  }

  group("a scan that works, chunked and filtered on chain");
  {
    const seen: Array<Record<string, unknown>> = [];
    const request = stub(
      2_500,
      (from, to) => (from <= 1_500n && 1_500n <= to ? [equityLog(ISSUER, NEW_EQUITY, 1_500)] : []),
      seen,
    );
    const found = await discoverIssued(request as never, ISSUER, FACTORY, {
      fromBlock: 0n, toBlock: 2_500n, chunkBlocks: 1_000n,
    });
    check(found.ok, `the scan failed: ${found.ok ? "" : found.why}`);
    check(found.ok && found.issued.length === 1, "the deployment was not found");
    check(found.ok && found.issued[0]?.address === NEW_EQUITY, "the wrong address was found");
    check(found.ok && found.issued[0]?.kind === "deployEquity", "the kind is wrong");
    check(found.ok && found.issued[0]?.symbol === "ACME", "the symbol was not decoded");
    check(found.ok && found.issued[0]?.blockNumber === 1_500n, "the block number was not decoded");
    check(found.ok && found.window.fromBlock === 0n && found.window.toBlock === 2_500n,
      "the window is not the one that was scanned");

    /* Three chunks, contiguous, no gaps and no overlap: a gap is a block that
     * was never looked at and would disappear from the result silently. */
    check(seen.length === 3, `${seen.length} requests, expected 3`);
    check(seen[0]?.fromBlock === "0x0" && seen[0]?.toBlock === "0x3e7", "the first chunk is wrong");
    check(seen[1]?.fromBlock === "0x3e8", "the second chunk does not start where the first ended");
    check(seen[2]?.toBlock === "0x9c4", "the last chunk does not end at the window's end");
    /* Filtered by the node: topic 0 is either event, topic 1 is this caller. */
    const topics = seen[0]?.topics as unknown[];
    check(Array.isArray(topics[0]) && (topics[0] as string[]).length === 2,
      "the filter does not ask for both events");
    check(topics[1] === topicOf(ISSUER), "the filter does not pin the caller");
    check(seen[0]?.address === FACTORY, "the filter is not aimed at the factory");
  }

  group("a failed chunk loses the whole scan, and says so");
  {
    let asked = 0;
    const request = async (req: { method: string; params?: unknown }): Promise<unknown> => {
      if (req.method === "eth_blockNumber") return "0x9c4";
      asked++;
      /* The first chunk answers; the second never does, however often it is
       * retried. The naive behaviour is to keep the first chunk's find. */
      const filter = (req.params as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
      if (BigInt(filter.fromBlock as string) === 0n) return [equityLog(ISSUER, NEW_EQUITY, 10)];
      throw new Error("range limit exceeded");
    };
    const failed = await discoverIssued(request as never, ISSUER, FACTORY, {
      fromBlock: 0n, toBlock: 2_500n, chunkBlocks: 1_000n,
    });
    check(!failed.ok, "a failed chunk was reported as a successful scan");
    check(!failed.ok && failed.reason === "logs-unavailable", "the failure has the wrong reason");
    check(!failed.ok && /reports none of what the other chunks saw/.test(failed.why),
      "the failure does not say the other chunks were discarded");
    check(asked === 1 + (1 + LOG_CHUNK_RETRIES),
      `${asked} requests, expected one good chunk plus ${1 + LOG_CHUNK_RETRIES} attempts`);
  }

  group("an unreadable head, an over-wide window, and a log of the wrong shape");
  {
    const noHead = await discoverIssued(
      (async (req: { method: string }) => {
        if (req.method === "eth_blockNumber") throw new Error("down");
        return [];
      }) as never, ISSUER, FACTORY,
    );
    check(!noHead.ok && noHead.reason === "head-unreadable", "an unreadable head did not refuse");

    const tooWide = await discoverIssued(stub(0, () => []) as never, ISSUER, FACTORY, {
      fromBlock: 0n, toBlock: 10_000_000n, chunkBlocks: 1_000n,
    });
    check(!tooWide.ok && tooWide.reason === "range-too-large",
      "a window needing thousands of requests was accepted");

    /* A log from another caller. The node was asked to filter; one that did not
     * has not answered the question, and dropping the row silently would report
     * a shorter list as if it were the list. */
    const stranger = await discoverIssued(
      stub(2_000, () => [equityLog(STRANGER, NEW_EQUITY, 10)]) as never,
      ISSUER, FACTORY, { fromBlock: 0n, toBlock: 500n, chunkBlocks: 1_000n },
    );
    check(!stranger.ok && stranger.reason === "undecodable",
      "a log from another caller was accepted or silently dropped");

    const garbled = await discoverIssued(
      stub(2_000, () => [{ topics: [ISSUE_TOPIC.deployEquity], data: "0x", blockNumber: "0x1" }]) as never,
      ISSUER, FACTORY, { fromBlock: 0n, toBlock: 500n, chunkBlocks: 1_000n },
    );
    check(!garbled.ok && garbled.reason === "undecodable", "a malformed log was accepted");

    const notAList = await discoverIssued(
      stub(2_000, () => ({ nope: true })) as never,
      ISSUER, FACTORY, { fromBlock: 0n, toBlock: 500n, chunkBlocks: 1_000n },
    );
    check(!notAList.ok && notAList.reason === "undecodable", "a non-list answer was accepted");
  }

  group("decoding the event's two strings");
  {
    const decoded = decodeDeployedData(logData("LEEKC", "ZZ0000000017"));
    check(decoded.symbol === "LEEKC", "the symbol did not decode");
    check(decoded.isin === "ZZ0000000017", "the ISIN did not decode");
    /* Host text on a line beside an address: the direction override is stripped
     * rather than rendered, the same rule abi.ts applies to `symbol()`. */
    const nasty = decodeDeployedData(logData("A‮B", "ZZ0000000017"));
    check(!nasty.symbol.includes("‮"), "a direction override survived into a label");
    let threw = false;
    try { decodeDeployedData("0x1234"); } catch { threw = true; }
    check(threw, "truncated log data decoded anyway");
  }

  group("merging keeps the two kinds of knowledge apart");
  {
    const failed = mergeSecurities({ ok: false, reason: "logs-unavailable", why: "down" });
    check(failed.length === KNOWN_SECURITIES.length,
      "a failed scan changed the size of the merged list");
    check(failed.every((c) => c.source === "table"),
      "a failed scan produced rows claiming to come from a log");

    const merged = mergeSecurities({
      ok: true,
      window: { fromBlock: 0n, toBlock: 1n },
      issued: [
        { address: NEW_EQUITY, kind: "deployEquity", symbol: "ACME", isin: "ZZ0000000017", blockNumber: 5n },
        /* One the table already knows: confirmed, not replaced. */
        {
          address: KNOWN_SECURITIES[0]?.address as string, kind: "deployEquity",
          symbol: "OTHER", isin: "ZZ0000000025", blockNumber: 6n,
        },
      ],
    });
    check(merged.length === KNOWN_SECURITIES.length + 1, "the discovered security was not added");
    const fresh = merged.find((c) => c.address === NEW_EQUITY);
    check(fresh?.source === "log", "a discovered security is not marked as coming from a log");
    check(fresh?.kind === "equity", "a discovered equity is not marked as one");
    const known = merged.find((c) => c.address === KNOWN_SECURITIES[0]?.address);
    check(known?.source === "both", "a confirmed security is not marked as confirmed");
    check(known?.symbol === KNOWN_SECURITIES[0]?.symbol,
      "a log's symbol overwrote the table's, losing the difference between them");
  }

  console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
};

void run();
