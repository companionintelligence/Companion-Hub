import fs from 'node:fs';
import path from 'node:path';
import { type UserSettingsBody, settingsSchema } from '@/app.dto';
import { APP_DATA_DIR, APP_DIR, ARCHITECTURES, DATA_DIR } from '@/common/constants';
import { TranslatableError } from '@/common/error/translatable-error';
import { EnvUtils } from '@/modules/env/env.utils';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import dotenv from 'dotenv';
import { z } from 'zod';
import { LOG_LEVEL_ENUM, type LogLevel, LoggerService } from '../logger/logger.service';
import { type } from 'arktype';

const envSchema = z.object({
  POSTGRES_HOST: z.string(),
  POSTGRES_DBNAME: z.string(),
  POSTGRES_USERNAME: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_PORT: z.coerce.number().default(6543),
  RABBITMQ_HOST: z.string(),
  RABBITMQ_USERNAME: z.string(),
  RABBITMQ_PASSWORD: z.string(),
  RABBITMQ_PORT: z.coerce.number().default(5672),
  ARCHITECTURE: z.enum(ARCHITECTURES).default('amd64'),
  INTERNAL_IP: z.string(),
  TIPI_VERSION: z.string(),
  JWT_SECRET: z.string(),
  APPS_REPO_URL: z.string().optional(),
  CI_CLOUD_URL: z.string(),
  CI_CLOUD_FRONTEND_URL: z.string(),
  DOMAIN: z.string(),
  LOCAL_DOMAIN: z.string(),
  DNS_IP: z.string().default('9.9.9.9'),
  RUNTIPI_APP_DATA_PATH: z.string(),
  RUNTIPI_FORWARD_AUTH_URL: z.string(),
  DEMO_MODE: z.string().transform((val) => val.toLowerCase() === 'true'),
  DISABLE_PASSWORD_RESET: z
    .string()
    .transform((val) => val.toLowerCase() === 'true')
    .default(true),
  GUEST_DASHBOARD: z.string().transform((val) => val.toLowerCase() === 'true'),
  ALLOW_ERROR_MONITORING: z.string().transform((val) => val.toLowerCase() === 'true'),
  ALLOW_AUTO_THEMES: z.string().transform((val) => val.toLowerCase() === 'true'),
  PERSIST_TRAEFIK_CONFIG: z.string().transform((val) => val.toLowerCase() === 'true'),
  QUEUE_TIMEOUT_IN_MINUTES: z.coerce.number().default(5),
  LOG_LEVEL: z.enum(LOG_LEVEL_ENUM).default('info').catch('info'),
  TZ: z.string(),
  ROOT_FOLDER_HOST: z.string(),
  NGINX_PORT: z.coerce.number().default(80),
  NGINX_PORT_SSL: z.coerce.number().default(443),
  ADVANCED_SETTINGS: z.string().transform((val) => val.toLowerCase() === 'true'),
  THEME_BASE: z.string(),
  THEME_COLOR: z.string(),
  MAX_BACKUPS: z.coerce.number().default(0),
  // Experimental flags
  EXPERIMENTAL_INSECURE_COOKIE: z.string().transform((val) => val.toLowerCase() === 'true'),
});

@Injectable()
export class ConfigurationService {
  private config: ReturnType<typeof this.configure>;
  private envPath = path.join(DATA_DIR, '.env');
  private logger: LoggerService;

  // Lowest level, cannot use any other service or module to avoid circular dependencies
  constructor(private readonly envUtils: EnvUtils) {
    // Preserve .env.local values (loaded first by NestJS/dotenv) before loading data .env
    const preservedEnv: Record<string, string> = {};
    for (const key of ['DOMAIN', 'LOCAL_DOMAIN']) {
      if (process.env[key]) preservedEnv[key] = process.env[key]!;
    }

    dotenv.config({ path: this.envPath, override: true, quiet: true });

    // Restore .env.local values — they take priority over data .env
    for (const [key, value] of Object.entries(preservedEnv)) {
      process.env[key] = value;
    }

    this.logger = new LoggerService('backend', path.join(DATA_DIR, 'logs'), process.env.LOG_LEVEL as LogLevel);
    this.config = this.configure();
  }

  private getEnvMap() {
    let envFile = '';
    try {
      envFile = fs.readFileSync(this.envPath).toString();
    } catch (_) {
      this.logger.error('❌ .env file not found');
    }

    return this.envUtils.envStringToMap(envFile.toString());
  }

  private configure() {
    const envMap = this.getEnvMap();

    const conf = { ...Object.fromEntries(envMap), ...process.env } as Record<string, string>;

    const env = envSchema.safeParse(conf);

    if (!env.success) {
      this.logger.error(env.error);
      throw new Error(`❌ Invalid environment variables ${JSON.stringify(env.error, null, 2)}`);
    }

    this.logger = new LoggerService('backend', path.join(DATA_DIR, 'logs'), env.data.LOG_LEVEL);

    const { NODE_ENV } = process.env;

    // Load settings.json manually to get credentials, bypassing .env
    let settingsCreds = { ciHubApiKey: null, ciHubOrganizationId: null };
    try {
      const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        settingsCreds = {
          ciHubApiKey: settings.ciHubApiKey || null,
          ciHubOrganizationId: settings.ciHubOrganizationId || null,
        };
      }
    } catch (_e) {
      // ignore
    }

    return {
      database: {
        host: env.data.POSTGRES_HOST,
        port: env.data.POSTGRES_PORT,
        username: env.data.POSTGRES_USERNAME,
        password: env.data.POSTGRES_PASSWORD,
        database: env.data.POSTGRES_DBNAME,
      },
      queue: {
        host: env.data.RABBITMQ_HOST,
        username: env.data.RABBITMQ_USERNAME,
        password: env.data.RABBITMQ_PASSWORD,
        port: env.data.RABBITMQ_PORT,
      },
      directories: {
        dataDir: DATA_DIR,
        appDataDir: APP_DATA_DIR,
        appDir: APP_DIR,
      },
      logLevel: env.data.LOG_LEVEL,
      version: env.data.TIPI_VERSION,
      isProduction: NODE_ENV === 'production',
      userSettings: {
        allowAutoThemes: env.data.ALLOW_AUTO_THEMES,
        allowErrorMonitoring: env.data.ALLOW_ERROR_MONITORING && NODE_ENV === 'production',
        demoMode: env.data.DEMO_MODE,
        disablePasswordReset: env.data.DISABLE_PASSWORD_RESET,
        guestDashboard: env.data.GUEST_DASHBOARD,
        timeZone: env.data.TZ,
        domain: env.data.DOMAIN,
        localDomain: env.data.LOCAL_DOMAIN,
        port: env.data.NGINX_PORT || 80,
        sslPort: env.data.NGINX_PORT_SSL || 443,
        listenIp: env.data.INTERNAL_IP, // TODO: Check if this is correct
        internalIp: env.data.INTERNAL_IP,
        postgresPort: env.data.POSTGRES_PORT,
        dnsIp: env.data.DNS_IP,
        appDataPath: env.data.RUNTIPI_APP_DATA_PATH,
        forwardAuthUrl: env.data.RUNTIPI_FORWARD_AUTH_URL,
        persistTraefikConfig: env.data.PERSIST_TRAEFIK_CONFIG,
        eventsTimeout: env.data.QUEUE_TIMEOUT_IN_MINUTES,
        advancedSettings: env.data.ADVANCED_SETTINGS,
        logLevel: env.data.LOG_LEVEL,
        maxBackups: env.data.MAX_BACKUPS,
        themeBase: env.data.THEME_BASE,
        themeColor: env.data.THEME_COLOR,
        experimental: {
          insecureCookie: env.data.EXPERIMENTAL_INSECURE_COOKIE,
        },
      },
      domain: env.data.DOMAIN,
      localDomain: env.data.LOCAL_DOMAIN,
      ciCloudUrl: env.data.CI_CLOUD_URL,
      ciCloudAppStoreUrl: `${env.data.CI_CLOUD_URL}/api`,
      ciCloudApiUrl: `${env.data.CI_CLOUD_URL}/api`,
      ciCloudFrontendUrl: env.data.CI_CLOUD_FRONTEND_URL,
      ciHubOrganizationId: settingsCreds.ciHubOrganizationId,
      ciHubApiKey: settingsCreds.ciHubApiKey,
      architecture: env.data.ARCHITECTURE,
      demoMode: env.data.DEMO_MODE,
      rootFolderHost: env.data.ROOT_FOLDER_HOST,
      envFilePath: this.envPath,
      internalIp: env.data.INTERNAL_IP,
      jwtSecret: env.data.JWT_SECRET,
      __prod__: NODE_ENV === 'production',
    };
  }

  public getConfig() {
    return this.config;
  }

  public get<T extends keyof ReturnType<typeof this.configure>>(key: T) {
    return this.config[key];
  }

  public async setUserSettings(settings: UserSettingsBody) {
    if (this.config.demoMode) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    try {
      this.initSentry({ release: this.config.version, allowSentry: Boolean(settings.allowErrorMonitoring) });

      const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');

      const fileContent = await fs.promises.readFile(settingsPath, 'utf8');
      const parsedContent = JSON.parse(fileContent);
      const currentSettingsResult = settingsSchema.partial()(parsedContent);
      if (currentSettingsResult instanceof type.errors) {
        throw currentSettingsResult.summary;
      }
      const currentSettings = currentSettingsResult;

      await fs.promises.writeFile(settingsPath, `${JSON.stringify({ ...currentSettings, ...settings }, null, 2)}`, 'utf8');

      this.config.userSettings = { ...this.config.userSettings, ...settings };

      // Update in-memory config for runtime changes
      if (settings.ciHubApiKey) {
        // @ts-expect-error
        this.config.ciHubApiKey = settings.ciHubApiKey;
      }
      if (settings.ciHubOrganizationId) {
        // @ts-expect-error
        this.config.ciHubOrganizationId = settings.ciHubOrganizationId;
      }
    } catch (error) {
      this.logger.error('Failed to set user settings', error);
      throw new InternalServerErrorException('Failed to set user settings');
    }
  }

  /**
   * Update the DOMAIN value in the data .env file and in-memory config.
   * Called after registration when the real domain is known.
   */
  public async setDomain(domain: string) {
    try {
      let envFile = '';
      try {
        envFile = fs.readFileSync(this.envPath, 'utf8');
      } catch {
        // file may not exist yet
      }

      const envMap = this.envUtils.envStringToMap(envFile);
      envMap.set('DOMAIN', domain);
      const newContent = this.envUtils.envMapToString(envMap);
      await fs.promises.writeFile(this.envPath, newContent, 'utf8');

      // Update in-memory config
      this.config.domain = domain;
      this.config.userSettings.domain = domain;

      this.logger.info(`Updated DOMAIN in data .env to: ${domain}`);
    } catch (error) {
      this.logger.error('Failed to update DOMAIN in .env', error);
    }
  }

  public async initSentry(params: { release: string; allowSentry: boolean }) {
    const { allowSentry } = params;

    const client = Sentry.getClient();

    if (!client) {
      return;
    }

    if (allowSentry) {
      client.getOptions().enabled = true;
    } else {
      await client.close();
    }
  }
}
