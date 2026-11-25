//! Linux process setup that runs first thing in `main`, before GTK starts or any thread exists
//! (changing the environment is only sound then).

use std::ffi::OsStr;

/// GTK's accessibility bridge gives every accessibility client (a screen reader, or any tool that
/// reads the window) its own D-Bus connection to the app, and keeps three pidfds open for each
/// one after it has gone. Over a long session the app runs out of open files, and then Docker
/// checks, dialogs and the WebView fail. With this set, clients reach the app through the
/// accessibility bus instead and nothing is left behind.
const ATSPI_DISABLE_P2P: &str = "ATSPI_DISABLE_P2P";

pub fn prepare() {
    if should_disable_atspi_peer_to_peer(std::env::var_os(ATSPI_DISABLE_P2P).as_deref()) {
        std::env::set_var(ATSPI_DISABLE_P2P, "1");
    }
    raise_open_file_limit();
}

/// Left as it is when the person set it themselves.
fn should_disable_atspi_peer_to_peer(current: Option<&OsStr>) -> bool {
    current.is_none()
}

/// The most the soft limit is raised to: systemd's hard limit. Some hosts (containers, sessions
/// not started by systemd) set the hard limit near fs.nr_open, about two billion, and every child
/// inherits the soft limit; programs that loop over every possible descriptor crawl at that size.
const OPEN_FILE_LIMIT_CAP: libc::rlim_t = 524_288;

/// A backstop for any other leak. An app started from the desktop gets a soft limit of 1024 open
/// files, and may raise it to the hard limit without privileges.
fn raise_open_file_limit() {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit and setrlimit only read and write the struct passed to them.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return;
    }
    if let Some(soft) = raised_soft_limit(limit.rlim_cur, limit.rlim_max) {
        limit.rlim_cur = soft;
        // SAFETY: as above.
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) };
    }
}

fn raised_soft_limit(soft: libc::rlim_t, hard: libc::rlim_t) -> Option<libc::rlim_t> {
    let target = hard.min(OPEN_FILE_LIMIT_CAP);
    (soft < target).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn peer_to_peer_accessibility_is_turned_off_unless_the_person_chose() {
        assert!(should_disable_atspi_peer_to_peer(None));
        assert!(!should_disable_atspi_peer_to_peer(Some(OsStr::new("0"))));
        assert!(!should_disable_atspi_peer_to_peer(Some(OsStr::new("1"))));
    }

    #[test]
    fn the_soft_open_file_limit_rises_to_the_hard_one_up_to_the_cap() {
        assert_eq!(raised_soft_limit(1024, 524_288), Some(524_288));
        assert_eq!(raised_soft_limit(1024, 65_536), Some(65_536));
        assert_eq!(raised_soft_limit(524_288, 524_288), None);
        assert_eq!(raised_soft_limit(1024, 1_073_741_816), Some(524_288));
        assert_eq!(raised_soft_limit(524_288, 1_073_741_816), None);
    }

    /// Runs the real function in a child that starts at the desktop's default of 1024, so the
    /// test process's own limit is left alone.
    #[test]
    fn a_process_started_at_1024_open_files_ends_at_its_hard_limit_or_the_cap() {
        let mut command = Command::new("sh");
        command.args(["-c", "ulimit -Sn; ulimit -Hn"]);
        // SAFETY: the closure only makes the getrlimit and setrlimit system calls, which are safe
        // between fork and exec.
        unsafe {
            command.pre_exec(|| {
                let mut limit = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
                limit.rlim_cur = limit.rlim_max.min(1024);
                libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
                raise_open_file_limit();
                Ok(())
            });
        }
        let output = command.output().expect("run sh");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines();
        let (soft, hard) = (lines.next(), lines.next());
        if hard == Some("1024") {
            // Nothing to raise on a machine whose hard limit is the default itself.
            return;
        }

        let parse = |value: Option<&str>| value.and_then(|v| v.trim().parse::<libc::rlim_t>().ok());
        let (soft, hard) = (parse(soft), parse(hard));
        let hard = hard.unwrap_or_else(|| panic!("no limits printed: {stdout}"));
        assert_eq!(
            soft,
            Some(hard.min(OPEN_FILE_LIMIT_CAP)),
            "soft limit not raised: {stdout}"
        );
    }
}
