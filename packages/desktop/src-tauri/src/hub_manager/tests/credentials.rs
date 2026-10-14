//! The Postgres and RabbitMQ password checks against a stand-in Docker engine.

use super::*;
use crate::hub_manager::{
    ensure_postgres_password_matches, rabbitmq_auth_works, rabbitmq_reader, sync_rabbitmq_password,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::process::{ExitStatus, Output};

#[cfg(unix)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code << 8)
}

#[cfg(windows)]
fn exit_status(code: i32) -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(code as u32)
}

fn output(code: i32, stdout: &str, stderr: &str) -> Output {
    Output {
        status: exit_status(code),
        stdout: stdout.as_bytes().to_vec(),
        stderr: stderr.as_bytes().to_vec(),
    }
}

const NAME_LOOKUP_FAILED: &str =
    "psql: error: could not translate host name \"ci-hub-db\" to address: Name or service not known";

/// A command's exit status and what it printed to stdout and stderr.
type Ran = (i32, String, String);

/// An engine running `ci-hub-db` (stock `postgres:14` on `ci-hub_internal`) and `ci-hub-queue`.
/// As in the real image, Postgres trusts loopback connections and asks everyone else for the
/// role's password.
struct FakeEngine {
    /// False acts like the WSL engine at `tcp://127.0.0.1:2375`: `docker exec` exits 0 and prints
    /// nothing whatever the command did, and `docker run` keeps its exit status but prints nothing.
    streams_output: bool,
    /// ALTER USER and `rabbitmqctl change_password` fail.
    password_changes_fail: bool,
    /// psql inside `ci-hub-db` can't resolve the container's own name.
    name_lookup_fails_inside: bool,
    /// `docker inspect ci-hub-db` fails, so nothing says which networks the database is on.
    inspect_fails: bool,
    /// psql in a `docker run` client can't resolve `ci-hub-db` on any network.
    name_lookup_fails_outside: bool,
    db_password: RefCell<String>,
    queue_password: RefCell<String>,
    /// Folders the detached route left in a container, with what the command did.
    container_dirs: RefCell<HashMap<String, Ran>>,
    calls: RefCell<Vec<String>>,
}

impl FakeEngine {
    fn new(streams_output: bool, password: &str) -> Self {
        Self {
            streams_output,
            password_changes_fail: false,
            name_lookup_fails_inside: false,
            inspect_fails: false,
            name_lookup_fails_outside: false,
            db_password: RefCell::new(password.to_string()),
            queue_password: RefCell::new(password.to_string()),
            container_dirs: RefCell::new(HashMap::new()),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn wsl_engine(password: &str) -> Self {
        Self::new(false, password)
    }

    fn streaming_engine(password: &str) -> Self {
        Self::new(true, password)
    }

    fn ran_alter_user(&self) -> bool {
        self.calls
            .borrow()
            .iter()
            .any(|call| call.contains("ALTER USER"))
    }

    fn docker(&self, args: &[&str]) -> std::io::Result<Output> {
        self.calls.borrow_mut().push(args.join(" "));
        match args {
            ["exec", "-d", _, "rm", "-rf", dir] => {
                self.container_dirs.borrow_mut().remove(*dir);
                Ok(output(0, "", ""))
            }
            ["exec", "-d", _, "sh", "-c", _, "sh", dir, command @ ..] => {
                let ran = self.run_in_container(command);
                self.container_dirs
                    .borrow_mut()
                    .insert(dir.to_string(), ran);
                Ok(output(0, "", ""))
            }
            ["exec", _, command @ ..] => {
                let (code, stdout, stderr) = self.run_in_container(command);
                if self.streams_output {
                    Ok(output(code, &stdout, &stderr))
                } else {
                    Ok(output(0, "", ""))
                }
            }
            ["cp", source, target] => {
                let dir = source.split_once(':').map(|(_, dir)| dir).unwrap_or("");
                let Some((code, stdout, stderr)) = self.container_dirs.borrow().get(dir).cloned()
                else {
                    return Ok(output(
                        1,
                        "",
                        "Error response from daemon: Could not find the file",
                    ));
                };
                let target = Path::new(target);
                std::fs::create_dir_all(target)?;
                std::fs::write(target.join("out"), stdout)?;
                std::fs::write(target.join("err"), stderr)?;
                std::fs::write(target.join("status"), format!("{code}\n"))?;
                Ok(output(0, "", ""))
            }
            ["inspect", "-f", _, "ci-hub-db"] if !self.inspect_fails => {
                Ok(output(0, "ci-hub_internal\n", ""))
            }
            ["run", "--rm", "--network", network, "postgres:14", "bash", "-lc", script] => {
                let (code, stdout, stderr) =
                    if *network == "ci-hub_internal" && !self.name_lookup_fails_outside {
                        self.psql_select_one(script)
                    } else {
                        (2, String::new(), NAME_LOOKUP_FAILED.to_string())
                    };
                if self.streams_output {
                    Ok(output(code, &stdout, &stderr))
                } else {
                    Ok(output(code, "", ""))
                }
            }
            _ => Ok(output(
                1,
                "",
                &format!("fake docker: unexpected call {args:?}"),
            )),
        }
    }

    fn run_in_container(&self, command: &[&str]) -> Ran {
        match command {
            ["bash", "-lc", script] => {
                if self.name_lookup_fails_inside && !script.contains(" -h 127.0.0.1 ") {
                    return (2, String::new(), NAME_LOOKUP_FAILED.to_string());
                }
                self.psql_select_one(script)
            }
            ["psql", .., "-c", sql] => {
                if self.password_changes_fail {
                    return (
                        1,
                        String::new(),
                        "ERROR:  permission denied to alter role".to_string(),
                    );
                }
                let password = sql
                    .strip_prefix("ALTER USER companion WITH PASSWORD '")
                    .and_then(|rest| rest.strip_suffix("';"))
                    .expect("ALTER USER statement");
                *self.db_password.borrow_mut() = password.to_string();
                (0, "ALTER ROLE\n".to_string(), String::new())
            }
            ["rabbitmqctl", "authenticate_user", "companion", password] => {
                let banner = "Authenticating user \"companion\" ...\n".to_string();
                if *password == self.queue_password.borrow().as_str() {
                    (0, format!("{banner}Success\n"), String::new())
                } else {
                    (
                        65,
                        banner,
                        "Error:\nUser \"companion\" failed to authenticate: invalid credentials"
                            .to_string(),
                    )
                }
            }
            ["rabbitmqctl", "change_password", "companion", password] => {
                let banner = "Changing password for user \"companion\" ...\n".to_string();
                if self.password_changes_fail {
                    return (
                        70,
                        banner,
                        "Error: operation change_password failed".to_string(),
                    );
                }
                *self.queue_password.borrow_mut() = password.to_string();
                (0, banner, String::new())
            }
            _ => (127, String::new(), format!("{command:?}: not found")),
        }
    }

    /// `psql -h <host> -qt -c 'SELECT 1'` with `PGPASSWORD='<password>'`.
    fn psql_select_one(&self, script: &str) -> Ran {
        let password = script
            .split_once("PGPASSWORD='")
            .and_then(|(_, rest)| rest.split_once('\''))
            .map(|(password, _)| password)
            .unwrap_or_default();
        let host = script
            .split_once(" -h ")
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .unwrap_or_default();
        let loopback = host == "127.0.0.1" || host == "localhost";
        if loopback || password == self.db_password.borrow().as_str() {
            (0, "        1\n\n".to_string(), String::new())
        } else {
            (
                2,
                String::new(),
                "psql: error: connection to server at \"ci-hub-db\" (172.20.0.2), port 6543 failed: \
                 FATAL:  password authentication failed for user \"companion\""
                    .to_string(),
            )
        }
    }
}

fn desktop_log(data_dir: &Path) -> String {
    std::fs::read_to_string(desktop_log_path_for(data_dir)).unwrap_or_default()
}

#[test]
fn postgres_check_syncs_a_wrong_password_on_an_engine_that_drops_exec_output() {
    let engine = FakeEngine::wsl_engine("old-secret");
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "new-secret",
        data_dir.path(),
    );

    assert_eq!(result, Ok(()));
    assert_eq!(engine.db_password.borrow().as_str(), "new-secret");
    assert!(desktop_log(data_dir.path())
        .contains("Postgres TCP auth failed for configured password; syncing role password."));
    assert!(
        engine.container_dirs.borrow().is_empty(),
        "the detached route left its folders behind"
    );
}

#[test]
fn postgres_check_syncs_a_wrong_password_on_an_engine_that_streams_exec_output() {
    let engine = FakeEngine::streaming_engine("old-secret");
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "new-secret",
        data_dir.path(),
    );

    assert_eq!(result, Ok(()));
    assert_eq!(engine.db_password.borrow().as_str(), "new-secret");
}

#[test]
fn postgres_check_fails_when_alter_user_fails_on_an_engine_that_drops_exec_output() {
    let mut engine = FakeEngine::wsl_engine("old-secret");
    engine.password_changes_fail = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "new-secret",
        data_dir.path(),
    );

    let error = result.expect_err("a failed ALTER USER must stop the start");
    assert!(
        error.contains("permission denied to alter role"),
        "unexpected error: {error}"
    );
    assert_eq!(engine.db_password.borrow().as_str(), "old-secret");
}

#[test]
fn postgres_check_leaves_a_matching_password_alone() {
    for engine in [
        FakeEngine::wsl_engine("same-secret"),
        FakeEngine::streaming_engine("same-secret"),
    ] {
        let data_dir = tempfile::tempdir().expect("tempdir");

        let result = ensure_postgres_password_matches(
            &|args: &[&str]| engine.docker(args),
            "same-secret",
            data_dir.path(),
        );

        assert_eq!(result, Ok(()));
        assert!(
            !engine.ran_alter_user(),
            "calls: {:?}",
            engine.calls.borrow()
        );
    }
}

#[test]
fn rabbitmq_check_rejects_a_wrong_password_on_an_engine_that_drops_exec_output() {
    let engine = FakeEngine::wsl_engine("old-secret");
    let docker = |args: &[&str]| engine.docker(args);
    let queue = rabbitmq_reader(&docker, "ci-hub-queue");

    assert!(!rabbitmq_auth_works(&queue, "new-secret"));
    assert!(rabbitmq_auth_works(&queue, "old-secret"));
    let direct_execs = engine
        .calls
        .borrow()
        .iter()
        .filter(|call| call.starts_with("exec ci-hub-queue "))
        .count();
    assert_eq!(direct_execs, 1, "calls: {:?}", engine.calls.borrow());
}

#[test]
fn rabbitmq_sync_reports_a_failed_change_password_on_an_engine_that_drops_exec_output() {
    let mut engine = FakeEngine::wsl_engine("old-secret");
    engine.password_changes_fail = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let docker = |args: &[&str]| engine.docker(args);
    let result = sync_rabbitmq_password(
        &rabbitmq_reader(&docker, "ci-hub-queue"),
        "new-secret",
        data_dir.path(),
    );

    let error = result.expect_err("a failed change_password must be reported");
    assert!(
        error.contains("change_password failed"),
        "unexpected error: {error}"
    );
}

#[test]
fn postgres_check_probes_from_the_network_the_database_is_on() {
    let mut engine = FakeEngine::wsl_engine("same-secret");
    engine.name_lookup_fails_inside = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "same-secret",
        data_dir.path(),
    );

    assert_eq!(result, Ok(()));
    assert!(
        !engine.ran_alter_user(),
        "calls: {:?}",
        engine.calls.borrow()
    );
    assert!(engine
        .calls
        .borrow()
        .iter()
        .any(|call| call.starts_with("run --rm --network ci-hub_internal ")));
}

#[test]
fn postgres_check_probes_from_the_internal_network_when_docker_inspect_fails() {
    let mut engine = FakeEngine::wsl_engine("same-secret");
    engine.name_lookup_fails_inside = true;
    engine.inspect_fails = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "same-secret",
        data_dir.path(),
    );

    assert_eq!(result, Ok(()));
    assert!(
        !engine.ran_alter_user(),
        "calls: {:?}",
        engine.calls.borrow()
    );
}

#[test]
fn postgres_check_keeps_the_exec_probe_error_when_docker_run_prints_nothing() {
    let mut engine = FakeEngine::wsl_engine("same-secret");
    engine.name_lookup_fails_inside = true;
    engine.name_lookup_fails_outside = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "same-secret",
        data_dir.path(),
    );

    let error = result.expect_err("no probe could connect");
    assert!(
        error.contains("could not translate host name"),
        "unexpected error: {error}"
    );
}

#[test]
fn postgres_check_syncs_a_wrong_password_when_only_the_network_probe_can_connect() {
    let mut engine = FakeEngine::wsl_engine("old-secret");
    engine.name_lookup_fails_inside = true;
    let data_dir = tempfile::tempdir().expect("tempdir");

    let result = ensure_postgres_password_matches(
        &|args: &[&str]| engine.docker(args),
        "new-secret",
        data_dir.path(),
    );

    assert_eq!(result, Ok(()));
    assert_eq!(engine.db_password.borrow().as_str(), "new-secret");
}
