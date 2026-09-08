# Third-Party Licenses

LeekWallet is licensed under [Apache License 2.0](LICENSE). It bundles the
components below under their own licenses, which are unchanged and continue to
govern those files. Nothing here is relicensed.

## Inventory

| Component | Location | License | Compatible with Apache-2.0 |
|---|---|---|---|
| trezor-crypto | `components/trezor-crypto/` | MIT | Yes |
| chacha20poly1305 | `components/trezor-crypto/chacha20poly1305/` | MIT | Yes |
| QRCode | `src/qrcode.c`, `src/qrcode.h` | MIT | Yes |
| ESP-IDF | build dependency, not vendored | Apache-2.0 | Yes |
| zxing-wasm | `app/` npm dependency, WASM bundled into the app | MIT | Yes |
| @1inch/aqua-sdk | `app/packages/apps/aqua/` **devDependency, tests only — never bundled** | LicenseRef-Degensoft-Aqua-Source-1.1 | **No — see below** |

Every row above is bundled into a release except `@1inch/aqua-sdk`, which is
deliberately not, because it is the one entry that could not be. The section
on it below says why, and what contributors must not do with it.

MIT is permissive and imposes only attribution, so MIT code may be distributed
inside an Apache-2.0 project provided the copyright notices and license text
travel with it. That is what `NOTICE` and this file are for. The MIT-licensed
directories keep their own `LICENSE` files in place.

## trezor-crypto

`components/trezor-crypto/` — the cryptographic core: BIP32, BIP39, secp256k1
ECDSA, SHA-2/SHA-3, PBKDF2, AES. Everything that touches a key in this project
ultimately calls into it.

License: MIT, Copyright (c) 2013 Tomas Dzetkulic and Pavol Rusnak.
Full text: `components/trezor-crypto/LICENSE`.
Upstream: https://github.com/trezor/trezor-firmware (the `crypto/` directory).

Note that the wider trezor-firmware repository is GPL-licensed; only the
`crypto/` subdirectory vendored here is MIT. Do not pull additional files from
upstream without checking their headers.

## chacha20poly1305

`components/trezor-crypto/chacha20poly1305/` — MIT, Copyright (c) 2016 Will
Glozer. Full text in that directory's `LICENSE`.

## QRCode

`src/qrcode.c` / `src/qrcode.h` — QR generation for receive addresses.
MIT, Copyright (c) 2017 Richard Moore. Upstream:
https://github.com/ricmoo/QRCode

## zxing-wasm

`zxing-wasm` — QR *decoding* from camera frames in the companion app
(`app/src/wc/qr.ts`). Distinct from the `QRCode` entry above, which generates
codes on the device; this reads them on the host.

License: MIT (the wrapper), wrapping zxing-cpp, Apache-2.0.
Upstream: https://github.com/Sec-ant/zxing-wasm

The `.wasm` is bundled as a local asset and served from the app's own origin.
zxing-wasm fetches it from a CDN by default; that would be remote code arriving
in the process that talks to a signing device, and is not done here.

This replaced `jsqr`, which was 40 KB of readable JavaScript and preferable on
every axis except the decisive one: it could not read a WalletConnect pairing
code. The actual code, captured from the device camera at full resolution and
in focus, was handed to three decoders — jsQR found nothing, `@zxing/library`
(the pure-JS ZXing port) found nothing, and zxing-cpp via WASM read it.
Preprocessing the image three ways did not rescue either JS decoder.

The costs were accepted deliberately: about 1.1 MB of opaque binary in place of
auditable source, and `'wasm-unsafe-eval'` added to `script-src` so the module
can be instantiated at all. Both are real, and both are the price of a scanner
that works.

## firefly-display

`components/firefly-display/` — the ST7789 driver used by the Firefly Pixie
build, vendored from [firefly/component-display](https://github.com/firefly/component-display).

**MIT**, Copyright (c) 2024 Richard Moore. The licence travels with the source in
`components/firefly-display/LICENSE.md`.

Two local changes, both in `CMakeLists.txt` and neither in the driver itself:
the component is registered only for the ESP32-C3, since the reference board has
no ST7789 and compiling one in would be a driver for a panel that is not there;
and `esp_driver_spi` is added to `REQUIRES`, because ESP-IDF 5 split the SPI
master out of the monolithic `driver` component and the upstream file still
asks only for `driver`.

The rest of the Firefly ecosystem is deliberately **not** vendored.
`firefly-hollows` is an application framework that would replace this project's
UI task, button layer and transport; `firefly-scene` is a scene graph for a
display that is 21 characters wide. See `docs/PIXIE-PORT.md` for why taking the
driver alone was the whole of the decision.

## esptool-js — website only

Not in this repository. The web flasher in the sibling website project vendors
[esptool-js](https://github.com/espressif/esptool-js) 0.6.1, **Apache-2.0**,
whose bundle inlines [pako](https://github.com/nodeca/pako), **MIT AND Zlib**.
Recorded here because a reader auditing what this project ships should not have
to know that the flasher lives elsewhere to find out what it depends on.

## Colibri — inspiration, not code

The HD wallet core was previously named `colibri-wallet`, after the
[Colibri](https://github.com/xtools-at/colibri) hardware wallet, whose JSON-RPC
method naming and overall structure informed this design.

**Upstream Colibri is AGPL-3.0-or-later, which is not compatible with releasing
this project under Apache-2.0.** No Colibri code is present here:

- Colibri is C++ for Arduino, built on ArduinoJson, organised as classes
  (`Wallet::`, `Storage::`).
- `components/leek-wallet/` is C for ESP-IDF, procedural, with its own NVS
  schema and state handling.
- The two share no symbols. Every AGPL source in the sibling `colibri/`
  checkout carries an `SPDX-License-Identifier: AGPL-3.0-or-later` header; no
  file in this repository does.

The component was renamed to `leek-wallet` to make that boundary unambiguous.
Method *names* (`getStatus`, `unlock`, `signTypedData`) are shared for wire
compatibility; names and interfaces are not generally protected by copyright,
and no implementation was copied.

**Rule for contributors: do not copy code from the Colibri repository into this
one.** Doing so would make this project AGPL and invalidate its license. If you
want a behaviour Colibri has, read its documentation or observe its protocol,
then write the implementation here.

## @1inch/aqua-sdk

`app/packages/apps/aqua/` — the 1inch Aqua SDK. A **devDependency**, used only
by `test/sdk-parity.test.ts`, which builds the same `ship` and `dock` calldata
the app builds and asserts the two agree byte for byte. **No module under any
`src/` imports it, so no release artifact contains it**; that suite asserts as
much, because everything below depends on it staying true.

License: **Degensoft Aqua Source License 1.1** (`LicenseRef-Degensoft-Aqua-Source-1.1`),
Copyright © 2025 Degensoft Ltd. Full text ships in the package: `LICENSE`.

**Source-available, not open source, and not compatible with Apache-2.0.**

### Why it is not a dependency

`docs/apps/AQUA-1INCH.md` notes that calling the deployed Aqua contracts is
unaffected by this licence. That is right, and it is what the app does. Putting
the SDK *into a signed release binary* is a different act, and it fails on five
independent clauses:

- **§2.1 vs §1.7.** The grant covers distributing *unmodified* source or object
  forms. §1.7 defines Modification to include static or dynamic linking and
  "artifacts shipped/deployed together as one product". A bundled, tree-shaken,
  minified companion is both, so the bundle is not what §2.1 permits us to hand
  out.
- **§5 and §6.** Commercial use requires a separate written agreement from
  Degensoft; Degensoft may demand an annual audit. These are obligations that
  would attach to whoever holds the binary. Our `LICENSE` tells them they have
  none.
- **§7.1.** The patent grant terminates when the licensee stops using the work
  or asserts a claim, and forbids seeking patent protection for any system that
  depends on it. Apache-2.0 §3 is irrevocable except on patent litigation.
- **§9 and §11.3.** The licence terminates on uncured material breach and may
  not be assigned without written consent. Apache-2.0 is perpetual and
  irrevocable, and a public release is exactly an unconsented conveyance to
  strangers.
- **§5.3.** The waiver that makes ordinary use practical is revocable "at any
  time in its sole discretion, including with respect to existing users", with
  ten days to cure. Binaries already downloaded cannot be cured at all.

There is also an internal contradiction worth knowing about: **§3.1 C requires
the designation "Powered by Aqua"** in README and UI for distributed
Modifications, while **§7.2 grants no right to use that designation** absent
separate written permission. Any path that made us a distributor of a
Modification would require contacting Degensoft to resolve it.

The short version: this project cannot grant rights it does not hold, and cannot
bind people who download a release to terms they never saw. Keeping the SDK out
of the bundle avoids all of it, and costs nothing — see below.

### What we get instead

The SDK is more useful as a witness than as a dependency. `src/registry.ts` and
`AquaProtocolContract` are two independent implementations of the same ABI, and
`test/sdk-parity.test.ts` compares every byte either produces, plus the strategy
hash, the three event topics and the registry address. Importing the SDK would
have replaced two implementations with one and proved nothing. A differential
test against the protocol authors' own code is the stronger result.

### Rules for contributors

1. **Do not import `@1inch/aqua-sdk` from any `src/` directory**, and do not
   promote it to `dependencies`. Both would put it in the release bundle and
   everything above would start applying. `test/sdk-parity.test.ts` fails if the
   first happens.
2. **Do not copy or vendor Aqua source**, SDK or contracts, into this
   repository. Calling published contracts is permitted; a copied file is a
   Modification under §1.7 and would pull this project under a licence it cannot
   be released under.
3. **If this project ever charges for anything**, re-read §5 before shipping,
   not after — the triggers are measured on gross receipts and aggregate across
   affiliates.
