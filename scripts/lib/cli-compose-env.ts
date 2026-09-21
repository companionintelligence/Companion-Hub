import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { parseEnvFile } from '../env-file.js';
import { resolveRootFolderHost } from './paths.js';
import { CI_CLOUD_DEFAULT, LOCAL_DEV_BACKEND_PORT, LOCAL_DEV_FRONTEND_PORT, type HubEnv } from './cli-types.js';
import { bold } from './cli-ui.js';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

declare const CIHUB_BUILD_VERSION: string | undefined;

/**
 * The version of THIS `cihub` binary.
 *
 * The release pipeline is the source of truth, not `package.json`. `scripts/build-standalone-cli.cjs`
 * bakes the release tag in as `CIHUB_BUILD_VERSION` at compile time (fed from `CI_HUB_BUILD_VERSION`,
 * which desktop-release.yml sets from `inputs.tag`), so a shipped binary reports the release it was
 * cut from. `package.json` is deliberately NOT bumped per release and carries the placeholder
 * `0.0.0-dev` — see the "Where the release version comes from" note in
 * `scripts/release/resolve-hub-image-tags.cjs`, enforced by
 * `scripts/__tests__/release-version-source.test.ts`, which fails if a real-looking release number
 * is hand-edited back into it.
 *
 * Reaching the fallback therefore means "running from a source checkout", and the placeholder says
 * exactly that. It used to read `0.2.61` while releases were at `0.2.73`, which said the opposite.
 */
export function packageVersion(): string {
  const buildVersion = typeof CIHUB_BUILD_VERSION === 'string' ? CIHUB_BUILD_VERSION.trim() : '';
  const runtimeOverride = process.env.CIHUB_BUILD_VERSION?.trim() || '';
  if (buildVersion) return buildVersion;
  if (runtimeOverride) return runtimeOverride;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const envFileMap: Record<HubEnv, string> = {
  local: '.env.local',
  dev: '.env.dev',
  staging: '.env.staging',
  prod: '.env.prod',
};

export function getEnvFileOrExit(env: string): string {
  const f = envFileMap[env as HubEnv];
  if (!f) {
    console.error(`Unknown environment: ${env}`);
    process.exit(2);
  }
  return f;
}

function envFileHasCiHubImage(envFileName: string): boolean {
  try {
    const envPath = path.isAbsolute(envFileName) ? envFileName : join(process.cwd(), envFileName);
    if (!existsSync(envPath)) return false;
    const vars = parseEnvFile(envPath);
    return Boolean(vars.CI_HUB_IMAGE?.trim());
  } catch {
    return false;
  }
}

export function getComposeFiles(env: HubEnv): string[] {
  if (env === 'local') return ['docker-compose.local.yml'];
  const files = env === 'staging' ? ['docker-compose.prod.yml', 'docker-compose.staging.yml'] : ['docker-compose.prod.yml'];
  if (envFileHasCiHubImage(envFileMap[env])) {
    files.push('docker-compose.dev-image.yml');
  }
  return files;
}

/** Canonical compose bind: `<ROOT_FOLDER_HOST>/../tunnel/token`. */
export function tunnelTokenPath(envFileName: string): string {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  return path.resolve(rootFolderHost, '..', 'tunnel', 'token');
}

/**
 * Non-secret marker the Hub backend writes into its tunnel dir whenever it holds a Portal
 * registration, and deletes on every registration reset.
 */
export const TUNNEL_REGISTRATION_MARKER = 'registration.json';

/** Tunnel dirs for a Hub data dir: canonical sibling `../tunnel` first, then the legacy nested `tunnel`. */
function tunnelDirsForDataDir(dataDir: string): string[] {
  return [path.resolve(dataDir, '..', 'tunnel'), path.join(dataDir, 'tunnel')];
}

function isNonEmptyTokenFile(tokenPath: string): boolean {
  try {
    const stats = statSync(tokenPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Native host path for a `ROOT_FOLDER_HOST` value. On Windows the desktop app writes it in Docker's
 * form, `/c/Users/...` (Docker Desktop) or `/mnt/c/Users/...` (a WSL2 engine), which Node would
 * resolve against the current drive (`C:\c\Users\...`), so the tunnel files beside the data dir
 * would never be found. Mirrors `host_path_from_docker_path` in the desktop app.
 */
export function hostPathFromDockerPath(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return value;
  const [, drive, rest = ''] = /^\/(?:mnt\/)?([a-zA-Z])(?:\/(.*))?$/.exec(value.trim().replace(/\\/g, '/')) ?? [];
  if (!drive) return value;
  return `${drive.toUpperCase()}:\\${rest.replace(/^\/+/, '').replace(/\//g, '\\')}`;
}

/** Hub data dir named by an env file, in the form this platform's filesystem calls accept. */
function hostDataDirForEnvFile(envFileName: string): string {
  return hostPathFromDockerPath(resolveRootFolderHost(envFileName));
}

/** True when a non-empty tunnel token exists at the sibling compose path or the legacy nested path. */
export function hasCloudflareTunnelTokenAtDataDir(dataDir: string): boolean {
  return tunnelDirsForDataDir(dataDir).some((dir) => isNonEmptyTokenFile(path.join(dir, 'token')));
}

/** Same rules as {@link hasCloudflareTunnelTokenAtDataDir}, resolving the data dir from an env file. */
export function hasCloudflareTunnelToken(envFileName: string): boolean {
  return hasCloudflareTunnelTokenAtDataDir(hostDataDirForEnvFile(envFileName));
}

/**
 * True when the tunnel token belongs to a registered Hub: one tunnel dir (sibling first, then
 * legacy nested) holds both a non-empty `token` and `registration.json`. A token without the
 * marker is left over from an uninstalled or reset Hub and must not start `cloudflared`.
 * Must match `registered_tunnel_present_for_data_dir` in the desktop app.
 */
export function hasRegisteredCloudflareTunnelAtDataDir(dataDir: string): boolean {
  return tunnelDirsForDataDir(dataDir).some(
    (dir) => isNonEmptyTokenFile(path.join(dir, 'token')) && isRegularFile(path.join(dir, TUNNEL_REGISTRATION_MARKER)),
  );
}

/** Same rules as {@link hasRegisteredCloudflareTunnelAtDataDir}, resolving the data dir from an env file. */
export function hasRegisteredCloudflareTunnel(envFileName: string): boolean {
  return hasRegisteredCloudflareTunnelAtDataDir(hostDataDirForEnvFile(envFileName));
}

function hasTailscaleAuthKey(vars: Record<string, string>): boolean {
  return Boolean(vars.TAILSCALE_AUTHKEY?.trim() || vars.HEADSCALE_PREAUTH_KEY?.trim());
}

/**
 * Whether a `tailscaled.state` file holds a login, not just a machine key.
 *
 * tailscaled writes `_machinekey` the moment it starts, before any login, and keeps it after a
 * logout — so a non-empty file is not evidence of anything. A node that is (or was) logged in
 * carries `_current-profile` pointing at a `profile-<id>` entry. Checking size alone is what kept
 * `private-vpn` switched on for a sidecar that had no auth key and a 119-byte logged-out state:
 * every `cihub up` re-enabled it, and it then crash-looped once a minute against the control
 * plane (beta-max, 2026-09-15).
 */
export function tailscaledStateLooksLoggedIn(raw: string): boolean {
  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    const current = state['_current-profile'];
    return typeof current === 'string' && current.length > 0;
  } catch {
    return false;
  }
}

/** Best-effort: Tailscale login already persisted in the named Docker volume. */
function probeTailscalePersistedState(): boolean {
  try {
    const result = spawnSync(
      'docker',
      ['run', '--rm', '-v', 'hub_tailscale_state:/state:ro', 'alpine:3.21', 'sh', '-c', 'cat /state/tailscaled.state 2>/dev/null'],
      { encoding: 'utf-8' },
    );
    return result.status === 0 && tailscaledStateLooksLoggedIn(result.stdout ?? '');
  } catch {
    return false;
  }
}

/** Test override so unit tests do not depend on a real `hub_tailscale_state` volume. */
let tailscalePersistedStateProbe: () => boolean = probeTailscalePersistedState;

export function setTailscalePersistedStateProbeForTests(probe: (() => boolean) | null): void {
  tailscalePersistedStateProbe = probe ?? probeTailscalePersistedState;
}

function hasTailscalePersistedState(): boolean {
  return tailscalePersistedStateProbe();
}

function privateVpnShouldRun(vars: Record<string, string>): boolean {
  if (vars.PRIVATE_VPN_USER_DISABLED === 'true') return false;
  return hasTailscaleAuthKey(vars) || hasTailscalePersistedState();
}

/**
 * The `cloudflare` profile follows registration, like `private-vpn` follows its credentials: added
 * for a registered Hub, dropped otherwise — including when the env file or shell still names it
 * from a launch before an uninstall or reset. A registered Hub whose backend has not written the
 * marker yet keeps its tunnel: the backend starts `cloudflared` itself with `--profile cloudflare`.
 */
function applyCloudflareProfile(profiles: Set<string>, envFileName: string): void {
  if (hasRegisteredCloudflareTunnel(envFileName)) profiles.add('cloudflare');
  else profiles.delete('cloudflare');
}

export function mergeComposeProfilesFromEnvFile(envFileName: string): string {
  const vars = parseEnvFile(envFileName);
  const hasEnvFile = Object.keys(vars).length > 0;
  if (!hasEnvFile) {
    const set = new Set(
      (process.env.COMPOSE_PROFILES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    // No env file yet — only enable Private VPN when the process env already has a key.
    if (hasTailscaleAuthKey(process.env as Record<string, string>) || hasTailscalePersistedState()) {
      set.add('private-vpn');
    }
    applyCloudflareProfile(set, envFileName);
    return [...set].join(',');
  }
  const vpnOn = privateVpnShouldRun(vars);
  const set = new Set<string>([
    ...(vars.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(process.env.COMPOSE_PROFILES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]);
  if (vpnOn) set.add('private-vpn');
  else set.delete('private-vpn');
  applyCloudflareProfile(set, envFileName);
  return [...set].join(',');
}

export function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const fileVars = parseEnvFile(envFileName);
  const resolvedHubVersion = (process.env.CI_HUB_VERSION || fileVars.CI_HUB_VERSION || packageVersion()).trim();
  const overrides: Record<string, string | undefined> = {
    ENV_FILE: envFileName,
    // Always set, even when empty: Compose falls back to `COMPOSE_PROFILES` from `--env-file` when
    // the process env leaves it unset, which would revive a `cloudflare` or `private-vpn` profile
    // the merge above dropped (an env file written while the Hub was still registered).
    COMPOSE_PROFILES: composeProfiles,
  };
  if (resolvedHubVersion) overrides.CI_HUB_VERSION = resolvedHubVersion;

  // Identity comes from init:host / the env file (e.g. UID 0 on Docker Desktop). Never
  // replace with getuid() here \u2014 shell env wins over --env-file for compose interpolation.
  if (fileVars.CI_HUB_CONTAINER_UID) overrides.CI_HUB_CONTAINER_UID = fileVars.CI_HUB_CONTAINER_UID;
  if (fileVars.CI_HUB_CONTAINER_GID) overrides.CI_HUB_CONTAINER_GID = fileVars.CI_HUB_CONTAINER_GID;

  return overrides;
}

export function renderConfigLines(env: HubEnv) {
  const envFileName = getEnvFileOrExit(env);
  const fileVars = parseEnvFile(envFileName);
  const rootFolder = resolveRootFolderHost(envFileName);
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const mcpEnabled = (process.env.MCP_ENABLED || fileVars.MCP_ENABLED || 'true') !== 'false';
  // Deliberately no `mcp api key` line. Nothing derives MCP_API_KEY any more (env-helpers deletes it
  // rather than minting one) and McpAuthGuard has no env fallback, so the variable authenticates
  // nothing. An appliance upgraded from an older build can still have the dead value sitting in its
  // source env file — printing it as `<set>` is exactly what told operators they held a credential
  // they did not. The real keys live in the hashed store: `cihub api-key list`.
  return [
    `${bold('environment')}      ${env}`,
    `${bold('env file')}         ${envFileName}`,
    `${bold('root folder')}      ${rootFolder}`,
    `${bold('cloud url')}        ${process.env.CI_CLOUD_URL || fileVars.CI_CLOUD_URL || CI_CLOUD_DEFAULT}`,
    `${bold('compose profiles')} ${composeProfiles || '(none)'}`,
    `${bold('mcp enabled')}      ${mcpEnabled}`,
  ];
}

export function ensureLocalDevRuntimeEnv(envFileName: string): Record<string, string> {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  const runtimeEnvPath = join(rootFolderHost, '.env');
  const appDataDir = join(rootFolderHost, 'app-data');
  const sourceVars = parseEnvFile(envFileName);
  const runtimeVars = {
    ...sourceVars,
    ENV_FILE: envFileName,
    ROOT_FOLDER_HOST: rootFolderHost,
    API_PORT: sourceVars.API_PORT || LOCAL_DEV_BACKEND_PORT,
    FRONTEND_PORT: sourceVars.FRONTEND_PORT || LOCAL_DEV_FRONTEND_PORT,
    CI_HUB_DATA_DIR: sourceVars.CI_HUB_DATA_DIR || rootFolderHost,
    CI_HUB_APP_DATA_DIR: sourceVars.CI_HUB_APP_DATA_DIR || appDataDir,
    CI_HUB_APP_DATA_PATH: sourceVars.CI_HUB_APP_DATA_PATH || rootFolderHost,
    // Backend default is `/app` (the packaged container's root). Source-based local dev
    // runs the backend bare on the host, where `/app` doesn't exist, breaking anything
    // that derives from APP_DIR: Cloudflare tunnel file writes (EACCES), the Cloudflare
    // service's docker-compose-file lookup (falls back to `${APP_DIR}/docker-compose.local.yml`),
    // and the swagger.json writer. Point it at the repo root, mirroring the CI_HUB_DATA_DIR
    // treatment above. requireRepoRoot() has already confirmed cwd is the checkout root
    // by the time this runs (see startHub's 'local-dev' branch).
    //
    // Note: FilesystemService#getSafeFilePath allowlists `APP_DIR`, so this makes the whole
    // checkout (including .env*, .git/) a "safe" root for backend file ops in local dev —
    // same as prod, where /app is the packaged app's own files. Accepted tradeoff: a local
    // dev checkout is inherently a superset of the packaged image's /app, and a developer
    // running this already has equal-or-greater direct filesystem access. Never reachable
    // from appliance/prod/staging/dev-docker (requireRepoRoot/isApplianceMode gate this).
    CI_HUB_APP_DIR: sourceVars.CI_HUB_APP_DIR || process.cwd(),
    CI_HUB_VERSION: sourceVars.CI_HUB_VERSION || process.env.CI_HUB_VERSION || packageVersion(),
  };
  const content = Object.entries(runtimeVars)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(runtimeEnvPath, `${content}\n`, 'utf-8');
  return runtimeVars;
}
