//! USB CDC transport commands. Desktop and Android, from one source.
//!
//! Nothing here is platform-conditional except the shape of the lock and the
//! thread the work runs on: `leek-transport-serial` picks its backend at build
//! time and hands back the same `list_ports`/`open`/`send`/`recv` either way.
//! That is the same bargain `ble.rs` makes, and for the same reason — a
//! phone-specific command surface would be a second implementation of the
//! signing path, and the one that gets less use is the one that quietly rots.
//!
//! The command *names* are shared too (`ports`, `connect`, `disconnect`,
//! `request`), so the frontend's USB path is one path. Android is not a second
//! transport in the UI; it is the same transport reached differently.

use std::time::Duration;

use leek_transport_serial::{list_ports, PortInfo};
use serde::Serialize;
use tauri::State;

#[cfg(not(target_os = "android"))]
use leek_transport_serial::SerialTransport;
#[cfg(target_os = "android")]
use leek_transport_serial::UsbTransport;
#[cfg(target_os = "android")]
use tauri_plugin_serialplugin::api::SerialPort;

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
///
/// On Android this is a `tokio` mutex rather than a `std` one, because the
/// guard is held across an `.await` on the blocking pool — see `request`. The
/// desktop keeps `std`'s, which is what it has always used.
#[cfg(not(target_os = "android"))]
#[derive(Default)]
pub struct Connection(std::sync::Mutex<Option<SerialTransport>>);

#[cfg(target_os = "android")]
#[derive(Default)]
pub struct Connection(tokio::sync::Mutex<Option<UsbTransport<tauri::Wry>>>);

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn ports() -> Result<Vec<Port>, String> {
    list_ports()
        .map(|v| v.into_iter().map(Port::from).collect())
        .map_err(|e| e.to_string())
}

/// Android needs the plugin's state to enumerate through `UsbManager`, and the
/// enumeration crosses into the JVM, so it is kept off the UI thread like every
/// other call in this module.
///
/// Unlike desktop, an empty result is returned as an *error*. Nothing is
/// attached and no cable is plugged in look identical from here, and the things
/// worth checking on a phone — a charge-only cable, a phone with no USB host
/// support, a missing OTG adapter — are not the things worth checking on a
/// laptop. `TransportError::NoDevice` carries that list. An empty array would
/// arrive at the UI as the generic desktop message about the dialout group,
/// which on a phone is advice about a group that does not exist.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn ports(app: tauri::AppHandle) -> Result<Vec<Port>, String> {
    use leek_transport_serial::TransportError;

    let serial = plugin_state(&app)?;
    let found = blocking(move || list_ports(&serial)).await?.map_err(|e| e.to_string())?;
    if found.is_empty() {
        return Err(TransportError::NoDevice.to_string());
    }
    Ok(found.into_iter().map(Port::from).collect())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn connect(path: String, state: State<'_, Connection>) -> Result<(), String> {
    let transport = SerialTransport::open(&path).map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|_| "connection lock poisoned")? = Some(transport);
    Ok(())
}

/// Open the device, prompting for USB permission if this app does not hold it.
///
/// `spawn_blocking` is load-bearing, not tidiness. The plugin's Kotlin blocks
/// on the permission broadcast for up to thirty seconds while Android's dialog
/// is on screen; running that on the UI thread is an ANR, and the user would
/// watch the app freeze at the exact moment it is asking them a question.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn connect(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, Connection>,
) -> Result<(), String> {
    let serial = plugin_state(&app)?;
    let transport = blocking(move || UsbTransport::open(serial, &path))
        .await?
        .map_err(|e| e.to_string())?;
    *state.0.lock().await = Some(transport);
    Ok(())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn disconnect(state: State<'_, Connection>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "connection lock poisoned")? = None;
    Ok(())
}

/// Drop the link.
///
/// Dropping the transport closes it (see `UsbTransport::close`), which matters
/// more here than on desktop: the plugin holds the `UsbDeviceConnection` and
/// the file descriptor under it, and leaving those open makes the next connect
/// fail with a busy interface rather than reconnecting.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn disconnect(state: State<'_, Connection>) -> Result<(), String> {
    let taken = state.0.lock().await.take();
    // Off the UI thread: closing crosses into the JVM to release the fd.
    if let Some(transport) = taken {
        blocking(move || drop(transport)).await?;
    }
    Ok(())
}

/// Send one frame and wait for the reply.
///
/// Bytes cross the bridge as plain arrays rather than base64: Tauri's IPC is
/// JSON, and a binary payload smuggled through a string is a decoding bug
/// waiting to happen. Frames here are small enough that the overhead is
/// irrelevant.
#[cfg(not(target_os = "android"))]
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

/// Send one frame and wait for the reply.
///
/// Same contract as the desktop command above, on the blocking pool: `recv`
/// waits out a device that may be asking a human to press a button, and a
/// request that can take two minutes has no business on the UI thread.
///
/// The transport is taken out of the lock and put back rather than borrowed
/// across the `.await`, because `spawn_blocking` needs to own what it touches.
/// The lock is still held for the whole exchange, so the "one connection at a
/// time" rule survives.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn request(
    frame_type: u8,
    payload: Vec<u8>,
    timeout_ms: u64,
    state: State<'_, Connection>,
) -> Result<(u8, Vec<u8>), String> {
    let mut guard = state.0.lock().await;
    let mut transport = guard.take().ok_or("not connected")?;

    let (transport, result) = blocking(move || {
        let result = transport
            .send(frame_type, &payload)
            .and_then(|()| transport.recv(Duration::from_millis(timeout_ms)));
        (transport, result)
    })
    .await?;

    // Put it back even when the exchange failed. A timeout is the ordinary way
    // to learn that a device is in BLE mode (PROTOCOL.md 3b), and dropping the
    // connection on it would force a reconnect — and a second permission
    // dialog on some phones — for a failure the user is about to be told how
    // to fix.
    *guard = Some(transport);
    result.map_err(|e| e.to_string())
}

/// The plugin's own state, which is where its Android USB handle lives.
///
/// Absent only if `tauri_plugin_serialplugin::init()` was not registered in
/// `lib.rs`; treated as an error rather than a panic so a misconfigured build
/// says so instead of taking the app down.
#[cfg(target_os = "android")]
fn plugin_state(app: &tauri::AppHandle) -> Result<SerialPort<tauri::Wry>, String> {
    use tauri::Manager;
    app.try_state::<SerialPort<tauri::Wry>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "the USB serial plugin is not initialised in this build".to_string())
}

/// Run a blocking call on the pool and flatten the join failure.
///
/// A panic in there is a bug, but it must not be one that hangs the UI on a
/// promise that never settles.
#[cfg(target_os = "android")]
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("USB worker failed: {e}"))
}
