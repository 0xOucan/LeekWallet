//! BLE GATT transport for LeekWallet.
//!
//! The same frames as USB (docs/PROTOCOL.md §2), split into chunks because
//! GATT writes cap at MTU−3. Everything above the chunking layer is identical
//! on both transports, which is the point: `leek-ble-probe` and `leek-probe`
//! ask the same questions and should get the same answers.
//!
//! The split here is deliberate. `wire` is pure and unit-tested; the backends
//! are the radio plumbing and are not testable without hardware, so they are
//! kept as small as they can be.
//!
//! There are two backends because there are two Bluetooth stacks worth using:
//! btleplug on desktop (`transport`), `tauri-plugin-blec` on Android
//! (`android`) — see the module header there for why. Exactly one is compiled;
//! both expose the same `BleTransport`, so nothing above this crate knows
//! which it is talking to.

pub mod ids;
pub mod wire;

#[cfg(feature = "ble")]
pub mod transport;

#[cfg(feature = "blec")]
pub mod android;

#[cfg(any(feature = "ble", feature = "blec"))]
pub mod error;

// Both would define `BleTransport`, and silently picking one would mean a
// build that quietly used the wrong Bluetooth stack. Better to refuse.
#[cfg(all(feature = "ble", feature = "blec"))]
compile_error!(
    "features `ble` (btleplug, desktop) and `blec` (tauri-plugin-blec, Android) \
     are alternative backends for the same transport; enable exactly one"
);

#[cfg(any(feature = "ble", feature = "blec"))]
pub use error::{BleDevice, BleError};
#[cfg(any(feature = "ble", feature = "blec"))]
pub use ids::{CHAR_NOTIFY_UUID, CHAR_WRITE_UUID, SERVICE_UUID};

#[cfg(feature = "ble")]
pub use transport::BleTransport;

#[cfg(feature = "blec")]
pub use android::BleTransport;

pub use wire::{
    chunk_for_ble, encode_frame, ChunkReassembler, FrameDecoder, WireError, BLE_USES_SYNC,
    FRAME_ENC_REQUEST, FRAME_ENC_RESPONSE, FRAME_ERROR, FRAME_EVENT, FRAME_REQUEST,
    FRAME_RESPONSE, MAX_FRAME, MIN_MTU,
};
