import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePersistedSettings } from '@/app.dto';
import { type LogLevel, LoggerService } from '@/core/logger/logger.service';
import { EnvUtils } from '@/modules/env/env.utils';
import dotenv from 'dotenv';
import {
  DATA_DIR,
  DEFAULT_POSTGRES_HOST,
  DEFAULT_POSTGRES_DBNAME,
  DEFAULT_POSTGRES_USERNAME,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_RABBITMQ_HOST,
  DEFAULT_RABBITMQ_USERNAME,
  DEFAULT_RABBITMQ_PASSWORD,
  DEFAULT_FORWARD_AUTH_URL,
  DEFAULT_DNS_IP,
  DEFAULT_TZ,
  DEFAULT_CI_CLOUD_URL,
  DEFAULT_PUBLIC_DOMAIN,
  DEFAULT_DEMO_MODE,
  DEFAULT_DISABLE_PASSWORD_RESET,
  DEFAULT_GUEST_DASHBOARD,
  DEFAULT_ALLOW_AUTO_THEMES,
  DEFAULT_ALLOW_ERROR_MONITORING,
  DEFAULT_PERSIST_TRAEFIK_CONFIG,
  DEFAULT_QUEUE_TIMEOUT_IN_MINUTES,
  DEFAULT_MAX_BACKUPS,
  DEFAULT_ADVANCED_SETTINGS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_EXPERIMENTAL_INSECURE_COOKIE,
  DEFAULT_THEME_BASE,
  DEFAULT_THEME_COLOR,
  DEFAULT_LOCAL_DOMAIN,
} from '../constants';
import { quarantineStalePath } from './bind-mount-helpers';
import { canonicalTimeZone, getHostTimeZone } from './timezone-helpers';

const generateSeed = async () => {
  const seedFilePath = path.join(DATA_DIR, 'state', 'seed');
  if (!fs.existsSync(seedFilePath)) {
    const randomBytes = crypto.randomBytes(32);
    const seed = randomBytes.toString('hex');
    await fs.promises.writeFile(seedFilePath, seed);
  }
};

/**
 * Prefers host-probe architecture because emulated containers can report an
 * architecture that does not match the images Docker runs.
 */
const readHostProbeArchitecture = (): 'arm64' | 'amd64' | null => {
  const candidates = [path.join(DATA_DIR, 'state', 'hardware', 'host_metrics.json'), path.join(DATA_DIR, 'state', 'hardware', 'host_system.json')];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { cpuArch?: string };
      if (parsed.cpuArch === 'arm64') return 'arm64';
      if (parsed.cpuArch === 'x86_64' || parsed.cpuArch === 'amd64') return 'amd64';
    } catch {
      // Fall back to the container architecture when probe files are unreadable.
    }
  }

  return null;
};

const getArchitecture = () => {
  const fromHost = readHostProbeArchitecture();
  if (fromHost) return fromHost;

  const arch = os.arch();

  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';

  throw new Error(`Unsupported architecture: ${arch}`);
};

/**
 * Accepts Windows host paths even when the backend runs in a Linux container.
 */
const isAbsoluteHostPath = (value: string) => path.isAbsolute(value) || path.win32.isAbsolute(value);

/**
 * Resolves configuration from the process environment, settings, persisted
 * environment, then the default. New variable names take precedence over legacy aliases.
 */
/**
 * Keep legacy names readable while existing installations migrate.
 *
 * Aliases are listed oldest-first. The `RUNTIPI_*` / `TIPI_*` names are the ones
 * appliances actually have on disk — CI-OS still writes them today, in
 * `core/lib/ci-hub.sh`. They were lost in #1143 (`c88a83580`), which renamed
 * "Runtipi" to "CIHub" by substring and turned `RUNTIPI_` into `RUNCIHUB_` — a
 * prefix that was never shipped, so nothing ever set it and this whole fallback
 * silently stopped resolving. The `RUNCIHUB_*` / `CIHUB_*` spellings are kept
 * because they have been in released builds since v0.2.60 and cost nothing.
 */
const LEGACY_ENV_MAP: Record<string, readonly string[]> = {
  CI_HUB_STATE_PATH: ['RUNTIPI_STATE_PATH', 'RUNCIHUB_STATE_PATH'],
  CI_HUB_APP_DATA_PATH: ['RUNTIPI_APP_DATA_PATH', 'RUNCIHUB_APP_DATA_PATH'],
  CI_HUB_FORWARD_AUTH_URL: ['RUNTIPI_FORWARD_AUTH_URL', 'RUNCIHUB_FORWARD_AUTH_URL'],
  CI_HUB_DATA_DIR: ['TIPI_DATA_DIR', 'CIHUB_DATA_DIR'],
  CI_HUB_APP_DIR: ['TIPI_APP_DIR', 'CIHUB_APP_DIR'],
  CI_HUB_APP_DATA_DIR: ['TIPI_APP_DATA_DIR', 'CIHUB_APP_DATA_DIR'],

  CI_HUB_MEDIA_PATH: ['RUNTIPI_MEDIA_PATH', 'RUNCIHUB_MEDIA_PATH'],
  CI_HUB_REPOS_PATH: ['RUNTIPI_REPOS_PATH', 'RUNCIHUB_REPOS_PATH'],
  CI_HUB_APPS_PATH: ['RUNTIPI_APPS_PATH', 'RUNCIHUB_APPS_PATH'],
  CI_HUB_LOGS_PATH: ['RUNTIPI_LOGS_PATH', 'RUNCIHUB_LOGS_PATH'],
  CI_HUB_USER_CONFIG_PATH: ['RUNTIPI_USER_CONFIG_PATH', 'RUNCIHUB_USER_CONFIG_PATH'],
  CI_HUB_BACKUPS_PATH: ['RUNTIPI_BACKUPS_PATH', 'RUNCIHUB_BACKUPS_PATH'],
};

const legacyKeysFor = (key: string): readonly string[] => LEGACY_ENV_MAP[key] ?? [];

const envValue = (key: string): string | undefined => {
  const val = process.env[key];
  return val !== undefined && val !== '' ? val : undefined;
};

function resolve(
  key: string,
  opts: {
    envMap: Map<string, string>;
    settingsVal?: string | undefined;
    fallback: string;
  },
): string {
  const current = envValue(key);
  if (current !== undefined) {
    return current;
  }
  const legacyKeys = legacyKeysFor(key);
  for (const legacyKey of legacyKeys) {
    const legacy = envValue(legacyKey);
    if (legacy !== undefined) {
      return legacy;
    }
  }
  if (opts.settingsVal !== undefined && opts.settingsVal !== '') {
    return opts.settingsVal;
  }
  const persisted = opts.envMap.get(key);
  if (persisted !== undefined && persisted !== '') {
    return persisted;
  }
  for (const legacyKey of legacyKeys) {
    const legacyPersisted = opts.envMap.get(legacyKey);
    if (legacyPersisted !== undefined && legacyPersisted !== '') {
      return legacyPersisted;
    }
  }
  return opts.fallback;
}

function processEnvHasValue(key: string): boolean {
  if (envValue(key) !== undefined) {
    return true;
  }
  return legacyKeysFor(key).some((legacyKey) => envValue(legacyKey) !== undefined);
}

function boolStr(val: boolean | undefined): string | undefined {
  return typeof val === 'boolean' ? String(val) : undefined;
}

/**
 * Error-reporting consent, and the ONLY place its precedence is decided: the persisted
 * `allowErrorMonitoring` switch, then `ALLOW_ERROR_MONITORING`, then
 * {@link DEFAULT_ALLOW_ERROR_MONITORING}. `generateSystemEnvFile` and
 * `ConfigurationService.configure()` both call it, so the resolved env this function writes
 * and the config the Hub actually runs on cannot disagree about what the user consented to.
 * They did: `resolve()` handed the variable to the env and `configure()` handed it to the
 * setting, and for a privacy control "whichever wins" is not an answer.
 *
 * Settings-first is deliberately NOT the env-first order `resolve()` gives every other key,
 * and deliberately not the `resolveHubPoolEnabled` shape either. Those exist so a box
 * owner's `.env` cannot be undone from the dashboard, and both are disable-only:
 * `HUB_POOL_USER_DISABLED=true` switches pooling off and nothing switches it back on.
 * `ALLOW_ERROR_MONITORING` is two-valued and defaults to `'true'`, so env-first would let a
 * `true` inherited from a compose file, a stale shell, or an older build's
 * `state/.env.resolved` override a user who explicitly opted out — an environment variable
 * forcing consent ON, which is the one direction a privacy control must never move.
 *
 * The operator-of-the-box kill switch for reporting already exists in the disable-only
 * shape. `CI_LOCAL_ONLY=true` and `CI_TELEMETRY=off` sit above the user's switch in
 * `core/error-reporting/telemetry-consent.ts`, are enforced at Sentry init and again per
 * event in `beforeSend`, and cannot be undone from the UI. This variable is the seed for a
 * Hub whose user has never touched the switch — level 3 of that file's precedence list, not
 * a fourth switch above it.
 *
 * Settings-first is also what keeps projecting the value into `state/.env.resolved` safe:
 * under env-first the projection would be exactly the trap `resolveHubPoolEnabled` documents
 * in `helpers/hub-pool.ts`, where one boot writes the flag to disk and every later boot reads
 * its own output back as an operator decision.
 */
export function resolveAllowErrorMonitoring(sources: { setting: boolean | undefined; env: boolean }): boolean {
  return sources.setting ?? sources.env;
}

/**
 * Resolves the RabbitMQ password without silently using the development default in
 * production. Production requires an explicit value; an explicit `admin` remains
 * compatible but returns a migration warning.
 */
export function resolveRabbitmqPassword(envMap: Map<string, string>): { password: string; warning?: string } {
  const isProduction = process.env.NODE_ENV === 'production';
  const explicit = resolve('RABBITMQ_PASSWORD', { envMap, fallback: '' });

  if (explicit) {
    if (isProduction && explicit === DEFAULT_RABBITMQ_PASSWORD) {
      return {
        password: explicit,
        warning:
          "RABBITMQ_PASSWORD is set to the weak default 'admin' in production. Set a strong, unique RABBITMQ_PASSWORD " +
          '(and match RABBITMQ_DEFAULT_PASS on the broker) — the default is a known credential.',
      };
    }
    return { password: explicit };
  }

  if (isProduction) {
    throw new Error(
      'RABBITMQ_PASSWORD is not set. Production must provide an explicit RABBITMQ_PASSWORD ' +
        "instead of silently falling back to the weak default 'admin'. Set it in the environment or the Hub .env file.",
    );
  }

  return { password: DEFAULT_RABBITMQ_PASSWORD };
}

function isFsErrorWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === code);
}

const SETTINGS_JSON_MODE = 0o666;

/** Repairs bind-mounted state permissions for the Hub process. */
export async function ensureHubStateDirWritable(stateDir: string): Promise<void> {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o775 });
  try {
    await fs.promises.chmod(stateDir, 0o775);
  } catch {
    // Some mounts reject chmod; later writes still provide the authoritative check.
  }
}

async function retrySettingsJsonPermissions(settingsFilePath: string, stateDir: string): Promise<void> {
  try {
    await fs.promises.chmod(stateDir, 0o777);
  } catch {
    // A previous root-owned container can leave the host user without ownership.
  }
  if (fs.existsSync(settingsFilePath)) {
    try {
      await fs.promises.chmod(settingsFilePath, SETTINGS_JSON_MODE);
      return;
    } catch {
      try {
        await fs.promises.access(settingsFilePath, fs.constants.R_OK);
        // Preserve readable files for manual ownership repair.
        return;
      } catch {
        quarantineStalePath(settingsFilePath);
      }
    }
  }
}

function settingsJsonPermissionError(settingsFilePath: string, cause: unknown): Error {
  return new Error(
    `Cannot read or write ${settingsFilePath}. This usually means bind-mounted Hub data was written by a prior container running as a different user (common after Hub upgrades or Docker Desktop UID changes). Stop the Hub, fix ownership on the host data directory (for example: chown -R "$(id -u):$(id -g)" "$ROOT_FOLDER_HOST/state"), or quarantine state/settings.json and restart.`,
    { cause },
  );
}

/** Ensures settings.json exists and is readable and writable by the Hub process. */
export async function ensureSettingsJsonReady(settingsFilePath: string): Promise<void> {
  const stateDir = path.dirname(settingsFilePath);
  await ensureHubStateDirWritable(stateDir);

  const createEmpty = async () => {
    await fs.promises.writeFile(settingsFilePath, '{}', { encoding: 'utf8', mode: SETTINGS_JSON_MODE });
  };

  if (!fs.existsSync(settingsFilePath)) {
    try {
      await createEmpty();
      return;
    } catch (error) {
      if (!isFsErrorWithCode(error, 'EACCES')) {
        throw error;
      }
      await retrySettingsJsonPermissions(settingsFilePath, stateDir);
      await createEmpty();
      return;
    }
  }

  try {
    await fs.promises.access(settingsFilePath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    await retrySettingsJsonPermissions(settingsFilePath, stateDir);
    if (!fs.existsSync(settingsFilePath)) {
      await createEmpty();
      return;
    }
    try {
      await fs.promises.access(settingsFilePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (retryError) {
      throw settingsJsonPermissionError(settingsFilePath, retryError ?? error);
    }
  }
}

/** Writes settings.json with permission recovery for stale root-owned bind mounts. */
export async function writeSettingsJsonFile(settingsFilePath: string, content: string): Promise<void> {
  await ensureSettingsJsonReady(settingsFilePath);

  try {
    await fs.promises.writeFile(settingsFilePath, content, { encoding: 'utf8', mode: SETTINGS_JSON_MODE });
  } catch (error) {
    if (!isFsErrorWithCode(error, 'EACCES')) {
      throw error;
    }
    await retrySettingsJsonPermissions(settingsFilePath, path.dirname(settingsFilePath));
    try {
      await fs.promises.writeFile(settingsFilePath, content, { encoding: 'utf8', mode: SETTINGS_JSON_MODE });
    } catch (retryError) {
      throw settingsJsonPermissionError(settingsFilePath, retryError);
    }
  }
}

/** Persists resolved environment when the mount permits writes. Returns false otherwise. */
export async function writeResolvedEnvFile(targetPath: string, content: string): Promise<boolean> {
  const stateDir = path.dirname(targetPath);
  await ensureHubStateDirWritable(stateDir);

  try {
    await fs.promises.unlink(targetPath);
  } catch {
    // File may not exist yet.
  }

  const attemptWrite = async () => {
    await fs.promises.writeFile(targetPath, content, { mode: 0o664 });
  };

  try {
    await attemptWrite();
    return true;
  } catch (error: unknown) {
    if (!isFsErrorWithCode(error, 'EACCES') && !isFsErrorWithCode(error, 'EROFS')) {
      throw error;
    }
    try {
      await fs.promises.chmod(targetPath, 0o664);
    } catch {
      // Some mounts do not support chmod.
    }
    try {
      await attemptWrite();
      return true;
    } catch (retryError: unknown) {
      if (isFsErrorWithCode(retryError, 'EACCES') || isFsErrorWithCode(retryError, 'EROFS')) {
        return false;
      }
      throw retryError;
    }
  }
}

/** Applies resolved environment without replacing runtime or .env.local values. */
function applyEnvMapToProcess(envMap: Map<string, string>) {
  for (const [key, value] of envMap.entries()) {
    // Assigning undefined to process.env creates the truthy string `undefined`, which would
    // override later fallbacks and poison time zone detection.
    if (typeof value !== 'string') continue;

    if (!processEnvHasValue(key)) {
      process.env[key] = value;
    }
  }
}

export const generateSystemEnvFile = async (): Promise<Map<string, string>> => {
  const logger = new LoggerService('backend', path.join(path.join(DATA_DIR, 'logs')), process.env.LOG_LEVEL as LogLevel);
  logger.debug('Checking system env file');

  const envUtils = new EnvUtils();

  const stateDir = path.join(DATA_DIR, 'state');
  await ensureHubStateDirWritable(stateDir);

  const settingsFilePath = path.join(DATA_DIR, 'state', 'settings.json');
  const envFilePath = path.join(DATA_DIR, '.env');
  const resolvedEnvFilePath = path.join(DATA_DIR, 'state', '.env.resolved');

  // Preserve the source environment; resolved values are written to state/.env.resolved.
  let envFile = '';
  if (fs.existsSync(envFilePath)) {
    envFile = await fs.promises.readFile(envFilePath, 'utf-8');
  }

  const envMap: Map<string, string> = envUtils.envStringToMap(envFile);

  const { NODE_ENV } = process.env;
  envMap.set('NODE_ENV', NODE_ENV || 'production');

  await ensureSettingsJsonReady(settingsFilePath);

  const settingsFile = await fs.promises.readFile(settingsFilePath, 'utf-8');

  // One unusable field must not abort the boot. This function runs before Nest exists (main.ts
  // calls it first), so a throw here is a crash loop with no UI to fix it from and no route to the
  // file that caused it — and every field it feeds already has an environment value or a default
  // behind it. Drop what cannot be read, name it in the log, and carry on with the rest.
  const settings = parsePersistedSettings(JSON.parse(settingsFile));

  if (settings.unreadable) {
    logger.warn(
      'settings.json does not contain a JSON object. Ignoring it for this boot and resolving every value from the environment and defaults.',
    );
  } else if (settings.invalidKeys.length > 0) {
    logger.warn(`Ignoring unusable settings.json field(s): ${settings.invalidKeys.join(', ')}. Every other field was applied.`);
  }

  const settingsData = settings.settings;

  await generateSeed();

  const jwtSecret = resolve('JWT_SECRET', { envMap, fallback: '' }) || envUtils.deriveEntropy('jwt_secret');
  // Derive forward-auth independently so consumer access cannot expose the Hub JWT secret.
  const forwardAuthSecret = resolve('CI_HUB_FORWARD_AUTH_SECRET', { envMap, fallback: '' }) || envUtils.deriveEntropy('forward_auth_secret');

  const rootFolderHost = resolve('ROOT_FOLDER_HOST', { envMap, fallback: '' });

  if (!rootFolderHost) {
    throw new Error(
      'Failed to determine root folder host. If you are not running via the CLI, please set the ROOT_FOLDER_HOST environment variable.',
    );
  }

  if (!isAbsoluteHostPath(rootFolderHost)) {
    throw new Error(
      `ROOT_FOLDER_HOST must be an absolute host path, got: ${rootFolderHost}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path in docker-compose.yml or .env file.',
    );
  }

  let appDataPath = settingsData.appDataPath || resolve('CI_HUB_APP_DATA_PATH', { envMap, fallback: '' });
  const appDataSegment = '/app-data';

  while (appDataPath?.endsWith(appDataSegment)) {
    logger.warn('Your app data path setting should not end with /app-data. Please remove the /app-data suffix.');
    appDataPath = appDataPath.slice(0, -appDataSegment.length);
  }

  if (appDataPath && !isAbsoluteHostPath(appDataPath)) {
    appDataPath = path.resolve(rootFolderHost, appDataPath);
    logger.debug(`Resolved relative CI_HUB_APP_DATA_PATH against ROOT_FOLDER_HOST to: ${appDataPath}`);
  }

  const finalAppDataPath = appDataPath || rootFolderHost;

  if (!isAbsoluteHostPath(finalAppDataPath)) {
    throw new Error(
      `CI_HUB_APP_DATA_PATH must be an absolute path, got: ${finalAppDataPath}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path or set CI_HUB_APP_DATA_PATH to an absolute path.',
    );
  }

  if (finalAppDataPath.startsWith('/app') || finalAppDataPath.startsWith('/data/')) {
    throw new Error(
      `CI_HUB_APP_DATA_PATH must be a host path, not a container path. Got: ${finalAppDataPath}. ` +
        'Please ensure ROOT_FOLDER_HOST is set to an absolute host path.',
    );
  }

  envMap.set('ROOT_FOLDER_HOST', rootFolderHost);
  envMap.set('ARCHITECTURE', getArchitecture());
  envMap.set('JWT_SECRET', jwtSecret);
  // `MCP_API_KEY` no longer authenticates requests. Remove persisted values; MCP keys live
  // in the hashed key store (SEC-MCP-8).
  envMap.delete('MCP_API_KEY');
  envMap.set('CI_HUB_FORWARD_AUTH_SECRET', forwardAuthSecret);
  // Destructive access now comes from each key's capability column. Discard obsolete
  // environment grants (ISSUE-MCP-2).
  envMap.delete('MCP_ALLOW_DESTRUCTIVE');
  envMap.set('CI_HUB_APP_DATA_PATH', finalAppDataPath);

  envMap.set('INTERNAL_IP', resolve('INTERNAL_IP', { envMap, settingsVal: settingsData.listenIp, fallback: '127.0.0.1' }));
  // Validate the winning time zone from every source, not only the fallback.
  const hostTimeZone = getHostTimeZone();
  const requestedTz = resolve('TZ', { envMap, settingsVal: settingsData.timeZone, fallback: hostTimeZone ?? DEFAULT_TZ });
  const canonicalTz = canonicalTimeZone(requestedTz);
  // Preserve the detected host zone when a configured value is invalid.
  const timeZone = canonicalTz ?? hostTimeZone ?? DEFAULT_TZ;

  if (!canonicalTz) {
    // JSON encoding prevents malformed settings values from forging log lines.
    logger.warn(`TZ ${JSON.stringify(requestedTz)} is not a valid IANA time zone. Falling back to ${timeZone}.`);
  } else if (!hostTimeZone && !process.env.TZ && !settingsData.timeZone && !envMap.get('TZ')) {
    // Warn only when no source selected a time zone.
    logger.warn(`Could not determine the host time zone — is tzdata missing from the image? Using ${timeZone}.`);
  }

  envMap.set('TZ', timeZone);
  // Keep inherited TZ consistent because ConfigurationService lets process.env win.
  process.env.TZ = timeZone;
  envMap.set('DNS_IP', resolve('DNS_IP', { envMap, settingsVal: settingsData.dnsIp, fallback: DEFAULT_DNS_IP }));
  envMap.set('DOMAIN', resolve('DOMAIN', { envMap, fallback: DEFAULT_PUBLIC_DOMAIN }));
  envMap.set(
    'LOCAL_DOMAIN',
    resolve('LOCAL_DOMAIN', {
      envMap,
      settingsVal: settingsData.localDomain?.trim() || undefined,
      fallback: DEFAULT_LOCAL_DOMAIN,
    }),
  );
  envMap.set(
    'CI_HUB_FORWARD_AUTH_URL',
    resolve('CI_HUB_FORWARD_AUTH_URL', { envMap, settingsVal: settingsData.forwardAuthUrl, fallback: DEFAULT_FORWARD_AUTH_URL }),
  );

  envMap.set('POSTGRES_HOST', resolve('POSTGRES_HOST', { envMap, fallback: DEFAULT_POSTGRES_HOST }));
  envMap.set('POSTGRES_DBNAME', resolve('POSTGRES_DBNAME', { envMap, fallback: DEFAULT_POSTGRES_DBNAME }));
  envMap.set('POSTGRES_USERNAME', resolve('POSTGRES_USERNAME', { envMap, fallback: DEFAULT_POSTGRES_USERNAME }));
  envMap.set('POSTGRES_PORT', resolve('POSTGRES_PORT', { envMap, fallback: DEFAULT_POSTGRES_PORT }));

  // Normalize legacy queue service names retained in persisted environments.
  let rabbitmqHost = resolve('RABBITMQ_HOST', { envMap, fallback: DEFAULT_RABBITMQ_HOST });
  if (rabbitmqHost === 'runcihub-queue' || rabbitmqHost === 'ci-hub-queue') {
    rabbitmqHost = DEFAULT_RABBITMQ_HOST;
  }
  envMap.set('RABBITMQ_HOST', rabbitmqHost);
  envMap.set('RABBITMQ_USERNAME', resolve('RABBITMQ_USERNAME', { envMap, fallback: DEFAULT_RABBITMQ_USERNAME }));
  const rabbitmqPassword = resolveRabbitmqPassword(envMap);
  if (rabbitmqPassword.warning) {
    logger.warn(rabbitmqPassword.warning);
  }
  envMap.set('RABBITMQ_PASSWORD', rabbitmqPassword.password);

  envMap.set('DEMO_MODE', resolve('DEMO_MODE', { envMap, settingsVal: boolStr(settingsData.demoMode), fallback: DEFAULT_DEMO_MODE }));
  envMap.set(
    'DISABLE_PASSWORD_RESET',
    resolve('DISABLE_PASSWORD_RESET', { envMap, settingsVal: boolStr(settingsData.disablePasswordReset), fallback: DEFAULT_DISABLE_PASSWORD_RESET }),
  );
  envMap.set(
    'GUEST_DASHBOARD',
    resolve('GUEST_DASHBOARD', { envMap, settingsVal: boolStr(settingsData.guestDashboard), fallback: DEFAULT_GUEST_DASHBOARD }),
  );
  envMap.set(
    'ALLOW_AUTO_THEMES',
    resolve('ALLOW_AUTO_THEMES', { envMap, settingsVal: boolStr(settingsData.allowAutoThemes), fallback: DEFAULT_ALLOW_AUTO_THEMES }),
  );
  // Not `resolve()`'s settingsVal slot: that slot is env-first, and this one key must not be.
  const errorMonitoringEnv = resolve('ALLOW_ERROR_MONITORING', { envMap, fallback: DEFAULT_ALLOW_ERROR_MONITORING });
  envMap.set(
    'ALLOW_ERROR_MONITORING',
    String(resolveAllowErrorMonitoring({ setting: settingsData.allowErrorMonitoring, env: errorMonitoringEnv.toLowerCase() === 'true' })),
  );
  envMap.set(
    'PERSIST_TRAEFIK_CONFIG',
    resolve('PERSIST_TRAEFIK_CONFIG', { envMap, settingsVal: boolStr(settingsData.persistTraefikConfig), fallback: DEFAULT_PERSIST_TRAEFIK_CONFIG }),
  );
  envMap.set(
    'QUEUE_TIMEOUT_IN_MINUTES',
    resolve('QUEUE_TIMEOUT_IN_MINUTES', {
      envMap,
      settingsVal: typeof settingsData.eventsTimeout === 'number' ? String(settingsData.eventsTimeout) : undefined,
      fallback: DEFAULT_QUEUE_TIMEOUT_IN_MINUTES,
    }),
  );
  envMap.set(
    'MAX_BACKUPS',
    resolve('MAX_BACKUPS', {
      envMap,
      settingsVal: typeof settingsData.maxBackups === 'number' ? String(settingsData.maxBackups) : undefined,
      fallback: DEFAULT_MAX_BACKUPS,
    }),
  );
  envMap.set(
    'ADVANCED_SETTINGS',
    resolve('ADVANCED_SETTINGS', { envMap, settingsVal: boolStr(settingsData.advancedSettings), fallback: DEFAULT_ADVANCED_SETTINGS }),
  );
  envMap.set('LOG_LEVEL', resolve('LOG_LEVEL', { envMap, settingsVal: settingsData.logLevel, fallback: DEFAULT_LOG_LEVEL }));
  envMap.set(
    'EXPERIMENTAL_INSECURE_COOKIE',
    resolve('EXPERIMENTAL_INSECURE_COOKIE', {
      envMap,
      settingsVal: boolStr(settingsData.experimental_insecureCookie),
      fallback: DEFAULT_EXPERIMENTAL_INSECURE_COOKIE,
    }),
  );

  envMap.set('THEME_BASE', resolve('THEME_BASE', { envMap, settingsVal: settingsData.themeBase, fallback: DEFAULT_THEME_BASE }));
  envMap.set('THEME_COLOR', resolve('THEME_COLOR', { envMap, settingsVal: settingsData.themeColor, fallback: DEFAULT_THEME_COLOR }));

  // Prefer mounted data because Docker Compose can retain stale host-shell values.
  const ciCloudUrl = envMap.get('CI_CLOUD_URL')?.trim() || resolve('CI_CLOUD_URL', { envMap, fallback: '' });
  if (!ciCloudUrl) {
    throw new Error(`CI_CLOUD_URL is required. Please set it in your .env file (e.g. CI_CLOUD_URL=${DEFAULT_CI_CLOUD_URL})`);
  }
  envMap.set('CI_CLOUD_URL', ciCloudUrl);

  const newEnvContent = envUtils.envMapToString(envMap);

  applyEnvMapToProcess(envMap);

  const wroteResolved = await writeResolvedEnvFile(resolvedEnvFilePath, newEnvContent);
  if (wroteResolved) {
    logger.debug('Resolved environment written to state/.env.resolved');
    // Preserve runtime and .env.local values while exposing the snapshot to other processes.
    dotenv.config({ path: resolvedEnvFilePath, override: false, quiet: true });
  } else {
    logger.warn('Could not write state/.env.resolved (permission denied on bind mount). Using in-memory resolved environment for this process.');
  }

  return envMap;
};
