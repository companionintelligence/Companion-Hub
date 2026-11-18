//! The operating system's own signature on a downloaded installer, checked before it runs.
//!
//! The signed manifest (`update_signature`) is what ties a download to a release on every platform.
//! On macOS and Windows the installers also carry the platform's code signature, made in the release
//! workflow with keys that live outside it (Apple Developer ID, Azure Artifact Signing). Nothing
//! checked it: the updater copies the app with `ditto` and runs `msiexec` itself, so Gatekeeper and
//! SmartScreen never look (a file this app downloaded carries no quarantine mark). So it is checked
//! here, against the publisher pinned below, as a second lock that the manifest key alone does not
//! open. Linux packages carry no signature to check.
//!
//! The pins were read off the v0.3.13 release: the DMG is signed by Developer ID team `68U45V853Y`
//! as `computer.ci.app.hub`, and the Windows installers by `CN=Lifescope Inc, O=Lifescope Inc`.

// Linux has no installer signature to check; the pins and parsers are used on macOS and Windows.
#![cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::Command;

/// The Apple Developer ID team that signs Companion Hub.
pub(crate) const APPLE_TEAM_ID: &str = "68U45V853Y";

/// The app's bundle identifier (`tauri.conf.json`), the same in production and dev builds.
pub(crate) const MACOS_BUNDLE_ID: &str = "computer.ci.app.hub";

/// The organization the Windows installers are Authenticode-signed as.
pub(crate) const WINDOWS_PUBLISHER: &str = "Lifescope Inc";

/// The code requirement a new app bundle must meet: Apple's Developer ID chain, this app, this team.
/// The form Apple gives a Developer ID app's designated requirement, with the team and app pinned.
pub(crate) fn macos_code_requirement() -> String {
    format!(
        "anchor apple generic and identifier \"{MACOS_BUNDLE_ID}\" \
         and certificate 1[field.1.2.840.113635.100.6.2.6] \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] \
         and certificate leaf[subject.OU] = \"{APPLE_TEAM_ID}\""
    )
}

/// Refuse an app bundle that is not intact, or not signed by [`APPLE_TEAM_ID`] as this app.
#[cfg(target_os = "macos")]
pub(crate) fn verify_macos_app(app: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(format!("-R={}", macos_code_requirement()))
        .arg(app)
        .output()
        .map_err(|e| format!("Could not run codesign to check the update: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "The update is not signed by Companion Intelligence (team {APPLE_TEAM_ID}) — refusing to install: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Refuse an installer whose Authenticode signature is not valid, or not [`WINDOWS_PUBLISHER`]'s.
#[cfg(target_os = "windows")]
pub(crate) fn verify_windows_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // The path goes in through the environment, never into the script text, so no file name can
    // change what the script does.
    let script = "$s = Get-AuthenticodeSignature -LiteralPath $env:CI_HUB_INSTALLER_TO_CHECK; \
                  Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CI_HUB_INSTALLER_TO_CHECK", installer)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Could not run PowerShell to check the update's signature: {e}"))?;
    windows_signature_verdict(&String::from_utf8_lossy(&output.stdout))
}

/// What `Get-AuthenticodeSignature` printed (the status, then the signer's subject), as a verdict.
/// `Valid` means Windows trusts the certificate chain and the file is unchanged since it was signed.
pub(crate) fn windows_signature_verdict(output: &str) -> Result<(), String> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let status = lines.next().unwrap_or("");
    let subject = lines.next().unwrap_or("");
    if status != "Valid" {
        let status = if status.is_empty() {
            "no signature"
        } else {
            status
        };
        return Err(format!(
            "The update's Windows signature is not valid ({status}) — refusing to install"
        ));
    }
    let signed_by_us = subject_field(subject, "CN").as_deref() == Some(WINDOWS_PUBLISHER)
        && subject_field(subject, "O").as_deref() == Some(WINDOWS_PUBLISHER);
    if !signed_by_us {
        return Err(format!(
            "The update is signed by someone other than {WINDOWS_PUBLISHER} ({subject}) — refusing to install"
        ));
    }
    Ok(())
}

/// The value of `key` in an X.500 subject as Windows prints it: `CN=Name, O="Name, Inc", C=US`.
fn subject_field(subject: &str, key: &str) -> Option<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in subject.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ',' if !quoted => fields.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    fields.push(current);
    fields.iter().find_map(|field| {
        let (name, value) = field.trim().split_once('=')?;
        if !name.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        let value = value.trim();
        Some(
            value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value)
                .replace("\"\"", "\""),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The subject of the certificate the v0.3.13 Windows installers are signed with.
    const OURS: &str =
        "CN=Lifescope Inc, O=Lifescope Inc, L=Laguna Niguel CA 92677, S=California, C=US";

    #[test]
    fn accepts_a_valid_signature_by_the_publisher() {
        assert!(windows_signature_verdict(&format!("Valid\r\n{OURS}\r\n")).is_ok());
    }

    #[test]
    fn refuses_an_unsigned_altered_or_untrusted_installer() {
        for status in [
            "NotSigned",
            "HashMismatch",
            "UnknownError",
            "NotTrusted",
            "",
        ] {
            let error = windows_signature_verdict(&format!("{status}\n{OURS}\n")).unwrap_err();
            assert!(error.contains("not valid"), "{status}: {error}");
        }
        assert!(windows_signature_verdict("").is_err());
    }

    #[test]
    fn refuses_a_valid_signature_by_anyone_else() {
        for subject in [
            "CN=Evil Corp, O=Evil Corp, C=US",
            // The organization must match as well as the name, and whole, not as a prefix.
            "CN=Lifescope Inc, O=Evil Corp, C=US",
            "CN=Lifescope Inc Ltd, O=Lifescope Inc Ltd, C=US",
            "CN=\"Lifescope Inc, O=Lifescope Inc\", O=Evil Corp",
            "",
        ] {
            assert!(
                windows_signature_verdict(&format!("Valid\n{subject}\n")).is_err(),
                "{subject}"
            );
        }
    }

    #[test]
    fn reads_quoted_subject_values() {
        assert_eq!(
            subject_field("CN=\"Name, Inc\", O=Org", "CN").as_deref(),
            Some("Name, Inc")
        );
        assert_eq!(
            subject_field("CN=\"Name, Inc\", O=Org", "O").as_deref(),
            Some("Org")
        );
        assert_eq!(subject_field("cn=lower", "CN").as_deref(), Some("lower"));
        assert_eq!(subject_field("CN=Only", "O"), None);
    }

    #[test]
    fn the_macos_requirement_pins_apple_this_app_and_this_team() {
        let requirement = macos_code_requirement();
        assert!(requirement.starts_with("anchor apple generic"));
        assert!(requirement.contains("identifier \"computer.ci.app.hub\""));
        assert!(requirement.contains("certificate leaf[subject.OU] = \"68U45V853Y\""));
        // Developer ID: the intermediate and leaf certificate markers Apple puts on it.
        assert!(requirement.contains("certificate 1[field.1.2.840.113635.100.6.2.6]"));
        assert!(requirement.contains("certificate leaf[field.1.2.840.113635.100.6.1.13]"));
    }

    #[test]
    fn the_bundle_id_matches_the_app_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["identifier"], MACOS_BUNDLE_ID);
    }
}
