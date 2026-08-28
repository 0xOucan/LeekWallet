//! BLE GATT transport commands. Desktop and Android, from one source.
//!
//! Nothing here is platform-conditional: `leek-transport-ble` picks its radio
//! backend at build time and hands back the same `BleTransport` either way.
//! That is on purpose — a phone-specific command surface would be a second
//! implementation of the signing path, and the one that gets less use is the
//! one that quietly rots.
//!
//! A deliberate mirror of `serial.rs`: same four commands, same shapes, same
//! request/response model. The frontend's two transports differ only in which
//! command names they invoke, which is what lets the client above them stay
//! transport-blind.
//!
//! The one structural difference is `tokio::sync::Mutex` rather than `std`'s.
//! btleplug is async all the way down, so the guard is held across `.await`,
//! and a `std` guard held across an await point is not `Send`.

use std::time::Duration;

use leek_transport_ble::{BleDevice, BleTransport};
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

/// How long a scan looks before giving up.
///
/// Long enough for a device that is advertising to be seen, short enough that
/// a user who forgot to switch the device off USB is told so rather than left
/// watching a spinner. `scan()` always waits the whole window; `connect_id()`
/// returns as soon as it matches.
const SCAN_MS: u64 = 4000;

#[derive(Serialize)]
pub struct Device {
    id: String,
    /// Advertised name, if any. Decoration — the service UUID is what actually
    /// identified this peer, and the name is host-supplied and user-settable.
    name: Option<String>,
}

impl From<BleDevice> for Device {
    fn from(d: BleDevice) -> Self {
        Device { id: d.id, name: d.name }
    }
}

/// One connection at a time, for the same reason as serial: the device is a
/// single physical object and the frame stream has no request IDs.
#[derive(Default)]
pub struct Connection(Mutex<Option<BleTransport>>);

#[tauri::command]
pub async fn ble_scan() -> Result<Vec<Device>, String> {
    BleTransport::scan(Duration::from_millis(SCAN_MS))
        .await
        .map(|v| v.into_iter().map(Device::from).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ble_connect(id: String, state: State<'_, Connection>) -> Result<(), String> {
    // Tear the previous link down FIRST. Assigning over it would only drop the
    // transport, and neither backend implements `Drop`, so the CCCD would stay
    // written and `disconnect()` would never run — which is the bug already
    // fixed inside `BleTransport::disconnect`, reachable again by the implicit
    // path. BlueZ then still believes the client is subscribed, the next
    // subscribe is a no-op, and the device answers correctly into a dead
    // channel. Reachable in normal use: a drop the frontend never noticed,
    // followed by the user pressing Connect again.
    //
    // The old link's failure is not this call's failure. It is gone either way,
    // and refusing a new connection because a corpse would not close cleanly is
    // the wrong trade.
    if let Some(mut old) = state.0.lock().await.take() {
        let _ = old.disconnect().await;
    }

    let transport = BleTransport::connect_id(&id, Duration::from_millis(SCAN_MS))
        .await
        .map_err(|e| e.to_string())?;
    *state.0.lock().await = Some(transport);
    Ok(())
}

/// Drop the link.
///
/// Explicitly disconnecting rather than just dropping the transport: the
/// device serves one peer at a time (PROTOCOL.md 3b), so a link left for the
/// stack to time out keeps the next connection out for as long as that takes.
#[tauri::command]
pub async fn ble_disconnect(state: State<'_, Connection>) -> Result<(), String> {
    let taken = state.0.lock().await.take();
    if let Some(mut transport) = taken {
        transport.disconnect().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Send one frame and wait for the reply.
///
/// Bytes cross the bridge as plain arrays, matching `serial::request` — see
/// the note there.
#[tauri::command]
pub async fn ble_request(
    frame_type: u8,
    payload: Vec<u8>,
    timeout_ms: u64,
    state: State<'_, Connection>,
) -> Result<(u8, Vec<u8>), String> {
    let mut guard = state.0.lock().await;
    let transport = guard.as_mut().ok_or("not connected")?;

    transport.send(frame_type, &payload).await.map_err(|e| e.to_string())?;
    transport
        .recv(Duration::from_millis(timeout_ms))
        .await
        .map_err(|e| e.to_string())
}
