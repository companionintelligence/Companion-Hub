import fs from 'node:fs';
import path from 'node:path';
import { type UserSettingsBody, settingsSchema } from '@/app.dto';
import { APP_DATA_DIR, APP_DIR, ARCHITECTURES, DATA_DIR, DEFAULT_LOCAL_DOMAIN } from '@/common/constants';
import { writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';
import { TranslatableError } from '@/common/error/translatable-error';
import { EnvUtils } from '@/modules/env/env.utils';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import dotenv from 'dotenv';
import { z } from 'zod';
import { LOG_LEVEL_ENUM, type LogLevel, LoggerService } from '../logger/logger.service';

const envSchema = z
  .object({
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
    CI_HUB_VERSION: z.string(),
    JWT_SECRET: z.string(),
    APPS_REPO_URL: z.string().optional(),
    CI_CLOUD_URL: z.string(),
    DOMAIN: z.string(),
    LOCAL_DOMAIN: z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().optional()),
    DNS_IP: z.string().default('9.9.9.9'),
    CI_HUB_APP_DATA_PATH: z.string(),
    CI_HUB_FORWARD_AUTH_URL: z.string(),
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
  })
  .transform((data) => ({
    ...data,
    // When LOCAL_DOMAIN is unset, default to the configured public DOMAIN rather than a
    // hardcoded LAN domain (ci.lan). DEFAULT_LOCAL_DOMAIN remains a last-resort fallback.
    LOCAL_DOMAIN: data.LOCAL_DOMAIN?.trim() || data.DOMAIN?.trim() || DEFAULT_LOCAL_DOMAIN,
  }));

@Injectable()
export class ConfigurationService {
  private config: ReturnType<typeof this.configure>;
  private envPath = path.join(DATA_DIR, '.env');
  private logger: LoggerService;

  // Lowest level, cannot use any other service or module to avoid circular dependencies
  constructor(private readonly envUtils: EnvUtils) {
    // Load data .env as defaults only — .env.local values (already in process.env) take priority.
    // override: false means existing process.env values are NOT clobbered.
    dotenv.config({ path: this.envPath, override: false, quiet: true });
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
    let settingsValues: {
      ciHubApiKey: string | null;
      ciHubOrganizationId: string | null;
      defaultAppCpuLimit?: string;
      defaultAppMemoryLimit?: string;
      autoAllocateAppResources?: boolean;
      inferenceBackend: InferenceBackendType | undefined;
      inferenceModel: string | undefined;
      inferenceEmbeddingModel: string | undefined;
      inferenceVisionModel: string | undefined;
    } = {
      ciHubApiKey: null,
      ciHubOrganizationId: null,
      defaultAppCpuLimit: undefined,
      defaultAppMemoryLimit: undefined,
      autoAllocateAppResources: undefined,
      inferenceBackend: undefined,
      inferenceModel: undefined,
      inferenceEmbeddingModel: undefined,
      inferenceVisionModel: undefined,
    };
    try {
      const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const settings = settingsSchema.partial().parse(parsed);
        settingsValues = {
          ciHubApiKey: settings.ciHubApiKey || null,
          ciHubOrganizationId: settings.ciHubOrganizationId || null,
          defaultAppCpuLimit: settings.defaultAppCpuLimit?.trim() || undefined,
          defaultAppMemoryLimit: settings.defaultAppMemoryLimit?.trim() || undefined,
          autoAllocateAppResources: settings.autoAllocateAppResources,
          inferenceBackend: settings.inferenceBackend,
          inferenceModel: settings.inferenceModel,
          inferenceEmbeddingModel: settings.inferenceEmbeddingModel,
          inferenceVisionModel: settings.inferenceVisionModel,
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
      version: env.data.CI_HUB_VERSION,
      isProduction: NODE_ENV === 'production',
      userSettings: {
        allowAutoThemes: env.data.ALLOW_AUTO_THEMES,
        // Consent plumbing retained; error reporting is always-on when SENTRY_DSN is configured.
        allowErrorMonitoring: true,
        defaultAppCpuLimit: settingsValues.defaultAppCpuLimit,
        defaultAppMemoryLimit: settingsValues.defaultAppMemoryLimit,
        // Auto resource allocation is opt-out: undefined means enabled
        autoAllocateAppResources: settingsValues.autoAllocateAppResources ?? true,
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
        appDataPath: env.data.CI_HUB_APP_DATA_PATH,
        forwardAuthUrl: env.data.CI_HUB_FORWARD_AUTH_URL,
        persistTraefikConfig: env.data.PERSIST_TRAEFIK_CONFIG,
        eventsTimeout: env.data.QUEUE_TIMEOUT_IN_MINUTES,
        advancedSettings: env.data.ADVANCED_SETTINGS,
        logLevel: env.data.LOG_LEVEL,
        maxBackups: env.data.MAX_BACKUPS,
        themeBase: env.data.THEME_BASE,
        themeColor: env.data.THEME_COLOR,
        inferenceBackend: settingsValues.inferenceBackend,
        inferenceModel: settingsValues.inferenceModel,
        inferenceEmbeddingModel: settingsValues.inferenceEmbeddingModel,
        inferenceVisionModel: settingsValues.inferenceVisionModel,
        experimental: {
          insecureCookie: env.data.EXPERIMENTAL_INSECURE_COOKIE,
        },
      },
      domain: env.data.DOMAIN,
      localDomain: env.data.LOCAL_DOMAIN,
      ciCloudUrl: env.data.CI_CLOUD_URL,
      ciHubOrganizationId: settingsValues.ciHubOrganizationId,
      ciHubApiKey: settingsValues.ciHubApiKey,
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

  /** Portal URL for server-side outbound API calls (Docker host bridge when needed). */
  public getOutboundCiCloudUrl(): string {
    const publicUrl = this.config.ciCloudUrl.trim().replace(/\/+$/, '');
    return resolveOutboundPortalBaseUrl(publicUrl, readPortalInternalUrlOverride());
  }

  public async setUserSettings(settings: UserSettingsBody) {
    if (this.config.demoMode) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    try {
      await this.mergeSettingsToDisk(settings);

      this.config.userSettings = { ...this.config.userSettings, ...settings };

      // Update in-memory config for runtime changes
      if (settings.ciHubApiKey) {
        (this.config as Record<string, unknown>).ciHubApiKey = settings.ciHubApiKey;
      }
      if (settings.ciHubOrganizationId) {
        (this.config as Record<string, unknown>).ciHubOrganizationId = settings.ciHubOrganizationId;
      }
    } catch (error) {
      this.logger.error('Failed to set user settings', error);
      throw new InternalServerErrorException('Failed to set user settings');
    }
  }

  /**
   * ISSUE-MCP-2 / ENH-MCP-4: persist MCP admin-managed settings (a rotated agent API key, the
   * destructive-tool gate) to settings.json ONLY — without merging them into the in-memory
   * `userSettings` object that GET /app-context returns. This is what prevents the plaintext MCP
   * API key from being disclosed to every authenticated browser session after a rotation. The
   * caller (McpAdminService) applies the live value to `process.env` for immediate effect; this
   * write is purely for persistence across restarts (env-helpers re-reads settings.json at boot).
   */
  public async persistMcpSettings(settings: { mcpApiKey?: string; mcpAllowDestructive?: boolean }): Promise<void> {
    try {
      await this.mergeSettingsToDisk(settings as UserSettingsBody);
    } catch (error) {
      this.logger.error('Failed to persist MCP settings', error);
      throw new InternalServerErrorException('Failed to persist MCP settings');
    }
  }

  /** Read settings.json, merge in the given partial, and write it back. Disk-only — never mutates
   *  the in-memory config (callers that want the runtime change apply it separately). */
  private async mergeSettingsToDisk(settings: UserSettingsBody): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    const fileContent = await fs.promises.readFile(settingsPath, 'utf8');
    const currentSettingsResult = settingsSchema.partial().safeParse(JSON.parse(fileContent));
    if (!currentSettingsResult.success) {
      throw currentSettingsResult.error.message;
    }
    await writeSettingsJsonFile(settingsPath, `${JSON.stringify({ ...currentSettingsResult.data, ...settings }, null, 2)}`);
  }

  public getInferencePreferences() {
    return {
      preferredBackend: this.config.userSettings.inferenceBackend ?? null,
      preferredModel: this.config.userSettings.inferenceModel ?? null,
      preferredEmbeddingModel: this.config.userSettings.inferenceEmbeddingModel ?? null,
      preferredVisionModel: this.config.userSettings.inferenceVisionModel ?? null,
    };
  }

  /**
   * Persist inference preferences. `model` is the catalog id of the default model Companion agents
   * (Hermes, OpenClaw) and the Hub use by default. Pass `null` to clear it; omit it to leave it
   * unchanged. `embeddingModel` and `visionModel` follow the same convention.
   */
  public async setInferencePreferences(
    backend: InferenceBackendType,
    model?: string | null,
    embeddingModel?: string | null,
    visionModel?: string | null,
  ) {
    const settings: {
      inferenceBackend: InferenceBackendType;
      inferenceModel?: string;
      inferenceEmbeddingModel?: string;
      inferenceVisionModel?: string;
    } = { inferenceBackend: backend };
    if (model !== undefined) {
      settings.inferenceModel = model ?? undefined;
    }
    if (embeddingModel !== undefined) {
      settings.inferenceEmbeddingModel = embeddingModel ?? undefined;
    }
    if (visionModel !== undefined) {
      settings.inferenceVisionModel = visionModel ?? undefined;
    }
    await this.setUserSettings(settings);
    return this.getInferencePreferences();
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
}
