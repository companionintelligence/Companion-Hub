//! Container-safe Docker config sanitizer.
//!
//! The Hub container runs the Docker CLI inside Linux and talks to the host's
//! Docker daemon via /var/run/docker.sock. It therefore cannot inherit
//! host-specific fields from the user's ~/.docker/config.json, notably:
//!
//!   - "currentContext" values like "desktop-linux" (Docker Desktop on macOS)
//!     point at daemon sockets that don't exist inside the container.
//!   - "credsStore": "desktop" (macOS/Windows), "osxkeychain", "wincred",
//!     "secretservice", or "pass" all require host-side binaries that the
//!     Linux container image does not ship.
//!   - "plugins", "features", and "hooks" reference host CLI plugins that
//!     aren't installed inside the container and can break compose invocations.
//!
//! If we naively bind-mount the host config, the Hub's docker-compose calls
//! (when installing marketplace apps) fail with errors like:
//!
//!   unable to resolve docker endpoint: context "desktop-linux": context not
//!   found: open /root/.docker/contexts/meta/.../meta.json: no such file or
//!   directory
//!
//! This module reads the host config, strips anything that only works on the
//! host, and writes the result into the desktop data directory. The desktop
//! compose file bind-mounts that sanitized file into the container at
//! /root/.docker/config.json via ${DOCKER_CONFIG_PATH}, so the setup
//! auto-configures across macOS, Linux, and Windows without per-user overrides.
//!
//! Registry auths that carry inline credentials (`auth` field) are preserved
//! so private image pulls keep working.

use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;

use serde_json::{Map, Value};

/// Filename of the sanitized config inside the desktop data directory.
pub const SANITIZED_DOCKER_CONFIG_FILENAME: &str = "docker-config.json";

/// Credential-store values that rely on host-only binaries and will fail
/// inside the Linux container if forwarded.
const HOST_ONLY_CREDSTORES: &[&str] = &[
    "desktop",
    "osxkeychain",
    "wincred",
    "secretservice",
    "pass",
];

fn is_host_only_cred_helper(value: &str) -> bool {
    HOST_ONLY_CREDSTORES.iter().any(|s| *s == value)
}

fn host_docker_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".docker").join("config.json"))
}

fn read_host_config(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn sanitize_auths(value: Option<&Value>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(Value::Object(auths)) = value else {
        return result;
    };
    for (registry, entry) in auths {
        let Value::Object(obj) = entry else { continue };
        // Only entries with an inline `auth` token work without a cred helper.
        // Entries that rely solely on the host's credsStore can't be satisfied
        // inside the container, so we drop them to avoid confusing errors.
        if let Some(Value::String(auth)) = obj.get("auth") {
            if !auth.is_empty() {
                let mut sanitized = Map::new();
                sanitized.insert("auth".to_string(), Value::String(auth.clone()));
                result.insert(registry.clone(), Value::Object(sanitized));
            }
        }
    }
    result
}

fn sanitize_cred_helpers(value: Option<&Value>) -> Map<String, Value> {
    let mut result = Map::new();
    let Some(Value::Object(helpers)) = value else {
        return result;
    };
    for (registry, helper) in helpers {
        if let Value::String(h) = helper {
            if !is_host_only_cred_helper(h) {
                result.insert(registry.clone(), Value::String(h.clone()));
            }
        }
    }
    result
}

fn sanitize_config(host_config: &Value) -> Value {
    let mut sanitized = Map::new();

    let auths = sanitize_auths(host_config.get("auths"));
    if !auths.is_empty() {
        sanitized.insert("auths".to_string(), Value::Object(auths));
    }

    if let Some(Value::String(cred_store)) = host_config.get("credsStore") {
        if !is_host_only_cred_helper(cred_store) {
            sanitized.insert("credsStore".to_string(), Value::String(cred_store.clone()));
        }
    }

    let cred_helpers = sanitize_cred_helpers(host_config.get("credHelpers"));
    if !cred_helpers.is_empty() {
        sanitized.insert("credHelpers".to_string(), Value::Object(cred_helpers));
    }

    // Deliberately dropped: currentContext, plugins, features, hooks, aliases,
    // experimental. All host-specific and either unused or harmful in-container.

    Value::Object(sanitized)
}

/// Read the host Docker config, strip host-only fields, and write a
/// container-safe copy to `<data_dir>/docker-config.json`. Returns the
/// absolute path of the written file on success.
///
/// If the host has no `~/.docker/config.json` (or it is unreadable/invalid),
/// an empty `{}` config is written so the compose bind mount still resolves.
pub fn prepare_sanitized_docker_config(data_dir: &Path) -> Result<PathBuf, String> {
    let output_path = data_dir.join(SANITIZED_DOCKER_CONFIG_FILENAME);

    std::fs::create_dir_all(data_dir).map_err(|e| {
        format!(
            "Failed to create data directory {}: {}",
            data_dir.display(),
            e
        )
    })?;

    let host_value = host_docker_config_path()
        .as_deref()
        .and_then(read_host_config);
    let sanitized = match host_value {
        Some(v) => sanitize_config(&v),
        None => Value::Object(Map::new()),
    };

    let serialized = serde_json::to_string_pretty(&sanitized)
        .map_err(|e| format!("Failed to serialize sanitized Docker config: {}", e))?;

    std::fs::write(&output_path, format!("{}\n", serialized)).map_err(|e| {
        format!(
            "Failed to write sanitized Docker config to {}: {}",
            output_path.display(),
            e
        )
    })?;

    set_restrictive_permissions(&output_path)?;

    Ok(output_path)
}

fn set_restrictive_permissions(path: &Path) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| {
            format!(
                "Failed to set permissions on {}: {}",
                path.display(),
                e
            )
        })?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = path;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_drops_host_only_cred_store() {
        let input = json!({ "credsStore": "desktop" });
        let output = sanitize_config(&input);
        assert!(output.get("credsStore").is_none());
    }

    #[test]
    fn sanitize_preserves_portable_cred_store() {
        let input = json!({ "credsStore": "ecr-login" });
        let output = sanitize_config(&input);
        assert_eq!(
            output.get("credsStore"),
            Some(&Value::String("ecr-login".to_string()))
        );
    }

    #[test]
    fn sanitize_keeps_inline_auth_entries_and_drops_helper_only_entries() {
        let input = json!({
            "auths": {
                "ghcr.io": { "auth": "dG9rZW46dmFsdWU=" },
                "registry.example.com": { "identitytoken": "xxx" }
            }
        });
        let output = sanitize_config(&input);
        let auths = output.get("auths").and_then(Value::as_object).unwrap();
        assert!(auths.contains_key("ghcr.io"));
        assert!(!auths.contains_key("registry.example.com"));
    }

    #[test]
    fn sanitize_filters_host_only_cred_helpers() {
        let input = json!({
            "credHelpers": {
                "ghcr.io": "ecr-login",
                "registry.example.com": "osxkeychain"
            }
        });
        let output = sanitize_config(&input);
        let helpers = output.get("credHelpers").and_then(Value::as_object).unwrap();
        assert_eq!(helpers.len(), 1);
        assert!(helpers.contains_key("ghcr.io"));
    }

    #[test]
    fn sanitize_drops_host_only_top_level_fields() {
        let input = json!({
            "currentContext": "desktop-linux",
            "plugins": { "foo": {} },
            "features": { "bar": true },
            "hooks": { "baz": {} },
            "aliases": { "ls": "image ls" },
            "experimental": "enabled"
        });
        let output = sanitize_config(&input);
        let obj = output.as_object().unwrap();
        assert!(obj.is_empty(), "expected empty object, got {:?}", obj);
    }

    #[test]
    fn prepare_writes_empty_object_when_no_host_config_available() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        // Point HOME at an empty directory so `~/.docker/config.json` does not exist.
        let original_home = std::env::var_os("HOME");
        #[cfg(target_os = "windows")]
        let original_userprofile = std::env::var_os("USERPROFILE");

        let empty_home = tempfile::tempdir().expect("empty home");
        std::env::set_var("HOME", empty_home.path());
        #[cfg(target_os = "windows")]
        std::env::set_var("USERPROFILE", empty_home.path());

        let result = prepare_sanitized_docker_config(tempdir.path())
            .expect("sanitized config should be written");

        assert_eq!(result, tempdir.path().join(SANITIZED_DOCKER_CONFIG_FILENAME));
        let contents = std::fs::read_to_string(&result).expect("read sanitized");
        let parsed: Value = serde_json::from_str(&contents).expect("valid json");
        assert_eq!(parsed, json!({}));

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(up) = original_userprofile {
                std::env::set_var("USERPROFILE", up);
            } else {
                std::env::remove_var("USERPROFILE");
            }
        }
    }

    #[test]
    fn prepare_applies_restrictive_permissions_on_unix() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let empty_home = tempfile::tempdir().expect("empty home");
        let original_home = std::env::var_os("HOME");
        std::env::set_var("HOME", empty_home.path());

        let result = prepare_sanitized_docker_config(tempdir.path())
            .expect("sanitized config should be written");

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mode = std::fs::metadata(&result)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = result;

        if let Some(home) = original_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
