# Releasing, reproducing, and signing

**Status: both the firmware and the companion app are reproducible and verified
as such locally, with one documented caveat on the companion (the build path is
part of the recipe). No release has been published, and the CI job that checks
this has never run** — this repository has no remote. ([T37](../ROADMAP.md))

This document exists because of one sentence in
[CAMERA-OPTIONS.md](CAMERA-OPTIONS.md) §9: *whoever assembles and flashes a
device becomes its buyer's trust anchor.* Everything this project does to avoid
trusting a host computer is undone if the firmware on a posted board is not the
firmware that was published, and a buyer has no way to tell by looking.

So the goal here is narrow and checkable: **make the published binary a
function of the published source**, so that the maintainer's word is not the
only evidence.

---

## What is actually true today

There are two things a user downloads — the firmware and the companion app —
and they have different answers, so they get separate sections. One script asks
both questions:

```bash
./scripts/repro-verify.sh              # firmware + companion
./scripts/repro-verify.sh firmware     # delegates to repro-check.sh
./scripts/repro-verify.sh companion
```

### The firmware

Two builds of the same commit, from two different directories, produce
byte-identical `firmware.bin`, `bootloader.bin` and `partitions.bin`. Verified,
not assumed:

```bash
./scripts/repro-check.sh
```

It builds one commit twice from two clones with deliberately different path
lengths and compares the artefacts. Two paths rather than two runs in one
directory, because an absolute path baked into a binary passes the easy version
of that test.

### What had to be fixed to get there

Measured before the fix: `firmware.bin` differed in **67 of 1,118,064 bytes**
and `firmware.elf` in exactly **3**. One cause, three symptoms:

| Divergence | Cause | Fix |
|---|---|---|
| `esp_app_desc_t.time` (0x70) and the bootloader's date/time | ESP-IDF stamps wall-clock build time into both images | `CONFIG_APP_REPRODUCIBLE_BUILD=y` |
| ELF SHA-256 recorded at 0xb0 | consequence of the above — the ELF contains the same stamp | same |
| the SHA-256 appended to the image | consequence of the two above | same |

Notably **nothing else diverged**: no absolute paths in the flashed binaries,
no link ordering, no archive mtimes, no `__DATE__`/`__TIME__` in this project's
own source. The toolchain was already deterministic; only the timestamps were
not. `CONFIG_APP_REPRODUCIBLE_BUILD` also remaps source paths in debug info,
which matters for the ELF but not for what gets flashed.

A second, opposite bug was fixed at the same time. `PROJECT_VER` — the short
commit hash stamped into the image — is computed by `git describe` at CMake
*configure* time, and nothing in the generated ninja graph depended on git
state. So after a new commit, an incremental build kept reporting the previous
hash: a build made at `f90755c` still said `1e9231d`. `CMakeLists.txt` now
watches the reflog (via `git rev-parse --git-path`, so it works in a worktree)
and forces a reconfigure when HEAD moves. A binary that misreports its own
provenance is exactly the failure this whole document is about.

The commit hash is deliberately **kept** in the image rather than stripped for
reproducibility. It is a function of the commit, so it is reproducible for
anyone building that commit, and a binary that cannot name its source is worse
than one whose bytes depend on it.

### The companion app

This is the newer half of the answer, and it matters for a reason the firmware
section does not cover. The plan is to publish the companion as GitHub releases
for Linux, Windows and macOS, and to put a firmware flasher inside it
([T65](../ROADMAP.md)). A flasher is a program that writes to the device the
wallet exists to protect, shipped as a binary that almost nobody will build
themselves. A checksum beside that download proves only that the download is
intact; without a reproducible build it says nothing about which source
produced it, and the flasher's authority over the device would rest on nobody
having checked.

Two artefacts are compared, and both are byte-identical across two clean
builds of the same commit:

| Artefact | Result |
|---|---|
| `dist/` — the Vite bundle, all 7 files | identical |
| `target/release/leekwallet-companion` | identical |

The Vite bundle turned out to need nothing at all. Built from two clones at two
paths of different length, every output file matched on the first attempt,
content hashes and all — Rollup's filename hashes are derived from content and
nothing in the pipeline stamps a time. `pnpm-lock.yaml` was already committed
and `--frozen-lockfile` is what CI and these scripts use, so the dependency
tree is pinned rather than resolved afresh per build.

The Rust binary needed a pin and a documented build path. `app/rust-toolchain.toml`
now pins rustc, for the same reason `platformio.ini` pins the firmware's
compiler: "rebuild the tag and compare" needs one answer to *which compiler*,
or a mismatch that really means "you have a newer rustc" is indistinguishable
from a mismatch that means the binary is not from this source.

#### The one caveat: the Rust build path is part of the recipe

The same commit built at `/tmp/reprox/a` and at
`/tmp/reprox/build-two-with-a-much-longer-name-here` does **not** produce the
same library. This was measured rather than assumed, and the shape of the
difference is the interesting part:

| Section | Result |
|---|---|
| `.text` | **same**, 233 843 bytes |
| `.rodata` | **same**, 18 536 |
| `.data.rel.ro`, `.data` | **same** |
| `.eh_frame` | differs, same size — reordered |
| `.gcc_except_table` | differs, 765 556 vs 765 580 bytes |

The compiled code is identical. Only the unwind and exception-handling tables
move, and the 24-byte size change shifts every section header after it, which
is why a plain `cmp` reports 677 830 differing bytes and looks catastrophic
when it is not.

What it is **not**: an embedded path. `strings | grep` finds zero occurrences
of the build directory in either binary. `--remap-path-prefix` was tried over
the manifest directory, the workspace root and `$HOME/.cargo`, and changed
neither hash by a single byte — the useful negative result, because it means
there is nothing being embedded for a remap to rewrite. What the path actually
changes is cargo's `-C metadata` hash, which is derived from the absolute
manifest path and feeds codegen-unit names; different object file names give a
different link order, and the concatenated tables come out in a different
order.

There is no stable-Rust flag that fixes this — `-Ztrim-paths` is nightly and
addresses embedding, which is not the problem here. So the fix is the one the
wider ecosystem uses, Debian included: **make the build path part of the
published recipe.** `scripts/repro-verify.sh` runs both passes in
`/tmp/leekwallet-repro-build` (override with `LEEK_REPRO_ROOT`), and a third
party reproducing a release must build there too.

This is a genuinely weaker property than the firmware's and is not worth
dressing up. The firmware is a function of its source. The companion is a
function of its source *and* a path that both parties have to agree on in
advance. Setting `LEEK_REPRO_VARY_PATH=1` runs the two-path version anyway; it
is expected to fail on the Rust artefact, and it exists so this section stays a
measurement anyone can re-take rather than a paragraph that quietly rots.

#### What is not checked on the companion

The **packaged installers** — `.deb`, `.AppImage`, `.msi`, `.dmg`. `tauri build`
produces those by shelling out to `dpkg-deb`, WiX and `hdiutil`, none of which
this project controls and at least two of which stamp their own timestamps into
the archive. What `repro-verify.sh` checks is the executable that goes inside
the package, which is the part this repository's source determines. Reproducible
*packaging* is a separate and harder problem, and claiming it here would be
claiming something nobody has measured.

`SOURCE_DATE_EPOCH` is exported by the release and verify scripts, set to the
commit's own timestamp so it is a function of what is built rather than of when
someone pressed the button. Nothing in the two artefacts above currently reads
it. It is set anyway, so that a packaging step which starts honouring it does
not silently reintroduce wall-clock time first.

### What is not true

- **Reproducible across toolchain versions: no.** A different ESP-IDF or
  compiler produces different bytes for reasons unrelated to this source.
  `platformio.ini` pins `espressif32@6.12.0` (ESP-IDF 5.5.0, toolchain 14.2.0)
  precisely so that "rebuild the tag" has one answer. Moving that pin is a
  deliberate act that produces a new release with new hashes.
- **Reproducible across operating systems: unverified.** It has only been
  checked on Linux x86-64. The pinned toolchain is the same binary everywhere
  PlatformIO supports, so it is likely, but likely is not verified and this
  document does not claim it.
- **Bit-for-bit identical to a `docker`-less clean-room: unverified.** There is
  no hermetic build environment here; the check controls the path and the
  toolchain version, not the whole machine.

---

## Cutting a release

```bash
git tag -s v0.3.0 -m "v0.3.0"          # signed tag; the tag is a claim too
./scripts/release.sh v0.3.0            # default, unsigned firmware
./scripts/release.sh v0.3.0 esp32s3-secure   # the signed, shippable one
```

`scripts/release.sh` clones the tag into a temporary directory and builds
there, so a release cannot contain an uncommitted edit — that is enforced,
not remembered. Output lands in `release/<tag>/<env>/` (git-ignored).

For the secure environment it then runs `scripts/preflight-secure.sh`, which
already owns every rule about the signing key, and refuses to publish if that
refuses. There is deliberately no second copy of those checks here; two
definitions of "the key is safe to use" would drift.

### What a release publishes

| File | What it is |
|---|---|
| `firmware.bin`, `bootloader.bin`, `partitions.bin` | what gets flashed |
| `*-signed.bin` (secure env only) | the same, with secure boot v2 signatures |
| `SHA256SUMS` | hashes of every `.bin` above |
| `SHA256SUMS.asc` | detached GPG signature over `SHA256SUMS`, made by hand |
| `leekwallet-<board>-<version>.bin` | the same three, merged into one image flashed at offset `0x0` |
| `manifest-fragment.json` | the entry the website's flasher manifest expects, hash included |
| `BUILDINFO` | tag, commit, environment, platform pin, rebuild instructions |
| `secure_boot_signing_key.pub` + its digest | the *public* half only (secure releases) |

The **merged image** is a repackaging and not a fourth artefact to be trusted
on its own: `esptool.py merge_bin` pads the three binaries into their flash
offsets and adds nothing else, so it is reproducible for the same reason they
are, and it is listed in `SHA256SUMS` beside them so a verifier can check
either form. It exists because the three parts go to three different offsets
and a user who transposes two of them gets a board that no longer boots and no
error message saying why. The web flasher writes one file for that reason.

The **manifest fragment** is emitted so that publishing the website is a copy
rather than a transcription. `../leekwalletwebsite/assets/firmware/manifest.json`
carries a `releases` array; the fragment is written as a whole manifest holding
one element of it, so merging is inserting an array element rather than
reshaping anything:

```json
{"releases": [{"id": "s3-0.1.0", "board": "s3", "version": "0.1.0",
               "file": "leekwallet-s3-0.1.0.bin", "sha256": "...", "size": 1234}]}
```

It is written into the release output directory and merged, by hand, in the
website repository —
`release.sh` deliberately never writes outside `release/`, because a script
that edits a sibling checkout is convenient once and inexplicable later. The
reason it is generated at all is the hash: the flasher re-checks the SHA-256
after downloading, so a digit mistyped into the manifest fails loudly on a
perfectly good binary, which is precisely how users learn to click past
warnings.

Sign the manifest, not each binary. `SHA256SUMS` covers the binaries and the
signature covers `SHA256SUMS`, so one signature is enough and there is one
place to look — a verifier given four separate signatures runs one of them.

`scripts/release.sh` will do it, given a key id:

```bash
LEEK_SIGNING_KEY=0xDEADBEEF ./scripts/release.sh v0.3.0 esp32s3-secure
```

or by hand, which is the same thing:

```bash
cd release/v0.3.0/esp32s3-secure
gpg --armor --detach-sign SHA256SUMS
```

Signing is opt-in rather than automatic on purpose: a script that signs by
default signs a build nobody has looked at yet. The intended order is build,
read the hashes, then sign, and an explicit variable makes that the easy order.
When it does sign, it uses `--local-user` rather than `--default-key` — an
absent key must fail loudly rather than produce a signature from whatever the
keyring lists first, because a signature by the wrong key is worse than no
signature, it just looks like one — and it verifies what it wrote before
reporting success, so a signature over an earlier draft of the manifest cannot
ship.

The script will never generate a key, never print or copy key material, and
writes only into `release/`, which is `.gitignore`d. Creating the signing key
is a human act performed once (`gpg --full-generate-key`), off this machine
if possible; the only thing that crosses into automation is a key *id*, which
is public by construction.

**Never published, in any form:** `secure_boot_signing_key.pem`. It is
`.gitignore`d along with `*.pem`, and `preflight-secure.sh` fails outright if
git is tracking it — that check treats a tracked key as already compromised,
which it is. There is no example key in this repository; if one is ever added
it must contain the word `PLACEHOLDER`, which the same pre-flight rejects on
content rather than filename, so renaming it is not a way round.

---

## Where the signing key lives

Restating [BURN-PROCEDURE.md](BURN-PROCEDURE.md) only where releases change the
picture:

- The secure boot key is **RSA-3072**, generated once, and burned as a digest
  into every board's eFuses. Every board built from it trusts exactly that key,
  forever. Lose it and no board can ever be updated; leak it and secure boot
  protects nothing on any board already shipped.
- It belongs on **offline removable media**, mode `600`, never inside the
  worktree except during a burn, and never in a backup that syncs anywhere.
  Point `CONFIG_SECURE_BOOT_SIGNING_KEY` at an absolute path on that media.
  `scripts/release.sh` deliberately does not copy the key into its build clone
  — a release script that moves keys around is how keys end up in tarballs.
- The **GPG key that signs `SHA256SUMS`** is a different key with a different
  job: it says who published a file. It can live on a normal machine, ideally a
  hardware token. Do not reuse the secure boot key for it; they have different
  exposure and different consequences when lost.
- If the secure boot key is ever suspected leaked, say so publicly and stop
  shipping boards from it. Secure boot v2 allows up to three key digests per
  board, so a *future* batch can move to a new key — but boards already burned
  cannot revoke the old one, and pretending otherwise would be the dishonest
  version of this paragraph.

---

## Keys, and where they are not

Four different keys could plausibly touch a release. This project holds two of
them, deliberately does not hold the other two, and the distinctions matter
more than the mechanics.

| Key | Held? | Signs | Says |
|---|---|---|---|
| Secure boot (RSA-3072) | offline, once burned | firmware images | which firmware a *board* will boot |
| GPG release key | maintainer, off build machines | `SHA256SUMS` | who published a file |
| Android release keystore | maintainer + one CI secret | the APK | this update came from the same author as the last one |
| macOS / Windows code-signing | **no** | — | an identity paid a certificate authority |

Nothing in this repository generates any of them, and no script or workflow
prints, exports or copies key material. The only values that cross into
automation are a GPG key *id*, which is public by construction, and an Android
keystore that a human created elsewhere and stored as an encrypted secret.

### The Android release keystore

Android refuses to install an unsigned APK, and it refuses to install an update
signed by a different key than the one already on the phone. That second rule
is the one that makes the keystore load-bearing: **lose it and existing users
cannot update.** They must uninstall — which deletes the app's data — and
install a new package under a new signing identity, which is indistinguishable
from an attacker's package as far as the phone is concerned. Treat it with the
care the secure boot key gets, minus the eFuse finality.

Creating it is a human act performed once, off any build machine, and this
document deliberately does not do it for you:

```bash
keytool -genkeypair -v -keystore leekwallet-release.keystore \
        -alias leekwallet -keyalg RSA -keysize 4096 -validity 10000
```

Then, and only then, put it where CI can read it:

```bash
base64 -w0 leekwallet-release.keystore    # paste into the secret, then clear the terminal
```

Four repository secrets, under Settings → Secrets and variables → Actions:

| Secret | Contents |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the base64 of the keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `leekwallet`, or whatever alias was used |
| `ANDROID_KEY_PASSWORD` | the key password |

The signing configuration itself lives in `app/src-tauri/gen/android`, which is
**generated and not tracked** — `tauri android init` writes it, and it is
regenerated on every release run for the reason app/ANDROID.md gives: a
committed copy becomes the truth and silently ignores `tauri.conf.json`. A
generated tree cannot carry a hand-made signing block, so
`scripts/android-release-signing.sh` re-applies one: it writes
`keystore.properties` from four environment variables and adds a `release`
signingConfig to the generated `build.gradle.kts`, unless the template already
has one. It never creates a keystore and never prints one.

That the build files *say* "signed" is not the claim worth making, so the
workflow ends the job with `apksigner verify --print-certs` on the finished
APK. An APK that was not signed installs nowhere, and learning that here is
much cheaper than learning it from the first user who tries. The certificate
digest it prints is public by construction, and is the value to compare across
releases to see that the signing identity has not changed.

`.github/workflows/release.yml` decodes the keystore into `$RUNNER_TEMP`,
never into the workspace — a keystore inside the checkout is one `git add -A`
away from being in the repository forever — and deletes it in an `if: always()`
step so a failed build does not leave it on a runner's disk. If the secret is
absent the Android job **fails** rather than producing an unsigned APK, because
an unsigned APK in a release is a download that cannot be installed and a user
who meets one concludes the project is broken.

Keep the original offline. A GitHub secret is a copy that GitHub can read, not
a backup: it is write-only through the UI, and a repository that is deleted or
transferred takes it with it.

**The repository refuses to track key material by filename as well as by
discipline.** `.gitignore` carries `*.pem`, `*.keystore`, `*.jks` and `*.p12`.
That is the cheap half and it is worth saying so: ignoring a file only stops
the accident, and `preflight-secure.sh` treats a key git is *already tracking*
as compromised rather than merely ignored. That is the check that counts, and
a pattern list is not a substitute for it.

### GPG signing of `SHA256SUMS`

Covered above under "Cutting a release": `LEEK_SIGNING_KEY=<key-id>` makes
`scripts/release.sh` sign the manifest with `--local-user` and verify what it
wrote before reporting success. It is opt-in because a script that signs by
default signs a build nobody has read yet.

The release workflow deliberately does **not** sign. Putting this key in a
repository secret would place it on every runner the workflow ever schedules,
which is the opposite of the arrangement the rest of this section describes.
CI publishes a *draft* release; the maintainer downloads `SHA256SUMS`, checks
it against a local build, signs it, and uploads `SHA256SUMS.asc` before making
the release public. That is slower on purpose — it is the step where a human
looks at what is about to be published.

### macOS and Windows code signing: not done, and why

The `.dmg` and the `.msi` are unsigned, and will stay that way for now. Apple
notarisation requires a Developer account at $99/year; an EV code-signing
certificate for Windows runs into several hundred dollars a year and is tied to
a legal identity. For a project that has not funded a security audit, neither is
a good use of the first money.

This is a trade, not an oversight, so be precise about what is lost. A code
signature attests that a named identity paid a certificate authority and
published the file. It says nothing about what the file does. What replaces it
here is a stronger claim about the code and a weaker one about the author:
**reproducible builds plus published checksums**, so that any reader can rebuild
the tag and confirm the binary came from the source they can read. See
"Verifying a release" below. A user who wants to know *what they are running*
gets a better answer here than a signature would give them; a user who wants to
know *who wrote it* gets a worse one.

The visible cost is a scary dialog, and users deserve to be told about it in
advance rather than meeting it alone:

- **macOS** — Gatekeeper reports the app "cannot be opened because the
  developer cannot be verified". Right-click (or Control-click) the app and
  choose **Open**, then **Open** again in the dialog; the choice is remembered.
  Equivalently, `xattr -dr com.apple.quarantine /Applications/LeekWallet.app`.
- **Windows** — SmartScreen shows "Windows protected your PC". Click **More
  info**, then **Run anyway**.

Both of those are, in the abstract, instructions for how to ignore a security
warning, which is an uncomfortable thing to publish for a wallet. That is why
they appear next to the checksum commands and not on their own: the warning is
telling the truth — nobody has vouched for this binary's *author* — and the
answer is to verify the *binary*, which is a check the reader can actually
perform.

---

## Verifying a release, as someone who is not the maintainer

Three levels, and they are not interchangeable. Level 1 is the one to put in front of somebody
who just downloaded a file — the README carries it with per-platform commands, because
`sha256sum -c` is Linux-only and a reader on Windows who meets it simply stops. Levels 2 and 3
are the ones that actually establish provenance, and they need a toolchain.

### Level 1 — the download is intact (proves the least)

```bash
sha256sum -c SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS
```

This says the bytes you have are the bytes that were published, by whoever
holds that GPG key. It says **nothing** about what is in them, and nothing
about any device.

### Level 2 — the binary came from the source (the real claim)

For the **firmware**:

```bash
git clone <repo> && cd leekwallet
git checkout v0.3.0
git verify-tag v0.3.0
./scripts/release.sh v0.3.0
sha256sum -c /path/to/downloaded/SHA256SUMS
```

For the **companion app**, the same idea with the build path pinned, because
of the caveat above — the Rust binary is a function of the source *and* the
directory it was built in, so a verifier who builds somewhere else will get a
different hash for reasons that are not tampering:

```bash
export LEEK_REPRO_ROOT=/tmp/leekwallet-repro-build   # the published path
rm -rf "$LEEK_REPRO_ROOT"
git clone <repo> "$LEEK_REPRO_ROOT"
cd "$LEEK_REPRO_ROOT" && git checkout v0.3.0
cd app && pnpm install --frozen-lockfile && pnpm build
cd src-tauri && cargo build --release --bin leekwallet-companion
sha256sum target/release/leekwallet-companion
```

Compare that against the companion's line in the published `SHA256SUMS`. If it
differs, check `BUILDINFO` for the toolchain before concluding anything: a
different rustc changes the bytes on its own, which is why the pin in
`app/rust-toolchain.toml` exists and why the version is recorded rather than
implied.

To run the whole comparison rather than one artefact — building twice and
diffing, which is what a maintainer should do before publishing:

```bash
./scripts/repro-verify.sh
```

Matching hashes mean the published binary contains nothing that is not in the
published source. This is the check worth running, and the one the rest of this
work exists to make possible. It still says nothing about any device.

An honest note on what Level 2 costs: it requires the verifier to install the
pinned toolchains and spend several minutes of CPU. Almost nobody will. The
value is not that every user runs it — it is that any user *can*, so that a
tampered release is a thing that can be caught by one person and then told to
everyone, rather than a thing nobody is able to check even in principle.

### Level 3 — a device runs signed firmware (the only device-level claim)

With the board attached:

```bash
espefuse.py --port /dev/ttyACM0 summary
```

A buyer should see `SECURE_BOOT_EN = True`, a `SECURE_BOOT_DIGEST0` key block
whose digest matches the published one, `SPI_BOOT_CRYPT_CNT` set (flash
encrypted), and — on a shipped board rather than a development one —
`DIS_DOWNLOAD_MANUAL_ENCRYPT` set. Those fuses are one-way, so nothing running
later can undo them.

```bash
esptool.py --port /dev/ttyACM0 read_flash 0x20000 0x1000 app.bin
xxd app.bin | head
```

Should be ciphertext. Readable strings there mean flash encryption is not on,
whatever the board was sold as.

### What a buyer cannot verify, and should be told plainly

- **They cannot hash the app on the board and compare it to the release.**
  Flash is encrypted with a per-device key that never leaves the SoC, so the
  bytes read back are not the bytes that were published, by design. Level 2 and
  Level 3 together say "this device only boots firmware signed by that key" and
  "that key's holder published this source" — they do not compose into "this
  device is running that binary".
- **Anything the device says about itself is self-reported.** The version in
  the handshake comes from the firmware; firmware that lied about being signed
  would also lie about its version. The eFuse summary is read out of the chip
  rather than out of the application, which is why it is the check that counts.
- **Secure boot does not defend against a funded laboratory.** ESP32-S3 is a
  general-purpose MCU with a documented history of glitching attacks against
  eFuse protections. See [VAULT.md](VAULT.md); the claim is "your seed survives
  losing the device", not "your seed survives a lab".
- **None of this covers the supply chain before the flash.** A tampered board
  can have hardware that no firmware check would notice.

The honest summary to put in front of a buyer: *a hash verifies a download; an
independent rebuild verifies a binary; only secure boot verifies a device — and
only that it boots firmware signed by a particular key.*

---

## When the check fails

`./scripts/repro-check.sh` prints the byte offsets of the first differences.
They are usually enough to name the cause:

| Offsets | Almost certainly |
|---|---|
| `0x70`–`0x8f` | a build time/date stamp — `CONFIG_APP_REPRODUCIBLE_BUILD` is off, check the *generated* `sdkconfig.esp32s3`, not `sdkconfig.defaults` |
| `0x30`–`0x4f` | `PROJECT_VER` differs — a dirty tree, or different commits |
| `0xb0`–`0xcf` | the recorded ELF SHA-256; a *consequence*, look for the real cause elsewhere |
| the last 32 bytes | the image's own appended SHA-256; also a consequence |
| scattered, thousands of bytes | a different toolchain — check the `platform` pin resolved to `6.12.0` |

For the **companion**, the diagnosis is different because the artefacts are
ELF objects rather than flat images. `readelf -S -W` on both and compare the
section table first: if `.text` and `.rodata` match and only `.eh_frame` and
`.gcc_except_table` differ, that is the known build-path effect described
above and the fix is to build at `LEEK_REPRO_ROOT`, not to go hunting. If
`.text` itself differs, the toolchain differs — check `rustc --version`
against `app/rust-toolchain.toml`, and remember that a distribution-packaged
`cargo` ignores that file entirely. If the Vite bundle differs, suspect
`pnpm install` without `--frozen-lockfile`, which is allowed to resolve a
different dependency tree than the one that was published.

The trap worth naming: PlatformIO does **not** regenerate `sdkconfig.<env>`
when the defaults change, so an edit to `sdkconfig.defaults` can silently do
nothing while the build reports success. If a config change appears to have no
effect, `rm sdkconfig.esp32s3` and rebuild. This has bitten this repository
more than once — see the header of `scripts/preflight-secure.sh`.

---

## CI

`.github/workflows/ci.yml` runs the host suites and the app checks on
`ubuntu-latest`, `windows-latest` and `macos-latest`, because the companion is
published for three operating systems and "it builds on Linux" is not evidence
about the other two. It is not evidence about devices either: no runner has a
board or a Bluetooth radio, so USB enumeration, pairing and every signing flow
stay unverified on Windows and macOS until a person with that OS and a board
runs them. [RELEASE-0.1.md](RELEASE-0.1.md) carries that per-platform status,
and the release notes repeat it rather than letting a green matrix imply
otherwise.

The firmware job stays Linux-only — both targets cross-compile, so a second and
third runner would download the same toolchain to answer a question already
answered — and it builds **both** of them: `./scripts/check.sh firmware` now
runs `esp32s3` and `pixie`. The C3 image is built on every commit whether or
not it ships, because a target that is only built when a tag is cut is a target
that is discovered broken while cutting the tag. It lives in `check.sh` rather
than as an extra workflow step so that a developer running the script locally
learns exactly what CI learns.

`.github/workflows/ci.yml` also has two reproducibility jobs — `repro` for the
firmware and `repro-app` for the companion — both running on every push.
They are separate because they need entirely different toolchains, and because
two red crosses that name which half broke are worth more than one that does
not. A check that runs is worth more than a procedure in a document
that nobody opens, and reproducibility is exactly the property that rots
silently — a dependency bump reintroduces a timestamp and nothing complains
until someone tries to verify a release months later.

That job builds the firmware twice, so it is the slowest thing in CI. It runs
as its own job rather than inside `check.sh` so that the fast host suites still
report in seconds, and so that `./scripts/check.sh` stays the thing a developer
runs before a commit rather than a five-minute wait.

`.github/workflows/release.yml` is the other half: a tag matching `v*` builds
the firmware for both boards, merges each into a single flashable image, builds
the companion on all three desktop platforms, builds the Android APK, hashes
everything into one `SHA256SUMS` and attaches the lot to a **draft** release.
Draft rather than published, because two things still have to be done by a
person: the release notes must carry the per-platform test status from
[RELEASE-0.1.md](RELEASE-0.1.md), and `SHA256SUMS` still needs a signature made
off the build machine.

**Neither workflow has ever executed.** The repository has no remote, so they are
written to be correct on inspection rather than iterated against a runner.
The YAML parses and the shell in them is syntax-checked; nothing beyond that
has been demonstrated. Expect the first real run to need adjusting, and do not treat a green badge as
having been demonstrated until one has actually gone green.
