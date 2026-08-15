//! Firmware flashing over USB (T65).
//!
//! `espflash` as a library rather than a bundled CLI: the esptool protocol runs
//! in this process, so there is no Python to ship, no binary to sign separately,
//! and no shelling out to something a user could have shadowed on their PATH.
//!
//! # What this is, honestly
//!
//! **A flasher is a way to install firmware, and firmware is what holds the
//! keys.** On a device without secure boot, anything written here runs with full
//! access to the vault and the PIN entry screen. That hole is not opened by this
//! module — the ESP32-S3's USB-Serial-JTAG can be commanded into ROM download
//! mode by any host, so `esptool` has always been able to do this — but a button
//! in the wallet app turns "possible for someone who knows esptool" into "one
//! click", and that difference is worth being deliberate about.
//!
//! What makes it safe is secure boot (T11): once burned, the bootloader only
//! runs images signed by the vendor key, so a flasher can install *this
//! project's* releases and nothing else. Until then the UI must say plainly that
//! the device will run whatever it is given. `flash_capability()` exists so the
//! frontend cannot forget to ask.
//!
//! # Deliberate limits
//!
//! * **Desktop only.** Android needs the USB Host API and a different serial
//!   backend; `transport-serial` already makes that split for the protocol and
//!   the flasher will follow the same shape, but not in this first pass.
//! * **No eFuse burning.** Burning is irreversible and ends the board's ability
//!   to run anything else; it does not belong behind the same button as an
//!   ordinary update. See docs/BURN-PROCEDURE.md.
//! * **App partition only, by default.** `DEFAULT_APP_OFFSET` is where a
//!   firmware image goes on this layout. Writing at a lower offset would land on
//!   `nvs`, which is the vault — the one mistake here that destroys wallets
//!   rather than merely bricking a boot.
//! * **Nothing is fetched.** The image is read from a path the user chose. This
//!   module does not download, and does not decide what is authentic; that is
//!   the release-verification story and it is not built yet.

use serde::Serialize;

/// Where the application image lives on this project's partition layout.
///
/// `partitions.csv`: nvs at 0x9000, phy_init at 0xf000, app at 0x10000. The
/// secure layout moves the app to 0x20000 because a signed bootloader and a
/// signed partition table push everything out — see partitions-secure.csv,
/// which documents how getting this wrong wrote a signature over the first 4 KB
/// of a vault.
pub const DEFAULT_APP_OFFSET: u32 = 0x10000;

/// The lowest offset this command will write to.
///
/// Everything below the app partition is the vault and the partition table. A
/// flasher that will write anywhere is a flasher that can silently destroy
/// wallets on a typo, so the floor is enforced here rather than trusted to the
/// caller.
pub const MIN_WRITE_OFFSET: u32 = DEFAULT_APP_OFFSET;

/// A plausible firmware image is at least this big.
///
/// The real one is over a megabyte. This only rejects the obvious mistake of
/// pointing the flasher at an empty or truncated file, before it has erased
/// anything.
pub const MIN_IMAGE_BYTES: usize = 64 * 1024;

/// ESP-IDF application images start with this magic byte.
pub const ESP_IMAGE_MAGIC: u8 = 0xE9;

/// A candidate device to flash.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlashPort {
    pub name: String,
    pub description: String,
    /// Whether the USB vendor ID is Espressif's. A hint for ordering, never a
    /// guarantee: a board behind a CP2102 or CH340 is a different vendor and is
    /// still perfectly flashable.
    pub likely_device: bool,
}

/// What the UI must say before it offers to flash anything.
///
/// Returned rather than hardcoded in the frontend so that the sentence and the
/// capability ship together: a build that can flash always has the warning to
/// go with it, and changing one means changing the other in the same file.
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
}

/// The warning that accompanies flashing on an unlocked device.
pub const UNLOCKED_WARNING: &str =
    "This device has no secure boot, so it will run whatever firmware it is given \
     — including firmware that records your PIN and sends your seed elsewhere. \
     Only flash an image you built yourself or one whose signature you have \
     checked. Flashing does not erase the vault, but the firmware you install \
     has full access to it.";

/// Can this build flash, and what must the user be told?
#[tauri::command]
pub fn flash_capability() -> FlashCapability {
    FlashCapability {
        available: cfg!(all(feature = "flasher", not(target_os = "android"))),
        // Hardcoded false, not detected. When T11 lands this becomes a real
        // query against the device's eFuses, and until it does, "unknown" and
        // "not protected" must be treated identically.
        secure_boot: false,
        warning: UNLOCKED_WARNING.to_string(),
    }
}

/// Reject an image this command will not write.
///
/// Checked before the port is opened, because the first thing a flash does is
/// erase: an image rejected here costs nothing, and one rejected halfway
/// through leaves a device that will not boot.
pub fn validate_image(data: &[u8], offset: u32) -> Result<(), String> {
    if offset < MIN_WRITE_OFFSET {
        return Err(format!(
            "refusing to write at 0x{offset:X}: everything below 0x{MIN_WRITE_OFFSET:X} is the \
             partition table and the vault, and overwriting it destroys the wallets on this device"
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
             it starts with 0x{b:02X}, so it is not an ESP-IDF application image"
        )),
        None => Err("that file is empty".to_string()),
    }
}

#[cfg(all(feature = "flasher", not(target_os = "android")))]
mod imp {
    use super::*;
    use espflash::flasher::Flasher;
    use espflash::target::ProgressCallbacks;
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
            let _ = self.app.emit(
                "flash://progress",
                ProgressEvent { stage, current, total: self.total },
            );
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

    pub fn ports() -> Result<Vec<FlashPort>, String> {
        let mut out = Vec::new();
        for p in serialport::available_ports().map_err(|e| e.to_string())? {
            let serialport::SerialPortType::UsbPort(usb) = &p.port_type else {
                continue;
            };
            out.push(FlashPort {
                name: p.port_name,
                description: usb
                    .product
                    .clone()
                    .unwrap_or_else(|| format!("{:04x}:{:04x}", usb.vid, usb.pid)),
                likely_device: usb.vid == leek_transport_serial::ESPRESSIF_VID,
            });
        }
        out.sort_by_key(|p| !p.likely_device);
        Ok(out)
    }

    pub fn write(app: tauri::AppHandle, port: String, image: Vec<u8>, offset: u32) -> Result<(), String> {
        use espflash::connection::{Connection, ResetAfterOperation, ResetBeforeOperation};

        let serial = serialport::new(&port, 115_200)
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
            /* Reset into the app after flashing, so the device comes back on its
             * own rather than leaving the user wondering whether it worked. */
            ResetAfterOperation::HardReset,
            ResetBeforeOperation::DefaultReset,
            115_200,
        );

        let mut flasher = Flasher::connect(connection, true, true, false, None, None)
            .map_err(|e| format!("could not talk to the bootloader on {port}: {e}"))?;

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

    pub fn ports() -> Result<Vec<FlashPort>, String> {
        Ok(Vec::new())
    }

    pub fn write(_app: tauri::AppHandle, _port: String, _image: Vec<u8>, _offset: u32) -> Result<(), String> {
        Err("this build cannot flash firmware".to_string())
    }
}

/// Serial ports that might be a flashable board.
#[tauri::command]
pub fn flash_ports() -> Result<Vec<FlashPort>, String> {
    imp::ports()
}

/// Write a firmware image to a device.
///
/// The image arrives as bytes rather than a path so that the one place a file
/// is read is the frontend's own file dialog: this command cannot be pointed at
/// an arbitrary path on disk by anything that can reach the webview.
#[tauri::command]
pub async fn flash_write(
    app: tauri::AppHandle,
    port: String,
    image: Vec<u8>,
    offset: Option<u32>,
) -> Result<(), String> {
    let offset = offset.unwrap_or(DEFAULT_APP_OFFSET);
    validate_image(&image, offset)?;

    /* Blocking work off the async runtime: a flash takes tens of seconds and
     * would otherwise stall every other command, including the ones the UI uses
     * to show progress. */
    tokio::task::spawn_blocking(move || imp::write(app, port, image, offset))
        .await
        .map_err(|e| format!("the flashing task did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_below_the_app_partition_is_refused() {
        let img = vec![ESP_IMAGE_MAGIC; MIN_IMAGE_BYTES];
        // 0x9000 is nvs: the vault. This is the mistake that destroys wallets.
        let e = validate_image(&img, 0x9000).unwrap_err();
        assert!(e.contains("vault"), "{e}");
        assert!(validate_image(&img, DEFAULT_APP_OFFSET).is_ok());
    }

    #[test]
    fn a_file_that_is_not_an_esp_image_is_refused() {
        let mut img = vec![0u8; MIN_IMAGE_BYTES];
        img[0] = 0x7F; // an ELF, say -- the file next to the .bin in the build dir
        let e = validate_image(&img, DEFAULT_APP_OFFSET).unwrap_err();
        assert!(e.contains("magic"), "{e}");
    }

    #[test]
    fn a_truncated_file_is_refused_before_anything_is_erased() {
        let img = vec![ESP_IMAGE_MAGIC; 128];
        assert!(validate_image(&img, DEFAULT_APP_OFFSET).is_err());
        assert!(validate_image(&[], DEFAULT_APP_OFFSET).is_err());
    }

    #[test]
    fn the_warning_names_the_actual_risk() {
        let cap = flash_capability();
        // Never claim protection that has not been burned.
        assert!(!cap.secure_boot);
        for word in ["secure boot", "PIN", "seed"] {
            assert!(cap.warning.contains(word), "warning does not mention {word}");
        }
    }
}
