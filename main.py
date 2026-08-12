from machine import Pin, I2C
import time
import ssd1306

i2c = I2C(0, scl=Pin(9), sda=Pin(8), freq=400000)
oled = ssd1306.SSD1306_I2C(128, 64, i2c, addr=0x3C)

k1 = Pin(4, Pin.IN, Pin.PULL_UP)
k2 = Pin(5, Pin.IN, Pin.PULL_UP)
k3 = Pin(6, Pin.IN, Pin.PULL_UP)
k4 = Pin(7, Pin.IN, Pin.PULL_UP)

def draw_screen(last_key="--", note=""):
    oled.fill(0)
    oled.text("ESP32-S3 + OLED", 0, 0, 1)
    oled.text("I2C: 0x3c", 0, 12, 1)
    oled.text("Press K1..K4", 0, 24, 1)
    oled.text("Key: " + last_key, 0, 44, 1)
    if note:
        oled.text(note, 0, 56, 1)
    oled.show()

# SAFE MODE: mantén K4 al reset para no entrar al loop
time.sleep_ms(50)
if k4.value() == 0:
    draw_screen("--", "SAFE MODE (K4)")
    print("SAFE MODE: not running loop")
    # No loop -> REPL queda usable
else:
    draw_screen("--")

    def read_key():
        if k1.value() == 0: return "K1"
        if k2.value() == 0: return "K2"
        if k3.value() == 0: return "K3"
        if k4.value() == 0: return "K4"
        return None

    last = None
    while True:
        key = read_key()
        if key and key != last:
            print("Pressed:", key)
            draw_screen(key)
            last = key
        if key is None:
            last = None
        time.sleep_ms(60)
