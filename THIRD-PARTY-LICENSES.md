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
