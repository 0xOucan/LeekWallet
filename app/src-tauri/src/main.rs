//! Desktop entry point. Android boots the same `run()` through the JNI entry
//! point in the library, so this file stays empty of logic on purpose.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    leekwallet_companion_lib::run()
}
