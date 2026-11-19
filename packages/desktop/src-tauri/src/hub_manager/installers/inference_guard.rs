//! Keeps the local AI servers this app sets up off the network.
//!
//! ⚠ OLLAMA HAS NO LOGIN. On Linux, and inside the WSL2 distro of a native WSL engine, the Hub
//! container reaches the host's Ollama (and vLLM) over the Docker bridge, at the host-gateway
//! address (`host.docker.internal` → 172.17.0.1). A server on 127.0.0.1 cannot be reached from
//! there, so the installer binds Ollama to 0.0.0.0, and the runner starts vLLM on 0.0.0.0 too. That
//! also put them on every other interface: anyone on the same Wi-Fi, LAN or VPN could use the GPU,
//! read the models, and pull or delete them.
//!
//! So the servers stay on 0.0.0.0, which keeps the `ollama` command and every container working, and
//! a small nftables table drops their ports on every interface but loopback and Docker's bridges.
//! It is a table of our own, at the input hook, so it holds whatever ufw or firewalld do (a drop in
//! any table at a hook is final), and they leave it alone when they reload. A systemd unit loads it
//! at boot, before Ollama starts.
//!
//! vLLM also gets an API key (`inference_runners`), because a person can start it on another port.

/// Ollama's port, and the vLLM port the desktop starts it on (`inference_runners::VLLM_PORT`).
pub(crate) const INFERENCE_GUARD_PORTS: [u16; 2] = [11434, 8002];

pub(crate) const INFERENCE_GUARD_TABLE: &str = "companion_hub_inference";
pub(crate) const INFERENCE_GUARD_UNIT: &str = "companion-hub-inference-guard.service";
pub(crate) const INFERENCE_GUARD_RULES_PATH: &str = "/etc/companion-hub/inference-guard.nft";

/// The nftables rules. Loading them replaces the table whole, so loading twice is the same as once.
/// `loopback0` is the loopback a WSL2 distro in mirrored networking mode sees Windows on.
pub(crate) fn inference_guard_ruleset() -> String {
    let ports = INFERENCE_GUARD_PORTS
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "table inet {table}\n\
         delete table inet {table}\n\
         table inet {table} {{\n\
         \tchain input {{\n\
         \t\ttype filter hook input priority -5; policy accept;\n\
         \t\tiifname \"lo\" accept\n\
         \t\tiifname \"loopback0\" accept\n\
         \t\tiifname \"docker0\" accept\n\
         \t\tiifname \"br-*\" accept\n\
         \t\ttcp dport {{ {ports} }} drop\n\
         \t}}\n\
         }}\n",
        table = INFERENCE_GUARD_TABLE,
    )
}

/// POSIX shell, run as root, that installs the rules and the unit that loads them at boot, and loads
/// them now. Installs nftables with the system package manager when `nft` is missing. Exits non-zero
/// when the rules could not be loaded.
pub(crate) fn inference_guard_install_script() -> String {
    format!(
        r#"# ── Keep the local AI servers off the network (inference_guard.rs) ──
if ! command -v nft >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nftables \
            || {{ apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nftables; }}
    elif command -v dnf >/dev/null 2>&1; then dnf install -y nftables
    elif command -v yum >/dev/null 2>&1; then yum install -y nftables
    elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm nftables
    elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install nftables
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache nftables
    fi
fi
nft_bin="$(command -v nft)" || {{ echo "nftables (nft) is not installed and could not be installed" >&2; exit 1; }}
install -d -m 0755 "$(dirname {rules_path})"
cat > {rules_path} <<'COMPANION_HUB_NFT'
{ruleset}COMPANION_HUB_NFT
chmod 0644 {rules_path}
"$nft_bin" -c -f {rules_path}
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/{unit} <<COMPANION_HUB_UNIT
[Unit]
Description=Companion Hub: keep local AI servers off the network
DefaultDependencies=no
Before=network-pre.target ollama.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$nft_bin -f {rules_path}
ExecStop=$nft_bin delete table inet {table}

[Install]
WantedBy=multi-user.target
COMPANION_HUB_UNIT
    systemctl daemon-reload
    systemctl enable {unit}
    systemctl restart {unit}
else
    "$nft_bin" -f {rules_path}
fi
echo inference-guard-active
"#,
        rules_path = INFERENCE_GUARD_RULES_PATH,
        ruleset = inference_guard_ruleset(),
        unit = INFERENCE_GUARD_UNIT,
        table = INFERENCE_GUARD_TABLE,
    )
}

/// What the desktop can see, without root, about whether this machine's AI servers reach the network.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiNetworkExposure {
    /// A guarded port has a listener on every interface (0.0.0.0 or ::).
    pub listening_on_all_interfaces: bool,
    /// The guard's unit is active.
    pub guarded: bool,
    /// Whether this computer can install the guard from the desktop (Linux with pkexec).
    pub can_protect: bool,
}

impl LocalAiNetworkExposure {
    /// Reachable from the network: the case to warn about.
    pub fn exposed(&self) -> bool {
        self.listening_on_all_interfaces && !self.guarded
    }
}

/// The ports in `/proc/net/tcp` or `/proc/net/tcp6` text that are listening on every interface.
pub(crate) fn wildcard_listening_ports(proc_net_tcp: &str) -> Vec<u16> {
    proc_net_tcp
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let local = fields.nth(1)?;
            let state = fields.nth(1)?;
            if state != "0A" {
                return None;
            }
            let (address, port) = local.split_once(':')?;
            if address.chars().any(|c| c != '0') {
                return None;
            }
            u16::from_str_radix(port, 16).ok()
        })
        .collect()
}

#[cfg(target_os = "linux")]
pub fn local_ai_network_exposure() -> LocalAiNetworkExposure {
    let mut listening = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = std::fs::read_to_string(path) {
            listening.extend(wildcard_listening_ports(&text));
        }
    }
    let guarded = std::process::Command::new("systemctl")
        .args(["is-active", "--quiet", INFERENCE_GUARD_UNIT])
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    LocalAiNetworkExposure {
        listening_on_all_interfaces: INFERENCE_GUARD_PORTS
            .iter()
            .any(|port| listening.contains(port)),
        guarded,
        can_protect: super::find_executable("pkexec").is_some(),
    }
}

/// Elsewhere the desktop sets up nothing on every interface: Docker Desktop reaches the host's own
/// loopback, and a native WSL engine's distro gets the guard at startup, as root, with no prompt.
#[cfg(not(target_os = "linux"))]
pub fn local_ai_network_exposure() -> LocalAiNetworkExposure {
    LocalAiNetworkExposure::default()
}

/// Install the guard on this Linux machine, asking for the password with pkexec.
#[cfg(target_os = "linux")]
pub fn protect_local_ai() -> Result<(), String> {
    let pkexec = super::find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;
    let script = format!("#!/bin/sh\nset -e\n{}", inference_guard_install_script());
    let wrapper = super::write_elevated_script(script.as_bytes())?;
    let output = std::process::Command::new(&pkexec)
        .arg(&*wrapper)
        .output()
        .map_err(|e| format!("Failed to run pkexec: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout).trim(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    if super::pkexec_refused(output.status.code(), &combined) {
        return Err("Authorization was cancelled or denied.".to_string());
    }
    Err(format!(
        "Could not protect the local AI servers: {}",
        combined.trim()
    ))
}

#[cfg(not(target_os = "linux"))]
pub fn protect_local_ai() -> Result<(), String> {
    Err(
        "Only needed on Linux, where the desktop app sets the AI servers up on every interface."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rules_drop_only_the_ai_ports_and_only_off_loopback_and_docker() {
        let rules = inference_guard_ruleset();
        // Replaces the table whole: loading twice is the same as once.
        assert!(rules.starts_with(
            "table inet companion_hub_inference\ndelete table inet companion_hub_inference\n"
        ));
        assert!(rules.contains("type filter hook input priority -5; policy accept;"));
        for interface in ["lo", "loopback0", "docker0", "br-*"] {
            assert!(
                rules.contains(&format!("iifname \"{interface}\" accept")),
                "{interface}"
            );
        }
        assert!(rules.contains("tcp dport { 11434, 8002 } drop"));
        // The accepts come before the drop.
        assert!(rules.find("br-*").unwrap() < rules.find("drop").unwrap());
        assert_eq!(rules.matches(" drop").count(), 1);
    }

    #[test]
    fn the_install_script_checks_the_rules_and_loads_them_at_boot_before_ollama() {
        let script = inference_guard_install_script();
        assert!(script.contains("\"$nft_bin\" -c -f /etc/companion-hub/inference-guard.nft"));
        assert!(script.contains("Before=network-pre.target ollama.service"));
        assert!(script.contains("ExecStart=$nft_bin -f /etc/companion-hub/inference-guard.nft"));
        assert!(script.contains("systemctl enable companion-hub-inference-guard.service"));
        assert!(script.contains(&inference_guard_ruleset()));
        assert!(script.trim_end().ends_with("echo inference-guard-active"));
    }

    #[test]
    fn the_install_script_is_valid_posix_shell() {
        let status = std::process::Command::new("sh")
            .args(["-n", "-c", &inference_guard_install_script()])
            .status()
            .expect("sh");
        assert!(status.success());
    }

    #[test]
    fn finds_ports_listening_on_every_interface_and_nothing_else() {
        // 11434 on 0.0.0.0 listening; 8002 on 127.0.0.1 listening; 5002 on 0.0.0.0 but established.
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
                     0: 00000000:2CAA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   997        0 1\n\
                     1: 0100007F:1F42 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2\n\
                     2: 00000000:138A 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3\n";
        assert_eq!(wildcard_listening_ports(tcp), vec![11434]);
        let tcp6 = "  sl  local_address                         remote_address                        st\n\
                      0: 00000000000000000000000000000000:1F42 00000000000000000000000000000000:0000 0A 0\n\
                      1: 00000000000000000000000001000000:2CAA 00000000000000000000000000000000:0000 0A 0\n";
        assert_eq!(wildcard_listening_ports(tcp6), vec![8002]);
    }

    #[test]
    fn exposed_means_listening_everywhere_with_no_guard() {
        let exposure = |listening_on_all_interfaces, guarded| LocalAiNetworkExposure {
            listening_on_all_interfaces,
            guarded,
            can_protect: true,
        };
        assert!(exposure(true, false).exposed());
        assert!(!exposure(true, true).exposed());
        assert!(!exposure(false, false).exposed());
    }
}
