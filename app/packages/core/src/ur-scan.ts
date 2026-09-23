/**
 * Assembling one UR out of whatever a camera happens to decode.
 *
 * The camera loop is DOM and lives with each UI (the desktop app, the
 * extension's scan window). What to do with each decoded string is not, and
 * it is the part both of them must get identically right, so it lives here
 * where a test can drive it without a camera.
 */

import { UrDecoder } from "./ur-decoder.ts";

/** The UR type of a scanned string, lowercased, or null if it is not a UR. */
export function urType(raw: string): string | null {
  if (!/^ur:/i.test(raw)) return null;
  const slash = raw.indexOf("/");
  return slash < 0 ? null : raw.slice(3, slash).toLowerCase();
}

/**
 * Feeds scanned strings into a decoder, but only strings of one UR type.
 *
 * The filter is the point. The decoder pins its type from the first part it
 * accepts, so an unrelated UR in view — another wallet's screen, a poster —
 * would otherwise capture the assembly and hold it for the rest of the scan.
 */
export class UrScanAssembler {
  readonly type: string;
  private readonly decoder = new UrDecoder();

  constructor(type: string) {
    this.type = type.toLowerCase();
  }

  /**
   * One decoded QR string. Returns the complete message once it has
   * assembled, and `undefined` until then. `onProgress` hears about each
   * part that moved the assembly forward, never about ignored ones, so a
   * progress line cannot be driven by a code that is not the one expected.
   */
  accept(raw: string, onProgress?: (text: string) => void): Uint8Array | undefined {
    if (urType(raw) !== this.type) return undefined;
    const result = this.decoder.receive(raw);
    if (result === "complete") return this.decoder.message ?? undefined;
    if (result === "accepted") {
      onProgress?.(this.decoder.remaining > 0
        ? `Reading… ${this.decoder.remaining} fragment(s) still missing. Keep the device in view.`
        : "Reading…");
    }
    return undefined;
  }

  /** Fragments still missing, for callers that draw their own progress. */
  get remaining(): number {
    return this.decoder.remaining;
  }
}
