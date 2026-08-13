//! The GATT identifiers the firmware is built to. Fixed; not configurable.
//!
//! These live outside both backend modules because there are now two of them —
//! btleplug on desktop, `tauri-plugin-blec` on Android — and a UUID that
//! differed between the two would produce a build that scans forever on one
//! platform and works on the other, with nothing to point at.

use uuid::{uuid, Uuid};

/// What a LeekWallet advertises, and the only thing a scan matches on.
pub const SERVICE_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000001");
/// host → device
pub const CHAR_WRITE_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000002");
/// device → host
pub const CHAR_NOTIFY_UUID: Uuid = uuid!("6c65656b-7761-6c6c-6574-000000000003");
