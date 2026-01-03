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

const OLD_DEFAULT_REPO_URL = 'https://github.com/meienberger/runtipi-appstore';
export const DEFAULT_REPO_URL = 'https://github.com/runtipi/runtipi-appstore';

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

  if (settings.appsRepoUrl === OLD_DEFAULT_REPO_URL) {
    settings.appsRepoUrl = DEFAULT_REPO_URL;
  }

  const jwtSecret = envMap.get('JWT_SECRET') || envUtils.deriveEntropy('jwt_secret');

  const repoUrl = settings.appsRepoUrl || envMap.get('APPS_REPO_URL') || DEFAULT_REPO_URL;
  const hash = crypto.createHash('sha256');
  hash.update(repoUrl);
  const repoId = hash.digest('hex');

  const rootFolderHost = envMap.get('ROOT_FOLDER_HOST') || process.env.ROOT_FOLDER_HOST;
  const internalIp = envMap.get('INTERNAL_IP') || '127.0.0.1';

  if (!rootFolderHost) {
    throw new Error(
      'Failed to determine root folder host. If you are not running via the CLI, please set the ROOT_FOLDER_HOST environment variable.',
    );
  }

  // CRITICAL: ROOT_FOLDER_HOST must be a host path, not a container path
  // If it contains ${PWD} or is relative, we need to handle it differently
  // In Docker, ROOT_FOLDER_HOST should be set to an absolute host path by docker-compose
  // If it's still relative or contains variables, we cannot resolve it from inside the container
  if (!path.isAbsolute(rootFolderHost)) {
    logger.warn(
      `ROOT_FOLDER_HOST is relative (${rootFolderHost}). This should be an absolute host path. If running in Docker, check docker-compose.yml.`,
    );
    // In development, if we're in a container and ROOT_FOLDER_HOST is relative,
    // we cannot determine the host path. This is a configuration error.
    throw new Error(
      `ROOT_FOLDER_HOST must be an absolute host path, got: ${rootFolderHost}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path in docker-compose.yml or .env file.',
    );
  }

  // Ensure that the app data path does not contain the /app-data suffix
  let appDataPath = settings.appDataPath || envMap.get('RUNTIPI_APP_DATA_PATH');
  const appDataSegment = '/app-data';

  while (appDataPath?.endsWith(appDataSegment)) {
    logger.warn('Your app data path setting should not end with /app-data. Please remove the /app-data suffix.');
    appDataPath = appDataPath.slice(0, -appDataSegment.length);
  }

  // Ensure RUNTIPI_APP_DATA_PATH is always absolute (host path)
  // If it's relative, resolve it against ROOT_FOLDER_HOST (which must be absolute)
  if (appDataPath && !path.isAbsolute(appDataPath)) {
    // rootFolderHost is guaranteed to be absolute at this point
    appDataPath = path.resolve(rootFolderHost, appDataPath);
    logger.debug(`Resolved relative RUNTIPI_APP_DATA_PATH against ROOT_FOLDER_HOST to: ${appDataPath}`);
  }

  // Final fallback to rootFolderHost if appDataPath is still not set
  const finalAppDataPath = appDataPath || rootFolderHost;

  // Final validation - should be absolute at this point
  if (!path.isAbsolute(finalAppDataPath)) {
    logger.error(
      `RUNTIPI_APP_DATA_PATH is not absolute: ${finalAppDataPath}. This will cause Docker mount errors. Please set it to an absolute path.`,
    );
    throw new Error(
      `RUNTIPI_APP_DATA_PATH must be an absolute path, got: ${finalAppDataPath}. ` +
        'Please set ROOT_FOLDER_HOST to an absolute path or set RUNTIPI_APP_DATA_PATH to an absolute path.',
    );
  }

  // Additional validation: ensure it's not a container path
  if (finalAppDataPath.startsWith('/app') || finalAppDataPath.startsWith('/data/')) {
    logger.error(`RUNTIPI_APP_DATA_PATH appears to be a container path: ${finalAppDataPath}. This must be a host path for Docker mounts to work.`);
    throw new Error(
      `RUNTIPI_APP_DATA_PATH must be a host path, not a container path. Got: ${finalAppDataPath}. ` +
        'Please ensure ROOT_FOLDER_HOST is set to an absolute host path.',
    );
  }

  envMap.set('ROOT_FOLDER_HOST', rootFolderHost);
  envMap.set('APPS_REPO_ID', repoId);
  envMap.set('APPS_REPO_URL', settings.appsRepoUrl || envMap.get('APPS_REPO_URL') || DEFAULT_REPO_URL);
  envMap.set('TZ', settings.timeZone || envMap.get('TZ') || Intl.DateTimeFormat().resolvedOptions().timeZone);
  envMap.set('INTERNAL_IP', settings.listenIp || internalIp);
  envMap.set('DNS_IP', settings.dnsIp || envMap.get('DNS_IP') || '9.9.9.9');
  envMap.set('ARCHITECTURE', getArchitecture());
  envMap.set('JWT_SECRET', jwtSecret);
  envMap.set('DOMAIN', settings.domain || envMap.get('DOMAIN') || 'example.com');
  envMap.set('RUNTIPI_APP_DATA_PATH', finalAppDataPath);
  envMap.set(
    'RUNTIPI_FORWARD_AUTH_URL',
    settings.forwardAuthUrl ||
      process.env.RUNTIPI_FORWARD_AUTH_URL ||
      envMap.get('RUNTIPI_FORWARD_AUTH_URL') ||
      'http://ci-os-hub:3000/api/auth/traefik',
  );

  envMap.set('POSTGRES_HOST', process.env.POSTGRES_HOST || envMap.get('POSTGRES_HOST') || 'ci-hub-db');
  envMap.set('POSTGRES_DBNAME', process.env.POSTGRES_DBNAME || envMap.get('POSTGRES_DBNAME') || 'tipi');
  envMap.set('POSTGRES_USERNAME', process.env.POSTGRES_USERNAME || envMap.get('POSTGRES_USERNAME') || 'tipi');
  envMap.set('POSTGRES_PORT', process.env.POSTGRES_PORT || envMap.get('POSTGRES_PORT') || String(6543));
  // Override old runtipi-queue hostname if present
  const currentRabbitmqHost = process.env.RABBITMQ_HOST || envMap.get('RABBITMQ_HOST');
  if (currentRabbitmqHost === 'runtipi-queue') {
    envMap.set('RABBITMQ_HOST', 'ci-os-hub-queue');
  } else {
    envMap.set('RABBITMQ_HOST', currentRabbitmqHost || 'ci-os-hub-queue');
  }
  envMap.set('RABBITMQ_USERNAME', envMap.get('RABBITMQ_USERNAME') || 'tipi');
  envMap.set('RABBITMQ_PASSWORD', envMap.get('RABBITMQ_PASSWORD') || 'tipi');
  envMap.set('DEMO_MODE', typeof settings.demoMode === 'boolean' ? String(settings.demoMode) : envMap.get('DEMO_MODE') || 'false');
  envMap.set(
    'DISABLE_PASSWORD_RESET',
    typeof settings.disablePasswordReset === 'boolean' ? String(settings.disablePasswordReset) : envMap.get('DISABLE_PASSWORD_RESET') || 'true',
  );
  envMap.set(
    'GUEST_DASHBOARD',
    typeof settings.guestDashboard === 'boolean' ? String(settings.guestDashboard) : envMap.get('GUEST_DASHBOARD') || 'false',
  );
  envMap.set('LOCAL_DOMAIN', settings.localDomain || envMap.get('LOCAL_DOMAIN') || 'tipi.lan');
  envMap.set(
    'ALLOW_AUTO_THEMES',
    typeof settings.allowAutoThemes === 'boolean' ? String(settings.allowAutoThemes) : envMap.get('ALLOW_AUTO_THEMES') || 'true',
  );
  envMap.set(
    'ALLOW_ERROR_MONITORING',
    typeof settings.allowErrorMonitoring === 'boolean' ? String(settings.allowErrorMonitoring) : envMap.get('ALLOW_ERROR_MONITORING') || 'false',
  );
  envMap.set(
    'PERSIST_TRAEFIK_CONFIG',
    typeof settings.persistTraefikConfig === 'boolean' ? String(settings.persistTraefikConfig) : envMap.get('PERSIST_TRAEFIK_CONFIG') || 'false',
  );
  envMap.set(
    'QUEUE_TIMEOUT_IN_MINUTES',
    typeof settings.eventsTimeout === 'number' ? String(settings.eventsTimeout) : envMap.get('QUEUE_TIMEOUT_IN_MINUTES') || '5',
  );
  envMap.set('MAX_BACKUPS', typeof settings.maxBackups === 'number' ? String(settings.maxBackups) : envMap.get('MAX_BACKUPS') || '0');
  envMap.set(
    'ADVANCED_SETTINGS',
    typeof settings.advancedSettings === 'boolean' ? String(settings.advancedSettings) : envMap.get('ADVANCED_SETTINGS') || 'false',
  );
  envMap.set('LOG_LEVEL', settings.logLevel || envMap.get('LOG_LEVEL') || 'info');
  envMap.set('EXPERIMENTAL_INSECURE_COOKIE', settings.experimental_insecureCookie ? 'true' : 'false');
  envMap.set('THEME_BASE', settings.themeBase || envMap.get('THEME_BASE') || 'gray');
  envMap.set('THEME_COLOR', settings.themeColor || envMap.get('THEME_COLOR') || 'blue');

  // CI Cloud integration settings
  envMap.set('CI_CLOUD_API_URL', envMap.get('CI_CLOUD_API_URL') || '');
  envMap.set('CI_CLOUD_FRONTEND_URL', envMap.get('CI_CLOUD_FRONTEND_URL') || '');
  envMap.set('CI_CLOUD_APP_STORE_URL', envMap.get('CI_CLOUD_APP_STORE_URL') || '');
  envMap.set('CI_HUB_ORGANIZATION_ID', envMap.get('CI_HUB_ORGANIZATION_ID') || '');
  envMap.set('CI_HUB_API_KEY', envMap.get('CI_HUB_API_KEY') || '');

  // Only write the env file if values have actually changed to avoid unnecessary overwrites
  // This preserves manual edits to .env while still syncing settings.json changes
  const newEnvContent = envUtils.envMapToString(envMap);
  const currentEnvMap = envUtils.envStringToMap(envFile);

  // Check if any values have changed
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

  // Also check for removed variables
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
    // Try to write the env file, but continue if it's read-only (e.g., mounted as read-only)
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

  dotenv.config({ path: envFilePath, override: true, quiet: true });

  return envMap;
};
