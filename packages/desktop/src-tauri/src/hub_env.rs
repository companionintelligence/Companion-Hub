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
/// GHCR repo the Hub stack image is pulled from.
///
/// This is the package `build-container.yml` actually publishes to (it pushes to
/// `ghcr.io/${{ github.repository }}`, lowercased), and it is public. It must stay in
/// sync with `HUB_STACK_IMAGE_REPO` in the backend's `common/constants.ts`, which is
/// what the in-container updater writes into `CI_HUB_IMAGE` — when the two disagree,
/// the desktop and the updater fight over `.env` on every start.
///
/// NOTE: `ci-os-hub` elsewhere in this codebase is the compose *service*/container
/// name (`container_name: ci-os-hub`, `ci-os-hub_network`, `ci-os-hub.managed`
/// labels). That is unrelated to this image repo and must not be renamed with it.
pub(crate) const HUB_STACK_IMAGE_REPO: &str = "ghcr.io/companionintelligence/ci-hub";

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

/// Default Hub stack image for this desktop build, aligned with backend stack updates.
///
/// A production bundle pins the exact release version so the stack cannot drift from the
/// binary that shipped it. `CI_HUB_BUILD_VERSION` is the release tag (`v0.2.45`), and the
/// `v` is stripped here — so the release pipeline must publish the tag **unprefixed**
/// (`ci-hub:0.2.45`). `scripts/release/resolve-hub-image-tags.cjs` mirrors this function to
/// decide what CI publishes and verifies; keep the two in step.
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
///
/// Pins are only honoured when they point at [`HUB_STACK_IMAGE_REPO`]. That is what makes
/// the #920 recovery automatic: a `.env` left pinned at the old, private `ci-os-hub` repo
/// no longer matches, so it is dropped and the next start regenerates a pullable
/// `ci-hub` reference. The rewritten `.env` also makes `ensure_runtime_env_state` report a
/// change, which forces a fresh pull — so a stranded install repairs itself on one start.
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

    // Exact repo match, not a substring test: a pin is only meaningful if it names the
    // repo this build actually pulls from. Anything else (a foreign registry, or a stale
    // `ci-os-hub` reference from a pre-#920 desktop or backend) is discarded in favour of
    // the desktop default rather than carried forward into an unpullable start.
    if image_repository(existing_image) != Some(HUB_STACK_IMAGE_REPO) {
        return desktop_default;
    }

    if let Some(desktop_version) = option_env!("CI_HUB_BUILD_VERSION") {
        let desktop_version = desktop_version.trim_start_matches('v');
        if compare_semver(tag, desktop_version) == Ordering::Greater {
            return existing_image.clone();
        }
        return desktop_default;
    }

    if is_version_image_tag(tag) {
        return existing_image.clone();
    }

    desktop_default
}

pub(crate) fn runtime_hub_version_for_image(hub_image: &str) -> String {
    if let Some(tag) = image_tag(hub_image).filter(|tag| !is_floating_image_tag(tag)) {
        if is_version_image_tag(tag) {
            return tag.trim_start_matches('v').to_string();
        }
    }

    option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or("4.7.0")
        .trim_start_matches('v')
        .to_string()
}

/// Tag portion of a `repo:tag` reference.
fn image_tag(image: &str) -> Option<&str> {
    image.rsplit_once(':').map(|(_, tag)| tag)
}

/// Repository portion of a `repo:tag` reference.
///
/// Splits on the same boundary as [`image_tag`] so the repo and tag checks can never
/// disagree about where the reference divides. An untagged reference yields `None`,
/// which callers treat as "not a pin we recognise".
fn image_repository(image: &str) -> Option<&str> {
    image.rsplit_once(':').map(|(repo, _)| repo)
}

fn is_floating_image_tag(tag: &str) -> bool {
    matches!(tag, "latest" | "staging" | "dev")
}

/// Whether a tag looks like a version pin (`0.2.43` or `v0.2.43`).
///
/// The leading `v` is optional because both spellings have been published over this
/// repo's history: the retired tag-triggered workflow emitted `v`-prefixed tags, while
/// the desktop and the backend updater both use the unprefixed form. Callers strip the
/// prefix before parsing, so accepting it here keeps a `v`-tagged pin from silently
/// falling through to the build-time fallback version.
fn is_version_image_tag(tag: &str) -> bool {
    tag.trim_start_matches('v')
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_digit())
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

    /// Build a `CI_HUB_IMAGE`-only env map, the shape `resolve_runtime_hub_image` reads.
    fn env_with_pin(image: &str) -> HashMap<String, String> {
        HashMap::from([("CI_HUB_IMAGE".to_string(), image.to_string())])
    }

    #[test]
    fn default_hub_image_uses_public_ci_hub_repo() {
        let image = default_hub_image();
        assert!(
            image.starts_with(&format!("{HUB_STACK_IMAGE_REPO}:")),
            "expected a {HUB_STACK_IMAGE_REPO} reference, got {image}"
        );
        // The private repo this was mistakenly pointed at in #916 must never come back.
        assert!(
            !image.contains("ci-os-hub"),
            "regressed to ci-os-hub: {image}"
        );
    }

    #[test]
    fn default_hub_image_tag_is_never_v_prefixed() {
        // CI publishes the release tag unprefixed because this function strips the `v`
        // and the backend interpolates the raw listed tag. A `v` here means a 404 pull.
        let image = default_hub_image();
        let tag = image_tag(&image).expect("image has a tag");
        assert!(!tag.starts_with('v'), "tag must be unprefixed, got {tag}");
    }

    #[test]
    fn preserves_newer_stack_update_pin_over_desktop_default() {
        let pin = format!("{HUB_STACK_IMAGE_REPO}:99.0.0");
        let resolved = resolve_runtime_hub_image(&env_with_pin(&pin));
        assert_eq!(
            resolved, pin,
            "a newer same-repo pin must survive hub.start"
        );
    }

    #[test]
    fn discards_stale_ci_os_hub_pin_even_when_newer() {
        // The #920 migration guarantee: a pre-fix desktop or backend left a pin at the
        // private ci-os-hub repo, which anonymous Docker cannot pull. Even though 99.0.0
        // is "newer" than any desktop build, the reference is unusable and must be
        // replaced by the desktop default rather than carried forward.
        let resolved = resolve_runtime_hub_image(&env_with_pin(
            "ghcr.io/companionintelligence/ci-os-hub:99.0.0",
        ));
        assert_eq!(resolved, default_hub_image());
        assert!(!resolved.contains("ci-os-hub"));
    }

    #[test]
    fn discards_pin_from_a_foreign_registry() {
        let resolved =
            resolve_runtime_hub_image(&env_with_pin("registry.example.com/ci-hub:99.0.0"));
        assert_eq!(resolved, default_hub_image());
    }

    #[test]
    fn discards_floating_pin_in_favour_of_desktop_default() {
        for tag in ["latest", "staging", "dev"] {
            let resolved =
                resolve_runtime_hub_image(&env_with_pin(&format!("{HUB_STACK_IMAGE_REPO}:{tag}")));
            assert_eq!(
                resolved,
                default_hub_image(),
                "floating tag {tag} must not pin"
            );
        }
    }

    #[test]
    fn falls_back_to_desktop_default_without_a_pin() {
        assert_eq!(
            resolve_runtime_hub_image(&HashMap::new()),
            default_hub_image()
        );
    }

    #[test]
    fn image_repository_splits_on_the_same_boundary_as_image_tag() {
        let reference = format!("{HUB_STACK_IMAGE_REPO}:1.2.3");
        assert_eq!(image_repository(&reference), Some(HUB_STACK_IMAGE_REPO));
        assert_eq!(image_tag(&reference), Some("1.2.3"));
        assert_eq!(image_repository("no-tag-here"), None);
    }

    #[test]
    fn semver_compare_orders_patch_versions() {
        assert_eq!(compare_semver("0.2.43", "0.2.41"), Ordering::Greater);
        assert_eq!(compare_semver("0.2.41", "0.2.43"), Ordering::Less);
    }

    #[test]
    fn runtime_hub_version_follows_pinned_image_tag() {
        assert_eq!(
            runtime_hub_version_for_image(&format!("{HUB_STACK_IMAGE_REPO}:0.2.43")),
            "0.2.43"
        );
    }

    #[test]
    fn runtime_hub_version_strips_v_prefix_from_a_pinned_tag() {
        assert_eq!(
            runtime_hub_version_for_image(&format!("{HUB_STACK_IMAGE_REPO}:v0.2.43")),
            "0.2.43"
        );
    }
}
