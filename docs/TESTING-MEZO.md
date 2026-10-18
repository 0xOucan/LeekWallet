# Testing the Mezo integration on hardware

Everything below has been run except where it says otherwise. The board at
`/dev/ttyACM0` was flashed on 2026-10-18 with the working tree's own build and
answers as `LeekWallet-S3CAM`, firmware `0.1.0`, **1 wallet intact**.

The contracts are live on Mezo testnet (31611). Nothing here is a simulation:
a buy spends real testnet MUSD against
[leekdefi.0xoucanproject.xyz](https://leekdefi.0xoucanproject.xyz)'s own
vaults.

## 0 — What is already true

| | |
|---|---|
| Firmware table | `buy`, `redeem`, `stake`, `unstake` on the generic path (`src/eth-decode.c`) |
| Host mirror | the same four in `app/packages/core/src/eth-decode.ts` |
| Shared vectors | **65**, recorded from the real C decoder, replayed against the mirror |
| Descriptors | `app/packages/apps/leekdefi/descriptors.ts` for the vaults and staking; MUSD/MEZO `approve` in `app/packages/core/src/erc7730-mezo.ts` |
| Both gates | `app/test/leekdefi.test.ts`, 7 groups, same calldata through each |
| Blind signing | **off**, confirmed by `getFeatures` — and it must stay off, because the point is that the device *reads* these calls |

## 1 — Flash the board

```sh
cd ~/Hardware/FireflyPixie/leekwallet
./flash-board.sh s3cam --dry-run      # says what it would do, writes nothing
./flash-board.sh s3cam                # builds, then writes the app only
```

App only, at `0x10000`, **no erase**: NVS and the seeds in it are untouched.
The script asks the board which model it is and refuses a board that answers
with a different one, because the CAM board and the reference board are both
an ESP32-S3 N16R8 and esptool cannot tell them apart — their pin maps collide
on GPIO 5-10, which are camera data lines here.

Never `flash-both.sh provision`. That erases every wallet.

## 2 — Confirm what came up

```sh
python3 scripts/probe-device.py /dev/ttyACM0
```

`getFeatures` answers CBOR; decoded it reads `blindSigning 0`, `firmware
"0.1.0"`, `model "LeekWallet-S3CAM"`. `getStatus` gives `walletCount` and
`unlocked`. A locked device is the normal state — unlock happens on the board.

**`blindSigning` must read 0.** If it reads 1 the device will sign calldata it
cannot put into words, and every claim in this document stops meaning
anything. It is changed on the device only; there is deliberately no command
for it.

## 3 — Run the two decoders against each other

No hardware needed, and this is the check that actually proves the firmware
and the companion agree:

```sh
make -C sim eth-decode-conformance     # re-records the vectors from src/eth-decode.c
cd app && npm test                     # replays them against the TS mirror
```

Want to see it bite? Change one argument name in `src/eth-decode.c`, re-record,
and the mirror test fails naming the row.

The LeekDefi-specific suite on its own:

```sh
cd app && node --experimental-strip-types --disable-warning=ExperimentalWarning test/leekdefi.test.ts
```

Seven groups. The one that matters runs the same `buy` calldata through
`screenProposal` (the host gate) and `decodeCall` (the device's mirror), and
asserts the slippage floor is on screen in both.

## 4 — Desktop companion, end to end

```sh
cd app && pnpm tauri dev
```

Then, in the app:

1. **Link** the device over USB. Pick the serial transport; the port is
   `/dev/ttyACM0`.
2. **Unlock** on the board — PIN on the device, never in the companion.
3. Switch the chain to **Mezo Testnet**. Gas there is **BTC**, not ether, and
   the companion labels it that way.
4. Open **LeekDefi** from the app list.
5. Check the reads land: a price near 98-99 MUSD, `Backing` over 100%, your
   MUSD balance. A figure that says *not read* is a failed call, not a zero —
   that distinction is deliberate.
6. Type an amount, press **Approve MUSD**. The device draws
   *Approve spending*, the spender and the amount, with `UNLIMITED` if it ever
   were. Confirm on the board.
7. Press **Buy shares**. **This is the beat worth watching.** The device draws
   two pages from its own decoder: the MUSD being spent, and `minShares`, the
   floor below which the buy reverts. No descriptor reaches the device; what is
   on glass is its own reading of the calldata.
8. Confirm. Mezo answers `eth_getTransactionReceipt` with null for minutes
   after a transaction is already in a block, so **a reported failure here is
   usually not one**. Check the explorer or re-read your share balance.

### If something is wrong

| Symptom | Cause |
|---|---|
| The buy button is disabled and says no device is connected | `propose` is absent — the shell has no device. Link one. |
| *The wallet declined this request.* | One sentence for every no, on purpose: an app is not told whether you rejected it or the gate refused it. The **shell's log** has the real reason. |
| "cannot display this request" on the board | The device's table does not have that selector. Did the firmware get flashed, or only the companion? |
| `not read` on every figure | The RPC endpoint is not answering. The app cannot build its own client, so this is the shell's endpoint. |
| No usable price | The oracle's last answer is older than the vault accepts. Buys revert until the feed publishes; `MAX_STALENESS` is 1 hour. |

## 5 — Chrome, which is a different path

The extension is **not** a mini-app host. It is the EIP-1193 provider that
injects into pages, so the Chrome story is the **real website** talking to the
board:

```sh
cd app/extension && npm run build
# chrome://extensions -> Developer mode -> Load unpacked -> app/extension/dist
```

Then open [leekdefi.0xoucanproject.xyz](https://leekdefi.0xoucanproject.xyz)
and buy from the page. The manifest already injects on all HTTPS, so no change
was needed for this domain. Desktop Chromium only — it needs Web Serial.

A dapp gets the laxer host rule than a mini-app does: a missing descriptor is
shown with a caveat rather than refused, because refusing a dapp the device
*would* accept means overruling the owner invisibly. The device's own decoder
is what protects the signer either way, and after this change it reads `buy`
and `redeem` field by field.

## 6 — What has not been tested

Said plainly, because the opposite is worth nothing:

- **Android.** `app/ANDROID.md` still applies: the arm64 APK builds and the
  Gradle wiring was inspected, but no phone has been attached. No scan, no
  enumeration, no connection, no permission dialog, no signature. The mini-app
  is surface-independent — same shell, same registry — so what is unproven is
  the transport, not the app.
- **The Pixie.** Only the CAM board was flashed. The Pixie still holds
  Aqua-Q2-era firmware and its wallets are intact; `./flash-both.sh dev`
  handles it when wanted.
- **A signature on this firmware.** The board was flashed and answers, and the
  decoders agree on 65 recorded vectors. That is evidence, not a substitute
  for a confirmed transaction: until step 4 is walked through, no screen has
  drawn a `buy`.
