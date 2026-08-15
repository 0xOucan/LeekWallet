/**
 * The firmware flasher panel (T65).
 *
 * Deliberately hard to use by accident. Flashing installs the code that holds
 * the keys, so on a device without secure boot this button is a one-click way
 * to install firmware that records a PIN and exfiltrates a seed. The hole is
 * not new — the ESP32-S3 can be put into ROM download mode by any host, so
 * `esptool` has always been able to do this — but making it easy is a decision,
 * and it is gated three ways:
 *
 * 1. **The build.** `flash_capability()` reports false unless the backend was
 *    compiled with the `flasher` feature. Shipped builds are not, so the button
 *    is disabled and says why.
 * 2. **An acknowledgement.** Even in a flashing build, the user has to tick a
 *    box that states what an unprotected device means.
 * 3. **The device.** Nothing here burns eFuses, and nothing writes below the
 *    app partition — the backend enforces that floor, because everything under
 *    it is the vault.
 *
 * When secure boot lands (T11) the first gate changes meaning: a locked device
 * only runs signed images, so flashing becomes the safe update path rather than
 * a hazard, and the warning becomes a statement about which key signed it.
 */

import { invoker } from "./tauri-transport.ts";

export interface FlashCapability {
  available: boolean;
  secureBoot: boolean;
  warning: string;
}

export interface FlashPort {
  name: string;
  description: string;
  likelyDevice: boolean;
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
  write(port: string, image: Uint8Array): Promise<void>;
  onProgress(handler: (p: FlashProgress) => void): void;
  log(line: string): void;
}

/**
 * Why the flash button is disabled, or the empty string when it is not.
 *
 * Split out from the DOM so the rule is testable: a build that cannot flash, a
 * user who has not acknowledged, no device chosen, no image chosen. Returned as
 * the sentence to display rather than a boolean, because "disabled with no
 * explanation" is the version of this that generates support questions.
 */
export function flashBlockedReason(state: {
  capability: FlashCapability | null;
  acknowledged: boolean;
  port: string;
  imageBytes: number;
  busy: boolean;
}): string {
  if (state.busy) return "Flashing…";
  if (!state.capability) return "Checking what this build can do…";
  if (!state.capability.available) {
    return (
      "This build cannot flash firmware. That is deliberate: until secure boot " +
      "is burned, a device will run whatever it is given, so the flasher is " +
      "compiled out of shipped builds. Build the backend with `--features " +
      "flasher` if you are developing on your own board."
    );
  }
  if (!state.acknowledged) return "Read and accept the warning above first.";
  if (state.port === "") return "Choose the device to flash.";
  if (state.imageBytes === 0) return "Choose a firmware .bin to write.";
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
    write: (port, image) =>
      // Bytes, not a path: the only place a file is read is the file input
      // below, so this command cannot be aimed at an arbitrary path on disk.
      invoke<void>("flash_write", { port, image: Array.from(image) }),
    onProgress: (handler) => {
      const w = window as unknown as {
        __TAURI__?: { event?: { listen?: (e: string, cb: (p: { payload: FlashProgress }) => void) => void } };
      };
      w.__TAURI__?.event?.listen?.("flash://progress", (e) => handler(e.payload));
    },
    log,
  };
}

export function initFlasher(bridge: FlashBridge | null): void {
  const panel = $("flashpanel");
  const button = $("flashgo") as HTMLButtonElement;
  const status = $("flashstatus");
  const warning = $("flashwarning");
  const ack = $("flashack") as HTMLInputElement;
  const portSelect = $("flashport") as HTMLSelectElement;
  const file = $("flashfile") as HTMLInputElement;

  let capability: FlashCapability | null = null;
  let image = new Uint8Array(0);
  let busy = false;

  const refresh = (): void => {
    const reason = flashBlockedReason({
      capability,
      acknowledged: ack.checked,
      port: portSelect.value,
      imageBytes: image.length,
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
    return;
  }

  panel.hidden = false;
  ack.addEventListener("change", refresh);
  portSelect.addEventListener("change", refresh);

  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) { image = new Uint8Array(0); refresh(); return; }
    void f.arrayBuffer().then((buf) => {
      image = new Uint8Array(buf);
      status.textContent =
        `${f.name}, ${image.length} bytes. The backend checks it is an ESP image before erasing anything.`;
      refresh();
    });
  });

  bridge.onProgress((p) => {
    status.textContent = describeProgress(p);
    if (p.stage === "done") { busy = false; refresh(); }
  });

  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    refresh();
    bridge.log(`flashing ${image.length} bytes to ${portSelect.value}`);
    void bridge
      .write(portSelect.value, image)
      .then(() => {
        status.textContent = describeProgress({ stage: "done", current: image.length, total: image.length });
        bridge.log("flash complete");
      })
      .catch((e: unknown) => {
        status.textContent = `Flashing failed: ${String((e as Error).message ?? e)}`;
        bridge.log(`flash failed: ${String((e as Error).message ?? e)}`);
      })
      .finally(() => { busy = false; refresh(); });
  });

  void bridge.capability().then(async (cap) => {
    capability = cap;
    warning.textContent = cap.warning;
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
        opt.textContent = `${p.name} — ${p.description}${p.likelyDevice ? "  (looks like an ESP)" : ""}`;
        portSelect.appendChild(opt);
      }
    }
    refresh();
  }).catch(() => {
    status.textContent = "Could not ask the backend whether it can flash.";
  });

  refresh();
}
