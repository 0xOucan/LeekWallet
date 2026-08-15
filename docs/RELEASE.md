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
| `BUILDINFO` | tag, commit, environment, platform pin, rebuild instructions |
| `secure_boot_signing_key.pub` + its digest | the *public* half only (secure releases) |

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

## Verifying a release, as someone who is not the maintainer

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

`.github/workflows/ci.yml` has two reproducibility jobs — `repro` for the
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

**This workflow has never executed.** The repository has no remote, so it is
written to be correct on inspection rather than iterated against a runner.
Expect the first real run to need adjusting, and do not treat a green badge as
having been demonstrated until one has actually gone green.
