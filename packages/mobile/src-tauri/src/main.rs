// Prevents an extra console window on Windows in release. Harmless on mobile.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ci_os_hub_mobile_lib::run();
}
