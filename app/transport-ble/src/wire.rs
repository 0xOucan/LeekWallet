//! Frames and BLE chunking. No radio, no async, no I/O — so all of it can be
//! tested on a machine with the Bluetooth adapter unplugged, which is where
//! this code was written.
//!
//! Mirrors `app/packages/core/src/framing.ts` (`chunkForBle`,
//! `ChunkReassembler`) byte for byte. If the two ever disagree the device will
//! reassemble something the host never sent, so the TS file is the reference
//! and this is the translation, not a second design.
//!
//! ```text
//! frame:  ┌────────┬────────┬──────────────┐
//!         │ len:u16│ type:u8│ payload:CBOR │   len covers type + payload
//!         └────────┴────────┴──────────────┘
//! chunk:  ┌────────┬──────────────────────┐
//!         │ hdr:u8 │ slice of the frame   │   hdr bit7 = more, bits0-6 = seq
//!         └────────┴──────────────────────┘
//! ```

/// Both sides refuse anything larger, so a lying length field costs nothing.
pub const MAX_FRAME: usize = 4096;

/// USB prefixes every frame with `'L','K'` because it shares its port with
/// console logs and a reader has to be able to find the start of a frame in a
/// stream of text. A GATT characteristic carries nothing but our frames, so
/// there is nothing to resynchronise against and the marker is two wasted
/// bytes out of a 19-byte chunk payload — over 10% of the budget at the small
/// MTU.
///
/// The firmware agent owns the decision. This is the one place it lives: flip
/// the constant and both `encode_frame` and `FrameDecoder` follow.
pub const BLE_USES_SYNC: bool = false;

pub const SYNC: [u8; 2] = *b"LK";

pub const FRAME_REQUEST: u8 = 0x01;
pub const FRAME_RESPONSE: u8 = 0x02;
pub const FRAME_ENC_REQUEST: u8 = 0x11;
pub const FRAME_ENC_RESPONSE: u8 = 0x12;
pub const FRAME_EVENT: u8 = 0x13;
pub const FRAME_ENC_ERROR: u8 = 0x7e;
pub const FRAME_ERROR: u8 = 0x7f;

pub const CHUNK_HEADER_MORE: u8 = 0x80;
pub const CHUNK_SEQ_MASK: u8 = 0x7f;

/// Smallest MTU the spec permits, and what a surprising number of stacks
/// actually settle on. Assume it until something tells us otherwise: chunking
/// too small is slow, chunking too large is silently truncated writes.
pub const MIN_MTU: u16 = 23;

#[derive(Debug, PartialEq, Eq)]
pub enum WireError {
    /// A length field no device of ours would send.
    BadFrame(String),
    BadChunk(String),
    MtuTooSmall(u16),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::BadFrame(m) => write!(f, "bad frame: {m}"),
            WireError::BadChunk(m) => write!(f, "bad chunk: {m}"),
            WireError::MtuTooSmall(m) => write!(f, "MTU {m} leaves no room for a payload"),
        }
    }
}

impl std::error::Error for WireError {}

pub fn encode_frame(frame_type: u8, payload: &[u8]) -> Result<Vec<u8>, WireError> {
    let length = payload.len() + 1; // the type byte counts
    if length + 2 > MAX_FRAME {
        return Err(WireError::BadFrame(format!(
            "{} bytes exceeds {MAX_FRAME}",
            length + 2
        )));
    }

    let mut out = Vec::with_capacity(length + 4);
    if BLE_USES_SYNC {
        out.extend_from_slice(&SYNC);
    }
    out.push((length >> 8) as u8);
    out.push(length as u8);
    out.push(frame_type);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Split a frame across GATT writes.
///
/// `mtu` is the negotiated ATT MTU: three bytes go to the ATT write header,
/// one more to our chunk header.
pub fn chunk_for_ble(frame: &[u8], mtu: u16) -> Result<Vec<Vec<u8>>, WireError> {
    let capacity = (mtu as usize).saturating_sub(3 + 1);
    if capacity < 1 {
        return Err(WireError::MtuTooSmall(mtu));
    }

    let mut chunks = Vec::new();
    let mut offset = 0usize;
    let mut seq = 0u8;
    while offset < frame.len() {
        let end = (offset + capacity).min(frame.len());
        let more = end < frame.len();
        let mut chunk = Vec::with_capacity(end - offset + 1);
        chunk.push(if more { CHUNK_HEADER_MORE } else { 0 } | (seq & CHUNK_SEQ_MASK));
        chunk.extend_from_slice(&frame[offset..end]);
        chunks.push(chunk);
        offset = end;
        seq = seq.wrapping_add(1);
    }
    Ok(chunks)
}

/// Reassembles chunks into frames, refusing anything that does not add up.
///
/// A gap, a repeat or a reordering means we do not have the bytes the device
/// sent, and guessing which is worse than failing: the payload underneath is a
/// transaction. Every rejection clears the buffer, so a peer cannot leave us
/// holding state by walking away mid-frame.
#[derive(Default)]
pub struct ChunkReassembler {
    parts: Vec<u8>,
    expected_seq: u8,
}

impl ChunkReassembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Option<Vec<u8>>, WireError> {
        let Some(&header) = chunk.first() else {
            return Err(WireError::BadChunk("empty chunk".into()));
        };

        let seq = header & CHUNK_SEQ_MASK;
        let more = header & CHUNK_HEADER_MORE != 0;

        if seq != self.expected_seq {
            let expected = self.expected_seq;
            self.reset();
            return Err(WireError::BadChunk(format!(
                "out of order: expected seq {expected}, got {seq}"
            )));
        }

        // Checked before extending, not after: the point is to never hold more
        // than one frame's worth of a hostile peer's bytes.
        if self.parts.len() + chunk.len() - 1 > MAX_FRAME {
            self.reset();
            return Err(WireError::BadChunk(format!(
                "reassembly would exceed {MAX_FRAME} bytes"
            )));
        }

        self.parts.extend_from_slice(&chunk[1..]);
        self.expected_seq = (self.expected_seq + 1) & CHUNK_SEQ_MASK;

        if more {
            return Ok(None);
        }
        let out = std::mem::take(&mut self.parts);
        self.reset();
        Ok(Some(out))
    }

    pub fn reset(&mut self) {
        self.parts.clear();
        self.expected_seq = 0;
    }

    pub fn pending(&self) -> usize {
        self.parts.len()
    }
}

/// Incremental frame decoder fed by reassembled chunks.
///
/// One reassembled unit *should* be exactly one frame, but nothing on the wire
/// guarantees that, so bytes accumulate here rather than being parsed in
/// place. Unlike the USB decoder there is no resynchronising: on a dedicated
/// characteristic a frame that does not parse is a bug or an attack, and
/// scanning forward for a plausible-looking length would turn either one into
/// a silently accepted frame.
#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<(u8, Vec<u8>)>, WireError> {
        if self.buffer.len() + bytes.len() > MAX_FRAME * 2 {
            self.buffer.clear();
            return Err(WireError::BadFrame("decoder buffer overflowed".into()));
        }
        self.buffer.extend_from_slice(bytes);

        let mut frames = Vec::new();
        loop {
            let header = if BLE_USES_SYNC { 2 } else { 0 };
            if self.buffer.len() < header + 3 {
                break;
            }
            if BLE_USES_SYNC && self.buffer[..2] != SYNC {
                self.buffer.clear();
                return Err(WireError::BadFrame("missing sync marker".into()));
            }

            let length =
                ((self.buffer[header] as usize) << 8) | self.buffer[header + 1] as usize;
            if length < 1 || length + 2 > MAX_FRAME {
                self.buffer.clear();
                return Err(WireError::BadFrame(format!("invalid length {length}")));
            }
            if self.buffer.len() < header + length + 2 {
                break;
            }

            let frame_type = self.buffer[header + 2];
            let payload = self.buffer[header + 3..header + length + 2].to_vec();
            self.buffer.drain(..header + length + 2);
            frames.push((frame_type, payload));
        }
        Ok(frames)
    }

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

    fn frame(n: usize) -> Vec<u8> {
        encode_frame(FRAME_RESPONSE, &vec![0xab; n]).unwrap()
    }

    #[test]
    fn round_trip_at_the_smallest_mtu() {
        // 23 is what BlueZ hands us when nothing negotiates up, so it is the
        // case most likely to be hit and least likely to be tested.
        let f = frame(200);
        let chunks = chunk_for_ble(&f, MIN_MTU).unwrap();
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.len() <= MIN_MTU as usize - 3);
        }

        let mut r = ChunkReassembler::new();
        let mut got = None;
        for c in &chunks {
            got = r.push(c).unwrap();
        }
        assert_eq!(got.unwrap(), f);
    }

    #[test]
    fn capacity_matches_the_typescript() {
        // mtu - 3 (ATT) - 1 (chunk header); the TS computes the same number.
        for (mtu, cap) in [(23u16, 19usize), (185, 181), (247, 243)] {
            let chunks = chunk_for_ble(&vec![0u8; cap * 2], mtu).unwrap();
            assert_eq!(chunks[0].len() - 1, cap, "mtu {mtu}");
            assert_eq!(chunks.len(), 2);
        }
    }

    #[test]
    fn single_chunk_frame_has_no_more_bit() {
        let chunks = chunk_for_ble(&frame(4), 247).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0][0], 0);
    }

    #[test]
    fn mtu_with_no_room_is_refused() {
        assert_eq!(chunk_for_ble(&frame(4), 4), Err(WireError::MtuTooSmall(4)));
        assert_eq!(chunk_for_ble(&frame(4), 0), Err(WireError::MtuTooSmall(0)));
    }

    #[test]
    fn sequence_wraps_past_127() {
        // 7 bits of sequence, so a long frame at a small MTU wraps. The
        // reassembler must wrap with it rather than stall at 127.
        let f = frame(19 * 200);
        let chunks = chunk_for_ble(&f, MIN_MTU).unwrap();
        assert!(chunks.len() > 128);
        let mut r = ChunkReassembler::new();
        let mut got = None;
        for c in &chunks {
            got = r.push(c).unwrap();
        }
        assert_eq!(got.unwrap(), f);
    }

    #[test]
    fn a_dropped_chunk_is_rejected_not_stitched() {
        let chunks = chunk_for_ble(&frame(100), MIN_MTU).unwrap();
        let mut r = ChunkReassembler::new();
        r.push(&chunks[0]).unwrap();
        assert!(r.push(&chunks[2]).is_err());
        assert_eq!(r.pending(), 0, "a rejection must not leave bytes behind");
    }

    #[test]
    fn a_duplicated_chunk_is_rejected() {
        let chunks = chunk_for_ble(&frame(100), MIN_MTU).unwrap();
        let mut r = ChunkReassembler::new();
        r.push(&chunks[0]).unwrap();
        assert!(r.push(&chunks[0]).is_err());
    }

    #[test]
    fn reassembly_cannot_grow_without_bound() {
        // A peer that never sets the final bit: the cap has to bite while the
        // frame is still in pieces, not once it is complete.
        let mut r = ChunkReassembler::new();
        let mut seq = 0u8;
        let mut err = None;
        for _ in 0..1000 {
            let mut chunk = vec![CHUNK_HEADER_MORE | (seq & CHUNK_SEQ_MASK)];
            chunk.extend_from_slice(&[0u8; 19]);
            if let Err(e) = r.push(&chunk) {
                err = Some(e);
                break;
            }
            seq = seq.wrapping_add(1);
        }
        assert!(err.is_some(), "unterminated frame was buffered forever");
        assert_eq!(r.pending(), 0);
    }

    #[test]
    fn empty_chunk_is_rejected() {
        assert!(ChunkReassembler::new().push(&[]).is_err());
    }

    #[test]
    fn decoder_accepts_bytes_one_at_a_time() {
        let f = frame(60);
        let mut d = FrameDecoder::new();
        for (i, b) in f.iter().enumerate() {
            let frames = d.push(&[*b]).unwrap();
            if i + 1 == f.len() {
                assert_eq!(frames.len(), 1);
                assert_eq!(frames[0].0, FRAME_RESPONSE);
                assert_eq!(frames[0].1, vec![0xab; 60]);
            } else {
                assert!(frames.is_empty(), "frame emitted early at byte {i}");
            }
        }
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn decoder_splits_two_frames_in_one_delivery() {
        let mut joined = frame(3);
        joined.extend_from_slice(&frame(5));
        let frames = FrameDecoder::new().push(&joined).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].1.len(), 3);
        assert_eq!(frames[1].1.len(), 5);
    }

    #[test]
    fn a_length_field_that_lies_is_refused() {
        // Claims 60000 bytes and supplies four. Nothing is allocated and the
        // decoder does not sit waiting for bytes that are not coming.
        let mut d = FrameDecoder::new();
        assert!(d.push(&[0xea, 0x60, 0x02, 0x00]).is_err());
        assert_eq!(d.pending(), 0);

        // Zero-length is equally impossible: the type byte always counts.
        assert!(FrameDecoder::new().push(&[0x00, 0x00, 0x02]).is_err());
    }

    #[test]
    fn oversized_frame_is_refused_at_encode() {
        assert!(encode_frame(FRAME_REQUEST, &vec![0u8; MAX_FRAME]).is_err());
        assert!(encode_frame(FRAME_REQUEST, &vec![0u8; MAX_FRAME - 3]).is_ok());
    }

    #[test]
    fn decoder_buffer_is_capped() {
        let mut d = FrameDecoder::new();
        // A frame header promising a legal length, then a flood of bytes that
        // never completes it.
        d.push(&[0x0f, 0xf0, 0x02]).unwrap();
        let mut err = None;
        for _ in 0..100 {
            if let Err(e) = d.push(&[0u8; 1024]) {
                err = Some(e);
                break;
            }
        }
        assert!(err.is_some());
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn sync_marker_presence_matches_the_flag() {
        // Guards the flip: whichever way BLE_USES_SYNC is set, encode and
        // decode must agree, and the header length must follow.
        let f = encode_frame(FRAME_REQUEST, b"hi").unwrap();
        if BLE_USES_SYNC {
            assert_eq!(&f[..2], &SYNC);
            assert_eq!(f.len(), 2 + 2 + 1 + 2);
        } else {
            assert_eq!(f.len(), 2 + 1 + 2);
            assert_eq!(f[0], 0x00);
        }
        let frames = FrameDecoder::new().push(&f).unwrap();
        assert_eq!(frames[0], (FRAME_REQUEST, b"hi".to_vec()));
    }
}
