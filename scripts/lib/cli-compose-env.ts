import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { parseEnvFile } from '../env-file.js';
import { resolveRootFolderHost } from './paths.js';
import { CI_CLOUD_DEFAULT, LOCAL_DEV_BACKEND_PORT, LOCAL_DEV_FRONTEND_PORT, type HubEnv } from './cli-types.js';
import { bold } from './cli-ui.js';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

declare const CIHUB_BUILD_VERSION: string | undefined;

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

const envFileMap: Record<HubEnv, string> = {
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

export function getComposeFiles(env: HubEnv): string[] {
  if (env === 'local') return ['docker-compose.local.yml'];
  if (env === 'staging') return ['docker-compose.prod.yml', 'docker-compose.staging.yml'];
  return ['docker-compose.prod.yml'];
}

function tunnelTokenPath(envFileName: string): string {
  const rootFolderHost = resolveRootFolderHost(envFileName);
  return path.resolve(rootFolderHost, '..', 'tunnel', 'token');
}

function hasCloudflareTunnelToken(envFileName: string): boolean {
  try {
    const tokenPath = tunnelTokenPath(envFileName);
    return existsSync(tokenPath) && statSync(tokenPath).isFile() && statSync(tokenPath).size > 0;
  } catch {
    return false;
  }
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
    set.add('private-vpn');
    if (hasCloudflareTunnelToken(envFileName)) set.add('cloudflare');
    return [...set].join(',');
  }
  const vpnOn = vars.PRIVATE_VPN_USER_DISABLED !== 'true';
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
  if (hasCloudflareTunnelToken(envFileName)) set.add('cloudflare');
  return [...set].join(',');
}

export function buildEnvOverrides(envFileName: string) {
  const composeProfiles = mergeComposeProfilesFromEnvFile(envFileName);
  const fileVars = parseEnvFile(envFileName);
  const resolvedHubVersion = (process.env.CI_HUB_VERSION || fileVars.CI_HUB_VERSION || packageVersion()).trim();
  const overrides: Record<string, string | undefined> = {
    ENV_FILE: envFileName,
  };
  if (composeProfiles) overrides.COMPOSE_PROFILES = composeProfiles;
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
  // Deliberately no `mcp api key` line. MCP_API_KEY is derived into the env file at boot
  // (env-helpers.ts) and reaches the container, but SEC-MCP-8 removed the guard's env fallback, so
  // nothing reads it — reporting it as `<set>` told operators they held a credential they did not.
  // The real keys live in the hashed store: `cihub api-key list`.
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
