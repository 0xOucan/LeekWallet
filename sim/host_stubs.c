/* Minimal host stubs so firmware sources link natively.
 * NOT for production: random32() here is deterministic on purpose so tests repeat. */
#include <stdint.h>
static uint32_t s = 0x1234abcd;
uint32_t random32(void) { s = s * 1664525u + 1013904223u; return s; }
