#!/usr/bin/env python3
"""
Mutation check for the BLE transport tests.

A test suite that passes is evidence of nothing until you have watched it fail.
Each mutant below is a plausible mistake in the code this change adds — an
off-by-one in the chunk capacity, a dropped bound, a sync marker on the wrong
transport, a transport switch that forgets the session. If a mutant survives,
the corresponding test is decorative.

  python3 sim/mutants.py
"""

import subprocess, shutil, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
    # file, find, replace, which test binaries should notice
    ("src/ble-chunk.c", "size_t capacity = (size_t)mtu - 3 - 1;",
     "size_t capacity = (size_t)mtu - 3;", "chunk larger than the MTU allows"),
    ("src/ble-chunk.c", "if (seq != r->next_seq) {",
     "if (false) {", "out-of-order chunks accepted"),
    ("src/ble-chunk.c", "if (total < 4 || total > sizeof(r->buf) || r->len > total) {",
     "if (false) {", "declared length unbounded"),
    ("src/ble-chunk.c", "if (r->len + body > sizeof(r->buf)) {",
     "if (false) {", "reassembly buffer unbounded"),
    ("src/ble-chunk.c", "if (!more && r->len != total) {",
     "if (false) {", "trailing/truncated bodies accepted"),
    ("src/ble-chunk.c", "r->next_seq = (uint8_t)((r->next_seq + 1) & BLE_CHUNK_SEQ_MASK);",
     "r->next_seq = (uint8_t)(r->next_seq + 1);", "sequence wrap wrong"),
    ("src/ble-chunk.c", "if (body == 0) {", "if (false) {",
     "payload-free chunks accepted"),
    ("src/ble-chunk.c", "if (mtu < 5) {", "if (mtu < 1) {",
     "unusable MTU accepted"),
    ("src/protocol.c", "if (tx_writer) {", "if (false) {",
     "BLE replies go to the cable"),
    ("src/protocol.c",
     "    if (!rx_enabled) {", "    if (false) {",
     "USB answers while BLE is selected"),
    ("src/transport.c", "    session_reset();\n    protocol_reset_rx();",
     "    protocol_reset_rx();", "session survives a transport switch"),
    ("src/transport.c", "        ble_transport_stop();               /* advertising off, not just idle */",
     "        /* mutant: left advertising */", "BLE keeps advertising on USB"),
    ("src/transport.c", "        protocol_set_rx_enabled(false);     /* USB endpoint stops answering */",
     "        protocol_set_rx_enabled(true);", "cable stays live under BLE"),
]

BINARIES = ["test_protocol", "test_ble_chunk", "test_ui"]


def run(cmd, **kw):
    return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, **kw)


def build_and_run():
    """Return the set of suites that failed (build failure counts as caught)."""
    failed = set()
    for b in BINARIES:
        r = run(f"make -C sim build/{b}")
        if r.returncode != 0:
            failed.add(b + " (build)")
            continue
        r = run(f"./sim/build/{b}")
        if r.returncode != 0:
            failed.add(b)
    return failed


def main():
    baseline = build_and_run()
    if baseline:
        print("baseline is not green:", baseline)
        return 1

    killed, survived = 0, []
    for path, find, repl, label in MUTANTS:
        full = os.path.join(ROOT, path)
        original = open(full).read()
        if find not in original:
            print(f"SKIP  {label}: pattern not found in {path}")
            survived.append(label + " (pattern missing)")
            continue
        open(full, "w").write(original.replace(find, repl, 1))
        try:
            failed = build_and_run()
        finally:
            open(full, "w").write(original)
        if failed:
            killed += 1
            print(f"KILLED  {label}  <- {', '.join(sorted(failed))}")
        else:
            survived.append(label)
            print(f"SURVIVED {label}")

    # Leave the tree rebuilt from pristine sources.
    build_and_run()

    print(f"\n{killed}/{len(MUTANTS)} mutants killed")
    for s in survived:
        print("  survived:", s)
    return 0 if not survived else 1


if __name__ == "__main__":
    sys.exit(main())
