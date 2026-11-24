// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/build.rs
// Copyright (c) Lifescope Inc. Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md.

const COMMANDS: &[&str] = &[
    "begin_loopback",
    "await_loopback",
    "cancel_loopback",
    "secure_get",
    "secure_set",
    "secure_remove",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
