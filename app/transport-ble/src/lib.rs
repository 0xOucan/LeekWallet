//! BLE GATT transport for LeekWallet.
//!
//! The same frames as USB (docs/PROTOCOL.md §2), split into chunks because
//! GATT writes cap at MTU−3. Everything above the chunking layer is identical
//! on both transports, which is the point: `leek-ble-probe` and `leek-probe`
//! ask the same questions and should get the same answers.
//!
//! The split here is deliberate. `wire` is pure and unit-tested; `transport`
//! is the btleplug plumbing and is not testable without hardware, so it is
//! kept as small as it can be.

pub mod wire;

#[cfg(feature = "ble")]
pub mod transport;

#[cfg(feature = "ble")]
pub use transport::{
    BleDevice, BleError, BleTransport, CHAR_NOTIFY_UUID, CHAR_WRITE_UUID, SERVICE_UUID,
};
pub use wire::{
    chunk_for_ble, encode_frame, ChunkReassembler, FrameDecoder, WireError, BLE_USES_SYNC,
    FRAME_ENC_REQUEST, FRAME_ENC_RESPONSE, FRAME_ERROR, FRAME_EVENT, FRAME_REQUEST,
    FRAME_RESPONSE, MAX_FRAME, MIN_MTU,
};
