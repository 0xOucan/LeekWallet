//! The Android half, on top of `tauri-plugin-serialplugin`.
//!
//! Why not the `serialport` crate, as on desktop: an unrooted Android app
//! cannot open `/dev/ttyACM*` at all. The node is owned by `root:root` and
//! there is no group to join. The only way to a CDC-ACM device is the Java USB
//! Host API — `UsbManager` enumerates it, the user grants an explicit
//! per-device permission through a system dialog, and only then does
//! `openDevice` hand back a file descriptor that bulk transfers can run on.
//! None of that is reachable from `serialport`, and the JVM half of it has to
//! be compiled into the APK.
//!
//! That is the same shape of problem T30 hit with btleplug, and it has the same
//! answer. `tauri-plugin-serialplugin` (Apache-2.0 OR MIT) is a Tauri mobile
//! plugin: it sets `links = "tauri-plugin-serialplugin"` and its build script
//! calls `tauri_plugin::Builder::new(..).android_path("android")`, so
//! `tauri-build` pulls its Kotlin library into the generated Gradle project
//! every time that project is generated. Nothing under `gen/` is hand-edited
//! and nothing is lost when it is regenerated — exactly the property that made
//! `tauri-plugin-blec` the right answer for the radio.
//!
//! We use it as a *library*, not as a JS API: its own `invoke` commands are
//! never exposed to the webview (see `capabilities/default.json` — no entry was
//! added), and the only things called are the plain Rust methods on its
//! `SerialPort` state. The frames, the sync marker and the resync are ours, out
//! of `wire.rs`, and are byte-for-byte the code the desktop backend runs.
//!
//! The public shape is a deliberate copy of `transport.rs`: `list_ports`,
//! `open`, `send`, `recv`, same `PortInfo`, same `TransportError`. Everything
//! above this crate is therefore one implementation for both platforms, which
//! is the only way "it works over USB on the desktop" says anything at all
//! about the phone.

use std::time::{Duration, Instant};

use tauri::Runtime;
use tauri_plugin_serialplugin::api::SerialPort;

use crate::error::TransportError;
use crate::wire::{encode_frame, FrameDecoder};
use crate::{PortInfo, ESPRESSIF_VID};

/// Baud rate. Meaningless on a native-USB CDC device — the ESP32-S3's
/// USB-Serial-JTAG ignores the line coding entirely — but the plugin's `open`
/// requires one, and matching the desktop number keeps the two calls readable
/// side by side.
const BAUD: u32 = 115_200;

/// How long a single read may block before we look at our own deadline again.
///
/// The plugin's read fills up to `READ_CHUNK` bytes or returns what it has when
/// this expires, so it doubles as the latency floor on a short reply. 100 ms is
/// the timeout the desktop port has used since the beginning.
const READ_SLICE_MS: u64 = 100;

/// Bytes asked for per read. Matches the desktop backend's stack buffer.
const READ_CHUNK: usize = 256;

/// What the plugin says when a read produced nothing at all.
///
/// Matched as a string because the plugin flattens every read failure into
/// `Error::String`, so there is no variant to match on. An empty read is the
/// normal state of a device that is idle — or that is in BLE mode and
/// deliberately not answering — and must not be mistaken for the link dying,
/// which is why it is separated out rather than every read error being
/// swallowed. If a future plugin version reworks this text the effect is a read
/// loop that reports a broken link instead of a timeout: worse wording, not a
/// wrong answer.
const NO_DATA: &str = "no data received";

/// Everything attached that looks like a serial device.
///
/// Enumeration needs no permission — `UsbManager.getDeviceList()` is free, and
/// only *opening* prompts. That is what makes it honest to list a device the
/// app has not been allowed to touch yet: the user is shown what is plugged in,
/// and the permission dialog arrives when they pick one.
pub fn list_ports<R: Runtime>(serial: &SerialPort<R>) -> Result<Vec<PortInfo>, TransportError> {
    // `true` collapses a multi-interface device to one entry. The ESP32-S3
    // exposes a single CDC-ACM function, but a composite device would otherwise
    // appear two or three times in a chooser as if several wallets were
    // attached.
    let found = serial
        .available_ports(true)
        .map_err(|e| TransportError::Serial(e.to_string()))?;

    let mut out = Vec::new();
    for (path, meta) in found {
        let vid = meta.get("vid").and_then(|v| parse_hex(v));
        // Product and manufacturer strings come back empty when the app has no
        // permission for the device yet — Android refuses them until then — so
        // fall back to the numbers rather than showing a blank row.
        let product = meta.get("product").filter(|p| !p.is_empty()).cloned();
        let description = product.unwrap_or_else(|| match (vid, meta.get("pid")) {
            (Some(v), Some(p)) => format!("{v:04x}:{}", p.trim_start_matches("0x")),
            _ => "USB serial device".to_string(),
        });
        out.push(PortInfo { name: path, description, likely_device: vid == Some(ESPRESSIF_VID) });
    }
    // Likely devices first, so a UI can default sensibly without guessing.
    // Then by name, because the plugin hands back a HashMap and an order that
    // changes between two calls would move the entries under the user's finger.
    out.sort_by(|a, b| {
        b.likely_device
            .cmp(&a.likely_device)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

/// `"0x303A"` → `0x303a`. The plugin formats VID and PID as hex strings.
fn parse_hex(s: &str) -> Option<u16> {
    u16::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16).ok()
}

pub struct UsbTransport<R: Runtime> {
    serial: SerialPort<R>,
    path: String,
    decoder: FrameDecoder,
}

impl<R: Runtime> UsbTransport<R> {
    /// Open the device, prompting for USB permission if it has not been granted.
    ///
    /// **This blocks for as long as the user takes to answer the dialog** — the
    /// plugin's Kotlin waits up to 30 seconds on the permission broadcast — so
    /// it must never be called on the UI thread. The Tauri command that calls
    /// it does so inside `spawn_blocking` for exactly that reason; on the main
    /// thread this is an ANR.
    ///
    /// Blocking is also the *better* flow, and worth the care it costs. BLE's
    /// permission check returns false immediately and the user has to tap scan
    /// a second time after granting; here the grant lands inside the same
    /// attempt, so one tap on Connect is one connection.
    pub fn open(serial: SerialPort<R>, path: &str) -> Result<Self, TransportError> {
        let description = describe(&serial, path);

        serial
            .open(
                path.to_string(),
                BAUD,
                // Defaults: 8N1, no flow control. The device sets no line
                // coding of its own and native USB CDC has no wire to set it
                // on, but the plugin needs values to hand its driver.
                None,
                None,
                None,
                None,
                Some(READ_SLICE_MS),
            )
            .map_err(|e| classify_open(e, description))?;

        /* Drop whatever the device had queued before this app arrived.
         *
         * The desktop backend sleeps 250 ms first, because the ESP32-S3's
         * USB-Serial-JTAG releases its buffered TX shortly AFTER the host
         * opens the port; clearing immediately clears nothing and the stale
         * bytes land on the first read. Nothing about that is host-specific,
         * so the same wait applies here. Without it the first reply the app
         * sees may be an answer to a request from a previous session — and
         * the protocol has no request IDs to catch that with. */
        std::thread::sleep(Duration::from_millis(250));
        let _ = serial.clear_buffer(
            path.to_string(),
            tauri_plugin_serialplugin::state::ClearBuffer::Input,
        );

        Ok(Self { serial, path: path.to_string(), decoder: FrameDecoder::new() })
    }

    pub fn send(&mut self, frame_type: u8, payload: &[u8]) -> Result<(), TransportError> {
        let out = encode_frame(frame_type, payload)?;

        // Same reasoning as the desktop backend: with no request IDs, a reply
        // left over from an earlier exchange is indistinguishable from an
        // answer to this one. Drop both the driver's buffer and ours.
        let _ = self.serial.clear_buffer(
            self.path.clone(),
            tauri_plugin_serialplugin::state::ClearBuffer::Input,
        );
        self.decoder.reset();

        self.serial
            .write_binary(self.path.clone(), out)
            .map_err(|e| TransportError::Serial(e.to_string()))?;
        Ok(())
    }

    /// Read one frame, discarding any console text that precedes it.
    pub fn recv(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>), TransportError> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(frame) = self.decoder.next_frame()? {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }

            match self.serial.read_binary(
                self.path.clone(),
                Some(READ_SLICE_MS),
                Some(READ_CHUNK),
            ) {
                Ok(bytes) => self.decoder.feed(&bytes),
                // An idle device is not a broken one. Loop until *our* deadline
                // decides, so a silent link times out with the message that
                // explains silence rather than with a driver-level read error.
                Err(e) if e.to_string().contains(NO_DATA) => {}
                Err(e) => return Err(TransportError::Serial(e.to_string())),
            }
        }
    }

    /// Release the device.
    ///
    /// Worth doing explicitly rather than on drop: the plugin holds a
    /// `UsbDeviceConnection` and the file descriptor under it, and a phone that
    /// keeps them across a reconnect gets "interface is busy" instead of a
    /// link. The USB permission itself is unaffected — it is granted to the app
    /// for the device, not to the open handle, so closing does not mean asking
    /// the user again.
    pub fn close(&mut self) {
        let _ = self.serial.close(self.path.clone());
    }
}

impl<R: Runtime> Drop for UsbTransport<R> {
    fn drop(&mut self) {
        self.close();
    }
}

/// Best-effort human name for a device we may not have permission to read.
fn describe<R: Runtime>(serial: &SerialPort<R>, path: &str) -> String {
    list_ports(serial)
        .ok()
        .and_then(|ports| ports.into_iter().find(|p| p.name == path))
        .map(|p| p.description)
        .unwrap_or_else(|| path.to_string())
}

/// Turn the plugin's flattened error string back into something a user can act
/// on.
///
/// The plugin has one error variant for everything, so the distinction between
/// "you said no to the dialog" and "this is not a wallet" only survives in the
/// text. Losing it would leave both looking like a dead cable — the precise
/// mistake `BleError::PermissionDenied` exists to avoid, where a denied
/// permission produced an empty scan and sent people to check hardware that was
/// working perfectly.
fn classify_open(e: impl std::fmt::Display, product: String) -> TransportError {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if lower.contains("permission") {
        TransportError::PermissionDenied { product }
    } else if lower.contains("no driver") || lower.contains("unsupported") {
        TransportError::NotCdcAcm { product }
    } else {
        TransportError::Serial(text)
    }
}
