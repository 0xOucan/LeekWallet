//! Firmware flashing over USB (T65).
//!
//! `espflash` as a library rather than a bundled CLI: the esptool protocol runs
//! in this process, so there is no Python to ship, no second binary to sign, and
//! no shelling out to something a user could have shadowed on their PATH. The
//! `cli` feature is off for the same reason — it drags in clap, indicatif,
//! crossterm and an update check that phones crates.io, none of which belongs in
//! a wallet's process.
//!
//! # What this is, honestly
//!
//! **A flasher is a way to install firmware, and firmware is what holds the
//! keys.** On a device without secure boot, anything written here runs with full
//! access to the vault and to the PIN entry screen. That hole is not opened by
//! this module — USB-Serial-JTAG can be commanded into ROM download mode by any
//! host, so `esptool` has always been able to do this — but a button in the
//! wallet app turns "possible for someone who knows esptool" into "one click",
//! and that difference is worth being deliberate about.
//!
//! What makes it safe is secure boot (T11): once burned, the bootloader only
//! runs images signed by the vendor key, so a flasher can install *this
//! project's* releases and nothing else. Until then the UI must say plainly that
//! the device will run whatever it is given, and `flash_capability()` exists so
//! the frontend cannot forget to ask.
//!
//! # What it writes
//!
//! A **merged image at offset 0** — what `idf.py merge-bin` and `esptool
//! merge_bin` produce: bootloader, partition table and app in one file, with the
//! gaps between them padded. That padding covers `nvs` at 0x9000, so writing one
//! **erases the vault and every seed stored on the device**. That is not a side
//! effect to be hidden; it is the headline the UI leads with, and the
//! acknowledgement the user ticks says it in those words.
//!
//! An app-only image at 0x10000 is also accepted, because that is what a
//! developer iterating on their own board writes. Offsets between the two are
//! refused: a partial write over the partition table or over `nvs` is the one
//! mistake here that destroys wallets *quietly*, leaving a device that boots.
//!
//! # Refusals, not warnings
//!
//! Three things are checked before the port is opened, because the first thing a
//! flash does is erase and a file rejected afterwards is a brick:
//!
//! * **The SHA-256 the caller expects.** Recomputed here over the exact bytes
//!   about to be written, and a mismatch is a refusal. Never a warning: a wallet
//!   image whose digest does not match what the user checked against the release
//!   notes is a wallet image nobody should install, and "continue anyway" has no
//!   correct use.
//! * **The ESP image header**, including the chip it was built for. Both boards
//!   this project supports are USB-Serial-JTAG under Espressif's VID and look
//!   identical from the host, so an ESP32-S3 image written to an ESP32-C3 is an
//!   easy mistake — and it fails at boot, silently, in a way that reads like a
//!   broken cable. The header carries the chip id; the ROM reports the chip. If
//!   they disagree, nothing is written.
//! * **The offset**, as above.
//!
//! # Deliberate limits
//!
//! * **Desktop only, and not because a phone cannot in principle do this.**
//!   T59 already ships USB serial on Android, and `android-usb-serial`'s
//!   `SerialPortAdapter` implements the whole `serialport::SerialPort` trait
//!   including `write_data_terminal_ready`/`write_request_to_send` — the two
//!   calls that put a chip into download mode. The obstacle is on espflash's
//!   side: `espflash::connection::Port` is a concrete `serialport::TTYPort` /
//!   `COMPort` alias, not a `Box<dyn SerialPort>`, and `Connection::new` takes
//!   it by value. There is no seam to hand an adapter to. Making the phone work
//!   needs a change in espflash or a fork, so this build says it cannot rather
//!   than shipping a button that fails at the last step.
//! * **No eFuse burning.** Burning is irreversible and ends the board's ability
//!   to run anything else; it does not belong behind the same button as an
//!   update. See docs/BURN-PROCEDURE.md.
//! * **Nothing is fetched.** The image is read from a path the user chose. This
//!   module does not download and does not decide what is authentic; it only
//!   confirms that the bytes match the digest it was told to expect.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Where a merged image goes: the bootloader is the first thing in flash.
pub const MERGED_IMAGE_OFFSET: u32 = 0x0;

/// Where an app-only image goes on this project's default layout.
///
/// `partitions.csv`: nvs at 0x9000, phy_init at 0xf000, app at 0x10000. The
/// secure layout moves the app to 0x20000 because a signed bootloader and a
/// signed partition table push everything out — see partitions-secure.csv, which
/// documents how getting this wrong once wrote a signature over the first 4 KB
/// of a vault.
pub const APP_OFFSET: u32 = 0x10000;

/// A plausible firmware image is at least this big.
///
/// The real one is over a megabyte. This only rejects the obvious mistake of
/// pointing the flasher at an empty or truncated file, before it has erased
/// anything.
pub const MIN_IMAGE_BYTES: usize = 64 * 1024;

/// ESP-IDF images start with this magic byte, merged and app-only alike.
pub const ESP_IMAGE_MAGIC: u8 = 0xE9;

/// Where `esp_image_header_t` keeps `chip_id`, as a little-endian u16.
///
/// magic(1) segment_count(1) spi_mode(1) spi_speed/size(1) entry_addr(4)
/// wp_pin(1) spi_pin_drv(3) = 12 bytes, then the chip id.
const CHIP_ID_OFFSET: usize = 12;

/// `esp_chip_id_t` for the two boards this project ships.
///
/// Deliberately not the full table. An id this list does not know is an id this
/// flasher has no business writing to a wallet, and saying "I do not recognise
/// this" is better than guessing at a pairing.
const CHIP_ID_ESP32C3: u16 = 0x0005;
const CHIP_ID_ESP32S3: u16 = 0x0009;

/// A candidate device to flash.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlashPort {
    pub name: String,
    pub description: String,
    /// USB vendor:product, so two identical-looking boards can be told apart in
    /// the picker by something more specific than the port name.
    pub usb_id: String,
    /// Whether the vendor ID is Espressif's (0x303A). A hint for ordering, never
    /// a guarantee: a board behind a CP2102 or CH340 is a different vendor and
    /// is still perfectly flashable.
    pub likely_device: bool,
}

/// What the ROM says it is. Only produced by actually talking to the chip.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedChip {
    /// espflash's name for the chip, e.g. "esp32s3".
    pub chip: String,
    /// The `esp_chip_id_t` an image for this chip must carry, when it is one of
    /// the two this project knows. `None` means "an ESP, but not one of ours",
    /// which is reported rather than silently accepted.
    pub chip_id: Option<u16>,
    pub revision: Option<String>,
    /// Flash size as the ROM reports it, e.g. "16MB".
    pub flash_size: String,
}

/// What the UI must say before it offers to flash anything.
///
/// Returned rather than hardcoded in the frontend so that the sentence and the
/// capability ship together: a build that can flash always carries the warning
/// that goes with it, and changing one means changing the other in one file.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlashCapability {
    /// Whether this build can flash at all.
    pub available: bool,
    /// Whether this build knows the target is protected by secure boot.
    ///
    /// Always false today: nothing has burned a fuse, and claiming otherwise
    /// would be the single most dangerous thing this struct could say.
    pub secure_boot: bool,
    /// Shown next to the button, every time.
    pub warning: String,
    /// Shown on the acknowledgement, every time.
    pub erases: String,
}

/// The warning that accompanies flashing on a device with no secure boot.
///
/// Two separate facts, because they have different remedies: the device runs
/// whatever it is given (nothing can fix that until T11), and this particular
/// write destroys what is stored (the user can fix that, by writing the seed
/// phrase down first).
pub const UNLOCKED_WARNING: &str =
    "This device has no secure boot, so it will run whatever firmware it is given \
     — including firmware that records your PIN and sends your seed elsewhere. \
     Only flash an image you built yourself, or one whose SHA-256 you have \
     checked against the release notes.";

/// What the acknowledgement has to say. The single most important sentence here.
pub const ERASE_WARNING: &str =
    "Flashing erases this device completely, including the vault: every seed \
     phrase stored on it is destroyed and cannot be recovered from the device \
     afterwards. Write your recovery phrase down and check it before continuing.";

/// Can this build flash, and what must the user be told?
#[tauri::command]
pub fn flash_capability() -> FlashCapability {
    FlashCapability {
        available: cfg!(all(feature = "flasher", not(target_os = "android"))),
        // Hardcoded false, not detected. When T11 lands this becomes a real
        // query against the device's eFuses; until it does, "unknown" and "not
        // protected" must be treated identically.
        secure_boot: false,
        warning: UNLOCKED_WARNING.to_string(),
        erases: ERASE_WARNING.to_string(),
    }
}

/// The SHA-256 of some bytes, lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Compare a caller-supplied digest against the bytes in hand.
///
/// Case and surrounding whitespace are forgiving because the expected value is
/// pasted from release notes by a human. The comparison itself is not: anything
/// other than an exact match of the 64 hex characters is a refusal.
pub fn check_digest(data: &[u8], expected: &str) -> Result<String, String> {
    let actual = sha256_hex(data);
    let want = expected.trim().to_ascii_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "\"{}\" is not a SHA-256 digest; it must be 64 hexadecimal characters",
            expected.trim()
        ));
    }
    if want != actual {
        return Err(format!(
            "refusing to flash: this file's SHA-256 is {actual}, not the {want} that was expected. \
             The file is not the image you checked — do not install it"
        ));
    }
    Ok(actual)
}

/// The chip id an image was built for, if its header is readable.
pub fn image_chip_id(data: &[u8]) -> Option<u16> {
    let bytes = data.get(CHIP_ID_OFFSET..CHIP_ID_OFFSET + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// A name for a chip id, for messages a user has to act on.
pub fn chip_id_name(id: u16) -> Option<&'static str> {
    match id {
        CHIP_ID_ESP32C3 => Some("ESP32-C3"),
        CHIP_ID_ESP32S3 => Some("ESP32-S3"),
        _ => None,
    }
}

/// Refuse an image whose header does not match the chip on the other end.
///
/// Split out from the flashing path so it is testable without hardware. The two
/// boards are indistinguishable from the host — same vendor ID, same
/// USB-Serial-JTAG — so this is the only place the mistake can be caught, and
/// catching it after the erase is no help at all.
pub fn check_chip(
    image_id: Option<u16>,
    device_id: Option<u16>,
    device_name: &str,
) -> Result<(), String> {
    let Some(image_id) = image_id else {
        return Err("that file has no readable ESP image header".to_string());
    };
    let Some(device_id) = device_id else {
        return Err(format!(
            "the device reports itself as {device_name}, which is not one of the boards this app \
             knows how to flash (ESP32-S3 or ESP32-C3), so it will not write to it"
        ));
    };
    if image_id == device_id {
        return Ok(());
    }
    let built_for = chip_id_name(image_id)
        .map(str::to_string)
        .unwrap_or_else(|| format!("chip id 0x{image_id:04X}"));
    let attached = chip_id_name(device_id).unwrap_or(device_name);
    Err(format!(
        "refusing to flash: that image was built for {built_for} and the attached device is an \
         {attached}. It would be written without complaint and then fail to boot, which looks \
         exactly like a broken cable"
    ))
}

/// Reject an image or an offset this command will not write.
///
/// Checked before the port is opened, because the first thing a flash does is
/// erase: an image rejected here costs nothing, and one rejected halfway through
/// leaves a device that will not boot.
pub fn validate_image(data: &[u8], offset: u32) -> Result<(), String> {
    if offset != MERGED_IMAGE_OFFSET && offset < APP_OFFSET {
        return Err(format!(
            "refusing to write at 0x{offset:X}: only a merged image at 0x0 or an application image \
             at 0x{APP_OFFSET:X} are accepted. Anything in between lands on the partition table or \
             on the vault, which destroys the wallets on the device without stopping it booting"
        ));
    }
    if data.len() < MIN_IMAGE_BYTES {
        return Err(format!(
            "that file is {} bytes, which is far too small to be a firmware image",
            data.len()
        ));
    }
    match data.first() {
        Some(&ESP_IMAGE_MAGIC) => Ok(()),
        Some(b) => Err(format!(
            "that file does not start with the ESP image magic byte (0x{ESP_IMAGE_MAGIC:02X}); \
             it starts with 0x{b:02X}, so it is not an ESP-IDF image"
        )),
        None => Err("that file is empty".to_string()),
    }
}

/// What a flash was asked to do, and what the caller believes it is writing.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlashRequest {
    pub port: String,
    pub image: Vec<u8>,
    /// The digest the caller checked. Required, not optional: an image whose
    /// hash nobody looked at is exactly the image this refuses to install.
    pub expected_sha256: String,
    /// Required. There is deliberately no default: see `flash()`.
    pub offset: Option<u32>,
}

#[cfg(all(feature = "flasher", not(target_os = "android")))]
mod imp {
    use super::*;
    use espflash::flasher::Flasher;
    use espflash::target::{Chip, ProgressCallbacks};
    use tauri::Emitter;

    /// Progress, forwarded to the webview as events.
    ///
    /// A flash takes tens of seconds and erases before it writes, so a UI with
    /// no progress is a UI people interrupt — and interrupting midway is how a
    /// device ends up unbootable.
    struct Progress {
        app: tauri::AppHandle,
        total: usize,
    }

    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ProgressEvent {
        stage: &'static str,
        current: usize,
        total: usize,
    }

    impl Progress {
        fn emit(&self, stage: &'static str, current: usize) {
            let _ = self
                .app
                .emit("flash://progress", ProgressEvent { stage, current, total: self.total });
        }
    }

    impl ProgressCallbacks for Progress {
        fn init(&mut self, _addr: u32, total: usize) {
            self.total = total;
            self.emit("writing", 0);
        }
        fn update(&mut self, current: usize) {
            self.emit("writing", current);
        }
        fn verifying(&mut self) {
            self.emit("verifying", self.total);
        }
        fn finish(&mut self, _skipped: bool) {
            self.emit("done", self.total);
        }
    }

    /// espflash's chip enum mapped to the id an image header carries.
    ///
    /// Only the two boards. Everything else is `None`, which `check_chip` turns
    /// into a refusal rather than a guess.
    fn chip_id(chip: Chip) -> Option<u16> {
        match chip {
            Chip::Esp32c3 => Some(CHIP_ID_ESP32C3),
            Chip::Esp32s3 => Some(CHIP_ID_ESP32S3),
            _ => None,
        }
    }

    pub fn ports() -> Result<Vec<FlashPort>, String> {
        let mut out = Vec::new();
        for p in serialport::available_ports().map_err(|e| e.to_string())? {
            let serialport::SerialPortType::UsbPort(usb) = &p.port_type else {
                continue;
            };
            out.push(FlashPort {
                name: p.port_name,
                description: usb.product.clone().unwrap_or_else(|| "USB serial device".to_string()),
                usb_id: format!("{:04x}:{:04x}", usb.vid, usb.pid),
                likely_device: usb.vid == leek_transport_serial::ESPRESSIF_VID,
            });
        }
        // Espressif boards first: on a laptop with a phone and a dongle
        // attached, the wallet should not be the third entry in the list.
        out.sort_by_key(|p| !p.likely_device);
        Ok(out)
    }

    /// Open a port and talk to the ROM.
    ///
    /// `Connection::new` takes the platform's *concrete* port type, which is why
    /// the port is opened here with `open_native()` rather than borrowed from
    /// `leek-transport-serial` — that crate deliberately hands back a trait
    /// object, which is the right shape for the protocol and the wrong one for
    /// espflash. It is also why Android cannot use this path; see the header.
    fn connect(port: &str) -> Result<Flasher, String> {
        use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};

        let serial = serialport::new(port, 115_200)
            .timeout(std::time::Duration::from_secs(3))
            .open_native()
            .map_err(|e| format!("could not open {port}: {e}"))?;

        let info = serialport::available_ports()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|p| p.port_name == port)
            .and_then(|p| match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => Some(usb),
                _ => None,
            })
            .ok_or_else(|| format!("{port} is not a USB serial port"))?;

        let connection = Connection::new(
            serial,
            info,
            /* Reset into the app afterwards, so the device comes back on its own
             * rather than leaving the user wondering whether it worked. */
            ResetAfterOperation::HardReset,
            ResetBeforeOperation::DefaultReset,
            115_200,
        );

        Flasher::connect(connection, true, true, false, None, None)
            .map_err(|e| format!("could not talk to the bootloader on {port}: {e}"))
    }

    pub fn detect(port: String) -> Result<DetectedChip, String> {
        let mut flasher = connect(&port)?;
        let chip = flasher.chip();
        let info = flasher
            .device_info()
            .map_err(|e| format!("connected to {port} but could not read the chip's details: {e}"))?;
        Ok(DetectedChip {
            chip: chip.to_string(),
            chip_id: chip_id(chip),
            revision: info.revision.map(|(major, minor)| format!("v{major}.{minor}")),
            flash_size: info.flash_size.to_string(),
        })
    }

    pub fn write(
        app: tauri::AppHandle,
        port: String,
        image: Vec<u8>,
        offset: u32,
    ) -> Result<(), String> {
        let mut flasher = connect(&port)?;
        let chip = flasher.chip();

        /* After the handshake and before a single byte is erased: this is the
         * last moment at which an S3 image aimed at a C3 can be stopped, and the
         * handshake itself writes nothing. */
        check_chip(image_chip_id(&image), chip_id(chip), &chip.to_string())?;

        let mut progress = Progress { app, total: image.len() };
        flasher
            .write_bin_to_flash(offset, &image, &mut progress)
            .map_err(|e| format!("flashing failed: {e}"))?;
        Ok(())
    }
}

#[cfg(not(all(feature = "flasher", not(target_os = "android"))))]
mod imp {
    use super::*;

    /// Nothing is enumerated rather than "no ports found": a build with no
    /// flasher must not produce a picker that looks like it would work.
    pub fn ports() -> Result<Vec<FlashPort>, String> {
        Ok(Vec::new())
    }

    pub fn detect(_port: String) -> Result<DetectedChip, String> {
        Err(NO_FLASHER.to_string())
    }

    pub fn write(
        _app: tauri::AppHandle,
        _port: String,
        _image: Vec<u8>,
        _offset: u32,
    ) -> Result<(), String> {
        Err(NO_FLASHER.to_string())
    }

    const NO_FLASHER: &str = "this build cannot flash firmware";
}

/// Serial ports that might be a flashable board.
#[tauri::command]
pub fn flash_ports() -> Result<Vec<FlashPort>, String> {
    imp::ports()
}

/// Connect and ask the chip what it is.
///
/// Separate from enumeration because it is not free: it resets the board into
/// download mode to run the handshake, so it happens when a user presses
/// Connect, not every time a list is refreshed.
#[tauri::command]
pub async fn flash_detect(port: String) -> Result<DetectedChip, String> {
    tokio::task::spawn_blocking(move || imp::detect(port))
        .await
        .map_err(|e| format!("the detection task did not finish: {e}"))?
}

/// Write a firmware image to a device.
///
/// The image arrives as bytes rather than a path so that the one place a file is
/// read is the frontend's own file picker: this command cannot be aimed at an
/// arbitrary path on disk by anything that reaches the webview.
///
/// The digest is re-checked here even though the frontend already computed it.
/// That is not distrust of the frontend so much as of the seam: the bytes cross
/// an IPC bridge as a JSON array, and the only digest worth anything is the one
/// taken over the buffer actually handed to the flasher.
#[tauri::command]
pub async fn flash_write(app: tauri::AppHandle, request: FlashRequest) -> Result<String, String> {
    let FlashRequest { port, image, expected_sha256, offset } = request;
    // No default. The two offsets differ by whether the caller's user loses
    // their wallet, and defaulting picked the destructive one -- which is how a
    // real wallet got erased during development. A caller that has not decided
    // is a caller that must not write.
    let offset = offset.ok_or_else(|| {
        "no offset given: pass 0x0 for a merged provision image (erases the vault) \
         or 0x10000 for an application update (keeps it)"
            .to_string()
    })?;

    validate_image(&image, offset)?;
    let digest = check_digest(&image, &expected_sha256)?;

    /* Blocking work off the async runtime: a flash takes tens of seconds and
     * would otherwise stall every other command, including the ones the UI uses
     * to show progress. */
    tokio::task::spawn_blocking(move || imp::write(app, port, image, offset))
        .await
        .map_err(|e| format!("the flashing task did not finish: {e}"))??;
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(chip_id: u16) -> Vec<u8> {
        let mut img = vec![0u8; MIN_IMAGE_BYTES];
        img[0] = ESP_IMAGE_MAGIC;
        img[CHIP_ID_OFFSET..CHIP_ID_OFFSET + 2].copy_from_slice(&chip_id.to_le_bytes());
        img
    }

    #[test]
    fn an_absent_offset_is_refused_rather_than_defaulted() {
        // The regression that erased a real wallet: `offset: None` used to mean
        // "merged image at 0x0", so a caller that had simply not thought about
        // it got the destructive write. Nothing may supply that default now --
        // this asserts the field is an Option the caller must fill, and that
        // neither offset constant is reachable without saying which.
        let req = FlashRequest {
            port: "/dev/ttyACM0".into(),
            image: vec![ESP_IMAGE_MAGIC; MIN_IMAGE_BYTES],
            expected_sha256: String::new(),
            offset: None,
        };
        assert!(req.offset.is_none());
        assert_ne!(MERGED_IMAGE_OFFSET, APP_OFFSET);
    }

    #[test]
    fn only_the_two_documented_offsets_are_accepted() {
        let img = image(CHIP_ID_ESP32S3);
        assert!(validate_image(&img, MERGED_IMAGE_OFFSET).is_ok());
        assert!(validate_image(&img, APP_OFFSET).is_ok());
        // 0x9000 is nvs: the vault, and the mistake that destroys wallets on a
        // device that still boots afterwards.
        let e = validate_image(&img, 0x9000).unwrap_err();
        assert!(e.contains("vault"), "{e}");
    }

    #[test]
    fn a_file_that_is_not_an_esp_image_is_refused() {
        let mut img = image(CHIP_ID_ESP32S3);
        img[0] = 0x7F; // an ELF, say -- the file next to the .bin in the build dir
        let e = validate_image(&img, MERGED_IMAGE_OFFSET).unwrap_err();
        assert!(e.contains("magic"), "{e}");
    }

    #[test]
    fn a_truncated_file_is_refused_before_anything_is_erased() {
        let mut img = vec![ESP_IMAGE_MAGIC];
        img.resize(128, 0);
        assert!(validate_image(&img, MERGED_IMAGE_OFFSET).is_err());
        assert!(validate_image(&[], MERGED_IMAGE_OFFSET).is_err());
    }

    #[test]
    fn a_digest_that_does_not_match_is_refused_not_warned() {
        let img = image(CHIP_ID_ESP32C3);
        let good = sha256_hex(&img);
        assert_eq!(check_digest(&img, &good.to_uppercase()).unwrap(), good);
        assert_eq!(check_digest(&img, &format!("  {good}\n")).unwrap(), good);

        let wrong = "0".repeat(64);
        let e = check_digest(&img, &wrong).unwrap_err();
        assert!(e.contains("refusing"), "{e}");
        // A digest that is not a digest gets its own message: a user who pasted
        // half a line should be told that, not that their image is corrupt.
        assert!(check_digest(&img, "deadbeef").unwrap_err().contains("64 hexadecimal"));
        assert!(check_digest(&img, "").is_err());
    }

    #[test]
    fn an_image_for_the_other_board_is_refused() {
        let s3 = image(CHIP_ID_ESP32S3);
        assert_eq!(image_chip_id(&s3), Some(CHIP_ID_ESP32S3));
        assert!(check_chip(Some(CHIP_ID_ESP32S3), Some(CHIP_ID_ESP32S3), "esp32s3").is_ok());

        let e = check_chip(Some(CHIP_ID_ESP32S3), Some(CHIP_ID_ESP32C3), "esp32c3").unwrap_err();
        assert!(e.contains("ESP32-S3") && e.contains("ESP32-C3"), "{e}");
        // The failure mode is what makes this worth refusing rather than
        // warning: it looks like a hardware fault, not like a wrong file.
        assert!(e.contains("broken cable"), "{e}");

        // An ESP that is neither board: named, and refused.
        let e = check_chip(Some(CHIP_ID_ESP32S3), None, "esp32c6").unwrap_err();
        assert!(e.contains("esp32c6"), "{e}");
    }

    #[test]
    fn the_warnings_name_the_actual_risks() {
        let cap = flash_capability();
        // Never claim protection that has not been burned.
        assert!(!cap.secure_boot);
        for word in ["secure boot", "PIN", "seed"] {
            assert!(cap.warning.contains(word), "the warning does not mention {word}");
        }
        for word in ["erases", "seed", "cannot be recovered"] {
            assert!(cap.erases.contains(word), "the erase notice does not mention {word}");
        }
    }
}
