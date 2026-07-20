//! Build-time defaults for Hub public URLs and container image tags.

use std::cmp::Ordering;
use std::collections::HashMap;

pub(crate) const DEFAULT_DEV_PUBLIC_DOMAIN: &str = "companionintelligence.com";
// Production public domain. Must be a Cloudflare-provisioned zone (CI-Portal only
// provisions DNS/tunnel ingress for companionintelligence.com / companionintel.com /
// ci.computer — NOT .org, which is the Squarespace marketing site). Image selection is
// decoupled from this via default_hub_image(), so changing the domain does not change
// which Hub image tag is pulled.
pub(crate) const DEFAULT_PROD_PUBLIC_DOMAIN: &str = "companionintelligence.com";
pub(crate) const DEFAULT_DEV_CI_CLOUD_URL: &str = "https://hub.companionintelligence.com";
pub(crate) const DEFAULT_PROD_CI_CLOUD_URL: &str = "https://hub.ci.computer";
pub(crate) const DEFAULT_DEV_UPDATE_CDN_BASE: &str = "https://dl-dev.ci.computer";
pub(crate) const DEFAULT_PROD_UPDATE_CDN_BASE: &str = "https://dl.ci.computer";
pub(crate) const DEFAULT_DEV_UPDATE_CDN_HOST: &str = "dl-dev.ci.computer";
pub(crate) const DEFAULT_PROD_UPDATE_CDN_HOST: &str = "dl.ci.computer";
pub(crate) const HUB_STACK_IMAGE_REPO: &str = "ghcr.io/companionintelligence/ci-os-hub";

pub(crate) fn default_public_domain() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_PUBLIC_DOMAIN,
        _ => DEFAULT_DEV_PUBLIC_DOMAIN,
    }
}

pub(crate) fn default_ci_cloud_url() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_CI_CLOUD_URL,
        _ => DEFAULT_DEV_CI_CLOUD_URL,
    }
}

/// Default Hub stack image for this desktop build (ci-os-hub repo, aligned with backend stack updates).
pub(crate) fn default_hub_image() -> String {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => {
            if let Some(version) = option_env!("CI_HUB_BUILD_VERSION") {
                format!(
                    "{}:{}",
                    HUB_STACK_IMAGE_REPO,
                    version.trim_start_matches('v')
                )
            } else {
                format!("{HUB_STACK_IMAGE_REPO}:latest")
            }
        }
        Some("staging") => format!("{HUB_STACK_IMAGE_REPO}:staging"),
        _ => format!("{HUB_STACK_IMAGE_REPO}:dev"),
    }
}

/// Preserve semver pins written by in-container stack updates (Settings → Update in a browser)
/// until the desktop bundle itself catches up. Without this, every hub.start regenerates
/// .env from the stale desktop binary and reverts CI_HUB_IMAGE back to the old tag.
pub(crate) fn resolve_runtime_hub_image(existing: &HashMap<String, String>) -> String {
    let desktop_default = default_hub_image();

    let Some(existing_image) = existing.get("CI_HUB_IMAGE") else {
        return desktop_default;
    };

    let Some(tag) = image_tag(existing_image) else {
        return desktop_default;
    };

    if is_floating_image_tag(tag) {
        return desktop_default;
    }

    if !existing_image.contains("ci-os-hub") {
        return desktop_default;
    }

    if let Some(desktop_version) = option_env!("CI_HUB_BUILD_VERSION") {
        let desktop_version = desktop_version.trim_start_matches('v');
        if compare_semver(tag, desktop_version) == Ordering::Greater {
            return existing_image.clone();
        }
        return desktop_default;
    }

    if tag.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return existing_image.clone();
    }

    desktop_default
}

pub(crate) fn runtime_hub_version_for_image(hub_image: &str) -> String {
    if let Some(tag) = image_tag(hub_image).filter(|tag| !is_floating_image_tag(tag)) {
        if tag.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return tag.trim_start_matches('v').to_string();
        }
    }

    option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or("4.7.0")
        .trim_start_matches('v')
        .to_string()
}

fn image_tag(image: &str) -> Option<&str> {
    image.rsplit_once(':').map(|(_, tag)| tag)
}

fn is_floating_image_tag(tag: &str) -> bool {
    matches!(tag, "latest" | "staging" | "dev")
}

fn compare_semver(left: &str, right: &str) -> Ordering {
    let left_parts = parse_semver_parts(left);
    let right_parts = parse_semver_parts(right);
    let max_len = left_parts.len().max(right_parts.len());

    for index in 0..max_len {
        let left_part = left_parts.get(index).copied().unwrap_or(0);
        let right_part = right_parts.get(index).copied().unwrap_or(0);
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            other => return other,
        }
    }

    Ordering::Equal
}

fn parse_semver_parts(version: &str) -> Vec<u32> {
    version
        .trim_start_matches('v')
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect()
}

pub(crate) fn default_update_cdn_base() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_UPDATE_CDN_BASE,
        _ => DEFAULT_DEV_UPDATE_CDN_BASE,
    }
}

pub(crate) fn default_update_cdn_host() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_UPDATE_CDN_HOST,
        _ => DEFAULT_DEV_UPDATE_CDN_HOST,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_public_domain_is_non_empty() {
        assert!(!default_public_domain().is_empty());
    }

    #[test]
    fn default_hub_image_uses_ci_os_hub_repo() {
        let image = default_hub_image();
        assert!(image.contains("ci-os-hub"));
    }

    #[test]
    fn preserves_newer_stack_update_pin_over_desktop_default() {
        let mut existing = HashMap::new();
        existing.insert(
            "CI_HUB_IMAGE".to_string(),
            "ghcr.io/companionintelligence/ci-os-hub:99.0.0".to_string(),
        );

        let resolved = resolve_runtime_hub_image(&existing);
        assert_eq!(
            resolved,
            "ghcr.io/companionintelligence/ci-os-hub:99.0.0".to_string()
        );
    }

    #[test]
    fn semver_compare_orders_patch_versions() {
        assert_eq!(
            compare_semver("0.2.43", "0.2.41"),
            Ordering::Greater
        );
        assert_eq!(
            compare_semver("0.2.41", "0.2.43"),
            Ordering::Less
        );
    }

    #[test]
    fn runtime_hub_version_follows_pinned_image_tag() {
        assert_eq!(
            runtime_hub_version_for_image("ghcr.io/companionintelligence/ci-os-hub:0.2.43"),
            "0.2.43"
        );
    }
}
