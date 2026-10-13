//! Running commands inside the Hub's containers, on an engine that loses `docker exec` output.
//!
//! Through the Docker engine the Windows desktop app runs in WSL2 (`tcp://127.0.0.1:2375`), the
//! docker CLI half-closes the exec stream at once when no stdin is attached, and WSL's localhost
//! forwarding drops the rest. Nothing the command prints comes back, and `docker exec` exits 0
//! whatever the command did. `docker cp` still works there, since it returns the files in one
//! response. So when a command that always prints something comes back empty with status 0, it runs
//! again detached (`docker exec -d`), writing its output and exit status to files in the container,
//! and the files are copied out. The CLI does the same in `scripts/lib/docker-exec-output.ts`.

use super::*;
use std::cell::Cell;

/// Runs the docker CLI with these arguments. Tests pass a stand-in that acts like a given engine.
pub(crate) type DockerCli<'a> = &'a dyn Fn(&[&str]) -> std::io::Result<std::process::Output>;

/// The real docker CLI, on the engine the Hub is pinned to.
pub(crate) fn run_docker_cli(args: &[&str]) -> std::io::Result<std::process::Output> {
    docker_command().args(args).output()
}

/// Runs the command after `$1` with its output, then its exit status, in files under `$1`. The
/// status goes in through a rename, so the folder holds all of the output whenever it holds `status`.
const COPY_ROUTE_SCRIPT: &str = r#"d=$1; shift; mkdir -p "$d" || exit; "$@" >"$d/out" 2>"$d/err"; echo $? >"$d/status.tmp" && mv "$d/status.tmp" "$d/status""#;
/// Pause between looks for the exit status of a command run through the copy route.
const COPY_ROUTE_POLL_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug)]
pub(crate) struct ContainerOutput {
    /// The command's exit status, or `None` when docker could not run it or no status came back.
    pub(crate) status: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl ContainerOutput {
    pub(crate) fn succeeded(&self) -> bool {
        self.status == Some(0)
    }
}

/// Runs commands in one container and returns what they printed. Only for commands that print
/// something when they succeed and are safe to run twice: an exit status of 0 with nothing printed
/// means the output was lost, and the command then runs again through the copy route, as does
/// every later command from this reader.
pub(crate) struct ContainerReader<'a> {
    docker: DockerCli<'a>,
    container: &'a str,
    /// How long the copy route waits for the command to finish.
    timeout: Duration,
    copy_out: Cell<bool>,
}

impl<'a> ContainerReader<'a> {
    pub(crate) fn new(docker: DockerCli<'a>, container: &'a str, timeout: Duration) -> Self {
        Self {
            docker,
            container,
            timeout,
            copy_out: Cell::new(false),
        }
    }

    pub(crate) fn run(&self, command: &[&str]) -> ContainerOutput {
        if !self.copy_out.get() {
            let direct = self.exec_direct(command);
            if direct.status != Some(0) || !direct.stdout.is_empty() {
                return direct;
            }
            self.copy_out.set(true);
        }
        self.exec_through_copy(command)
    }

    fn exec_direct(&self, command: &[&str]) -> ContainerOutput {
        let mut args = vec!["exec", self.container];
        args.extend_from_slice(command);
        match (self.docker)(&args) {
            Ok(output) => ContainerOutput {
                status: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            },
            Err(error) => ContainerOutput {
                status: None,
                stdout: String::new(),
                stderr: format!("Failed to exec into {}: {error}", self.container),
            },
        }
    }

    /// Starts `command` detached with its output sent to a new folder under /tmp in the container,
    /// copies the folder out once the exit status is in it, and removes it.
    fn exec_through_copy(&self, command: &[&str]) -> ContainerOutput {
        let dir = format!("/tmp/ci-hub-exec-{:016x}", rand::random::<u64>());
        let mut args = vec![
            "exec",
            "-d",
            self.container,
            "sh",
            "-c",
            COPY_ROUTE_SCRIPT,
            "sh",
            &dir,
        ];
        args.extend_from_slice(command);
        // Nothing ran when this fails, and docker says why: a stopped container, or no docker.
        match (self.docker)(&args) {
            Ok(output) if output.status.success() => {}
            Ok(output) => {
                return ContainerOutput {
                    status: output.status.code(),
                    stdout: String::new(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                }
            }
            Err(error) => {
                return ContainerOutput {
                    status: None,
                    stdout: String::new(),
                    stderr: format!("Failed to exec into {}: {error}", self.container),
                }
            }
        }

        let result = self.copy_result_out(&dir);
        let _ = (self.docker)(&["exec", "-d", self.container, "rm", "-rf", &dir]);
        result.unwrap_or_else(|| ContainerOutput {
            status: None,
            stdout: String::new(),
            stderr: format!(
                "No result came back from {} within {} s.",
                self.container,
                self.timeout.as_secs()
            ),
        })
    }

    /// Copies `dir` out of the container until it holds `status`, or the timeout passes.
    fn copy_result_out(&self, dir: &str) -> Option<ContainerOutput> {
        let local = tempfile::tempdir().ok()?;
        let target = local.path().join("result");
        let target_arg = target.to_string_lossy().to_string();
        let source = format!("{}:{dir}", self.container);
        let deadline = Instant::now() + self.timeout;
        loop {
            // `docker cp` into an existing folder nests the copy, so each look starts clean.
            let _ = std::fs::remove_dir_all(&target);
            let copied = (self.docker)(&["cp", &source, &target_arg])
                .map(|output| output.status.success())
                .unwrap_or(false);
            if copied {
                if let Ok(status) = std::fs::read_to_string(target.join("status")) {
                    let read = |name: &str| {
                        std::fs::read_to_string(target.join(name))
                            .map(|text| text.trim().to_string())
                            .unwrap_or_default()
                    };
                    return Some(ContainerOutput {
                        status: status.trim().parse().ok(),
                        stdout: read("out"),
                        stderr: read("err"),
                    });
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(COPY_ROUTE_POLL_INTERVAL);
        }
    }
}
