//! The systemd user service that starts the Hub's containers after login when they could not
//! start at boot, for the headless mode (`companion-hub --detached`).
//!
//! The windowed app covers a home folder that is only unlocked at login with its autostart entry
//! (`login_autostart.rs`). That entry needs a graphical login, and a desktop package that is only
//! ever started headless (an SSH-only box) has none, so after a reboot its `ci-hub` stayed down
//! (`error mounting … not a directory`, exit 127, never retried by Docker). `cihub up` installs a
//! systemd user service for the same case (`scripts/lib/login-start-unit.ts`); this installs the
//! very same one. The script and the unit template are the files in `scripts/login-start/`, which
//! the CLI bakes in too, and both installers use the same three paths and marker, so neither
//! fights the other.
//!
//! What the script starts, and why a Hub someone stopped stays stopped, is described in the
//! script itself and in `docs/CLI.md`, "After a reboot on Linux".
//!
//! The user stays in charge: the service is enabled only on its first install, which the marker
//! records, so a `systemctl --user disable` stays disabled and a deleted unit is not written again.

// Only the Linux `ensure` uses the helpers below. On other platforms they compile for the tests, and
// the release build's `-D dead_code` would otherwise fail on them.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

pub const UNIT_NAME: &str = "companion-hub-login-start.service";
const SCRIPT_NAME: &str = "login-start.sh";
const MARKER_NAME: &str = ".login-start-installed";

const SCRIPT: &str = include_str!("../../../../scripts/login-start/companion-hub-login-start.sh");
const SERVICE_TEMPLATE: &str =
    include_str!("../../../../scripts/login-start/companion-hub-login-start.service");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub unit_file: PathBuf,
    pub script_file: PathBuf,
    pub marker_file: PathBuf,
}

/// `$XDG_CONFIG_HOME` (or `~/.config` when it is unset, empty or relative)
/// `/systemd/user/<unit>`, plus `companion-hub/login-start.sh` and its marker beside it. The same
/// paths as `loginStartPaths` in `scripts/lib/login-start-unit.ts`.
pub fn paths(xdg_config_home: Option<&str>, home: Option<&Path>) -> Option<Paths> {
    let config = match xdg_config_home.map(str::trim) {
        Some(value) if !value.is_empty() && Path::new(value).is_absolute() => PathBuf::from(value),
        _ => home?.join(".config"),
    };
    let own = config.join("companion-hub");
    Some(Paths {
        unit_file: config.join("systemd").join("user").join(UNIT_NAME),
        script_file: own.join(SCRIPT_NAME),
        marker_file: own.join(MARKER_NAME),
    })
}

/// systemd takes a path with spaces in `ExecStart=` in double quotes, with `\` and `"` escaped.
fn systemd_quote(value: &str) -> String {
    if !value
        .chars()
        .any(|c| c.is_whitespace() || c == '"' || c == '\\')
    {
        return value.to_string();
    }
    let mut quoted = String::from('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    quoted
}

pub fn render_service(script_file: &Path) -> String {
    let script = script_file.to_string_lossy();
    SERVICE_TEMPLATE
        .replacen("@SCRIPT_PATH@", &script, 1)
        .replacen("@SCRIPT_EXEC@", &systemd_quote(&script), 1)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Installed,
    Refreshed,
    Unchanged,
    LeftRemoved,
    Root,
    NoUserSession,
    Failed(String),
}

/// Install or refresh the unit. `systemctl` runs `systemctl --user <args>` and says whether it
/// exited 0. Every step after the checks is a file write or that call, so it is tested whole.
pub fn ensure_at(paths: &Paths, uid: u32, systemctl: &mut dyn FnMut(&[&str]) -> bool) -> Outcome {
    // A root Hub's files are not in a folder unlocked at a person's login, and a unit in root's
    // config would run only when root logs in.
    if uid == 0 {
        return Outcome::Root;
    }
    let installed_before = paths.marker_file.exists();
    if installed_before && !paths.unit_file.exists() {
        return Outcome::LeftRemoved;
    }
    // No user manager (a container, some SSH setups): nothing would ever run the unit.
    if !systemctl(&["show-environment"]) {
        return Outcome::NoUserSession;
    }

    let unit = render_service(&paths.script_file);
    let current_script = std::fs::read_to_string(&paths.script_file).ok();
    let current_unit = std::fs::read_to_string(&paths.unit_file).ok();
    let changed =
        current_script.as_deref() != Some(SCRIPT) || current_unit.as_deref() != Some(&unit);
    if changed {
        if let Err(error) = write_files(paths, &unit) {
            return Outcome::Failed(error);
        }
        systemctl(&["daemon-reload"]);
    }

    if installed_before {
        return if changed {
            Outcome::Refreshed
        } else {
            Outcome::Unchanged
        };
    }
    // First install only: a later `enable` would undo a user's `disable`.
    if !systemctl(&["enable", UNIT_NAME]) {
        return Outcome::Failed(format!("systemctl --user enable {UNIT_NAME} failed"));
    }
    if let Err(error) = std::fs::write(&paths.marker_file, "") {
        return Outcome::Failed(format!("{}: {error}", paths.marker_file.display()));
    }
    Outcome::Installed
}

fn write_files(paths: &Paths, unit: &str) -> Result<(), String> {
    let describe = |path: &Path, error: std::io::Error| format!("{}: {error}", path.display());
    for dir in [paths.script_file.parent(), paths.unit_file.parent()]
        .into_iter()
        .flatten()
    {
        std::fs::create_dir_all(dir).map_err(|e| describe(dir, e))?;
    }
    std::fs::write(&paths.script_file, SCRIPT).map_err(|e| describe(&paths.script_file, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.script_file, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| describe(&paths.script_file, e))?;
    }
    std::fs::write(&paths.unit_file, unit).map_err(|e| describe(&paths.unit_file, e))?;
    Ok(())
}

/// Install the unit for the headless mode. Best effort: the outcome goes to desktop.log and never
/// stops the Hub from starting.
#[cfg(target_os = "linux")]
pub fn ensure(data_dir: &Path) {
    let log = |message: &str| {
        let _ = crate::hub_manager::append_desktop_log_for(data_dir, "login-start-unit", message);
    };
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let Some(paths) = paths(xdg.as_deref(), home.as_deref()) else {
        log("Skipped: HOME is not set.");
        return;
    };
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let mut systemctl = |args: &[&str]| {
        std::process::Command::new("systemctl")
            .arg("--user")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    };
    match ensure_at(&paths, uid, &mut systemctl) {
        // Quiet when nothing changed, so an ordinary start adds nothing to the log.
        Outcome::Unchanged | Outcome::Root => {}
        Outcome::Installed => log(&format!(
            "Installed and enabled {} (starts the Hub after login when it could not start at boot).",
            paths.unit_file.display()
        )),
        Outcome::Refreshed => log(&format!("Refreshed {}.", paths.unit_file.display())),
        Outcome::LeftRemoved => log(&format!(
            "Left {} alone: removed by the user.",
            paths.unit_file.display()
        )),
        Outcome::NoUserSession => log("Skipped: no systemd user manager to run the unit."),
        Outcome::Failed(error) => log(&format!("Could not install {UNIT_NAME}: {error}")),
    }
}

/// Linux only; elsewhere the platform's own startup mechanism applies.
#[cfg(not(target_os = "linux"))]
pub fn ensure(_data_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = paths(None, Some(dir.path())).expect("paths");
        (dir, paths)
    }

    /// Every `systemctl` call the recorder saw, one joined argument list per call.
    type Calls = std::rc::Rc<std::cell::RefCell<Vec<String>>>;

    /// A `systemctl` that records each call, with a user manager unless `session` is false.
    fn recorder(session: bool) -> (Calls, impl FnMut(&[&str]) -> bool) {
        let calls = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = calls.clone();
        let systemctl = move |args: &[&str]| {
            sink.borrow_mut().push(args.join(" "));
            args.first() != Some(&"show-environment") || session
        };
        (calls, systemctl)
    }

    #[test]
    fn paths_match_the_cli_installer() {
        let home = Path::new("/home/u");
        let p = paths(None, Some(home)).unwrap();
        assert_eq!(
            p.unit_file,
            PathBuf::from("/home/u/.config/systemd/user/companion-hub-login-start.service")
        );
        assert_eq!(
            p.script_file,
            PathBuf::from("/home/u/.config/companion-hub/login-start.sh")
        );
        assert_eq!(
            p.marker_file,
            PathBuf::from("/home/u/.config/companion-hub/.login-start-installed")
        );
        assert_eq!(
            paths(Some("/cfg"), Some(home)).unwrap().unit_file,
            PathBuf::from("/cfg/systemd/user/companion-hub-login-start.service")
        );
        assert_eq!(paths(Some("relative"), Some(home)).unwrap(), p);
        assert_eq!(paths(None, None), None);
    }

    #[test]
    fn the_unit_runs_the_script_and_quotes_a_path_with_a_space() {
        let unit = render_service(Path::new("/home/u/.config/companion-hub/login-start.sh"));
        assert!(unit.contains("ExecStart=/bin/sh /home/u/.config/companion-hub/login-start.sh\n"));
        assert!(unit.contains("ConditionPathExists=/home/u/.config/companion-hub/login-start.sh\n"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains('@'));
        let spaced = render_service(Path::new("/home/a b/login-start.sh"));
        assert!(spaced.contains("ExecStart=/bin/sh \"/home/a b/login-start.sh\"\n"));
    }

    #[test]
    fn first_install_writes_both_files_and_enables_the_unit() {
        let (_dir, paths) = temp_paths();
        let (calls, mut systemctl) = recorder(true);
        assert_eq!(ensure_at(&paths, 1000, &mut systemctl), Outcome::Installed);
        assert_eq!(std::fs::read_to_string(&paths.script_file).unwrap(), SCRIPT);
        assert_eq!(
            std::fs::read_to_string(&paths.unit_file).unwrap(),
            render_service(&paths.script_file)
        );
        assert!(paths.marker_file.exists());
        assert!(calls.borrow().contains(&format!("enable {UNIT_NAME}")));
    }

    #[test]
    fn later_runs_never_enable_again_and_rewrite_only_a_stale_file() {
        let (_dir, paths) = temp_paths();
        ensure_at(&paths, 1000, &mut recorder(true).1);

        let (calls, mut systemctl) = recorder(true);
        assert_eq!(ensure_at(&paths, 1000, &mut systemctl), Outcome::Unchanged);
        std::fs::write(&paths.script_file, "old").unwrap();
        assert_eq!(ensure_at(&paths, 1000, &mut systemctl), Outcome::Refreshed);
        assert_eq!(std::fs::read_to_string(&paths.script_file).unwrap(), SCRIPT);
        assert!(!calls.borrow().iter().any(|c| c.starts_with("enable")));
    }

    #[test]
    fn a_deleted_unit_stays_deleted() {
        let (_dir, paths) = temp_paths();
        ensure_at(&paths, 1000, &mut recorder(true).1);
        std::fs::remove_file(&paths.unit_file).unwrap();
        let (calls, mut systemctl) = recorder(true);
        assert_eq!(
            ensure_at(&paths, 1000, &mut systemctl),
            Outcome::LeftRemoved
        );
        assert!(!paths.unit_file.exists());
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn root_and_a_missing_user_manager_get_nothing() {
        let (_dir, paths) = temp_paths();
        assert_eq!(ensure_at(&paths, 0, &mut recorder(true).1), Outcome::Root);
        assert_eq!(
            ensure_at(&paths, 1000, &mut recorder(false).1),
            Outcome::NoUserSession
        );
        assert!(!paths.unit_file.exists());
        assert!(!paths.script_file.exists());
    }
}
