//! Whether this is a Companion OS live session, and what the image stops from running in one.
//!
//! The image bakes Ollama and Tailscale in and blocks both services in a live session with a
//! `10-not-live.conf` drop-in, so installing them again can't help: `systemctl enable --now` exits 0
//! and nothing starts. Everything else the session keeps is in RAM and gone after a restart.

use serde::Serialize;
use std::path::Path;

pub(crate) const LIVE_SESSION_OLLAMA_REFUSAL: &str =
    "Ollama can't run in a live session. Install Companion OS to run AI models on this machine.";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionState {
    pub live: bool,
    pub ollama_blocked: bool,
    pub tailscale_blocked: bool,
}

/// `root` is `/` outside tests. A stock Ubuntu live session has no Companion OS files, and an
/// installed Companion OS has no `/cdrom/casper`, so neither counts.
pub(crate) fn live_session_state_at(root: &Path) -> LiveSessionState {
    let live =
        root.join("cdrom/casper/vmlinuz").exists() && root.join("usr/lib/ci-os/version").exists();
    let blocked = |unit: &str| {
        live && root
            .join("etc/systemd/system")
            .join(format!("{unit}.service.d/10-not-live.conf"))
            .exists()
    };
    LiveSessionState {
        live,
        ollama_blocked: blocked("ollama"),
        tailscale_blocked: blocked("tailscaled"),
    }
}

pub fn live_session_state() -> LiveSessionState {
    if cfg!(target_os = "linux") {
        live_session_state_at(Path::new("/"))
    } else {
        LiveSessionState::default()
    }
}
