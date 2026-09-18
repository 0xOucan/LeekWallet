# Board reference: ESP32-S3-WROOM-1-N16R8 CAM

Transcribed from the pinout diagram supplied with the board (`specs.avif`), and
spot-checked with a multimeter on 2026-09-17: microSD on 38/39/40 confirmed,
3V3 and 5V rails continuous to the header.

This is the authoritative pin reference for the `s3cam` board profile. Anything
that disagrees with it is wrong until re-measured.

## Header layout

```
 LEFT / FUNCTIONS                          ESP32-S3 CAM BOARD                RIGHT / FUNCTIONS
 ───────────────────                 ┌────────────────────────────┐        ───────────────────
 3V3 ────────────────────────────────┤ 3V3                    TX ├── GPIO43 ─ U0TXD ─ LED_TX
 RST ────────────────────────────────┤ RST                    RX ├── GPIO44 ─ U0RXD ─ LED_RX
 T4   ADC1_CH3 CAM_SIOD  ─ GPIO4  ───┤ 4                       1 ├── GPIO1  ─ ADC1_CH0 ─ T1
 T5   ADC1_CH4 CAM_SIOC  ─ GPIO5  ───┤ 5                       2 ├── GPIO2  ─ ADC1_CH1 ─ LED_ON ─ T2
 T6   ADC1_CH5 CAM_VSYNC ─ GPIO6  ───┤ 6                      42 ├── GPIO42 ─ MTMS
 T7   ADC1_CH6 CAM_HREF  ─ GPIO7  ───┤ 7                      41 ├── GPIO41 ─ MTDI
 U0RTS ADC2_CH4 CAM_XCLK ─ GPIO15 ───┤ 15                     40 ├── GPIO40 ─ SD_DATA ─ MTDO
 U0CTS ADC2_CH5 CAM_Y9   ─ GPIO16 ───┤ 16                     39 ├── GPIO39 ─ SD_CLK  ─ MTCK
 U1TXD ADC2_CH6 CAM_Y8   ─ GPIO17 ───┤ 17                     38 ├── GPIO38 ─ SD_CMD
 U1RXD ADC2_CH7 CAM_Y7   ─ GPIO18 ───┤ 18                     37 ├── GPIO37 ─ PSRAM
 T8   ADC1_CH7 CAM_Y4    ─ GPIO8  ───┤ 8                      36 ├── GPIO36 ─ PSRAM
 T3   ADC1_CH2 JTAG_EN   ─ GPIO3  ───┤ 3                      35 ├── GPIO35 ─ PSRAM
                  LOG    ─ GPIO46 ───┤ 46                      0 ├── GPIO0  ─ BOOT
 T9   ADC1_CH8 CAM_Y3    ─ GPIO9  ───┤ 9                      45 ├── GPIO45 ─ VSPI
 T10  ADC1_CH9 CAM_Y5    ─ GPIO10 ───┤ 10                     48 ├── GPIO48 ─ WS2812
 T11  ADC2_CH0 CAM_Y2    ─ GPIO11 ───┤ 11                     47 ├── GPIO47
 T12  ADC2_CH1 CAM_Y6    ─ GPIO12 ───┤ 12                     21 ├── GPIO21
 T13  ADC2_CH2 CAM_PCLK  ─ GPIO13 ───┤ 13                     20 ├── GPIO20 ─ USB_D- ─ ADC2_CH9 ─ U1CTS
 T14  ADC2_CH3           ─ GPIO14 ───┤ 14                     19 ├── GPIO19 ─ USB_D+ ─ ADC2_CH8 ─ U1RTS
 5V ─────────────────────────────────┤ 5V                    GND ├── GND
                                     │    [USB-C] [USB-C]       │
                                     └──────────────────────────┘
```

> The diagram prints GPIO19 as USB_D+ and GPIO20 as USB_D-. Espressif's
> datasheet has **GPIO19 = D-** and **GPIO20 = D+**. Neither matters here,
> because both are reserved either way.

## Functional groups

```
CAMERA (14 pins)               ON-BOARD SD (1-bit only)
├─ GPIO4   CAM_SIOD            ├─ GPIO38 SD_CMD
├─ GPIO5   CAM_SIOC            ├─ GPIO39 SD_CLK   (also MTCK)
├─ GPIO6   CAM_VSYNC           └─ GPIO40 SD_DATA  (also MTDO)
├─ GPIO7   CAM_HREF
├─ GPIO8   CAM_Y4/D2           PSRAM (octal, R8)
├─ GPIO9   CAM_Y3/D1           ├─ GPIO35
├─ GPIO10  CAM_Y5/D3           ├─ GPIO36
├─ GPIO11  CAM_Y2/D0           └─ GPIO37
├─ GPIO12  CAM_Y6/D4
├─ GPIO13  CAM_PCLK            USB            LED / ON-BOARD
├─ GPIO15  CAM_XCLK            ├─ GPIO19      ├─ GPIO2  LED_ON
├─ GPIO16  CAM_Y9/D7           └─ GPIO20      ├─ GPIO43 LED_TX
├─ GPIO17  CAM_Y8/D6                          ├─ GPIO44 LED_RX
└─ GPIO18  CAM_Y7/D5           STRAPPING      └─ GPIO48 WS2812
                               ├─ GPIO0  BOOT
JTAG (external)                ├─ GPIO3  JTAG_EN
├─ GPIO39 MTCK  (= SD_CLK)     ├─ GPIO45 VSPI
├─ GPIO40 MTDO  (= SD_DATA)    └─ GPIO46 LOG
├─ GPIO41 MTDI
└─ GPIO42 MTMS
```

Multiple labels on one GPIO mean multiplexed alternatives, not simultaneous
functions. Using the onboard SD therefore rules out **external** JTAG on 39/40;
native USB JTAG over 19/20 is unaffected and is what we use.

## Camera bus

```
 ESP32-S3                          OV5640
 GPIO4   CAM_SIOD / SCCB SDA  ◄──► SIOD
 GPIO5   CAM_SIOC / SCCB SCL  ───► SIOC
 GPIO15  CAM_XCLK             ───► XCLK
 GPIO6   CAM_VSYNC            ◄─── VSYNC
 GPIO7   CAM_HREF             ◄─── HREF
 GPIO13  CAM_PCLK             ◄─── PCLK
 GPIO11 Y2=D0   GPIO9  Y3=D1   GPIO8  Y4=D2   GPIO10 Y5=D3
 GPIO12 Y6=D4   GPIO18 Y7=D5   GPIO17 Y8=D6   GPIO16 Y9=D7
```

Matches `esp32-camera`'s `BOARD_ESP32S3_WROOM` map exactly.

```c
#define CAM_PIN_PWDN  -1
#define CAM_PIN_RESET -1
#define CAM_PIN_XCLK  15
#define CAM_PIN_SIOD   4
#define CAM_PIN_SIOC   5
#define CAM_PIN_D0    11
#define CAM_PIN_D1     9
#define CAM_PIN_D2     8
#define CAM_PIN_D3    10
#define CAM_PIN_D4    12
#define CAM_PIN_D5    18
#define CAM_PIN_D6    17
#define CAM_PIN_D7    16
#define CAM_PIN_VSYNC  6
#define CAM_PIN_HREF   7
#define CAM_PIN_PCLK  13
```

## What LeekWallet gets

After camera, SD, PSRAM, USB and strapping pins, these are free:

| Function | GPIO | Note |
|---|---|---|
| I2C SDA (OLED + ATECC608B) | **47** | free |
| I2C SCL (OLED + ATECC608B) | **21** | free |
| Button K1 | **1** | ADC1_CH0 / T1 |
| Button K2 | **41** | MTDI, free with native USB JTAG |
| Button K3 | **14** | the one GPIO in 4-18 the camera does not take |
| Button K4 | **42** | MTMS, likewise |
| Status LED | **48** | onboard WS2812 |
| Serial log | **43 / 44** | UART0, kept |
| Spare | **2** | free, but it also drives LED_ON — see board.h before using it as an input |

No strapping pin is used. See
[RESEARCH-AIRGAP-VAULT.md](RESEARCH-AIRGAP-VAULT.md) for what is built on top.
