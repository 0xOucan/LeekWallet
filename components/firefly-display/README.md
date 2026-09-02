Firefly Display
===============

A simple display driver for the ST7789 240x240 display optimized
for reduced memory usage.

The screen is broken up into fragments (by default ten 240x24
fragments) and two fragment buffers are allocated. At any point
in time there is an "active" buffer being blitted to the display
while the next "backbuffer" fragment is passed to the `renderFunc`
provided when the display was initialized.

The `renderFunc` should populate the fragment with the viewport
from `(0, y0, 240, FragmentHeight)`, using RGB565 values.

```
void renderFunc(uint8_t *buffer, uint32_t y0, void *context) {
  // render the viewport lines from y0 to FfxDisplayFragmentHeight
}

void app_main(void) {
  
  // Context may be NULL; it is passed to each renderFunc invocation
  // The Display can be oriented with either the ribbon to the right
  // or the bottom.
  FfxDisplayContext display = ffx_display_init(bus, pinDC, pinReset,
    FfxDisplayRotationRibbonRight, renderFunc, context);

  while (1) {
    // Calls renderFunc to prepare the next fragment, while blitting
    // the previously prepared fragment.
    uint32_t frameDone = ffx_display_renderFragment(display);
    if (frameDone) {
      // The last fragment of the screen has been drawn

      // To throttle the frame rate use a delayUntil function
    }
  }
}
```


  }
  
Examples
--------

See the [example project](./examples/test-app) which merely
displays a static image on the display.


Using Locally
-------------

Due to the way ESP IDF uses a component's folder name to determine
its package name, the default folder when checking out from GitHub
(i.e. `component-display`) prevents the component from working.

To resolve this, for example if contributing to the repository,
checkout out the component in a target folder named `firefly-display`:

```shell
/home/ricmoo> git clone git@github.com:firefly/component-display.git firefly-display
# This is important!! -----------------------------------------------^
```


License
-------

MIT License.
