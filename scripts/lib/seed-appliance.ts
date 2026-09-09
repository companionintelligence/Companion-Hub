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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { dockerBindMountPath } from '../heal-hub-bind-mounts';

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
};

export type SeedApplianceResult = {
  dataDir: string;
  envFilePath: string;
  composePath: string;
  hubImage: string;
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

function installedCompanionHubVersion(): string | undefined {
  try {
    const dpkgVersionFormat = ['$', '{Version}'].join('');
    const version = execFileSync('dpkg-query', ['-W', '-f', dpkgVersionFormat, 'companion-hub'], { encoding: 'utf8' }).trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export function resolveApplianceHubImage(env: NodeJS.ProcessEnv = process.env): { image: string; version: string } {
  const pinned = env.CI_HUB_IMAGE?.trim();
  if (pinned) {
    const tag = pinned.includes(':') ? pinned.slice(pinned.lastIndexOf(':') + 1) : 'latest';
    return { image: pinned, version: tag || 'latest' };
  }
  const installed = installedCompanionHubVersion();
  if (installed) {
    return { image: `${HUB_STACK_IMAGE_REPO}:${installed}`, version: installed };
  }
  return { image: `${HUB_STACK_IMAGE_REPO}:latest`, version: 'latest' };
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
  const composeSource = options.composeSource || findBundledCompose(options.execPath);
  if (!composeSource || !existsSync(composeSource)) {
    throw new Error('Could not find docker-compose.prod.yml. Install the Companion Hub desktop package, or run cihub from a CI-Hub checkout.');
  }

  for (const sub of APPLIANCE_SUBDIRS) {
    mkdirSync(path.join(dataDir, sub), { recursive: true });
  }

  const composePath = path.join(dataDir, HUB_COMPOSE_FILENAME);
  copyFileSync(composeSource, composePath);

  const resolvedImage = options.hubImage
    ? { image: options.hubImage, version: options.hubVersion || options.hubImage.split(':').pop() || 'latest' }
    : resolveApplianceHubImage();
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

  return { dataDir, envFilePath, composePath, hubImage: resolvedImage.image };
}
