import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settingsSchema } from '@/app.dto';
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

/**
 * Generates a random seed if it does not exist yet
 */
const generateSeed = async () => {
  const seedFilePath = path.join(DATA_DIR, 'state', 'seed');
  if (!fs.existsSync(seedFilePath)) {
    const randomBytes = crypto.randomBytes(32);
    const seed = randomBytes.toString('hex');
    await fs.promises.writeFile(seedFilePath, seed);
  }
};

/**
 * Returns the architecture of the current system
 */
const getArchitecture = () => {
  const arch = os.arch();

  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';

  throw new Error(`Unsupported architecture: ${arch}`);
};

/**
 * Host paths may be POSIX (/foo/bar), Windows drive-letter (C:/foo), or UNC
 * (\\server\share). The backend often runs in a Linux container, so use both
 * path.isAbsolute and path.win32.isAbsolute.
 */
const isAbsoluteHostPath = (value: string) => path.isAbsolute(value) || path.win32.isAbsolute(value);

/**
 * Resolve a configuration value using the standard priority chain:
 *
 *   1. process.env (from .env.local or system environment — deployment intent)
 *   2. settings.json value (user preference from UI)
 *   3. data .env (previously persisted value)
 *   4. hardcoded default
 *
 * For boolean settings, pass the settings value through `settingsVal`
 * (which may be undefined if not set). For string settings, omit
 * `settingsVal` if there is no corresponding settings.json field.
 */
// Map of new env var names to their legacy equivalents for backward compatibility
const LEGACY_ENV_MAP: Record<string, string> = {
  CI_HUB_STATE_PATH: 'RUNTIPI_STATE_PATH',
  CI_HUB_APP_DATA_PATH: 'RUNTIPI_APP_DATA_PATH',
  CI_HUB_FORWARD_AUTH_URL: 'RUNTIPI_FORWARD_AUTH_URL',
  CI_HUB_DATA_DIR: 'TIPI_DATA_DIR',
  CI_HUB_APP_DIR: 'TIPI_APP_DIR',
  CI_HUB_APP_DATA_DIR: 'TIPI_APP_DATA_DIR',

  CI_HUB_MEDIA_PATH: 'RUNTIPI_MEDIA_PATH',
  CI_HUB_REPOS_PATH: 'RUNTIPI_REPOS_PATH',
  CI_HUB_APPS_PATH: 'RUNTIPI_APPS_PATH',
  CI_HUB_LOGS_PATH: 'RUNTIPI_LOGS_PATH',
  CI_HUB_USER_CONFIG_PATH: 'RUNTIPI_USER_CONFIG_PATH',
  CI_HUB_BACKUPS_PATH: 'RUNTIPI_BACKUPS_PATH',
};

function resolve(
  key: string,
  opts: {
    envMap: Map<string, string>;
    settingsVal?: string | undefined;
    fallback: string;
  },
): string {
  // 1. process.env (.env.local / system) always wins — check new name first, then legacy
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return process.env[key] as string;
  }
  const legacyKey = LEGACY_ENV_MAP[key];
  if (legacyKey && process.env[legacyKey] !== undefined && process.env[legacyKey] !== '') {
    return process.env[legacyKey] as string;
  }
  // 2. settings.json value (if provided and non-empty)
  if (opts.settingsVal !== undefined && opts.settingsVal !== '') {
    return opts.settingsVal;
  }
  // 3. Previously persisted value in data .env — check new name first, then legacy
  const persisted = opts.envMap.get(key);
  if (persisted !== undefined && persisted !== '') {
    return persisted;
  }
  if (legacyKey) {
    const legacyPersisted = opts.envMap.get(legacyKey);
    if (legacyPersisted !== undefined && legacyPersisted !== '') {
      return legacyPersisted;
    }
  }
  // 4. Hardcoded default
  return opts.fallback;
}

/** True when process.env already has a non-empty value (including legacy alias). */
function processEnvHasValue(key: string): boolean {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return true;
  }
  const legacyKey = LEGACY_ENV_MAP[key];
  return Boolean(legacyKey && process.env[legacyKey] !== undefined && process.env[legacyKey] !== '');
}

/** Coerce a settings boolean to string, or return undefined if not set */
function boolStr(val: boolean | undefined): string | undefined {
  return typeof val === 'boolean' ? String(val) : undefined;
}

function isFsErrorWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === code);
}

const SETTINGS_JSON_MODE = 0o666;

/** Ensure bind-mounted state/ exists; Hub container UID should match the host user (see CI_HUB_CONTAINER_UID). */
export async function ensureHubStateDirWritable(stateDir: string): Promise<void> {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o775 });
  try {
    await fs.promises.chmod(stateDir, 0o775);
  } catch {
    // chmod may fail on some mounts; write retry logic still applies.
  }
}

async function retrySettingsJsonPermissions(settingsFilePath: string, stateDir: string): Promise<void> {
  try {
    await fs.promises.chmod(stateDir, 0o777);
  } catch {
    // Host user may not own the directory (e.g. prior root-owned Hub container).
  }
  if (fs.existsSync(settingsFilePath)) {
    try {
      await fs.promises.chmod(settingsFilePath, SETTINGS_JSON_MODE);
      return;
    } catch {
      try {
        await fs.promises.access(settingsFilePath, fs.constants.R_OK);
        // Readable but not writable — preserve in place for manual ownership repair.
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

/** Ensure settings.json exists and is readable/writable by the Hub process. */
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

/** Write settings.json with permission recovery for stale root-owned bind mounts. */
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

/** Best-effort persistence of resolved env; returns false when the mount blocks writes. */
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
      // ignore
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

/** Apply resolved env to process.env without clobbering runtime / .env.local values. */
function applyEnvMapToProcess(envMap: Map<string, string>) {
  for (const [key, value] of envMap.entries()) {
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

  // Read the source .env (read-only — never written back to)
  let envFile = '';
  if (fs.existsSync(envFilePath)) {
    envFile = await fs.promises.readFile(envFilePath, 'utf-8');
  }

  const envMap: Map<string, string> = envUtils.envStringToMap(envFile);

  const { NODE_ENV } = process.env;
  envMap.set('NODE_ENV', NODE_ENV || 'production');

  await ensureSettingsJsonReady(settingsFilePath);

  const settingsFile = await fs.promises.readFile(settingsFilePath, 'utf-8');

  const settings = settingsSchema.partial().safeParse(JSON.parse(settingsFile));

  if (!settings.success) {
    throw new Error(`Invalid settings.json file: ${settings.error.message}`);
  }
  const settingsData = settings.data;

  await generateSeed();

  // --- Resolve all values using the standard priority chain ---

  const jwtSecret = resolve('JWT_SECRET', { envMap, fallback: '' }) || envUtils.deriveEntropy('jwt_secret');
  const mcpApiKey = resolve('MCP_API_KEY', { envMap, fallback: '' }) || envUtils.deriveEntropy('mcp_api_key');

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

  // Ensure that the app data path does not contain the /app-data suffix
  let appDataPath = settingsData.appDataPath || resolve('CI_HUB_APP_DATA_PATH', { envMap, fallback: '' });
  const appDataSegment = '/app-data';

  while (appDataPath?.endsWith(appDataSegment)) {
    logger.warn('Your app data path setting should not end with /app-data. Please remove the /app-data suffix.');
    appDataPath = appDataPath.slice(0, -appDataSegment.length);
  }

  // Ensure CI_HUB_APP_DATA_PATH is always absolute (host path)
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

  // --- Write resolved values into envMap ---
  // Every value uses resolve() for consistent priority:
  //   process.env > settingsData.json > data .env > default

  envMap.set('ROOT_FOLDER_HOST', rootFolderHost);
  envMap.set('ARCHITECTURE', getArchitecture());
  envMap.set('JWT_SECRET', jwtSecret);
  envMap.set('MCP_API_KEY', mcpApiKey);
  envMap.set('CI_HUB_APP_DATA_PATH', finalAppDataPath);

  // Core infrastructure
  envMap.set('INTERNAL_IP', resolve('INTERNAL_IP', { envMap, settingsVal: settingsData.listenIp, fallback: '127.0.0.1' }));
  envMap.set('TZ', resolve('TZ', { envMap, settingsVal: settingsData.timeZone, fallback: Intl.DateTimeFormat().resolvedOptions().timeZone }));
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

  // Database — these are internal Docker service names/creds; hardcoded defaults from constants
  envMap.set('POSTGRES_HOST', resolve('POSTGRES_HOST', { envMap, fallback: DEFAULT_POSTGRES_HOST }));
  envMap.set('POSTGRES_DBNAME', resolve('POSTGRES_DBNAME', { envMap, fallback: DEFAULT_POSTGRES_DBNAME }));
  envMap.set('POSTGRES_USERNAME', resolve('POSTGRES_USERNAME', { envMap, fallback: DEFAULT_POSTGRES_USERNAME }));
  envMap.set('POSTGRES_PORT', resolve('POSTGRES_PORT', { envMap, fallback: DEFAULT_POSTGRES_PORT }));

  // Message queue — handle legacy hostname migration (runtipi-queue was the original Runtipi hostname)
  let rabbitmqHost = resolve('RABBITMQ_HOST', { envMap, fallback: DEFAULT_RABBITMQ_HOST });
  if (rabbitmqHost === 'runtipi-queue' || rabbitmqHost === 'ci-hub-queue') {
    rabbitmqHost = DEFAULT_RABBITMQ_HOST;
  }
  envMap.set('RABBITMQ_HOST', rabbitmqHost);
  envMap.set('RABBITMQ_USERNAME', resolve('RABBITMQ_USERNAME', { envMap, fallback: DEFAULT_RABBITMQ_USERNAME }));
  envMap.set('RABBITMQ_PASSWORD', resolve('RABBITMQ_PASSWORD', { envMap, fallback: DEFAULT_RABBITMQ_PASSWORD }));

  // Feature flags / user preferences (settingsData.json booleans)
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
  envMap.set(
    'ALLOW_ERROR_MONITORING',
    resolve('ALLOW_ERROR_MONITORING', { envMap, settingsVal: boolStr(settingsData.allowErrorMonitoring), fallback: DEFAULT_ALLOW_ERROR_MONITORING }),
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

  // Theming
  envMap.set('THEME_BASE', resolve('THEME_BASE', { envMap, settingsVal: settingsData.themeBase, fallback: DEFAULT_THEME_BASE }));
  envMap.set('THEME_COLOR', resolve('THEME_COLOR', { envMap, settingsVal: settingsData.themeColor, fallback: DEFAULT_THEME_COLOR }));

  // CI Cloud integration — REQUIRED, no fallback
  const ciCloudUrl = resolve('CI_CLOUD_URL', { envMap, fallback: '' });
  if (!ciCloudUrl) {
    throw new Error(`CI_CLOUD_URL is required. Please set it in your .env file (e.g. CI_CLOUD_URL=${DEFAULT_CI_CLOUD_URL})`);
  }
  envMap.set('CI_CLOUD_URL', ciCloudUrl);

  // --- Write resolved env to state dir (never back to source .env) ---

  const newEnvContent = envUtils.envMapToString(envMap);

  applyEnvMapToProcess(envMap);

  const wroteResolved = await writeResolvedEnvFile(resolvedEnvFilePath, newEnvContent);
  if (wroteResolved) {
    logger.debug('Resolved environment written to state/.env.resolved');
    // Disk snapshot for other processes; override: false preserves runtime / .env.local on process.env.
    dotenv.config({ path: resolvedEnvFilePath, override: false, quiet: true });
  } else {
    logger.warn('Could not write state/.env.resolved (permission denied on bind mount). Using in-memory resolved environment for this process.');
  }

  return envMap;
};
