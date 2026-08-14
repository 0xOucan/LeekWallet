# Releasing, reproducing, and signing

**Status: the build is reproducible and verified as such locally. No release
has been published, and the CI job that checks this has never run** — this
repository has no remote. ([T37](../ROADMAP.md))

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

Sign the manifest, not each binary:

```bash
cd release/v0.3.0/esp32s3-secure
gpg --armor --detach-sign SHA256SUMS
```

`SHA256SUMS` covers the binaries and the signature covers `SHA256SUMS`, so one
signature is enough and there is one place to look.

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

```bash
git clone <repo> && cd leekwallet
git checkout v0.3.0
git verify-tag v0.3.0
./scripts/release.sh v0.3.0
sha256sum -c /path/to/downloaded/SHA256SUMS
```

Matching hashes mean the published binary contains nothing that is not in the
published source. This is the check worth running, and the one the rest of this
work exists to make possible. It still says nothing about any device.

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

The trap worth naming: PlatformIO does **not** regenerate `sdkconfig.<env>`
when the defaults change, so an edit to `sdkconfig.defaults` can silently do
nothing while the build reports success. If a config change appears to have no
effect, `rm sdkconfig.esp32s3` and rebuild. This has bitten this repository
more than once — see the header of `scripts/preflight-secure.sh`.

---

## CI

`.github/workflows/ci.yml` has a `repro` job that runs `scripts/repro-check.sh`
on every push. A check that runs is worth more than a procedure in a document
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
