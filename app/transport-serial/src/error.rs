//! One error type for both USB backends.
//!
//! Shared rather than per-backend for the same reason `leek-transport-ble`
//! shares its own: the messages are the part that matters. The sentence that
//! explains a silent cable took several confused evenings to get right on the
//! desktop, and a user hitting the same silence on a phone deserves the same
//! sentence rather than a worse one written later in a hurry.

use crate::wire::WireError;

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    /// Whatever the platform USB layer said, already formatted. Flattened to a
    /// `String` at the boundary because it is only ever displayed, and keeping
    /// it typed would drag `serialport` into the Android build, where the whole
    /// point is that it is not present.
    Serial(String),
    Wire(WireError),
    Timeout,
    /// Android: nothing with a matching vendor ID is attached.
    #[cfg(target_os = "android")]
    NoDevice,
    /// Android: the device is attached but the user has not granted this app
    /// permission to open it.
    ///
    /// Distinct from `NoDevice` on purpose. A denied permission and an unplugged
    /// cable both end up as "no device" if they are not separated, and telling
    /// someone to check their cable when the real problem is a dialog they
    /// dismissed is the worst answer this code could give — the same mistake
    /// `BleError::PermissionDenied` exists to avoid.
    #[cfg(target_os = "android")]
    PermissionDenied { product: String },
    /// Android: permission was granted, but the device exposes no CDC-ACM
    /// interface we know how to drive.
    #[cfg(target_os = "android")]
    NotCdcAcm { product: String },
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "io: {e}"),
            TransportError::Serial(e) => write!(f, "serial: {e}"),
            TransportError::Wire(e) => write!(f, "{e}"),
            TransportError::Timeout => write!(f, "timed out waiting for the device"),
            #[cfg(target_os = "android")]
            TransportError::NoDevice => write!(
                f,
                "No LeekWallet is attached over USB.\n\
                 Check the cable is a data cable and not charge-only, that the phone\n\
                 supports USB host (OTG) — most do over USB-C, few over micro-USB —\n\
                 and that an OTG adapter is used if the cable is not C-to-C.\n\
                 The device's Link setting does not affect this: it enumerates over\n\
                 USB either way, so a device missing here is an electrical problem,\n\
                 not a mode problem."
            ),
            #[cfg(target_os = "android")]
            TransportError::PermissionDenied { product } => write!(
                f,
                "USB permission not granted for {product}.\n\
                 Android requires you to approve each USB device explicitly, per\n\
                 device and per app. Unplug and replug the cable, then tap Connect\n\
                 again and choose OK on the \"Allow LeekWallet to access the USB\n\
                 device?\" dialog. Ticking \"Use by default for this USB device\"\n\
                 makes the grant stick until the app is uninstalled.\n\
                 If no dialog appeared at all, the app was not in the foreground\n\
                 when it was raised — bring it forward and try once more."
            ),
            #[cfg(target_os = "android")]
            TransportError::NotCdcAcm { product } => write!(
                f,
                "{product} is attached and permitted, but exposes no CDC-ACM serial\n\
                 interface. That is not a LeekWallet, or its USB console is disabled\n\
                 in firmware."
            ),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}

impl From<WireError> for TransportError {
    fn from(e: WireError) -> Self {
        TransportError::Wire(e)
    }
}

#[cfg(feature = "serialport")]
impl From<serialport::Error> for TransportError {
    fn from(e: serialport::Error) -> Self {
        TransportError::Serial(e.to_string())
    }
}
