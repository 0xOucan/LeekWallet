/**
 * One transport at a time — ROADMAP T57, docs/PROTOCOL.md 3b.
 *
 * The device exposes USB *or* BLE, never both, chosen on the device and
 * defaulting to USB. This is a constraint the rest of the firmware already
 * assumes rather than a preference:
 *
 *   - session.c holds ONE session and one pair of nonce counters. Two peers
 *     would advance the same counters and corrupt each other's traffic.
 *   - The framing carries no request IDs, so a reply belongs to whichever
 *     request arrived last. Two channels means two "last"s.
 *   - A device advertising over BLE while plugged into USB is reachable by
 *     someone the user cannot see. Off, not merely unpaired.
 *
 * Switching tears down any session: a passkey confirmed on one channel does not
 * authorise the other, and there is no state worth carrying across.
 */

#ifndef LEEK_TRANSPORT_H
#define LEEK_TRANSPORT_H

#include <stdbool.h>

typedef enum {
    TRANSPORT_USB = 0,   /* the default, and what an unset device boots into */
    TRANSPORT_BLE = 1,
} TransportKind;

/** Load the stored choice and apply it. Call once, after NVS is up. */
void transport_init(void);

TransportKind transport_get(void);

/** "USB" or "BLE", for the settings screen. */
const char *transport_label(TransportKind kind);

/**
 * Select a transport: tears down the session, silences the other channel,
 * brings this one up, and persists the choice. Returns false if the requested
 * transport could not be started, in which case USB is left selected — a
 * device that is reachable on nothing is worse than one on the cable.
 */
bool transport_set(TransportKind kind);

/** Convenience for the settings screen's single button. */
bool transport_toggle(void);

#endif /* LEEK_TRANSPORT_H */
