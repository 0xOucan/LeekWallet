/**
 * The on-device decode-rate benchmark.
 *
 * research/qr-spike measured quirc on a host and modelled the device, because
 * no emulator on this project has an image sensor and QEMU's wall-clock times
 * are TCG artefacts. This is the other half: the same pipeline the Scan screen
 * uses, run flat out on the board, printing sustained frames/second and
 * decodes/second over the serial log.
 *
 * Compiled only under LEEK_QR_BENCH, and that flag is an environment of its
 * own (`pio run -e esp32s3cam-bench`) rather than a menu entry, because it
 * takes the camera for itself and never gives it back. A build carrying it is
 * an instrument, not firmware anyone should be holding seeds on.
 */

#ifndef LEEK_QR_BENCH_H
#define LEEK_QR_BENCH_H

#ifndef LEEK_QR_BENCH
#  define LEEK_QR_BENCH 0
#endif

#if LEEK_QR_BENCH
/** Spawn the bench task. Never returns the camera; call it and nothing else. */
void qr_bench_start(void);
#endif

#endif /* LEEK_QR_BENCH_H */
