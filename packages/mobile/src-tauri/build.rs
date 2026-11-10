fn main() {
    align_android_to_16kb_pages();
    tauri_build::build()
}

/// Play rejects 64-bit native libraries whose ELF LOAD segments are aligned to
/// 4 KB, and a debuggable build of one makes Android 16 show an "Android App
/// Compatibility" warning at every launch. NDK r28+ aligns to 16 KB by default;
/// this makes an older NDK do the same. 32-bit ABIs are not part of the
/// requirement.
///
/// The flag is emitted here and not as `rustflags` in `.cargo/config.toml`,
/// where it used to be and never took effect: the Tauri CLI and its Gradle
/// plugin build with the `RUSTFLAGS` family of environment variables set, and
/// those replace the config file's values instead of adding to them.
fn align_android_to_16kb_pages() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let pointer_width = std::env::var("CARGO_CFG_TARGET_POINTER_WIDTH").unwrap_or_default();
    if os == "android" && pointer_width == "64" {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
}
