//! Frames on a byte stream. No I/O, no platform, no async.
//!
//! Split out of `lib.rs` for T59. Android reaches the same device over the same
//! CDC-ACM endpoints, but it cannot use the `serialport` crate to get there —
//! bulk transfers come back from a Kotlin `UsbDeviceConnection` instead. The
//! only thing the two backends may not disagree about is the wire, so the wire
//! lives here and both of them call into it. This is the same split
//! `leek-transport-ble` already makes between `wire.rs` and its two radio
//! backends, for the same reason: the part worth testing is testable with no
//! hardware in the room, and the part that needs hardware is kept as small as
//! it can be.
//!
//! ```text
//! ┌──────┬──────┬────────┬──────────────┐
//! │ 'L'  │ 'K'  │ len:u16│ type + CBOR  │   len covers type + payload
//! └──────┴──────┴────────┴──────────────┘
//! ```
//!
//! The device shares this stream with its console logs, so unlike BLE every
//! frame carries the two-byte sync marker and a reader that loses sync scans
//! forward to the next one rather than misparsing. See `src/protocol.c` and
//! docs/PROTOCOL.md §2.

pub const SYNC: [u8; 2] = [b'L', b'K'];

/// Above any response the device produces, and small enough that a garbage
/// length is rejected rather than allocated. The device applies the same cap.
pub const MAX_FRAME: usize = 4096;

/// How much unparsed stream to hold before dropping the oldest bytes.
///
/// Only reachable when the device is emitting console text faster than frames
/// arrive. Bounded rather than growing without end: on a phone an unbounded
/// buffer fed by a chatty device is an out-of-memory kill, which is a much
/// worse failure than losing log text nobody was reading.
pub const MAX_BUFFER: usize = MAX_FRAME * 4;

pub const FRAME_REQUEST: u8 = 0x01;
pub const FRAME_RESPONSE: u8 = 0x02;
pub const FRAME_ENC_REQUEST: u8 = 0x11;
pub const FRAME_ENC_RESPONSE: u8 = 0x12;
pub const FRAME_ERROR: u8 = 0x7F;

#[derive(Debug, PartialEq, Eq)]
pub enum WireError {
    /// A length field no device of ours would send.
    BadFrame(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::BadFrame(m) => write!(f, "bad frame: {m}"),
        }
    }
}

impl std::error::Error for WireError {}

/// Serialise one frame, ready to be written to the stream.
pub fn encode_frame(frame_type: u8, payload: &[u8]) -> Result<Vec<u8>, WireError> {
    let body = payload.len() + 1; // the type byte counts toward the length
    if body + 4 > MAX_FRAME {
        return Err(WireError::BadFrame(format!("{body} bytes is over the cap")));
    }

    let mut out = Vec::with_capacity(body + 4);
    out.extend_from_slice(&SYNC);
    out.push((body >> 8) as u8);
    out.push(body as u8);
    out.push(frame_type);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Pulls frames out of a byte stream that also carries console text.
#[derive(Default)]
pub struct FrameDecoder {
    /// Bytes seen but not yet consumed. A read can split a frame or carry two.
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buffer: Vec::with_capacity(MAX_FRAME) }
    }

    /// Add bytes just read from the device.
    pub fn feed(&mut self, bytes: &[u8]) {
        if self.buffer.len() + bytes.len() > MAX_BUFFER {
            let excess = self.buffer.len() + bytes.len() - MAX_BUFFER;
            // Drop the oldest. Anything that old is either console text or a
            // frame we already failed to complete.
            let excess = excess.min(self.buffer.len());
            self.buffer.drain(..excess);
        }
        self.buffer.extend_from_slice(bytes);
    }

    /// Pull one complete frame out of the buffer, resynchronising past noise.
    ///
    /// `Ok(None)` means "not yet", never "never": the caller loops against its
    /// own deadline.
    pub fn next_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, WireError> {
        loop {
            // Console output shares this stream, so leading text is expected.
            // When no marker is present, keep the final byte: it may be the
            // 'L' of a marker whose 'K' has not arrived yet.
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

    /// Forget everything buffered.
    ///
    /// Called before each request: the protocol has no request IDs, so a reply
    /// left over from an earlier exchange is indistinguishable from an answer
    /// to the next one.
    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn pending(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let mut d = FrameDecoder::new();
        d.feed(&encode_frame(FRAME_RESPONSE, b"hello").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"hello".to_vec())));
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn console_text_before_a_frame_is_skipped() {
        let mut d = FrameDecoder::new();
        d.feed(b"I (123) leek: booting\n");
        d.feed(&encode_frame(FRAME_RESPONSE, b"ok").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"ok".to_vec())));
    }

    #[test]
    fn a_byte_at_a_time_still_decodes() {
        let mut d = FrameDecoder::new();
        for b in encode_frame(FRAME_ENC_RESPONSE, b"chunked") {
            for byte in b {
                d.feed(&[byte]);
            }
        }
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_ENC_RESPONSE, b"chunked".to_vec())));
    }

    #[test]
    fn two_frames_in_one_read() {
        let mut d = FrameDecoder::new();
        let mut both = encode_frame(FRAME_RESPONSE, b"one").unwrap();
        both.extend(encode_frame(FRAME_RESPONSE, b"two").unwrap());
        d.feed(&both);
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"one".to_vec())));
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"two".to_vec())));
        assert_eq!(d.next_frame().unwrap(), None);
    }

    #[test]
    fn a_lying_length_is_rescanned_past_not_waited_on() {
        let mut d = FrameDecoder::new();
        // A marker followed by an impossible length, then a real frame.
        d.feed(&[b'L', b'K', 0xff, 0xff, 0x00]);
        d.feed(&encode_frame(FRAME_RESPONSE, b"real").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"real".to_vec())));
    }

    #[test]
    fn a_marker_split_across_reads_is_not_lost() {
        let mut d = FrameDecoder::new();
        d.feed(b"noise L");
        d.feed(&[b'K', 0x00, 0x03, FRAME_RESPONSE, b'h', b'i']);
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"hi".to_vec())));
    }

    #[test]
    fn zero_length_body_is_refused() {
        let mut d = FrameDecoder::new();
        // len 0 cannot even hold the type byte.
        d.feed(&[b'L', b'K', 0x00, 0x00]);
        d.feed(&encode_frame(FRAME_RESPONSE, b"x").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"x".to_vec())));
    }

    #[test]
    fn oversized_frame_is_refused_at_encode() {
        assert!(encode_frame(FRAME_REQUEST, &vec![0u8; MAX_FRAME]).is_err());
    }

    #[test]
    fn the_buffer_is_capped() {
        let mut d = FrameDecoder::new();
        for _ in 0..64 {
            d.feed(&vec![b'.'; 1024]);
        }
        assert!(d.pending() <= MAX_BUFFER);
    }

    #[test]
    fn capping_does_not_break_a_following_frame() {
        let mut d = FrameDecoder::new();
        for _ in 0..64 {
            d.feed(&vec![b'.'; 1024]);
        }
        d.feed(&encode_frame(FRAME_RESPONSE, b"survivor").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"survivor".to_vec())));
    }

    #[test]
    fn reset_drops_a_stale_partial_frame() {
        let mut d = FrameDecoder::new();
        d.feed(&[b'L', b'K', 0x00, 0x10]);
        d.reset();
        d.feed(&encode_frame(FRAME_RESPONSE, b"fresh").unwrap());
        assert_eq!(d.next_frame().unwrap(), Some((FRAME_RESPONSE, b"fresh".to_vec())));
    }
}
