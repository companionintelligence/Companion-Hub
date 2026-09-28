/**
 * Seed a canonical prod (appliance) Hub install after a reset or first CLI start.
 *
 * Desktop normally writes `~/.local/share/companion-hub/{.env,.env.dev,docker-compose.prod.yml}`.
 * After a wipe, `cihub up prod` can do the same: copy the bundled compose file and write
 * a runtime env. The operator is prompted for POSTGRES_PASSWORD; other secrets are generated.
 * The Hub pairs against production unless CI_CLOUD_URL names another Portal
 * (see {@link APPLIANCE_DEFAULT_CI_CLOUD_URL}).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BUNDLED_HUB_COMPOSE } from './bundled-hub-assets.generated.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { dockerBindMountPath } from '../heal-hub-bind-mounts';
import { packageVersion } from './cli-compose-env.js';
import { BASE_COMMAND } from './cli-types.js';
import { classifyCliInstall, isVersionTag, normalizeVersion, parseImageTag } from './cli-version-skew.js';
import { compareCihubVersions } from './fleet-cihub-binary.js';

export const HUB_COMPOSE_FILENAME = 'docker-compose.prod.yml';
export const HUB_STACK_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-hub';
export const MIN_POSTGRES_PASSWORD_LENGTH = 8;

/**
 * The Portal a fresh appliance pairs against when CI_CLOUD_URL does not name another: production.
 *
 * Deliberately not `CI_CLOUD_DEFAULT` (the dev tier), although that is this CLI's own default for
 * `login`, `register` and `catalog`. This seed writes the install a production desktop app writes
 * (`DEFAULT_PROD_CI_CLOUD_URL` in the desktop's hub_env.rs), and the image it pins by default is a
 * production release — `:<x.y.z>` and `:latest` are published only by production builds
 * (scripts/release/resolve-hub-image-tags.cjs). A customer's `cihub reset` + `cihub up` has landed
 * on production since #1162; following the CLI's default instead would pair that appliance with a
 * Portal whose database has never heard of their account, and nothing would say why until the code
 * came back 410. Choosing another Portal is a deliberate act: CI_CLOUD_URL in the environment, which
 * `cihub fleet install` sets to the Portal it minted the node's pairing code on.
 */
export const APPLIANCE_DEFAULT_CI_CLOUD_URL = 'https://hub.ci.computer';

const APPLIANCE_SUBDIRS = ['state', 'repos', 'apps', 'logs', 'media', 'user-config', 'app-data', 'backups', 'cache', '.internal', '.docker'] as const;

export type PasswordPrompt = (label: string) => Promise<string>;

export type ResolvePostgresPasswordOptions = {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  prompt?: PasswordPrompt;
};

export type SeedApplianceOptions = {
  dataDir: string;
  postgresPassword: string;
  jwtSecret?: string;
  rabbitmqPassword?: string;
  hubImage?: string;
  hubVersion?: string;
  composeSource?: string;
  execPath?: string;
  /** Tests only: replace the whole on-disk search and its checks, e.g. `() => undefined` for a headless box. */
  findCompose?: (execPath?: string) => string | undefined;
  /**
   * Tests only: the places the compose search looks, checked as the live search checks them. The live
   * list names the desktop package's directories under /usr/lib, which a test cannot write to.
   */
  composeCandidates?: HubResourceCandidate[];
  /** Tests only: the environment the image and Portal are resolved from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Tests only: stand in for this machine's desktop package, desktop app, and cihub build. */
  imageHost?: ApplianceImageHost;
};

export type SeedApplianceResult = {
  dataDir: string;
  envFilePath: string;
  composePath: string;
  /** Where the compose came from, in words, for the line that reports the seed. */
  composeFrom: string;
  hubImage: string;
  /** Where `hubImage` came from, in words, for the line that reports the seed. */
  hubImageFrom: string;
  /** The CI_CLOUD_URL written: the Portal this Hub pairs against. */
  portalUrl: string;
  /** Where `portalUrl` came from, in words, for the line that reports the seed. */
  portalUrlFrom: string;
  /** What the operator has to read before trusting this install; empty when nothing here disagrees with it. */
  warnings: string[];
};

export function validateSeedPassword(password: string, confirm?: string): string | null {
  if (!password || password.trim().length === 0) return 'Password is required.';
  if (password.length < MIN_POSTGRES_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_POSTGRES_PASSWORD_LENGTH} characters.`;
  }
  if (confirm !== undefined && password !== confirm) return 'Passwords do not match.';
  return null;
}

export function envPasswordFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CIHUB_POSTGRES_PASSWORD?.trim() || env.POSTGRES_PASSWORD?.trim();
  return value || undefined;
}

/** Hidden TTY prompt. Does not echo keystrokes. */
export function promptHiddenPassword(label: string, stdin = input, stdout = output): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      reject(new Error('A terminal is required to enter the password interactively.'));
      return;
    }
    const wasRaw = stdin.isRaw;
    stdout.write(label);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(Boolean(wasRaw));
    };
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function resolvePostgresPassword(options: ResolvePostgresPasswordOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const fromEnv = envPasswordFrom(env);
  if (fromEnv) {
    const error = validateSeedPassword(fromEnv);
    if (error) throw new Error(error);
    return fromEnv;
  }

  const isTty = options.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const prompt = options.prompt ?? promptHiddenPassword;
  if (!isTty) {
    throw new Error('Re-run in a terminal to set the password, or set POSTGRES_PASSWORD / CIHUB_POSTGRES_PASSWORD.');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const password = await prompt('Password: ');
    const confirm = await prompt('Confirm password: ');
    const error = validateSeedPassword(password, confirm);
    if (!error) return password;
    if (options.prompt) {
      // Tests inject a prompt — surface the validation error instead of looping forever.
      throw new Error(error);
    }
    process.stderr.write(`${error} Try again.\n`);
  }
  throw new Error('Password confirmation failed.');
}

/** The installed `companion-hub` desktop package's version (dpkg only). It describes the package, not this cihub. */
function installedCompanionHubVersion(): string | undefined {
  try {
    const dpkgVersionFormat = ['$', '{Version}'].join('');
    const version = execFileSync('dpkg-query', ['-W', '-f', dpkgVersionFormat, 'companion-hub'], { encoding: 'utf8' }).trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** True while a `companion-hub` desktop app runs on this machine, under any user. False wherever `pgrep` is missing. */
function companionHubDesktopRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', 'companion-hub'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * What the seed may learn about this machine when it picks an image. Injectable so a test never
 * reads the dpkg database or process table of whichever machine runs it.
 */
export type ApplianceImageHost = {
  /** Version of the installed `companion-hub` desktop package, or undefined when there is none. */
  desktopPackageVersion: () => string | undefined;
  /** True while the desktop app is running. */
  desktopAppRunning: () => boolean;
  /** The release this `cihub` was built as. */
  cliVersion: () => string;
};

export const LIVE_APPLIANCE_IMAGE_HOST: ApplianceImageHost = {
  desktopPackageVersion: installedCompanionHubVersion,
  desktopAppRunning: companionHubDesktopRunning,
  cliVersion: packageVersion,
};

/**
 * Where a Hub resource found on disk sits, which decides whether this `cihub` may use it (see
 * {@link untrustedHubResourceReason}).
 *
 * - `beside-binary`: next to the executable, or in its `resources/`. The desktop package ships its
 *   own `cihub` among its resources, so there the two are one artifact. Nothing installs these files
 *   beside a standalone `cihub`.
 * - `desktop-package`: the Linux desktop package's resource directories.
 * - `checkout`: the CI-Hub source this `cihub` runs from, or the checkout it is run inside.
 */
export type HubResourceOrigin = 'beside-binary' | 'desktop-package' | 'checkout';

export type HubResourceCandidate = { path: string; origin: HubResourceOrigin };

const DESKTOP_PACKAGE_RESOURCE_DIRS = ['/usr/lib/Companion Hub/resources', '/usr/lib/companion-hub/resources', '/usr/share/companion-hub'] as const;

/** A path in the checkout this module was loaded from. Inside a Bun-compiled binary it names nothing on disk. */
function checkoutPath(relative: string): string | undefined {
  try {
    return path.resolve(fileURLToPath(new URL(relative, import.meta.url)));
  } catch {
    return undefined;
  }
}

/** Every place a compose file for a fresh install may sit, in the order they are tried. */
export function composeResourceCandidateList(execPath: string = process.execPath): HubResourceCandidate[] {
  const execDir = path.dirname(execPath);
  const fromModule = checkoutPath('../../packages/desktop/src-tauri/resources/docker-compose.prod.yml');
  return [
    { path: path.join(execDir, HUB_COMPOSE_FILENAME), origin: 'beside-binary' },
    { path: path.join(execDir, 'resources', HUB_COMPOSE_FILENAME), origin: 'beside-binary' },
    ...DESKTOP_PACKAGE_RESOURCE_DIRS.map((dir): HubResourceCandidate => ({ path: path.join(dir, HUB_COMPOSE_FILENAME), origin: 'desktop-package' })),
    ...(fromModule ? [{ path: fromModule, origin: 'checkout' as const }] : []),
  ];
}

export function composeResourceCandidates(execPath: string = process.execPath): string[] {
  return composeResourceCandidateList(execPath).map((candidate) => candidate.path);
}

export const TRAEFIK_ASSETS_DIRNAME = 'traefik-assets';

/**
 * Same shape as {@link composeResourceCandidateList}: a fresh `cihub up`/`cihub setup` on a
 * headless box (no CI-Hub checkout, no desktop package) has no `process.cwd()`-relative
 * monorepo path to read `packages/backend/assets/traefik/` from, so `initTraefik()` silently
 * warned and skipped `traefik.yml` — and, because it never got that far, never reached the
 * unconditional `acme_storage.json` write either. `traefik.yml` and `acme_storage.json`
 * missing from `docker-compose.prod.yml`'s bind mounts is what makes the `traefik` container
 * fail with "invalid mount config for type bind: bind source path does not exist" on every
 * first boot outside a checkout. That box now gets the copies baked into the CLI instead.
 */
export function traefikAssetsCandidateList(execPath: string = process.execPath): HubResourceCandidate[] {
  const execDir = path.dirname(execPath);
  const fromModule = checkoutPath('../../packages/backend/assets/traefik');
  return [
    { path: path.join(execDir, TRAEFIK_ASSETS_DIRNAME), origin: 'beside-binary' },
    { path: path.join(execDir, 'resources', TRAEFIK_ASSETS_DIRNAME), origin: 'beside-binary' },
    ...DESKTOP_PACKAGE_RESOURCE_DIRS.map(
      (dir): HubResourceCandidate => ({ path: path.join(dir, TRAEFIK_ASSETS_DIRNAME), origin: 'desktop-package' }),
    ),
    { path: path.join(process.cwd(), 'packages/backend/assets/traefik'), origin: 'checkout' },
    ...(fromModule ? [{ path: fromModule, origin: 'checkout' as const }] : []),
  ];
}

export function traefikAssetsCandidates(execPath: string = process.execPath): string[] {
  return traefikAssetsCandidateList(execPath).map((candidate) => candidate.path);
}

/**
 * Why this `cihub` may not use a Hub resource found on disk, or null when it may.
 *
 * The same rule the image follows (see {@link resolveApplianceHubImage}): a file on disk is used only
 * when it is provably this `cihub`'s release. Anything else loses to the copy baked into this binary
 * (scripts/generate-bundled-hub-assets.ts), which is this release by construction. The search used to
 * take the first file that existed. On 2026-09-27, 16 of 17 fleet nodes had a v0.2.70 compose that
 * someone had left beside `/usr/local/bin/cihub` on 2026-09-18. Every rebuilt Hub came up on it,
 * without the ci_hub_internal and ci_hub_edge networks and with Postgres and RabbitMQ published on
 * 0.0.0.0. fzzy's 0.2.61 desktop package compose, next in line, also lacks the Tailscale mounts that
 * pool pairing needs.
 */
export function untrustedHubResourceReason(candidate: HubResourceCandidate, execPath: string, host: ApplianceImageHost): string | null {
  switch (candidate.origin) {
    case 'checkout':
      return null;
    case 'beside-binary':
      // The desktop package's `cihub` sits among the resources it shipped with, so the two are one release.
      return classifyCliInstall(execPath).kind === 'desktop'
        ? null
        : `it sits beside a standalone ${BASE_COMMAND}, where nothing installs one, so it was left there by hand or by an earlier install`;
    case 'desktop-package': {
      const desktop = host.desktopPackageVersion()?.trim();
      const cli = normalizeVersion(host.cliVersion());
      if (desktop && normalizeVersion(desktop) === cli) return null;
      return desktop
        ? `it belongs to the companion-hub ${desktop} desktop package, and this ${BASE_COMMAND} is ${cli}`
        : `no installed companion-hub package of this ${BASE_COMMAND}'s release (${cli}) owns it`;
    }
  }
}

export type PickedHubResource = {
  /** The first candidate this `cihub` may use, or undefined when the copy baked into the binary should be used. */
  path?: string;
  /** Candidates that exist but were passed over, with the reason. */
  ignored: (HubResourceCandidate & { why: string })[];
};

/**
 * The first candidate on disk that is this `cihub`'s own, plus what was passed over on the way.
 * `isHarmless` drops a passed-over file from `ignored` when it is the same as the baked-in copy.
 */
export function pickHubResource(
  candidates: HubResourceCandidate[],
  execPath: string,
  host: ApplianceImageHost,
  isHarmless?: (candidatePath: string) => boolean,
): PickedHubResource {
  const ignored: PickedHubResource['ignored'] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    const why = untrustedHubResourceReason(candidate, execPath, host);
    if (why === null) return { path: candidate.path, ignored };
    if (!isHarmless?.(candidate.path)) ignored.push({ ...candidate, why });
  }
  return { ignored };
}

/**
 * What the operator reads about a passed-over resource. A leftover beside the binary gets a removal
 * line because an older `cihub` on the same machine still takes it first.
 */
export function describeIgnoredHubResources(picked: PickedHubResource, what: string): string[] {
  if (picked.ignored.length === 0) return [];
  return [
    ...picked.ignored.map(({ path: ignoredPath, why }) => `Did not use ${ignoredPath}: ${why}.`),
    picked.path ? `Used ${picked.path} instead.` : `Used the ${what} built into this ${BASE_COMMAND} instead.`,
    ...picked.ignored
      .filter((candidate) => candidate.origin === 'beside-binary')
      .map(({ path: ignoredPath }) => `Nothing reads ${ignoredPath} now, but an older ${BASE_COMMAND} would. Remove it: sudo rm -r '${ignoredPath}'`),
  ];
}

function isBundledCompose(candidatePath: string): boolean {
  try {
    return readFileSync(candidatePath, 'utf8') === BUNDLED_HUB_COMPOSE;
  } catch {
    return false;
  }
}

/** The compose a fresh install copies, or undefined when it writes the one baked into this binary. */
export function pickApplianceCompose(execPath: string = process.execPath, host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST): PickedHubResource {
  return pickHubResource(composeResourceCandidateList(execPath), execPath, host, isBundledCompose);
}

/** The Traefik assets directory `initTraefik` copies from, or undefined when it writes the ones baked into this binary. */
export function pickTraefikAssets(execPath: string = process.execPath, host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST): PickedHubResource {
  return pickHubResource(traefikAssetsCandidateList(execPath), execPath, host);
}

export function findTraefikAssets(execPath: string = process.execPath, host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST): string | undefined {
  return pickTraefikAssets(execPath, host).path;
}

export function findBundledCompose(execPath: string = process.execPath, host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST): string | undefined {
  return pickApplianceCompose(execPath, host).path;
}

/**
 * `environment`: CI_HUB_IMAGE was set on purpose. `desktop-package`: this cihub's own release, installed
 * as the desktop app. `cli-release`: this cihub's own release, with no package. `default`: `:latest`,
 * for a build that has no published image of its own.
 */
export type HubImageSource = 'environment' | 'desktop-package' | 'cli-release' | 'default';

export type ResolvedApplianceHubImage = {
  image: string;
  version: string;
  source: HubImageSource;
  /** This cihub's release, normalized, which is what `default` has to explain it is not. */
  cli: string;
  /** Lines the operator has to read before trusting `image`; empty when nothing here disagrees with it. */
  warnings: string[];
};

/** `repo@sha256:<64 hex>` is a pin, not a version: the 64 hex characters after the last colon ended up as CI_HUB_VERSION on every digest-pinned node. */
function versionForPinnedImage(pinned: string): string {
  const at = pinned.indexOf('@sha256:');
  if (at >= 0) return `digest-${pinned.slice(at + '@sha256:'.length, at + '@sha256:'.length + 12)}`;
  const tag = pinned.includes(':') ? pinned.slice(pinned.lastIndexOf(':') + 1) : 'latest';
  return tag || 'latest';
}

/**
 * Whether `ci-hub:<version>` is an image the release pipeline publishes: a plain `x.y.z`, which a
 * production Desktop Release pushes and its verify-anonymous-pull gate checks (build-container.yml).
 *
 * A pre-release suffix is left out on purpose. The fleet's `0.2.76-trial.1c9003d68` has that shape
 * and no image, and nothing here can tell it from a published `-rc.1`. `0.0.0-dev` is a source run.
 * No workflow publishes an image per commit, so builds like these have nothing of their own to pin.
 */
export function isPublishedReleaseVersion(version: string): boolean {
  const normalized = normalizeVersion(version);
  return isVersionTag(normalized) && !normalized.includes('-') && normalized !== '0.0.0';
}

/**
 * Whether a desktop app built as `desktopVersion` keeps `image` when it next starts the Hub.
 *
 * Mirrors `resolve_runtime_hub_image_for` in the desktop's `hub_env.rs`: every start it makes
 * re-renders the env file, and the only pin it carries forward is a release tag of the public repo
 * newer than its own build. `:latest`, `:dev`, a digest, or an older release all become the
 * desktop's own `ci-hub:<desktopVersion>`.
 */
function desktopAppKeepsImage(image: string, desktopVersion: string): boolean {
  const { repository, tag, digest } = parseImageTag(image);
  if (repository !== HUB_STACK_IMAGE_REPO || digest || !tag || !isVersionTag(tag)) return false;
  // Its own build is not "kept" but re-rendered as the same reference, which comes to the same thing.
  return normalizeVersion(tag) === normalizeVersion(desktopVersion) || compareCihubVersions(tag, desktopVersion) > 0;
}

/** Where a seeded image came from, for the line that reports the seed. */
export function describeHubImageSource(resolved: Pick<ResolvedApplianceHubImage, 'source' | 'version'> & { cli?: string }): string {
  if (resolved.source === 'environment') return 'set by CI_HUB_IMAGE';
  if (resolved.source === 'desktop-package') return `the companion-hub ${resolved.version} desktop package here, which is this cihub's release`;
  if (resolved.source === 'cli-release') return `this ${BASE_COMMAND}'s own release (CI_HUB_IMAGE is not set)`;
  if (!resolved.cli) return 'the public release channel (CI_HUB_IMAGE is not set)';
  // Said in the report rather than warned about: every dev and trial build lands here, and the fleet
  // hand-pinned each node after a trial-build install without the seed ever saying the Hub was not it.
  return (
    `the public release channel (CI_HUB_IMAGE is not set). This ${BASE_COMMAND} is ${resolved.cli}, which has no published image, ` +
    `so the Hub runs the newest release and not this build. To run this build's image: CI_HUB_IMAGE=<ref> ${BASE_COMMAND} up`
  );
}

/**
 * The Hub image a fresh install pins, where it came from, and what on this machine disagrees.
 *
 * In order: CI_HUB_IMAGE in the environment (a fleet roll, or an operator pinning on purpose); the
 * installed `companion-hub` desktop package, only when it is this cihub's own release; this cihub's
 * own release, when the pipeline publishes an image for it; the public `:latest`. Nothing else is
 * read — not a CI-Hub checkout under the home directory, not an env file left from an earlier install.
 *
 * The package is consulted because the CLI ships inside it (#1162), and the desktop app rewrites
 * CI_HUB_IMAGE to its own build on every start it makes; seeding that same build keeps the two from
 * fighting. But dpkg describes the package, not this binary, and following any installed package
 * pinned whatever release a node once had: the 2026-09-26 fleet rebuild, run with cihub 0.2.76,
 * started core-6 on ci-hub:0.2.70 and fzzy on ci-hub:0.2.61 — both older than the
 * /api/registration/phase route fleet install checks (#1484) — and said nothing about why. A package
 * at another release is now named and not followed.
 *
 * A release cihub pins its own release rather than `:latest`, for two reasons. The compose this seed
 * writes is that release's (see {@link pickApplianceCompose}), and a floating tag lets the image move
 * away from it. And an older desktop app discards `:latest` on its next Hub start but keeps a newer
 * release tag, so on core-6 only the exact pin survives the 0.2.70 app that is still running there.
 */
export function resolveApplianceHubImage(
  env: NodeJS.ProcessEnv = process.env,
  host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST,
): ResolvedApplianceHubImage {
  const desktop = host.desktopPackageVersion()?.trim() || undefined;
  const cli = normalizeVersion(host.cliVersion());
  const pinned = env.CI_HUB_IMAGE?.trim();
  const desktopRunning = desktop ? host.desktopAppRunning() : false;

  let resolved: Omit<ResolvedApplianceHubImage, 'warnings' | 'cli'>;
  const warnings: string[] = [];
  if (pinned) {
    resolved = { image: pinned, version: versionForPinnedImage(pinned), source: 'environment' };
  } else if (desktop && normalizeVersion(desktop) === cli) {
    resolved = { image: `${HUB_STACK_IMAGE_REPO}:${desktop}`, version: desktop, source: 'desktop-package' };
  } else if (isPublishedReleaseVersion(cli)) {
    resolved = { image: `${HUB_STACK_IMAGE_REPO}:${cli}`, version: cli, source: 'cli-release' };
  } else {
    resolved = { image: `${HUB_STACK_IMAGE_REPO}:latest`, version: 'latest', source: 'default' };
  }

  if (!pinned && desktop && resolved.source !== 'desktop-package') {
    warnings.push(
      `A companion-hub ${desktop} desktop package is installed here, but this ${BASE_COMMAND} is ${cli}.`,
      `This install takes neither the package's image (${HUB_STACK_IMAGE_REPO}:${desktop}) nor its compose; it pins ${resolved.image}.`,
    );
    // Not running now is not the same as never running. fzzy's 0.2.61 app was idle, and the first Hub
    // start it makes would swap in its own build on a database a newer Hub has already migrated.
    if (!desktopRunning && !desktopAppKeepsImage(resolved.image, desktop)) {
      warnings.push(
        `If that desktop app is started, its first Hub start rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:${desktop} and recreates the Hub on it.`,
        'If that build is older than this one, it starts on a database the newer Hub may already have migrated.',
      );
    }
    warnings.push(
      `To pin a release on purpose: CI_HUB_IMAGE=<ref> ${BASE_COMMAND} up. If nothing here uses the desktop app: sudo apt remove companion-hub`,
    );
  }

  // A running desktop app is a second writer of the same env file, and it wins every start it makes:
  // on core-6 its watchdog saw the freshly seeded Hub down and started it itself eight seconds later.
  if (desktop && desktopRunning && !desktopAppKeepsImage(resolved.image, desktop)) {
    warnings.push(
      `The companion-hub ${desktop} desktop app is running on this machine. When it finds the Hub down it starts the Hub itself,`,
      `and that start rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:${desktop}, replacing ${resolved.image}.`,
      'Quit the desktop app, or update it to this release, before you rely on this install.',
    );
  }

  return { ...resolved, cli, warnings };
}

/** Loopback hosts, matching `is_loopback_portal_host` in the desktop and `isLoopbackPortalHost` in the backend. */
function isLoopbackPortalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * `value` as a Portal origin (`https://host[:port]`, no trailing slash), or why it cannot be one.
 *
 * The rules the desktop applies to its Portal URL override (`validate_portal_url_override` in
 * portal_url.rs), because the value lands in the same env file and is read the same way. The backend
 * appends `/api/...` to it and app OIDC injection uses it as the token issuer, so a path, query or
 * fragment is refused rather than cut. Docker compose interpolates `$` when it reads the file, so the
 * host must be a plain DNS name or an IP. And plain http is accepted only for a Portal on this
 * machine, since the Hub sends its device key there. Trailing slashes are dropped first:
 * `https://host/` is the same Portal, and the fleet check compares origins without them.
 */
export function validatePortalOrigin(value: string): { origin: string } | { why: string } {
  let parsed: URL;
  try {
    parsed = new URL(value.trim().replace(/\/+$/, ''));
  } catch {
    return { why: 'it is not an absolute URL (expected e.g. https://hub.companionintelligence.com)' };
  }
  const host = parsed.hostname;
  if (!host) return { why: 'it has no host' };
  // `[…]` is an IPv6 literal the parser has already validated; anything else must be DNS labels
  // (IPv4 included), which rules out the `$`, `{` and quotes the URL parser lets into a host.
  if (!host.startsWith('[') && !host.split('.').every((label) => /^[a-z0-9_-]+$/i.test(label))) {
    return { why: 'its host is not a DNS name (letters, digits, hyphens, and dots, with no trailing dot)' };
  }
  if (parsed.protocol === 'http:' && !isLoopbackPortalHost(host)) {
    return { why: 'it must use https; plain http is accepted only for localhost' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { why: `it must use https, not ${parsed.protocol.replace(/:$/, '')}` };
  }
  if (parsed.username || parsed.password) return { why: 'it must not contain credentials' };
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { why: 'it must be a bare origin with no path, query, or fragment' };
  }
  return { origin: parsed.origin };
}

export type ResolvedAppliancePortal = {
  /** The CI_CLOUD_URL to write. */
  url: string;
  /** `environment`: CI_CLOUD_URL named it. `default`: {@link APPLIANCE_DEFAULT_CI_CLOUD_URL}. */
  source: 'environment' | 'default';
  /** Set when CI_CLOUD_URL held something that is not a Portal origin, which the seed then ignored. */
  rejected?: { value: string; why: string };
};

/**
 * The Portal a fresh install pairs against: CI_CLOUD_URL from the environment when it is a usable
 * origin, else {@link APPLIANCE_DEFAULT_CI_CLOUD_URL}.
 *
 * Read only here, when there is no complete install (an env file and its compose). An installed Hub's
 * CI_CLOUD_URL is never rewritten from the environment — `cihub up` on a seeded appliance does not
 * come through this file, and the appliance compose does not interpolate CI_CLOUD_URL from the shell
 * — so exporting it can choose a new Hub's Portal and cannot move an old one.
 *
 * An unusable value is ignored and the default kept, as the desktop does with a refused override:
 * failing here would leave no install at all half-way through `cihub up`, and the operator gets the
 * reason in the seed's warnings.
 */
export function resolveAppliancePortalUrl(env: NodeJS.ProcessEnv = process.env): ResolvedAppliancePortal {
  const raw = env.CI_CLOUD_URL?.trim();
  if (!raw) return { url: APPLIANCE_DEFAULT_CI_CLOUD_URL, source: 'default' };
  const checked = validatePortalOrigin(raw);
  if ('origin' in checked) return { url: checked.origin, source: 'environment' };
  return { url: APPLIANCE_DEFAULT_CI_CLOUD_URL, source: 'default', rejected: { value: raw, why: checked.why } };
}

/** Where a seeded Portal came from, for the line that reports the seed. */
export function describeAppliancePortalSource(resolved: ResolvedAppliancePortal): string {
  if (resolved.source === 'environment') return 'set by CI_CLOUD_URL';
  if (resolved.rejected) return 'the default for a new appliance, production, because CI_CLOUD_URL was not usable';
  return 'the default for a new appliance, production (CI_CLOUD_URL is not set)';
}

/** What the operator reads when CI_CLOUD_URL was ignored; empty when it was not. */
function describeRejectedPortal(resolved: ResolvedAppliancePortal, envFiles: string[]): string[] {
  if (!resolved.rejected) return [];
  // A URL with a password in it is not echoed back into a terminal, or a fleet run's log.
  const shown = resolved.rejected.why.includes('credentials') ? 'a URL with credentials in it' : resolved.rejected.value;
  return [
    `Ignored CI_CLOUD_URL=${shown}: ${resolved.rejected.why}.`,
    `This Hub pairs against ${resolved.url}, and a pairing code minted on any other Portal is refused 410.`,
    `To pair it with another Portal, set CI_CLOUD_URL to that Portal's bare origin (e.g. https://hub.companionintelligence.com) in ${envFiles.join(' and ')} before ${BASE_COMMAND} register.`,
  ];
}

export function renderApplianceEnvContent(input: {
  dataDir: string;
  postgresPassword: string;
  jwtSecret: string;
  rabbitmqPassword: string;
  hubImage: string;
  hubVersion: string;
  /** The Portal this Hub pairs against (default {@link APPLIANCE_DEFAULT_CI_CLOUD_URL}); see {@link resolveAppliancePortalUrl}. */
  ciCloudUrl?: string;
}): string {
  const rootFolderHost = dockerBindMountPath(input.dataDir);
  const composeFileHost = dockerBindMountPath(path.join(input.dataDir, HUB_COMPOSE_FILENAME));
  const dockerPlatform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  const dockerSocketPath = dockerBindMountPath(process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock');
  return [
    '# Preserved (generated once, survive upgrades)',
    `ROOT_FOLDER_HOST=${rootFolderHost}`,
    `JWT_SECRET=${input.jwtSecret}`,
    `POSTGRES_PASSWORD=${input.postgresPassword}`,
    `RABBITMQ_PASSWORD=${input.rabbitmqPassword}`,
    '',
    '# Derived (recomputed for this CLI seed)',
    'INTERNAL_IP=0.0.0.0',
    // A placeholder, the same for every Portal: the desktop's dev and prod builds both start from
    // companionintelligence.com, and registration replaces it with the zone Portal assigns this
    // organization (ConfigurationService.setDomain, from registration.service). Deriving it from the
    // Portal would only be a second guess at what registration is about to write anyway.
    'DOMAIN=companionintelligence.com',
    `CI_CLOUD_URL=${input.ciCloudUrl ?? APPLIANCE_DEFAULT_CI_CLOUD_URL}`,
    `CI_HUB_VERSION=${input.hubVersion}`,
    `CI_HUB_IMAGE=${input.hubImage}`,
    `COMPOSE_FILE_HOST=${composeFileHost}`,
    `DOCKER_PLATFORM=${dockerPlatform}`,
    `DOCKER_SOCKET_PATH=${dockerSocketPath}`,
    `ENV_FILE=${process.platform === 'win32' ? '.env' : '.env.dev'}`,
    '',
  ].join('\n');
}

export function seedApplianceInstall(options: SeedApplianceOptions): SeedApplianceResult {
  const dataDir = path.resolve(options.dataDir);
  const execPath = options.execPath ?? process.execPath;
  const host = options.imageHost ?? LIVE_APPLIANCE_IMAGE_HOST;
  if (options.composeSource && !existsSync(options.composeSource)) {
    throw new Error(`Could not find docker-compose.prod.yml at ${options.composeSource}.`);
  }
  // An explicit source is the caller's choice and is taken as given. The search takes a file on disk
  // only when it is this cihub's release; see untrustedHubResourceReason.
  const compose: PickedHubResource = options.composeSource
    ? { path: options.composeSource, ignored: [] }
    : options.findCompose
      ? { path: options.findCompose(options.execPath), ignored: [] }
      : pickHubResource(options.composeCandidates ?? composeResourceCandidateList(execPath), execPath, host, isBundledCompose);

  for (const sub of APPLIANCE_SUBDIRS) {
    mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  const composePath = path.join(dataDir, HUB_COMPOSE_FILENAME);
  let composeFrom: string;
  if (compose.path && existsSync(compose.path)) {
    copyFileSync(compose.path, composePath);
    composeFrom = compose.path;
  } else {
    // The compose baked into the CLI at build time (scripts/generate-bundled-hub-assets.ts): this
    // release's by construction. First written for a headless box with nothing on disk — twelve of
    // fifteen fleet nodes on 2026-09-18 — and now also what replaces a file on disk that is not this
    // cihub's.
    writeFileSync(composePath, BUNDLED_HUB_COMPOSE, 'utf8');
    composeFrom = `the compose built into this ${BASE_COMMAND}`;
  }

  // An explicit `hubImage` is a pin like CI_HUB_IMAGE, and goes through the same resolver so the
  // desktop-app check still applies to it.
  const resolvedImage = resolveApplianceHubImage(
    options.hubImage ? { ...(options.env ?? process.env), CI_HUB_IMAGE: options.hubImage } : (options.env ?? process.env),
    host,
  );
  // Until 2026-09-28 this was always production, whatever the operator asked for. Rebuilding sixteen
  // wiped nodes against the dev Portal that day, `cihub fleet install` could not bring up a single
  // fresh one: each stopped with portal-mismatch straight after `cihub up`, because the seed had just
  // written the one Portal the node's code could never be redeemed on.
  const portal = resolveAppliancePortalUrl(options.env ?? process.env);
  const jwtSecret = options.jwtSecret || randomBytes(64).toString('hex');
  const rabbitmqPassword = options.rabbitmqPassword || randomBytes(32).toString('hex');
  const envContent = renderApplianceEnvContent({
    dataDir,
    postgresPassword: options.postgresPassword,
    jwtSecret,
    rabbitmqPassword,
    hubImage: resolvedImage.image,
    hubVersion: options.hubVersion || resolvedImage.version,
    ciCloudUrl: portal.url,
  });

  const primaryName = process.platform === 'win32' ? '.env' : '.env.dev';
  const compatName = process.platform === 'win32' ? '.env.dev' : '.env';
  const envFilePath = path.join(dataDir, primaryName);
  const compatPath = path.join(dataDir, compatName);
  writeFileSync(envFilePath, envContent, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(compatPath, envContent, { encoding: 'utf8', mode: 0o600 });

  return {
    dataDir,
    envFilePath,
    composePath,
    composeFrom,
    hubImage: resolvedImage.image,
    hubImageFrom: describeHubImageSource(resolvedImage),
    portalUrl: portal.url,
    portalUrlFrom: describeAppliancePortalSource(portal),
    warnings: [
      ...describeRejectedPortal(portal, [envFilePath, compatPath]),
      ...resolvedImage.warnings,
      ...describeIgnoredHubResources(compose, 'compose'),
    ],
  };
}
