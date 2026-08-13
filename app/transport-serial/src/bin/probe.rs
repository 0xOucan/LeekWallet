//! Talk to a LeekWallet over USB.
//!
//! The Rust counterpart to scripts/probe-device.py: same protocol, but through
//! the transport the Tauri app will actually use, so this exercises the code
//! that ships rather than a parallel implementation.
//!
//!     cargo run --bin leek-probe [/dev/ttyACM0]

use std::time::Duration;

use leek_transport_serial::{list_ports, SerialTransport, FRAME_ERROR, FRAME_REQUEST};

/// Minimal CBOR for `{"method": "<name>"}` — enough to ask a question.
/// The real client uses the shared codec in packages/core.
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

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        match list_ports() {
            Ok(ports) => {
                for p in &ports {
                    println!(
                        "  {} — {}{}",
                        p.name,
                        p.description,
                        if p.likely_device { "  <- looks like a LeekWallet" } else { "" }
                    );
                }
                ports
                    .into_iter()
                    .find(|p| p.likely_device)
                    .map(|p| p.name)
                    .unwrap_or_else(|| "/dev/ttyACM0".to_string())
            }
            Err(e) => {
                eprintln!("could not list ports: {e}");
                std::process::exit(1);
            }
        }
    });

    println!("==> {path}");
    let mut t = match SerialTransport::open(&path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("open failed: {e}");
            eprintln!("on Linux you must be in the dialout group");
            std::process::exit(1);
        }
    };

    // getMnemonic is included on purpose: it must be refused. A transport that
    // only ever exercises the happy path proves less than one that checks the
    // device still says no.
    for method in ["ping", "getFeatures", "getStatus", "getMnemonic"] {
        if let Err(e) = t.send(FRAME_REQUEST, &request(method)) {
            eprintln!("{method}: send failed: {e}");
            continue;
        }
        match t.recv(Duration::from_secs(3)) {
            Ok((ty, payload)) => {
                let label = match ty {
                    FRAME_ERROR => "ERROR",
                    0x02 => "RESPONSE",
                    0x12 => "ENCRYPTED",
                    _ => "?",
                };
                println!("{method:14} -> {label:10} {}", hex(&payload));
            }
            Err(e) => println!("{method:14} -> {e}"),
        }
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
