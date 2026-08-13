# Android build (T29)

The companion app runs on Android through the same Tauri shell as the desktop
build. **The Android build has no transport yet**: it drives the built-in mock
device, which is enough to exercise the entire UI on a real phone.

T22c added a BLE transport, but on **desktop only**. btleplug's Android backend
needs a JVM-side driver class compiled into the Gradle project that Tauri
generates — and that project is not tracked here (see "Generated project"
below), so there is nowhere to put it that survives a regeneration. Compiling
btleplug in for Android would produce a transport that links, reports itself as
available, and then fails at the first call with a JNI class-not-found. That is
worse than no transport, so `leek-transport-ble` stays behind
`cfg(not(target_os = "android"))` alongside the serial one, the `transports`
command returns an empty list on Android, and the app keeps saying `mock`.
Wiring the JVM side is the remaining work for T30.

## What you need

| Piece | Version used | Notes |
| --- | --- | --- |
| JDK | Temurin 21 | A JRE is **not** enough — Gradle needs `javac`. |
| Android SDK | platform 34, build-tools 34.0.0 | Licences must be accepted. |
| Android NDK | 27.2.12479018 | Installed through `sdkmanager`. |
| Rust targets | `aarch64-linux-android` (+ the other three for a real universal APK) | |
| Node/pnpm | node ≥22, pnpm 9 | |

Install the SDK pieces (adjust the SDK path if yours differs):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses      # interactive, once
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install \
    "ndk;27.2.12479018" "platforms;android-34" "build-tools;34.0.0" "platform-tools"
```

A JDK without root:

```bash
mkdir -p ~/.local/lib && cd ~/.local/lib
curl -sSL -o jdk21.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
tar xzf jdk21.tar.gz && rm jdk21.tar.gz
```

Rust targets:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android
```

## Environment

Every Android command needs these four. Put them in your shell profile:

```bash
export JAVA_HOME="$HOME/.local/lib/jdk-21.0.12+8"   # or your system JDK
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
```

`NDK_HOME` must point at the *versioned* directory, not at `$ANDROID_HOME/ndk`.

## Build

```bash
cd app
pnpm install
pnpm tauri android init          # only once per checkout, see "Generated project"
pnpm android:build               # debug APK, all installed targets
pnpm tauri android build --debug --target aarch64   # just arm64, much faster
```

The APK lands at:

```
app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A debug build is large (~250 MB) because the Rust library is unoptimised and
carries debug info. A release build is a fraction of that.

## Install

```bash
adb install -r app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -s RustStdoutStderr   # the Rust side's output
```

Or `pnpm android:dev` with a device attached, which live-reloads the frontend
from the Vite dev server.

## Generated project

`src-tauri/gen/android/` is **git-ignored** (it already was, in
`app/.gitignore`), and this task kept it that way. It is generated from
`tauri.conf.json` and `Cargo.toml`, so it is derived state, and committing it
would create the same trap the repo documents for `sdkconfig.*`: an edit to the
source of truth that silently does nothing because the generated file is
already there. Run `pnpm tauri android init` after a fresh clone, and re-run it
after changing the app identifier or product name.

## Release signing

The debug APK is signed with the standard Android debug key and will install on
any phone with unknown sources enabled. That is all a release build needs
extra:

1. Generate a keystore **outside the repository**:
   ```bash
   keytool -genkey -v -keystore ~/leekwallet-release.jks -keyalg RSA \
           -keysize 4096 -validity 10000 -alias leekwallet
   ```
2. Create `app/src-tauri/gen/android/keystore.properties` (already ignored by
   the generated `.gitignore` — verify that before writing it):
   ```properties
   storeFile=/absolute/path/to/leekwallet-release.jks
   keyAlias=leekwallet
   storePassword=...
   password=...
   ```
3. Wire it into `app/build.gradle.kts` per the Tauri "Android code signing"
   guide, then `pnpm tauri android build`.

No keystore, password, or signing key belongs in this repository. For a wallet
the signing key is the thing that decides which binary a user's phone trusts;
treat it like `secure_boot_signing_key.pem`.

## Known state

- Built and verified: debug APK produced for `aarch64`.
- **Not** verified: installing or running on a physical device — none was
  attached when this was written. Nothing below has been observed on real
  hardware.
- No transport: the app reports `mock` in the status badge on Android and
  connects to the built-in mock device. It never claims `hardware` there.
- After T22c: `cargo check --target aarch64-linux-android` still passes. A full
  `pnpm android:build` was **not** re-run.
