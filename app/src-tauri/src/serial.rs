//! USB CDC transport commands. Desktop only — see `lib.rs`.

use std::sync::Mutex;
use std::time::Duration;

use leek_transport_serial::{list_ports, PortInfo, SerialTransport};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Port {
    name: String,
    description: String,
    likely_device: bool,
}

impl From<PortInfo> for Port {
    fn from(p: PortInfo) -> Self {
        Port { name: p.name, description: p.description, likely_device: p.likely_device }
    }
}

/// One connection at a time. A hardware wallet is a single physical object and
/// two frontends talking to it concurrently would interleave frames on a stream
/// that has no request IDs.
#[derive(Default)]
pub struct Connection(Mutex<Option<SerialTransport>>);

#[tauri::command]
pub fn ports() -> Result<Vec<Port>, String> {
    list_ports()
        .map(|v| v.into_iter().map(Port::from).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn connect(path: String, state: State<'_, Connection>) -> Result<(), String> {
    let transport = SerialTransport::open(&path).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "connection lock poisoned")? = Some(transport);
    Ok(())
}

#[tauri::command]
pub fn disconnect(state: State<'_, Connection>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "connection lock poisoned")? = None;
    Ok(())
}

/// Send one frame and wait for the reply.
///
/// Bytes cross the bridge as plain arrays rather than base64: Tauri's IPC is
/// JSON, and a binary payload smuggled through a string is a decoding bug
/// waiting to happen. Frames here are small enough that the overhead is
/// irrelevant.
#[tauri::command]
pub fn request(
    frame_type: u8,
    payload: Vec<u8>,
    timeout_ms: u64,
    state: State<'_, Connection>,
) -> Result<(u8, Vec<u8>), String> {
    let mut guard = state.0.lock().map_err(|_| "connection lock poisoned")?;
    let transport = guard.as_mut().ok_or("not connected")?;

    transport.send(frame_type, &payload).map_err(|e| e.to_string())?;
    transport
        .recv(Duration::from_millis(timeout_ms))
        .map_err(|e| e.to_string())
}
