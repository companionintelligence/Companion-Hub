//! Files the app keeps for a Hub on the Docker engine inside WSL: the address where the Hub
//! reaches the desktop app's update listener (`state/update-listener.host`), and the logon script
//! that starts the engine (`Startup\CompanionHub-WSL-Docker.vbs`).

// Windows-only bodies below need the parent scope; on other hosts this looks unused.
#[allow(unused_imports)]
use super::*;

// ─── Where the Hub reaches the update listener ────────────────────────────────
//
// The Hub calls the desktop app's update listener (port 17400) at host.docker.internal. On the
// WSL engine that name is the WSL VM, where nothing listens on that port, while the listener runs
// on Windows. The distro's default gateway is the Windows host's address on the WSL adapter, and
// the Hub's container reaches it through the VM, so the app records that address for the Hub.

/// Set when this app starts the engine's distro again. Until the address is recorded once more,
/// the one the Hub has may be the gateway of the WSL network from before.
#[cfg(windows)]
pub(crate) static UPDATE_LISTENER_HOST_STALE: AtomicBool = AtomicBool::new(false);

/// For the status polls once Docker answers: record the listener's address again after the app
/// started the engine's distro, on a thread of its own, since asking the distro runs wsl.exe.
#[cfg(windows)]
pub(crate) fn refresh_update_listener_host_after_revive(data_dir: &Path) {
    if !UPDATE_LISTENER_HOST_STALE.swap(false, Ordering::SeqCst) {
        return;
    }
    let data_dir = data_dir.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("update-listener-host".to_string())
        .spawn(move || record_update_listener_host(&data_dir));
    if spawned.is_err() {
        UPDATE_LISTENER_HOST_STALE.store(true, Ordering::SeqCst);
    }
}

/// The file in `state/` the Hub reads the listener's address from (`UPDATE_LISTENER_HOST_FILENAME`
/// in the backend's `common/constants.ts`).
#[cfg(any(test, windows))]
pub(crate) const UPDATE_LISTENER_HOST_FILENAME: &str = "update-listener.host";

/// The default route's gateway in a `/proc/net/route` table. The table prints addresses as hex in
/// host byte order, little-endian on the x86 and arm64 machines WSL runs on.
#[cfg(any(test, windows))]
pub(crate) fn default_gateway_from_route_table(table: &str) -> Option<std::net::Ipv4Addr> {
    table.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (destination, gateway, mask) = (fields.get(1)?, fields.get(2)?, fields.get(7)?);
        if *destination != "00000000" || *mask != "00000000" {
            return None;
        }
        let gateway = u32::from_str_radix(gateway, 16)
            .ok()
            .filter(|gateway| *gateway != 0)?;
        Some(std::net::Ipv4Addr::from(gateway.to_le_bytes()))
    })
}

/// Whether `address` is one of this computer's own addresses: a socket binds to it only then.
/// With WSL's mirrored networking the distro's default gateway is the router, and the Hub must not
/// send the listener token there.
#[cfg(any(test, windows))]
pub(crate) fn is_own_address(address: std::net::Ipv4Addr) -> bool {
    std::net::TcpListener::bind((address, 0)).is_ok()
}

/// Writes the listener address for the Hub to read, or removes the file for `None`, and says
/// whether that changed anything. Written whole through a temporary file, so the Hub never reads
/// half of it.
#[cfg(any(test, windows))]
pub(crate) fn write_update_listener_host(
    data_dir: &Path,
    address: Option<std::net::Ipv4Addr>,
) -> Result<bool, String> {
    use std::io::Write as _;

    let state_dir = data_dir.join("state");
    let path = state_dir.join(UPDATE_LISTENER_HOST_FILENAME);
    let wanted = address.map(|address| format!("{address}\n"));
    if std::fs::read_to_string(&path).ok() == wanted {
        return Ok(false);
    }
    let Some(content) = wanted else {
        return std::fs::remove_file(&path)
            .map(|()| true)
            .map_err(|error| format!("Couldn't remove {}: {error}", path.display()));
    };
    std::fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Couldn't create {}: {error}", state_dir.display()))?;
    let mut file = tempfile::Builder::new()
        .prefix(".update-listener.host.")
        .tempfile_in(&state_dir)
        .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    file.persist(&path)
        .map_err(|error| format!("Couldn't write {}: {}", path.display(), error.error))?;
    Ok(true)
}

/// Records where the Hub reaches the update listener from inside its container: the Windows host's
/// address on the WSL adapter on the WSL engine, and nothing (so host.docker.internal) on any
/// other. Called only while Docker answers, so asking the distro never starts WSL.
pub fn record_update_listener_host(data_dir: &Path) {
    #[cfg(windows)]
    {
        UPDATE_LISTENER_HOST_STALE.store(false, Ordering::SeqCst);
        let address = if hub_wsl_engine(data_dir).is_some() {
            let Some(table) = wsl_engine_distro()
                .and_then(|distro| run_wsl_root_script_capture(&distro, "cat /proc/net/route"))
            else {
                // The distro didn't answer this time: keep what an earlier start recorded.
                return;
            };
            default_gateway_from_route_table(&table).filter(|address| is_own_address(*address))
        } else {
            None
        };
        let message = match write_update_listener_host(data_dir, address) {
            Ok(false) => return,
            Ok(true) => match address {
                Some(address) => format!(
                    "The Hub reaches the update listener at {address}, this PC's address on the WSL adapter."
                ),
                None => "The Hub reaches the update listener at host.docker.internal.".to_string(),
            },
            Err(error) => error,
        };
        let _ = append_desktop_log_for(data_dir, "updater.listener", &message);
    }
    #[cfg(not(windows))]
    let _ = data_dir;
}

// ─── The logon script ─────────────────────────────────────────────────────────
//
// The WSL engine installer puts a script in the user's Startup folder that starts the engine's
// distro at every logon. When an uninstall removed it, a reinstall that finds the engine already
// set up doesn't run the installer again, so the engine stayed down after the next logon. Separate
// from starting the engine when Docker doesn't answer: this is about the next logon.

/// The installer's logon script, in the user's Startup folder (`wsl2_engine_user_script`).
#[cfg(any(test, windows))]
pub(crate) const WSL_ENGINE_LOGON_SCRIPT: &str = "CompanionHub-WSL-Docker.vbs";

/// The logon script as the installer writes it with Windows PowerShell's `Set-Content`: a hidden
/// `wsl.exe` running the keepalive, and a CRLF.
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_logon_script(distro: &str) -> String {
    format!(
        "CreateObject(\"Wscript.Shell\").Run \"wsl.exe {}\", 0, False\r\n",
        wsl_keepalive_args(distro).join(" ")
    )
}

/// Writes the logon script into `startup_dir` for the distro `distro` names, unless a script is
/// there already, and returns where it wrote one.
#[cfg(any(test, windows))]
pub(crate) fn restore_wsl_engine_logon_script(
    startup_dir: &Path,
    distro: impl FnOnce() -> Option<String>,
) -> Result<Option<PathBuf>, String> {
    let path = startup_dir.join(WSL_ENGINE_LOGON_SCRIPT);
    if path.exists() {
        return Ok(None);
    }
    let distro = distro()
        .ok_or_else(|| "No Ubuntu WSL distro was found for the Docker engine.".to_string())?;
    std::fs::create_dir_all(startup_dir)
        .and_then(|()| std::fs::write(&path, wsl_engine_logon_script(&distro)))
        .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    Ok(Some(path))
}

/// When the Hub runs on the WSL engine, put the logon script back if it's missing, so the engine
/// starts at the next logon. The Startup folder is the default one under `%APPDATA%`, where
/// `[Environment]::GetFolderPath('Startup')` puts it unless the user moved it.
pub fn ensure_wsl_engine_logon_script(data_dir: &Path) {
    #[cfg(windows)]
    {
        let on_wsl_engine = hub_wsl_engine(data_dir).is_some();
        let Some(startup_dir) = dirs::config_dir()
            .filter(|_| on_wsl_engine)
            .map(|roaming| roaming.join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
        else {
            return;
        };
        let message = match restore_wsl_engine_logon_script(&startup_dir, wsl_engine_distro) {
            Ok(None) => return,
            Ok(Some(path)) => format!(
                "Put back the logon script that starts the WSL engine: {}",
                path.display()
            ),
            Err(error) => {
                format!("Couldn't put back the logon script that starts the WSL engine: {error}")
            }
        };
        let _ = append_desktop_log_for(data_dir, "wsl.engine", &message);
    }
    #[cfg(not(windows))]
    let _ = data_dir;
}
