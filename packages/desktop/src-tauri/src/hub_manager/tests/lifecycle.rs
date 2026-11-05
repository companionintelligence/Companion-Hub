//! Tests for the `lifecycle` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn invalidate_config_hash_removes_saved_hash() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let hash_path = tempdir.path().join(".config-hash");
    std::fs::write(&hash_path, b"abc123").expect("write hash");

    crate::hub_manager::invalidate_config_hash(tempdir.path());

    assert!(!hash_path.exists(), ".config-hash should be removed");
}

#[test]
fn persist_config_hash_writes_compose_env_fingerprint() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let compose = tempdir.path().join("docker-compose.prod.yml");
    let env = tempdir.path().join(".env");
    std::fs::write(&compose, b"services: {}\n").expect("write compose");
    std::fs::write(&env, b"ROOT_FOLDER_HOST=/data\n").expect("write env");

    crate::hub_manager::persist_config_hash(tempdir.path(), &compose, &env);

    let hash_path = tempdir.path().join(".config-hash");
    let saved = std::fs::read_to_string(&hash_path).expect("hash file");
    let expected = crate::hub_manager::compute_config_hash(&compose, &env);
    assert_eq!(saved, expected);
}

// The startup page opens the Hub only once this reads false. A launch check that panics must not
// leave it true, or the window stays on the startup page for good. And the stop the launch check
// runs inside it ending must not end the launch check.
#[test]
fn stack_change_is_pending_until_every_guard_is_dropped_even_by_a_panic() {
    let pending = || crate::hub_manager::stack_change_state().stack_change_pending;
    assert!(!pending());

    let launch_check = crate::hub_manager::StackChange::begin();
    assert!(pending());
    let stop = crate::hub_manager::StackChange::begin();
    drop(stop);
    assert!(
        pending(),
        "an inner stop ending must not end the launch check"
    );
    drop(launch_check);
    assert!(!pending());

    let panicked = std::panic::catch_unwind(|| {
        let _check = crate::hub_manager::StackChange::begin();
        panic!("launch check failed");
    });
    assert!(panicked.is_err());
    assert!(!pending());
}

#[test]
fn a_hung_pull_names_what_is_missing_and_what_to_do() {
    let one = hung_pull_message(&["postgres:14".to_string()]);
    assert!(
        one.contains("this image is still missing: postgres:14."),
        "{one}"
    );
    assert!(one.contains("restart Docker"), "{one}");

    let two = hung_pull_message(&["traefik:v3.6.12".to_string(), "postgres:14".to_string()]);
    assert!(
        two.contains("these images are still missing: traefik:v3.6.12, postgres:14."),
        "{two}"
    );
}

#[cfg(unix)]
mod quiet_watch {
    use crate::hub_manager::quiet_watch::{run_until_quiet, WatchedRun};
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    /// A killed process stays a zombie until it is reaped, which its new parent does in its own time.
    fn is_gone(pid_file: &std::path::Path) -> bool {
        let pid = std::fs::read_to_string(pid_file).expect("the script wrote its child's pid");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state = Command::new("ps")
                .args(["-o", "stat=", "-p", pid.trim()])
                .output()
                .expect("ps runs");
            let state = String::from_utf8_lossy(&state.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_command_that_ends_is_reported_with_its_status_and_output() {
        let run = run_until_quiet(
            sh("echo out; echo err >&2; exit 3"),
            Duration::from_secs(30),
        )
        .expect("runs");
        match run {
            WatchedRun::Finished {
                status,
                stdout,
                stderr,
            } => {
                assert_eq!(status.code(), Some(3));
                assert_eq!(stdout.trim(), "out");
                assert_eq!(stderr.trim(), "err");
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    #[test]
    fn a_slow_command_that_keeps_talking_is_left_alone() {
        // Runs for about twice the limit, so only its output can be keeping it alive.
        let run = run_until_quiet(
            sh("for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.25; done"),
            Duration::from_secs(1),
        )
        .expect("runs");
        match run {
            WatchedRun::Finished { status, stdout, .. } => {
                assert!(status.success());
                assert!(stdout.contains("tick 8"), "{stdout}");
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }

    #[test]
    fn a_quiet_command_is_stopped_with_its_children_and_keeps_what_it_said() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("pid");
        let script = format!(
            "echo started; sleep 60 & echo $! > '{}'; wait",
            pid_file.display()
        );
        let started = Instant::now();
        let run = run_until_quiet(sh(&script), Duration::from_millis(300)).expect("runs");
        assert!(started.elapsed() < Duration::from_secs(30));
        match run {
            WatchedRun::WentQuiet { stdout, .. } => assert_eq!(stdout.trim(), "started"),
            other => panic!("expected WentQuiet, got {other:?}"),
        }
        // The docker CLI runs compose as a child, which is what would go on pulling.
        assert!(is_gone(&pid_file), "the child is still running");
    }

    #[test]
    fn a_quiet_command_that_ignores_being_asked_to_stop_is_killed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("pid");
        let script = format!(
            "trap '' TERM; sleep 60 & echo $! > '{}'; wait",
            pid_file.display()
        );
        let run = run_until_quiet(sh(&script), Duration::from_millis(300)).expect("runs");
        assert!(matches!(run, WatchedRun::WentQuiet { .. }), "{run:?}");
        assert!(is_gone(&pid_file), "the child is still running");
    }

    #[test]
    fn a_command_that_closes_its_output_and_stays_still_counts_as_quiet() {
        let run = run_until_quiet(
            sh("exec >/dev/null 2>&1; sleep 60"),
            Duration::from_millis(300),
        )
        .expect("runs");
        assert!(matches!(run, WatchedRun::WentQuiet { .. }), "{run:?}");
    }

    #[test]
    fn only_the_end_of_a_long_output_is_kept() {
        let run = run_until_quiet(
            sh("head -c 500000 /dev/zero | tr '\\0' x; echo; echo the-cause"),
            Duration::from_secs(30),
        )
        .expect("runs");
        match run {
            WatchedRun::Finished { stdout, .. } => {
                assert!(stdout.len() <= 64 * 1024, "kept {} bytes", stdout.len());
                assert!(stdout.trim_end().ends_with("the-cause"));
            }
            other => panic!("expected Finished, got {other:?}"),
        }
    }
}
