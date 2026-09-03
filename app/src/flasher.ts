/**
 * The firmware flasher panel (T65).
 *
 * Deliberately hard to use by accident. Flashing installs the code that holds
 * the keys. There are two ways to do it and they are not interchangeable:
 *
 * * **provision** — the merged image at offset 0. The vault lives in `nvs` at
 *   0x9000, which is *before* the app at 0x10000, so a merged image spans it
 *   and **erases every wallet**. Correct for a new or bricked board only.
 * * **update** — the application alone at 0x10000. The vault is untouched.
 *
 * Both images begin with the same ESP-IDF magic byte, so the file cannot say
 * which one it is; the user is asked, and the answer is sent explicitly rather
 * than defaulted. Defaulting picked the destructive one, and did erase a real
 * wallet during development.
 *
 * Within provisioning there are two further
 * dangers on this screen and they are stated separately, because they have
 * different remedies:
 *
 * * The seed on the device is destroyed. The user fixes that by writing their
 *   recovery phrase down first, which is why the acknowledgement says so in
 *   those words instead of "this cannot be undone".
 * * Without secure boot the device runs whatever it is given, so a flasher is a
 *   one-click way to install firmware that records a PIN. Nothing the user does
 *   fixes that; it is fixed by T11 burning the fuses. Until then the screen says
 *   it plainly rather than the button being quietly greyed out — a greyed button
 *   teaches nothing, and the risk is real whether or not this app offers it
 *   (any host can put a USB-Serial-JTAG chip into ROM download mode, so esptool
 *   has always been able to do this).
 *
 * Three gates in front of the button, in order of how fundamental they are:
 *
 * 1. **The build.** `flash_capability()` reports false unless the backend was
 *    compiled with the `flasher` feature; shipped builds are not.
 * 2. **The image.** Its SHA-256 is computed here and shown, and if the user
 *    pasted the digest from the release notes, a mismatch is a *refusal* — not
 *    a warning with a way past it. So is an image built for the other board:
 *    the ESP32-S3 reference and the ESP32-C3 Pixie are indistinguishable over
 *    USB, and the wrong one flashes cleanly and then fails to boot, which reads
 *    as a broken cable rather than as a wrong file.
 * 3. **The acknowledgement**, then a device, then a file.
 *
 * Nothing here flashes on its own. There is no auto-detect-and-write path, and
 * connecting is a separate press from writing.
 */

import { invoker } from "./tauri-transport.ts";

export interface FlashCapability {
  available: boolean;
  secureBoot: boolean;
  warning: string;
  erases: string;
}

export interface FlashPort {
  name: string;
  description: string;
  usbId: string;
  likelyDevice: boolean;
}

export interface DetectedChip {
  chip: string;
  chipId: number | null;
  revision: string | null;
  flashSize: string;
}

export interface FlashProgress {
  stage: "writing" | "verifying" | "done";
  current: number;
  total: number;
}

/** What the frontend needs from the shell. An interface so tests can fake it. */
export interface FlashBridge {
  capability(): Promise<FlashCapability>;
  ports(): Promise<FlashPort[]>;
  detect(port: string): Promise<DetectedChip>;
  write(
    port: string,
    image: Uint8Array,
    expectedSha256: string,
    /** 0 for a merged provision image, 0x10000 for an application update. */
    offset: number,
  ): Promise<string>;
  onProgress(handler: (p: FlashProgress) => void): void;
  log(line: string): void;
}

/** `esp_chip_id_t`, for the two boards this project ships. */
export const CHIP_IDS: Record<number, string> = { 0x0005: "ESP32-C3", 0x0009: "ESP32-S3" };

/**
 * The chip id out of an ESP image header, or null if there is no header.
 *
 * magic(1) segment_count(1) spi_mode(1) spi_speed/size(1) entry_addr(4)
 * wp_pin(1) spi_pin_drv(3), then chip_id as a little-endian u16 at byte 12.
 * Read here as well as in Rust so the mismatch can be caught while choosing the
 * file, rather than after the device has already been reset into the ROM.
 */
export function imageChipId(image: Uint8Array): number | null {
  if (image.length < 14 || image[0] !== 0xe9) return null;
  return image[12]! | (image[13]! << 8);
}

/** A name for a chip id, falling back to the raw number. */
export function chipName(id: number | null): string {
  if (id === null) return "an unrecognised chip";
  return CHIP_IDS[id] ?? `chip id 0x${id.toString(16).padStart(4, "0")}`;
}

/** The SHA-256 of some bytes, lowercase hex. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = new Uint8Array(data).buffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a pasted digest matches, and what to say when it does not.
 *
 * Forgiving about case and whitespace, because the expected value comes from a
 * human pasting a line out of release notes. Not forgiving about anything else:
 * a mismatch returns a sentence and the caller has no way to write anyway.
 */
export function digestRefusal(expected: string, actual: string): string {
  const want = expected.trim().toLowerCase();
  if (want === "") return "";
  if (!/^[0-9a-f]{64}$/.test(want)) {
    return "That is not a SHA-256 digest — it should be 64 hexadecimal characters. Paste the whole line from the release notes.";
  }
  if (want !== actual) {
    return (
      "Refusing to flash: this file's SHA-256 does not match the one you pasted. " +
      "The file is not the image you checked — download it again, and do not " +
      "install this one."
    );
  }
  return "";
}

/** Whether the image belongs on the attached board, and what to say if not. */
export function chipRefusal(imageId: number | null, device: DetectedChip | null): string {
  if (device === null || imageId === null) return "";
  if (device.chipId === null) {
    return (
      `The attached device reports itself as ${device.chip}, which is not one of the boards ` +
      "this app knows how to flash (ESP32-S3 or ESP32-C3)."
    );
  }
  if (device.chipId !== imageId) {
    return (
      `Refusing to flash: this image was built for ${chipName(imageId)} and the attached device ` +
      `is ${chipName(device.chipId)}. It would be written without complaint and then fail to ` +
      "boot, which looks exactly like a broken cable."
    );
  }
  return "";
}

/**
 * Why the flash button is disabled, or the empty string when it is not.
 *
 * Split out from the DOM so the rule is testable, and returned as the sentence
 * to display rather than as a boolean: "disabled with no explanation" is the
 * version of this that generates support questions, and on a screen this
 * dangerous the explanation is most of the point.
 */
export function flashBlockedReason(state: {
  capability: FlashCapability | null;
  acknowledged: boolean;
  port: string;
  imageBytes: number;
  digestRefusal: string;
  chipRefusal: string;
  busy: boolean;
}): string {
  if (state.busy) return "Flashing…";
  if (!state.capability) return "Checking what this build can do…";
  if (!state.capability.available) {
    return (
      "This build cannot flash firmware. That is deliberate: until secure boot " +
      "is burned, a device will run whatever it is given, so the flasher is " +
      "compiled out of shipped builds. Build the backend with `--features " +
      "flasher` if you are developing on your own board. Flashing is also " +
      "desktop-only — espflash takes a concrete serial port type that the " +
      "Android USB backend cannot be handed."
    );
  }
  if (state.imageBytes === 0) return "Choose a firmware image (.bin) to write.";
  // The refusals come before the smaller omissions: a user holding the wrong
  // file should be told that, not told to pick a port they will then be
  // refused at.
  if (state.digestRefusal !== "") return state.digestRefusal;
  if (state.chipRefusal !== "") return state.chipRefusal;
  if (state.port === "") return "Choose the device to flash.";
  if (!state.acknowledged) return "Read and accept the warning above first.";
  return "";
}

/** Human-readable progress. Exported so a test can pin the wording. */
export function describeProgress(p: FlashProgress): string {
  const pct = p.total > 0 ? Math.floor((p.current / p.total) * 100) : 0;
  switch (p.stage) {
    case "writing":
      return `Writing… ${pct}% (${p.current} of ${p.total} bytes). Do not unplug the device.`;
    case "verifying":
      return "Written. Verifying the checksum on the device…";
    case "done":
      return "Done. The device has been reset and should be running the new firmware.";
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** The real bridge, over Tauri. Returns null where there is no backend. */
export function tauriFlashBridge(log: (line: string) => void): FlashBridge | null {
  const invoke = invoker();
  if (!invoke) return null;
  return {
    capability: () => invoke<FlashCapability>("flash_capability"),
    ports: () => invoke<FlashPort[]>("flash_ports"),
    detect: (port) => invoke<DetectedChip>("flash_detect", { port }),
    write: (port, image, expectedSha256, offset) =>
      // Bytes, not a path: the only place a file is read is the file input
      // below, so this command cannot be aimed at an arbitrary path on disk.
      // The digest travels with them and the backend re-checks it over the
      // buffer it is actually about to write.
      invoke<string>("flash_write", {
        request: { port, image: Array.from(image), expectedSha256, offset },
      }),
    onProgress: (handler) => {
      const w = window as unknown as {
        __TAURI__?: {
          event?: { listen?: (e: string, cb: (p: { payload: FlashProgress }) => void) => void };
        };
      };
      w.__TAURI__?.event?.listen?.("flash://progress", (e) => handler(e.payload));
    },
    log,
  };
}

export function initFlasher(bridge: FlashBridge | null): void {
  const panel = $("flashpanel");
  const button = $("flashgo") as HTMLButtonElement;
  const connectButton = $("flashconnect") as HTMLButtonElement;
  const status = $("flashstatus");
  const warning = $("flashwarning");
  const erase = $("flasherase");
  const ack = $("flashack") as HTMLInputElement;
  const mode = $("flashmode") as HTMLSelectElement;
  const ackText = $("flashacktext");
  const fileLabel = $("flashfilelabel");

  /** Offsets from partitions.csv: nvs 0x9000, phy_init 0xf000, app 0x10000. */
  const PROVISION_OFFSET = 0x0;
  const UPDATE_OFFSET = 0x10000;
  const provisioning = () => mode.value === "provision";
  const offsetForMode = () => (provisioning() ? PROVISION_OFFSET : UPDATE_OFFSET);

  /* The acknowledgement is not boilerplate to click past — it is the sentence
     that has to be true. So it says what THIS write does, and re-arms itself
     when the mode changes: a box ticked against "keeps my wallet" is not
     consent to erase one. */
  const describeMode = (): void => {
    if (provisioning()) {
      fileLabel.textContent = "Firmware image (-provision.bin, written at 0x0)";
      ackText.textContent =
        "I have written down my recovery phrase. I understand that this erases " +
        "the device including every seed stored on it, and that the firmware I " +
        "install will have full access to my PIN and my seed.";
    } else {
      fileLabel.textContent = "Firmware image (-update.bin, written at 0x10000)";
      ackText.textContent =
        "I understand that the firmware I install will have full access to my " +
        "PIN and my seed. My wallet stays on the device.";
    }
  };
  mode.addEventListener("change", () => {
    ack.checked = false;
    describeMode();
    erase.hidden = !provisioning();
    refresh();
  });
  describeMode();
  const portSelect = $("flashport") as HTMLSelectElement;
  const file = $("flashfile") as HTMLInputElement;
  const digestOut = $("flashdigest");
  const expected = $("flashexpected") as HTMLInputElement;
  const device = $("flashdevice");
  const bar = $("flashbar") as HTMLProgressElement;

  let capability: FlashCapability | null = null;
  let image = new Uint8Array(0);
  let digest = "";
  let detected: DetectedChip | null = null;
  let busy = false;

  const refresh = (): void => {
    const reason = flashBlockedReason({
      capability,
      acknowledged: ack.checked,
      port: portSelect.value,
      imageBytes: image.length,
      digestRefusal: digestRefusal(expected.value, digest),
      chipRefusal: chipRefusal(imageChipId(image), detected),
      busy,
    });
    button.disabled = reason !== "";
    if (reason !== "") status.textContent = reason;
  };

  if (!bridge) {
    panel.hidden = false;
    warning.textContent =
      "Flashing needs the desktop app; a browser window cannot reach a USB device.";
    button.disabled = true;
    connectButton.disabled = true;
    return;
  }

  panel.hidden = false;
  ack.addEventListener("change", refresh);
  portSelect.addEventListener("change", () => {
    // A different port is a different board until it says otherwise. Keeping a
    // stale detection here would let a C3 image through a check that passed
    // against the S3 that used to be selected.
    detected = null;
    device.textContent = "Not connected.";
    refresh();
  });
  expected.addEventListener("input", refresh);

  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) {
      image = new Uint8Array(0);
      digest = "";
      digestOut.textContent = "";
      refresh();
      return;
    }
    void f.arrayBuffer().then(async (buf) => {
      image = new Uint8Array(buf);
      digest = await sha256Hex(image);
      const built = imageChipId(image);
      digestOut.textContent =
        `${f.name} — ${image.length} bytes, built for ${chipName(built)}\nSHA-256 ${digest}`;
      refresh();
    });
  });

  connectButton.addEventListener("click", () => {
    if (busy || portSelect.value === "") return;
    device.textContent = "Connecting…";
    void bridge
      .detect(portSelect.value)
      .then((d) => {
        detected = d;
        const rev = d.revision === null ? "" : ` ${d.revision}`;
        device.textContent = `${chipName(d.chipId)} (${d.chip}${rev}), ${d.flashSize} flash`;
        bridge.log(`flasher: ${portSelect.value} is ${d.chip}`);
        refresh();
      })
      .catch((e: unknown) => {
        detected = null;
        device.textContent = `Could not identify the device: ${String((e as Error).message ?? e)}`;
        refresh();
      });
  });

  bridge.onProgress((p) => {
    status.textContent = describeProgress(p);
    bar.hidden = false;
    bar.max = p.total || 1;
    bar.value = p.current;
  });

  button.addEventListener("click", () => {
    if (busy) return;
    /* Never auto-flash, and never flash on a stale answer: everything the
     * button's state depends on is re-evaluated at the moment of the press. */
    if (flashBlockedReason({
      capability,
      acknowledged: ack.checked,
      port: portSelect.value,
      imageBytes: image.length,
      digestRefusal: digestRefusal(expected.value, digest),
      chipRefusal: chipRefusal(imageChipId(image), detected),
      busy,
    }) !== "") {
      refresh();
      return;
    }
    busy = true;
    refresh();
    bridge.log(`flasher: writing ${image.length} bytes (${digest}) to ${portSelect.value}`);
    void bridge
      .write(portSelect.value, image, digest, offsetForMode())
      .then(() => {
        status.textContent = describeProgress({
          stage: "done",
          current: image.length,
          total: image.length,
        });
        bridge.log("flasher: complete");
      })
      .catch((e: unknown) => {
        status.textContent = `Flashing failed: ${String((e as Error).message ?? e)}`;
        bridge.log(`flasher: failed: ${String((e as Error).message ?? e)}`);
      })
      .finally(() => {
        busy = false;
        bar.hidden = true;
        refresh();
      });
  });

  void bridge
    .capability()
    .then(async (cap) => {
      capability = cap;
      warning.textContent = cap.warning;
      /* Only where it is true. A standing "this erases your device" banner over
         an update that does not erase anything is how a warning stops being
         read by the time it matters. */
      erase.textContent = cap.erases;
      erase.hidden = !provisioning();
      /* Never say "protected" unless the backend says so. Today it never does:
       * no fuse has been burned, and "unknown" must read the same as "not
       * protected" for as long as that is true. */
      warning.dataset["secure"] = String(cap.secureBoot);
      if (cap.available) {
        const ports = await bridge.ports();
        portSelect.textContent = "";
        for (const p of ports) {
          const opt = document.createElement("option");
          opt.value = p.name;
          opt.textContent =
            `${p.name} — ${p.description} [${p.usbId}]` +
            (p.likelyDevice ? "  (Espressif)" : "");
          portSelect.appendChild(opt);
        }
      } else {
        connectButton.disabled = true;
      }
      refresh();
    })
    .catch(() => {
      status.textContent = "Could not ask the backend whether it can flash.";
    });

  refresh();
}
