//! Build-time defaults for Hub public URLs and container image tags.

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

/// Hub container image tag for this build. Keyed on the build-time environment
/// (CI_HUB_ENVIRONMENT) rather than the public domain, so the public domain can be a
/// Cloudflare-provisioned zone (e.g. companionintelligence.com) without affecting which
/// image tag is pulled. Production → :latest, staging → :staging, otherwise → :dev.
pub(crate) fn default_hub_image() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => "ghcr.io/companionintelligence/ci-hub:latest",
        Some("staging") => "ghcr.io/companionintelligence/ci-hub:staging",
        _ => "ghcr.io/companionintelligence/ci-hub:dev",
    }
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
}
