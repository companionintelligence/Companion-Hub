//! Licensing-free Docker engine alternatives: Colima and the WSL2 engine.

#[allow(unused_imports)]
use super::*;

/// Install a licensing-free Docker engine. Docker Desktop requires a paid
/// subscription for organizations with >250 employees or >$10M revenue; these
/// paths run the open-source Docker Engine instead:
///   - macOS: Colima (Engine in a lightweight vz VM). Homebrew when present,
///     otherwise verified binaries (colima + lima + docker CLI) into /usr/local.
///   - Windows: Docker Engine inside WSL2 (Ubuntu), TCP-exposed on
///     127.0.0.1:2375 with a docker context — no Docker Desktop involved.
///   - Linux: the standard Engine install (already licensing-free).
pub fn install_docker_engine_alternative() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(detail),
        });
    }

    #[cfg(target_os = "macos")]
    {
        return install_colima_macos();
    }

    #[cfg(target_os = "windows")]
    {
        return install_docker_wsl2_windows();
    }

    #[allow(unreachable_code)]
    Err("No licensing-free engine path is available on this platform.".to_string())
}

/// Elevated phase of the no-Homebrew Colima install: place colima, lima, and
/// the docker CLI under /usr/local. Checksums are verified for colima (per-asset
/// .sha256sum) and lima (release SHA256SUMS); Docker's static CLI publishes no
/// checksums, so it relies on TLS like the get.docker.com path.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn colima_macos_binary_install_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT
cd "$workdir"

ARCH="$(uname -m)"   # arm64 | x86_64
case "$ARCH" in
  arm64) DOCKER_ARCH_DIR="aarch64" ;;
  x86_64) DOCKER_ARCH_DIR="x86_64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# colima: version-less asset names, so latest/download is stable; verify sha256.
curl -fsSL -o colima "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}"
curl -fsSL -o colima.sha256sum "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}.sha256sum"
# The published file references the asset name; check against our local name.
expected="$(awk '{print $1}' colima.sha256sum)"
echo "${expected}  colima" | shasum -a 256 -c -
install -m 0755 colima /usr/local/bin/colima

# lima: asset names embed the version; resolve the tag from the GitHub API.
LIMA_TAG="$(curl -fsSL https://api.github.com/repos/lima-vm/lima/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
test -n "$LIMA_TAG"
LIMA_VERSION="${LIMA_TAG#v}"
curl -fsSL -o lima.tar.gz "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz"
curl -fsSL -o lima-SHA256SUMS "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/SHA256SUMS"
grep "lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz" lima-SHA256SUMS | awk '{print $1}' | { read -r sum; echo "${sum}  lima.tar.gz" | shasum -a 256 -c -; }
# Extract the whole tarball to one prefix: limactl resolves ../share/lima
# (guest agents, templates) relative to its own binary.
tar -xzf lima.tar.gz -C /usr/local

# docker CLI (static, client-only): no latest pointer — scrape the index.
DOCKER_TGZ="$(curl -fsSL "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/" | grep -o 'docker-[0-9][0-9.]*\.tgz' | sort -uV | tail -1)"
test -n "$DOCKER_TGZ"
curl -fsSL -o docker.tgz "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/${DOCKER_TGZ}"
tar -xzf docker.tgz
install -m 0755 docker/docker /usr/local/bin/docker
"#
}

/// User phase of the Colima install (never root — brew refuses it, and the VM
/// must belong to the user). Installs via Homebrew when available; otherwise
/// assumes the binary phase already ran, registers a LaunchAgent for autostart,
/// and waits until `docker info` answers (first start downloads a ~350 MB VM
/// image, so the ceiling is generous).
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn colima_macos_start_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$candidate" ]; then BREW="$candidate"; break; fi
done

if [ -n "$BREW" ]; then
  "$BREW" install colima docker
  "$BREW" services start colima
else
  # Binary install path: autostart via a per-user LaunchAgent.
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.companionhub.colima</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/colima</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  launchctl unload "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.companionhub.colima.plist"
fi

# First start downloads the VM image (~350 MB); wait until the engine answers.
for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then exit 0; fi
  sleep 5
done
echo "Timed out waiting for the Colima engine to come up." >&2
exit 1
"#
}

#[cfg(target_os = "macos")]
fn install_colima_macos() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let brew_present = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .any(|p| Path::new(p).exists());

    // Without Homebrew the binaries must be placed under /usr/local first —
    // the only step that needs admin rights.
    if !brew_present {
        let mut script = NamedTempFile::new()
            .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
        script
            .write_all(colima_macos_binary_install_script().as_bytes())
            .map_err(|e| format!("Failed to write Colima installer script: {}", e))?;
        script
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to set installer script permissions: {}", e))?;

        let applescript = format!(
            "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
            script.path().to_string_lossy().replace('"', "\\\"")
        );
        let output = Command::new("osascript")
            .args(["-e", &applescript])
            .output()
            .map_err(|e| format!("Failed to launch elevated Colima installer: {}", e))?;
        if !output.status.success() {
            let combined = format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            );
            let combined_lower = combined.to_lowercase();
            if combined_lower.contains("cancel") && combined_lower.contains("user") {
                return Err("Authorization was cancelled or denied.".to_string());
            }
            return Err(format!("Colima binary installation failed: {}", combined));
        }
    }

    // Brew install, autostart registration, colima start, and the readiness
    // wait all run as the user — never root.
    let mut start_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary start script: {}", e))?;
    start_script
        .write_all(colima_macos_start_script().as_bytes())
        .map_err(|e| format!("Failed to write Colima start script: {}", e))?;
    start_script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set start script permissions: {}", e))?;

    let output = Command::new("bash")
        .arg(start_script.path())
        .output()
        .map_err(|e| format!("Failed to run Colima start script: {}", e))?;

    if output.status.success() {
        Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Colima installed and the Docker Engine is running (context \"colima\")."
                    .to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if combined.is_empty() {
            Err("Colima installation failed.".to_string())
        } else {
            Err(format!("Colima installation failed: {}", combined))
        }
    }
}

// Windows: Docker Engine inside WSL2, no Docker Desktop.
//
// The install is split across two PowerShell scripts so that only the steps
// that genuinely need Windows admin run elevated, and everything that is
// inherently per-user runs as the logged-in user. This matters because:
//   - WSL distros, the docker context (`~/.docker`) and the Startup keepalive
//     are all per-user; if they were created by an elevated *other* admin
//     account (over-the-shoulder UAC) the Hub — running as the real user —
//     would never see them, so `docker info` would keep failing after a
//     "successful" install.
//   - The Colima path on macOS already uses this elevated-then-user split.
//
// Exit code contract for the **elevated** script matches the Docker Desktop
// installer: 100 = WSL was just enabled and Windows must reboot (NeedsRestart);
// 0 = elevated work done. The **user** script returns 0 once the engine is
// reachable.
//
// Design notes (all verified against MS Learn / Docker docs):
//   - `wsl --install -d Ubuntu --no-launch` registers Ubuntu without the
//     interactive first-run user creation; `wsl -u root` works without it.
//     Once the WSL platform is enabled, adding/running a distro is per-user and
//     does not require Windows admin.
//   - Ubuntu's docker-ce systemd unit uses `-H fd://`, which conflicts with a
//     daemon.json `hosts` key — TCP exposure needs a systemd drop-in instead.
//   - WSL2 localhost forwarding makes tcp://127.0.0.1:2375 reachable from
//     Windows, but only while the distro runs — and systemd services do NOT
//     keep the VM alive, hence the hidden `sleep infinity` keepalive in the
//     user's Startup folder.
//   - docker.exe goes where find_docker_binary() already looks, and a docker
//     context (stored in ~/.docker, read at runtime) points it at the TCP
//     endpoint — no env vars, so the running Hub needs no restart.

/// The static docker CLI the WSL engine setup puts in Program Files. Docker doesn't
/// sign these Windows builds and publishes no checksums for them, so setup pins one
/// zip by its SHA-256, taken from download.docker.com. Change both together.
#[cfg(any(test, target_os = "windows"))]
pub(crate) const WINDOWS_STATIC_DOCKER_CLI_VERSION: &str = "29.9.0";
#[cfg(any(test, target_os = "windows"))]
pub(crate) const WINDOWS_STATIC_DOCKER_CLI_SHA256: &str =
    "e3ff5d2e4cd1ad7e1c9bcb76f0df28a84853c43416a915323f08659d8487ad83";

/// Start of the elevated script. Start-Process -Verb RunAs hands the app nothing
/// but the exit code, so a failure writes its message to -ErrorFile, which the app
/// reads and shows. -Program is the app's own executable, for the firewall rule.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_elevated_script_prelude() -> &'static str {
    r#"param([string]$Program, [string]$ErrorFile)
trap {
  if ($ErrorFile) { try { [System.IO.File]::WriteAllText($ErrorFile, "$_") } catch { } }
  exit 1
}
"#
}

/// Install-CompanionHubDockerCli: checks Docker's static CLI zip against the
/// pinned SHA-256 and writes its docker.exe to `$Target`. The zip stays in memory
/// from download to Program Files, since the user's own processes can write to
/// %TEMP% and a file there could change after the check. Docker doesn't sign
/// these builds, so an unsigned docker.exe passes on the hash alone; a signed one
/// must still be signed by Docker, or `$Target` is removed again. The hash is
/// computed with .NET rather than Get-FileHash for the same reason the
/// Authenticode helper imports its module explicitly: a PSModulePath inherited
/// from PowerShell 7 can break module autoloading in Windows PowerShell.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn windows_docker_cli_install_function() -> &'static str {
    r#"function Install-CompanionHubDockerCli {
  param([byte[]]$Zip, [string]$ZipName, [string]$ExpectedSha256, [string]$Target)
  $actual = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($Zip)) -replace '-', ''
  if ($actual -ne $ExpectedSha256) {
    throw "Downloaded docker CLI $ZipName has SHA-256 $($actual.ToLowerInvariant()), expected $ExpectedSha256."
  }
  Add-Type -AssemblyName System.IO.Compression
  $archive = [System.IO.Compression.ZipArchive]::new([System.IO.MemoryStream]::new($Zip), [System.IO.Compression.ZipArchiveMode]::Read)
  try {
    $entries = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'docker/docker.exe' })
    if ($entries.Count -ne 1) { throw "Downloaded docker CLI $ZipName has no docker/docker.exe." }
    $source = $entries[0].Open()
    try {
      $file = [System.IO.File]::Create($Target)
      try {
        $source.CopyTo($file)
        $file.Dispose()
        $signature = Get-CompanionHubAuthenticodeSignature $Target
        if ($signature.Status -ne 'NotSigned') {
          if ($signature.Status -ne 'Valid') {
            throw "Downloaded docker CLI signature validation failed: $($signature.Status)"
          }
          if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Docker') {
            throw "Downloaded docker CLI signer was not recognized as Docker."
          }
        }
      } catch {
        # Leave no half-written or refused docker.exe: setup skips this step once one exists.
        $file.Dispose()
        Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
        throw
      }
    } finally {
      $source.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
}
"#
}

/// Set-CompanionHubUpdateListenerFirewall: lets the Hub on the WSL engine reach
/// the desktop app's update listener (`updater.rs`, TCP 17400). The Hub calls it
/// at this PC's address on the WSL adapter, which Windows filters with the Public
/// profile, and the app's first-run firewall prompt allows only Private networks
/// unless the user ticks Public too. The rule allows one port, one program, and
/// only traffic between addresses in 172.16.0.0/12: WSL's NAT network is a /20
/// that Windows picks from that range, and it can pick a new one after a reboot.
/// It can't name the WSL adapter, because a rule stores an adapter by its GUID
/// and Windows creates the WSL adapter with a new GUID at every boot. So it
/// covers wired interfaces only, which keeps out Wi-Fi in that range, such as a
/// hotel's network or a phone's Wi-Fi hotspot.
///
/// Block rules win over Allow rules, so the prompt's Block rule for Public
/// networks, named `TCP Query User{...}<program path>`, loses port 17400 and keeps
/// the rest. A Block rule that also covers Private networks is what the prompt
/// leaves when the user denied the app altogether (Cancel), and stays as it is.
/// The rule object is piped to Set-NetFirewallRule because -Name takes wildcards
/// and the name holds the program path. The uninstaller
/// (`distribution/scripts/uninstall-cleanup.ps1`) removes the rule by its name.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn update_listener_firewall_function() -> &'static str {
    r#"function Set-CompanionHubUpdateListenerFirewall {
  param([string]$Program)
  $name = 'CompanionHub-UpdateListener-WSL'
  Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
  $rule = @{
    Name = $name
    DisplayName = 'Companion Hub update listener (WSL)'
    Description = 'Lets the Hub on the Docker engine inside WSL hand desktop updates to Companion Hub.'
    Direction = 'Inbound'
    Action = 'Allow'
    Protocol = 'TCP'
    LocalPort = '17400'
    Program = $Program
    LocalAddress = '172.16.0.0/12'
    RemoteAddress = '172.16.0.0/12'
    InterfaceType = 'Wired'
    Profile = 'Any'
  }
  New-NetFirewallRule @rule | Out-Null
  Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue | Get-NetFirewallRule |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Name -like 'TCP Query User*' } |
    ForEach-Object {
      $profiles = "$($_.Profile)" -split ',\s*'
      if ($profiles -contains 'Public' -and $profiles -notcontains 'Private' -and
          "$(($_ | Get-NetFirewallPortFilter).LocalPort)" -eq 'Any') {
        $_ | Set-NetFirewallRule -LocalPort '1-17399', '17401-65535'
      }
    }
}
"#
}

/// Elevated phase, for the steps that need Windows admin: the firewall rule for
/// the update listener, enabling the WSL platform (reboot via exit 100 the first
/// time), and writing the static docker CLI into Program Files where
/// `find_docker_binary()` looks. Run with -Program and -ErrorFile (see the prelude).
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_elevated_script() -> String {
    format!(
        "{prelude}{authenticode}{docker_cli_install}{firewall}$dockerCliVersion = '{version}'\n$dockerCliSha256 = @{{ 'x86_64' = '{sha256}' }}\n{body}",
        prelude = wsl2_engine_elevated_script_prelude(),
        authenticode = powershell_authenticode_helper(),
        docker_cli_install = windows_docker_cli_install_function(),
        firewall = update_listener_firewall_function(),
        version = WINDOWS_STATIC_DOCKER_CLI_VERSION,
        sha256 = WINDOWS_STATIC_DOCKER_CLI_SHA256,
        body = r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

# Firewall rule for the desktop app's update listener. It comes first so the run
# that enables WSL and exits 100 adds it too: when docker.exe is already in
# Program Files, the run after the reboot skips this script. The engine works
# without the rule, so a failure is reported in -ErrorFile and setup goes on; a
# later failure overwrites that message with its own.
if ($Program) {
  try {
    Set-CompanionHubUpdateListenerFirewall -Program $Program
  } catch {
    if ($ErrorFile) { try { [System.IO.File]::WriteAllText($ErrorFile, "Couldn't add the firewall rule for the update listener: $_") } catch { } }
  }
}

# Phase 1: WSL platform itself (admin + reboot when absent). The status probe is
# allowed to fail (WSL absent) — relax briefly so its non-zero exit doesn't become
# a terminating error under Stop, then restore Stop for the download cmdlets below.
$ErrorActionPreference = 'Continue'
& wsl.exe --status | Out-Null
$wslPresent = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $wslPresent) {
  & wsl.exe --install --no-distribution
  exit 100
}

# Phase 2: static docker CLI where the Hub already looks for it (Program Files
# needs admin to write). Idempotent: skip when docker.exe is already present.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
# Prefer ProgramW6432 (the 64-bit root even under 32-bit/WOW64 PowerShell) so the
# CLI lands where the 64-bit Hub's find_docker_binary() looks.
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$dockerBin = Join-Path $programFiles 'Docker\Docker\resources\bin'
if (-not (Test-Path (Join-Path $dockerBin 'docker.exe'))) {
  # The pinned zip, checked against its SHA-256 (WINDOWS_STATIC_DOCKER_CLI_* in
  # engine_alt.rs). Docker publishes the static Windows CLI for x86_64 only.
  if (-not $dockerCliSha256.ContainsKey($arch)) {
    throw "Docker publishes no static docker CLI for Windows on $arch."
  }
  # In memory, never in %TEMP%: see Install-CompanionHubDockerCli.
  $zipName = "docker-$dockerCliVersion.zip"
  $zip = (Invoke-WebRequest -UseBasicParsing -Uri "https://download.docker.com/win/static/stable/$arch/$zipName").RawContentStream.ToArray()
  New-Item -ItemType Directory -Force -Path $dockerBin | Out-Null
  Install-CompanionHubDockerCli -Zip $zip -ZipName $zipName -ExpectedSha256 $dockerCliSha256[$arch] -Target (Join-Path $dockerBin 'docker.exe')
}
exit 0
"#
    )
}

/// User phase: runs non-elevated as the logged-in user so all per-user state
/// (distro registration, docker context, Startup keepalive) lands in the real
/// profile. Assumes the elevated phase already enabled WSL and placed docker.exe.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_user_script() -> String {
    let linux_setup = r#"set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v dockerd >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375\n' > /etc/systemd/system/docker.service.d/companionhub-tcp.conf
systemctl enable docker 2>/dev/null || true"#;

    format!(
        r#"# Continue (not Stop): this phase runs probes that are *expected* to fail —
# `docker context inspect` before the context exists, `docker info` /
# `systemctl is-system-running` while the engine is still starting. Under Stop a
# native command's non-zero exit (or stderr) becomes a terminating error, so the
# must-succeed steps instead assert $LASTEXITCODE explicitly and `throw`.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

# Phase 3: Ubuntu distro, registered without the interactive first-run (owned by
# the logged-in user since this runs non-elevated).
$distros = (& wsl.exe -l -q) | ForEach-Object {{ $_.Trim() }}
$distro = $distros | Where-Object {{ $_ -eq 'Ubuntu' -or $_ -match '^Ubuntu-' }} | Select-Object -First 1
if (-not $distro) {{
  & wsl.exe --install -d Ubuntu --no-launch
  if ($LASTEXITCODE -ne 0) {{ throw "Ubuntu installation failed with exit code $LASTEXITCODE" }}
  $distro = 'Ubuntu'
}}

# Phase 4: Docker Engine + systemd TCP drop-in inside the distro (as root).
$setup = @'
{linux_setup}
'@ -replace "`r`n", "`n"
$setup | & wsl.exe -d $distro -u root -- sh
if ($LASTEXITCODE -ne 0) {{ throw "Docker Engine setup inside WSL failed with exit code $LASTEXITCODE" }}

# Restart the distro so wsl.conf + the drop-in take effect.
& wsl.exe --terminate $distro
& wsl.exe -d $distro -u root -- true

# Phase 5: route the CLI at the WSL engine via a context (read from ~/.docker
# at runtime — no env vars, no Hub restart needed).
# Prefer ProgramW6432 (the 64-bit root even under 32-bit/WOW64 PowerShell) so we
# read the CLI from where the 64-bit Hub's find_docker_binary() placed it.
$programFiles = if ($env:ProgramW6432) {{ $env:ProgramW6432 }} else {{ $env:ProgramFiles }}
$dockerBin = Join-Path $programFiles 'Docker\Docker\resources\bin'
$dockerExe = Join-Path $dockerBin 'docker.exe'
if (-not (Test-Path $dockerExe)) {{ throw "Static docker CLI is missing at $dockerExe." }}
& $dockerExe context inspect {wsl_context} 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & $dockerExe context create {wsl_context} --docker host=tcp://127.0.0.1:2375 | Out-Null
  if ($LASTEXITCODE -ne 0) {{ throw "Failed to create the {wsl_context} docker context." }}
}}
& $dockerExe context use {wsl_context} | Out-Null
if ($LASTEXITCODE -ne 0) {{ throw "Failed to select the {wsl_context} docker context." }}

# Phase 6: keepalive at logon — systemd services do not keep the WSL VM alive.
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'CompanionHub-WSL-Docker.vbs'
Set-Content -Path $vbs -Value "CreateObject(""Wscript.Shell"").Run ""wsl.exe -d $distro -u root -- sleep infinity"", 0, False"

# Keepalive for this session too, then wait for the engine.
Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d',$distro,'-u','root','--','sleep','infinity'
# Wait up to 30 s for systemd to finish booting before polling Docker.
for ($s = 0; $s -lt 15; $s++) {{
  $state = (& wsl.exe -d $distro -u root -- systemctl is-system-running 2>$null)
  if ($state -match 'running|degraded') {{ break }}
  Start-Sleep -Seconds 2
}}
for ($i = 0; $i -lt 60; $i++) {{
  & $dockerExe info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {{ exit 0 }}
  Start-Sleep -Seconds 5
}}
throw 'Timed out waiting for the Docker Engine inside WSL2 to come up.'
"#,
        linux_setup = linux_setup,
        wsl_context = DOCKER_CONTEXT_WSL_ENGINE,
    )
}

/// True when the WSL platform is already enabled (`wsl --status` succeeds). Used
/// to decide whether the elevated phase has anything to do.
#[cfg(target_os = "windows")]
fn wsl_platform_present() -> bool {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    command
        .arg("--status")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True when the static docker CLI is already in Program Files (where the
/// elevated phase would otherwise place it). Resolves the root with the same
/// ProgramW6432-first preference the install scripts use, so the pre-check looks
/// at exactly the path the elevated phase writes and the user phase reads —
/// otherwise a CLI present only under Program Files (x86) could wrongly skip the
/// elevated phase and make the user phase throw "missing".
#[cfg(target_os = "windows")]
fn program_files_docker_present() -> bool {
    let root = std::env::var("ProgramW6432")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("ProgramFiles").ok());
    match root {
        Some(root) => Path::new(&root)
            .join("Docker")
            .join("Docker")
            .join("resources")
            .join("bin")
            .join("docker.exe")
            .exists(),
        None => false,
    }
}

/// The error for a failed elevated phase: the message the script wrote to its
/// error file, else what the launcher printed, else the exit code.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_elevated_failure(
    code: Option<i32>,
    script_error: &str,
    launcher_output: &str,
) -> String {
    let reason = match script_error.trim() {
        "" => launcher_output.trim(),
        script_error => script_error,
    };
    match (reason.is_empty(), code) {
        (false, _) => format!("WSL2 Docker Engine installation failed: {reason}"),
        (true, Some(code)) => {
            format!("WSL2 Docker Engine installation failed with exit code {code}.")
        }
        (true, None) => "WSL2 Docker Engine installation failed without an exit code.".to_string(),
    }
}

/// `path` as the firewall matches a program: verbatim prefixes removed, so
/// `\\?\C:\x` reads `C:\x` and `\\?\UNC\server\share` reads `\\server\share`.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn firewall_program_path(path: &str) -> String {
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
    }
}

/// This executable, which also runs the update listener, so the firewall rule
/// names it as the program. Resolved through junctions and symlinks first: the
/// firewall matches the program a process was really started from, and that is
/// where the first-run prompt's rules point too.
#[cfg(target_os = "windows")]
fn update_listener_program() -> String {
    std::env::current_exe()
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path))
        .map(|path| firewall_program_path(&path.to_string_lossy()))
        .unwrap_or_default()
}

/// Run a PowerShell script, optionally elevated, with `script_args` after
/// `-File`. Returns the captured output so the caller can map exit codes to the
/// install-result contract.
#[cfg(target_os = "windows")]
fn run_powershell_script(
    script_body: &str,
    elevated: bool,
    script_args: &[(&str, &str)],
) -> Result<std::process::Output, String> {
    use std::io::Write as IoWrite;

    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(script_body.as_bytes())
        .map_err(|e| format!("Failed to write temporary installer script: {}", e))?;
    // Close our writable handle before executing: on Windows, PowerShell cannot
    // run a .ps1 that is still held open by this process ("the process cannot
    // access the file ... because it is being used by another process").
    // into_temp_path() keeps the file on disk and still deletes it on drop.
    let script_path = script.into_temp_path();
    let script_path_str = script_path.to_string_lossy();

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);

    if elevated {
        // Elevate via a nested Start-Process -Verb RunAs and propagate the inner
        // exit code.
        let launch_command = elevated_powershell_launch_command(&script_path_str, script_args);
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launch_command,
        ]);
    } else {
        // Non-elevated: run as the logged-in Hub user directly.
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path_str,
        ]);
        for (name, value) in script_args {
            command.args([name, value]);
        }
    }

    command
        .output()
        .map_err(|e| format!("Failed to launch WSL2 engine installer: {}", e))
}

#[cfg(target_os = "windows")]
fn install_docker_wsl2_windows() -> Result<DockerInstallResult, String> {
    // Elevation is only needed when the WSL platform must be enabled or the
    // static docker CLI is missing from Program Files. Skipping it on re-runs
    // avoids an unnecessary UAC prompt.
    if !wsl_platform_present() || !program_files_docker_present() {
        // The elevated script writes why it failed here; the launcher only sees
        // its exit code. Kept in the user's temp folder, which an elevated
        // administrator account can write too.
        let error_file = tempfile::Builder::new()
            .prefix("companionhub-wsl-engine-")
            .suffix(".txt")
            .tempfile()
            .map_err(|e| format!("Failed to create temporary installer file: {}", e))?
            .into_temp_path();
        let error_file_str = error_file.to_string_lossy().into_owned();
        let program = update_listener_program();
        if program.is_empty() {
            let _ = append_desktop_log(
                "docker.install",
                "Couldn't tell where this program is, so setup adds no firewall rule for the update listener.",
            );
        }
        let output = run_powershell_script(
            &wsl2_engine_elevated_script(),
            true,
            &[
                ("-Program", program.as_str()),
                ("-ErrorFile", error_file_str.as_str()),
            ],
        )?;
        let script_error = std::fs::read_to_string(&error_file).unwrap_or_default();
        let script_error = script_error.trim();
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        let combined_lower = combined.to_lowercase();
        // A message with exit 0 or 100 is the firewall step's, which doesn't stop setup.
        if matches!(output.status.code(), Some(0) | Some(100)) && !script_error.is_empty() {
            let _ = append_desktop_log("docker.install", script_error);
        }
        match output.status.code() {
            Some(0) => {}
            Some(100) => {
                return Ok(DockerInstallResult {
                    state: DockerInstallState::NeedsRestart,
                    detail: Some(
                        "WSL was installed or enabled. Restart Windows, then reopen Companion Hub to continue Docker setup."
                            .to_string(),
                    ),
                });
            }
            _ if combined_lower.contains("cancel") && combined_lower.contains("user") => {
                return Err("Authorization was cancelled or denied.".to_string());
            }
            code => {
                return Err(wsl2_engine_elevated_failure(code, script_error, &combined));
            }
        }
    }

    // User phase: per-user state (distro, docker context, Startup keepalive) is
    // created as the logged-in user so the running Hub can see it.
    let output = run_powershell_script(&wsl2_engine_user_script(), false, &[])?;
    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    match output.status.code() {
        Some(0) => Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(format!(
                "Docker Engine is running inside WSL2 (context \"{DOCKER_CONTEXT_WSL_ENGINE}\")."
            )),
        }),
        _ if combined.is_empty() => Err(format!(
            "WSL2 Docker Engine installation failed with exit code {:?}.",
            output.status.code()
        )),
        _ => Err(format!(
            "WSL2 Docker Engine installation failed: {}",
            combined
        )),
    }
}
