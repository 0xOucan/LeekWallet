#!/usr/bin/env python3
"""
Print the ship transaction hash of a maker's newest OPEN Aqua position.

    python3 script/latest-position.py <rpc> <registry> <maker> [scan_blocks]

Used by fill-position.sh when it is run without a hash.

Two constraints shape it:

  * Aqua does not index the maker in its events, so there is no log filter for
    "this device's positions". Every maker's Shipped events come back and the
    maker is read out of the event data.
  * The public Base RPC caps eth_getLogs at 2,000 blocks per request, and a
    2-hour position deadline is ~3,600 Base blocks. So the window is walked in
    chunks, newest first, and the scan stops at the first match.

A position the maker docked afterwards is skipped -- nothing is left in it to
fill -- and the scan continues to the one before it. Exits non-zero with a
sentence when nothing open is found.
"""
import json
import sys
import time
import urllib.error
import urllib.request

SHIPPED = "0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0"
DOCKED = "0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004"
CHUNK = 2000


def main() -> None:
    rpc, registry, maker = sys.argv[1], sys.argv[2], sys.argv[3].lower()
    span = int(sys.argv[4]) if len(sys.argv) > 4 else 6000

    def call(method, params):
        # A named User-Agent: mainnet.base.org answers Python's default one
        # with 403 Forbidden before reading the request.
        req = urllib.request.Request(
            rpc,
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
            {"content-type": "application/json", "user-agent": "leekwallet-aqua-fill/1"},
        )
        # A long scan is many requests; a public RPC rate-limits, so back off
        # and retry rather than failing a demo on the fortieth chunk.
        for attempt in range(5):
            try:
                out = json.load(urllib.request.urlopen(req, timeout=30))
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4:
                    sys.exit(f"rpc http error {e.code} from {rpc}")
                time.sleep(1.5 * (attempt + 1))
        if "error" in out:
            sys.exit(f"rpc error: {out['error'].get('message')}")
        return out["result"]

    def logs(topic, lo, hi):
        return call("eth_getLogs", [{
            "address": registry, "topics": [topic],
            "fromBlock": hex(lo), "toBlock": hex(hi),
        }])

    def words(data):
        return [data[2:][i:i + 64] for i in range(0, len(data) - 2, 64)]

    def chunks(head, floor):
        hi = head
        while hi > floor:
            lo = max(floor, hi - CHUNK + 1)
            yield lo, hi
            hi = lo - 1

    head = int(call("eth_blockNumber", []), 16)
    floor = max(0, head - span)

    # Maker, app and strategy hash are the first three data words of both events.
    docked = set()
    for lo, hi in chunks(head, floor):
        for log in logs(DOCKED, lo, hi):
            w = words(log["data"])
            if ("0x" + w[0][24:]).lower() == maker:
                docked.add(w[2])

    for lo, hi in chunks(head, floor):
        for log in reversed(logs(SHIPPED, lo, hi)):
            w = words(log["data"])
            if ("0x" + w[0][24:]).lower() != maker:
                continue
            if w[2] in docked:
                print(f"    skipping {log['transactionHash']} (docked)", file=sys.stderr)
                continue
            print(log["transactionHash"])
            return

    sys.exit(f"no open position shipped by {maker} in the last {span} blocks")


if __name__ == "__main__":
    main()
