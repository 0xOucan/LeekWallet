#ifndef __FIREFLY_DISPLAY_H__
#define __FIREFLY_DISPLAY_H__

#ifdef __cplusplus
extern "C" {
#endif /* __cplusplus */


#include <stdint.h>

#include <driver/spi_master.h>
#include <soc/spi_pins.h>

//#define DEBUG_SHOW_FPS  (1)


#define _ENCODE_SPI_OFFSET(val,offset,width) (((val) & ((1 << (width)) - 1)) << (offset))

// Macro to encode the specifics of a SPI bus
#define _ENCODE_SPI_BUS(host,cs0,sclk,miso,mosi) (\
  _ENCODE_SPI_OFFSET(host,20,6) | _ENCODE_SPI_OFFSET(cs0,15,6) | \
  _ENCODE_SPI_OFFSET(sclk,10,6) | _ENCODE_SPI_OFFSET(miso,5,6) | \
  _ENCODE_SPI_OFFSET(mosi,0,6))

#define _DECODE_SPI_OFFSET(bus,offset,width)  (((bus) >> (offset)) & ((1 << (width)) - 1))

// Macros used to extract specific components of a SPI bus.
// Generally not used by developers.
#define _DECODE_SPI_BUS_HOST(bus)    (_DECODE_SPI_OFFSET(bus,20,6))
#define _DECODE_SPI_BUS_CS0(bus)     (_DECODE_SPI_OFFSET(bus,15,6))
#define _DECODE_SPI_BUS_SCLK(bus)    (_DECODE_SPI_OFFSET(bus,10,6))
#define _DECODE_SPI_BUS_MISO(bus)    (_DECODE_SPI_OFFSET(bus,5,6))
#define _DECODE_SPI_BUS_MOSI(bus)    (_DECODE_SPI_OFFSET(bus,0,6))


/**
 *  SPI Bus Options
 *
 *  The `_nocs` variants should be used when the CS0 pin of the
 *  display is tied to ground.
 *
 *  These are specified as the default pin configurations based
 *  on `soc/spi_pins.h`. If using a custom pin configuration (via
 *  to iomux) or using an otherwise unsupported chip, use the
 *  _ENCODE_SPI_BUS macro to configure a custom bus.
 *
 *  Target Notes:
 *   - ESP32
 *     - SPI2=HSPI, SPI3=VSPI
 *     - Only the first device attached to the bus can use the CS0 pin
 *   - ESP32-S2
 *     - SPI2=FSPI
 */
typedef enum FfxDisplaySpiBus {

// These devices support SPI2
#if (CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2 || \
  CONFIG_IDF_TARGET_ESP32S2 || CONFIG_IDF_TARGET_ESP32S3 || \
  CONFIG_IDF_TARGET_ESP32C2 || CONFIG_IDF_TARGET_ESP32C3 || \
  CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32H2 || \
  CONFIG_IDF_TARGET_ESP32P4)

    FfxDisplaySpiBus2 = _ENCODE_SPI_BUS(
        SPI2_HOST,
        SPI2_IOMUX_PIN_NUM_CS,
        SPI2_IOMUX_PIN_NUM_CLK,
        SPI2_IOMUX_PIN_NUM_MISO,
        SPI2_IOMUX_PIN_NUM_MOSI
    ),
    FfxDisplaySpiBus2_nocs = _ENCODE_SPI_BUS(
        SPI2_HOST,
        0,
        SPI2_IOMUX_PIN_NUM_CLK,
        SPI2_IOMUX_PIN_NUM_MISO,
        SPI2_IOMUX_PIN_NUM_MOSI
    ),

#endif

// These device support octal SPI alternate SPI2 pins
#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32P4

    FfxDisplaySpiBus2oct = _ENCODE_SPI_BUS(
        SPI2_HOST,
        SPI2_IOMUX_PIN_NUM_CS_OCT,
        SPI2_IOMUX_PIN_NUM_CLK_OCT,
        SPI2_IOMUX_PIN_NUM_MISO_OCT,
        SPI2_IOMUX_PIN_NUM_MOSI_OCT
    ),
    FfxDisplaySpiBus2oct_nocs = _ENCODE_SPI_BUS(
        SPI2_HOST,
        SPI2_IOMUX_PIN_NUM_CS_OCT,
        SPI2_IOMUX_PIN_NUM_CLK_OCT,
        SPI2_IOMUX_PIN_NUM_MISO_OCT,
        SPI2_IOMUX_PIN_NUM_MOSI_OCT
    ),

#endif

// These devices support SPI3
#if CONFIG_IDF_TARGET_ESP32

    FfxDisplaySpiBus3 = _ENCODE_SPI_BUS(
        SPI3_HOST,
        SPI3_IOMUX_PIN_NUM_CS,
        SPI3_IOMUX_PIN_NUM_CLK,
        SPI3_IOMUX_PIN_NUM_MISO,
        SPI3_IOMUX_PIN_NUM_MOSI
    ),
    FfxDisplaySpiBus3_nocs = _ENCODE_SPI_BUS(
        SPI3_HOST,
        0,
        SPI3_IOMUX_PIN_NUM_CLK,
        SPI3_IOMUX_PIN_NUM_MISO,
        SPI3_IOMUX_PIN_NUM_MOSI
    ),

#endif

} FfxDisplaySpiBus;


/**
 *  The side of the display the ribbon is protruding from, used
 *  to specify display rotation.
 */
typedef enum FfxDisplayRotation {
    FfxDisplayRotationRibbonBottom,
    FfxDisplayRotationRibbonRight
} FfxDisplayRotation;

/**
 *  The Fragment dimensions.
 */
extern const uint8_t FfxDisplayFragmentHeight;
extern const uint8_t FfxDisplayFragmentWidth;

/**
 *  The number of fragments per screen.
 */
extern const uint8_t FfxDisplayFragmentCount;

/**
 *  The callback function called per fragment to render to the buffer.
 *
 *  When called the buffer should be updated with RGB565 colors (2 bytes)
 *  per pixel, starting at the source line y0 (0 is the top line)
 *  populating DisplayFragmentWidth wide and DisplayFragmentHeight high.
 *
 *  The %%context%% is what was provided to the init call.
 */
typedef void (*FfxRenderFunc)(uint8_t *buffer, uint32_t y0, void *context);

/**
 *  Display Context Object.
 *
 *  This is intentionally opaque; do not inspect or rely on internals.
 */
typedef void* FfxDisplayContext;

/**
 *  Initializes the display, sending all necessary commands to
 *  configure the screen, blocking the current thread until
 *  complete.
 *
 *  This allocates DMA-compatible RAM and returns NULL if the
 *  memory cannot be allocated.
 */
FfxDisplayContext ffx_display_init(FfxDisplaySpiBus spiBus, uint8_t pinDC,
    uint8_t pinReset, FfxDisplayRotation rotation,
    FfxRenderFunc renderFunc, void *ctx);

/**
 *  Release all allocated buffers.
 *
 *  The DisplayContext must not be used after calling this
 *  without calling init again first.
 */
void ffx_display_free(FfxDisplayContext context);

/**
 *  Renders the next fragment, blocking the current task until
 *  complete, calling the [[RenderFunc]] with the fragment buffer.
 *
 *  Returns 1 if the last fragment of the frame was rendered,
 *  otherwise returns 0.
 */
uint32_t ffx_display_renderFragment(FfxDisplayContext context);

/**
 *  Returns the current FPS statistic.
 */
uint16_t ffx_display_fps(FfxDisplayContext context);


#ifdef __cplusplus
}
#endif /* __cplusplus */

#endif /* __FIREFLY_DISPLAY_H__ */
