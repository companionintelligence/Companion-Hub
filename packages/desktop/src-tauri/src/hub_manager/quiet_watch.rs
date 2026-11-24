//! Runs a command that reports its progress, and gives up on it once it goes quiet.
//!
//! `docker compose pull` prints every layer's progress, so a slow connection keeps it talking and
//! only a download that has stopped goes silent. Waiting on `.output()` would wait for that forever.

use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What is kept of each stream. Progress output runs to thousands of lines and only the end says
/// anything about a failure.
const KEPT_OUTPUT_BYTES: usize = 64 * 1024;
/// How long a stopped command gets to leave before it is killed outright.
const TERMINATE_GRACE: Duration = Duration::from_secs(5);
/// How long to wait for the last output of a command that has exited.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub(crate) enum WatchedRun {
    Finished {
        status: ExitStatus,
        stdout: String,
        stderr: String,
    },
    /// Said nothing for the whole limit, so it and its children were stopped.
    WentQuiet { stdout: String, stderr: String },
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

#[derive(Default)]
struct Tail(Vec<u8>);

impl Tail {
    fn push(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
        if self.0.len() > KEPT_OUTPUT_BYTES {
            let excess = self.0.len() - KEPT_OUTPUT_BYTES;
            self.0.drain(..excess);
        }
    }

    fn into_string(self) -> String {
        String::from_utf8_lossy(&self.0).into_owned()
    }
}

/// Runs `command` to the end, or until it has printed nothing for `quiet_limit`.
pub(crate) fn run_until_quiet(
    mut command: Command,
    quiet_limit: Duration,
) -> std::io::Result<WatchedRun> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // `docker compose` is the docker CLI running a plugin: stopping only the CLI leaves the plugin
    // pulling, and holding these pipes open.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    let (sender, receiver) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        forward(stdout, Stream::Stdout, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        forward(stderr, Stream::Stderr, sender.clone());
    }
    drop(sender);

    let mut stdout = Tail::default();
    let mut stderr = Tail::default();
    let mut keep = |stream: Stream, bytes: &[u8]| match stream {
        Stream::Stdout => stdout.push(bytes),
        Stream::Stderr => stderr.push(bytes),
    };

    let mut last_output = Instant::now();
    let mut went_quiet = false;
    let status = loop {
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok((stream, bytes)) => {
                keep(stream, &bytes);
                last_output = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // It closed both pipes and may still be running. There is nothing left to wake us.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if last_output.elapsed() >= quiet_limit {
            went_quiet = true;
            break stop_process_tree(&mut child)?;
        }
    };

    // A leftover child can hold a pipe open after the command has gone, so don't wait on the pipes.
    let drain_until = Instant::now() + DRAIN_GRACE;
    while let Some(left) = drain_until.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(left) {
            Ok((stream, bytes)) => keep(stream, &bytes),
            Err(_) => break,
        }
    }

    let (stdout, stderr) = (stdout.into_string(), stderr.into_string());
    Ok(if went_quiet {
        WatchedRun::WentQuiet { stdout, stderr }
    } else {
        WatchedRun::Finished {
            status,
            stdout,
            stderr,
        }
    })
}

fn forward(
    mut pipe: impl Read + Send + 'static,
    stream: Stream,
    sender: mpsc::Sender<(Stream, Vec<u8>)>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send((stream, buffer[..read].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(unix)]
fn stop_process_tree(child: &mut std::process::Child) -> std::io::Result<ExitStatus> {
    // `process_group(0)` made the child the leader of its own group, whose id is its pid.
    let group = child.id() as libc::pid_t;
    // SAFETY: killpg only takes two integers. The child isn't reaped yet, so the group is ours.
    unsafe { libc::killpg(group, libc::SIGTERM) };
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // The leader leaving doesn't mean the rest of the group has. An empty group answers with an error.
    // SAFETY: killpg only takes two integers.
    unsafe { libc::killpg(group, libc::SIGKILL) };
    child.wait()
}

#[cfg(windows)]
fn stop_process_tree(child: &mut std::process::Child) -> std::io::Result<ExitStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    child.kill()?;
    child.wait()
}
