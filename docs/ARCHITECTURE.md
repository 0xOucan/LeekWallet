# Architecture

How a transaction gets signed, and which part of this system is trusted.

---

## The one idea

**Two gates, and only one of them is trusted.**

The companion renders a preview from ERC-7730 descriptors. That preview is
explicitly *untrusted* — it runs on a general-purpose computer that may already
be compromised, and the UI says so in those words. The device decodes the raw
calldata **independently**, with its own table, and draws what it found. No
descriptor is ever sent to the device: nothing the host says can change what
the screen shows.

If the device cannot read a call, it refuses it. That refusal is the product.

```mermaid
flowchart LR
    subgraph HOST["Companion — NOT trusted"]
        APP["Caller<br/>WalletConnect · send · dapp"]
        SCREEN["screenProposal<br/>ERC-7730 descriptors"]
        APP -->|"proposal"| SCREEN
    end

    subgraph DEV["LeekWallet device — trusted"]
        DEC["eth-decode.c<br/>its own decoder"]
        PAGES["ui.c<br/>one page per field"]
        KEY["seed · AES-256-GCM v3<br/>never leaves"]
        DEC --> PAGES --> KEY
    end

    SCREEN -->|"to · value · data · gas · chainId · nonce<br/><b>no descriptor</b>"| DEC
    KEY -->|"signature"| HOST
    HOST -->|"broadcast"| CHAIN["Base · Hedera · Arc"]

    style DEV fill:#1b5e20,color:#fff
    style HOST fill:#4e342e,color:#fff
```

> **Note, 2026-09-17.** The hackathon mini-apps (aqua, ats, till) were removed.
> The seam they used, `app-proposal.ts` and `screenProposal`, remains and is
> what WalletConnect and the send flow use, so the diagrams below still
> describe how a call reaches the device. The per-track flow sections are kept
> as worked examples of the three decoding tiers, not as shipping features.

**Consequence:** supporting a new contract call means extending the *device*,
not the app. A host-side descriptor alone cannot make a call signable — proven
the hard way when the escrow market's `fill()` was refused by the firmware even
with a valid descriptor in place.

---

## The three tiers of decoding

| tier | cost | examples |
|---|---|---|
| **Static-typed** — one row in the firmware's table, no code | trivial | `fill(uint256)`, `list(address,uint256,uint256)`, `transfer`, `approve` |
| **Dynamic-typed** — a hand-written decoder, its host mirror, device pages, and shared vectors | days | Aqua `ship`/`dock`, `deployEquity(string,string)` |
| **Unknown** — blind signing, **off by default, switchable only on the device** | opt-in | anything else |

Blind signing exists because a wallet that decodes nothing new is unusable, and
a wallet that decodes everything is trusting somebody else's description. The
toggle lives on the device precisely because *a host that can disable the
protection is the host it was protecting you from.*

The firmware decoder and its TypeScript mirror are held together by **52 shared
vectors** emitted from the C code and replayed against the host
(`packages/core/test/eth-decode-vectors.json`), comparing decoded *content* —
not merely accept/reject.

---

## System layout

```mermaid
flowchart TB
    subgraph FW["Firmware — ESP32-S3 · ESP32-C3"]
        PROTO["protocol.c<br/>JSON-RPC, permission tiers"]
        SESS["session.c<br/>encrypted channel, passkey"]
        ETH["eth-decode.c · eth-tx.c<br/>ETH_MAX_DATA 768"]
        UI["ui.c — 240×240 / OLED"]
        WAL["colibri-wallet<br/>BIP39/32/44"]
    end

    subgraph CORE["packages/core — the seam"]
        PROP["app-proposal.ts<br/>DEVICE_DRAWN_KINDS"]
        D7730["erc7730.ts"]
        MIRROR["eth-decode.ts<br/>mirror of the C decoder"]
        CHAINS["chains.ts · balances.ts"]
    end

    subgraph APPS["Mini-apps — no keys, no transport"]
        AQ["aqua<br/>1inch Aqua / SwapVM"]
        AT["ats · ats-market<br/>Hedera ATS"]
        TI["till · waiter · payroll<br/>Arc"]
    end

    APPS --> CORE --> PROTO
    PROTO --> SESS --> ETH --> UI
    ETH --> WAL
    MIRROR -. "52 shared vectors" .-> ETH

    style FW fill:#1b5e20,color:#fff
```

A mini-app **cannot** reach a key, a transport or the device. It builds
calldata and hands it to `screenProposal`; everything else is the shell's.
`app/test/apps.test.ts` enforces that, including that no app imports another
and that each carries its own CSS so it can be deleted whole.

---

## Per-track flows

### Hedera — issuance from a 240×240 screen

The ATS factory's `deployEquity` is a seventeen-field nested struct and **3,748
bytes**. The device holds 768 and refuses more. Raising the limit would not
help: a screen that says *"deploy equity, approve?"* over 3.7 KB nobody can
read is blind signing with better manners.

```mermaid
sequenceDiagram
    participant U as You
    participant C as Companion
    participant D as Device
    participant F as LeekSecurityFactory
    participant A as ATS Factory

    U->>C: name + symbol
    C->>D: deployEquity(string,string) — 196 bytes
    D->>D: decode · check printable ASCII · bounds
    D->>U: 3 pages — "you become issuer, ALL roles" · name · symbol
    U->>D: press
    D->>C: signature
    C->>F: broadcast
    F->>A: the frozen 3,748-byte template
    A-->>F: new security, 12 roles to msg.sender
```

The template lives in verified on-chain code, so **name and symbol are not a
summary of the decision — they are all of it.** That is the only condition
under which drawing a call is not blind signing.

### Arc — payroll as two transactions per person

Salary and tips are sent **separately, on purpose**. Tips are not wages: they
are frequently owed to a pool, taxed differently and disputed separately. One
blended transfer is a number nobody can reconcile afterwards; two are two lines
in a ledger. Each is its own device screen and its own confirmation.

```mermaid
flowchart LR
    CSV["CSV<br/>name,role,address,salary,tips"] --> P["staff.ts<br/>parser as a security boundary"]
    P --> PLAN["payroll.ts<br/>2 legs per person"]
    PLAN --> D1["device: salary → Ana"]
    PLAN --> D2["device: tips → Ana"]
    PLAN --> D3["device: salary → Beto"]
    PLAN --> D4["device: tips → Beto"]
    D1 & D2 & D3 & D4 --> ARC["Arc · USDC / EURC / cirBTC"]
```

The CSV parser is treated as a security boundary because it is one: an
attacker-controlled file that ends in a transfer amount. It refuses rather than
coerces.

### 1inch Aqua — the device reads the program

```mermaid
flowchart LR
    T["tier-plan.ts<br/>pair · tier · mid"] --> PR["program.ts<br/>SwapVM bytecode"]
    PR --> DEP["deploy.ts<br/>capped approval, never unlimited"]
    DEP --> DEV["device<br/>one page per instruction"]
    DEV --> REG["Aqua registry"]
    REG --> FILL["taker fills via SwapVM router"]
```

A program the device cannot read **in full** refuses the whole ship. There is no
state where the legs are shown beside a program the device gave up on.

---

## What is deliberately not here

- **No key ever leaves the device.** The companion holds none.
- **No descriptor reaches the device.** It decodes independently.
- **No mini-app touches a transport.** The seam is `app-proposal.ts`.
- **No blind signing by default**, and no host command can enable it.
- **No balance is claimed as zero when it could not be read.** Unreadable and
  empty are different facts throughout.


---

## The QR air gap is a second entrance, not a third transport

Decided while reading this code, and worth writing down because the obvious
guess is wrong.

`docs/PROTOCOL.md` §2 frames every message as `len:u16 | type:u8 | CBOR`, with
no request IDs, and §3b says the device exposes **one transport at a time**
because the session layer is single-peer and a reply belongs to whichever
request went out last. A QR channel could carry those same frames — and then
nothing else would change.

**It should not.** Carrying our own frames over QR would make LeekWallet
unable to talk to any other wallet, and the whole reason to pick BC-UR and
EIP-4527 is that Keystone, AirGap, imToken and others already speak it. So:

```
USB / BLE ──► protocol.c frames ──┐
                                  ├──► eth-decode.c ──► ui.c pages ──► sign
QR (BC-UR / EIP-4527) ────────────┘
```

Two entrances, one decision path. What that costs and what it must not cost:

- **It converges at the decoder, not before it.** An `eth-sign-request` becomes
  the same `EthTx` the USB path produces, and from there every rule in this
  document applies unchanged: the device decodes, the device draws, the device
  refuses what it cannot read.
- **It has no session, and does not need one.** §3's passkey defends against an
  active MITM on a live channel. There is no live channel: a QR carries a
  self-contained request, and the user is looking at both screens. The session
  code is not weakened, it is **not used** on this path.
- **QR joins the one-transport-at-a-time selector** as a third setting, and
  becomes the default on the CAM board. §3b's three reasons all still hold, and
  the third one - "a device listening on BLE while plugged into USB is reachable
  by someone you cannot see" - is the whole argument for the radios being off
  until a deliberate act turns one on.
- **`ETH_MAX_DATA` is 768**, and that bound now does a second job: it caps what
  a QR animation has to carry. A signing request cannot exceed roughly a
  kilobyte, which is a dozen or so fountain fragments. The refusal that made
  ATS's 3,748-byte `deployEquity` undrawable is the same refusal that keeps the
  air gap fast.
