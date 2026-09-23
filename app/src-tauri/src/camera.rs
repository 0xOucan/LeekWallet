//! Webcam exposure for reading the device's OLED, set on the camera itself.
//!
//! A webcam exposing for the room turns the device's QR into a glowing blob:
//! the lit OLED pixels bloom over the dark modules. The device's own camera
//! fixes the same problem by biasing exposure down (e-5), and the equivalent
//! here is a short manual exposure. WebKitGTK exposes no exposure control
//! through MediaStreamTrack constraints, so on Linux it goes straight to the
//! V4L2 driver - the same controls `v4l2-ctl` sets - and is put back to
//! automatic when the scan ends.
//!
//! The exposure is a time, not a fraction of the range: 12.8 ms, two full
//! refreshes of the device's panel while it shows a QR (about 156 Hz). An
//! OLED lights one row at a time, and an exposure shorter than a refresh
//! records the rows not lit in that window as dark bands across the code.
//! Clamped to the camera's own reported range.

#[cfg(target_os = "linux")]
mod v4l2 {
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;

    // <linux/videodev2.h>
    const VIDIOC_QUERYCTRL: libc::c_ulong = 0xC044_5624;
    const VIDIOC_S_CTRL: libc::c_ulong = 0xC008_561C;
    const V4L2_CID_EXPOSURE_AUTO: u32 = 0x009A_0901;
    const V4L2_CID_EXPOSURE_ABSOLUTE: u32 = 0x009A_0902;
    const V4L2_CID_EXPOSURE_AUTO_PRIORITY: u32 = 0x009A_0903;
    const V4L2_EXPOSURE_MANUAL: i32 = 1;
    const V4L2_EXPOSURE_APERTURE_PRIORITY: i32 = 3;

    #[repr(C)]
    struct QueryCtrl {
        id: u32,
        kind: u32,
        name: [u8; 32],
        minimum: i32,
        maximum: i32,
        step: i32,
        default_value: i32,
        flags: u32,
        reserved: [u32; 2],
    }

    #[repr(C)]
    struct Control {
        id: u32,
        value: i32,
    }

    fn query(fd: i32, id: u32) -> Option<(i32, i32, i32)> {
        let mut q = QueryCtrl {
            id,
            kind: 0,
            name: [0; 32],
            minimum: 0,
            maximum: 0,
            step: 0,
            default_value: 0,
            flags: 0,
            reserved: [0; 2],
        };
        // SAFETY: q is a correctly laid out v4l2_queryctrl the kernel fills.
        let rc = unsafe { libc::ioctl(fd, VIDIOC_QUERYCTRL as _, &mut q) };
        (rc == 0).then_some((q.minimum, q.maximum, q.step.max(1)))
    }

    fn set(fd: i32, id: u32, value: i32) -> bool {
        let mut c = Control { id, value };
        // SAFETY: c is a correctly laid out v4l2_control.
        unsafe { libc::ioctl(fd, VIDIOC_S_CTRL as _, &mut c) == 0 }
    }

    /// Manual exposure of `units` (UVC's 100 us steps), clamped to each
    /// camera's range. None puts every camera back on automatic exposure.
    pub fn apply(units: Option<i32>) -> String {
        let mut done = Vec::new();
        let Ok(dir) = std::fs::read_dir("/dev") else {
            return "no /dev".into();
        };
        let mut nodes: Vec<_> = dir
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("video"))
            })
            .collect();
        nodes.sort();
        for path in nodes {
            let Ok(file) = OpenOptions::new().read(true).write(true).open(&path) else {
                continue;
            };
            let fd = file.as_raw_fd();
            let Some((min, max, step)) = query(fd, V4L2_CID_EXPOSURE_ABSOLUTE) else {
                continue; // a metadata node, or a camera with no exposure control
            };
            let name = path.display().to_string();
            match units {
                Some(u) => {
                    let value = min + ((u.clamp(min, max) - min) / step) * step;
                    // Frame rate may not stretch to fit a longer exposure.
                    let _ = set(fd, V4L2_CID_EXPOSURE_AUTO_PRIORITY, 0);
                    if set(fd, V4L2_CID_EXPOSURE_AUTO, V4L2_EXPOSURE_MANUAL)
                        && set(fd, V4L2_CID_EXPOSURE_ABSOLUTE, value)
                    {
                        done.push(format!("{name} exposure {value} ({min}..{max})"));
                    }
                }
                None => {
                    if set(fd, V4L2_CID_EXPOSURE_AUTO, V4L2_EXPOSURE_APERTURE_PRIORITY) {
                        done.push(format!("{name} exposure auto"));
                    }
                }
            }
        }
        if done.is_empty() {
            "no webcam took an exposure setting".into()
        } else {
            done.join(", ")
        }
    }
}

/// Darken (`dark`) or restore every webcam's exposure. Returns what was
/// actually set, for the scanner's status line.
#[tauri::command]
pub fn camera_exposure(dark: bool) -> String {
    #[cfg(target_os = "linux")]
    {
        // 12.8 ms: two panel refreshes, so no dark bands, and still short
        // enough that the white modules do not bloom. The desktop
        // counterpart of the device's e-5.
        v4l2::apply(dark.then_some(128))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dark;
        "not needed here: this platform's webview takes the constraints".into()
    }
}
