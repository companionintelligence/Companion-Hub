//! Tests for the `cli_install` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn matches_paths_by_components() {
    assert!(paths_match_by_components(
        Path::new("/usr/local/bin/"),
        Path::new("/usr/local/bin")
    ));
    assert!(!paths_match_by_components(
        Path::new("/usr/local/bin"),
        Path::new("/usr/local/share")
    ));
}

#[test]
fn matches_files_by_contents() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let source = tempdir.path().join("source.bin");
    let installed = tempdir.path().join("installed.bin");
    std::fs::write(&source, b"same-bytes").expect("write source");
    std::fs::write(&installed, b"same-bytes").expect("write installed");

    assert!(files_match(&source, &installed).expect("compare files"));
}

#[test]
fn detects_when_installed_file_differs() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let source = tempdir.path().join("source.bin");
    let installed = tempdir.path().join("installed.bin");
    std::fs::write(&source, b"same-size").expect("write source");
    std::fs::write(&installed, b"diffsize!").expect("write installed");

    assert!(!files_match(&source, &installed).expect("compare files"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn replaces_broken_symlink_at_cli_install_path() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let install_dir = tempdir.path().join("bin");
    std::fs::create_dir_all(&install_dir).expect("create install dir");
    let source = tempdir.path().join("bundled-cihub");
    std::fs::write(&source, b"cli-bytes").expect("write source");

    // Symlink into a checkout that no longer exists — fs::copy onto this
    // path fails with ENOENT.
    let installed = install_dir.join("cihub");
    std::os::unix::fs::symlink(tempdir.path().join("gone/checkout/cihub"), &installed)
        .expect("create broken symlink");

    crate::hub_manager::replace_installed_cli(&source, &install_dir, &installed)
        .expect("install CLI");

    let metadata = installed.symlink_metadata().expect("installed metadata");
    assert!(metadata.file_type().is_file());
    assert_eq!(
        std::fs::read(&installed).expect("read installed"),
        b"cli-bytes"
    );
    let leftovers: Vec<_> = std::fs::read_dir(&install_dir)
        .expect("list install dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().contains("staging"))
        .collect();
    assert!(leftovers.is_empty(), "staging file left behind");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn replaces_symlink_without_writing_through_to_its_target() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let install_dir = tempdir.path().join("bin");
    std::fs::create_dir_all(&install_dir).expect("create install dir");
    let source = tempdir.path().join("bundled-cihub");
    std::fs::write(&source, b"cli-bytes").expect("write source");

    // Symlink to a live file elsewhere (e.g. a dev checkout binary) — the
    // install must replace the link, not overwrite what it points at.
    let checkout_binary = tempdir.path().join("checkout-cihub");
    std::fs::write(&checkout_binary, b"checkout-bytes").expect("write checkout binary");
    let installed = install_dir.join("cihub");
    std::os::unix::fs::symlink(&checkout_binary, &installed).expect("create symlink");

    crate::hub_manager::replace_installed_cli(&source, &install_dir, &installed)
        .expect("install CLI");

    assert!(installed
        .symlink_metadata()
        .expect("installed metadata")
        .file_type()
        .is_file());
    assert_eq!(
        std::fs::read(&installed).expect("read installed"),
        b"cli-bytes"
    );
    assert_eq!(
        std::fs::read(&checkout_binary).expect("read checkout binary"),
        b"checkout-bytes"
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn prefers_user_bin_dir_even_when_system_bin_is_on_path() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let home = tempdir.path();
    let original_path = std::env::var_os("PATH");

    unsafe {
        std::env::set_var("PATH", "/usr/local/bin");
    }

    let selected = preferred_unix_cli_install_dir(home);

    match original_path {
        Some(value) => unsafe { std::env::set_var("PATH", value) },
        None => unsafe { std::env::remove_var("PATH") },
    }

    assert_eq!(selected, home.join(".local/bin"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn chooses_platform_correct_bash_profile() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let selected = unix_profile_for_shell(tempdir.path(), "/bin/bash");

    #[cfg(target_os = "macos")]
    assert_eq!(selected, tempdir.path().join(".bash_profile"));

    #[cfg(target_os = "linux")]
    assert_eq!(selected, tempdir.path().join(".bashrc"));
}
