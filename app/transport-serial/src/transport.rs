//! The desktop half: a real serial port through the `serialport` crate.
//!
//! Unchanged in behaviour by T59 — every line of the open/send/recv sequence
//! below is the one that has been in daily use, including the two sleeps and
//! clears that were each paid for with a debugging session. Only the framing
//! moved out, into `wire.rs`, so that Android can share it.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::error::TransportError;
use crate::wire::{encode_frame, FrameDecoder};
use crate::{PortInfo, ESPRESSIF_VID};

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
    decoder: FrameDecoder,
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

        /* Let the port settle, then drop whatever the device had queued.
         *
         * The ESP32-S3's USB-Serial-JTAG hands over its buffered TX shortly
         * AFTER the host opens the port, so clearing immediately clears
         * nothing and the stale bytes land on the next read. Since the
         * protocol has no request IDs, that reply then looks like an answer to
         * whatever is sent first. */
        std::thread::sleep(Duration::from_millis(250));
        let mut port = port;
        let _ = port.clear(serialport::ClearBuffer::Input);
        let _ = &mut port;

        Ok(Self { port, decoder: FrameDecoder::new() })
    }

    pub fn send(&mut self, frame_type: u8, payload: &[u8]) -> Result<(), TransportError> {
        let out = encode_frame(frame_type, payload)?;

        /* Drop anything already sitting in the OS buffer before sending.
         *
         * There is no request ID, so a reply is matched to whichever request
         * went out last - which means a leftover reply from an earlier run is
         * indistinguishable from an answer to this one. That is not
         * theoretical: it made a device that was correctly silent on USB (BLE
         * was the selected transport) look like it was answering, and a
         * transport-exclusivity bug get reported that did not exist. */
        self.port.clear(serialport::ClearBuffer::Input)?;
        self.decoder.reset();

        self.port.write_all(&out)?;
        self.port.flush()?;
        Ok(())
    }

    /// Read one frame, discarding any console text that precedes it.
    pub fn recv(&mut self, timeout: Duration) -> Result<(u8, Vec<u8>), TransportError> {
        let deadline = Instant::now() + timeout;

        loop {
            if let Some(frame) = self.decoder.next_frame()? {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err(TransportError::Timeout);
            }

            let mut chunk = [0u8; 256];
            match self.port.read(&mut chunk) {
                Ok(0) => {}
                Ok(n) => self.decoder.feed(&chunk[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(TransportError::Io(e)),
            }
        }
    }
}
