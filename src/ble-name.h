/**
 * The advertised BLE device name (ROADMAP T56).
 *
 * "LeekWallet" broadcast to everyone within range announces to a room that
 * somebody in it is carrying a hardware wallet. Ledger lets the owner rename
 * the device for exactly this reason, and a name is the one field of the
 * advertisement a user can actually choose.
 *
 * Free of NimBLE on purpose, like ble-chunk.c: the bound below is the whole
 * point of the feature and it has to be testable on the host. src/ble.c does
 * nothing but read the result of ble_name_get() and hand it to the radio.
 *
 * THE BOUND IS NOT COSMETIC. A legacy advertisement carries 31 bytes. The
 * device already spends 3 on flags and 18 on the complete 128-bit service UUID,
 * which is why the name lives in the scan response instead — and the scan
 * response is 31 bytes too. Overflow it and ble_gap_adv_rsp_set_fields()
 * rejects the whole thing with BLE_HS_EMSGSIZE, advertising never starts, and
 * the device sits there looking powered and idle with one log line nobody on
 * battery will ever read. That already happened once, before the name was
 * moved out of the advertisement; letting a user type their way back into it
 * would be the same failure with a nicer origin story.
 *
 * So a name that does not fit is REFUSED, not truncated. Truncation would
 * quietly advertise a different device than the one the user named, and the
 * user is the only one who could notice.
 */

#ifndef LEEK_BLE_NAME_H
#define LEEK_BLE_NAME_H

#include <stdbool.h>
#include <stddef.h>

/** The name shipped on a device nobody has renamed. */
#define BLE_NAME_DEFAULT "LeekWallet"

/**
 * Longest name that still fits a legacy scan response.
 *
 * 31 bytes total, minus the 2-byte AD header (length + type) that wraps the
 * name. This is the runtime twin of the _Static_assert in ble.c, which bounds
 * the compile-time default the same way.
 */
#define BLE_NAME_MAX_LEN 29

/** Whether `name` may be advertised: 1..BLE_NAME_MAX_LEN printable ASCII. */
bool ble_name_is_valid(const char *name);

/**
 * The name to advertise. Never NULL, never empty, never over the bound —
 * a caller can hand the result straight to the radio.
 */
const char *ble_name_get(void);

/**
 * Rename the device and persist it. Returns false and changes nothing if the
 * name would not fit or is not printable ASCII.
 */
bool ble_name_set(const char *name);

/** Back to BLE_NAME_DEFAULT, persisted. */
void ble_name_reset(void);

/** Drop the cached copy, so the next read comes from storage. For tests. */
void ble_name_forget(void);

#endif /* LEEK_BLE_NAME_H */
