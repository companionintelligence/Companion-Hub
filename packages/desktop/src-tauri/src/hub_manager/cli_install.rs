//! Bundled cihub CLI staging and host PATH integration.

use super::*;

fn bundled_cli_resource_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir.join(HOST_CLI_FILENAME),
        resource_dir.join("resources").join(HOST_CLI_FILENAME),
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(Path::new("."))
            .join("resources")
            .join(HOST_CLI_FILENAME),
        PathBuf::from("/usr/lib/companion-hub/resources").join(HOST_CLI_FILENAME),
        PathBuf::from("/usr/lib/Companion Hub/resources").join(HOST_CLI_FILENAME),
        PathBuf::from("/usr/share/companion-hub").join(HOST_CLI_FILENAME),
    ]
}

fn path_contains_dir(dir: &Path) -> bool {
    std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value).any(|entry| paths_match_by_components(&entry, dir))
        })
        .unwrap_or(false)
}

pub(crate) fn paths_match_by_components(left: &Path, right: &Path) -> bool {
    left.components().eq(right.components())
}

pub(crate) fn files_match(source: &Path, installed: &Path) -> std::io::Result<bool> {
    let source_metadata = std::fs::metadata(source)?;
    let installed_metadata = std::fs::metadata(installed)?;
    if !source_metadata.is_file() || !installed_metadata.is_file() {
        return Ok(false);
    }
    if source_metadata.len() != installed_metadata.len() {
        return Ok(false);
    }
    Ok(std::fs::read(source)? == std::fs::read(installed)?)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn preferred_unix_profile() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let shell = std::env::var("SHELL").ok().unwrap_or_default();
    Some(unix_profile_for_shell(&home, &shell))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn unix_profile_for_shell(home: &Path, shell: &str) -> PathBuf {
    let shell_name = Path::new(&shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    match shell_name {
        "zsh" => home.join(".zshrc"),
        #[cfg(target_os = "macos")]
        "bash" => home.join(".bash_profile"),
        #[cfg(target_os = "linux")]
        "bash" => home.join(".bashrc"),
        _ => home.join(".profile"),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn append_unix_profile_path(dir: &Path) -> Result<Option<PathBuf>, String> {
    let profile = match preferred_unix_profile() {
        Some(profile) => profile,
        None => return Ok(None),
    };

    let line = format!("export PATH=\"{}:$PATH\"", dir.display());
    let marker = "# Companion Hub CLI";
    let current = std::fs::read_to_string(&profile).unwrap_or_default();
    if current.contains(&line) {
        return Ok(Some(profile));
    }

    if let Some(parent) = profile.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare shell profile directory {}: {}",
                parent.display(),
                error
            )
        })?;
    }

    let prefix = if current.is_empty() || current.ends_with('\n') {
        String::new()
    } else {
        "\n".to_string()
    };

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&profile)
        .map_err(|error| {
            format!(
                "Failed to open shell profile {}: {}",
                profile.display(),
                error
            )
        })?;
    use std::io::Write;
    file.write_all(format!("{prefix}{marker}\n{line}\n").as_bytes())
        .map_err(|error| {
            format!(
                "Failed to update shell profile {}: {}",
                profile.display(),
                error
            )
        })?;

    Ok(Some(profile))
}

#[cfg(target_os = "windows")]
fn set_windows_user_path(dir: &Path) -> Result<bool, String> {
    let target = dir.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$target = '{target}'; \
         $current = [Environment]::GetEnvironmentVariable('Path','User'); \
         $entries = @(); \
         if ($current) {{ $entries = $current -split ';' | Where-Object {{ $_ -and $_.Trim() -ne '' }} }}; \
         if ($entries -contains $target) {{ exit 0 }}; \
         $entries += $target; \
         [Environment]::SetEnvironmentVariable('Path', (($entries | Select-Object -Unique) -join ';'), 'User')"
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|error| format!("Failed to launch PowerShell to update PATH: {}", error))?;

    Ok(output.status.success())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn preferred_unix_cli_install_dir(home: &Path) -> PathBuf {
    let local_bin = home.join(".local/bin");
    let home_bin = home.join("bin");

    if path_contains_dir(&local_bin) {
        return local_bin;
    }

    if path_contains_dir(&home_bin) {
        return home_bin;
    }

    if home_bin.exists() && !local_bin.exists() {
        return home_bin;
    }

    local_bin
}

fn host_cli_install_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return dirs::data_local_dir().map(|dir| dir.join("Companion Hub").join("bin"));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let home = dirs::home_dir()?;
        return Some(preferred_unix_cli_install_dir(&home));
    }

    #[allow(unreachable_code)]
    None
}

/// Install `source` at `installed_path` by staging a copy in `install_dir` and
/// renaming it into place. A plain `fs::copy` onto the destination writes
/// *through* an existing symlink (clobbering the link target) and fails with
/// ENOENT on a broken one; the rename replaces the link itself and never leaves
/// a half-copied binary on PATH.
pub(crate) fn replace_installed_cli(
    source: &Path,
    install_dir: &Path,
    installed_path: &Path,
) -> std::io::Result<()> {
    let staged = install_dir.join(format!(
        "{}.staging-{}",
        HOST_CLI_FILENAME,
        std::process::id()
    ));
    let result = (|| {
        std::fs::copy(source, &staged)?;
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        }
        move_staged_cli_into_place(install_dir, &staged, installed_path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn move_staged_cli_into_place(
    _install_dir: &Path,
    staged: &Path,
    installed_path: &Path,
) -> std::io::Result<()> {
    std::fs::rename(staged, installed_path)
}

#[cfg(target_os = "windows")]
fn move_staged_cli_into_place(
    install_dir: &Path,
    staged: &Path,
    installed_path: &Path,
) -> std::io::Result<()> {
    // Windows `rename` refuses to replace an existing destination, so move it
    // aside instead of deleting it — if the final rename fails, the previous
    // binary is restored rather than leaving no CLI at the install path.
    let backup = install_dir.join(format!(
        "{}.backup-{}",
        HOST_CLI_FILENAME,
        std::process::id()
    ));
    let had_existing = installed_path.symlink_metadata().is_ok();
    if had_existing {
        std::fs::rename(installed_path, &backup)?;
    }
    match std::fs::rename(staged, installed_path) {
        Ok(()) => {
            if had_existing {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(error) => {
            if had_existing {
                let _ = std::fs::rename(&backup, installed_path);
            }
            Err(error)
        }
    }
}

pub(crate) fn ensure_bundled_cli_available(resource_dir: &Path, data_dir: &Path) {
    let candidates = bundled_cli_resource_candidates(resource_dir);
    let Some(source) = candidates.into_iter().find(|path| path.exists()) else {
        let _ = append_desktop_log_for(
            data_dir,
            "cli",
            &format!(
                "Bundled Companion Hub CLI resource not found. Looked for {}.",
                bundled_cli_resource_candidates(resource_dir)
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        );
        return;
    };

    let Some(install_dir) = host_cli_install_dir() else {
        let _ = append_desktop_log_for(
            data_dir,
            "cli",
            "Unable to resolve a host install directory for the bundled Companion Hub CLI.",
        );
        return;
    };

    if let Err(error) = std::fs::create_dir_all(&install_dir) {
        let _ = append_desktop_log_for(
            data_dir,
            "cli",
            &format!(
                "Failed to create Companion Hub CLI install directory {}: {}",
                install_dir.display(),
                error
            ),
        );
        return;
    }

    let installed_path = install_dir.join(HOST_CLI_FILENAME);
    // A symlink at the install path (e.g. left behind by a dev-checkout setup)
    // is never "current" even if it resolves to identical bytes: the CLI on
    // PATH would silently track whatever the link points at instead of this
    // bundle's binary.
    let installed_is_symlink = installed_path
        .symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    let already_current =
        !installed_is_symlink && files_match(&source, &installed_path).unwrap_or(false);
    if !already_current {
        if let Err(error) = replace_installed_cli(&source, &install_dir, &installed_path) {
            let _ = append_desktop_log_for(
                data_dir,
                "cli",
                &format!(
                    "Failed to install bundled Companion Hub CLI from {} to {}: {}",
                    source.display(),
                    installed_path.display(),
                    error
                ),
            );
            return;
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = std::fs::set_permissions(&installed_path, std::fs::Permissions::from_mode(0o755));
    }

    let mut notes = vec![if already_current {
        format!(
            "Bundled Companion Hub CLI at {} is already current",
            installed_path.display()
        )
    } else {
        format!(
            "Bundled Companion Hub CLI installed to {}",
            installed_path.display()
        )
    }];

    if !path_contains_dir(&install_dir) {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        match append_unix_profile_path(&install_dir) {
            Ok(Some(profile)) => notes.push(format!(
                "Added {} to PATH in {} (open a new shell to use `cihub`).",
                install_dir.display(),
                profile.display()
            )),
            Ok(None) => notes.push(format!(
                "{} is not on PATH yet. Add it manually to use `cihub`.",
                install_dir.display()
            )),
            Err(error) => notes.push(format!(
                "Failed to update shell profile for PATH export: {}",
                error
            )),
        }

        #[cfg(target_os = "windows")]
        match set_windows_user_path(&install_dir) {
            Ok(true) => notes.push(format!(
                "Added {} to the Windows user PATH (open a new terminal to use `cihub`).",
                install_dir.display()
            )),
            Ok(false) => notes.push(format!(
                "Could not confirm PATH update for {}. You may need to add it manually.",
                install_dir.display()
            )),
            Err(error) => notes.push(format!("Failed to update Windows user PATH: {}", error)),
        }
    } else {
        notes.push(format!(
            "{} is already on PATH. `cihub` should be available in new shells.",
            install_dir.display()
        ));
    }

    let _ = append_desktop_log_for(data_dir, "cli", &notes.join(" "));
}
