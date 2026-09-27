/**
 * Seed a canonical prod (appliance) Hub install after a reset or first CLI start.
 *
 * Desktop normally writes `~/.local/share/companion-hub/{.env,.env.dev,docker-compose.prod.yml}`.
 * After a wipe, `cihub up prod` can do the same: copy the bundled compose file and write
 * a runtime env. The operator is prompted for POSTGRES_PASSWORD; other secrets are generated.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { BUNDLED_HUB_COMPOSE } from './bundled-hub-assets.generated.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { dockerBindMountPath } from '../heal-hub-bind-mounts';
import { packageVersion } from './cli-compose-env.js';
import { BASE_COMMAND } from './cli-types.js';
import { isVersionTag, normalizeVersion, parseImageTag } from './cli-version-skew.js';
import { compareCihubVersions } from './fleet-cihub-binary.js';

export const HUB_COMPOSE_FILENAME = 'docker-compose.prod.yml';
export const HUB_STACK_IMAGE_REPO = 'ghcr.io/companionintelligence/ci-hub';
export const MIN_POSTGRES_PASSWORD_LENGTH = 8;

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
  /** Tests only: stand in for the on-disk search, e.g. `() => undefined` for a headless box. */
  findCompose?: (execPath?: string) => string | undefined;
  /** Tests only: the environment the image is resolved from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Tests only: stand in for this machine's desktop package, desktop app, and cihub build. */
  imageHost?: ApplianceImageHost;
};

export type SeedApplianceResult = {
  dataDir: string;
  envFilePath: string;
  composePath: string;
  hubImage: string;
  /** Where `hubImage` came from, in words, for the line that reports the seed. */
  hubImageFrom: string;
  /** What the operator has to read before trusting `hubImage`; empty when nothing here disagrees with it. */
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

export function composeResourceCandidates(execPath: string = process.execPath): string[] {
  const execDir = path.dirname(execPath);
  const fromModule = (() => {
    try {
      return path.resolve(fileURLToPath(new URL('../../packages/desktop/src-tauri/resources/docker-compose.prod.yml', import.meta.url)));
    } catch {
      return undefined;
    }
  })();
  return [
    path.join(execDir, HUB_COMPOSE_FILENAME),
    path.join(execDir, 'resources', HUB_COMPOSE_FILENAME),
    path.join('/usr/lib/Companion Hub/resources', HUB_COMPOSE_FILENAME),
    path.join('/usr/lib/companion-hub/resources', HUB_COMPOSE_FILENAME),
    path.join('/usr/share/companion-hub', HUB_COMPOSE_FILENAME),
    ...(fromModule ? [fromModule] : []),
  ];
}

export const TRAEFIK_ASSETS_DIRNAME = 'traefik-assets';

/**
 * Same shape as {@link composeResourceCandidates}: a fresh `cihub up`/`cihub setup` on a
 * headless box (no CI-Hub checkout, no desktop package) has no `process.cwd()`-relative
 * monorepo path to read `packages/backend/assets/traefik/` from, so `initTraefik()` silently
 * warned and skipped `traefik.yml` — and, because it never got that far, never reached the
 * unconditional `acme_storage.json` write either. `traefik.yml` and `acme_storage.json`
 * missing from `docker-compose.prod.yml`'s bind mounts is what makes the `traefik` container
 * fail with "invalid mount config for type bind: bind source path does not exist" on every
 * first boot outside a checkout.
 */
export function traefikAssetsCandidates(execPath: string = process.execPath): string[] {
  const execDir = path.dirname(execPath);
  const fromModule = (() => {
    try {
      return path.resolve(fileURLToPath(new URL('../../packages/backend/assets/traefik', import.meta.url)));
    } catch {
      return undefined;
    }
  })();
  return [
    path.join(execDir, TRAEFIK_ASSETS_DIRNAME),
    path.join(execDir, 'resources', TRAEFIK_ASSETS_DIRNAME),
    path.join('/usr/lib/Companion Hub/resources', TRAEFIK_ASSETS_DIRNAME),
    path.join('/usr/lib/companion-hub/resources', TRAEFIK_ASSETS_DIRNAME),
    path.join('/usr/share/companion-hub', TRAEFIK_ASSETS_DIRNAME),
    path.join(process.cwd(), 'packages/backend/assets/traefik'),
    ...(fromModule ? [fromModule] : []),
  ];
}

export function findTraefikAssets(execPath: string = process.execPath): string | undefined {
  return traefikAssetsCandidates(execPath).find((candidate) => existsSync(candidate));
}

export function findBundledCompose(execPath: string = process.execPath): string | undefined {
  return composeResourceCandidates(execPath).find((candidate) => existsSync(candidate));
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

/** `environment`: CI_HUB_IMAGE was set on purpose. `desktop-package`: this cihub's own release, installed as the desktop app. */
export type HubImageSource = 'environment' | 'desktop-package' | 'default';

export type ResolvedApplianceHubImage = {
  image: string;
  version: string;
  source: HubImageSource;
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
export function describeHubImageSource(resolved: Pick<ResolvedApplianceHubImage, 'source' | 'version'>): string {
  if (resolved.source === 'environment') return 'set by CI_HUB_IMAGE';
  if (resolved.source === 'desktop-package') return `the companion-hub ${resolved.version} desktop package here, which is this cihub's release`;
  return 'the public release channel (CI_HUB_IMAGE is not set)';
}

/**
 * The Hub image a fresh install pins, where it came from, and what on this machine disagrees.
 *
 * In order: CI_HUB_IMAGE in the environment (a fleet roll, or an operator pinning on purpose); the
 * installed `companion-hub` desktop package, only when it is this cihub's own release; the public
 * `:latest`. Nothing else is read — not a CI-Hub checkout under the home directory, not an env file
 * left from an earlier install.
 *
 * The package is consulted because the CLI ships inside it (#1162), and the desktop app rewrites
 * CI_HUB_IMAGE to its own build on every start it makes; seeding that same build keeps the two from
 * fighting. But dpkg describes the package, not this binary, and following any installed package
 * pinned whatever release a node once had: the 2026-09-26 fleet rebuild, run with cihub 0.2.76,
 * started core-6 on ci-hub:0.2.70 and fzzy on ci-hub:0.2.61 — both older than the
 * /api/registration/phase route fleet install checks (#1484) — and said nothing about why. A package
 * at another release is now named and not followed.
 */
export function resolveApplianceHubImage(
  env: NodeJS.ProcessEnv = process.env,
  host: ApplianceImageHost = LIVE_APPLIANCE_IMAGE_HOST,
): ResolvedApplianceHubImage {
  const desktop = host.desktopPackageVersion()?.trim() || undefined;
  const cli = normalizeVersion(host.cliVersion());
  const pinned = env.CI_HUB_IMAGE?.trim();

  let resolved: Omit<ResolvedApplianceHubImage, 'warnings'>;
  const warnings: string[] = [];
  if (pinned) {
    resolved = { image: pinned, version: versionForPinnedImage(pinned), source: 'environment' };
  } else if (desktop && normalizeVersion(desktop) === cli) {
    resolved = { image: `${HUB_STACK_IMAGE_REPO}:${desktop}`, version: desktop, source: 'desktop-package' };
  } else {
    resolved = { image: `${HUB_STACK_IMAGE_REPO}:latest`, version: 'latest', source: 'default' };
    if (desktop) {
      warnings.push(
        `A companion-hub ${desktop} desktop package is installed here, but this cihub is ${cli}.`,
        `This install does not take the package's image (${HUB_STACK_IMAGE_REPO}:${desktop}); it pins ${resolved.image}.`,
        `To pin a release on purpose: CI_HUB_IMAGE=<ref> ${BASE_COMMAND} up. If nothing here uses the desktop app: sudo apt remove companion-hub`,
      );
    }
  }

  // A running desktop app is a second writer of the same env file, and it wins every start it makes:
  // on core-6 its watchdog saw the freshly seeded Hub down and started it itself eight seconds later.
  if (desktop && host.desktopAppRunning() && !desktopAppKeepsImage(resolved.image, desktop)) {
    warnings.push(
      `The companion-hub ${desktop} desktop app is running on this machine. When it finds the Hub down it starts the Hub itself,`,
      `and that start rewrites CI_HUB_IMAGE to ${HUB_STACK_IMAGE_REPO}:${desktop}, replacing ${resolved.image}.`,
      'Quit the desktop app, or update it to this release, before you rely on this install.',
    );
  }

  return { ...resolved, warnings };
}

export function renderApplianceEnvContent(input: {
  dataDir: string;
  postgresPassword: string;
  jwtSecret: string;
  rabbitmqPassword: string;
  hubImage: string;
  hubVersion: string;
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
    'DOMAIN=companionintelligence.com',
    'CI_CLOUD_URL=https://hub.ci.computer',
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
  const composeSource = options.composeSource || (options.findCompose ?? findBundledCompose)(options.execPath);
  if (options.composeSource && !existsSync(options.composeSource)) {
    throw new Error(`Could not find docker-compose.prod.yml at ${options.composeSource}.`);
  }

  for (const sub of APPLIANCE_SUBDIRS) {
    mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  const composePath = path.join(dataDir, HUB_COMPOSE_FILENAME);
  if (composeSource && existsSync(composeSource)) {
    copyFileSync(composeSource, composePath);
  } else {
    // No checkout, no desktop package, nothing next to the binary: a headless box. The compose is
    // baked into the CLI at build time (scripts/generate-bundled-hub-assets.ts) for exactly this
    // machine — which, on 2026-09-18, was twelve of fifteen fleet nodes.
    writeFileSync(composePath, BUNDLED_HUB_COMPOSE, 'utf8');
  }

  // An explicit `hubImage` is a pin like CI_HUB_IMAGE, and goes through the same resolver so the
  // desktop-app check still applies to it.
  const resolvedImage = resolveApplianceHubImage(
    options.hubImage ? { ...(options.env ?? process.env), CI_HUB_IMAGE: options.hubImage } : (options.env ?? process.env),
    options.imageHost,
  );
  const jwtSecret = options.jwtSecret || randomBytes(64).toString('hex');
  const rabbitmqPassword = options.rabbitmqPassword || randomBytes(32).toString('hex');
  const envContent = renderApplianceEnvContent({
    dataDir,
    postgresPassword: options.postgresPassword,
    jwtSecret,
    rabbitmqPassword,
    hubImage: resolvedImage.image,
    hubVersion: options.hubVersion || resolvedImage.version,
  });

  const primaryName = process.platform === 'win32' ? '.env' : '.env.dev';
  const compatName = process.platform === 'win32' ? '.env.dev' : '.env';
  const envFilePath = path.join(dataDir, primaryName);
  writeFileSync(envFilePath, envContent, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(path.join(dataDir, compatName), envContent, { encoding: 'utf8', mode: 0o600 });

  return {
    dataDir,
    envFilePath,
    composePath,
    hubImage: resolvedImage.image,
    hubImageFrom: describeHubImageSource(resolvedImage),
    warnings: resolvedImage.warnings,
  };
}
