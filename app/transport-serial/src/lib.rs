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

use std::io::{Read, Write};
use std::time::{Duration, Instant};

pub const SYNC: [u8; 2] = [b'L', b'K'];

/// Above any response the device produces, and small enough that a garbage
/// length is rejected rather than allocated. The device applies the same cap.
pub const MAX_FRAME: usize = 4096;

pub const FRAME_REQUEST: u8 = 0x01;
pub const FRAME_RESPONSE: u8 = 0x02;
pub const FRAME_ENC_REQUEST: u8 = 0x11;
pub const FRAME_ENC_RESPONSE: u8 = 0x12;
pub const FRAME_ERROR: u8 = 0x7F;

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    Serial(serialport::Error),
    Timeout,
    /// A length field no device of ours would send.
    BadFrame(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "io: {e}"),
            TransportError::Serial(e) => write!(f, "serial: {e}"),
            TransportError::Timeout => write!(f, "timed out waiting for the device"),
            TransportError::BadFrame(m) => write!(f, "bad frame: {m}"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}
impl From<serialport::Error> for TransportError {
    fn from(e: serialport::Error) -> Self {
        TransportError::Serial(e)
    }
}

#[derive(Debug, Clone)]
pub struct PortInfo {
    pub name: String,
    pub description: String,
    /// True when the USB VID/PID matches an Espressif device.
    pub likely_device: bool,
}

/// Espressif's vendor ID. Used to rank ports, never to trust one: a matching
/// VID says something about the cable, not about what is on the other end.
const ESPRESSIF_VID: u16 = 0x303A;

/// USB serial ports only.
///
/// A typical Linux box enumerates twenty or more `/dev/ttyS*` legacy ports that
/// no hardware wallet will ever appear on. Listing them buries the one entry
/// that matters and makes a connect dialog useless.
pub fn list_ports() -> Result<Vec<PortInfo>, TransportError> {
    let mut out = Vec::new();
    for p in serialport::available_ports()? {
        let serialport::SerialPortType::UsbPort(usb) = &p.port_type else {
            continue;
        };
        let description = usb
            .product
            .clone()
            .unwrap_or_else(|| format!("{:04x}:{:04x}", usb.vid, usb.pid));
        out.push(PortInfo {
            name: p.port_name,
            description,
            likely_device: usb.vid == ESPRESSIF_VID,
        });
    }
    // Likely devices first, so a UI can default sensibly without guessing.
    out.sort_by_key(|p| !p.likely_device);
    Ok(out)
}

pub struct SerialTransport {
    port: Box<dyn serialport::SerialPort>,
    /// Bytes seen but not yet consumed. A read can split a frame or carry two.
    buffer: Vec<u8>,
}

impl SerialTransport {
    pub fn open(path: &str) -> Result<Self, TransportError> {
        let port = serialport::new(path, 115_200)
            .timeout(Duration::from_millis(100))
            // No DTR/RTS toggling: on the ESP32-S3's USB-Serial-JTAG that
            // resets the chip, which would reboot the device every time the
            // app connected.
            .dtr_on_open(false)
            .open()?;
        Ok(Self { port, buffer: Vec::with_capacity(MAX_FRAME) })
    }

    pub fn send(&mut self, frame_type: u8, payload: &[u8]) -> Result<(), TransportError> {
        let body = payload.len() + 1;
        if body + 4 > MAX_FRAME {
            return Err(TransportError::BadFrame(format!("{body} bytes is over the cap")));
        }

        let mut out = Vec::with_capacity(body + 4);
        out.extend_from_slice(&SYNC);
        out.push((body >> 8) as u8);
        out.push(body as u8);
        out.push(frame_type);
        out.extend_from_slice(payload);

        self.port.write_all(&out)?;
        self.port.flush()?;
        Ok(())
    }

    /// Read one frame, discarding any console text that precedes it.
    pub fn recv(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>), TransportError> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(frame) = self.take_frame()? {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }

            let mut chunk = [0u8; 256];
            match self.port.read(&mut chunk) {
                Ok(0) => {}
                Ok(n) => {
                    if self.buffer.len() + n > MAX_FRAME * 4 {
                        // Only reachable if the device is emitting console text
                        // faster than frames arrive. Drop the oldest rather
                        // than grow without bound.
                        let excess = self.buffer.len() + n - MAX_FRAME * 4;
                        self.buffer.drain(..excess);
                    }
                    self.buffer.extend_from_slice(&chunk[..n]);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(TransportError::Io(e)),
            }
        }
    }

    /// Pull one complete frame out of the buffer, resynchronising past noise.
    fn take_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, TransportError> {
        loop {
            // Console output shares this port, so leading text is expected.
            let start = self
                .buffer
                .windows(2)
                .position(|w| w == SYNC)
                .unwrap_or(self.buffer.len().saturating_sub(1));
            if start > 0 {
                self.buffer.drain(..start);
            }
            if self.buffer.len() < 4 {
                return Ok(None);
            }

            let body = ((self.buffer[2] as usize) << 8) | self.buffer[3] as usize;
            if body < 1 || body + 4 > MAX_FRAME {
                // Not a length we would send. Drop the marker and rescan rather
                // than trusting it and waiting forever for bytes that are not
                // coming.
                self.buffer.drain(..2);
                continue;
            }
            if self.buffer.len() < body + 4 {
                return Ok(None);
            }

            let frame_type = self.buffer[4];
            let payload = self.buffer[5..body + 4].to_vec();
            self.buffer.drain(..body + 4);
            return Ok(Some((frame_type, payload)));
        }
    }
}
