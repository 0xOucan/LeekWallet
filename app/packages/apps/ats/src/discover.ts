/**
 * "What have I issued?" — a log scan over `LeekSecurityFactory`.
 *
 * ---------------------------------------------------------------------------
 * Why a scan at all
 *
 * The factory keeps no list. It emits `EquityDeployed(address indexed caller,
 * address indexed security, string symbol, string isin)` and holds nothing,
 * which is the right shape for a contract with no owner and no storage worth
 * stealing — and it means the only source for "securities this wallet issued"
 * is the logs. The `caller` is indexed precisely so the question can be asked
 * with a topic filter instead of by walking every block; the contract's own
 * header records that un-indexed events elsewhere in this workspace cost this
 * project exactly that, and these were indexed so it would not happen twice.
 *
 * ---------------------------------------------------------------------------
 * A partial scan is refused outright, and that is the whole point
 *
 * The argument is copied, deliberately, from the sibling app that scans logs on
 * Base — quoted rather than imported, because no app in this workspace reaches
 * into another and a shared helper would make deleting either of them a code
 * change in the other. Its header puts it better than a summary can: when chunk
 * 7 of 12 fails, the obvious move is to return what the other eleven found, and the securities that were not seen
 * then render as *securities you do not have*. There is no visual treatment
 * that fixes a row which is simply not on the screen. So one failed chunk makes
 * the whole discovery `{ ok: false }`, and the view must render that as "we
 * could not look" — never as "you have none".
 *
 * The same applies to a log this file cannot decode. A malformed log means the
 * response did not come from the contract whose layout is assumed, and the rest
 * of the batch is no more trustworthy for having parsed.
 *
 * ---------------------------------------------------------------------------
 * The window, and what is not known about it
 *
 * There is no honest "everything": `fromBlock: 0` against a public Hedera relay
 * is refused or times out, and the factory's deployment block is not known
 * because the factory is not deployed. So the default is a window, the window
 * travels back with the result, and `DISCOVERY_NOTICE` says out loud that
 * anything older than it was not looked for. Once the factory is broadcast,
 * `FACTORY_DEPLOY_BLOCK` below should be filled in beside
 * `LEEK_SECURITY_FACTORY`; the scan then starts there and the caveat shrinks to
 * nothing.
 */

import type { EthRequest } from "@leekwallet/core/balances.ts";
import { ISSUE_TOPIC, type IssueKind } from "./issue.ts";
import { KNOWN_SECURITIES, type KnownSecurity } from "./securities.ts";

/* --------------------------------------------------------------- the window */

/**
 * Blocks per `eth_getLogs`.
 *
 * **Not measured against a Hedera relay.** The sibling log-scanning app's
 * constant was measured chunk by chunk against three Base providers, and its
 * file records what each one said; nothing equivalent has been run against
 * `testnet.hashio.io`. 1,000 is below every documented cap this project has
 * met (the lowest being 2,000) and is therefore a guess biased towards working
 * rather than towards speed. If a scan starts failing with a "range" error,
 * this is the number to lower, and the measurement belongs in this comment when
 * someone makes it.
 */
export const LOG_CHUNK_BLOCKS = 1_000n;

/**
 * The block `LeekSecurityFactory` was deployed in.
 *
 * 40,397,299 — the block of the deployment transaction recorded beside
 * `LEEK_SECURITY_FACTORY`. Nothing this factory emitted can be older, so a scan
 * that starts here and reaches the head has looked at all of it, and the "older
 * than the window" caveat in `DISCOVERY_NOTICE` stops applying.
 *
 * It only stops applying while the chain is close enough behind: the start is
 * clamped to `toBlock - DEFAULT_SCAN_BLOCKS` (see `discoverIssued`), so once the
 * head is more than that past deployment the scan covers the recent end and the
 * window says so. Clamping rather than refusing is deliberate — a scan that
 * refuses outright as the chain ages is a panel that stops working on a
 * schedule, and the window is rendered next to the result either way.
 */
export const FACTORY_DEPLOY_BLOCK: bigint | undefined = 40_397_299n;

/**
 * How far back to look when neither the caller nor `FACTORY_DEPLOY_BLOCK` says.
 *
 * Bounded by `LOG_CHUNK_BLOCKS × MAX_LOG_CHUNKS`, and the scan refuses up front
 * rather than truncating silently when a caller exceeds it: 50,000 blocks at
 * 1,000 per chunk is 50 requests, inside the ceiling of 64. Raising this
 * without raising the ceiling turns every scan into `range-too-large`.
 */
export const DEFAULT_SCAN_BLOCKS = 200_000n;

/**
 * Ceiling on chunks per scan, so a bad `fromBlock` cannot become a flood.
 *
 * 256 at 1,000 blocks each covers `DEFAULT_SCAN_BLOCKS` with room to spare. It
 * is larger than the sibling app's 64 because Hedera's blocks are seconds
 * apart: 64,000 blocks there is a day and a half of history, which would have
 * made a security issued last week invisible by default.
 */
export const MAX_LOG_CHUNKS = 256;

/** Extra attempts per chunk before the scan gives up. Reads, so repeating is free. */
export const LOG_CHUNK_RETRIES = 2;

export const DISCOVERY_NOTICE =
  "This list is what the factory's logs say inside the block window shown " +
  "beside it, and nothing else. The scan starts at the factory's own " +
  "deployment block where it can, and at a fixed number of blocks back from " +
  "the head when that is nearer — so compare the window's start against the " +
  "deployment block before reading this list as complete. A security issued " +
  "before the window is not listed and was not looked for. If the scan fails, this console says so and " +
  "lists nothing — an empty list after a failure would be a claim that you " +
  "have issued nothing, which is a different sentence entirely.";

export interface ScanWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ScanOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
  chunkBlocks?: bigint;
  maxChunks?: number;
}

export type DiscoveryFailure =
  | "head-unreadable"
  | "logs-unavailable"
  | "undecodable"
  | "range-too-large"
  | "factory-unset";

/**
 * One security this wallet issued, as the log describes it.
 *
 * `symbol` and `isin` are the factory's own event fields, which makes them a
 * better label than `securities.ts`'s table — they were emitted by the contract
 * rather than written down here — and still a LABEL: nothing on a screen may be
 * read out of them as a figure, and the register read is what produces numbers.
 */
export interface IssuedSecurity {
  address: string;
  kind: IssueKind;
  symbol: string;
  isin: string;
  /** The block the deployment was mined in, for ordering and for an explorer. */
  blockNumber: bigint;
}

export type Discovery =
  | { ok: true; window: ScanWindow; issued: IssuedSecurity[] }
  | { ok: false; reason: DiscoveryFailure; window?: ScanWindow; why: string };

const hexQuantity = (value: bigint): string => `0x${value.toString(16)}`;

function parseQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("not a hex quantity");
  }
  return BigInt(value);
}

/** A 32-byte topic word that must be a clean address. Dirty upper bytes are a refusal. */
function addressTopic(topic: unknown): string {
  if (typeof topic !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) {
    throw new Error("a topic is not a clean 20-byte address");
  }
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * The two `string` fields out of a log's data, bounds-checked at every step.
 *
 * Same discipline as abi.ts: every offset and length is compared against the
 * actual byte length before it is used, and anything that does not add up
 * throws rather than being read as far as it parses. The text is then bounded
 * and filtered to printable ASCII — these are host-supplied strings destined
 * for a line beside an address, which is the label-attack shape that
 * `sanitiseText` exists for.
 */
export function decodeDeployedData(data: unknown): { symbol: string; isin: string } {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error("log data is not whole-byte hex");
  }
  const body = data.slice(2);
  if (body.length < 128) throw new Error("log data is shorter than its two head words");
  const at = (i: number): number => {
    const raw = BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);
    if (raw > BigInt(body.length / 2)) throw new Error("an offset is out of range");
    return Number(raw);
  };
  const readString = (offset: number): string => {
    const start = offset * 2;
    if (start + 64 > body.length) throw new Error("a string offset is past the data");
    const length = Number(BigInt(`0x${body.slice(start, start + 64)}`));
    if (start + 64 + length * 2 > body.length) throw new Error("a string is truncated");
    const bytes = new Uint8Array(length);
    const hex = body.slice(start + 64, start + 64 + length * 2);
    for (let i = 0; i < length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const printable = [...text]
      .filter((ch) => {
        const c = ch.codePointAt(0) as number;
        return c >= 0x20 && c <= 0x7e;
      })
      .join("")
      .trim();
    return printable.length > 32 ? `${printable.slice(0, 32)}…` : printable;
  };
  return { symbol: readString(at(0)), isin: readString(at(1)) };
}

/**
 * Scan for the securities one address issued, in a block window.
 *
 * `issuer` is filtered on chain, in topic position 1, so the relay is asked
 * only about this address's deployments — the opposite of Aqua's scan, which is
 * forced to fetch everybody's and filter here. The relay does learn which
 * issuer is asking; that is inherent in a filtered query and is the trade the
 * indexed event was added to make.
 */
export async function discoverIssued(
  request: EthRequest,
  issuer: string,
  factory: string,
  options: ScanOptions = {},
): Promise<Discovery> {
  const wanted = issuer.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wanted)) {
    return { ok: false, reason: "undecodable", why: "the issuer is not a 20-byte address" };
  }
  if (factory.trim() === "" || !/^0x[0-9a-fA-F]{40}$/.test(factory.trim())) {
    /* Not an empty result. There is no factory to have issued anything from,
     * and "nothing found" would read as a statement about this wallet. */
    return {
      ok: false,
      reason: "factory-unset",
      why:
        "LeekSecurityFactory has no address in this build, so there are no logs " +
        "to scan. This is not a statement about what this wallet has issued.",
    };
  }
  const target = factory.trim().toLowerCase();

  let toBlock: bigint;
  if (options.toBlock !== undefined) {
    toBlock = options.toBlock;
  } else {
    try {
      toBlock = parseQuantity(await request({ method: "eth_blockNumber", params: [] }));
    } catch (e) {
      /* Not "nothing issued". We never got as far as asking. */
      return {
        ok: false,
        reason: "head-unreadable",
        why: `the node would not say what block it is on: ${String((e as Error)?.message ?? e)}`,
      };
    }
  }

  /* Where a scan starts when the caller does not say: the factory's own
   * deployment block, because nothing older can exist — but never further back
   * than `DEFAULT_SCAN_BLOCKS`, which is what keeps the request count bounded
   * as the chain moves on. Whichever of the two wins, the window is returned
   * and rendered, so a clamped scan says what it looked at rather than implying
   * it looked at everything. */
  const floor = toBlock > DEFAULT_SCAN_BLOCKS ? toBlock - DEFAULT_SCAN_BLOCKS : 0n;
  const deployed = FACTORY_DEPLOY_BLOCK ?? 0n;
  const start = options.fromBlock ?? (deployed > floor ? deployed : floor);
  if (start > toBlock) {
    return {
      ok: false, reason: "range-too-large",
      why: `the window starts at ${start}, after its end at ${toBlock}`,
    };
  }
  const window: ScanWindow = { fromBlock: start, toBlock };

  const chunkBlocks = options.chunkBlocks ?? LOG_CHUNK_BLOCKS;
  const maxChunks = options.maxChunks ?? MAX_LOG_CHUNKS;
  if (chunkBlocks <= 0n) {
    return { ok: false, reason: "range-too-large", window, why: "a chunk of zero blocks scans nothing" };
  }
  if ((toBlock - start) / chunkBlocks + 1n > BigInt(maxChunks)) {
    return {
      ok: false, reason: "range-too-large", window,
      why:
        `that window is more than ${maxChunks} requests of ${chunkBlocks} blocks. ` +
        "Narrow it rather than let this app quietly scan part of it.",
    };
  }

  const byAddress = new Map<string, IssuedSecurity>();

  for (let from = start; from <= toBlock; from += chunkBlocks) {
    const end = from + chunkBlocks - 1n > toBlock ? toBlock : from + chunkBlocks - 1n;
    let logs: unknown;
    /* Bounded retry per chunk, for the reason positions.ts records: the scan is
     * all-or-nothing, so without a retry one transient 500 from a public node
     * throws away every other chunk's work — and a failed discovery is not
     * cosmetic here either, since a security that cannot be listed cannot be
     * minted from this console at all. */
    for (let attempt = 0; ; attempt++) {
      try {
        logs = await request({
          method: "eth_getLogs",
          params: [{
            address: target,
            /* Topic 0 as an array is "EquityDeployed OR BondDeployed"; topic 1
             * pins the caller. One request per chunk, filtered by the node. */
            topics: [[ISSUE_TOPIC.deployEquity, ISSUE_TOPIC.deployBond], padTopic(wanted)],
            fromBlock: hexQuantity(from),
            toBlock: hexQuantity(end),
          }],
        });
        break;
      } catch (e) {
        if (attempt >= LOG_CHUNK_RETRIES) {
          return {
            ok: false, reason: "logs-unavailable", window,
            why:
              `blocks ${from}–${end} could not be read after ${attempt + 1} attempts ` +
              `(${String((e as Error)?.message ?? e)}), so this scan found nothing it can ` +
              "stand behind and reports none of what the other chunks saw.",
          };
        }
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
    if (!Array.isArray(logs)) {
      return { ok: false, reason: "undecodable", window, why: "the node's answer was not a list of logs" };
    }

    for (const raw of logs) {
      try {
        const log = raw as { topics?: unknown; data?: unknown; blockNumber?: unknown };
        const topics = log.topics;
        if (!Array.isArray(topics) || topics.length < 3) throw new Error("too few topics");
        const kind = (Object.keys(ISSUE_TOPIC) as IssueKind[])
          .find((k) => ISSUE_TOPIC[k] === String(topics[0]).toLowerCase());
        if (kind === undefined) throw new Error("a log carries an event this filter did not ask for");
        if (addressTopic(topics[1]) !== wanted) {
          throw new Error("a log's caller is not the address the filter named");
        }
        const address = addressTopic(topics[2]);
        const { symbol, isin } = decodeDeployedData(log.data);
        byAddress.set(address, {
          address, kind, symbol, isin, blockNumber: parseQuantity(log.blockNumber),
        });
      } catch (e) {
        return {
          ok: false, reason: "undecodable", window,
          why:
            `a log did not have the shape this factory emits (${String((e as Error)?.message ?? e)}), ` +
            "so none of this scan is reported. A response that is wrong about one log " +
            "is not trustworthy about the rest.",
        };
      }
    }
  }

  const issued = [...byAddress.values()].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
  return { ok: true, window, issued };
}

const padTopic = (address: string): string => `0x${"0".repeat(24)}${address.slice(2)}`;

/* ----------------------------------------------------------------- merging */

/**
 * One entry in the console's list of securities to act on.
 *
 * `source` is carried rather than flattened away because the two halves are
 * known differently and a user is owed the difference: `table` is this repo's
 * hard-coded note about four addresses deployed by an EOA before the factory
 * existed, and `log` is a deployment this wallet made and the chain recorded.
 * Merging them into one anonymous list would put a claim written in a source
 * file next to a fact read off a chain with nothing to tell them apart.
 */
export interface SecurityChoice {
  address: string;
  symbol: string;
  /** The table's long name, or the ISIN for a discovered one. Advisory, always. */
  note: string;
  kind: "equity" | "bond";
  source: "table" | "log" | "both";
}

const kindOf = (k: IssueKind): "equity" | "bond" =>
  k === "deployEquity" ? "equity" : "bond";

/**
 * The hard-coded table plus whatever the scan found, by address, without
 * either half being able to hide the other.
 *
 * A discovered security whose address is already in the table keeps the table's
 * name and is marked `both` — the scan confirmed it rather than replaced it.
 * Discovery is passed in as the whole `Discovery`, not as an array, so a caller
 * cannot reach this function with a failed scan flattened to `[]`: a failure
 * returns the table alone, and the view still has the `Discovery` in hand to
 * render the failure beside it.
 */
export function mergeSecurities(
  discovery: Discovery,
  table: readonly KnownSecurity[] = KNOWN_SECURITIES,
): SecurityChoice[] {
  const out = new Map<string, SecurityChoice>();
  for (const s of table) {
    out.set(s.address.toLowerCase(), {
      address: s.address.toLowerCase(),
      symbol: s.symbol,
      note: s.name,
      kind: s.kind,
      source: "table",
    });
  }
  if (!discovery.ok) return [...out.values()];
  for (const issued of discovery.issued) {
    const existing = out.get(issued.address);
    if (existing) {
      out.set(issued.address, { ...existing, source: "both" });
      continue;
    }
    out.set(issued.address, {
      address: issued.address,
      symbol: issued.symbol === "" ? "(no symbol in the log)" : issued.symbol,
      note: issued.isin === "" ? `issued in block ${issued.blockNumber}` : `ISIN ${issued.isin}`,
      kind: kindOf(issued.kind),
      source: "log",
    });
  }
  return [...out.values()];
}
