/**
 * Deliberately empty. The RNG bridge lives in `src/rand_esp32.c`.
 *
 * This file used to define `random32()` and `random_buffer()` against
 * `esp_random()` / `esp_fill_random()` directly. Both symbols are also defined
 * in `src/rand_esp32.c`, and only that copy runs the entropy health check,
 * enables the bootloader RNG when RF is down, folds in the user pool, and
 * aborts rather than returning material that failed its own tests.
 *
 * Nothing was wrong with the firmware that shipped: the linker resolved
 * `random_buffer` to `src/rand_esp32.c:41`, confirmed with addr2line against
 * the built ELF. It resolved that way for a reason nobody chose, though --
 * objects belonging to the main application are searched before archive
 * members, and this file is compiled into the trezor-crypto archive. Change
 * the build layout, move a file between the app and a component, or link the
 * archive differently, and the other definition wins silently. There is no
 * duplicate-symbol error to catch it, no warning, and no runtime symptom: seeds
 * would simply be generated from an unchecked source, exactly the failure
 * mnemonic_generate() has no way to notice.
 *
 * A second definition of the one function that decides whether a seed is worth
 * anything is not a thing to leave lying next to the first. `scripts/check.sh`
 * now fails if a second one appears.
 */
