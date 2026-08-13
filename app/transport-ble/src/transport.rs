//! The radio half: scan, connect, subscribe, exchange frames.
//!
//! Everything here needs an adapter, so it is deliberately thin — it moves
//! bytes between btleplug and `wire`, and holds no protocol knowledge of its
//! own. The logic worth trusting lives in `wire`, where it can be tested.

use std::pin::Pin;
use std::time::Duration;

use btleplug::api::{
    Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, ValueNotification,
    WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::{Stream, StreamExt};
use uuid::{uuid, Uuid};

use crate::wire::{
    chunk_for_ble, encode_frame, ChunkReassembler, FrameDecoder, WireError, MIN_MTU,
};

/// The interface the firmware is being built to. Fixed; not configurable.
pub const SERVICE_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000001");
/// host → device
pub const CHAR_WRITE_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000002");
/// device → host
pub const CHAR_NOTIFY_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000003");

#[derive(Debug)]
pub enum BleError {
    Ble(btleplug::Error),
    Wire(WireError),
    /// Nothing advertising our service turned up. Carries what we looked for
    /// and for how long, because "no device found" on its own has never once
    /// helped anyone.
    NotFound { scanned_for: Duration },
    NoAdapter,
    /// Connected, but the peer is not the thing we are looking for.
    MissingCharacteristic(Uuid),
    NotNotifiable(Uuid),
    Timeout,
}

impl std::fmt::Display for BleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BleError::Ble(e) => write!(f, "bluetooth: {e}"),
            BleError::Wire(e) => write!(f, "{e}"),
            BleError::NotFound { scanned_for } => write!(
                f,
                "no device found.\n\
                 scanned {}s for advertisements of service {SERVICE_UUID}\n\
                 check: the device is powered on, BLE (not USB) is the selected\n\
                 transport — see PROTOCOL.md 3b, it advertises on only one — and\n\
                 that `bluetoothctl scan on` sees it at all",
                scanned_for.as_secs()
            ),
            BleError::NoAdapter => write!(
                f,
                "no Bluetooth adapter. `hciconfig` should list hci0 as UP RUNNING"
            ),
            BleError::MissingCharacteristic(u) => write!(
                f,
                "connected, but the peer has no characteristic {u} — wrong device, \
                 or firmware older than the fixed UUIDs"
            ),
            BleError::NotNotifiable(u) => {
                write!(f, "characteristic {u} does not support notify")
            }
            BleError::Timeout => write!(f, "timed out waiting for the device to answer"),
        }
    }
}

impl std::error::Error for BleError {}

impl From<btleplug::Error> for BleError {
    fn from(e: btleplug::Error) -> Self {
        BleError::Ble(e)
    }
}
impl From<WireError> for BleError {
    fn from(e: WireError) -> Self {
        BleError::Wire(e)
    }
}

/// One advertising peer, as far as a chooser needs to know it.
///
/// `id` is the platform's own handle (a MAC on BlueZ/Android, a UUID on
/// CoreBluetooth) and is what `connect_id` matches on. `name` is decoration
/// only — it is host-supplied, user-settable under T56, and must never be the
/// thing an identity decision rests on.
#[derive(Debug, Clone)]
pub struct BleDevice {
    pub id: String,
    pub name: Option<String>,
}

pub struct BleTransport {
    peripheral: Peripheral,
    write_char: Characteristic,
    notifications: Pin<Box<dyn Stream<Item = ValueNotification> + Send>>,
    reassembler: ChunkReassembler,
    decoder: FrameDecoder,
    mtu: u16,
    /// Writing without a response is roughly twice as fast, but only legal if
    /// the characteristic advertises it.
    write_type: WriteType,
}

impl BleTransport {
    /// Scan for the service, connect to the first match.
    ///
    /// Filtered by service UUID rather than by name: a name is host-supplied
    /// decoration (T56 makes it user-settable), while the service UUID is what
    /// actually identifies the protocol.
    pub async fn connect(scan_time: Duration) -> Result<Self, BleError> {
        let found = sweep(scan_time, None).await?;
        let peripheral = found
            .into_iter()
            .next()
            .ok_or(BleError::NotFound { scanned_for: scan_time })?;
        Self::attach(peripheral).await
    }

    /// Connect to one specific peer by the id `scan` reported.
    ///
    /// Separate from `connect` because a chooser that lists devices and then
    /// connects to "the first match" would connect to a different device than
    /// the one the user picked whenever two are in range. Rare with a single
    /// wallet on the desk, and exactly the kind of rare that signs the wrong
    /// transaction.
    pub async fn connect_id(id: &str, scan_time: Duration) -> Result<Self, BleError> {
        let found = sweep(scan_time, Some(id)).await?;
        let peripheral = found
            .into_iter()
            .next()
            .ok_or(BleError::NotFound { scanned_for: scan_time })?;
        Self::attach(peripheral).await
    }

    /// List everything advertising the service, without connecting to any of it.
    ///
    /// Always waits out the full window, unlike `connect`: a chooser that
    /// stopped at the first hit would hide the second device rather than let
    /// the user pick between them.
    pub async fn scan(scan_time: Duration) -> Result<Vec<BleDevice>, BleError> {
        let adapter = adapter().await?;
        adapter
            .start_scan(ScanFilter { services: vec![SERVICE_UUID] })
            .await?;
        tokio::time::sleep(scan_time).await;
        let peripherals = matches(&adapter).await;
        let _ = adapter.stop_scan().await;

        let mut out = Vec::new();
        for p in peripherals? {
            let name = p.properties().await?.and_then(|props| props.local_name);
            out.push(BleDevice { id: p.id().to_string(), name });
        }
        Ok(out)
    }

    async fn attach(peripheral: Peripheral) -> Result<Self, BleError> {
        if !peripheral.is_connected().await? {
            peripheral.connect().await?;
        }
        peripheral.discover_services().await?;

        let find = |u: Uuid| {
            peripheral
                .characteristics()
                .into_iter()
                .find(|c| c.uuid == u)
                .ok_or(BleError::MissingCharacteristic(u))
        };
        let write_char = find(CHAR_WRITE_UUID)?;
        let notify_char = find(CHAR_NOTIFY_UUID)?;

        if !notify_char.properties.contains(CharPropFlags::NOTIFY) {
            return Err(BleError::NotNotifiable(CHAR_NOTIFY_UUID));
        }
        let write_type = if write_char
            .properties
            .contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
        {
            WriteType::WithoutResponse
        } else {
            WriteType::WithResponse
        };

        // Subscribe before anything is sent, so a reply that comes back fast
        // cannot arrive before we are listening for it.
        peripheral.subscribe(&notify_char).await?;
        let notifications = peripheral.notifications().await?;

        Ok(Self {
            peripheral,
            write_char,
            notifications,
            reassembler: ChunkReassembler::new(),
            decoder: FrameDecoder::new(),
            // btleplug exposes no negotiated-MTU accessor on any backend, so
            // there is nothing to ask. Assume the floor: chunking smaller than
            // the link allows only costs packets, chunking larger than it
            // allows gets the tail silently truncated. Raise it with
            // `set_mtu` once the firmware reports what it negotiated.
            mtu: MIN_MTU,
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
        let frame = encode_frame(frame_type, payload)?;
        for chunk in chunk_for_ble(&frame, self.mtu)? {
            self.peripheral
                .write(&self.write_char, &chunk, self.write_type)
                .await?;
        }
        Ok(())
    }

    /// Wait for one complete frame.
    pub async fn recv(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>), BleError> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(BleError::Timeout);
            }
            let notification =
                match tokio::time::timeout(remaining, self.notifications.next()).await {
                    Err(_) => return Err(BleError::Timeout),
                    // The stream ending means the peripheral went away.
                    Ok(None) => return Err(BleError::Timeout),
                    Ok(Some(n)) => n,
                };
            if notification.uuid != CHAR_NOTIFY_UUID {
                continue;
            }

            let Some(reassembled) = self.reassembler.push(&notification.value)? else {
                continue;
            };
            if let Some(frame) = self.decoder.push(&reassembled)?.into_iter().next() {
                return Ok(frame);
            }
        }
    }

    /// Takes `&mut self` despite not mutating anything: the notification
    /// stream is `Send` but not `Sync`, so a future holding `&BleTransport`
    /// across an await is not `Send` and cannot be a Tauri async command.
    /// A unique borrow needs only `Send`.
    pub async fn disconnect(&mut self) -> Result<(), BleError> {
        self.peripheral.disconnect().await?;
        Ok(())
    }
}

async fn adapter() -> Result<Adapter, BleError> {
    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    adapters.into_iter().next().ok_or(BleError::NoAdapter)
}

/// Scan until something matches or the window closes.
///
/// Polls rather than waiting out the full window: a device that is already
/// advertising is usually found in well under a second, and making the common
/// case take `scan_time` would be gratuitous.
async fn sweep(scan_time: Duration, want: Option<&str>) -> Result<Vec<Peripheral>, BleError> {
    let adapter = adapter().await?;
    adapter
        .start_scan(ScanFilter { services: vec![SERVICE_UUID] })
        .await?;

    let deadline = tokio::time::Instant::now() + scan_time;
    let found = loop {
        let mut hits = matches(&adapter).await?;
        if let Some(id) = want {
            hits.retain(|p| p.id().to_string() == id);
        }
        if !hits.is_empty() {
            break hits;
        }
        if tokio::time::Instant::now() >= deadline {
            break Vec::new();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let _ = adapter.stop_scan().await;
    Ok(found)
}

async fn matches(adapter: &Adapter) -> Result<Vec<Peripheral>, BleError> {
    let mut out = Vec::new();
    for p in adapter.peripherals().await? {
        let Some(props) = p.properties().await? else {
            continue;
        };
        if props.services.contains(&SERVICE_UUID) {
            out.push(p);
        }
    }
    Ok(out)
}
