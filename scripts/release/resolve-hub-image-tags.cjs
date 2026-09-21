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
 *
 * ## Where the release version comes from
 *
 * The RELEASE TAG is the single source of truth, and `package.json` is not a source at all. Follow
 * the tag and nothing reads a version off disk:
 *
 *   desktop-release.yml `inputs.tag`
 *     - build-container.yml -> this script -> the published image tag, the OCI version label, and
 *       the `CI_HUB_BUILD_*` build args the Dockerfile bakes into the runtime image
 *     - `CI_HUB_BUILD_VERSION` -> scripts/build-standalone-cli.cjs -> the `cihub` binary
 *     - the "Bump Tauri version to match release tag" step -> tauri.conf.json + Cargo.toml
 *
 * Root `package.json` therefore carries the placeholder `0.0.0-dev` rather than a release number.
 * It read `0.2.61` while published releases were at `0.2.73` (measured 2026-09-21), and since the
 * Dockerfile copies it into the image, that stale number was the only version a running container
 * had on disk. A placeholder cannot be mistaken for a release; a number that merely happens to be
 * old can. `scripts/__tests__/release-version-source.test.ts` fails if one is put back.
 *
 * `tauri.conf.json` and `Cargo.toml` still carry a real-looking number on purpose: the release
 * workflow overwrites both from the tag before bundling, and Windows MSI version parsing rejects a
 * pre-release suffix, so a `0.0.0-dev` placeholder there would break local desktop bundling.
 */

const fs = require('node:fs');
const { parseArgs: nodeParseArgs } = require('node:util');

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
// Null-prototype so inherited keys ('constructor', 'toString', ...) cannot pass the
// lookup guard below and yield an entry whose fields are undefined — which would publish
// a literal `:undefined` tag.
const ENVIRONMENTS = Object.assign(Object.create(null), {
  production: { channelTag: 'latest', portalRegistry: 'hub.ci.computer' },
  staging: { channelTag: 'staging', portalRegistry: 'portal.companionintel.com' },
  dev: { channelTag: 'dev', portalRegistry: 'hub.companionintelligence.com' },
});

/**
 * Strict `major.minor.patch` with an optional pre-release suffix.
 * Anchored so partial values like `0.2` or `latest` are rejected rather than silently
 * producing a tag nothing can pull.
 *
 * This is the semver.org reference grammar minus build metadata, so it accepts exactly what
 * `semver.valid()` does apart from `+`. That parity is load-bearing: the backend filters the
 * tag listing with `semver.valid(tag)` and, worse, `getTagsSince()` bails to `[]` the moment
 * the *running* version fails `semver.valid`. Publishing a looser tag like `01.2.45` would
 * therefore install and pull fine while permanently blinding that cohort to every future
 * update — the same silent, slow-to-diagnose shape as #920. Hence no leading zeros
 * (`01.2.3`) and no empty or zero-padded pre-release identifiers (`rc..1`, `rc.01`).
 *
 * Hand-rolled rather than using the workspace's `semver` dependency on purpose: this runs
 * from build-container.yml on the runner's preinstalled Node, before (and without) any
 * `pnpm install`, so the script must stay dependency-free. Do not "simplify" it to
 * `require('semver')` — the workflow would fail with MODULE_NOT_FOUND.
 */
// Build metadata (`+ci.7`) is deliberately NOT accepted even though semver allows it: `+` is
// illegal in a Docker tag ([A-Za-z0-9_][A-Za-z0-9._-]{0,127}), so allowing it would emit a
// reference that fails with "invalid reference format" at push time and again at every
// `docker compose pull`.
const NUMERIC_IDENTIFIER = String.raw`0|[1-9]\d*`;
const PRERELEASE_IDENTIFIER = String.raw`0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*`;
const SEMVER_PATTERN = new RegExp(
  `^(?:${NUMERIC_IDENTIFIER})\\.(?:${NUMERIC_IDENTIFIER})\\.(?:${NUMERIC_IDENTIFIER})` +
    `(?:-(?:${PRERELEASE_IDENTIFIER})(?:\\.(?:${PRERELEASE_IDENTIFIER}))*)?$`,
);

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
      `Release tag "${trimmed}" is not a publishable version (expected e.g. v0.2.45, 0.2.45, ` +
        'or 0.2.45-rc.1; build metadata like +ci.7 is not a legal Docker tag). ' +
        'Refusing to publish, because an unusable tag yields a release with no versioned image.',
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

/**
 * Parse `--environment <value> --tag <value>`.
 *
 * Uses Node's built-in parser (stdlib, so the dependency-free constraint holds) with
 * `strict`, so a typo'd flag is a hard error. A silently ignored `--enviroment` would fall
 * back to the dev default and publish no versioned image — the #920 failure mode.
 */
function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      environment: { type: 'string' },
      tag: { type: 'string' },
    },
    strict: true,
  });
  return values;
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
    // Set exitCode rather than calling process.exit(): writes to a pipe (which Actions
    // always attaches) are async, and exiting immediately can truncate the one message
    // that explains the failure.
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = { IMAGE_REPO, ENVIRONMENTS, normalizeVersion, resolveHubImageTags };
