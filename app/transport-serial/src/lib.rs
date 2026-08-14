//! USB CDC transport for LeekWallet.
//!
//! The device shares this port with its console logs, so framing has to be
//! findable in a stream that also carries text. Every frame is preceded by a
//! two-byte sync marker, and a reader that loses sync scans forward to the next
//! one rather than misparsing. See `src/protocol.c` and docs/PROTOCOL.md.
//!
//! ```text
//! ┌──────┬──────┬────────┬─────────────┐
//! │ 'L'  │ 'K'  │ len:u16│ type + CBOR │
//! └──────┴──────┴────────┴─────────────┘
//! ```
//!
//! The split here follows `leek-transport-ble`: `wire` is pure and unit-tested,
//! and the backends are the platform plumbing, kept as small as they can be
//! because they cannot be tested without hardware.
//!
//! There are two backends because there are two ways to reach a CDC-ACM device
//! worth having. On desktop the OS presents one as a character device and the
//! `serialport` crate opens it (`transport`). On Android nothing may open
//! `/dev/ttyACM*` unrooted; the device is reached through the Java USB Host
//! API, behind a permission the user grants per device, and
//! `tauri-plugin-serialplugin` carries that Kotlin into the APK (`android`).
//! Exactly one is compiled; both expose the same `PortInfo`, the same
//! `TransportError` and the same `send`/`recv`, so nothing above this crate
//! knows which it is talking to.

pub mod error;
pub mod wire;

#[cfg(feature = "serialport")]
pub mod transport;

#[cfg(feature = "android")]
pub mod android;

// Both define `list_ports`, and silently picking one would mean a build that
// quietly used the wrong way of reaching the device. Better to refuse.
#[cfg(all(feature = "serialport", feature = "android"))]
compile_error!(
    "features `serialport` (desktop) and `android` (tauri-plugin-serialplugin) \
     are alternative backends for the same transport; enable exactly one"
);

pub use error::TransportError;
pub use wire::{
    encode_frame, FrameDecoder, WireError, FRAME_ENC_REQUEST, FRAME_ENC_RESPONSE, FRAME_ERROR,
    FRAME_REQUEST, FRAME_RESPONSE, MAX_FRAME, SYNC,
};

#[cfg(feature = "serialport")]
pub use transport::{list_ports, SerialTransport};

#[cfg(feature = "android")]
pub use android::{list_ports, UsbTransport};

/// Espressif's vendor ID. Used to rank ports, never to trust one: a matching
/// VID says something about the cable, not about what is on the other end.
///
/// Shared by both backends, and the reason it is public: on Android the same
/// number goes into the enumeration filter, and two copies of it would be one
/// copy too many.
pub const ESPRESSIF_VID: u16 = 0x303A;

/// One attached device, as far as a chooser needs to know it.
///
/// `name` is the platform's own handle for the port — a `/dev/tty*` path on
/// desktop, a `UsbDevice.deviceName` on Android — and is what `open` takes. It
/// is not a stable identity across replugs on either platform, which is why
/// nothing but the immediately following `open` may hold onto it.
#[derive(Debug, Clone)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
    /// True when the USB VID matches an Espressif device.
    pub likely_device: bool,
}
