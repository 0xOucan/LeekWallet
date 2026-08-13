# Reaching a browser, and reaching MetaMask

A research note, not a plan. The question behind it was "can we simulate or fake a MetaMask
connection with an extension" — and the honest first answer is that *faking* one is not a
thing that exists — not in the sense the question meant, which was appearing *inside* MetaMask.
There are four real seams, each with a different owner, and three of them do not require
MetaMask's cooperation at all.

There is, though, a fifth thing that is neither faking MetaMask nor ignoring it: speaking
MetaMask's provider dialect on the page, which is what Rabby, Phantom and Coinbase Wallet all do
and which an unmeasured but non-empty tail of dapps still requires. §4bis covers it, source read
rather than
the folklore repeated.

Everything below was checked against primary sources in August 2026. Where a source could not
be confirmed it says so rather than rounding up.

---

## 0. The short version

| Route | Open to us alone? | Reaches the device how? | Verdict |
|---|---|---|---|
| Snap (Keyring API) *appearing as a MetaMask account* | **No** — allowlist closed | Not directly; via a companion dapp | Blocked upstream |
| MetaMask's built-in hardware keyrings (Ledger/Trezor/Lattice) | **No** — MetaMask code change | USB/HID | Not available |
| MetaMask's QR keyring (ERC-4527) | **Yes**, no permission needed | Animated QR, both directions | **Blocked by our hardware** — no camera |
| Our own extension + EIP-6963 | **Yes** | WebUSB / Web Serial / Web Bluetooth | Viable, and the only viable one |
| …plus a MetaMask-*compatible* provider on `window.ethereum` (§4bis) | **Yes** | same | Do it, with hard limits |
| WalletConnect v2 (in progress, [PROTOCOL.md 6b](PROTOCOL.md)) | **Yes** | Our app, over the relay | Already chosen; keep it |

The thing worth internalising before reading further: **"appear inside MetaMask" and "work in a
browser" are different goals**, and only the second is achievable by us unilaterally. Every path
that puts our accounts in MetaMask's account list runs through a gate someone else controls.

---

## 1. Snaps and the Keyring API — the sanctioned route, currently shut

### What it is

A Snap is a JavaScript program MetaMask runs in-process. An *account management Snap* holds the
`endowment:keyring` permission, implements `onKeyringRequest`, and calls `snap_manageAccounts` to
tell MetaMask about accounts it controls. Those accounts then appear in MetaMask's own account
list, and signing requests for them are routed to the Snap instead of MetaMask's internal keyring.
This is exactly the shape the question was reaching for, and it is real
([docs](https://docs.metamask.io/snaps/features/custom-evm-accounts/),
[Keyring API reference](https://docs.metamask.io/snaps/reference/keyring-api/)).

### The crux: a Snap cannot touch a USB or BLE device. At all.

Snaps run under SES ("Hardened JavaScript") in a sandbox with no DOM, no `window`, no `navigator`,
and no platform APIs. The globals are `Promise`/`Math`/`Set`, `console`, timers, `SubtleCrypto`,
`TextEncoder`, `atob`/`btoa`, `URL`, plus `snap` and (with permission) `ethereum`
([execution environment](https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/)).
The full permission list — `cronjob`, `ethereum-provider`, `page-home`, `keyring`,
`lifecycle-hooks`, `name-lookup`, `network-access`, `rpc`, `signature-insight`,
`transaction-insight`, `webassembly` — contains nothing for USB, HID, serial or Bluetooth
([permissions](https://docs.metamask.io/snaps/reference/permissions/)). `endowment:network-access`
grants `fetch` and nothing more.

So a Snap can never be the thing that opens our transport. That is not an oversight to be
worked around; a sandbox that could reach a USB device would not be a sandbox.

### How the real hardware-ish Snaps do it, and why that matters to us

MetaMask's own documented answer is the **asynchronous flow**: the Snap answers
`keyring_submitRequest` with `{ pending: true, redirect }`, MetaMask opens the redirect URL in a
new tab, and a *companion dapp* — an ordinary web page, with the full web platform available —
does the actual work and resolves the request via `keyring_getRequest` / `keyring_approveRequest`
([docs](https://docs.metamask.io/snaps/features/custom-evm-accounts/)). That companion page
*can* call `navigator.usb` / `navigator.serial`.

Which means a working architecture exists on paper: Snap as the account facade, companion tab as
the transport. But note what it costs. Every signature opens a browser tab. The user's flow is
MetaMask → new tab → plug/select device → confirm on device → back. That is worse than what our
own extension would do, for the sole benefit of the accounts appearing under MetaMask's logo.

### And it is gated anyway

The docs state plainly: **"MetaMask is not currently accepting allowlisting requests for Custom
EVM Account Snaps."** ([custom EVM accounts](https://docs.metamask.io/snaps/features/custom-evm-accounts/)).
An un-allowlisted Snap is not installable by ordinary users from the extension. On top of that,
any Snap doing key management requires a **third-party security audit paid for by the developer**
plus manual review by the MetaMask Snaps team — the audit requirement was relaxed for Snaps that
*don't* do key management, which is not us ([get allowlisted](https://docs.metamask.io/snaps/how-to/get-allowlisted/),
[MetaMask news](https://metamask.io/news/two-exciting-updates-to-metamask-snaps)).

There is a further wrinkle we could not resolve from public docs, and should not guess at: the
security guidelines say a Snap must be "self-contained and does not fetch code from external
sources", and that secrets live in `snap_manageState` — guidance written for MPC/software
signers. **How that reads for a Snap that holds no key at all and only proxies to hardware is
not stated anywhere we could find**, and given the allowlist is shut it is moot today.

**Verdict:** correct in shape, blocked in practice, and even unblocked it would be the *slowest*
integration we could build. Revisit if allowlisting reopens; do not build against it now.

---

## 2. MetaMask's built-in hardware wallets — closed, definitively

MetaMask Extension supports Trezor, Ledger, Lattice, Keystone, NGRAVE ZERO and AirGap Vault
([hardware wallet hub](https://support.metamask.io/more-web3/wallets/hardware-wallet-hub/)).
Each USB device is a keyring class compiled into the extension — e.g.
[`MetaMask/eth-trezor-keyring`](https://github.com/MetaMask/eth-trezor-keyring),
[`Consensys/ledgerhq-metamask-keyring`](https://github.com/Consensys/ledgerhq-metamask-keyring) —
registered in MetaMask's keyring builder list.

Adding a device to that list means a pull request against `metamask-extension`, merged and
shipped by MetaMask, i.e. a business relationship. **It is not open to a third party by any
mechanism.** Be definite about this: there is no plugin point, no local registration, no
sideload. This route is closed and asking about it is answered.

The one exception is the QR keyring, which is §3.

---

## 3. The QR / airgap route — genuinely open, and our hardware can't do it

This is the interesting near-miss, so it is worth being precise about why it fails.

**The mechanism.** MetaMask's QR support is not Keystone-specific plumbing; it is
[ERC-4527](https://eips.ethereum.org/EIPS/eip-4527), a wallet-agnostic protocol carrying
BC-UR-encoded payloads in animated QR codes: `crypto-hdkey` to hand the watch-only wallet an
extended public key, `eth-sign-request` for the unsigned payload, `eth-signature` for `(r,s,v)`
correlated by request ID. MetaMask's implementation is
[`@keystonehq/metamask-airgapped-keyring`](https://www.npmjs.com/package/@keystonehq/metamask-airgapped-keyring),
whose [base package](https://github.com/KeystoneHQ/keystone-sdk-base) is explicitly published for
others to extend. NGRAVE and AirGap Vault ride the same rails, which is the proof it is not a
one-vendor arrangement. Consensys' own framing: a manufacturer adopting the QR standard "can
integrate with MetaMask without ever engaging with MetaMask"
([Consensys](https://consensys.io/blog/metamask-x-keystone-how-to-benefit-from-hardware-wallet-security-using-transparent-qr-code)).

Note ERC-4527 is marked **Stagnant** on eips.ethereum.org. Stagnant means editorially inactive,
not withdrawn — the shipped implementations are what matter, and they are live.

**Why it is out of reach here.** QR signing is bidirectional. MetaMask displays the
`eth-sign-request`; the signer must **read** it. This device has a 128x64 OLED and a QR
*renderer* (T7, address display only) — and **no camera**. There is no image sensor on the board
and nothing in the tree that reads one. A signer that cannot scan cannot participate in ERC-4527,
full stop. Adding a camera is a hardware revision, plus a decoder and multi-frame UR reassembly
on an ESP32-S3, plus rendering multi-hundred-byte animated UR frames on a 128x64 panel — each of
those is a project.

**And it would be a strange fit even then.** ERC-4527 is an *airgap* protocol; its whole value is
never connecting. We have a USB cable and a BLE radio and a session layer (PROTOCOL.md §3) built
on the assumption of a live channel. Bolting on airgap would be a second wallet, not a feature.

**Verdict:** the only MetaMask-blessed route open to us without anyone's permission, and our
hardware disqualifies us. Worth remembering if a revision ever grows a camera. Not now.

---

## 4. Our own extension and EIP-6963 — the one that actually works

### The mechanism

[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) is **Final**. It replaces the old scramble
over `window.ethereum` with an event handshake: wallets dispatch `eip6963:announceProvider`
carrying `{ uuid, name, icon, rdns }` plus an EIP-1193 provider; dapps dispatch
`eip6963:requestProvider` and collect whoever answers. Load order stops deciding who wins, and
the user picks from a list. MetaMask supports it and
[recommends it](https://support.metamask.io/third-party-platforms-and-dapps/connecting-to-dapps-with-eip-6963-multi-wallet-discovery/).

This is the direct answer to "alongside MetaMask": we do not fight MetaMask for the global. We
announce ourselves as `com.leekwallet` — sitting in the same picker, on equal footing, on any
dapp that implements 6963.

An earlier draft of this note stopped there and said we would never touch `window.ethereum` at
all. That was wrong, and §4bis is the correction. 6963 announcement is necessary and it is not
sufficient: the spec itself says wallets **SHOULD** keep `window.ethereum` working for legacy
dapps ([EIP-6963, Backwards Compatibility](https://eips.ethereum.org/EIPS/eip-6963)). The real
question is not *whether* to be present on the global — it is *how much impersonation* the
legacy tail actually requires, and that turns out to be a much smaller and more separable thing
than "clobber the global".

### Reaching the device from an extension

| API | Extension support | Our transport |
|---|---|---|
| WebUSB | Chrome 118+, no manifest permission; `requestDevice()` **cannot** be called from the MV3 service worker — call it from a popup/page, then `getDevices()` in the worker ([Chrome docs](https://developer.chrome.com/docs/extensions/how-to/web-platform/webusb)) | Blocked in practice, see below |
| Web Serial | `navigator.serial` is available in extension **pages**; not in content scripts, and Chrome publishes no MV3 service-worker guidance for it — **unverified**, treat as page-only | The realistic one |
| Web Bluetooth | Chromium extensions only; the spec covers documents, not service workers, so a page context is required ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/BVeLvYX7oEY)) | Possible, awkward |

**The ESP32-S3 detail that decides the USB question.** Our USB is the built-in USB-Serial/JTAG
controller (`src/protocol.c`, `sdkconfig.defaults`), which Espressif describes as
"implemented entirely in hardware… cannot be reconfigured to perform any function other than a
serial port and JTAG"
([ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/usb-serial-jtag-console.html)).
It enumerates as CDC-ACM. On Linux and macOS the kernel's CDC driver claims that interface, so
WebUSB's `claimInterface()` will typically fail — **Web Serial is the correct API for it**,
because Web Serial talks to the OS serial port rather than stealing the interface. (We have not
bench-tested this against a browser; it is inference from the driver model, and should be
verified with a 20-line page before anyone plans around it.) A WebUSB-native path would mean
moving to the S3's separate USB-OTG peripheral and a TinyUSB stack — a firmware project, not a
setting.

Browser reach is Chromium-only for all three APIs: Web Serial arrived in Firefox 151 desktop
(May 2026) and Safari has never implemented any of them
([caniuse: serial](https://caniuse.com/web-serial), [webusb](https://caniuse.com/webusb),
[web-bluetooth](https://caniuse.com/web-bluetooth)). No iOS, ever.

Also note the sync marker: PROTOCOL.md §2 puts `'L','K'` in front of USB frames precisely because
that port carries console output too. An extension transport is a *third* implementation of that
framing after Rust and TypeScript, and it has to get the marker rule right or it looks like
corruption.

### The security question, taken seriously

PROTOCOL.md 6b rejects a built-in dapp browser because untrusted web content should not run in
the process that talks to the signing device. An extension is a different shape of the same
question and deserves the same scrutiny — not a pass for being convenient.

Where it is genuinely better:

- **We render no dapp content.** The extension injects a provider into pages the browser already
  renders and sandboxes. We are not adding a webview; we are adding a message port to one that
  exists and is maintained by people with far more security engineering than us.
- **What crosses is structured JSON-RPC** — the same `eth_sendTransaction`, `personal_sign`,
  `eth_signTypedData_v4` that WalletConnect carries. Identical shape at our boundary.
- **The trust model is unchanged.** The host was never trusted (PROTOCOL.md §1). An extension is
  one more untrusted host. Everything that makes an untrusted host survivable — device-side
  re-serialisation, device-rendered confirmation, refusal outside the decodable set (6bis) —
  applies unmodified.

Where it is genuinely worse, and must be designed for:

- **Every page gets to talk to us.** A content script runs on each site the user visits; the
  provider is reachable from any of them, including outright phishing pages. WalletConnect
  requires a deliberate pairing act; an injected provider is ambient. Per-origin approval,
  persisted, with the origin shown, is not optional.
- **The origin is our claim, not the device's.** The device screen cannot say "uniswap.org" with
  any authority — it only knows what the extension told it. So the origin must never appear on
  the device's confirmation as though the device verified it. Under PROTOCOL.md §6 that is the
  same rule as never rendering a device-supplied string as a security statement, pointed the
  other way.
- **The extension is a supply-chain target.** Wallet extensions get compromised through
  dependencies and through hijacked store listings. Minimal dependencies, reproducible builds,
  a locked-down CSP, and the standing assumption that the extension *will* eventually lie to the
  device — which is precisely why every confirmation is device-rendered from device-parsed state.
- **Persistent USB/BLE permission is a real grant.** Once the user grants the device to our
  origin, the extension can talk to it whenever the browser is open. Device-side confirmation is
  what keeps that from being an unattended signing oracle. It follows that no command which moves
  funds or reveals a secret may ever be reachable without a button press — which is Rule 1, and
  it is load-bearing here in a way it is not elsewhere.

Net: an extension is defensible in a way a dapp browser is not, but only because the device stays
the authority. If it ever becomes tempting to move a confirmation host-side "because the
extension can show a nicer summary", that is 6c, and the answer is no.

---

## 4bis. The MetaMask-compatibility shim, as shipping wallets actually do it

The folklore version is "set `isMetaMask = true`". The real thing is four separable decisions,
and they have very different costs. Rabby is the best source because its page provider is
open ([RabbyHub/page-provider `src/index.ts`](https://github.com/RabbyHub/page-provider/blob/main/src/index.ts));
everything quoted below is read off that file, not remembered.

### The four layers, in increasing order of aggression

**1. Provider-shape compatibility.** Rabby's `EthereumProvider` class carries, as plain fields:

```ts
isRabby? = true;
isMetaMask = true;
_isRabby = true;
...
_metamask = {
  isUnlocked: () => new Promise((resolve) => resolve(this._isUnlocked)),
};
```

So `isMetaMask` is *unconditionally* true — not a toggle, not conditional on MetaMask being
absent. Alongside it: `chainId`, `selectedAddress`, the deprecated `networkVersion`, and the
`_metamask.isUnlocked()` experimental method that some dapps gate on. It also shims `window.web3`
(`window.web3 = { currentProvider: rabbyProvider }`, only `if (!window.web3)`) and fires
`window.dispatchEvent(new Event("ethereum#initialized"))` once ready — the legacy signal for
pages that started before injection. MetaMask's own provider does the same two things
([`@metamask/providers`](https://github.com/MetaMask/providers/blob/main/src/initializeInpageProvider.ts),
`shimWeb3` and `setGlobalProvider`), so these are compatibility, not deception.

**2. Owning the global.** Rabby takes `window.ethereum` with a getter and
`configurable: false`:

```ts
const descriptor = Object.getOwnPropertyDescriptor(window, "ethereum");
const canDefine = !descriptor || descriptor.configurable;
...
Object.defineProperty(window, "ethereum", { get() { return proxyRabbyEthereumProvider; },
                                            configurable: false });
```

with a plain-assignment fallback in the `catch`. The comment in that `catch` is candid:
`// think that defineProperty failed means there is any other wallet`. This is a land-grab, and
it is the thing that generates the bug reports — [RabbyHub/Rabby#2953](https://github.com/RabbyHub/Rabby/issues/2953)
is "Rabby tempers with `window.ethereum` which breaks MetaMask, Phantom and other wallet
extensions"; Phantom did the same and produced the mirror-image report against MetaMask,
[MetaMask/metamask-extension#18113](https://github.com/MetaMask/metamask-extension/issues/18113).

**MetaMask does not do this**, and the asymmetry is worth stating precisely because it is
checkable. `setGlobalProvider` is a bare assignment inside a `try`:

```ts
(window as Record<string, any>).ethereum = providerInstance;
window.dispatchEvent(new Event('ethereum#initialized'));
```

and the `catch` logs "MetaMask encountered an error setting the global Ethereum provider - this
is likely due to another Ethereum wallet extension also setting the global Ethereum provider".
MetaMask loses the race gracefully. Whoever runs last wins, unless someone has made the property
non-configurable, in which case that wallet wins permanently. Load order among extensions is not
something a dapp or a user controls.

**3. A `providers` array.** Coinbase Wallet's extension documents building
`window.ethereum.providers` — an array of every injected provider, each tagged
(`isCoinbaseWallet`, `isMetaMask`) so a dapp can pick
([Coinbase docs](https://docs.cdp.coinbase.com/wallet-sdk/docs/injected-provider), [handling
multiple extensions](https://docs.cloud.coinbase.com/wallet-sdk/docs/injected-provider-guidance)).
This was the pre-6963 coexistence convention. It is superseded, it was never universally
implemented by dapps, and 6963 exists precisely because it did not work.

**4. Full identity impersonation, including over 6963.** This is where Rabby goes further than
the shim. In "MetaMask mode" it deletes its own marker and announces itself under MetaMask's
identity *through the 6963 channel*:

```ts
const announceMetamaskMode = () => {
  rabbyEthereumProvider.isMetaMask = true;
  delete rabbyEthereumProvider.isRabby;
  rabbyProvider.isMetaMask = true;
  delete rabbyProvider.isRabby;
  announceEip6963Provider(rabbyProvider, true);
};
```

and `announceEip6963Provider(provider, true)` swaps the announced `info` wholesale to
`{ name: "MetaMask", rdns: "io.metamask", icon: <MetaMask's fox, base64 SVG> }` under a
separate `uuid`. So a 6963-aware dapp sees a picker entry named MetaMask, with MetaMask's logo,
claiming MetaMask's `rdns`, that is Rabby. Which dapps get this is driven by a **remotely fetched
list**: `metamaskModeService` polls `https://static.debank.com/fake_mm_dapps.json` every 25–30
minutes, plus per-site user overrides
([`src/background/service/metamaskModeService.ts`](https://github.com/RabbyHub/Rabby/blob/develop/src/background/service/metamaskModeService.ts)).

EIP-6963 anticipated exactly this. Its security considerations call `rdns` "self-attested and
prone to impersonation", tell dapps not to use it for feature detection, and suggest watching for
colliding `uuid`s. Anticipating an attack is not blessing it.

### What we should and should not copy

| Layer | Do it? | Why |
|---|---|---|
| EIP-6963 announce as `com.leekwallet` | **Yes** | The standard, and the honest picker entry |
| `window.ethereum` fallback when the global is free | **Yes** | The spec's own SHOULD; the whole legacy tail |
| `isMetaMask = true` on that provider | **Yes, with `isLeekWallet = true` beside it** | See below |
| `_metamask.isUnlocked()`, `window.web3` shim, `ethereum#initialized` | **Yes** | Cheap, and legacy detection paths genuinely check them |
| `Object.defineProperty(..., configurable: false)` | **No** | This is the land-grab, and it is the part that breaks other people's wallets |
| Overwriting a global another wallet already set | **No** | Never assign over an existing `window.ethereum` |
| `window.ethereum.providers` array | **No** | Superseded by 6963; adding to someone else's provider object is worse than leaving it alone |
| Announcing over 6963 as `io.metamask` | **No** | 6963 is precisely the channel where identity is supposed to be true |

The line that falls out of this: **be honest wherever the user can see us, be compatible only
where nobody is looking.** `rdns: "com.leekwallet"`, name "LeekWallet", our own icon, always.
`isMetaMask: true` is a *capability* claim read only by dapp code — "this provider speaks the
dialect MetaMask defined" — and MetaMask's own documentation concedes the field means nothing
stronger: it notes plainly that "non-MetaMask providers may also set this property to `true`"
([provider API](https://docs.metamask.io/wallet/reference/provider-api/)). A user who opens a
connect modal must never see the fox where we are.

### Concretely, what our injected script does

1. Read `Object.getOwnPropertyDescriptor(window, 'ethereum')`. **If it exists, stop.** Do not
   assign, do not wrap, do not push onto `.providers`. We are 6963-only on that page. This one
   rule is the whole difference between us and the bug reports above.
2. If it does not exist, `window.ethereum = leekProvider` by **plain assignment** — writable and
   configurable, so a later wallet can take it and nothing we did is permanent. Then dispatch
   `ethereum#initialized`.
3. Shim `window.web3 = { currentProvider }` only `if (!window.web3)`.
4. Provider fields: `isLeekWallet: true`, `isMetaMask: true`, `chainId`, `selectedAddress`,
   `networkVersion`, `_metamask.isUnlocked()`. EIP-1193 `request()`, `on`/`removeListener`, and
   the events dapps actually bind: `connect`, `disconnect`, `chainChanged` (hex string chain id,
   *not* a number — this is the shape mistake that breaks dapps), `accountsChanged` (array,
   empty when locked or unapproved).
5. Announce 6963 as `{ name: "LeekWallet", rdns: "com.leekwallet", uuid, icon }`, on load and
   again on every `eip6963:requestProvider`. Never under any other `rdns`.
6. Make the shim **switchable off**, defaulting on, with the state visible in the extension. A
   user who wants to run MetaMask untouched should be one toggle away, and step 1 already means
   the toggle rarely matters.

### Does the shim still pay for itself?

Less than it did, and not zero. EIP-6963 is Final and support in the connect stacks is not
partial — it is the default path:

| Stack | Status |
|---|---|
| wagmi v2 | `multiInjectedProviderDiscovery` defaults to `true` ([createConfig](https://wagmi.sh/react/api/createConfig)) |
| RainbowKit v2 | 6963 wallets auto-appear under "Installed"; connectors carry `rdns` ([migration guide](https://rainbowkit.com/docs/migration-guide)) |
| ConnectKit 1.6.0 (Jan 2024) | 6963 via `mipd` ([changelog](https://family.co/changelog/2024-01-10)) |
| Reown AppKit (ex-WalletConnect/Web3Modal) | supported |
| MetaMask's own guidance | recommends 6963 for connecting; `@metamask/detect-provider` is deprecated ([npm](https://www.npmjs.com/package/@metamask/detect-provider)) |

So any dapp that has updated its connect kit since 2024 finds us without the shim. The tail is
dapps pinned to older wagmi/web3modal, and — the more stubborn category — dapps with
hand-rolled `if (window.ethereum) ... else "please install MetaMask"` code that no library
upgrade will ever fix. **We could not find a credible measurement of how large that tail is
today**, and we decline to invent one; the honest statement is that it is shrinking, that it is
concentrated in unmaintained dapps, and that the shim's cost to us is roughly forty lines given
we are building the provider anyway. Forty lines for an unknown-but-nonzero share of dapps, at
no cost to anyone else because of rule 1 above, is worth it.

### And the security question the shim does not answer

Being reachable as `window.ethereum` widens nothing that §"the security question" below does not
already cover — the ambient-provider problem is created by *injecting at all*, not by the name we
inject under. It is not softened by the conclusion changing. Two things specific to the shim:

- **`isMetaMask: true` makes us reachable by phishing pages written against MetaMask**, which is
  most of them. A drainer page that does `window.ethereum.request({ method:
  'eth_sendTransaction', ... })` reaches us with no adaptation. Per-origin approval and
  device-rendered confirmation are what stand between that and a loss; the shim removes an
  accidental barrier that was never a security control in the first place.
- **What the device's screen fixes, and what it does not.** It fixes: what is being signed, to
  whom, for how much — the device parses and renders it, so the extension cannot lie about the
  payload (Rule 1, PROTOCOL.md §1). It does **not** fix: which page is asking. The device has no
  way to verify an origin, so origin remains an extension-level claim and origin-approval remains
  a host-side control that a compromised extension can forge. A user who approves a transaction
  they misread is not rescued by any of this. The shim does not change either half; it just means
  more pages can start the conversation.

---

## 5. WalletConnect, fairly

Already chosen and being built, so the fair test is where it actually loses — not a
justification written after the fact.

**Where WalletConnect wins:** it works from any browser on any OS, including Safari and iOS,
where none of the device APIs exist. It needs no browser extension and no store review. Pairing
is explicit — the user scans or pastes a URI, so no page gets ambient access. One implementation
serves desktop and mobile. And the code already exists (ROADMAP T32).

**Where it loses:** a relay is a third party in the path, seeing connection metadata (encrypted
payloads, never keys) and requiring a WalletConnect Cloud project ID and network access —
already acknowledged in 6b, but it is a dependency and an availability risk we do not control.
The flow is clumsier: scan a QR, keep the companion app running, watch two windows. Dapp support
for WalletConnect is broad but not universal, and some dapps still assume an injected provider.
And it puts our app in the path as a long-lived network-connected process, whereas the extension
route makes the browser that process.

**Where the extension wins outright:** dapps that only speak injected providers; a
plug-in-and-go flow with no phone and no QR; no relay, no project ID, no third-party
availability dependency; and appearing in the EIP-6963 picker next to MetaMask, which is the
closest thing to the original request that actually exists.

They are not exclusive. Same JSON-RPC surface, same device protocol underneath — the extension is
a second front end onto the transport we already have, not a second wallet.

---

## 6. Recommendation

**Build our own extension, dual-mode: announce over EIP-6963 as `com.leekwallet`, *and* install a
MetaMask-compatible provider on `window.ethereum` when — and only when — the global is unclaimed.
Reach the device over Web Serial.** Ship it after WalletConnect, not instead of it. It is the only
route open to us today without anyone's cooperation, and it is the only one that puts us in the
same picker as MetaMask.

The dual-mode half of that is a correction to an earlier draft, which refused the global outright.
The refusal conflated two things: *taking* the global from other wallets, which is the actual
antisocial act and which we still refuse, and *filling* it when nobody else has, which EIP-6963's
own Backwards Compatibility section says wallets SHOULD do. §4bis has the mechanism.

Order of work, if it is taken up:

1. Verify the transport before designing anything on top: a 20-line page that opens the
   USB-Serial/JTAG port with `navigator.serial`, sends `'L','K'`-framed `ping`, and reads the
   reply. If that fails on Linux or macOS, everything above it changes.
2. EIP-6963 announce plus the small provider surface: `eth_requestAccounts`, `eth_accounts`,
   `eth_chainId`, `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`. Nothing else.
3. Per-origin approval with persisted grants and a visible origin. Before any signing path works.
4. Only then the legacy shim (§4bis), behind a toggle, gated on the
   `getOwnPropertyDescriptor(window, 'ethereum')` check. It is the last thing built, because it is
   the thing that widens who can reach us.
5. Reuse `@leekwallet/core` for framing, session and decoding, so the extension cannot end up
   more permissive than the device (the discipline of PROTOCOL.md 6e, applied to a third client).

**What I would not do:**

- **Not the Snap.** Allowlisting is shut, key-management Snaps need an audit we pay for and a
  manual review we do not control, and the resulting UX — a new tab per signature — is worse than
  our own extension for the sole gain of MetaMask's branding. Revisit only if allowlisting
  reopens.
- **Not a MetaMask keyring PR.** Not a technical decision; it requires MetaMask to ship our code.
- **Not the QR/airgap route.** No camera. It is a hardware revision and a second protocol, and it
  contradicts the connected design we already have.
- **Not *taking* `window.ethereum`.** Never `defineProperty` it non-configurable, never assign
  over a provider another wallet already installed, never add ourselves to someone else's
  `.providers` array. Fill the global only when it is empty, and leave it writable so the next
  wallet can have it. This is the specific behaviour that earns Rabby and Phantom their bug
  reports, and none of the compatibility benefit requires it.
- **Not impersonating anyone where the user can see it.** No `rdns: "io.metamask"`, no MetaMask
  name or fox in a picker entry, no remotely-fetched list of dapps to impersonate on. Rabby does
  all three; that is the line we do not cross. `isMetaMask: true` on the provider object is a
  dialect claim read by code, and MetaMask's own docs say the field guarantees nothing.
- **Not a dapp browser, in the extension or anywhere else.** 6b stands unchanged.
- **Not moving any confirmation host-side.** The extension is a nicer keyboard and a bigger
  screen. It is still not an authority.

---

## Could not confirm

Stated plainly rather than papered over:

- **Web Serial in MV3 service workers.** Chrome documents the WebUSB and WebHID service-worker
  rules explicitly; we found no equivalent for Web Serial. Assume page context only until tested.
- **Whether the USB-Serial/JTAG CDC port is reachable via `navigator.serial` on each OS.** Inferred
  from the kernel CDC driver model, not measured. Step 1 above exists for this reason.
- **How the "self-contained, no external code" account-Snap guidance applies to a Snap that holds
  no key and proxies to hardware.** Not addressed in the public docs.
- **Whether the Custom EVM Account Snap allowlist has any published reopening date.** The docs say
  only that requests are not being accepted.
- **How large the non-6963 dapp tail actually is.** Every connect kit that matters supports 6963
  by default, but we found no measurement of what share of live dapps still detect wallets by
  hand. The shim is justified on cheapness and on the existence of the tail, not on its size.
  If someone measures it and it is negligible, drop the shim — the argument is that thin.
- **MetaMask's stated position on `isMetaMask` impersonation.** We found the technical concession
  ("non-MetaMask providers may also set this property to `true`") and the deprecation push toward
  6963, but **no statement approving or forbidding the practice**, and nothing in the extension's
  terms or brand guidelines that we could locate. So: widely done, technically anticipated,
  **not sanctioned** — treat it as tolerated, not permitted. Announcing under `io.metamask` is a
  different matter and is at least a trademark question; we are not doing it, so we did not
  research it further.
- **Whether MetaMask reacts to a foreign `isMetaMask` provider.** We read `setGlobalProvider` and
  saw only the plain assignment and the error log; we did not test two extensions side by side.
- **Coinbase Wallet's and Phantom's current behaviour.** Both are closed-source extensions; the
  `providers`-array and global-override claims here come from Coinbase's own docs and from the
  MetaMask/Phantom issue threads, not from reading their shipping code.
- **Rabby's `fake_mm_dapps.json` contents.** We read the fetching service, not the list. Whether
  it is small and targeted or broad is unknown, and it can change without a release.
