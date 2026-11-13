//! Start the desktop app at login on Linux, so a Hub whose files sit in a home folder that is only
//! unlocked at login (eCryptfs, fscrypt, systemd-homed) comes back after a reboot.
//!
//! The Hub's containers bind-mount the data dir (`~/.local/share/companion-hub`). Docker starts at
//! boot, before anyone has logged in, so on such a home every bind source is missing: the `ci-hub`
//! container fails to start (`error mounting … not a directory`, exit 127) and `restart:
//! unless-stopped` never retries a container that failed to start. Nothing on Linux runs after login
//! to bring it back. Windows has its logon script for the WSL engine and macOS its LaunchAgent for
//! Colima; this is the Linux counterpart.
//!
//! The entry starts the app with [`LOGIN_START_FLAG`]: it opens in the tray without showing its
//! window, and the launch check in `main.rs` starts the Hub when a core service is stopped. That
//! check already honours "Stop Hub", waits for Docker and spaces out retries, so nothing here
//! decides whether the Hub should run. On a machine whose disk is unlocked before boot the Hub is
//! already up by login and the check does nothing.
//!
//! The user stays in charge of the entry. Turning it off in the desktop's startup settings (GNOME
//! writes `X-GNOME-Autostart-enabled=false`, KDE `Hidden=true`) keeps it off, and deleting the file
//! keeps it deleted: a marker in the data dir records that the app wrote it once.

use std::path::{Path, PathBuf};

/// Launch argument the autostart entry passes: open in the tray, without showing the window.
pub const LOGIN_START_FLAG: &str = "--login-start";

/// File name under `$XDG_CONFIG_HOME/autostart`, named after the app's binary.
pub const AUTOSTART_FILE_NAME: &str = "companion-hub.desktop";

/// Marker in the data dir: the app has written the entry before, so a missing file was removed by
/// the user and must not come back.
pub const AUTOSTART_MARKER_FILE_NAME: &str = ".login-autostart-installed";

/// `$XDG_CONFIG_HOME/autostart/companion-hub.desktop`, or `~/.config/autostart/…` when
/// `XDG_CONFIG_HOME` is unset, empty or relative (the XDG spec says to ignore a relative value).
pub fn autostart_path(xdg_config_home: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    let config = match xdg_config_home.map(str::trim) {
        Some(value) if !value.is_empty() && Path::new(value).is_absolute() => PathBuf::from(value),
        _ => home?.join(".config"),
    };
    Some(config.join("autostart").join(AUTOSTART_FILE_NAME))
}

/// Quote one `Exec=` argument as the Desktop Entry spec requires: inside double quotes, `"`, `` ` ``,
/// `$` and `\` are escaped with a backslash, and a literal `%` is written `%%` (field codes).
fn quote_exec_arg(arg: &str) -> String {
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    for ch in arg.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(ch);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

/// `TryExec=` takes a plain path, with no quoting. A path that needs quoting there (a newline, which
/// would end the key) is left out rather than written wrong; `Exec=` still names it.
fn try_exec_line(binary: &str) -> Option<String> {
    (!binary.contains('\n') && !binary.contains('\r')).then(|| format!("TryExec={binary}\n"))
}

/// The autostart entry for `binary`. `TryExec` makes the desktop skip it once the app is
/// uninstalled, or the AppImage moved, instead of failing at every login.
pub fn desktop_entry(binary: &Path) -> String {
    let binary = binary.to_string_lossy();
    let mut entry = String::from("[Desktop Entry]\n");
    entry.push_str("Type=Application\n");
    entry.push_str("Name=Companion Hub\n");
    entry.push_str(
        "Comment=Start Companion Hub in the tray at login, so the Hub comes back after a reboot\n",
    );
    entry.push_str(&format!(
        "Exec={} {LOGIN_START_FLAG}\n",
        quote_exec_arg(&binary)
    ));
    if let Some(line) = try_exec_line(&binary) {
        entry.push_str(&line);
    }
    entry.push_str("Icon=companion-hub\n");
    entry.push_str("Terminal=false\n");
    entry.push_str("NoDisplay=true\n");
    entry.push_str("X-GNOME-Autostart-enabled=true\n");
    entry
}

/// Whether an existing entry was turned off by the user, read from its `[Desktop Entry]` group only.
pub fn disabled_by_user(existing: &str) -> bool {
    let mut in_main_group = false;
    for line in existing.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_main_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Hidden" if value.eq_ignore_ascii_case("true") => return true,
            "X-GNOME-Autostart-enabled" if value.eq_ignore_ascii_case("false") => return true,
            _ => {}
        }
    }
    false
}

/// What [`ensure`] should do, given the file and the marker as they are now.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Write (or rewrite) the entry.
    Write,
    /// Leave it: already current, turned off, or removed by the user.
    Keep(&'static str),
}

pub fn plan(existing: Option<&str>, marker_present: bool, desired: &str) -> Plan {
    match existing {
        None if marker_present => Plan::Keep("removed by the user"),
        None => Plan::Write,
        Some(current) if disabled_by_user(current) => Plan::Keep("turned off by the user"),
        Some(current) if current == desired => Plan::Keep("already current"),
        // Ours but stale (the AppImage moved, the binary path changed) or written by an older version.
        Some(_) => Plan::Write,
    }
}

/// Write the autostart entry if it is missing or stale, unless the user turned it off or removed it.
/// Best effort: a failure is logged and never stops the app.
#[cfg(target_os = "linux")]
pub fn ensure(data_dir: &Path) {
    // desktop.log, which View logs opens: a login start has no terminal, so stderr goes unseen.
    let log = |message: &str| {
        let _ = crate::hub_manager::append_desktop_log_for(data_dir, "login-autostart", message);
    };
    let Some(binary) = crate::app_binary::launch_path() else {
        log("Skipped: could not resolve this app's binary path.");
        return;
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let Some(path) = autostart_path(xdg.as_deref(), home.as_deref()) else {
        log("Skipped: HOME is not set.");
        return;
    };
    let marker = data_dir.join(AUTOSTART_MARKER_FILE_NAME);
    let desired = desktop_entry(&binary);
    let existing = std::fs::read_to_string(&path).ok();

    match plan(existing.as_deref(), marker.exists(), &desired) {
        // Quiet when current, so an ordinary launch adds nothing to the log.
        Plan::Keep("already current") => {}
        Plan::Keep(reason) => log(&format!("Left {} alone: {reason}.", path.display())),
        Plan::Write => {
            let result = path
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::write(&path, &desired));
            match result {
                Ok(()) => {
                    let _ = std::fs::write(&marker, "");
                    log(&format!(
                        "Wrote {} (starts the app in the tray at login).",
                        path.display()
                    ));
                }
                Err(error) => log(&format!("Could not write {}: {error}", path.display())),
            }
        }
    }
}

/// Linux only; elsewhere the platform's own startup mechanism applies.
#[cfg(not(target_os = "linux"))]
pub fn ensure(_data_dir: &Path) {}

/// Whether this launch came from the autostart entry.
pub fn is_login_start(args: &[String]) -> bool {
    args.iter().any(|arg| arg == LOGIN_START_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_path_prefers_an_absolute_xdg_config_home() {
        let home = Path::new("/home/u");
        assert_eq!(
            autostart_path(Some("/cfg"), Some(home)),
            Some(PathBuf::from("/cfg/autostart/companion-hub.desktop"))
        );
        for ignored in [None, Some(""), Some("  "), Some("relative/cfg")] {
            assert_eq!(
                autostart_path(ignored, Some(home)),
                Some(PathBuf::from(
                    "/home/u/.config/autostart/companion-hub.desktop"
                )),
                "{ignored:?}"
            );
        }
        assert_eq!(autostart_path(None, None), None);
    }

    #[test]
    fn entry_starts_the_app_in_the_tray_and_names_the_binary_for_try_exec() {
        let entry = desktop_entry(Path::new("/usr/bin/companion-hub"));
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Exec=\"/usr/bin/companion-hub\" --login-start\n"));
        assert!(entry.contains("TryExec=/usr/bin/companion-hub\n"));
        assert!(entry.contains("Type=Application\n"));
        assert!(entry.contains("X-GNOME-Autostart-enabled=true\n"));
        assert!(!disabled_by_user(&entry));
    }

    #[test]
    fn exec_quotes_spaces_and_escapes_reserved_characters() {
        let entry = desktop_entry(Path::new("/home/u/Apps/Hub $1 \"x\" 100%.AppImage"));
        assert!(entry.contains(r#"Exec="/home/u/Apps/Hub \$1 \"x\" 100%%.AppImage" --login-start"#));
        // TryExec is a plain path.
        assert!(entry.contains("TryExec=/home/u/Apps/Hub $1 \"x\" 100%.AppImage\n"));
    }

    #[test]
    fn a_newline_in_the_path_drops_try_exec_instead_of_breaking_the_file() {
        let entry = desktop_entry(Path::new("/tmp/odd\nname"));
        assert!(!entry.contains("TryExec="));
        assert_eq!(entry.lines().filter(|l| l.starts_with("Exec=")).count(), 1);
    }

    #[test]
    fn gnome_and_kde_switches_count_as_turned_off() {
        assert!(disabled_by_user(
            "[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n"
        ));
        assert!(disabled_by_user("[Desktop Entry]\nHidden=true\n"));
        assert!(disabled_by_user("[Desktop Entry]\nHidden = TRUE\n"));
        assert!(!disabled_by_user(
            "[Desktop Entry]\nHidden=false\nX-GNOME-Autostart-enabled=true\n"
        ));
        // Keys outside the main group don't count.
        assert!(!disabled_by_user(
            "[Desktop Entry]\nName=x\n[Desktop Action a]\nHidden=true\n"
        ));
    }

    #[test]
    fn plan_writes_once_and_then_respects_the_user() {
        let desired = desktop_entry(Path::new("/usr/bin/companion-hub"));
        assert_eq!(plan(None, false, &desired), Plan::Write);
        assert_eq!(
            plan(None, true, &desired),
            Plan::Keep("removed by the user")
        );
        assert_eq!(
            plan(Some(&desired), true, &desired),
            Plan::Keep("already current")
        );
        let turned_off = desired.replace(
            "X-GNOME-Autostart-enabled=true",
            "X-GNOME-Autostart-enabled=false",
        );
        assert_eq!(
            plan(Some(&turned_off), true, &desired),
            Plan::Keep("turned off by the user")
        );
        let moved = desktop_entry(Path::new("/home/u/Old.AppImage"));
        assert_eq!(plan(Some(&moved), true, &desired), Plan::Write);
    }

    #[test]
    fn only_the_flag_marks_a_login_start() {
        assert!(is_login_start(&["--login-start".to_string()]));
        assert!(!is_login_start(&[]));
        assert!(!is_login_start(&["--detached".to_string()]));
    }
}
