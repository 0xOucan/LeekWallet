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

/**
 * Take both links down, and put back the one that was up.
 *
 * For the moments when the device should be talking to nothing: seed
 * generation, above all. Three reasons, and only the first is obvious.
 *
 * A host cannot observe or influence a seed it cannot reach. That is the
 * obvious one, and on its own it would be worth doing.
 *
 * The entropy gate is the second. `bootloader_random_enable()` is not
 * reference-counted by ESP-IDF, and the protocol task exists whether or not a
 * link is selected, so two tasks calling into the gate can have one's
 * `disable()` land inside the other's read -- which yields documented
 * pseudo-random bytes that pass the health check. With no link serving
 * requests, nothing else is drawing while the seed is born.
 *
 * The third is that BLE up means the radio is up, so the gate uses the RF
 * source; BLE down means it uses the SAR ADC. Espressif documents both as true
 * sources, but a seed generated with the radio off is generated the same way
 * every time, on every device, which is one less thing that varies between two
 * wallets that ought to be equally strong.
 *
 * Suspending twice is a no-op, and so is resuming when nothing was suspended:
 * the resume is called from the main menu, which is reached by every path out
 * of seed creation including cancelling and failing.
 */
void transport_suspend(void);
void transport_resume(void);

#endif /* LEEK_TRANSPORT_H */
