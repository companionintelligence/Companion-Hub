//! The program file this app was started from, and whether an update has replaced it since.
//!
//! Installing a new version while the app is open (`dpkg -i`, `rpm -U`, a new `.app` bundle or
//! AppImage) replaces the file on disk, but the open app keeps running the old one until it
//! restarts. Nothing else notices: the app reports the version compiled into it, and a second
//! launch only brings the old window back. On Linux the running file then reads as
//! `/usr/bin/companion-hub (deleted)`, which is not a path anything can start, so restarts go
//! through [`launch_path`].

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

/// What Linux appends to `/proc/self/exe` once the running program's file is replaced or removed.
const DELETED_SUFFIX: &str = " (deleted)";
/// `--version` prints and exits before any window or Hub work, so this is generous.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Enough to tell a replaced file from the one this process started from: a package manager or a
/// copy writes a new file (a new inode on Unix), and any rewrite moves the size or modified time.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    inode: (u64, u64),
}

fn file_identity(path: &Path) -> Option<FileIdentity> {
    let metadata = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    Some(FileIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        inode,
    })
}

struct LaunchBinary {
    path: PathBuf,
    identity: Option<FileIdentity>,
}

static LAUNCH_BINARY: OnceLock<Option<LaunchBinary>> = OnceLock::new();
/// The last `--version` answer, for the file it came from: the Settings page asks every minute.
static PROBED_VERSION: Mutex<Option<(FileIdentity, Option<String>)>> = Mutex::new(None);

/// Records the program file this process started from. Called first thing in `main`, before an
/// update can replace it; later calls are free.
pub fn remember_launch_binary() {
    let _ = launch_binary();
}

fn launch_binary() -> Option<&'static LaunchBinary> {
    LAUNCH_BINARY
        .get_or_init(|| {
            let path = launch_path()?;
            let identity = file_identity(&path);
            Some(LaunchBinary { path, identity })
        })
        .as_ref()
}

/// Under AppImage, `current_exe()` is the FUSE-mounted inner binary, never the
/// `.AppImage` file itself — the runtime exposes the real path via `$APPIMAGE`.
pub(crate) fn appimage_path_from_env() -> Option<PathBuf> {
    appimage_path_from(
        std::env::var_os("APPIMAGE"),
        std::env::var_os("APPDIR"),
        std::env::current_exe().ok(),
    )
}

/// `$APPIMAGE` counts only when this program runs from inside the mounted image (`$APPDIR`).
/// Both are inherited, so a package-installed app started from another AppImage's terminal (an
/// AppImage editor, say) sees that other AppImage's path, and must never restart, probe or replace
/// it.
fn appimage_path_from(
    appimage: Option<OsString>,
    appdir: Option<OsString>,
    exe: Option<PathBuf>,
) -> Option<PathBuf> {
    let appimage = appimage.filter(|value| !value.is_empty())?;
    let appdir = appdir.filter(|value| !value.is_empty())?;
    exe?.starts_with(Path::new(&appdir))
        .then(|| PathBuf::from(appimage))
}

/// The file to start for a fresh copy of this app: the `.AppImage` when running from one (its
/// mounted inner path vanishes once this process exits), otherwise this program's own path,
/// without the " (deleted)" Linux adds once an update has replaced it.
pub fn launch_path() -> Option<PathBuf> {
    if let Some(appimage) = appimage_path_from_env() {
        return Some(appimage);
    }
    std::env::current_exe()
        .ok()
        .map(|exe| strip_deleted_suffix(&exe))
}

fn strip_deleted_suffix(path: &Path) -> PathBuf {
    match path
        .to_str()
        .and_then(|text| text.strip_suffix(DELETED_SUFFIX))
    {
        Some(original) => PathBuf::from(original),
        None => path.to_path_buf(),
    }
}

/// The version compiled into this program.
pub fn running_version() -> String {
    option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim_start_matches('v')
        .to_string()
}

fn replaced(binary: &LaunchBinary) -> bool {
    match (&binary.identity, file_identity(&binary.path)) {
        (Some(started), Some(now)) => *started != now,
        // Nothing was there at startup, and something is now.
        (None, Some(_)) => true,
        // Nothing there now (removed, or mid-install): nothing to restart onto.
        (_, None) => false,
    }
}

/// Asks a program file which version it is. `--version` prints `companion-hub <version>` and
/// exits before any window opens or the Hub is touched (every release since 0.2.65).
fn probe_version(path: &Path, timeout: Duration) -> Option<String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(Some(_)) => return None,
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    parse_version_output(&output)
}

fn parse_version_output(output: &str) -> Option<String> {
    let version = output
        .lines()
        .next()?
        .split_whitespace()
        .last()?
        .trim_start_matches('v');
    let looks_like_version =
        version.starts_with(|c: char| c.is_ascii_digit()) && version.split('.').count() >= 2;
    looks_like_version.then(|| version.to_string())
}

fn installed_version(binary: &LaunchBinary) -> Option<String> {
    let identity = file_identity(&binary.path)?;
    if let Ok(cache) = PROBED_VERSION.lock() {
        if let Some((seen, version)) = cache.as_ref() {
            if *seen == identity {
                return version.clone();
            }
        }
    }
    let version = probe_version(&binary.path, VERSION_PROBE_TIMEOUT);
    if let Ok(mut cache) = PROBED_VERSION.lock() {
        *cache = Some((identity, version.clone()));
    }
    version
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartState {
    pub running_version: String,
    /// The version an update put on disk while this app ran, when the new file said which.
    pub installed_version: Option<String>,
    /// An update replaced this app's file with another version: only a restart starts using it.
    pub restart_required: bool,
}

pub fn restart_state(running_version: &str) -> RestartState {
    let installed = launch_binary()
        .filter(|binary| replaced(binary))
        .map(installed_version);
    restart_state_from(running_version, installed)
}

/// `installed` is `None` when nothing replaced the file, and `Some(None)` when something did but
/// the new file did not say its version. Reinstalling the same version needs no restart.
fn restart_state_from(running_version: &str, installed: Option<Option<String>>) -> RestartState {
    let running_version = running_version.trim_start_matches('v').to_string();
    let restart_required = match &installed {
        None => false,
        Some(None) => true,
        Some(Some(version)) => *version != running_version,
    };
    RestartState {
        running_version,
        installed_version: installed.flatten(),
        restart_required,
    }
}

/// Update listeners (`companion-hub --update-listener`) of this user still running a program file
/// an update has since replaced at `launch_path`; Linux shows such a file as "… (deleted)". They
/// hold the listener's port, so the new app's listener cannot start. Their PIDs, read from
/// `proc_root`.
#[cfg(target_os = "linux")]
pub fn stale_update_listener_pids(
    proc_root: &Path,
    launch_path: &Path,
    own_uid: u32,
    own_pid: u32,
) -> Vec<u32> {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = std::fs::read_dir(proc_root) else {
        return Vec::new();
    };
    let mut pids = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own_pid {
            continue;
        }
        let dir = entry.path();
        if std::fs::metadata(&dir).map(|m| m.uid()).ok() != Some(own_uid) {
            continue;
        }
        let Ok(cmdline) = std::fs::read(dir.join("cmdline")) else {
            continue;
        };
        let args: Vec<&[u8]> = cmdline
            .split(|byte| *byte == 0)
            .filter(|arg| !arg.is_empty())
            .collect();
        if args.len() != 2 || args[1] != b"--update-listener" {
            continue;
        }
        let Ok(exe) = std::fs::read_link(dir.join("exe")) else {
            continue;
        };
        let replaced_here = exe
            .to_str()
            .and_then(|text| text.strip_suffix(DELETED_SUFFIX))
            .is_some_and(|original| Path::new(original) == launch_path);
        if replaced_here {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_deleted_suffix_restores_the_replaced_path() {
        assert_eq!(
            strip_deleted_suffix(Path::new("/usr/bin/companion-hub (deleted)")),
            PathBuf::from("/usr/bin/companion-hub")
        );
        assert_eq!(
            strip_deleted_suffix(Path::new("/usr/bin/companion-hub")),
            PathBuf::from("/usr/bin/companion-hub")
        );
    }

    #[test]
    fn appimage_path_counts_only_inside_the_mounted_image() {
        let os = |value: &str| Some(OsString::from(value));
        let inner = Some(PathBuf::from("/tmp/.mount_HubAbc/usr/bin/companion-hub"));
        assert_eq!(
            appimage_path_from(
                os("/home/u/Apps/Hub.AppImage"),
                os("/tmp/.mount_HubAbc"),
                inner.clone()
            ),
            Some(PathBuf::from("/home/u/Apps/Hub.AppImage"))
        );
        // Inherited from another AppImage: this program runs from /usr/bin.
        assert_eq!(
            appimage_path_from(
                os("/home/u/Apps/Editor.AppImage"),
                os("/tmp/.mount_EditXyz"),
                Some(PathBuf::from("/usr/bin/companion-hub"))
            ),
            None
        );
        assert_eq!(
            appimage_path_from(os("/home/u/Apps/Hub.AppImage"), None, inner.clone()),
            None
        );
        assert_eq!(
            appimage_path_from(os(""), os("/tmp/.mount_HubAbc"), inner),
            None
        );
    }

    #[test]
    fn parse_version_output_reads_the_version_flag() {
        assert_eq!(
            parse_version_output("companion-hub 0.2.78\n").as_deref(),
            Some("0.2.78")
        );
        assert_eq!(
            parse_version_output("companion-hub v0.2.78-rc.1\n").as_deref(),
            Some("0.2.78-rc.1")
        );
        assert_eq!(parse_version_output(""), None);
        assert_eq!(parse_version_output("usage: companion-hub [options]"), None);
    }

    #[test]
    fn restart_needed_only_when_another_version_replaced_the_file() {
        let untouched = restart_state_from("0.2.77", None);
        assert!(!untouched.restart_required);
        assert_eq!(untouched.installed_version, None);

        let upgraded = restart_state_from("v0.2.77", Some(Some("0.2.78".to_string())));
        assert!(upgraded.restart_required);
        assert_eq!(upgraded.running_version, "0.2.77");
        assert_eq!(upgraded.installed_version.as_deref(), Some("0.2.78"));

        let reinstalled = restart_state_from("0.2.77", Some(Some("0.2.77".to_string())));
        assert!(!reinstalled.restart_required);

        let unknown = restart_state_from("0.2.77", Some(None));
        assert!(unknown.restart_required);
        assert_eq!(unknown.installed_version, None);
    }

    #[test]
    fn replaced_spots_a_new_file_at_the_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("companion-hub");
        std::fs::write(&path, b"old build").unwrap();
        let binary = LaunchBinary {
            identity: file_identity(&path),
            path: path.clone(),
        };
        assert!(!replaced(&binary));

        // How dpkg installs a file: write the new one beside it, then rename it over the old.
        let staged = dir.path().join("companion-hub.dpkg-new");
        std::fs::write(&staged, b"new build!").unwrap();
        std::fs::rename(&staged, &path).unwrap();
        assert!(replaced(&binary));

        std::fs::remove_file(&path).unwrap();
        assert!(
            !replaced(&binary),
            "a removed file leaves nothing to restart onto"
        );
    }

    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn probe_version_asks_the_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let answers = write_script(
            dir.path(),
            "answers",
            r#"[ "$1" = "--version" ] && echo "companion-hub 0.2.78""#,
        );
        assert_eq!(
            probe_version(&answers, Duration::from_secs(5)).as_deref(),
            Some("0.2.78")
        );

        let fails = write_script(dir.path(), "fails", "exit 3");
        assert_eq!(probe_version(&fails, Duration::from_secs(5)), None);

        let hangs = write_script(dir.path(), "hangs", "exec sleep 30");
        let started = Instant::now();
        assert_eq!(probe_version(&hangs, Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(target_os = "linux")]
    fn fake_process(proc_root: &Path, pid: u32, args: &[&str], exe: &str) {
        let dir = proc_root.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let mut cmdline = Vec::new();
        for arg in args {
            cmdline.extend_from_slice(arg.as_bytes());
            cmdline.push(0);
        }
        std::fs::write(dir.join("cmdline"), cmdline).unwrap();
        std::os::unix::fs::symlink(exe, dir.join("exe")).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_update_listener_pids_finds_only_replaced_listeners_of_this_app() {
        let proc_root = tempfile::tempdir().unwrap();
        let root = proc_root.path();
        let app = Path::new("/usr/bin/companion-hub");
        let uid = unsafe { libc::geteuid() };

        let listener = ["/usr/bin/companion-hub", "--update-listener"];
        fake_process(root, 101, &listener, "/usr/bin/companion-hub (deleted)");
        // Still running the current file: leave it.
        fake_process(root, 102, &listener, "/usr/bin/companion-hub");
        // The app window itself, also on the replaced file.
        fake_process(
            root,
            103,
            &["/usr/bin/companion-hub"],
            "/usr/bin/companion-hub (deleted)",
        );
        // A listener of another install.
        fake_process(
            root,
            104,
            &["/opt/other/companion-hub", "--update-listener"],
            "/opt/other/companion-hub (deleted)",
        );
        // This process.
        fake_process(root, 105, &listener, "/usr/bin/companion-hub (deleted)");
        std::fs::create_dir_all(root.join("self")).unwrap();

        assert_eq!(stale_update_listener_pids(root, app, uid, 105), vec![101]);
        assert!(stale_update_listener_pids(root, app, uid.wrapping_add(1), 105).is_empty());
    }
}
