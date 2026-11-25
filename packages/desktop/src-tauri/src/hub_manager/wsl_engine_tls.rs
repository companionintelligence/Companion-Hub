//! TLS for the Docker engine inside WSL.
//!
//! ⚠ THE ENGINE USED TO ANSWER ANYONE. It listened on plain `tcp://127.0.0.1:2375`, which WSL's
//! localhost forwarding hands to every program on the Windows machine: another account's, and a web
//! page's through DNS rebinding (Docker never checks the Host header). Whoever reached it was root
//! over a Docker that runs the Hub and can mount the Windows drives under `/mnt/c`.
//!
//! Now `dockerd` listens on [`WSL_ENGINE_TLS_HOST`] with `--tlsverify`: only a client holding the
//! certificate this script makes gets in. The certificate authority, the server certificate and the
//! client certificate are made inside the distro (root-only), and the client's copy goes to the
//! Windows profile ([`crate::docker_engine::wsl_engine_client_cert_dir`]), readable by its owner
//! only. The installer does this for a new engine (`wsl2_engine_user_script`); an engine set up
//! before is moved over at the next Hub start ([`ensure_wsl_engine_tls`]).

#[cfg(windows)]
use super::*;
#[cfg(any(test, windows))]
use crate::docker_engine::WSL_ENGINE_TLS_HOST;

/// Where the distro keeps the engine's certificates. Root-only (umask 077).
#[cfg(any(test, windows))]
pub(crate) const WSL_ENGINE_TLS_DIR: &str = "/etc/docker/companionhub-tls";

/// The systemd drop-in that adds the TCP listener to Ubuntu's `docker.service` (which uses `-H fd://`,
/// so the listener cannot go in daemon.json). The installer has always written this file; its old
/// content is the plain-TCP listener.
#[cfg(any(test, windows))]
pub(crate) const WSL_ENGINE_DOCKER_DROPIN: &str =
    "/etc/systemd/system/docker.service.d/companionhub-tcp.conf";

/// The certificates' lifetimes, and how early they are made again: well inside 825 days, which is
/// what clients accept for a server certificate, and long before a client copy could go stale.
#[cfg(any(test, windows))]
const CERT_DAYS: u32 = 825;
#[cfg(any(test, windows))]
const RENEW_WITHIN_SECONDS: u32 = 180 * 24 * 60 * 60;

/// POSIX shell, run as root in the engine's distro, that makes the certificates when any is missing
/// or close to expiry and points `dockerd` at [`WSL_ENGINE_TLS_HOST`] with `--tlsverify`. Restarts
/// Docker only when its listener or certificates changed. Its last line on stdout is
/// `tls-configured` (it changed something) or `tls-already`.
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_tls_root_script() -> String {
    let port = WSL_ENGINE_TLS_HOST.rsplit(':').next().unwrap_or("2376");
    // /proc/net/tcp writes ports as four upper-case hex digits.
    let port_hex = format!("{:04X}", port.parse::<u16>().unwrap_or(2376));
    format!(
        r#"set -e
dir={dir}
umask 077
mkdir -p "$dir"
cd "$dir"
if ! command -v openssl >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssl >&2
fi
renew=0
for f in ca.pem ca-key.pem server-cert.pem server-key.pem cert.pem key.pem; do
  [ -s "$f" ] || renew=1
done
if [ "$renew" = 0 ]; then
  openssl x509 -checkend {renew_within} -noout -in server-cert.pem >/dev/null 2>&1 || renew=1
  openssl x509 -checkend {renew_within} -noout -in cert.pem >/dev/null 2>&1 || renew=1
fi
changed=0
if [ "$renew" = 1 ]; then
  rm -f ./*.pem ./*.srl ./*.csr ./*.cnf
  openssl genrsa -out ca-key.pem 3072 2>/dev/null
  openssl req -x509 -new -key ca-key.pem -sha256 -days {days} -subj "/CN=Companion Hub WSL engine CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.pem
  openssl genrsa -out server-key.pem 3072 2>/dev/null
  openssl req -new -key server-key.pem -subj "/CN=localhost" -out server.csr
  printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' > server.cnf
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -sha256 -days {days} -extfile server.cnf -out server-cert.pem 2>/dev/null
  openssl genrsa -out key.pem 3072 2>/dev/null
  openssl req -new -key key.pem -subj "/CN=companion-hub-desktop" -out client.csr
  printf 'extendedKeyUsage=clientAuth\nkeyUsage=critical,digitalSignature\n' > client.cnf
  openssl x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -sha256 -days {days} -extfile client.cnf -out cert.pem 2>/dev/null
  rm -f ./*.csr ./*.cnf ./*.srl
  chmod 600 ./*-key.pem key.pem
  chmod 644 ca.pem server-cert.pem cert.pem
  changed=1
fi
mkdir -p "$(dirname {dropin})"
want=$(printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:{port} --tlsverify --tlscacert=%s/ca.pem --tlscert=%s/server-cert.pem --tlskey=%s/server-key.pem' "$dir" "$dir" "$dir")
if [ "$(cat {dropin} 2>/dev/null)" != "$want" ]; then
  printf '%s\n' "$want" > {dropin}
  chmod 644 {dropin}
  changed=1
fi
# A run cut short after writing the drop-in leaves nothing to change but Docker not yet on TLS:
# restart whenever the running daemon isn't listening there, not only when a file changed.
listening=0
awk 'NR > 1 && $4 == "0A" && toupper($2) == "0100007F:{port_hex}" {{ found = 1 }} END {{ exit !found }}' /proc/net/tcp && listening=1
if [ "$changed" = 1 ] || [ "$listening" = 0 ]; then
  systemctl daemon-reload
  systemctl restart docker
  i=0
  until docker -H unix:///var/run/docker.sock info >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && {{ echo "Docker did not come back after the switch to TLS" >&2; exit 1; }}
    sleep 1
  done
  echo tls-configured
else
  echo tls-already
fi"#,
        dir = WSL_ENGINE_TLS_DIR,
        dropin = WSL_ENGINE_DOCKER_DROPIN,
        days = CERT_DAYS,
        renew_within = RENEW_WITHIN_SECONDS,
        port = port,
        port_hex = port_hex,
    )
}

/// The three files the Windows side needs, as `DOCKER_CERT_PATH` names them, and where the distro
/// keeps each.
#[cfg(any(test, windows))]
pub(crate) const WSL_ENGINE_CLIENT_FILES: [(&str, &str); 3] = [
    ("ca.pem", "ca.pem"),
    ("cert.pem", "cert.pem"),
    ("key.pem", "key.pem"),
];

/// Whether `cert_dir` holds all three client files, none of them empty.
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_client_files_present(cert_dir: &std::path::Path) -> bool {
    WSL_ENGINE_CLIENT_FILES.iter().all(|(name, _)| {
        cert_dir
            .join(name)
            .metadata()
            .is_ok_and(|meta| meta.len() > 0)
    })
}

/// Whether this PC has a Docker engine in WSL that Companion Hub set up, and WSL can run it: the
/// client certificate it copies once Docker answers, an Ubuntu distro for it, and `wsl --status`
/// ready ([`wsl_status_says_ready`]). Docker inside the distro can't be seen without starting it,
/// which a status check mustn't do; the certificate comes only after Docker was up, so it stands
/// in. Lets the startup screen offer Start Docker in WSL instead of an install to a Hub still saved
/// on Docker Desktop.
///
/// Readiness matters: with WSL reinstalled and Virtual Machine Platform still waiting on a restart,
/// the distro and certificate were there, so the screen offered Start, which can't work, and never
/// the install whose admin step turns the feature on (seen on Windows). `wsl --status` is asked at
/// most every 30 seconds, since the startup screen polls every few.
///
/// So do the Docker CLI and the Compose plugin in Program Files: Start needs the CLI to switch the
/// context, and the Hub start after it needs Compose. Without them (Docker Desktop uninstalled,
/// which takes both along), only the install's admin step puts them back. The installer's own
/// check ([`program_files_docker_tools_present`]): two file lookups.
pub fn wsl_engine_set_up() -> bool {
    #[cfg(windows)]
    {
        crate::docker_engine::wsl_engine_client_cert_dir()
            .is_some_and(|dir| wsl_engine_client_files_present(&dir))
            && program_files_docker_tools_present()
            && wsl_engine_distro().is_some()
            && wsl_platform_ready_recently()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// [`wsl_platform_present`], remembered for 30 seconds.
#[cfg(windows)]
fn wsl_platform_ready_recently() -> bool {
    static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let mut last = lock_recovering(&LAST);
    if let Some((asked_at, ready)) = *last {
        if asked_at.elapsed() < Duration::from_secs(30) {
            return ready;
        }
    }
    let ready = wsl_platform_present();
    *last = Some((Instant::now(), ready));
    ready
}

/// `docker context` `--docker` value that points the `wsl-engine` context at the TLS listener with
/// the client certificate in `dir`.
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_context_endpoint(dir: &std::path::Path) -> String {
    format!(
        "host={host},ca={ca},cert={cert},key={key}",
        host = WSL_ENGINE_TLS_HOST,
        ca = dir.join("ca.pem").display(),
        cert = dir.join("cert.pem").display(),
        key = dir.join("key.pem").display(),
    )
}

/// The last non-empty line of a script's stdout: its marker, whatever a login banner printed before.
#[cfg(any(test, windows))]
pub(crate) fn last_line(output: &str) -> &str {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// How old the Windows copy of the client key may get before the next start checks the distro's
/// certificates again (they are made again inside [`RENEW_WITHIN_SECONDS`] of expiring).
#[cfg(windows)]
const CLIENT_COPY_RECHECK: Duration = Duration::from_secs(400 * 24 * 60 * 60);

/// Whether this start can skip the distro: the Hub is already pinned to the TLS listener, the client
/// certificate is in place and not old, and Docker answers with it. The last one catches a copy that
/// no longer matches the distro's certificates (made again there), which nothing else would mend.
#[cfg(windows)]
fn wsl_engine_tls_in_place(data_dir: &Path, cert_dir: &Path) -> bool {
    let on_tls =
        hub_wsl_engine(data_dir).is_some_and(|engine| engine.docker_host == WSL_ENGINE_TLS_HOST);
    let files_there = wsl_engine_client_files_present(cert_dir);
    let fresh = cert_dir
        .join("key.pem")
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < CLIENT_COPY_RECHECK);
    on_tls
        && files_there
        && fresh
        && crate::docker_engine::probe_docker_host_reachable(WSL_ENGINE_TLS_HOST)
}

/// Gives the folder to its owner alone: no inherited access, full control for the signed-in user,
/// which files made in it afterwards inherit.
///
/// The folder only, never `/T`: on a file already there, `/inheritance:r` takes away the access it
/// inherited (its only entry) and the `(OI)(CI)` grant doesn't apply to a file, so it is left with
/// an empty ACL that nobody can read or overwrite. That broke the second run on Windows ("Access is
/// denied" writing ca.pem, and deleting it too) and the Hub's TLS probe, which reads key.pem. Files
/// already there are reset to inherit the folder's entry instead, which their owner may always do,
/// and so mends a copy an earlier build left that way.
#[cfg(windows)]
fn restrict_to_current_user(dir: &Path) -> Result<(), String> {
    let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(domain), Ok(name)) if !domain.trim().is_empty() => format!("{domain}\\{name}"),
        (_, Ok(name)) => name,
        _ => return Err(
            "USERNAME is not set, so the client certificate's folder can't be given to its owner"
                .to_string(),
        ),
    };
    run_icacls(dir, &icacls_owner_only_args(&user))?;
    for (name, _) in WSL_ENGINE_CLIENT_FILES {
        let file = dir.join(name);
        if file.exists() {
            run_icacls(&file, &["/reset".to_string(), "/Q".to_string()])?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn run_icacls(path: &Path, args: &[String]) -> Result<(), String> {
    let mut command = Command::new("icacls");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .arg(path)
        .args(args)
        .output()
        .map_err(|error| format!("Couldn't run icacls: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        // icacls says what went wrong on stdout.
        Err(format!(
            "icacls {} failed: {} {}",
            path.display(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// `icacls <folder>` arguments that leave `user` the folder's only entry, inherited by what is made in
/// it. No `/T`: see [`restrict_to_current_user`].
#[cfg(any(test, windows))]
pub(crate) fn icacls_owner_only_args(user: &str) -> [String; 4] {
    [
        "/inheritance:r".to_string(),
        "/grant:r".to_string(),
        format!("{user}:(OI)(CI)F"),
        "/Q".to_string(),
    ]
}

/// Points the `wsl-engine` Docker context at the TLS listener, creating it if it is missing.
#[cfg(windows)]
pub(crate) fn point_wsl_engine_context_at_tls(cert_dir: &Path) -> Result<(), String> {
    let endpoint = wsl_engine_context_endpoint(cert_dir);
    let context = crate::docker_engine::DOCKER_CONTEXT_WSL_ENGINE;
    let exists = docker_command()
        .env_remove("DOCKER_HOST")
        .args(["context", "inspect", context])
        .output()
        .is_ok_and(|output| output.status.success());
    let verb = if exists { "update" } else { "create" };
    let output = docker_command()
        .env_remove("DOCKER_HOST")
        .args(["context", verb, context, "--docker", &endpoint])
        .output()
        .map_err(|error| format!("Couldn't run docker context {verb}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "docker context {verb} {context} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// For a Hub start on the Docker engine inside WSL: make sure it only answers TLS clients holding
/// this user's certificate, moving an engine still on plain TCP over. Cheap once done (no `wsl.exe`
/// call) until the client copy is old enough that the certificates may be renewed.
///
/// A failure part-way repairs itself: every step is safe to repeat, and the next start repeats the
/// lot. Restarts Docker in the distro when it changes the listener, which the Hub's containers
/// survive (they are restarted with it).
#[cfg(windows)]
pub(crate) fn ensure_wsl_engine_tls(data_dir: &Path) -> Result<(), String> {
    if hub_wsl_engine(data_dir).is_none() && !is_wsl_engine_docker_backend() {
        return Ok(());
    }
    let cert_dir = crate::docker_engine::wsl_engine_client_cert_dir().ok_or_else(|| {
        "There is no user profile to keep the WSL engine's client certificate in.".to_string()
    })?;
    if wsl_engine_tls_in_place(data_dir, &cert_dir) {
        return Ok(());
    }
    // Its script runs in the distro, which can't start without Windows' hypervisor: say why,
    // rather than WSL's error from a script that never ran.
    if let Some(why) = wsl_engine_cannot_start() {
        return Err(why);
    }
    let distro = wsl_engine_distro()
        .ok_or_else(|| "No Ubuntu WSL distro was found for the Docker engine.".to_string())?;

    let output =
        run_wsl_root_script_output(&distro, &wsl_engine_tls_root_script()).map_err(|why| {
            format!("Couldn't set up TLS for Docker in the WSL distro \"{distro}\". {why}")
        })?;
    let marker = last_line(&output).to_string();
    if marker != "tls-configured" && marker != "tls-already" {
        return Err(format!(
            "Setting up TLS for Docker in WSL ended without saying it worked: {marker}"
        ));
    }

    std::fs::create_dir_all(&cert_dir)
        .map_err(|error| format!("Couldn't create {}: {error}", cert_dir.display()))?;
    restrict_to_current_user(&cert_dir)?;
    for (name, source) in WSL_ENGINE_CLIENT_FILES {
        let pem =
            run_wsl_root_script_capture(&distro, &format!("cat {WSL_ENGINE_TLS_DIR}/{source}"))
                .filter(|pem| pem.contains("-----BEGIN"))
                .ok_or_else(|| {
                    format!("Couldn't read {source} from the WSL distro \"{distro}\".")
                })?;
        let path = cert_dir.join(name);
        std::fs::write(&path, format!("{pem}\n"))
            .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    }
    point_wsl_engine_context_at_tls(&cert_dir)?;
    crate::docker_engine::repoint_persisted_wsl_engine(data_dir);
    crate::docker_engine::clear_process_pin();

    let _ = append_desktop_log_for(
        data_dir,
        "wsl.engine",
        &format!(
            "Docker in WSL answers only TLS clients with this user's certificate, at {WSL_ENGINE_TLS_HOST} ({marker})."
        ),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker_engine::{wsl_engine_tls_env, WSL_ENGINE_LEGACY_HOST};
    use std::path::Path;

    #[test]
    fn the_root_script_is_valid_posix_shell() {
        let status = std::process::Command::new("sh")
            .args(["-n", "-c", &wsl_engine_tls_root_script()])
            .status()
            .expect("sh runs");
        assert!(status.success());
    }

    #[test]
    fn the_root_script_listens_only_with_tls_and_never_on_the_old_port() {
        let script = wsl_engine_tls_root_script();
        assert!(script.contains("-H fd:// -H tcp://127.0.0.1:2376 --tlsverify"));
        assert!(script.contains(
            "--tlscacert=%s/ca.pem --tlscert=%s/server-cert.pem --tlskey=%s/server-key.pem"
        ));
        assert!(!script.contains("2375"));
        // The server is 127.0.0.1 as WSL forwards it; the client certificate is for clients only.
        assert!(script.contains("subjectAltName=IP:127.0.0.1,DNS:localhost"));
        assert!(script.contains("extendedKeyUsage=clientAuth"));
        // Keys are root's alone, and Docker restarts only when something changed.
        assert!(script.contains("umask 077"));
        assert!(script.contains("chmod 600 ./*-key.pem key.pem"));
        assert!(script.contains("if [ \"$changed\" = 1 ] || [ \"$listening\" = 0 ]; then"));
        // 2376 as /proc/net/tcp spells it, so a half-finished earlier run still restarts Docker.
        assert!(script.contains("toupper($2) == \"0100007F:0948\""));
        assert!(script.ends_with("echo tls-already\nfi"));
    }

    #[test]
    fn the_context_endpoint_names_the_tls_listener_and_the_three_files() {
        let dir = Path::new("/home/u/.docker/companionhub-wsl");
        let endpoint = wsl_engine_context_endpoint(dir);
        // Joined with the host's separator: `\` where this runs for real.
        let file = |name: &str| dir.join(name).display().to_string();
        assert_eq!(
            endpoint,
            format!(
                "host=tcp://127.0.0.1:2376,ca={},cert={},key={}",
                file("ca.pem"),
                file("cert.pem"),
                file("key.pem")
            )
        );
    }

    #[test]
    fn only_the_wsl_tls_listener_gets_the_client_certificate() {
        let dir = Path::new("/home/u/.docker/companionhub-wsl");
        let env = wsl_engine_tls_env("tcp://127.0.0.1:2376", Some(dir)).expect("TLS env");
        assert_eq!(env[0], ("DOCKER_TLS_VERIFY", "1".to_string()));
        assert_eq!(env[1], ("DOCKER_CERT_PATH", dir.display().to_string()));
        assert!(wsl_engine_tls_env("tcp://127.0.0.1:2376/", Some(dir)).is_some());
        for host in [
            WSL_ENGINE_LEGACY_HOST,
            "npipe:////./pipe/docker_engine",
            "unix:///var/run/docker.sock",
            "tcp://10.0.0.5:2376",
        ] {
            assert!(wsl_engine_tls_env(host, Some(dir)).is_none(), "{host}");
        }
        assert!(wsl_engine_tls_env("tcp://127.0.0.1:2376", None).is_none());
    }

    #[test]
    fn the_client_folder_acl_never_reaches_into_files_already_there() {
        // /T on an existing file leaves it with an empty ACL: unreadable, even by its owner.
        let args = icacls_owner_only_args("HOST\\kyle");
        assert_eq!(args[2], "HOST\\kyle:(OI)(CI)F");
        assert!(!args.iter().any(|arg| arg.eq_ignore_ascii_case("/T")));
        let installer = crate::hub_manager::wsl2_engine_user_script();
        assert!(!installer.contains("/T /Q"));
        assert!(installer.contains("& icacls.exe $file /reset /Q"));
    }

    #[test]
    fn a_set_up_engine_needs_all_three_client_files_and_none_empty() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(!wsl_engine_client_files_present(dir.path()));
        for name in ["ca.pem", "cert.pem"] {
            std::fs::write(dir.path().join(name), "-----BEGIN CERTIFICATE-----\n").unwrap();
        }
        assert!(
            !wsl_engine_client_files_present(dir.path()),
            "key.pem missing"
        );
        std::fs::write(dir.path().join("key.pem"), "").unwrap();
        assert!(
            !wsl_engine_client_files_present(dir.path()),
            "key.pem empty"
        );
        std::fs::write(dir.path().join("key.pem"), "-----BEGIN PRIVATE KEY-----\n").unwrap();
        assert!(wsl_engine_client_files_present(dir.path()));
    }

    #[test]
    fn the_marker_is_the_last_line_whatever_came_before() {
        assert_eq!(
            last_line("Welcome to Ubuntu\n\ntls-configured\n\n"),
            "tls-configured"
        );
        assert_eq!(last_line(""), "");
    }
}
