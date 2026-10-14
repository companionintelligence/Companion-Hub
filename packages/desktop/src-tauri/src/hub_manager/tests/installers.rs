//! Tests for the `installers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn windows_docker_desktop_download_url_matches_build_architecture() {
    let url = docker_desktop_windows_download_url();

    if cfg!(target_arch = "aarch64") {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
        );
    } else {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
        );
    }
}

#[test]
fn windows_installer_script_uses_unique_temp_download_and_validates_signature() {
    let script = docker_desktop_windows_install_script(
        "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
    );

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("net.exe localgroup docker-users \"$AppUser\" /add"));
    assert!(!script.contains("CompanionHub-DockerDesktopInstaller.exe"));
    assert!(!script.contains("cmd /c"));
}

#[test]
fn macos_installer_script_verifies_downloaded_app_signature() {
    let script = docker_desktop_macos_install_script(
        "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
        "hex",
    );

    assert!(script.contains("spctl --assess --type open --verbose=2"));
    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("--user=\"hex\""));
}

#[test]
fn ollama_windows_installer_script_validates_signature_and_runs_silently() {
    let script = ollama_windows_install_script("https://ollama.com/download/OllamaSetup.exe");

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("-notmatch 'Ollama'"));
    assert!(script.contains("'/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'"));
    // Per-user Inno Setup installer — must never request elevation.
    assert!(!script.contains("RunAs"));
    assert!(!script.contains("-Verb"));
}

#[test]
fn ollama_macos_installer_script_verifies_app_signature_and_installs_cli() {
    let script = ollama_macos_install_script("https://ollama.com/download/Ollama-darwin.zip");

    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("ditto"));
    assert!(script.contains("/Applications/Ollama.app"));
    assert!(script.contains(
        "ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama"
    ));
}

#[test]
fn colima_binary_install_script_verifies_checksums_and_layout() {
    let script = colima_macos_binary_install_script();

    // colima sha256 + lima SHA256SUMS verification are non-negotiable.
    assert!(script.contains("shasum -a 256 -c"));
    assert!(script.contains("colima.sha256sum"));
    assert!(script.contains("SHA256SUMS"));
    // The lima tarball must be extracted whole — limactl resolves
    // ../share/lima relative to its own binary.
    assert!(script.contains("tar -xzf lima.tar.gz -C /usr/local"));
    assert!(script.contains("releases/latest/download/colima-Darwin-"));
    assert!(script.contains("download.docker.com/mac/static/stable"));
}

#[test]
fn colima_start_script_never_runs_brew_as_root_and_waits_for_engine() {
    let script = colima_macos_start_script();

    // brew refuses root; this script must not contain any elevation.
    assert!(!script.contains("sudo"));
    assert!(!script.contains("osascript"));
    assert!(script.contains(r#""$BREW" install colima docker"#));
    assert!(script.contains(r#""$BREW" services start colima"#));
    assert!(script.contains("LaunchAgents/com.companionhub.colima.plist"));
    // Success must mean a working engine, not just installed binaries.
    assert!(script.contains("docker info"));
}

#[test]
fn wsl2_engine_elevated_script_only_does_admin_work() {
    let script = wsl2_engine_elevated_script();

    // Exit-code contract shared with the Docker Desktop installer: enable WSL
    // then ask for a reboot.
    assert!(script.contains("exit 100"));
    assert!(script.contains("--no-distribution"));
    // UTF-16 output guard for wsl --status parsing.
    assert!(script.contains("WSL_UTF8"));
    // Architecture-aware docker CLI download into Program Files (the only
    // admin-requiring filesystem write).
    assert!(script.contains("PROCESSOR_ARCHITECTURE"));
    assert!(script.contains("aarch64"));
    assert!(script.contains("docker.exe"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $exe"));

    // Per-user state must NOT be created in the elevated phase — that is the
    // core fix (it would otherwise land in the wrong profile under
    // over-the-shoulder UAC).
    assert!(!script.contains("context create wsl-engine"));
    assert!(!script.contains("GetFolderPath('Startup')"));
    assert!(!script.contains("--install -d Ubuntu"));
}

#[test]
fn wsl2_engine_elevated_script_installs_the_pinned_docker_cli() {
    let script = wsl2_engine_elevated_script();

    // Docker's static Windows builds are unsigned and the index lists no
    // checksums, so setup downloads one pinned zip and checks its SHA-256
    // instead of taking the newest zip in the index.
    assert!(script.contains(&format!(
        "$dockerCliVersion = '{WINDOWS_STATIC_DOCKER_CLI_VERSION}'"
    )));
    assert!(script.contains(&format!("'x86_64' = '{WINDOWS_STATIC_DOCKER_CLI_SHA256}'")));
    assert!(script.contains("/win/static/stable/$arch/$zipName"));
    assert!(script.contains(
        "Expand-CompanionHubDockerCli -ZipPath $zipPath -ExpectedSha256 $dockerCliSha256[$arch]"
    ));
    assert!(!script.contains("Sort-Object"));
    assert!(!script.contains("$zips[-1]"));
}

#[test]
fn pinned_docker_cli_sha256_is_a_full_hex_digest() {
    assert_eq!(WINDOWS_STATIC_DOCKER_CLI_SHA256.len(), 64);
    assert!(WINDOWS_STATIC_DOCKER_CLI_SHA256
        .chars()
        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
}

#[test]
fn wsl2_engine_elevated_script_reports_its_error_to_the_app() {
    let script = wsl2_engine_elevated_script();

    // Start-Process -Verb RunAs hands back only the exit code, so the script
    // takes a file to write its error to, and the trap must come first.
    assert!(script.starts_with(wsl2_engine_elevated_script_prelude()));
    assert!(wsl2_engine_elevated_script_prelude()
        .starts_with("param([string]$Program, [string]$ErrorFile)"));
    assert!(wsl2_engine_elevated_script_prelude()
        .contains("[System.IO.File]::WriteAllText($ErrorFile, \"$_\")"));
}

#[test]
fn wsl2_engine_elevated_failure_shows_the_script_error_over_the_exit_code() {
    let reason = "Downloaded docker CLI docker-29.9.0.zip has SHA-256 ABC, expected def.";
    assert_eq!(
        wsl2_engine_elevated_failure(Some(1), &format!("{reason}\r\n"), ""),
        format!("WSL2 Docker Engine installation failed: {reason}")
    );
    assert_eq!(
        wsl2_engine_elevated_failure(Some(1), "", "Start-Process: boom"),
        "WSL2 Docker Engine installation failed: Start-Process: boom"
    );
    assert_eq!(
        wsl2_engine_elevated_failure(Some(1), "  ", ""),
        "WSL2 Docker Engine installation failed with exit code 1."
    );
    assert_eq!(
        wsl2_engine_elevated_failure(None, "", ""),
        "WSL2 Docker Engine installation failed without an exit code."
    );
}

#[test]
fn firewall_program_path_drops_verbatim_prefixes() {
    assert_eq!(
        firewall_program_path(r"\\?\C:\Users\u\AppData\Local\Companion Hub\companion-hub.exe"),
        r"C:\Users\u\AppData\Local\Companion Hub\companion-hub.exe"
    );
    assert_eq!(
        firewall_program_path(r"\\?\UNC\server\share\Companion Hub\companion-hub.exe"),
        r"\\server\share\Companion Hub\companion-hub.exe"
    );
    assert_eq!(
        firewall_program_path(r"C:\Program Files\Companion Hub\companion-hub.exe"),
        r"C:\Program Files\Companion Hub\companion-hub.exe"
    );
}

#[test]
fn powershell_single_quoted_escape_doubles_typographic_quotes_too() {
    // PowerShell ends a single-quoted string at U+2018 to U+201B as well.
    assert_eq!(
        escape_powershell_single_quoted("C:\\Users\\O\u{2019}Neil and o'neil"),
        "C:\\Users\\O\u{2019}\u{2019}Neil and o''neil"
    );
    assert_eq!(
        escape_powershell_single_quoted("\u{2018}\u{201A}\u{201B}"),
        "\u{2018}\u{2018}\u{201A}\u{201A}\u{201B}\u{201B}"
    );
}

#[test]
fn docker_desktop_launch_is_unchanged_by_the_shared_elevated_launch_command() {
    // The command Docker Desktop's install ran before the WSL engine setup
    // shared the builder with it.
    assert_eq!(
        docker_desktop_windows_outer_launch_command(r"C:\Temp\install.ps1", "test user"),
        r#"$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"C:\Temp\install.ps1"','-AppUser','"test user"'); exit $process.ExitCode"#
    );
}

#[test]
fn wsl2_engine_elevated_launch_passes_the_program_and_error_file_quoted() {
    let cmd = elevated_powershell_launch_command(
        r"C:\Users\o'neil\AppData\Local\Temp\.tmp1.ps1",
        &[
            (
                "-Program",
                r"C:\Users\o'neil\AppData\Local\Companion Hub\companion-hub.exe",
            ),
            (
                "-ErrorFile",
                r"C:\Users\o'neil\AppData\Local\Temp\companionhub-wsl-engine-1.txt",
            ),
        ],
    );

    assert!(cmd.starts_with("$ErrorActionPreference = 'Stop';"));
    assert!(cmd.contains("-Verb RunAs -Wait -PassThru"));
    assert!(cmd.contains(
        r#"-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','"C:\Users\o''neil\AppData\Local\Temp\.tmp1.ps1"','-Program','"C:\Users\o''neil\AppData\Local\Companion Hub\companion-hub.exe"','-ErrorFile','"C:\Users\o''neil\AppData\Local\Temp\companionhub-wsl-engine-1.txt"')"#
    ));
    assert!(cmd.ends_with("exit $process.ExitCode"));
}

#[test]
fn wsl2_engine_elevated_script_lets_the_hub_reach_the_update_listener() {
    let script = wsl2_engine_elevated_script();

    assert!(script.contains(update_listener_firewall_function()));
    // Before the WSL step's `exit 100`: with docker.exe already in Program
    // Files, the run after the reboot skips the elevated script.
    let firewall_call = script
        .find("Set-CompanionHubUpdateListenerFirewall -Program $Program")
        .expect("firewall call");
    assert!(firewall_call < script.find("exit 100").expect("reboot exit"));
    // The rule must stay narrow: one port, one program, the WSL range only.
    let function = update_listener_firewall_function();
    assert!(function.contains("$name = 'CompanionHub-UpdateListener-WSL'"));
    assert!(function.contains("LocalPort = '17400'"));
    assert!(function.contains("Program = $Program"));
    assert!(function.contains("LocalAddress = '172.16.0.0/12'"));
    assert!(function.contains("RemoteAddress = '172.16.0.0/12'"));
}

/// Runs `script` under Windows PowerShell 5.1, which runs the elevated script
/// on every Windows PC, with `args` after `-File`. PSModulePath is dropped:
/// UAC starts the elevated script with a fresh environment, and a value
/// inherited from PowerShell 7 (cargo run from pwsh) makes Windows PowerShell
/// load 7's Microsoft.PowerShell.Security.
#[cfg(target_os = "windows")]
fn run_windows_powershell(dir: &Path, script: &str, args: &[&str]) -> std::process::Output {
    let path = dir.join(format!("test-{}.ps1", std::process::id()));
    std::fs::write(&path, script).expect("write test script");
    std::process::Command::new("powershell.exe")
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&path)
        .args(args)
        .output()
        .expect("run powershell.exe")
}

/// Zips `exe` as docker\docker.exe, the layout of Docker's static zip, and runs
/// the elevated script's check on it. An `exe` of None is an unsigned program
/// that Add-Type builds, which reads as NotSigned like Docker's static builds;
/// arbitrary bytes would read as UnknownError. `expected_sha256` of None means
/// the zip's own hash. Prints `accepted=<path>` when the check passes.
#[cfg(target_os = "windows")]
fn run_docker_cli_check(exe: Option<&[u8]>, expected_sha256: Option<&str>) -> std::process::Output {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("src").join("docker");
    std::fs::create_dir_all(&source).expect("create source dir");
    if let Some(exe) = exe {
        std::fs::write(source.join("docker.exe"), exe).expect("write docker.exe");
    }
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
{helper}{check}
$root = '{root}'
$fixture = Join-Path $root 'src\docker\docker.exe'
if (-not (Test-Path $fixture)) {{
  Add-Type -TypeDefinition 'public static class P {{ public static void Main() {{ }} }}' -OutputAssembly $fixture -OutputType ConsoleApplication
}}
Compress-Archive -Path (Join-Path $root 'src\docker') -DestinationPath (Join-Path $root 'docker.zip')
$expected = '{expected}'
if (-not $expected) {{
  $stream = [System.IO.File]::OpenRead((Join-Path $root 'docker.zip'))
  try {{ $expected = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($stream)) -replace '-', '' }} finally {{ $stream.Dispose() }}
  $expected = $expected.ToLowerInvariant()
}}
$exe = Expand-CompanionHubDockerCli -ZipPath (Join-Path $root 'docker.zip') -ExpectedSha256 $expected -Destination (Join-Path $root 'out')
"accepted=$exe"
"#,
        helper = powershell_authenticode_helper(),
        check = windows_docker_cli_check_function(),
        root = escape_powershell_single_quoted(&dir.path().to_string_lossy()),
        expected = expected_sha256.unwrap_or(""),
    );
    let output = run_windows_powershell(dir.path(), &script, &[]);
    drop(dir);
    output
}

#[cfg(target_os = "windows")]
#[test]
fn docker_cli_check_accepts_an_unsigned_docker_exe_when_the_zip_hash_matches() {
    let output = run_docker_cli_check(None, None);
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("accepted=") && stdout.trim_end().ends_with(r"out\docker\docker.exe"),
        "stdout: {stdout}"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn docker_cli_check_rejects_a_zip_with_another_hash() {
    let output = run_docker_cli_check(None, Some(WINDOWS_STATIC_DOCKER_CLI_SHA256));
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("accepted="));
    assert!(
        stderr.contains(&format!("expected {WINDOWS_STATIC_DOCKER_CLI_SHA256}")),
        "stderr: {stderr}"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn docker_cli_check_rejects_a_docker_exe_signed_by_someone_else() {
    // whoami.exe is signed by Microsoft through a catalog, and a copy still
    // reads as Valid, so it stands in for a file with another signer.
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let signed = std::fs::read(Path::new(&system_root).join(r"System32\whoami.exe"))
        .expect("read whoami.exe");
    let output = run_docker_cli_check(Some(&signed), None);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("accepted="));
    assert!(
        stderr.contains("signer was not recognized as Docker"),
        "stderr: {stderr}"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn elevated_script_trap_writes_the_error_for_the_app_and_exits_1() {
    let dir = tempfile::tempdir().expect("tempdir");
    let error_file = dir.path().join("error.txt");
    let script = format!(
        "{}$ErrorActionPreference = 'Stop'\nthrow 'Downloaded docker CLI signer was not recognized as Docker.'\n",
        wsl2_engine_elevated_script_prelude()
    );
    let output = run_windows_powershell(
        dir.path(),
        &script,
        &[
            "-Program",
            r"C:\Program Files\Companion Hub\companion-hub.exe",
            "-ErrorFile",
            &error_file.to_string_lossy(),
        ],
    );

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        std::fs::read_to_string(&error_file).expect("error file"),
        "Downloaded docker CLI signer was not recognized as Docker."
    );
}

/// Runs the firewall function against stand-ins for the NetSecurity cmdlets
/// that hold the rules below and record each change, then prints the changes
/// as one JSON line each.
#[cfg(target_os = "windows")]
fn run_update_listener_firewall(program: &str) -> Vec<serde_json::Value> {
    let dir = tempfile::tempdir().expect("tempdir");
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$hub = 'c:\users\u\appdata\local\companion hub\companion-hub.exe'
$rules = @(
  # What the first-run prompt leaves when only Private networks is ticked.
  [pscustomobject]@{{ Name = "TCP Query User{{1}}$hub"; Direction = 'Inbound'; Action = 'Block'; Profile = 'Public'; Program = $hub; Protocol = 'TCP'; LocalPort = 'Any' }}
  [pscustomobject]@{{ Name = "UDP Query User{{2}}$hub"; Direction = 'Inbound'; Action = 'Block'; Profile = 'Public'; Program = $hub; Protocol = 'UDP'; LocalPort = 'Any' }}
  [pscustomobject]@{{ Name = "TCP Query User{{3}}$hub"; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Private'; Program = $hub; Protocol = 'TCP'; LocalPort = 'Any' }}
  # A rule the user made, and the prompt's rule for another program.
  [pscustomobject]@{{ Name = 'Block Companion Hub'; Direction = 'Inbound'; Action = 'Block'; Profile = 'Public'; Program = $hub; Protocol = 'TCP'; LocalPort = 'Any' }}
  [pscustomobject]@{{ Name = 'TCP Query User{{4}}c:\tools\other.exe'; Direction = 'Inbound'; Action = 'Block'; Profile = 'Public'; Program = 'c:\tools\other.exe'; Protocol = 'TCP'; LocalPort = 'Any' }}
  # The prompt's rule after an earlier run took 17400 out of it.
  [pscustomobject]@{{ Name = "TCP Query User{{5}}$hub"; Direction = 'Inbound'; Action = 'Block'; Profile = 'Public'; Program = $hub; Protocol = 'TCP'; LocalPort = @('1-17399', '17401-65535') }}
  # What the prompt leaves when the user denies the app (Cancel): the user's call, left alone.
  [pscustomobject]@{{ Name = "TCP Query User{{6}}$hub"; Direction = 'Inbound'; Action = 'Block'; Profile = 'Private, Public'; Program = $hub; Protocol = 'TCP'; LocalPort = 'Any' }}
  # A domain-joined PC where only Private was ticked.
  [pscustomobject]@{{ Name = "TCP Query User{{7}}$hub"; Direction = 'Inbound'; Action = 'Block'; Profile = 'Domain, Public'; Program = $hub; Protocol = 'TCP'; LocalPort = 'Any' }}
)
$calls = New-Object System.Collections.ArrayList
function Record($call) {{ [void]$calls.Add((ConvertTo-Json -Compress $call)) }}
function Remove-NetFirewallRule {{ [CmdletBinding()] param([string]$Name) Record @{{ call = 'Remove-NetFirewallRule'; name = $Name }} }}
function New-NetFirewallRule {{
  [CmdletBinding()] param([string]$Name, [string]$DisplayName, [string]$Description, [string]$Direction, [string]$Action, [string]$Protocol, [string[]]$LocalPort, [string]$Program, [string[]]$LocalAddress, [string[]]$RemoteAddress, [string[]]$Profile)
  Record @{{ call = 'New-NetFirewallRule'; name = $Name; direction = $Direction; action = $Action; protocol = $Protocol; localPort = $LocalPort; program = $Program; localAddress = $LocalAddress; remoteAddress = $RemoteAddress; profile = $Profile }}
}}
function Get-NetFirewallApplicationFilter {{ [CmdletBinding()] param([string]$Program) $rules | Where-Object {{ $_.Program -eq $Program }} }}
function Get-NetFirewallRule {{ [CmdletBinding()] param([Parameter(ValueFromPipeline = $true)]$InputObject) process {{ $InputObject }} }}
function Get-NetFirewallPortFilter {{ [CmdletBinding()] param([Parameter(ValueFromPipeline = $true)]$InputObject) process {{ [pscustomobject]@{{ Protocol = $InputObject.Protocol; LocalPort = $InputObject.LocalPort }} }} }}
function Set-NetFirewallRule {{ [CmdletBinding()] param([Parameter(ValueFromPipeline = $true)]$InputObject, [string[]]$LocalPort) process {{ Record @{{ call = 'Set-NetFirewallRule'; name = $InputObject.Name; localPort = $LocalPort }} }} }}
{function}
Set-CompanionHubUpdateListenerFirewall -Program '{program}'
$calls
"#,
        function = update_listener_firewall_function(),
        program = escape_powershell_single_quoted(program),
    );
    let output = run_windows_powershell(dir.path(), &script, &[]);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("one JSON call per line"))
        .collect()
}

#[cfg(target_os = "windows")]
#[test]
fn update_listener_firewall_allows_17400_from_wsl_and_takes_it_out_of_the_prompts_block_rule() {
    // The app passes its own path, in whatever case Windows reports it.
    let calls =
        run_update_listener_firewall(r"C:\Users\u\AppData\Local\Companion Hub\companion-hub.exe");

    assert_eq!(
        calls,
        vec![
            serde_json::json!({ "call": "Remove-NetFirewallRule", "name": "CompanionHub-UpdateListener-WSL" }),
            serde_json::json!({
                "call": "New-NetFirewallRule",
                "name": "CompanionHub-UpdateListener-WSL",
                "direction": "Inbound",
                "action": "Allow",
                "protocol": "TCP",
                "localPort": ["17400"],
                "program": r"C:\Users\u\AppData\Local\Companion Hub\companion-hub.exe",
                "localAddress": ["172.16.0.0/12"],
                "remoteAddress": ["172.16.0.0/12"],
                "profile": ["Any"],
            }),
            serde_json::json!({
                "call": "Set-NetFirewallRule",
                "name": r"TCP Query User{1}c:\users\u\appdata\local\companion hub\companion-hub.exe",
                "localPort": ["1-17399", "17401-65535"],
            }),
            serde_json::json!({
                "call": "Set-NetFirewallRule",
                "name": r"TCP Query User{7}c:\users\u\appdata\local\companion hub\companion-hub.exe",
                "localPort": ["1-17399", "17401-65535"],
            }),
        ]
    );
}

#[cfg(any(test, target_os = "windows"))]
#[test]
fn wsl2_engine_user_script_owns_per_user_state_and_avoids_daemon_json_hosts() {
    let script = wsl2_engine_user_script();

    // Distro registration happens in the user phase so the distro is owned by
    // the logged-in user.
    assert!(script.contains("--install -d Ubuntu --no-launch"));
    // Dynamic Ubuntu variant selection: handles Ubuntu-22.04, Ubuntu-24.04, etc.
    assert!(script.contains("-match '^Ubuntu-'"));
    // UTF-16 output guard for wsl -l parsing.
    assert!(script.contains("WSL_UTF8"));
    // TCP exposure must be a systemd drop-in, not daemon.json "hosts"
    // (which conflicts with Ubuntu's -H fd:// unit).
    assert!(script.contains("docker.service.d"));
    assert!(script.contains("-H fd:// -H tcp://127.0.0.1:2375"));
    assert!(!script.contains("\"hosts\""));
    // Per-user context routing (no env vars) + logon keepalive — generated in
    // the non-elevated phase so they land in the real user's profile.
    assert!(script.contains("context create wsl-engine"));
    assert!(script.contains("GetFolderPath('Startup')"));
    assert!(script.contains("sleep infinity"));
    // Must restart only the target distro, not every running WSL distro.
    assert!(script.contains("--terminate $distro"));
    assert!(!script.contains("--shutdown"));
    // Systemd boot check before the docker-info poll loop.
    assert!(script.contains("is-system-running"));
}

#[test]
fn docker_desktop_outer_launch_has_stop_on_error_preference() {
    let cmd = docker_desktop_windows_outer_launch_command(
        "C:\\Users\\test\\AppData\\Local\\Temp\\install.ps1",
        "testuser",
    );
    assert!(cmd.starts_with("$ErrorActionPreference = 'Stop';"));
    assert!(cmd.contains("-Verb RunAs"));
    assert!(cmd.contains("exit $process.ExitCode"));
    // Username must appear in the -AppUser argument.
    assert!(cmd.contains("testuser"));
}

#[test]
fn ollama_linux_installer_script_uses_official_installer_and_handles_deps() {
    let script = ollama_linux_install_script();

    assert!(script.contains("https://ollama.com/install.sh"));
    // The official installer hard-requires curl and zstd.
    assert!(script.contains("command -v curl"));
    assert!(script.contains("command -v zstd"));
    // apt's --no-install-recommends curl can't do HTTPS without this.
    assert!(script.contains("curl ca-certificates"));
    // Dep install must cover the major package-manager families.
    for pm in ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"] {
        assert!(script.contains(pm), "missing package manager: {}", pm);
    }
    // Group add is best-effort and gated on group existence (no-systemd hosts).
    assert!(script.contains("getent group ollama"));
    assert!(script.contains(r#"usermod -aG ollama "$USERNAME""#));
    // Linux desktop installs should repair the default localhost-only bind.
    assert!(script.contains("ollama.service.d/override.conf"));
    assert!(script.contains(r#"Environment="OLLAMA_HOST=0.0.0.0:11434""#));
    assert!(script.contains("systemctl daemon-reload"));
}
