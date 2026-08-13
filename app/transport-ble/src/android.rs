//! The radio half on Android, on top of `tauri-plugin-blec`.
//!
//! Why not btleplug directly, as on desktop: btleplug's Android backend is a
//! thin JNI shim over a Java driver (`com.nonpolynomial.*` plus vendored
//! `io.github.gedgygedgy.*` jni-utils classes) that has to be compiled into
//! the APK. Tauri generates `gen/android/` from `tauri.conf.json` and this repo
//! does not track it, so anywhere we put that Java by hand would be erased by
//! the next `tauri android init`.
//!
//! `tauri-plugin-blec` solves exactly that problem the way Tauri intends it to
//! be solved: it is a Tauri mobile plugin, so it ships its own Kotlin Android
//! library inside the crate and declares it with
//! `tauri_plugin::Builder::new(..).android_path("android")`. Tauri's build
//! machinery pulls that library into the generated Gradle project every time
//! the project is generated, and merges the plugin's `AndroidManifest.xml` —
//! including the Bluetooth permissions — into the app's. Nothing is
//! hand-edited, so nothing is lost on regeneration. On Android the plugin
//! replaces btleplug's platform layer with its own Kotlin implementation of
//! btleplug's `Central`/`Peripheral` traits; on desktop it would just re-wrap
//! btleplug, which is why desktop keeps talking to btleplug itself and this
//! module is compiled only for the phone.
//!
//! The public shape is a deliberate copy of `transport.rs`: same constructors,
//! same `send`/`recv`/`disconnect`, same errors. `ble.rs` in the Tauri backend
//! and every layer above it is therefore identical on both platforms, which is
//! the only way "it works over BLE on the desktop" says anything at all about
//! the phone.

use std::time::Duration;

use tauri_plugin_blec::models::{ScanFilter, WriteType};
use tauri_plugin_blec::{get_handler, OnDisconnectHandler};
use tokio::sync::mpsc;

use crate::error::{BleDevice, BleError};
use crate::ids::{CHAR_NOTIFY_UUID, CHAR_WRITE_UUID, SERVICE_UUID};
use crate::wire::{chunk_for_ble, encode_frame, ChunkReassembler, FrameDecoder, MIN_MTU};

/// How many notification chunks may queue up before the radio task blocks.
///
/// A frame is at most `MAX_FRAME` bytes and chunks are MTU-sized, so a few
/// dozen covers any single reply with room to spare. Bounded rather than
/// unbounded on purpose: an unbounded queue turns a device that will not stop
/// notifying into an out-of-memory kill instead of a visible stall.
const NOTIFY_QUEUE: usize = 64;

/// MTU to ask the peer for on connect.
///
/// Android is the one platform where the MTU is ours to request. 247 is the
/// largest that still fits a single LL data PDU under Data Length Extension,
/// so it is the point past which a bigger number buys nothing. Whatever the
/// peer actually grants is read back afterwards — this is a request, and the
/// chunker is driven by the answer, never by this.
#[cfg(target_os = "android")]
const REQUEST_MTU: u16 = 247;

pub struct BleTransport {
    /// Notification payloads, exactly as the peer sent them, in order.
    ///
    /// A channel rather than a stream because blec delivers notifications to a
    /// callback it owns. Subscribing before any request is sent — as `attach`
    /// does — means a reply that comes back faster than we can call `recv`
    /// lands in here rather than being dropped on the floor.
    notifications: mpsc::Receiver<Vec<u8>>,
    reassembler: ChunkReassembler,
    decoder: FrameDecoder,
    mtu: u16,
    write_type: WriteType,
}

impl BleTransport {
    /// Scan for the service, connect to the first match.
    pub async fn connect(scan_time: Duration) -> Result<Self, BleError> {
        let found = Self::scan(scan_time).await?;
        let device = found
            .into_iter()
            .next()
            .ok_or(BleError::NotFound { scanned_for: scan_time })?;
        Self::attach(&device.id).await
    }

    /// Connect to one specific peer by the id `scan` reported.
    ///
    /// Separate from `connect` for the same reason as on desktop: a chooser
    /// that lists devices and then connects to "the first match" would connect
    /// to a different device than the one the user picked whenever two are in
    /// range. Rare with a single wallet on the desk, and exactly the kind of
    /// rare that signs the wrong transaction.
    pub async fn connect_id(id: &str, scan_time: Duration) -> Result<Self, BleError> {
        // Scan first even though blec's `connect` would do it implicitly: its
        // implicit scan is unfiltered and one second long, and we want the
        // permission and adapter-state diagnostics below rather than a bare
        // "connection failed" three retries later.
        let found = Self::scan(scan_time).await?;
        if !found.iter().any(|d| d.id == id) {
            return Err(BleError::NotFound { scanned_for: scan_time });
        }
        Self::attach(id).await
    }

    /// List everything advertising the service, without connecting to any of it.
    ///
    /// Always waits out the full window, matching desktop: a chooser that
    /// stopped at the first hit would hide the second device rather than let
    /// the user pick between them.
    pub async fn scan(scan_time: Duration) -> Result<Vec<BleDevice>, BleError> {
        preflight().await?;
        let handler = get_handler()?;

        let (tx, mut rx) = mpsc::channel(1);
        handler
            .discover(
                Some(tx),
                scan_time.as_millis() as u64,
                // Filtering by service UUID rather than by name: a name is
                // host-supplied decoration (T56 makes it user-settable), while
                // the service UUID is what actually identifies the protocol.
                ScanFilter::Service(SERVICE_UUID),
                // No iBeacon support wanted, and saying so keeps ACCESS_FINE_LOCATION
                // out of the permissions the plugin asks for. A wallet has no
                // business holding a location permission it never reads.
                false,
            )
            .await?;

        // `discover` returns immediately and streams batches until its own
        // timeout, so drain until the sender is dropped. The extra second is
        // slack for the task's final send, not a second scan window.
        let mut out: Vec<BleDevice> = Vec::new();
        let deadline = tokio::time::Instant::now() + scan_time + Duration::from_secs(1);
        while let Ok(Some(batch)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            for d in batch {
                if out.iter().any(|seen| seen.id == d.address) {
                    continue;
                }
                out.push(BleDevice {
                    id: d.address,
                    // blec reports an empty string for an unnamed peer; the
                    // rest of the app distinguishes "no name" from "named the
                    // empty string" and shows the id instead.
                    name: if d.name.is_empty() { None } else { Some(d.name) },
                });
            }
        }
        let _ = handler.stop_scan().await;
        Ok(out)
    }

    async fn attach(address: &str) -> Result<Self, BleError> {
        preflight().await?;
        let handler = get_handler()?;

        // Ask before connecting: the MTU is negotiated once, during connection
        // setup, and cannot be raised afterwards.
        //
        // Gated because blec only exposes this on Android — every other
        // platform negotiates the maximum unprompted. The gate is what lets
        // `cargo check --features blec` run on the host, so a mistake in this
        // module is caught in seconds instead of only by the NDK cross-build.
        #[cfg(target_os = "android")]
        tauri_plugin_blec::Handler::set_android_mtu_request(REQUEST_MTU);

        handler
            .connect(address, OnDisconnectHandler::None, false)
            .await?;

        // Verify the peer is what it advertised before trusting it with a
        // frame. blec resolves a characteristic UUID lazily at write time, so
        // without this an unrelated device would fail with "characteristic not
        // available" halfway through a signing request instead of at connect.
        let services = handler.discover_services(address).await?;
        let ours = services
            .iter()
            .find(|s| s.uuid == SERVICE_UUID)
            .ok_or(BleError::MissingCharacteristic(SERVICE_UUID))?;
        let find = |u| {
            ours.characteristics
                .iter()
                .find(|c| c.uuid == u)
                .ok_or(BleError::MissingCharacteristic(u))
        };
        let write_char = find(CHAR_WRITE_UUID)?;
        let notify_char = find(CHAR_NOTIFY_UUID)?;

        if !notify_char
            .properties
            .contains(tauri_plugin_blec::models::CharProps::Notify)
        {
            return Err(BleError::NotNotifiable(CHAR_NOTIFY_UUID));
        }
        // Writing without a response is roughly twice as fast, but only legal
        // if the characteristic advertises it.
        let write_type = if write_char
            .properties
            .contains(tauri_plugin_blec::models::CharProps::WriteWithoutResponse)
        {
            WriteType::WithoutResponse
        } else {
            WriteType::WithResponse
        };

        let (tx, notifications) = mpsc::channel(NOTIFY_QUEUE);
        // Subscribe before anything is sent, so a reply that comes back fast
        // cannot arrive before we are listening for it.
        handler
            .subscribe(CHAR_NOTIFY_UUID, Some(SERVICE_UUID), move |data: Vec<u8>| {
                // Dropping is the honest failure here: the callback is
                // synchronous and blocking it would stall blec's notification
                // dispatch for every characteristic. A dropped chunk shows up
                // as a `recv` timeout, which is a failure the caller already
                // handles, rather than a deadlock, which is not.
                let _ = tx.try_send(data);
            })
            .await?;

        // Unlike desktop, Android can actually tell us what was negotiated,
        // so the chunker runs at the real MTU instead of assuming the floor.
        // Clamped upward only: a peer reporting something below the spec
        // minimum is reporting nonsense, and chunking below 23 bytes would
        // make every frame a storm of packets.
        let mtu = handler.mtu().await.unwrap_or(MIN_MTU).max(MIN_MTU);

        Ok(Self {
            notifications,
            reassembler: ChunkReassembler::new(),
            decoder: FrameDecoder::new(),
            mtu,
            write_type,
        })
    }

    /// Override the assumed MTU. Larger than the link's real MTU means
    /// truncated writes, so only call this with a number the device confirmed.
    pub fn set_mtu(&mut self, mtu: u16) {
        self.mtu = mtu;
    }

    pub fn mtu(&self) -> u16 {
        self.mtu
    }

    pub async fn send(&mut self, frame_type: u8, payload: &[u8]) -> Result<(), BleError> {
        let handler = get_handler()?;
        let frame = encode_frame(frame_type, payload)?;
        for chunk in chunk_for_ble(&frame, self.mtu)? {
            handler
                .send_data(CHAR_WRITE_UUID, Some(SERVICE_UUID), &chunk, self.write_type)
                .await?;
        }
        Ok(())
    }

    /// Wait for one complete frame.
    pub async fn recv(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>), BleError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let chunk = match tokio::time::timeout_at(deadline, self.notifications.recv()).await {
                Err(_) => return Err(BleError::Timeout),
                // The channel closing means the subscription went away, which
                // in practice means the peer did.
                Ok(None) => return Err(BleError::Timeout),
                Ok(Some(c)) => c,
            };

            let Some(reassembled) = self.reassembler.push(&chunk)? else {
                continue;
            };
            if let Some(frame) = self.decoder.push(&reassembled)?.into_iter().next() {
                return Ok(frame);
            }
        }
    }

    /// Drop the link.
    ///
    /// `&mut self` for symmetry with the desktop backend, whose notification
    /// stream forces it; callers are written against one signature.
    pub async fn disconnect(&mut self) -> Result<(), BleError> {
        let handler = get_handler()?;
        let _ = handler.unsubscribe(CHAR_NOTIFY_UUID).await;
        handler.disconnect().await?;
        Ok(())
    }
}

/// Everything that must be true before a scan or a connect can possibly work,
/// checked in the order that produces the most useful complaint.
///
/// Both failures here look identical from the UI otherwise — an empty device
/// list — and both have nothing to do with the wallet, so leaving them
/// undiagnosed sends the user to check a device that is working fine.
async fn preflight() -> Result<(), BleError> {
    // `true` lets the plugin re-ask after a previous denial: on Android a
    // second `requestPermissions` for a twice-denied permission is silently
    // ignored, so the plugin opens the app's settings page instead. Either way
    // this returns false the first time and the user has to act, which is why
    // the error text below has to say what to act on.
    if !tauri_plugin_blec::check_permissions(true)? {
        return Err(BleError::PermissionDenied);
    }
    match get_handler()?.get_adapter_state().await {
        tauri_plugin_blec::models::AdapterState::Off => Err(BleError::AdapterOff),
        // `Unknown` is not treated as a failure: it is what the plugin reports
        // before the adapter has been touched, and failing there would make the
        // first scan of every session fail.
        _ => Ok(()),
    }
}
