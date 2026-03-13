import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settingsSchema } from '@/app.dto';
import { type LogLevel, LoggerService } from '@/core/logger/logger.service';
import { EnvUtils } from '@/modules/env/env.utils';
import dotenv from 'dotenv';
import { DATA_DIR } from '../constants';
import { type } from 'arktype';

export const DEFAULT_REPO_URL = '';

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
function resolve(
  key: string,
  opts: {
    envMap: Map<string, string>;
    settingsVal?: string | undefined;
    fallback: string;
  },
): string {
  // 1. process.env (.env.local / system) always wins
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return process.env[key] as string;
  }
  // 2. settings.json value (if provided and not undefined)
  if (opts.settingsVal !== undefined) {
    return opts.settingsVal;
  }
  // 3. Previously persisted value in data .env
  const persisted = opts.envMap.get(key);
  if (persisted !== undefined && persisted !== '') {
    return persisted;
  }
  // 4. Hardcoded default
  return opts.fallback;
}

/** Coerce a settings boolean to string, or return undefined if not set */
function boolStr(val: boolean | undefined): string | undefined {
  return typeof val === 'boolean' ? String(val) : undefined;
}

export const generateSystemEnvFile = async (): Promise<Map<string, string>> => {
  const logger = new LoggerService('backend', path.join(path.join(DATA_DIR, 'logs')), process.env.LOG_LEVEL as LogLevel);
  logger.debug('Checking system env file');

  const envUtils = new EnvUtils();

  await fs.promises.mkdir(path.join(DATA_DIR, 'state'), { recursive: true });

  const settingsFilePath = path.join(DATA_DIR, 'state', 'settings.json');
  const envFilePath = path.join(DATA_DIR, '.env');

  if (!fs.existsSync(envFilePath)) {
    await fs.promises.writeFile(envFilePath, '');
    logger.info('Created new .env file');
  }

  const envFile = await fs.promises.readFile(envFilePath, 'utf-8');

  const envMap: Map<string, string> = envUtils.envStringToMap(envFile);

  const { NODE_ENV } = process.env;
  envMap.set('NODE_ENV', NODE_ENV || 'production');

  if (!fs.existsSync(settingsFilePath)) {
    await fs.promises.writeFile(settingsFilePath, JSON.stringify({}));
  }

  const settingsFile = await fs.promises.readFile(settingsFilePath, 'utf-8');

  const settings = settingsSchema.partial()(JSON.parse(settingsFile));

  if (settings instanceof type.errors) {
    throw new Error(`Invalid settings.json file: ${settings.summary}`);
  }

  await generateSeed();

  // --- Resolve all values using the standard priority chain ---

  const jwtSecret = envMap.get('JWT_SECRET') || envUtils.deriveEntropy('jwt_secret');

  const rootFolderHost = resolve('ROOT_FOLDER_HOST', { envMap, fallback: '' });

  if (!rootFolderHost) {
    throw new Error(
      'Failed to determine root folder host. If you are not running via the CLI, please set the ROOT_FOLDER_HOST environment variable.',
    );
  }

  if (!path.isAbsolute(rootFolderHost)) {
    throw new Error(
      `ROOT_FOLDER_HOST must be an absolute host path, got: ${rootFolderHost}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path in docker-compose.yml or .env file.',
    );
  }

  // Ensure that the app data path does not contain the /app-data suffix
  let appDataPath = settings.appDataPath || resolve('RUNTIPI_APP_DATA_PATH', { envMap, fallback: '' });
  const appDataSegment = '/app-data';

  while (appDataPath?.endsWith(appDataSegment)) {
    logger.warn('Your app data path setting should not end with /app-data. Please remove the /app-data suffix.');
    appDataPath = appDataPath.slice(0, -appDataSegment.length);
  }

  // Ensure RUNTIPI_APP_DATA_PATH is always absolute (host path)
  if (appDataPath && !path.isAbsolute(appDataPath)) {
    appDataPath = path.resolve(rootFolderHost, appDataPath);
    logger.debug(`Resolved relative RUNTIPI_APP_DATA_PATH against ROOT_FOLDER_HOST to: ${appDataPath}`);
  }

  const finalAppDataPath = appDataPath || rootFolderHost;

  if (!path.isAbsolute(finalAppDataPath)) {
    throw new Error(
      `RUNTIPI_APP_DATA_PATH must be an absolute path, got: ${finalAppDataPath}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path or set RUNTIPI_APP_DATA_PATH to an absolute path.',
    );
  }

  if (finalAppDataPath.startsWith('/app') || finalAppDataPath.startsWith('/data/')) {
    throw new Error(
      `RUNTIPI_APP_DATA_PATH must be a host path, not a container path. Got: ${finalAppDataPath}. ` +
        'Please ensure ROOT_FOLDER_HOST is set to an absolute host path.',
    );
  }

  // --- Write resolved values into envMap ---
  // Every value uses resolve() for consistent priority:
  //   process.env > settings.json > data .env > default

  envMap.set('ROOT_FOLDER_HOST', rootFolderHost);
  envMap.set('ARCHITECTURE', getArchitecture());
  envMap.set('JWT_SECRET', jwtSecret);
  envMap.set('RUNTIPI_APP_DATA_PATH', finalAppDataPath);

  // Core infrastructure
  envMap.set('INTERNAL_IP', resolve('INTERNAL_IP', { envMap, settingsVal: settings.listenIp, fallback: '127.0.0.1' }));
  envMap.set('TZ', resolve('TZ', { envMap, settingsVal: settings.timeZone, fallback: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  envMap.set('DNS_IP', resolve('DNS_IP', { envMap, settingsVal: settings.dnsIp, fallback: '9.9.9.9' }));
  envMap.set('DOMAIN', resolve('DOMAIN', { envMap, fallback: 'example.com' }));
  envMap.set('LOCAL_DOMAIN', resolve('LOCAL_DOMAIN', { envMap, settingsVal: settings.localDomain, fallback: '' }));
  envMap.set(
    'RUNTIPI_FORWARD_AUTH_URL',
    resolve('RUNTIPI_FORWARD_AUTH_URL', { envMap, settingsVal: settings.forwardAuthUrl, fallback: 'http://ci-os-hub:3000/api/auth/traefik' }),
  );

  // Database
  envMap.set('POSTGRES_HOST', resolve('POSTGRES_HOST', { envMap, fallback: 'ci-hub-db' }));
  envMap.set('POSTGRES_DBNAME', resolve('POSTGRES_DBNAME', { envMap, fallback: 'companiondb' }));
  envMap.set('POSTGRES_USERNAME', resolve('POSTGRES_USERNAME', { envMap, fallback: 'companion' }));
  envMap.set('POSTGRES_PORT', resolve('POSTGRES_PORT', { envMap, fallback: '6543' }));

  // Message queue — also handle legacy hostname migration
  let rabbitmqHost = resolve('RABBITMQ_HOST', { envMap, fallback: 'ci-os-hub-queue' });
  if (rabbitmqHost === 'runtipi-queue') {
    rabbitmqHost = 'ci-os-hub-queue';
  }
  envMap.set('RABBITMQ_HOST', rabbitmqHost);
  envMap.set('RABBITMQ_USERNAME', resolve('RABBITMQ_USERNAME', { envMap, fallback: 'companion' }));
  envMap.set('RABBITMQ_PASSWORD', resolve('RABBITMQ_PASSWORD', { envMap, fallback: 'admin' }));

  // Feature flags / user preferences (settings.json booleans)
  envMap.set('DEMO_MODE', resolve('DEMO_MODE', { envMap, settingsVal: boolStr(settings.demoMode), fallback: 'false' }));
  envMap.set(
    'DISABLE_PASSWORD_RESET',
    resolve('DISABLE_PASSWORD_RESET', { envMap, settingsVal: boolStr(settings.disablePasswordReset), fallback: 'true' }),
  );
  envMap.set('GUEST_DASHBOARD', resolve('GUEST_DASHBOARD', { envMap, settingsVal: boolStr(settings.guestDashboard), fallback: 'false' }));
  envMap.set('ALLOW_AUTO_THEMES', resolve('ALLOW_AUTO_THEMES', { envMap, settingsVal: boolStr(settings.allowAutoThemes), fallback: 'true' }));
  envMap.set(
    'ALLOW_ERROR_MONITORING',
    resolve('ALLOW_ERROR_MONITORING', { envMap, settingsVal: boolStr(settings.allowErrorMonitoring), fallback: 'false' }),
  );
  envMap.set(
    'PERSIST_TRAEFIK_CONFIG',
    resolve('PERSIST_TRAEFIK_CONFIG', { envMap, settingsVal: boolStr(settings.persistTraefikConfig), fallback: 'false' }),
  );
  envMap.set(
    'QUEUE_TIMEOUT_IN_MINUTES',
    resolve('QUEUE_TIMEOUT_IN_MINUTES', {
      envMap,
      settingsVal: typeof settings.eventsTimeout === 'number' ? String(settings.eventsTimeout) : undefined,
      fallback: '5',
    }),
  );
  envMap.set(
    'MAX_BACKUPS',
    resolve('MAX_BACKUPS', {
      envMap,
      settingsVal: typeof settings.maxBackups === 'number' ? String(settings.maxBackups) : undefined,
      fallback: '0',
    }),
  );
  envMap.set('ADVANCED_SETTINGS', resolve('ADVANCED_SETTINGS', { envMap, settingsVal: boolStr(settings.advancedSettings), fallback: 'false' }));
  envMap.set('LOG_LEVEL', resolve('LOG_LEVEL', { envMap, settingsVal: settings.logLevel, fallback: 'info' }));
  envMap.set(
    'EXPERIMENTAL_INSECURE_COOKIE',
    resolve('EXPERIMENTAL_INSECURE_COOKIE', { envMap, settingsVal: boolStr(settings.experimental_insecureCookie), fallback: 'false' }),
  );

  // Theming
  envMap.set('THEME_BASE', resolve('THEME_BASE', { envMap, settingsVal: settings.themeBase, fallback: 'gray' }));
  envMap.set('THEME_COLOR', resolve('THEME_COLOR', { envMap, settingsVal: settings.themeColor, fallback: 'blue' }));

  // CI Cloud integration
  const ciCloudUrl = resolve('CI_CLOUD_URL', { envMap, fallback: '' });
  if (!ciCloudUrl) {
    throw new Error('CI_CLOUD_URL is required for CI Cloud integration. Please set it in your .env file or environment variables.');
  }
  envMap.set('CI_CLOUD_URL', ciCloudUrl);

  // --- Write data .env only if values changed ---

  const newEnvContent = envUtils.envMapToString(envMap);
  const currentEnvMap = envUtils.envStringToMap(envFile);

  let hasChanges = false;
  const changedVars: string[] = [];
  for (const [key, newValue] of envMap.entries()) {
    const currentValue = currentEnvMap.get(key);
    if (currentValue !== newValue) {
      hasChanges = true;
      changedVars.push(key);
      logger.debug(`Environment variable ${key} changed: ${currentValue || '(missing)'} -> ${newValue}`);
    }
  }

  if (!hasChanges) {
    for (const [key] of currentEnvMap.entries()) {
      if (!envMap.has(key)) {
        hasChanges = true;
        changedVars.push(key);
        logger.debug(`Environment variable ${key} was removed`);
      }
    }
  }

  if (hasChanges) {
    logger.info(`Environment file has changes (${changedVars.length} variables: ${changedVars.join(', ')}), updating...`);
    try {
      await fs.promises.writeFile(envFilePath, newEnvContent);
      logger.info('Environment file updated successfully');
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EROFS') {
        logger.warn('Cannot write to .env file (read-only mount). Continuing with existing values.');
      } else {
        throw error;
      }
    }
  } else {
    logger.debug('Environment file unchanged, skipping write');
  }

  // Load the resolved data .env into process.env as DEFAULTS only.
  // .env.local values already in process.env are NOT overwritten.
  dotenv.config({ path: envFilePath, override: false, quiet: true });

  return envMap;
};
