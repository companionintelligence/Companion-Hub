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
    hub_image_for(build_environment(), build_version())
}

/// Pure form of [`default_hub_image`], split out so every arm is reachable in tests.
///
/// `option_env!` is resolved at compile time, so a test binary always sees the same
/// values; calling `default_hub_image()` directly would only ever exercise the `dev` arm
/// and leave the production branch — the one that shipped #920 — unverified.
fn hub_image_for(environment: Option<&str>, version: Option<&str>) -> String {
    match environment {
        // The compiled version must be a shape the pipeline actually publishes. A blank
        // value would compose `ci-hub:`, and a malformed one like `0.2.45+ci.7` composes a
        // reference Docker rejects outright — either way every install of that build is
        // dead on arrival, which is #920. `verify-anonymous-pull` cannot catch this: it
        // checks the reference the *resolver* computed, not the one compiled into the
        // binary, so the two only agree while the release wiring stays correct. Falling
        // back to the floating channel tag keeps a mis-wired build startable instead.
        Some("production") => match version
            .map(normalize_version_tag)
            .filter(|version| is_version_image_tag(version))
        {
            Some(version) => format!("{HUB_STACK_IMAGE_REPO}:{version}"),
            None => format!("{HUB_STACK_IMAGE_REPO}:latest"),
        },
        Some("staging") => format!("{HUB_STACK_IMAGE_REPO}:staging"),
        _ => format!("{HUB_STACK_IMAGE_REPO}:dev"),
    }
}

/// Build environment this binary was compiled for.
fn build_environment() -> Option<&'static str> {
    option_env!("CI_HUB_ENVIRONMENT").map(str::trim)
}

/// Release version this binary was compiled for, if one was supplied.
///
/// `option_env!` yields `Some("")` when the variable is set but empty, which the release
/// workflow does whenever it is dispatched with a blank tag. Treating that as a version
/// would compose `ci-hub:` — an invalid reference that fails every `docker compose` call —
/// so an empty value is reported as absent and falls back to the channel tag.
fn build_version() -> Option<&'static str> {
    option_env!("CI_HUB_BUILD_VERSION").filter(|version| !version.trim().is_empty())
}

/// Strip the optional leading `v` from a release tag.
///
/// The pipeline publishes unprefixed tags (`ci-hub:0.2.45`), so any `v` spelling that
/// reaches us — a legacy tag from the retired workflow, or a hand-edited `.env` — must be
/// normalized before it is written back as an image reference, or the pull 404s.
fn normalize_version_tag(version: &str) -> &str {
    version.trim().trim_start_matches('v')
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
    resolve_runtime_hub_image_for(
        existing.get("CI_HUB_IMAGE").map(String::as_str),
        build_environment(),
        build_version(),
    )
}

/// Pure form of [`resolve_runtime_hub_image`], so both build-version branches are testable.
///
/// A shipped bundle always carries `CI_HUB_BUILD_VERSION`, so released binaries only ever
/// take the `compare_semver` path; testing through `default_hub_image()` would exercise the
/// other one exclusively.
fn resolve_runtime_hub_image_for(
    existing_image: Option<&str>,
    environment: Option<&str>,
    build_version: Option<&str>,
) -> String {
    let desktop_default = hub_image_for(environment, build_version);

    let Some(existing_image) = existing_image.map(unquote_env_value) else {
        return desktop_default;
    };

    let Some((repository, tag)) = existing_image.rsplit_once(':') else {
        return desktop_default;
    };

    if is_floating_image_tag(tag) {
        return desktop_default;
    }

    // Exact repo match, not a substring test: a pin is only meaningful if it names the
    // repo this build actually pulls from. Anything else (a foreign registry, or a stale
    // `ci-os-hub` reference from a pre-#920 desktop or backend) is discarded in favour of
    // the desktop default rather than carried forward into an unpullable start.
    if repository != HUB_STACK_IMAGE_REPO {
        return desktop_default;
    }

    if !is_version_image_tag(tag) {
        return desktop_default;
    }

    // Rebuild the reference from the normalized tag rather than echoing the pin back
    // verbatim: a `v`-prefixed tag is a spelling the pipeline never publishes, so handing
    // it straight to compose would 404 — and would disagree with CI_HUB_VERSION, which
    // runtime_hub_version_for_image derives from the same tag with the `v` stripped.
    let pinned = format!("{HUB_STACK_IMAGE_REPO}:{}", normalize_version_tag(tag));

    match build_version {
        // Honour a stack update only while it is ahead of the bundle that shipped this
        // binary; otherwise the desktop's own build wins.
        Some(build_version) => {
            if compare_semver(tag, build_version) == Ordering::Greater {
                pinned
            } else {
                desktop_default
            }
        }
        None => pinned,
    }
}

/// Strip surrounding quotes from a `.env` value.
///
/// `parse_env_file` only trims whitespace, but quoting a value is legal in an env file.
/// Without this, a quoted `CI_HUB_IMAGE` fails the repository check, gets replaced on every
/// single start, and — because the rewritten file counts as a config change — forces a full
/// image pull and container recreate each launch.
fn unquote_env_value(value: &str) -> &str {
    let trimmed = value.trim();
    trimmed
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
        })
        .unwrap_or(trimmed)
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

fn is_floating_image_tag(tag: &str) -> bool {
    matches!(tag, "latest" | "staging" | "dev")
}

/// Whether a tag looks like a version pin (`0.2.43`, `v0.2.43`, `0.2.45-rc.1`).
///
/// Requires a fully numeric `major.minor.patch` core, not merely a leading digit. The
/// caller *preserves* any pin this accepts, so a lax check carries junk like `1.x` or
/// `2026-07-21` straight into `docker compose` as an unpullable reference — the exact
/// failure mode #920 was. Everything rejected here falls back to the desktop's own build
/// default, which is always publishable and pullable, so erring strict is the safe side.
///
/// Accepts exactly the shape `SEMVER_PATTERN` in `scripts/release/resolve-hub-image-tags.cjs`
/// publishes. The two guards bracket one contract — CI decides what may be published, this
/// decides what may be pinned — so any tag this honours must be one CI would mint. Letting
/// them drift is how a reference the pipeline refuses to publish becomes one the desktop
/// writes into `.env`.
///
/// Each component is validated with the same `u32` parse [`parse_semver_parts`] uses, so
/// the two can never disagree about whether a tag is comparable: a tag accepted here is
/// guaranteed to yield three ordered components there.
///
/// The leading `v` is optional because both spellings have been published over this
/// repo's history: the retired tag-triggered workflow emitted `v`-prefixed tags, while
/// the desktop and the backend updater both use the unprefixed form. Callers strip the
/// prefix before parsing, so accepting it here keeps a `v`-tagged pin from silently
/// falling through to the build-time fallback version.
fn is_version_image_tag(tag: &str) -> bool {
    let core = normalize_version_tag(tag);

    // `+` is outside the legal Docker tag alphabet, so build metadata can never be pulled.
    // Rejecting beats trimming: the caller rebuilds the pin from the *un-cut* tag, so
    // accepting `0.2.45+ci.7` would write `repo:0.2.45+ci.7` into .env, which compose
    // refuses with "invalid reference format" before it ever reaches the registry.
    if core.contains('+') {
        return false;
    }

    // A pre-release suffix is legal and published — Desktop Release defaults to prerelease.
    let (core, prerelease) = match core.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (core, None),
    };

    if core.split('.').count() != 3 || !core.split('.').all(is_numeric_identifier) {
        return false;
    }

    // An empty segment (`0.2.46-`) or an empty identifier (`rc..1`) is refused by CI and
    // would otherwise reach compare_prerelease as an empty identifier.
    match prerelease {
        None => true,
        Some(prerelease) => {
            !prerelease.is_empty() && prerelease.split('.').all(is_prerelease_identifier)
        }
    }
}

/// A semver numeric identifier: digits only, with no leading zero unless the value *is* zero.
///
/// Leading zeros matter beyond pedantry. `semver.valid("01.2.45")` is null, and the backend's
/// `getTagsSince` bails to an empty list as soon as the *running* version fails that check —
/// so a Hub installed from such a tag would pull fine and then never see another update.
fn is_numeric_identifier(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.bytes().all(|byte| byte.is_ascii_digit())
        && (identifier == "0" || !identifier.starts_with('0'))
}

/// A semver pre-release identifier: alphanumerics and hyphens, with purely numeric ones
/// held to the numeric-identifier rule so `rc.01` is rejected alongside `01.2.45`.
fn is_prerelease_identifier(identifier: &str) -> bool {
    if identifier.is_empty() {
        return false;
    }

    if identifier.bytes().all(|byte| byte.is_ascii_digit()) {
        return is_numeric_identifier(identifier);
    }

    identifier
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Semver precedence between two version tags.
///
/// Pre-release ordering is modelled, not just the numeric core. Desktop Release defaults
/// to prerelease, so RC bundles are real, and the backend's updater uses `semver.gt` — it
/// will happily pin `0.2.46-rc.2` over an `0.2.46-rc.1` build. Comparing cores alone
/// called those equal, so the caller discarded the pin and reverted the upgrade on the
/// next start: exactly the desktop-versus-updater fight this file exists to end.
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

    // Same numeric core, so semver precedence turns on the pre-release segment: a release
    // outranks every pre-release of the same version.
    match (prerelease_segment(left), prerelease_segment(right)) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left_prerelease), Some(right_prerelease)) => {
            compare_prerelease(left_prerelease, right_prerelease)
        }
    }
}

/// Pre-release segment of a version tag (`0.2.46-rc.1` → `rc.1`), or `None` for a release.
///
/// Build metadata is not handled because it cannot get here: [`is_version_image_tag`]
/// rejects `+` outright, since it is not a legal Docker tag character.
fn prerelease_segment(version: &str) -> Option<&str> {
    version
        .trim()
        .trim_start_matches('v')
        .split_once('-')
        .map(|(_, prerelease)| prerelease)
}

/// Compare two pre-release segments by semver precedence rules.
///
/// Identifiers are compared left to right: numeric ones numerically, so `rc.10` outranks
/// `rc.2` where a plain string compare would invert them; alphanumeric ones lexically in
/// ASCII order; a numeric identifier always ranks below an alphanumeric one; and when all
/// preceding identifiers match, the longer set wins (`rc.1.1` > `rc.1`).
fn compare_prerelease(left: &str, right: &str) -> Ordering {
    let mut left_identifiers = left.split('.');
    let mut right_identifiers = right.split('.');

    loop {
        let ordering = match (left_identifiers.next(), right_identifiers.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(left), Some(right)) => match (left.parse::<u32>(), right.parse::<u32>()) {
                (Ok(left), Ok(right)) => left.cmp(&right),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => left.cmp(right),
            },
        };

        if ordering != Ordering::Equal {
            return ordering;
        }
    }
}

/// Numeric `major.minor.patch` components of a version, ignoring any pre-release suffix.
///
/// The pre-release/build metadata is cut off BEFORE splitting on `.`. Splitting first and
/// discarding unparseable components silently mis-reads `0.2.46-rc.1` as `[0, 2, 1]` — the
/// `46-rc` component fails to parse and vanishes — which orders an rc build below the
/// release it follows. Pre-release tags are publishable (the release pipeline accepts them
/// and Desktop Release defaults to prerelease), so this path is live.
///
/// This yields only the numeric core; precedence *between* pre-releases of the same core
/// is [`compare_prerelease`]'s job, and [`compare_semver`] applies it once the cores tie.
fn parse_semver_parts(version: &str) -> Vec<u32> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    core.split('.')
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

    const PROD: Option<&str> = Some("production");

    #[test]
    fn default_public_domain_is_non_empty() {
        assert!(!default_public_domain().is_empty());
    }

    #[test]
    fn image_repo_is_the_public_ci_hub_package() {
        // Pinned to a literal, not interpolated: every other assertion in this module
        // derives from the constant, so only this one can catch it being repointed. The
        // private ci-os-hub package is what stopped Hub 0.2.44 from starting (#920).
        assert_eq!(HUB_STACK_IMAGE_REPO, "ghcr.io/companionintelligence/ci-hub");
    }

    #[test]
    fn production_pins_the_exact_release_version_unprefixed() {
        // Exercised through the pure form because option_env! is compile-time: calling
        // default_hub_image() in a test binary only ever reaches the `dev` arm, leaving
        // the production branch — the one that shipped #920 — unverified.
        assert_eq!(
            hub_image_for(PROD, Some("v0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.45")
        );
        assert_eq!(
            hub_image_for(PROD, Some("0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.45")
        );
    }

    #[test]
    fn production_without_a_version_falls_back_to_latest() {
        assert_eq!(
            hub_image_for(PROD, None),
            format!("{HUB_STACK_IMAGE_REPO}:latest")
        );
    }

    #[test]
    fn blank_build_version_is_treated_as_absent() {
        // The release workflow writes CI_HUB_BUILD_VERSION unconditionally, so a blank
        // tag would otherwise compose `ci-hub:` — an invalid reference that fails every
        // docker compose call.
        for blank in ["", "   "] {
            assert_eq!(
                hub_image_for(PROD, Some(blank)),
                format!("{HUB_STACK_IMAGE_REPO}:latest"),
                "blank version {blank:?} must not produce an empty tag"
            );
        }
    }

    #[test]
    fn malformed_build_version_falls_back_to_the_channel_tag() {
        // desktop-release.yml sets CI_HUB_BUILD_VERSION from the raw dispatch input, so a
        // mis-typed tag compiles straight into the binary. `0.2.45+ci.7` would compose a
        // reference Docker refuses outright, bricking every install of that build — and
        // the anonymous-pull gate would not notice, because it verifies the reference the
        // resolver computed rather than the one the binary carries. The floating channel
        // tag is public and current, so degrading to it keeps the build startable.
        for malformed in ["0.2", "0.2.45+ci.7", "latest", "1.x"] {
            assert_eq!(
                hub_image_for(PROD, Some(malformed)),
                format!("{HUB_STACK_IMAGE_REPO}:latest"),
                "version {malformed:?} is not publishable and must not be pinned"
            );
        }

        // A well-formed version, prefixed or not, is still pinned exactly.
        assert_eq!(
            hub_image_for(PROD, Some("v0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.45")
        );
        assert_eq!(
            hub_image_for(PROD, Some("0.2.46-rc.1")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.46-rc.1")
        );
    }

    #[test]
    fn non_production_environments_use_their_channel_tag() {
        assert_eq!(
            hub_image_for(Some("staging"), Some("0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:staging")
        );
        assert_eq!(
            hub_image_for(Some("dev"), Some("0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:dev")
        );
        assert_eq!(
            hub_image_for(None, None),
            format!("{HUB_STACK_IMAGE_REPO}:dev")
        );
    }

    #[test]
    fn preserves_newer_stack_update_pin_over_desktop_default() {
        let pin = format!("{HUB_STACK_IMAGE_REPO}:99.0.0");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.45")),
            pin,
            "a newer same-repo pin must survive hub.start"
        );
    }

    #[test]
    fn discards_pin_that_is_not_ahead_of_this_build() {
        // Shipped bundles always carry a build version, so this branch — not the
        // is_version_image_tag one — is what released binaries actually execute.
        let pin = format!("{HUB_STACK_IMAGE_REPO}:0.1.0");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.45")),
            hub_image_for(PROD, Some("0.2.45"))
        );
    }

    #[test]
    fn prerelease_build_is_not_ordered_below_the_release_it_follows() {
        // parse_semver_parts once read "0.2.46-rc.1" as [0,2,1], so an rc bundle compared
        // OLDER than 0.2.45 and kept the stale pin forever.
        let pin = format!("{HUB_STACK_IMAGE_REPO}:0.2.45");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&pin), PROD, Some("v0.2.46-rc.1")),
            hub_image_for(PROD, Some("v0.2.46-rc.1")),
            "an rc build must supersede the release before it"
        );
        assert_eq!(compare_semver("0.2.46-rc.1", "0.2.45"), Ordering::Greater);
        assert_eq!(compare_semver("0.2.46+ci.7", "0.2.45"), Ordering::Greater);
    }

    #[test]
    fn normalizes_a_v_prefixed_pin_instead_of_echoing_it_back() {
        // The pipeline never publishes a `v` spelling, so honouring one verbatim would
        // write an unpullable CI_HUB_IMAGE that also contradicts CI_HUB_VERSION.
        let pin = format!("{HUB_STACK_IMAGE_REPO}:v99.0.0");
        let resolved = resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.45"));
        assert_eq!(resolved, format!("{HUB_STACK_IMAGE_REPO}:99.0.0"));
        assert_eq!(runtime_hub_version_for_image(&resolved), "99.0.0");
    }

    #[test]
    fn honours_a_quoted_pin() {
        // parse_env_file only trims whitespace, so a quoted value would otherwise fail the
        // repo check and be rewritten on every start — forcing a pull and recreate each launch.
        let quoted = format!("\"{HUB_STACK_IMAGE_REPO}:99.0.0\"");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&quoted), PROD, Some("0.2.45")),
            format!("{HUB_STACK_IMAGE_REPO}:99.0.0")
        );
    }

    #[test]
    fn discards_a_pin_whose_tag_is_not_a_full_version() {
        // A leading-digit check accepts junk like `1.x`, and because a pin this guard
        // accepts is preserved verbatim, the Hub would then be told to pull a tag that
        // does not exist — reproducing #920 from a different direction. `1.x` also
        // out-compares any real build under compare_semver ([1] vs [0, 2, 45]), so the
        // lax form failed exactly when it mattered most.
        for tag in [
            "1.x",
            "v1.x",
            "0.2",
            "2026-07-21",
            "1.2.beta",
            "99.0.0+ci.7",
        ] {
            let pin = format!("{HUB_STACK_IMAGE_REPO}:{tag}");
            assert_eq!(
                resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.45")),
                hub_image_for(PROD, Some("0.2.45")),
                "expected the desktop default to win over the unpullable pin {pin}"
            );
        }
    }

    #[test]
    fn accepts_every_shape_the_release_pipeline_publishes() {
        // The strict check must not reject the tags CI actually mints, or a legitimate
        // stack update would be discarded on every start.
        for tag in ["99.0.0", "v99.0.0", "99.0.0-rc.1"] {
            assert!(
                is_version_image_tag(tag),
                "{tag} is a published tag shape and must be honoured as a version pin"
            );
        }
        for tag in ["1.x", "0.2", "latest", "nightly", "2026-07-21", ""] {
            assert!(!is_version_image_tag(tag), "{tag} is not a version pin");
        }
    }

    #[test]
    fn orders_pre_releases_by_semver_precedence() {
        // Numeric identifiers compare numerically: a lexical compare would put rc.10
        // below rc.2 and silently strand every release past the ninth candidate.
        assert_eq!(
            compare_semver("0.2.46-rc.10", "0.2.46-rc.2"),
            Ordering::Greater
        );
        assert_eq!(
            compare_semver("0.2.46-rc.2", "0.2.46-rc.1"),
            Ordering::Greater
        );
        // A release outranks every pre-release of the same core, and vice versa.
        assert_eq!(compare_semver("0.2.46", "0.2.46-rc.1"), Ordering::Greater);
        assert_eq!(compare_semver("0.2.46-rc.1", "0.2.46"), Ordering::Less);
        // Alphanumeric identifiers compare lexically; longer sets win ties.
        assert_eq!(
            compare_semver("0.2.46-rc", "0.2.46-beta"),
            Ordering::Greater
        );
        assert_eq!(
            compare_semver("0.2.46-rc.1.1", "0.2.46-rc.1"),
            Ordering::Greater
        );
        assert_eq!(
            compare_semver("0.2.46-rc.1", "0.2.46-rc.1"),
            Ordering::Equal
        );
        // The numeric core still dominates the pre-release segment.
        assert_eq!(compare_semver("0.2.47-rc.1", "0.2.46"), Ordering::Greater);
    }

    #[test]
    fn preserves_a_newer_pre_release_pin_over_a_pre_release_build() {
        // Desktop Release defaults to prerelease, and the backend updater pins with
        // semver.gt — so it will pin rc.2 onto an rc.1 build. Treating the two as equal
        // made the desktop discard that pin and revert the upgrade on the very next
        // start, which is the desktop-versus-updater fight this resolver exists to end.
        let pin = format!("{HUB_STACK_IMAGE_REPO}:0.2.46-rc.2");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.46-rc.1")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.46-rc.2")
        );

        // The final release must also win over the rc bundle that preceded it.
        let release_pin = format!("{HUB_STACK_IMAGE_REPO}:0.2.46");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&release_pin), PROD, Some("0.2.46-rc.1")),
            format!("{HUB_STACK_IMAGE_REPO}:0.2.46")
        );

        // ...but an older rc pin must not displace the shipped release.
        let stale_pin = format!("{HUB_STACK_IMAGE_REPO}:0.2.46-rc.1");
        assert_eq!(
            resolve_runtime_hub_image_for(Some(&stale_pin), PROD, Some("0.2.46")),
            hub_image_for(PROD, Some("0.2.46"))
        );
    }

    #[test]
    fn rejects_tags_the_release_pipeline_would_refuse_to_publish() {
        // This guard and SEMVER_PATTERN in resolve-hub-image-tags.cjs bracket one
        // contract, so a shape CI rejects must not be a shape the desktop pins.
        //
        // `+` matters most: it is outside the legal Docker tag alphabet, and because the
        // caller rebuilds the pin from the un-cut tag, accepting it would write
        // `repo:99.0.0+ci.7` into .env — rejected by compose as an invalid reference
        // before any registry is contacted, so the Hub never starts.
        for tag in [
            "99.0.0+ci.7",
            "v99.0.0+build.1",
            "1.2.3.4",
            "99.0.0.",
            "99.0.0-",
            // Invalid semver, so `semver.valid` in the backend rejects these — and
            // getTagsSince bails to [] on an invalid *running* version, which would blind
            // a Hub installed from such a tag to every future update.
            "01.2.45",
            "99.0.0-rc..1",
            "99.0.0-rc.01",
        ] {
            assert!(
                !is_version_image_tag(tag),
                "{tag} is not a shape the release pipeline publishes"
            );
        }

        // ...while every shape semver considers valid (bar build metadata) still passes.
        for tag in ["0.0.0", "1.0.0-0.3.7", "0.2.46-rc.1", "0.2.46-alpha-1"] {
            assert!(
                is_version_image_tag(tag),
                "{tag} is valid semver and must be honoured as a version pin"
            );
        }
    }

    #[test]
    fn discards_stale_ci_os_hub_pin_even_when_newer() {
        // The #920 migration guarantee: a pre-fix desktop or backend left a pin at the
        // private ci-os-hub repo, which anonymous Docker cannot pull. Even though 99.0.0
        // is "newer" than any desktop build, the reference is unusable and must be
        // replaced by the desktop default rather than carried forward.
        let resolved = resolve_runtime_hub_image_for(
            Some("ghcr.io/companionintelligence/ci-os-hub:99.0.0"),
            PROD,
            Some("0.2.45"),
        );
        assert_eq!(resolved, hub_image_for(PROD, Some("0.2.45")));
        assert!(!resolved.contains("ci-os-hub"));
    }

    #[test]
    fn discards_pin_from_a_foreign_registry() {
        assert_eq!(
            resolve_runtime_hub_image_for(
                Some("registry.example.com/ci-hub:99.0.0"),
                PROD,
                Some("0.2.45")
            ),
            hub_image_for(PROD, Some("0.2.45"))
        );
    }

    #[test]
    fn discards_a_non_version_pin() {
        for tag in ["latest", "staging", "dev", "nightly", "garbage"] {
            let pin = format!("{HUB_STACK_IMAGE_REPO}:{tag}");
            assert_eq!(
                resolve_runtime_hub_image_for(Some(&pin), PROD, Some("0.2.45")),
                hub_image_for(PROD, Some("0.2.45")),
                "tag {tag} must not be honoured as a version pin"
            );
        }
    }

    #[test]
    fn falls_back_to_desktop_default_without_a_pin() {
        assert_eq!(
            resolve_runtime_hub_image_for(None, PROD, Some("0.2.45")),
            hub_image_for(PROD, Some("0.2.45"))
        );
        assert_eq!(
            resolve_runtime_hub_image(&HashMap::new()),
            default_hub_image()
        );
    }

    #[test]
    fn honours_a_version_pin_when_no_build_version_is_compiled_in() {
        let pin = format!("{HUB_STACK_IMAGE_REPO}:1.2.3");
        assert_eq!(resolve_runtime_hub_image_for(Some(&pin), PROD, None), pin);
    }

    #[test]
    fn semver_compare_orders_patch_versions() {
        assert_eq!(compare_semver("0.2.43", "0.2.41"), Ordering::Greater);
        assert_eq!(compare_semver("0.2.41", "0.2.43"), Ordering::Less);
    }

    #[test]
    fn parse_semver_parts_ignores_prerelease_and_build_metadata() {
        assert_eq!(parse_semver_parts("0.2.46-rc.1"), vec![0, 2, 46]);
        assert_eq!(parse_semver_parts("v0.2.46+ci.7"), vec![0, 2, 46]);
        assert_eq!(parse_semver_parts("0.2.46"), vec![0, 2, 46]);
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
