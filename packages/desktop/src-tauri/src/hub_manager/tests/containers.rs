//! Tests for the `containers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::process::Output;
use std::time::Duration;

#[test]
fn prefers_a_running_legacy_hub_over_an_exited_canonical_container() {
    let names = ["ci-hub", "ci-os-hub"];
    let chosen = crate::hub_manager::first_preferred_container(&names, |name| match name {
        "ci-hub" => "exited:none".to_string(),
        "ci-os-hub" => "running:healthy".to_string(),
        _ => String::new(),
    });

    assert_eq!(chosen, Some("ci-os-hub"));
}

#[test]
fn wait_decision_keeps_looking_when_the_new_name_exited() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:starting")],
        "Hub",
    );

    assert_eq!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::KeepWaiting
    );
}

#[test]
fn wait_decision_succeeds_when_the_legacy_name_is_healthy() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:healthy")],
        "Hub",
    );

    assert_eq!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::Ready
    );
}

#[test]
fn wait_decision_fails_only_when_every_known_name_has_exited() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "dead:none")],
        "Hub",
    );

    assert!(matches!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::Failed(message) if message.contains("exited during startup")
    ));
}

#[test]
fn rocm_linux_installer_script_gates_on_ubuntu_and_supported_versions() {
    let script = rocm_linux_install_script();

    assert!(script.contains(r#"${ID:-}" != "ubuntu"#));
    assert!(script.contains("22.04) CODENAME=jammy"));
    assert!(script.contains("24.04|26.04) CODENAME=noble"));
    assert!(script.contains("amdgpu-install"));
    assert!(script.contains("--usecase=rocm"));
    assert!(script.contains("reboot_required"));
    assert!(script.contains("repo.radeon.com/amdgpu-install"));
}

// --- is_container_name_conflict / is_oci_runtime_error classifiers ---

#[test]
fn detects_container_name_conflict_from_docker_daemon_message() {
    let output = r#"Error response from daemon: Conflict. The container name "/ci-hub-app" is already in use by container "8dfafdbc3a40". You have to remove (or rename) that container to be able to reuse that name."#;
    assert!(is_container_name_conflict(output));
    assert!(!is_oci_runtime_error(output));
}

#[test]
fn detects_container_name_conflict_case_insensitively() {
    let output = r#"service-app-1  Recreate
Error response from daemon: CONFLICT. The container name "/ci-hub-app" IS ALREADY IN USE BY CONTAINER "8dfafdbc3a40"."#;
    assert!(is_container_name_conflict(output));
}

#[test]
fn does_not_treat_port_allocation_failure_as_container_name_conflict() {
    let output = "Error response from daemon: driver failed programming external connectivity on endpoint ci-hub-app-1: Bind for 0.0.0.0:5432 failed: port is already allocated";
    assert!(!is_container_name_conflict(output));
}

#[test]
fn detects_host_port_bind_conflict_from_traefik_publish_error() {
    let output = r#"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:443 -> 127.0.0.1:0: listen tcp 0.0.0.0:443: bind: address already in use"#;
    assert!(is_host_port_bind_conflict(output));
    assert!(!is_container_name_conflict(output));
}

#[test]
fn detects_oci_runtime_create_failed_message() {
    let output = r#"Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "/app/start.sh": stat /app/start.sh: no such file or directory: unknown"#;
    assert!(is_oci_runtime_error(output));
    assert!(!is_container_name_conflict(output));
}

#[test]
fn detects_failed_to_create_shim_task_message() {
    let output = "service-app-1  Starting\nError response from daemon: failed to create shim task: context deadline exceeded: unknown";
    assert!(is_oci_runtime_error(output));
}

#[test]
fn does_not_treat_pull_access_denied_as_oci_runtime_error() {
    let output = "Error response from daemon: pull access denied for ci-hub-app, repository does not exist or may require 'docker login'";
    assert!(!is_oci_runtime_error(output));
}

// --- Hub Node arch check against a stand-in Docker engine ---

/// An engine running the Hub, whose Node prints `node_arch` for `process.arch`.
struct FakeHubEngine {
    /// False acts like the WSL engine at `tcp://127.0.0.1:2375`: `docker exec` exits 0 and prints
    /// nothing whatever the command did.
    streams_output: bool,
    /// With `streams_output` false, the part of Node's answer a plain `docker exec` brings back, as
    /// when the WSL engine passes on only the first part of the output.
    plain_exec_prints: Option<&'static str>,
    node_arch: &'static str,
    node_exit: i32,
    /// The Hub container isn't running, so docker refuses every `docker exec`.
    stopped: bool,
    /// The docker CLI can't be started.
    no_docker: bool,
    /// `docker cp` finds nothing, so no result comes back through the copy route.
    copy_fails: bool,
    /// Folders the copy route left in the container, with what Node printed.
    container_dirs: RefCell<HashMap<String, String>>,
    calls: RefCell<Vec<String>>,
}

impl FakeHubEngine {
    fn new(streams_output: bool, node_arch: &'static str) -> Self {
        Self {
            streams_output,
            plain_exec_prints: None,
            node_arch,
            node_exit: 0,
            stopped: false,
            no_docker: false,
            copy_fails: false,
            container_dirs: RefCell::new(HashMap::new()),
            calls: RefCell::new(Vec::new()),
        }
    }

    fn streaming_engine(node_arch: &'static str) -> Self {
        Self::new(true, node_arch)
    }

    fn wsl_engine(node_arch: &'static str) -> Self {
        Self::new(false, node_arch)
    }

    fn used_copy_route(&self) -> bool {
        self.calls
            .borrow()
            .iter()
            .any(|call| call.starts_with("exec -d "))
    }

    /// How many times Node ran, by a plain `docker exec` or through the copy route.
    fn node_starts(&self) -> usize {
        self.calls
            .borrow()
            .iter()
            .filter(|call| call.ends_with(" node -p process.arch"))
            .count()
    }

    fn docker(&self, args: &[&str]) -> std::io::Result<Output> {
        self.calls.borrow_mut().push(args.join(" "));
        if self.no_docker {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        }
        let printed = format!("{}\n", self.node_arch);
        match args {
            ["exec", ..] if self.stopped => Ok(output(
                1,
                "",
                "Error response from daemon: container 3c5e0f1b2a7d is not running",
            )),
            ["exec", "-d", _, "rm", "-rf", dir] => {
                self.container_dirs.borrow_mut().remove(*dir);
                Ok(output(0, "", ""))
            }
            ["exec", "-d", _, "sh", "-c", _, "sh", dir, "node", "-p", "process.arch"] => {
                self.container_dirs
                    .borrow_mut()
                    .insert(dir.to_string(), printed);
                Ok(output(0, "", ""))
            }
            ["exec", _, "node", "-p", "process.arch"] if self.streams_output => {
                Ok(output(self.node_exit, &printed, ""))
            }
            ["exec", _, "node", "-p", "process.arch"] => {
                Ok(output(0, self.plain_exec_prints.unwrap_or(""), ""))
            }
            ["cp", source, target] => fake_copy_route_cp(source, target, |dir| {
                let stdout = self.container_dirs.borrow().get(dir).cloned()?;
                (!self.copy_fails).then_some((self.node_exit, stdout, String::new()))
            }),
            _ => Ok(output(
                1,
                "",
                &format!("fake docker: unexpected call {args:?}"),
            )),
        }
    }

    /// Runs the arch check against this engine and returns the desktop log it wrote.
    fn check_arch(&self, expected: &str) -> String {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let docker = |args: &[&str]| self.docker(args);
        // The fake has a result ready at the first look, so the copy route needn't wait.
        let hub = ContainerReader::new(&docker, "ci-hub", Duration::ZERO);
        log_hub_node_arch(&hub, expected, data_dir.path());
        desktop_log(data_dir.path())
    }
}

#[test]
fn hub_node_arch_is_ok_from_a_plain_exec_on_an_engine_that_streams_exec_output() {
    let engine = FakeHubEngine::streaming_engine("x64");

    let log = engine.check_arch("x64");

    assert!(
        log.contains("Hub Node arch ok: process.arch=x64"),
        "log: {log}"
    );
    assert!(
        !engine.used_copy_route(),
        "calls: {:?}",
        engine.calls.borrow()
    );
}

#[test]
fn hub_node_arch_is_read_through_the_copy_route_on_an_engine_that_drops_exec_output() {
    let engine = FakeHubEngine::wsl_engine("x64");

    let log = engine.check_arch("x64");

    assert!(
        log.contains("Hub Node arch ok: process.arch=x64"),
        "log: {log}"
    );
    assert!(!log.contains("mismatch"), "log: {log}");
    assert!(
        engine.container_dirs.borrow().is_empty(),
        "the copy route left its folders behind"
    );
}

#[test]
fn hub_node_arch_that_cannot_be_read_is_not_a_mismatch() {
    let mut copy_fails = FakeHubEngine::wsl_engine("x64");
    copy_fails.copy_fails = true;
    for (engine, reason) in [
        (copy_fails, "No result came back from ci-hub"),
        (FakeHubEngine::wsl_engine(""), "node printed nothing."),
        (FakeHubEngine::streaming_engine(""), "node printed nothing."),
    ] {
        let log = engine.check_arch("x64");

        assert!(
            log.contains(&format!("Could not probe Hub Node arch: {reason}")),
            "log: {log}"
        );
        assert!(!log.contains("mismatch"), "log: {log}");
    }
}

#[test]
fn hub_node_arch_check_logs_the_reason_when_docker_or_node_fails() {
    let mut stopped = FakeHubEngine::streaming_engine("x64");
    stopped.stopped = true;
    let mut no_docker = FakeHubEngine::streaming_engine("x64");
    no_docker.no_docker = true;
    let mut node_crashes = FakeHubEngine::streaming_engine("");
    node_crashes.node_exit = 139;
    let mut node_crashes_on_wsl = FakeHubEngine::wsl_engine("");
    node_crashes_on_wsl.node_exit = 139;
    for (engine, reason) in [
        (stopped, "container 3c5e0f1b2a7d is not running"),
        (no_docker, "Failed to exec into ci-hub"),
        (node_crashes, "node exited with status 139."),
        (node_crashes_on_wsl, "node exited with status 139."),
    ] {
        let log = engine.check_arch("x64");

        assert!(
            log.contains("Could not probe Hub Node arch: "),
            "log: {log}"
        );
        assert!(log.contains(reason), "log: {log}");
        assert!(!log.contains("mismatch"), "log: {log}");
    }
}

#[test]
fn hub_node_arch_mismatch_is_reported_on_either_engine() {
    for (engine, takes_copy_route) in [
        (FakeHubEngine::streaming_engine("arm64"), false),
        (FakeHubEngine::wsl_engine("arm64"), true),
    ] {
        let log = engine.check_arch("x64");

        assert!(
            log.contains(
                "WARNING: Hub Node arch mismatch: container process.arch=arm64, desktop expects x64."
            ),
            "log: {log}"
        );
        assert!(!log.contains("On Apple Silicon"), "log: {log}");
        assert_eq!(
            engine.used_copy_route(),
            takes_copy_route,
            "calls: {:?}",
            engine.calls.borrow()
        );
    }
}

#[test]
fn hub_node_arch_is_ok_when_node_prints_another_line_before_it() {
    let log = FakeHubEngine::streaming_engine("preloaded\nx64").check_arch("x64");

    assert!(
        log.contains("Hub Node arch ok: process.arch=x64"),
        "log: {log}"
    );
    assert!(!log.contains("mismatch"), "log: {log}");
}

#[test]
fn hub_node_arch_mismatch_names_the_arch_when_node_prints_another_line_before_it() {
    let log = FakeHubEngine::streaming_engine("preloaded\narm64").check_arch("x64");

    assert!(
        log.contains(
            "WARNING: Hub Node arch mismatch: container process.arch=arm64, desktop expects x64."
        ),
        "log: {log}"
    );
}

#[test]
fn hub_node_arch_mismatch_gives_the_apple_silicon_advice_only_on_macos() {
    let log = FakeHubEngine::streaming_engine("x64").check_arch("arm64");

    assert!(log.contains("Hub Node arch mismatch"), "log: {log}");
    assert_eq!(
        log.contains("On Apple Silicon"),
        cfg!(target_os = "macos"),
        "log: {log}"
    );
}

#[test]
fn hub_node_arch_mismatch_is_read_from_one_plain_exec_on_an_engine_that_streams_exec_output() {
    let engine = FakeHubEngine::streaming_engine("arm64");

    let log = engine.check_arch("x64");

    assert!(
        log.contains(
            "WARNING: Hub Node arch mismatch: container process.arch=arm64, desktop expects x64."
        ),
        "log: {log}"
    );
    assert_eq!(
        engine.node_starts(),
        1,
        "calls: {:?}",
        engine.calls.borrow()
    );
    assert!(
        !engine.used_copy_route(),
        "calls: {:?}",
        engine.calls.borrow()
    );
}

#[test]
fn hub_node_arch_mismatch_is_reported_on_a_streaming_engine_whose_copy_route_fails() {
    let mut engine = FakeHubEngine::streaming_engine("arm64");
    engine.copy_fails = true;

    let log = engine.check_arch("x64");

    assert!(
        log.contains(
            "WARNING: Hub Node arch mismatch: container process.arch=arm64, desktop expects x64."
        ),
        "log: {log}"
    );
    assert!(!log.contains("Could not probe"), "log: {log}");
}

#[test]
fn hub_node_arch_plain_exec_answer_with_no_arch_line_takes_the_copy_route() {
    // A preload script prints a line before Node does and only that line comes back.
    let mut engine = FakeHubEngine::wsl_engine("preloaded\nx64");
    engine.plain_exec_prints = Some("preloaded");

    let log = engine.check_arch("x64");

    assert!(
        log.contains("Hub Node arch ok: process.arch=x64"),
        "log: {log}"
    );
    assert!(!log.contains("mismatch"), "log: {log}");
    assert!(
        engine.used_copy_route(),
        "calls: {:?}",
        engine.calls.borrow()
    );
}
