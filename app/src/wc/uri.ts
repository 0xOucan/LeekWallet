/**
 * `wc:` pairing URI parsing (T32).
 *
 * The URI is the one piece of the WalletConnect handshake a user handles by
 * hand — pasted from a dapp, or read off a QR code by a camera that guesses.
 * Both paths produce a string that may be truncated, may have picked up
 * whitespace, or may be an entirely different URI scheme someone copied by
 * mistake. Parsing it here rather than handing it straight to the SDK means the
 * failure is a sentence the user can act on instead of an exception from inside
 * a dependency.
 *
 * It also carries the `symKey`, which is the secret that encrypts the pairing.
 * Nothing in this module logs it, and callers must not either: a pairing key in
 * a log file lets whoever reads the log decrypt the session proposal. It is not
 * a signing key — it cannot move funds — but it is still a secret.
 *
 * Pure and network-free, so it is tested directly.
 * Format: wc:<topic>@2?relay-protocol=irn&symKey=<64 hex>[&expiryTimestamp=…]
 */

export interface WcUri {
  /** 32-byte pairing topic, lower-case hex. */
  topic: string;
  /** Always 2 here; version 1 is dead and is refused by name. */
  version: 2;
  /** Relay transport protocol, `irn` in practice. */
  relayProtocol: string;
  /** Optional relay routing hint, passed through untouched. */
  relayData?: string;
  /** 32-byte symmetric key, lower-case hex. A secret — never log it. */
  symKey: string;
  /** Unix seconds, when the dapp supplied one. */
  expiryTimestamp?: number;
}

export type WcUriResult =
  | { ok: true; uri: WcUri }
  /** `reason` is written to be shown to a user, not to a developer. */
  | { ok: false; reason: string };

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * Parse and validate. Never throws: every rejection is a reason string.
 *
 * Deliberately strict about lengths. A truncated symKey would otherwise be
 * handed to the SDK, which fails much later with a decryption error that looks
 * like a relay problem rather than a bad paste.
 */
export function parseWcUri(input: string): WcUriResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "Nothing to pair with — paste a wc: URI." };

  if (!raw.startsWith("wc:")) {
    /* Say what was found rather than what was missing. The usual mistake is
     * copying the dapp's own https:// address out of the address bar. */
    const scheme = raw.split(":", 1)[0] ?? raw;
    return {
      ok: false,
      reason: `That is not a WalletConnect URI (it starts with "${scheme.slice(0, 12)}"). ` +
        `Use the dapp's "Connect wallet" dialog and copy the wc: link or scan its QR code.`,
    };
  }

  const body = raw.slice(3);
  const at = body.indexOf("@");
  if (at < 0) return { ok: false, reason: "This wc: URI has no version; it looks truncated." };

  const topic = body.slice(0, at).toLowerCase();
  if (!HEX32.test(topic)) {
    return { ok: false, reason: "This wc: URI's pairing topic is not 32 bytes of hex; it looks truncated or mistyped." };
  }

  const rest = body.slice(at + 1);
  const q = rest.indexOf("?");
  const version = q < 0 ? rest : rest.slice(0, q);
  if (version === "1") {
    /* Worth its own message: v1 relays were shut down in 2023, and a user
     * meeting one is looking at a dapp that has not been updated, not at a
     * fault in this app. */
    return { ok: false, reason: "This is a WalletConnect v1 link. v1 was shut down in 2023 — the dapp needs to offer a v2 connection." };
  }
  if (version !== "2") {
    return { ok: false, reason: `Unsupported WalletConnect version "${version}". This app speaks v2.` };
  }

  const params = new URLSearchParams(q < 0 ? "" : rest.slice(q + 1));
  const symKey = (params.get("symKey") ?? "").toLowerCase();
  if (!HEX32.test(symKey)) {
    return { ok: false, reason: "This wc: URI has no usable pairing key; it looks truncated. Copy the whole link." };
  }

  const relayProtocol = params.get("relay-protocol") ?? "";
  if (relayProtocol === "") {
    return { ok: false, reason: "This wc: URI names no relay protocol; it looks truncated." };
  }

  const uri: WcUri = { topic, version: 2, relayProtocol, symKey };

  const relayData = params.get("relay-data");
  if (relayData !== null) uri.relayData = relayData;

  const expiry = params.get("expiryTimestamp");
  if (expiry !== null && /^\d+$/.test(expiry)) uri.expiryTimestamp = Number(expiry);

  return { ok: true, uri };
}

/**
 * Whether the dapp's own expiry has passed.
 *
 * Pairing URIs are short-lived by design — a stale one produces a pairing that
 * simply never completes, which is indistinguishable from a dead relay unless
 * this is checked first. `now` is a parameter so the check is testable without
 * a fake clock.
 */
export function isExpired(uri: WcUri, now: number = Date.now()): boolean {
  return uri.expiryTimestamp !== undefined && uri.expiryTimestamp * 1000 <= now;
}

/**
 * A form of the URI that is safe to write to the log panel.
 *
 * The topic identifies the pairing and is not secret; the symmetric key is.
 * Redacting rather than omitting the whole URI keeps the log useful for
 * "did my paste arrive" while making it useless to anyone reading the log.
 */
export function redactWcUri(uri: WcUri): string {
  return `wc:${uri.topic.slice(0, 8)}…@2?relay-protocol=${uri.relayProtocol}&symKey=[redacted]`;
}
