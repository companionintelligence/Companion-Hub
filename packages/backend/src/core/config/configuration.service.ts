import fs from 'node:fs';
import path from 'node:path';
import { type FileOnlySettings, type PersistedSettings, type UserSettingsBody, parsePersistedSettings, settingsFileSchema } from '@/app.dto';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
import { APP_DATA_DIR, APP_DIR, ARCHITECTURES, DATA_DIR, DEFAULT_LOCAL_DOMAIN } from '@/common/constants';
import { ensureSettingsJsonReady, resolveAllowErrorMonitoring, writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import {
  DEFAULT_POOL_HEALTH_POLL_SECONDS,
  DEFAULT_POOL_LOCAL_AFFINITY,
  DEFAULT_POOL_PRESSURE_WEIGHT,
  DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
  type HubPoolPin,
  type HubPoolPreferences,
} from '@/common/helpers/hub-pool';
import type { InferenceSupervisionMode } from '@/common/helpers/inference-supervision';
import { readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';
import { TranslatableError } from '@/common/error/translatable-error';
import { scrubString } from '@/core/error-reporting/sentry-scrubber';
import { setUserConsent } from '@/core/error-reporting/telemetry-consent';
import { EnvUtils } from '@/modules/env/env.utils';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { CloudProviderConfig, InferenceBackendType } from '@ci-hub/common/types';
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
    // Shared HMAC secret for signing the forward-auth X-CI-Hub-User identity header.
    // Provisioned as a Hub<->consumer (CI-Server) shared secret. When unset, the
    // Dedicated Hub<->consumer forward-auth secret, provisioned by
    // generateSystemEnvFile (its own entropy — never JWT_SECRET). Defaults to ''
    // (not JWT_SECRET): an empty value makes the signer throw / guard fail closed
    // rather than silently leaking the master key into a consumer container.
    CI_HUB_FORWARD_AUTH_SECRET: z.string().optional().default(''),
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

function describeSettingsError(error: unknown): string {
  // For an unquoted value, the usual hand-edit mistake, V8's message quotes about ten characters of the
  // file on each side of it, and several settings.json values are credentials (`ciHubApiKey`, cloud
  // provider keys). The scrubber only catches that when a key name lands inside the quote, so keep
  // the position and never the text.
  if (error instanceof SyntaxError) {
    const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(error.message)?.[0];
    return `settings.json is not valid JSON${position ? `, ${position}` : ''}; its content is not logged`;
  }
  if (error instanceof Error) {
    return scrubString(error.stack || error.message);
  }

  return scrubString(String(error));
}

/**
 * The settings.json fields lifted straight out of the file because they have no `.env` equivalent.
 * `ciHubApiKey` is the Hub's Portal credential; losing it looks exactly like an unregistered
 * appliance, which is why this read must never be all-or-nothing.
 */
type PersistedSettingsValues = {
  ciHubApiKey: string | null;
  /**
   * The move key the Portal returned with `ciHubApiKey` at the last pairing: what lets this Hub move
   * itself to another organization. Unlike the device key it is never handed to an app.
   */
  ciHubMoveKey: string | null;
  ciHubOrganizationId: string | null;
  allowErrorMonitoring?: boolean;
  defaultAppCpuLimit?: string;
  defaultAppMemoryLimit?: string;
  autoAllocateAppResources?: boolean;
  inferenceBackend: InferenceBackendType | undefined;
  inferenceModel: string | undefined;
  inferenceEmbeddingModel: string | undefined;
  inferenceVisionModel: string | undefined;
  inferenceVllmApiKey: string | undefined;
  inferenceVllmUrl: string | undefined;
  inferenceMtplxUrl: string | undefined;
  inferenceDsparkUrl: string | undefined;
  inferenceMaxNumCtx: number | undefined;
  inferenceCloudProviders: CloudProviderConfig[] | undefined;
  hubPoolEnabled: boolean | undefined;
  hubPoolOutboundEnabled: boolean | undefined;
  hubPoolInboundEnabled: boolean | undefined;
  hubPoolLocalAffinity: number | undefined;
  hubPoolHealthPollSeconds: number | undefined;
  hubPoolRequireSignedPeers: boolean | undefined;
  hubPoolShareContainerStats: boolean | undefined;
  hubPoolPressureWeight: number | undefined;
  hubPoolMaxPromptTokens: number | undefined;
  hubPoolProbeSnapshotTtlMs: number | undefined;
  inferenceSupervisionMode: InferenceSupervisionMode | undefined;
  inferenceSupervisionPollSeconds: number | undefined;
  hubPoolPins: HubPoolPin[] | undefined;
  hubPoolRouteAppsAlways: boolean | undefined;
};

const EMPTY_PERSISTED_SETTINGS: PersistedSettingsValues = {
  ciHubApiKey: null,
  ciHubMoveKey: null,
  ciHubOrganizationId: null,
  allowErrorMonitoring: undefined,
  defaultAppCpuLimit: undefined,
  defaultAppMemoryLimit: undefined,
  autoAllocateAppResources: undefined,
  inferenceBackend: undefined,
  inferenceModel: undefined,
  inferenceEmbeddingModel: undefined,
  inferenceVisionModel: undefined,
  inferenceVllmApiKey: undefined,
  inferenceVllmUrl: undefined,
  inferenceMtplxUrl: undefined,
  inferenceDsparkUrl: undefined,
  inferenceMaxNumCtx: undefined,
  inferenceCloudProviders: undefined,
  hubPoolEnabled: undefined,
  hubPoolOutboundEnabled: undefined,
  hubPoolInboundEnabled: undefined,
  hubPoolLocalAffinity: undefined,
  hubPoolHealthPollSeconds: undefined,
  hubPoolRequireSignedPeers: undefined,
  hubPoolShareContainerStats: undefined,
  hubPoolPressureWeight: undefined,
  hubPoolMaxPromptTokens: undefined,
  hubPoolProbeSnapshotTtlMs: undefined,
  inferenceSupervisionMode: undefined,
  inferenceSupervisionPollSeconds: undefined,
  hubPoolPins: undefined,
  hubPoolRouteAppsAlways: undefined,
};

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

  /**
   * Lifts the settings.json fields that have no `.env` equivalent, field by field.
   *
   * A single unusable field must not cost the whole file. Parsing settings.json all-or-nothing
   * meant one out-of-range number — a hand edit, or a value a newer build wrote and this one's
   * bounds reject — booted the Hub with `ciHubApiKey: null` and every inference preference
   * forgotten. That is indistinguishable from an unregistered appliance, it was silent (the parse
   * failure was swallowed by an empty catch), and it self-perpetuated: the next settings write
   * persisted the emptied values.
   */
  private readPersistedSettings(): PersistedSettingsValues {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');

    let raw: unknown;
    try {
      if (!fs.existsSync(settingsPath)) {
        return { ...EMPTY_PERSISTED_SETTINGS };
      }
      raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      this.logger.error(`Could not read ${settingsPath}; continuing without persisted settings: ${describeSettingsError(error)}`);
      return { ...EMPTY_PERSISTED_SETTINGS };
    }

    const { settings, invalidKeys, unreadable } = parsePersistedSettings(raw);
    if (unreadable) {
      this.logger.error(`${settingsPath} does not contain a JSON object; continuing without persisted settings.`);
    } else if (invalidKeys.length > 0) {
      // Field names only — several of these fields hold credentials.
      this.logger.warn(`Ignoring unusable settings.json field(s): ${invalidKeys.join(', ')}. Every other field was applied.`);
    }

    return {
      ciHubApiKey: settings.ciHubApiKey || null,
      ciHubMoveKey: settings.ciHubMoveKey || null,
      ciHubOrganizationId: settings.ciHubOrganizationId || null,
      allowErrorMonitoring: settings.allowErrorMonitoring,
      defaultAppCpuLimit: settings.defaultAppCpuLimit?.trim() || undefined,
      defaultAppMemoryLimit: settings.defaultAppMemoryLimit?.trim() || undefined,
      autoAllocateAppResources: settings.autoAllocateAppResources,
      inferenceBackend: settings.inferenceBackend,
      inferenceModel: settings.inferenceModel,
      inferenceEmbeddingModel: settings.inferenceEmbeddingModel,
      inferenceVisionModel: settings.inferenceVisionModel,
      inferenceVllmApiKey: settings.inferenceVllmApiKey,
      inferenceVllmUrl: settings.inferenceVllmUrl,
      inferenceMtplxUrl: settings.inferenceMtplxUrl,
      inferenceDsparkUrl: settings.inferenceDsparkUrl,
      inferenceMaxNumCtx: settings.inferenceMaxNumCtx,
      inferenceCloudProviders: settings.inferenceCloudProviders,
      hubPoolEnabled: settings.hubPoolEnabled,
      hubPoolOutboundEnabled: settings.hubPoolOutboundEnabled,
      hubPoolInboundEnabled: settings.hubPoolInboundEnabled,
      hubPoolLocalAffinity: settings.hubPoolLocalAffinity,
      hubPoolHealthPollSeconds: settings.hubPoolHealthPollSeconds,
      hubPoolRequireSignedPeers: settings.hubPoolRequireSignedPeers,
      hubPoolShareContainerStats: settings.hubPoolShareContainerStats,
      hubPoolPressureWeight: settings.hubPoolPressureWeight,
      hubPoolMaxPromptTokens: settings.hubPoolMaxPromptTokens,
      hubPoolProbeSnapshotTtlMs: settings.hubPoolProbeSnapshotTtlMs,
      inferenceSupervisionMode: settings.inferenceSupervisionMode,
      inferenceSupervisionPollSeconds: settings.inferenceSupervisionPollSeconds,
      hubPoolPins: settings.hubPoolPins,
      hubPoolRouteAppsAlways: settings.hubPoolRouteAppsAlways,
    };
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
    const settingsValues = this.readPersistedSettings();

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
        // The user's error-reporting consent. This used to be hardcoded `true`, which
        // silently discarded the switch on every boot. The precedence now lives in one
        // shared resolver rather than being restated here — `generateSystemEnvFile` had
        // written the opposite order into the resolved env.
        allowErrorMonitoring: resolveAllowErrorMonitoring({ setting: settingsValues.allowErrorMonitoring, env: env.data.ALLOW_ERROR_MONITORING }),
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
        inferenceVllmApiKey: settingsValues.inferenceVllmApiKey,
        inferenceVllmUrl: settingsValues.inferenceVllmUrl,
        inferenceMtplxUrl: settingsValues.inferenceMtplxUrl,
        inferenceDsparkUrl: settingsValues.inferenceDsparkUrl,
        inferenceMaxNumCtx: settingsValues.inferenceMaxNumCtx,
        inferenceCloudProviders: settingsValues.inferenceCloudProviders,
        // Left tri-state on purpose: `undefined` (never touched) and `false` (operator turned it
        // off) mean the same thing to routing but different things to the UI, which distinguishes
        // "on by default" from "you disabled this here".
        hubPoolEnabled: settingsValues.hubPoolEnabled,
        hubPoolOutboundEnabled: settingsValues.hubPoolOutboundEnabled,
        hubPoolInboundEnabled: settingsValues.hubPoolInboundEnabled,
        hubPoolLocalAffinity: settingsValues.hubPoolLocalAffinity,
        hubPoolHealthPollSeconds: settingsValues.hubPoolHealthPollSeconds,
        hubPoolRequireSignedPeers: settingsValues.hubPoolRequireSignedPeers,
        hubPoolShareContainerStats: settingsValues.hubPoolShareContainerStats,
        hubPoolPressureWeight: settingsValues.hubPoolPressureWeight,
        hubPoolMaxPromptTokens: settingsValues.hubPoolMaxPromptTokens,
        hubPoolProbeSnapshotTtlMs: settingsValues.hubPoolProbeSnapshotTtlMs,
        inferenceSupervisionMode: settingsValues.inferenceSupervisionMode,
        inferenceSupervisionPollSeconds: settingsValues.inferenceSupervisionPollSeconds,
        hubPoolPins: settingsValues.hubPoolPins,
        hubPoolRouteAppsAlways: settingsValues.hubPoolRouteAppsAlways,
        experimental: {
          insecureCookie: env.data.EXPERIMENTAL_INSECURE_COOKIE,
        },
      },
      domain: env.data.DOMAIN,
      localDomain: env.data.LOCAL_DOMAIN,
      ciCloudUrl: env.data.CI_CLOUD_URL,
      ciHubOrganizationId: settingsValues.ciHubOrganizationId,
      ciHubApiKey: settingsValues.ciHubApiKey,
      ciHubMoveKey: settingsValues.ciHubMoveKey,
      architecture: env.data.ARCHITECTURE,
      demoMode: env.data.DEMO_MODE,
      rootFolderHost: env.data.ROOT_FOLDER_HOST,
      envFilePath: this.envPath,
      internalIp: env.data.INTERNAL_IP,
      jwtSecret: env.data.JWT_SECRET,
      // Dedicated secret provisioned by generateSystemEnvFile. Intentionally NOT
      // falling back to JWT_SECRET: this value is injected into consumer app
      // containers (e.g. ci-memory), so it must never be the Hub's master key.
      // Empty (misprovisioned) → the signer throws / the guard fails closed.
      forwardAuthSecret: env.data.CI_HUB_FORWARD_AUTH_SECRET,
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

      // Publish error-reporting consent to the `beforeSend` gate so flipping the
      // switch takes effect on the very next capture rather than after the
      // consent cache TTL — and, before this, rather than never.
      if (typeof settings.allowErrorMonitoring === 'boolean') {
        setUserConsent(settings.allowErrorMonitoring);
      }

      // Update in-memory config for runtime changes.
      if (settings.ciHubApiKey) {
        (this.config as Record<string, unknown>).ciHubApiKey = settings.ciHubApiKey;
      }
      if (settings.ciHubMoveKey) {
        (this.config as Record<string, unknown>).ciHubMoveKey = settings.ciHubMoveKey;
      }
      if (settings.ciHubOrganizationId) {
        (this.config as Record<string, unknown>).ciHubOrganizationId = settings.ciHubOrganizationId;
      }
    } catch (error) {
      this.logger.error(`Failed to set user settings: ${describeSettingsError(error)}; attemptedKeys=${Object.keys(settings).join(',') || '(none)'}`);
      throw new InternalServerErrorException('Failed to set user settings');
    }
  }

  /**
   * Persist settings.json keys that another module owns (see `FileOnlySettings`). Disk only: these
   * keys have no in-memory mirror here, and their owner reads them back from the file.
   *
   * Owners must come through here rather than read-modify-write the file themselves. A private
   * writer is how `autoUpdates` went undeclared and got stripped by every other write. The one
   * SystemUpdateService had also answered a file it could not read or parse (including one caught
   * mid-write by a concurrent save) by writing back only its own key, erasing the Portal credential.
   * No demo-mode refusal: the auto-update switch never had one, and this keeps its behaviour.
   *
   * Failures are logged and rethrown the way `setUserSettings` does it. Left raw, a parse error
   * reached the global exception filter, which logs the exception as-is, and V8's message for an
   * unquoted value quotes the file around it.
   */
  public async setFileOnlySettings(settings: FileOnlySettings): Promise<void> {
    try {
      await this.mergeSettingsToDisk(settings);
    } catch (error) {
      this.logger.error(`Failed to save settings: ${describeSettingsError(error)}; attemptedKeys=${Object.keys(settings).join(',') || '(none)'}`);
      throw new InternalServerErrorException('Failed to save settings');
    }
  }

  /** Read settings.json, merge in the given partial, and write it back. Disk-only — never mutates
   *  the in-memory config (callers that want the runtime change apply it separately).
   *
   *  Unusable fields already on disk are dropped rather than refused. Refusing them made a single
   *  out-of-range value 500 every settings write from then on, including the write that would have
   *  corrected it — so the only way out was to edit the file by hand. Dropping is safe here because
   *  the boot path already ignores those fields (see {@link parsePersistedSettings}); this just
   *  stops carrying a value nothing can read forward. */
  private async mergeSettingsToDisk(settings: PersistedSettings): Promise<void> {
    const settingsPath = path.join(DATA_DIR, 'state', 'settings.json');
    await ensureSettingsJsonReady(settingsPath);
    const fileContent = await fs.promises.readFile(settingsPath, 'utf8');
    const raw: unknown = JSON.parse(fileContent);
    const current = parsePersistedSettings(raw);
    // The parse strips keys this build does not declare, on purpose (see `settingsFileSchema`). Name
    // them, so a drop is visible: `autoUpdates` went unnoticed on the fleet, and a node that runs an
    // older build after a newer one (a trial image, a branch build on core-14) loses that build's keys
    // here. Names only; the values can be credentials.
    const undeclared = current.unreadable ? [] : Object.keys(raw as object).filter((key) => !Object.hasOwn(settingsFileSchema.shape, key));
    if (undeclared.length > 0) {
      this.logger.warn(`Dropping settings.json key(s) this build does not declare: ${scrubString(undeclared.slice(0, 20).join(', '))}.`);
    }
    if (current.unreadable) {
      this.logger.warn(`${settingsPath} does not contain a JSON object; replacing it with the settings being written.`);
    } else if (current.invalidKeys.length > 0) {
      this.logger.warn(`Dropping unusable settings.json field(s) while saving: ${current.invalidKeys.join(', ')}.`);
    }
    await writeSettingsJsonFile(settingsPath, `${JSON.stringify({ ...current.settings, ...settings }, null, 2)}`);
  }

  public getInferencePreferences() {
    return {
      preferredBackend: this.config.userSettings.inferenceBackend ?? null,
      preferredModel: this.config.userSettings.inferenceModel ?? null,
      preferredEmbeddingModel: this.config.userSettings.inferenceEmbeddingModel ?? null,
      preferredVisionModel: this.config.userSettings.inferenceVisionModel ?? null,
      preferredVllmApiKey: this.config.userSettings.inferenceVllmApiKey ?? null,
      preferredVllmUrl: this.config.userSettings.inferenceVllmUrl ?? null,
      preferredMtplxUrl: this.config.userSettings.inferenceMtplxUrl ?? null,
      preferredDsparkUrl: this.config.userSettings.inferenceDsparkUrl ?? null,
      // `null` is no cap: the handout is sized from the model window and this node's memory alone,
      // as before the cap existed. Clamped on read, so a value an older build persisted out of this
      // build's bounds reads as no cap instead of starving an app. See `inference-context-cap.ts`.
      maxNumCtx: clampContextCap(this.config.userSettings.inferenceMaxNumCtx),
    };
  }

  /**
   * Persist inference preferences. `model` is the catalog id of the default model Companion agents
   * (Hermes, OpenClaw) and the Hub use by default. Pass `null` to clear it; omit it to leave it
   * unchanged. `embeddingModel`, `visionModel`, and `maxNumCtx` follow the same convention; a
   * cleared `maxNumCtx` removes the key rather than storing a null, like the pool prompt ceiling.
   */
  public async setInferencePreferences(
    backend: InferenceBackendType,
    model?: string | null,
    embeddingModel?: string | null,
    visionModel?: string | null,
    vllmApiKey?: string | null,
    vllmUrl?: string | null,
    mtplxUrl?: string | null,
    dsparkUrl?: string | null,
    maxNumCtx?: number | null,
  ) {
    const settings: {
      inferenceBackend: InferenceBackendType;
      inferenceModel?: string;
      inferenceEmbeddingModel?: string;
      inferenceVisionModel?: string;
      inferenceVllmApiKey?: string;
      inferenceVllmUrl?: string;
      inferenceMtplxUrl?: string;
      inferenceDsparkUrl?: string;
      inferenceMaxNumCtx?: number;
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
    if (vllmApiKey !== undefined) {
      settings.inferenceVllmApiKey = vllmApiKey?.trim() ? vllmApiKey.trim() : undefined;
    }
    if (vllmUrl !== undefined) {
      settings.inferenceVllmUrl = vllmUrl?.trim() ? vllmUrl.trim() : undefined;
    }
    if (mtplxUrl !== undefined) {
      settings.inferenceMtplxUrl = mtplxUrl?.trim() ? mtplxUrl.trim() : undefined;
    }
    if (dsparkUrl !== undefined) {
      settings.inferenceDsparkUrl = dsparkUrl?.trim() ? dsparkUrl.trim() : undefined;
    }
    if (maxNumCtx !== undefined) {
      settings.inferenceMaxNumCtx = maxNumCtx ?? undefined;
    }
    await this.setUserSettings(settings);
    return this.getInferencePreferences();
  }

  /**
   * Operator-editable Hub Pool tuning. `poolEnabled` here is the *persisted* switch only — it says
   * nothing about `HUB_POOL_USER_DISABLED`, which overrides it. Resolve the two with
   * `resolveHubPoolEnabled(prefs.poolEnabled)` rather than reading this field as the effective state.
   */
  public getHubPoolPreferences(): HubPoolPreferences {
    return {
      poolEnabled: this.config.userSettings.hubPoolEnabled ?? true,
      poolOutboundEnabled: this.config.userSettings.hubPoolOutboundEnabled ?? true,
      poolInboundEnabled: this.config.userSettings.hubPoolInboundEnabled ?? true,
      poolLocalAffinity: this.config.userSettings.hubPoolLocalAffinity ?? DEFAULT_POOL_LOCAL_AFFINITY,
      poolHealthPollSeconds: this.config.userSettings.hubPoolHealthPollSeconds ?? DEFAULT_POOL_HEALTH_POLL_SECONDS,
      // `?? false`, not `?? true`: this is the one pool switch that is opt-IN, because it removes a
      // code path older peers still depend on. See `HubPoolPreferences.poolRequireSignedPeers`.
      poolRequireSignedPeers: this.config.userSettings.hubPoolRequireSignedPeers ?? false,
      // `?? true`: the container rollup is an opt-OUT, like the three switches above and unlike the
      // one directly before it. See `HubPoolPreferences.poolShareContainerStats` for the trade.
      poolShareContainerStats: this.config.userSettings.hubPoolShareContainerStats ?? true,
      poolPressureWeight: this.config.userSettings.hubPoolPressureWeight ?? DEFAULT_POOL_PRESSURE_WEIGHT,
      // `?? null`: no ceiling is the default, and a cleared ceiling is an absent key rather than a
      // stored null — see `setHubPoolPreferences`.
      poolMaxPromptTokens: this.config.userSettings.hubPoolMaxPromptTokens ?? null,
      poolProbeSnapshotTtlMs: this.config.userSettings.hubPoolProbeSnapshotTtlMs ?? DEFAULT_POOL_PROBE_SNAPSHOT_TTL_MS,
      // A fresh array every read, so a caller that sorts or splices what it got cannot mutate the
      // in-memory settings the next request will rank against.
      poolPins: [...(this.config.userSettings.hubPoolPins ?? [])],
      // `?? true`: opt-OUT. See `HubPoolPreferences.poolRouteAppsAlways` for the measurement behind it.
      poolRouteAppsAlways: this.config.userSettings.hubPoolRouteAppsAlways ?? true,
    };
  }

  /**
   * Persist Hub Pool tuning. Every field is optional and `undefined` leaves it unchanged. The prompt
   * ceiling is the one field with a "clear" state, because its default is the absence of a value:
   * `null` removes the key from settings.json rather than storing a null the boot parse would have to
   * understand.
   */
  public async setHubPoolPreferences(preferences: Partial<HubPoolPreferences>): Promise<HubPoolPreferences> {
    const settings: {
      hubPoolEnabled?: boolean;
      hubPoolOutboundEnabled?: boolean;
      hubPoolInboundEnabled?: boolean;
      hubPoolLocalAffinity?: number;
      hubPoolHealthPollSeconds?: number;
      hubPoolRequireSignedPeers?: boolean;
      hubPoolShareContainerStats?: boolean;
      hubPoolPressureWeight?: number;
      hubPoolMaxPromptTokens?: number;
      hubPoolProbeSnapshotTtlMs?: number;
      hubPoolPins?: HubPoolPin[];
      hubPoolRouteAppsAlways?: boolean;
    } = {};
    if (preferences.poolEnabled !== undefined) {
      settings.hubPoolEnabled = preferences.poolEnabled;
    }
    if (preferences.poolOutboundEnabled !== undefined) {
      settings.hubPoolOutboundEnabled = preferences.poolOutboundEnabled;
    }
    if (preferences.poolInboundEnabled !== undefined) {
      settings.hubPoolInboundEnabled = preferences.poolInboundEnabled;
    }
    if (preferences.poolLocalAffinity !== undefined) {
      settings.hubPoolLocalAffinity = preferences.poolLocalAffinity;
    }
    if (preferences.poolHealthPollSeconds !== undefined) {
      settings.hubPoolHealthPollSeconds = preferences.poolHealthPollSeconds;
    }
    if (preferences.poolRequireSignedPeers !== undefined) {
      settings.hubPoolRequireSignedPeers = preferences.poolRequireSignedPeers;
    }
    if (preferences.poolShareContainerStats !== undefined) {
      settings.hubPoolShareContainerStats = preferences.poolShareContainerStats;
    }
    if (preferences.poolPressureWeight !== undefined) {
      settings.hubPoolPressureWeight = preferences.poolPressureWeight;
    }
    // An explicit `undefined` value, not a skipped key: `mergeSettingsToDisk` spreads it over the file
    // and JSON drops it, which is how the ceiling is cleared, while the key's presence still counts as
    // a change for the no-op guard below.
    if (preferences.poolMaxPromptTokens !== undefined) {
      settings.hubPoolMaxPromptTokens = preferences.poolMaxPromptTokens ?? undefined;
    }
    if (preferences.poolProbeSnapshotTtlMs !== undefined) {
      settings.hubPoolProbeSnapshotTtlMs = preferences.poolProbeSnapshotTtlMs;
    }
    // The whole list, never a delta: pins have no per-row identity in settings.json, so the pin
    // service computes the next array and this persists it. `undefined` still means "leave alone",
    // which is what keeps every other pool PATCH from wiping an operator's pins.
    if (preferences.poolPins !== undefined) {
      settings.hubPoolPins = preferences.poolPins;
    }
    if (preferences.poolRouteAppsAlways !== undefined) {
      settings.hubPoolRouteAppsAlways = preferences.poolRouteAppsAlways;
    }
    // A no-op PATCH must not rewrite settings.json: every write is a read-modify-write of the whole
    // file with no locking, so an empty one can still clobber a concurrent inference-preferences save.
    if (Object.keys(settings).length > 0) {
      await this.setUserSettings(settings);
    }
    return this.getHubPoolPreferences();
  }

  /**
   * Inference-backend observation mode as persisted. `undefined` means the operator has never
   * chosen, which `resolveInferenceSupervisionMode` reads as `'off'` — the default is opt-in
   * precisely so an untouched appliance keeps doing no polling at all.
   */
  public getInferenceSupervisionMode(): InferenceSupervisionMode | undefined {
    return this.config.userSettings.inferenceSupervisionMode;
  }

  /** Persisted observation interval in seconds; `undefined` falls back to DEFAULT_SUPERVISION_POLL_SECONDS. */
  public getInferenceSupervisionPollSeconds(): number | undefined {
    return this.config.userSettings.inferenceSupervisionPollSeconds;
  }

  public getInferenceCloudProviders(): CloudProviderConfig[] {
    return this.config.userSettings.inferenceCloudProviders ?? [];
  }

  public async setInferenceCloudProviders(providers: CloudProviderConfig[]) {
    await this.setUserSettings({ inferenceCloudProviders: providers });
    return this.getInferenceCloudProviders();
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
