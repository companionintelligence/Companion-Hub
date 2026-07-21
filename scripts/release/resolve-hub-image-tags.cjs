#!/usr/bin/env node
/**
 * Resolve which Hub stack image references a release run must publish and verify.
 *
 * This is the single source of truth shared by the release pipeline and the shipped
 * desktop binary. It deliberately mirrors `default_hub_image()` in
 * `packages/desktop/src-tauri/src/hub_env.rs` — CI publishes what that function will
 * later pull, and the `verify-anonymous-pull` gate asserts the exact same reference is
 * anonymously pullable. If you change the resolution rules in either place, change both.
 *
 * Background: Hub 0.2.44 shipped pinning `ci-os-hub:0.2.44`, a private package no workflow
 * published version tags to, so Docker returned 403 and the Hub API never started (#920).
 * Encoding the rule once, in something unit-testable, is what stops that recurring.
 *
 * Usage:
 *   node scripts/release/resolve-hub-image-tags.cjs --environment production --tag v0.2.45
 *
 * Writes `key=value` lines to $GITHUB_OUTPUT when set, and always echoes them to stdout so
 * the resolution is visible in the run log and runnable locally.
 */

const fs = require('node:fs');

/**
 * GHCR repo the desktop pulls from. Must match `HUB_STACK_IMAGE_REPO` in
 * `hub_env.rs` and `packages/backend/src/common/constants.ts`.
 *
 * Spelled out rather than derived from `github.repository` so the published image and the
 * verified image cannot drift: the workflow feeds this same value into both the
 * `docker/metadata-action` image list and the pull gate.
 */
const IMAGE_REPO = 'ghcr.io/companionintelligence/ci-hub';

/** Per-environment floating tag and Portal mirror, unchanged from the original workflow. */
const ENVIRONMENTS = {
  production: { channelTag: 'latest', portalRegistry: 'hub.ci.computer' },
  staging: { channelTag: 'staging', portalRegistry: 'portal.companionintel.com' },
  dev: { channelTag: 'dev', portalRegistry: 'hub.companionintelligence.com' },
};

/**
 * Strict `major.minor.patch` with an optional pre-release/build suffix.
 * Anchored so partial values like `0.2` or `latest` are rejected rather than silently
 * producing a tag nothing can pull.
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Normalise a release tag into the tag CI must publish.
 *
 * The leading `v` is stripped because two consumers require the unprefixed form and would
 * 404 otherwise: `default_hub_image()` strips it when composing the pin, and the backend's
 * `pinHubStackVersionInEnv` interpolates the raw listed tag into `<repo>:<tag>`. Publishing
 * `v`-prefixed tags is precisely what the retired `release.yml` got wrong.
 *
 * @param {string} tag Raw release tag, e.g. `v0.2.45`. Empty/absent means "no version".
 * @returns {string} Unprefixed version, or '' when no tag was supplied.
 * @throws {Error} When a tag was supplied but is not valid semver — a hard error, because
 *   silently skipping it would ship a release with no versioned image, the original bug.
 */
function normalizeVersion(tag) {
  const trimmed = (tag ?? '').trim();
  if (!trimmed) {
    return '';
  }

  const withoutPrefix = trimmed.replace(/^v/, '');
  if (!SEMVER_PATTERN.test(withoutPrefix)) {
    throw new Error(
      `Release tag "${trimmed}" is not valid semver (expected e.g. v0.2.45 or 0.2.45). ` +
        'Refusing to publish, because an unparseable tag yields a release with no versioned image.',
    );
  }

  return withoutPrefix;
}

/**
 * Resolve every reference a run needs.
 *
 * A version tag is published ONLY for production. Non-production builds compile a different
 * CI_CLOUD_URL, so publishing `ci-hub:0.2.45` from a dev run would leave a
 * production-looking tag pointing at a dev-configured image that a real production desktop
 * would then pin and pull.
 *
 * @param {{environment?: string, tag?: string}} options
 * @returns {{environment: string, imageRepo: string, channelTag: string, version: string,
 *   desktopRef: string, portalRegistry: string}}
 */
function resolveHubImageTags({ environment, tag } = {}) {
  const env = (environment ?? '').trim() || 'dev';
  const config = ENVIRONMENTS[env];
  if (!config) {
    throw new Error(`Unknown environment "${env}" (expected one of: ${Object.keys(ENVIRONMENTS).join(', ')})`);
  }

  const isProduction = env === 'production';
  // Validate the tag even when it will not be published, so a malformed tag fails the run
  // rather than passing silently on dev and only exploding at production release time.
  const normalized = normalizeVersion(tag);
  const version = isProduction ? normalized : '';

  // Mirrors default_hub_image(): production pins the exact version when one exists and
  // otherwise falls back to the channel tag; every other environment uses its channel tag.
  const desktopRef = version ? `${IMAGE_REPO}:${version}` : `${IMAGE_REPO}:${config.channelTag}`;

  return {
    environment: env,
    imageRepo: IMAGE_REPO,
    channelTag: config.channelTag,
    version,
    desktopRef,
    portalRegistry: config.portalRegistry,
  };
}

/** Minimal `--flag value` parser; avoids a dependency for two arguments. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = '';
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveHubImageTags({ environment: args.environment, tag: args.tag });

  const outputs = {
    environment: resolved.environment,
    image_repo: resolved.imageRepo,
    channel_tag: resolved.channelTag,
    version: resolved.version,
    desktop_ref: resolved.desktopRef,
    portal_registry: resolved.portalRegistry,
  };

  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }

  // Always echo: makes the resolution auditable in the run log and usable locally.
  for (const line of lines) {
    console.log(line);
  }

  if (resolved.version) {
    console.log(`::notice::Desktop builds will pin ${resolved.desktopRef} — this exact reference must be anonymously pullable.`);
  } else {
    console.log(
      `::notice::No versioned image for environment "${resolved.environment}" — publishing channel tag ` +
        `"${resolved.channelTag}" only. Desktop builds will pin ${resolved.desktopRef}.`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = { IMAGE_REPO, ENVIRONMENTS, normalizeVersion, resolveHubImageTags };
