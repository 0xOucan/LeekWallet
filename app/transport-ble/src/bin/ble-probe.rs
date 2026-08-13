//! Talk to a LeekWallet over BLE.
//!
//! The BLE counterpart to `leek-probe`: same questions, same order, other
//! radio. This is the first thing anyone will run against the new GATT
//! service, so it is blunt about what went wrong rather than tidy about it.
//!
//!     cargo run --bin leek-ble-probe [--scan SECONDS] [--mtu BYTES]

use std::time::Duration;

use leek_transport_ble::{
    BleTransport, BLE_USES_SYNC, FRAME_ENC_RESPONSE, FRAME_ERROR, FRAME_RESPONSE, FRAME_REQUEST,
    MIN_MTU, SERVICE_UUID,
};

/// Minimal CBOR for `{"method": "<name>"}` — enough to ask a question. Same
/// shortcut as the serial probe; the real client uses the codec in
/// packages/core.
fn request(method: &str) -> Vec<u8> {
    let mut out = vec![0xa1];
    for s in ["method", method] {
        let b = s.as_bytes();
        assert!(b.len() < 24, "probe only encodes short strings");
        out.push(0x60 | b.len() as u8);
        out.extend_from_slice(b);
    }
    out
}

#[tokio::main]
async fn main() {
    let mut scan = Duration::from_secs(10);
    let mut mtu: Option<u16> = None;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scan" => {
                scan = Duration::from_secs(parse(args.get(i + 1), "--scan"));
                i += 2;
            }
            "--mtu" => {
                mtu = Some(parse(args.get(i + 1), "--mtu") as u16);
                i += 2;
            }
            other => {
                eprintln!("unknown argument {other}");
                eprintln!("usage: leek-ble-probe [--scan SECONDS] [--mtu BYTES]");
                std::process::exit(2);
            }
        }
    }

    println!("==> scanning {}s for {SERVICE_UUID}", scan.as_secs());
    let mut t = match BleTransport::connect(scan).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if let Some(m) = mtu {
        t.set_mtu(m);
    }
    println!(
        "==> connected; chunking at MTU {}{}, sync marker {}",
        t.mtu(),
        if t.mtu() == MIN_MTU && mtu.is_none() {
            " (assumed floor — pass --mtu once the device reports otherwise)"
        } else {
            ""
        },
        if BLE_USES_SYNC { "on" } else { "off" }
    );

    // getMnemonic is here on purpose: it must be refused. A transport that
    // only ever exercises the happy path proves less than one that checks the
    // device still says no.
    for method in ["ping", "getFeatures", "getStatus", "getMnemonic"] {
        if let Err(e) = t.send(FRAME_REQUEST, &request(method)).await {
            eprintln!("{method:14} -> send failed: {e}");
            continue;
        }
        match t.recv(Duration::from_secs(5)).await {
            Ok((ty, payload)) => {
                let label = match ty {
                    FRAME_RESPONSE => "RESPONSE",
                    FRAME_ENC_RESPONSE => "ENCRYPTED",
                    FRAME_ERROR => "ERROR",
                    _ => "?",
                };
                println!("{method:14} -> {label:10} {}", hex(&payload));
            }
            Err(e) => println!("{method:14} -> {e}"),
        }
    }

    // Leaving the link up would keep the device's single-peer session busy
    // (PROTOCOL.md 3b) until BlueZ times it out.
    if let Err(e) = t.disconnect().await {
        eprintln!("disconnect: {e}");
    }
}

fn parse(arg: Option<&String>, flag: &str) -> u64 {
    match arg.and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => {
            eprintln!("{flag} needs a number");
            std::process::exit(2);
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
