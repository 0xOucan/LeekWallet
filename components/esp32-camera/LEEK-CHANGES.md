# Local changes to the vendored esp32-camera

Upstream is https://github.com/espressif/esp32-camera at
`3fb41a99d61a853313d1cd5543ebf2c109ef7c0e` (2026-09-14). Everything here is
that tree, minus `examples/` and `test/`, with the two edits below. Both are
marked in the files with a `LEEK:` comment so they survive the next update.

## 1. `esp_jpeg` moved out of the manifest

`idf_component.yml` declared `esp_jpeg` as a managed dependency. Leaving it
there makes the IDF component manager resolve it at configure time and write
the result into `dependencies.lock` — as an absolute path on the machine that
built it, once `esp_jpeg` is also vendored. That file is committed, so the
build stops being reproducible anywhere but this laptop, which is the exact
property `CONFIG_APP_REPRODUCIBLE_BUILD` exists to protect.

`esp_jpeg` is instead vendored as an ordinary component in `components/` and
named in `REQUIRES`, which is how every other component in this repository is
resolved: no manifest, no lock file, no network.

## 2. `examples/` and `test/` were not taken

They pull in a camera web server, Unity and test images, none of which is
built here.

## Why esp_jpeg at all

Nothing in this firmware decodes JPEG — the sensor is configured for
`PIXFORMAT_GRAYSCALE`. But `esp_camera.h` includes `img_converters.h`, which
includes `jpeg_decoder.h`, so the header is needed to compile against the
driver's public API at all. Deleting the include instead would be a deeper
change to upstream for no gain: the JPEG code that is actually reached is none.
