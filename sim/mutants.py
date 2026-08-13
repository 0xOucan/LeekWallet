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

    # The widened decodable set (T50) and the blind-signing hatch (T16). Each
    # of these is the shape of a real mistake: a length check that stops being
    # exact, an argument shape copied from the row above, a warning screen that
    # accepts the first press, a gate that stops consulting the setting.
    ("src/eth-decode.c", "    if (len != 4 + words * 32) {",
     "    if (len < 4 + words * 32) {", "trailing bytes after a known selector"),
    ("src/eth-decode.c", "    if (word[31] > 1) {", "    if (false) {",
     "a bool that is neither 0 nor 1"),
    ("src/eth-decode.c", "    for (int i = 0; i < 31; i++) {", "    for (int i = 0; i < 0; i++) {",
     "dirty high bytes in a bool word"),
    ("src/eth-decode.c", "{ SEL_MINT,          ETH_CALL_MINT,                ARGS_UINT           },",
     "{ SEL_MINT,          ETH_CALL_MINT,                ARGS_ADDR_UINT      },",
     "mint(uint256) read at the wrong arity"),
    ("src/eth-decode.c", "call.unlimited = (known->kind == ETH_CALL_ERC20_APPROVE) &&",
     "call.unlimited = (known->kind != ETH_CALL_UNKNOWN) &&",
     "unlimited warning on calls that are not allowances"),
    ("src/eth-decode.c", "if (!word_is_address(w0) || !word_is_address(w1)) goto done;",
     "if (!word_is_address(w0)) goto done;",
     "dirty padding on transferFrom's destination"),
    ("src/eth-decode.c", "    if (!tx->has_to) {", "    if (false) {",
     "contract creation reaches the decoder"),
    ("src/protocol.c", "if (!(tx.has_to && blind_signing_enabled())) {",
     "if (!blind_signing_enabled()) {",
     "the hatch unlocks contract creation"),
    ("src/protocol.c", "if (!(tx.has_to && blind_signing_enabled())) {", "if (false) {",
     "undecodable calldata always allowed"),
    ("src/protocol.c", "cbor_write_uint(&w, blind_signing_enabled() ? 1 : 0);",
     "cbor_write_uint(&w, 0);", "getFeatures hides the setting"),
    ("src/blind-signing.c", "        enabled = (stored == 1);", "        enabled = true;",
     "any stored byte turns blind signing on"),
    ("src/blind-signing.c", "    enabled = false;      /* the default",
     "    enabled = true;       /* the default", "blind signing defaults to on"),
    ("src/ui.c", "if (++blind_confirm_count >= BLIND_CONFIRM_PRESSES) {",
     "if (++blind_confirm_count >= 1) {", "one press enables blind signing"),
    ("src/ui.c", "    sign_blind = (sign_call.kind == ETH_CALL_UNKNOWN);",
     "    sign_blind = false;", "a blind confirmation looks like a normal one"),
    ("src/ui.c", "            sign_page_kind[n++] = SIGN_PAGE_BLIND_DATA;",
     "            /* mutant: no calldata digest */", "blind confirmation hides the calldata"),
    ("src/ui.c", "            sign_page_kind[n++] = SIGN_PAGE_BLIND_WARN;",
     "            /* mutant: no warning page */", "blind confirmation drops the warning"),

    # Job 1: a reply must match the frame type of the request that caused it.
    # Each of these is the old, state-driven behaviour, or its mirror.
    ("src/protocol.c",
     "if (allow_encrypt && reply_encrypted && session_state() == SESSION_ACTIVE) {",
     "if (allow_encrypt && session_state() == SESSION_ACTIVE) {",
     "a plaintext request gets an encrypted error"),
    ("src/protocol.c",
     "    if (reply_encrypted && session_state() == SESSION_ACTIVE) {\n        int enc = session_encrypt(out, w.length, sizeof(out));",
     "    if (session_state() == SESSION_ACTIVE) {\n        int enc = session_encrypt(out, w.length, sizeof(out));",
     "a plaintext request gets an encrypted response"),
    ("src/protocol.c",
     "            reply_encrypted = true;\n            dispatch(payload, (size_t)plain);",
     "            dispatch(payload, (size_t)plain);",
     "an encrypted request gets a plaintext reply"),
    ("src/protocol.c",
     "    return reply_encrypted && session_state() == SESSION_ACTIVE;",
     "    return session_state() == SESSION_ACTIVE;",
     "a plaintext frame rides someone else's session"),

    # Job 2: no transport may answer a complete request with silence.
    ("src/protocol.c", '    send_error_ex(ERR_BUSY, "device busy; resend", false);',
     "    /* mutant: dropped on the floor */",
     "a request the transport cannot queue is dropped"),
    # Not a mutant of the busy path's `false` argument to send_error_ex: that
    # call is guarded by reply_encrypted as well, so flipping it is equivalent
    # code and would survive by construction rather than for want of a test.
    # The two `reply_encrypted = false` clears are not mutated for the same
    # reason: each is redundant with a guard that already forces plaintext, and
    # a mutant that cannot change behaviour measures nothing.
    ("src/protocol.c",
     "    reply_encrypted = false;\n\n    if (len < 4) {",
     "    reply_encrypted = true;\n\n    if (len < 4) {",
     "every reply is encrypted regardless of the request"),


    # Job 3: the name bound is what keeps the radio advertising at all.
    ("src/ble-name.c", "    if (len == 0 || len > BLE_NAME_MAX_LEN) {",
     "    if (len == 0) {", "an over-long name is accepted"),
    ("src/ble-name.h", "#define BLE_NAME_MAX_LEN 29", "#define BLE_NAME_MAX_LEN 40",
     "the bound is raised past the scan response"),
    ("src/ble-name.c", "        if (c < 0x20 || c > 0x7E) {", "        if (false) {",
     "control bytes in the advertised name"),
    ("src/ble-name.c", "    if (ble_name_is_valid(stored)) {",
     "    if (stored[0] != '\\0') {", "a stored name reaches the radio unchecked"),
    ("src/ble-name.c", "    if (!ble_name_is_valid(n)) {", "    if (false) {",
     "ble_name_set stores whatever it is given"),

    # Job 4: the acknowledgement has to mark the screen dirty itself.
    ("src/ui.c", "     * within 100 ms regardless. */\n    ui_invalidate();",
     "     * within 100 ms regardless. */",
     "the Signed acknowledgement never repaints"),
]

BINARIES = ["test_protocol", "test_ble_chunk", "test_ui", "test_eth_decode"]


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
