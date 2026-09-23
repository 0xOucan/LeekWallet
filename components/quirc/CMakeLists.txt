# quirc, vendored. See THIRD-PARTY-LICENSES.md for the revision and the
# licence; only lib/ is taken, because the demo and test programs upstream pull
# in SDL and a camera API this project has no use for.
#
# The default QUIRC_MAX_REGIONS of 254 is kept, which makes quirc_pixel_t a
# uint8_t and the pixel plane one byte per pixel rather than two. At QVGA that
# is the difference between 154 KB and 231 KB of PSRAM.
idf_component_register(
    SRCS lib/quirc.c lib/identify.c lib/decode.c lib/version_db.c
    INCLUDE_DIRS lib
)

# Built for speed whatever the project's optimisation level. The firmware is
# built -Og for debugging, and quirc at -Og identified a VGA frame several
# times slower than at -O2; nothing in here is worth stepping through.
# Single-precision maths, because the ESP32-S3 FPU has no double precision
# and every double operation in the perspective code was a software call.
target_compile_options(${COMPONENT_LIB} PRIVATE -O2)
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    QUIRC_FLOAT_TYPE=float QUIRC_USE_TGMATH)
