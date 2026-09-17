import { randomBytes } from 'node:crypto';
import { hubContainerName } from '@/common/constants';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { buildHubLocalOrigin, buildHubPublicOrigin, buildHubTailnetOrigin } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AppInfo, MemoryUrlStyle, HubIntegration } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { normalizeStoredHostname } from '@ci-hub/common/types';
import { buildFqdnSubdomain, buildPublicWebIdentity, resolvePublicDomainRoot, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { EnvUtils } from '../env/env.utils';
import type { AppEventFormInput } from '../queue/entities/app-events';
import { AppFilesManager } from './app-files-manager';
import { AppsRepository } from './apps.repository';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { RegistrationService } from '../registration/registration.service';
import { appMinContextLength } from '../inference/context-length.util';
import { InferenceEnvResolver, type StandardizedAiEnv } from '../inference/inference-env-resolver';
import { applyCloudProviderEnv, cloudProviderManagedKeys } from '../inference/cloud-provider-env';
import { INFERENCE_ERROR_ENV_KEY } from '../inference/app-model-handout';
import { ApiKeyService } from '../api-keys/api-key.service';
import type { ApiKeyScope } from '../api-keys/api-key.scopes';
import { isOfficialStoreApp } from './official-store.predicate';
import { MemoryConnectionService } from '../memory-connect/memory-connection.service';
import { GATEWAY_API_PREFIX } from '../memory-connect/memory-exchange.client';
import { isMemoryProviderApp } from '../memory-connect/memory-provider.predicate';
import { mergeFormFieldDefaults } from '@ci-hub/common/validation';

/**
 * Companion Hub secrets that must never reach an app container.
 *
 * `generateEnvFile` starts each app environment from the Hub's `.env`. Without
 * this filter, every `app.env` and container `env_file` would receive these
 * values, including apps from third-party stores.
 *
 * - `CI_HUB_FORWARD_AUTH_SECRET` signs connect exchange, rotation, and revocation
 *   calls, as well as the forward-auth identity header. The memory provider
 *   receives the Hub-wide value below. First-party consumers receive separate
 *   per-app secrets so the provider gate remains effective.
 * - `JWT_SECRET` is the Hub's signing key. `MCP_API_KEY` remains blocked even
 *   though the Hub no longer creates it (SEC-MCP-8), because upgraded appliances
 *   can retain the obsolete value.
 * - `POSTGRES_PASSWORD` is the Hub database password. The stock `postgres` image
 *   reads this value from its environment, so a leak could also configure another
 *   database with the same password.
 *
 * Apps can still use these variable names through their own `form_fields`. The
 * form-field loop runs after this filter and restores the app-owned value or
 * generates a new one. This filter removes only values inherited from the Hub.
 *
 * A denylist exposes each new Hub secret by default. A future allowlist can use
 * the marketplace's `HUB_PROVIDED_VARS` inventory as its source.
 */
const HUB_ONLY_SECRET_ENV_VARS = ['CI_HUB_FORWARD_AUTH_SECRET', 'JWT_SECRET', 'MCP_API_KEY', 'POSTGRES_PASSWORD'] as const;

/**
 * Formats the brokered Companion Memory address as the consuming app declares.
 *
 * The provider is reachable at `http://<service>:<port>`, but its gateway proxies
 * the API only under `/api/` and strips that prefix before forwarding. Apps that
 * build `/api/...` paths need the bare origin. Apps that append server-local paths
 * to an API base need `<origin>/api`. The gateway serves its SPA instead of
 * returning a 404 for the wrong shape, so the manifest must declare the format.
 */
function memoryUrlForStyle(brokeredUrl: string, style: MemoryUrlStyle | undefined): string {
  if (style !== 'api_base') {
    return brokeredUrl;
  }

  return `${brokeredUrl.replace(/\/+$/, '')}${GATEWAY_API_PREFIX}`;
}

const HUB_INFERENCE_RESOLVED: Record<string, keyof StandardizedAiEnv> = {
  llm_base_url: 'CI_LLM_BASE_URL',
  llm_api_key: 'CI_LLM_API_KEY',
  chat_model: 'CI_CHAT_MODEL',
  embedding_model: 'CI_EMBEDDING_MODEL',
  vision_model: 'CI_VISION_MODEL',
  ollama_host: 'OLLAMA_HOST',
  ollama_embed_host: 'CI_OLLAMA_EMBED_HOST',
  num_ctx: 'CI_LLM_NUM_CTX',
};

/** What {@link AppHelpers.buildInferenceEnv} produces for one app. */
export interface InferenceEnvEntries {
  /** Env entries a regeneration would write now. */
  entries: Map<string, string>;
  /** Every env key the inference block owns, including ones left unset this time. */
  ownedKeys: string[];
  /** The resolved values the entries were mapped from. */
  aiEnv: StandardizedAiEnv;
}

/** Whether the manifest opts into inference values through `hub_integration.inference`. */
export function hasInferenceMapping(config: Pick<AppInfo, 'hub_integration'>): boolean {
  const mapping = config.hub_integration?.inference;
  return Boolean(mapping && Object.keys(mapping).length > 0);
}

/** An app the Hub hands inference config to: categorized `ai`, or declaring an inference mapping. */
export function isAiAppInfo(config: Pick<AppInfo, 'hub_integration' | 'categories'>): boolean {
  return Boolean(config.categories?.includes('ai')) || hasInferenceMapping(config);
}

/** Copies resolved Hub inference values into the app's declared variables. */
export function applyHubInferenceEnv(options: {
  hubIntegration: HubIntegration | undefined;
  aiEnv: StandardizedAiEnv;
  envMap: Map<string, string>;
}): void {
  const inferenceMapping = options.hubIntegration?.inference;
  if (!inferenceMapping) {
    return;
  }

  const stripV1 = options.hubIntegration?.llm_base_url_strip_v1 === true;

  for (const [hubKey, appEnvVar] of Object.entries(inferenceMapping)) {
    const resolvedKey = HUB_INFERENCE_RESOLVED[hubKey as keyof typeof HUB_INFERENCE_RESOLVED];
    if (!resolvedKey || !appEnvVar) {
      continue;
    }

    const resolved = options.aiEnv[resolvedKey];
    if (typeof resolved !== 'string') {
      continue;
    }

    const value = hubKey === 'llm_base_url' && stripV1 ? resolved.replace(/\/v1\/?$/, '') : resolved;

    options.envMap.set(appEnvVar, value);
  }
}

/**
 * Returns whether the manifest declares a first-party consumer integration that
 * needs `HUB_APP_KEY`.
 *
 * A Companion Memory consumer declares `url_env` and `token_env`; its wrapper
 * drives the connect flow through `/api/memory-connect/apps/:urn/state|skip`. A
 * Companion Portal OIDC consumer declares `oidc`. The call site checks official
 * store provenance separately because manifest declarations alone are forgeable.
 */
export function needsHubAppKey(config: Pick<AppInfo, 'hub_integration'>): boolean {
  const memory = config.hub_integration?.memory;
  return Boolean((memory?.url_env && memory?.token_env) || config.hub_integration?.oidc);
}

/**
 * Returns the scopes for an app's Hub-managed key.
 *
 * The `mcp` scope serves an MCP tools consumer, and the `app` scope serves a
 * provenance-gated first-party consumer. An empty array grants no trust material.
 * Both `generateEnvFile` and `HubAccessService` use this gate so the operator-facing
 * report cannot drift from the actual grant.
 */
export function hubTrustMaterialScopes(config: Pick<AppInfo, 'urn' | 'hub_integration'>): ApiKeyScope[] {
  const scopes: ApiKeyScope[] = [];
  if (config.hub_integration?.mcp_client) {
    scopes.push('mcp');
  }
  // The install URN's store slug provides provenance because manifest fields are forgeable.
  if (isOfficialStoreApp(config) && needsHubAppKey(config)) {
    scopes.push('app');
  }
  return scopes;
}

function parseAppBaseUrl(url: string): URL {
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  return new URL(withScheme);
}

function deriveAppBaseWsOrigin(parsed: URL): string {
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws';
  return `${wsScheme}://${parsed.host}`;
}

@Injectable()
export class AppHelpers {
  constructor(
    private readonly appFilesManager: AppFilesManager,
    private readonly appsRepository: AppsRepository,
    private readonly config: ConfigurationService,
    private readonly filesytem: FilesystemService,
    private readonly envUtils: EnvUtils,
    private readonly logger: LoggerService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    private readonly registrationService: RegistrationService,
    private readonly inferenceEnv: InferenceEnvResolver,
    private readonly apiKeys: ApiKeyService,
    private readonly memoryConnection: MemoryConnectionService,
    private readonly portalClient: PortalClientService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Returns the Hub's tailnet origin for `CI_HUB_ORIGINS`, or `null` when the
   * Private VPN is disconnected or unavailable.
   *
   * A static `TailscaleService` import would create a dependency cycle, so this
   * method resolves the service lazily. Environment generation is infrequent,
   * and the uncached read exposes a newly connected VPN immediately.
   */
  private async hubTailnetOrigin(): Promise<string | null> {
    try {
      const { TailscaleService } = await import('../tailscale/tailscale.service');
      const tailscale = this.moduleRef?.get(TailscaleService, { strict: false });

      if (!tailscale) {
        return null;
      }

      const status = await tailscale.getStatus();

      return buildHubTailnetOrigin({ connected: status.connected, httpsAvailable: status.httpsAvailable, nodeFqdn: status.nodeFqdn });
    } catch (err) {
      // Omit the tailnet entry but retain a diagnostic because Companion Memory
      // rejects VPN callbacks when this origin is missing.
      this.logger.debug(`[AppHelpers] tailnet origin unavailable for CI_HUB_ORIGINS: ${err instanceof Error ? err.message : String(err)}`);

      return null;
    }
  }

  /**
   * The inference-derived entries `generateEnvFile` writes into an AI app's `app.env`, plus every
   * key those entries own whether or not a value is set this time.
   *
   * The one place this is computed, so the staleness check (`InferenceEnvStalenessService`) compares
   * an app's file against exactly what a regeneration would write rather than against a copy of the
   * mapping rules that could drift.
   */
  async buildInferenceEnv(appName: string, config: Pick<AppInfo, 'hub_integration' | 'categories'>): Promise<InferenceEnvEntries> {
    const entries = new Map<string, string>();
    // The app slug selects its requirement row — Hermes' 64K floor and tool calling — so this path
    // matches the credentials.env endpoint and never emits a model the app would refuse at startup.
    const aiEnv = await this.inferenceEnv.resolve({ appSlug: appName, minContextLength: appMinContextLength(appName) });
    if (hasInferenceMapping(config)) {
      applyHubInferenceEnv({ hubIntegration: config.hub_integration, aiEnv, envMap: entries });
    }
    applyCloudProviderEnv(entries, aiEnv.cloudProviderEnv);
    if (aiEnv.CI_INFERENCE_ERROR) {
      entries.set(INFERENCE_ERROR_ENV_KEY, aiEnv.CI_INFERENCE_ERROR);
    }

    const providerSwitch = config.hub_integration?.inference_provider;
    if (providerSwitch) {
      const usesOpenAiCompatible = (this.config.getInferencePreferences().preferredBackend ?? 'ollama') !== 'ollama';
      entries.set(providerSwitch.env, usesOpenAiCompatible ? providerSwitch.openai_compatible : providerSwitch.ollama);
    }

    const ownedKeys = new Set<string>([
      INFERENCE_ERROR_ENV_KEY,
      ...cloudProviderManagedKeys(),
      ...Object.values(config.hub_integration?.inference ?? {}),
    ]);
    if (providerSwitch) ownedKeys.add(providerSwitch.env);
    return { entries, ownedKeys: [...ownedKeys].filter((key): key is string => typeof key === 'string' && key.length > 0), aiEnv };
  }

  /**
   * Generates the environment file for an installed app.
   *
   * The generated values reflect the app manifest, submitted form values, and
   * current exposure identity. Exposed apps receive their confirmed public
   * hostname; other apps receive their browser-reachable internal address. The
   * app data path resolves to a host volume-mount location.
   *
   * @param appUrn App URN to configure.
   * @param form Submitted app configuration.
   * @throws If the manifest is invalid or a required variable is missing.
   */
  public generateEnvFile = async (appUrn: AppUrn, form: AppEventFormInput) => {
    const { internalIp, envFilePath, rootFolderHost, userSettings } = this.config.getConfig();

    const config = await this.appFilesManager.getInstalledAppInfo(appUrn);

    if (!config) {
      throw new Error(`App ${appUrn} not found`);
    }

    const mergedForm = mergeFormFieldDefaults(form as Record<string, unknown>, config.form_fields ?? []) as AppEventFormInput;

    const baseEnvFile = await this.filesytem.readTextFile(envFilePath);
    const envMap = this.envUtils.envStringToMap(baseEnvFile?.toString() ?? '');

    // Each app environment inherits the Hub's `.env`, including for third-party
    // apps. Remove Hub secrets before any inherited value reaches the container.
    //
    // Default installs put these values in `.env.resolved`, not the source `.env`.
    // Operators can pin `CI_HUB_FORWARD_AUTH_SECRET` in `.env` across rebuilds.
    // Without this filter, pinning would expose the credential that signs connect
    // exchange, rotation, revocation, and identity headers, defeating the
    // provider-only gate that isolates Companion Memory keys.
    for (const secret of HUB_ONLY_SECRET_ENV_VARS) {
      envMap.delete(secret);
    }

    // App containers always use production mode. Inheriting the Hub's development
    // mode can make apps such as Rocket.Chat load unavailable development dependencies.
    envMap.set('NODE_ENV', 'production');

    try {
      const deviceId = await this.registrationService.getDeviceId();
      if (deviceId) {
        envMap.set('HUB_DEVICE_ID', deviceId);
      } else {
        envMap.delete('HUB_DEVICE_ID');
      }
    } catch (error) {
      envMap.delete('HUB_DEVICE_ID');
      this.logger.warn('Unable to resolve HUB_DEVICE_ID for app env generation.', error);
    }

    // Strip `HUB_API_KEY` from every inherited env. The value it used to carry is
    // `ciHubApiKey`, the Hub's Portal device credential — which `AuthMiddleware`
    // also accepts as an operator bearer. Shipping it to every installed app,
    // third-party images included, authenticated as the operator on every
    // `AuthGuard` route (CI-Hub#1288).
    //
    // Apps that call the Hub API get a scoped key below (`HUB_MCP_API_KEY` /
    // `HUB_APP_KEY`). First-party Companion Memory is the exception: it calls
    // Portal (cloud OAuth, geocode) as this Hub's device and needs the Portal
    // device key back. That re-inject happens later, after this strip, so a
    // stale or inherited value cannot leak to any other app.
    envMap.delete('HUB_API_KEY');

    const { appName, appStoreId } = extractAppUrn(appUrn);

    // Registration data provides the organization-specific public identity instead
    // of the deployment's default domain.
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();

    /*
     * The custom hostname Companion Portal has wired for this app, mirrored onto
     * the row by the last successful tunnel sync (`reconcileCustomDomains`).
     *
     * Read from the row and never from `form`: the Hub cannot tell whether a
     * hostname really resolves to this tunnel, and emitting a public URL for one
     * that does not would make the app sign OAuth redirects for an unreachable
     * name. Companion Portal is authoritative for the delivered hostname.
     *
     * This value is absent at install time because Companion Portal can wire a
     * domain only after learning about the app. The later binding therefore
     * appears as a pending restart instead of applying at first boot.
     *
     * Read at the point of use, and only for an exposed app: this method runs on
     * every install, start, stop, restart, update, and reset. Local-only apps
     * cannot use the value.
     */

    // The deployment root domain anchors generated public hostnames.
    const domain = this.config.getConfig().domain;

    // Traefik label interpolation requires both `DOMAIN` and `LOCAL_DOMAIN`.
    // Prefer an authoritative configured domain over an inherited default.
    const currentEnvDomain = envMap.get('DOMAIN');
    // Replace a missing or inherited default with the authoritative domain.
    if (!currentEnvDomain || (currentEnvDomain === this.config.getConfig().domain && domain !== this.config.getConfig().domain)) {
      envMap.set('DOMAIN', domain);
      this.logger.debug(`Overriding DOMAIN with authoritative domain: ${domain}`);
    }

    if (!envMap.has('LOCAL_DOMAIN')) {
      envMap.set('LOCAL_DOMAIN', userSettings.localDomain || this.config.getConfig().localDomain);
    }

    // These identity values are available to every app.
    if (config.port || form.port) {
      envMap.set('APP_PORT', form.port ? String(form.port) : String(config.port));
    }
    envMap.set('APP_URN', appUrn);
    envMap.set('APP_ID', `${appName}-${appStoreId}`);
    envMap.set('APP_NAME', appName);
    envMap.set('APP_STORE_ID', appStoreId);
    envMap.set('ROOT_FOLDER_HOST', rootFolderHost);

    // `APP_DATA_DIR` must use an absolute host path for Docker volume mounts.
    // Docker Compose runs inside the Companion Hub container but talks to the
    // host Docker daemon, which cannot use the container's path. The volume mount
    // maps `${CI_HUB_APP_DATA_PATH:-.internal}/app-data` to `/app-data`.
    //
    // The desktop "Open data folder" action uses `getAppDataHostPath` too, keeping
    // the mounted and displayed directories identical.
    const ciHubAppDataPath = envMap.get('CI_HUB_APP_DATA_PATH');
    const finalAppDataDir = getAppDataHostPath(appUrn, {
      ciHubAppDataPath,
      appDataPath: userSettings.appDataPath,
      rootFolderHost,
    });

    this.logger.debug(
      `Constructing APP_DATA_DIR for ${appUrn}: ` +
        `CI_HUB_APP_DATA_PATH=${ciHubAppDataPath}, ` +
        `userSettings.appDataPath=${userSettings.appDataPath}, ` +
        `rootFolderHost=${rootFolderHost}, ` +
        `resolved=${finalAppDataDir}`,
    );

    envMap.set('APP_DATA_DIR', finalAppDataDir);
    this.logger.info(`Set APP_DATA_DIR for ${appUrn}: ${finalAppDataDir}`);
    envMap.set('APP_IMAGE_TAG', config.version);

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const existingAppEnvMap = this.envUtils.envStringToMap(appEnv.content);

    if (config.generate_vapid_keys) {
      if (existingAppEnvMap.has('VAPID_PUBLIC_KEY') && existingAppEnvMap.has('VAPID_PRIVATE_KEY')) {
        envMap.set('VAPID_PUBLIC_KEY', existingAppEnvMap.get('VAPID_PUBLIC_KEY') as string);
        envMap.set('VAPID_PRIVATE_KEY', existingAppEnvMap.get('VAPID_PRIVATE_KEY') as string);
      } else {
        const vapidKeys = this.envUtils.generateVapidKeys();
        envMap.set('VAPID_PUBLIC_KEY', vapidKeys.publicKey);
        envMap.set('VAPID_PRIVATE_KEY', vapidKeys.privateKey);
      }
    }

    for (const field of config.form_fields) {
      if (field.type === 'app_base_url') {
        continue;
      }

      const formValue = mergedForm[field.env_variable];
      const envVar = field.env_variable;

      if (field.type === 'random') {
        if (existingAppEnvMap.has(envVar)) {
          envMap.set(envVar, existingAppEnvMap.get(envVar) as string);
          continue;
        }

        const length = field.min ?? 32;
        const randomString = this.envUtils.createRandomString(field.env_variable, length, field.encoding);
        envMap.set(envVar, randomString);
        continue;
      }

      const hasValidFormValue = formValue !== undefined && formValue !== '' && formValue !== null;

      if (hasValidFormValue) {
        envMap.set(envVar, String(formValue));
        continue;
      }

      if (field.default !== undefined) {
        envMap.set(envVar, String(field.default));
        continue;
      }

      if (field.required) {
        throw new Error(`Variable ${field.label || field.env_variable} is required`);
      }
    }

    // --- Core identity variables ---
    // These values define the service's network identity.

    // 1. `APP_HOSTNAME`: raw bind address for containers, such as `0.0.0.0`.
    envMap.set('APP_HOSTNAME', internalIp);

    // 2. `APP_PORT`: internal service port, set above when the app declares one.

    // Map listen-all sentinels to loopback so `ORIGIN`, `APP_URL`, and the Hub's
    // Open action use the same browser-reachable host.
    const browserHost = resolveBrowserHost(internalIp);

    // 3. `APP_INTERNAL_AUTHORITY`: host and port for URLs and CSRF origin checks.
    if (config.port || form.port) {
      envMap.set('APP_INTERNAL_AUTHORITY', `${browserHost}:${form.port ? form.port : config.port}`);
    }

    // --- Exposure state variables ---
    // Resolve the app's public access identity.

    let isExposed = false;
    let scheme = 'http';
    let publicHostname = '';
    let publicUrl = '';
    // Resolve Cloudflare Tunnel exposure through Traefik.
    if (form.exposedLocal) {
      const appSubdomain = form.localSubdomain ? form.localSubdomain : `${appName}-${appStoreId}`;
      const configDomain = this.config.getConfig().domain;
      const selectedPublicDomain = typeof form.publicDomain === 'string' && form.publicDomain.trim().length > 0 ? form.publicDomain : undefined;
      const publicDomainRoot = resolvePublicDomainRoot({
        selectedPublicDomain,
        envDomain: envMap.get('DOMAIN'),
        configDomain,
      });

      const localSubdomainBase = org?.slug ? buildFqdnSubdomain(appSubdomain, org.hubSubdomain, org.slug) : sanitizeAppSubdomain(appSubdomain);

      // `APP_LOCAL_DOMAIN` remains separate because local network access uses it.
      envMap.set('APP_LOCAL_DOMAIN', `${localSubdomainBase}.${envMap.get('LOCAL_DOMAIN') || this.config.getConfig().localDomain}`);

      if (!form.openPort && org?.slug) {
        isExposed = true;
        scheme = 'https';
        const identity = buildPublicWebIdentity({
          appSubdomain,
          hubSubdomain: org.hubSubdomain,
          orgSlug: org.slug,
          publicDomainRoot,
        });
        publicHostname = identity.hostname;
        publicUrl = identity.publicUrl;
      } else if (!form.openPort) {
        isExposed = true;
        scheme = 'https';
        publicHostname = `${appSubdomain}.${publicDomainRoot}`;
        publicUrl = `https://${publicHostname}`;
      }
    }

    // A custom domain supplies an explicit public identity.
    if (form.exposed && form.domain && typeof form.domain === 'string') {
      isExposed = true;
      scheme = 'https';
      publicHostname = form.domain;
      publicUrl = `https://${form.domain}`;
    }

    /*
     * A custom domain takes precedence over the platform hostname.
     *
     * Cloudflare terminates TLS for the customer's hostname and the tunnel
     * answers on it. However, the cloned ingress rule retains the original
     * `httpHostHeader`, so the app receives the platform host and cannot infer
     * the browser's hostname from the request. These variables provide that
     * identity.
     *
     * Without the override, `redirect_uri` uses `APP_PUBLIC_URL` and mismatches
     * the custom domain. Absolute links also return to the platform hostname, and
     * origin-checked WebSockets validate against the wrong host.
     *
     * Apply the override only to exposed apps. A local or VPN-only app has no
     * public identity for a domain to alias.
     */
    const syncedCustomDomain = isExposed ? normalizeStoredHostname(await this.appsRepository.getAppCustomDomain(appUrn)) : null;

    if (isExposed && syncedCustomDomain) {
      scheme = 'https';
      publicHostname = syncedCustomDomain;
      publicUrl = `https://${syncedCustomDomain}`;
    }

    // Publish the resolved exposure state.
    envMap.set('APP_EXPOSED', String(isExposed));
    envMap.set('APP_SCHEME', scheme);

    if (isExposed) {
      envMap.set('APP_PUBLIC_HOSTNAME', publicHostname);
      envMap.set('APP_PUBLIC_URL', publicUrl);
      envMap.delete('APP_PUBLIC_DOMAIN');
    }

    // --- Derived variables ---
    // These aliases support common application configuration patterns.

    envMap.set('APP_PROTOCOL', scheme);

    // `APP_HOST` uses the browser-reachable internal host or exposed public FQDN.
    envMap.set('APP_HOST', isExposed ? publicHostname : browserHost);

    // `APP_DOMAIN` uses an internal authority or exposed public FQDN.
    if (isExposed) {
      envMap.set('APP_DOMAIN', publicHostname);
      envMap.set('APP_EXPOSED_DOMAIN', publicHostname);
    } else {
      const internalAuthority = envMap.get('APP_INTERNAL_AUTHORITY');
      if (internalAuthority) {
        envMap.set('APP_DOMAIN', internalAuthority);
      }
    }

    // `APP_URL` is the full browser access URL.
    if (isExposed) {
      envMap.set('APP_URL', publicUrl);
    } else {
      const internalAuthority = envMap.get('APP_INTERNAL_AUTHORITY');
      if (internalAuthority) {
        envMap.set('APP_URL', `http://${internalAuthority}`);
      }
    }

    const configDomain = domain;
    const platformPublicUrl =
      org?.slug && config.exposable
        ? buildPublicWebIdentity({
            appSubdomain: form.localSubdomain ? form.localSubdomain : `${appName}-${appStoreId}`,
            hubSubdomain: org.hubSubdomain,
            orgSlug: org.slug,
            publicDomainRoot: resolvePublicDomainRoot({
              selectedPublicDomain: typeof form.publicDomain === 'string' && form.publicDomain.trim().length > 0 ? form.publicDomain : undefined,
              envDomain: envMap.get('DOMAIN'),
              configDomain,
            }),
          }).publicUrl
        : undefined;

    /*
     * `APP_BASE_URL` and each `app_base_url` field must match the resolved
     * exposure identity instead of deriving the platform identity again. Most
     * apps build OAuth `redirect_uri` from this value, so a platform hostname
     * here breaks custom-domain sign-in even when `APP_PUBLIC_URL` is correct.
     */
    const suggestedPublicUrl = isExposed && syncedCustomDomain ? publicUrl : platformPublicUrl;

    const defaultAppBaseUrl = (suggestedPublicUrl ?? envMap.get('APP_URL') ?? '').replace(/\/+$/, '');

    /*
     * Preserve an existing base URL when an operator pinned it. A value equal to
     * the app's previous public URL represents the last automatic binding, not an
     * operator choice. Keeping that value after a domain change would make the app
     * sign redirects for a hostname it no longer serves.
     *
     * This method writes `APP_PUBLIC_URL`, so equality with the previously derived
     * value identifies an automatic base URL without storing the old binding. The
     * current platform URL also qualifies so public-domain moves are corrected.
     * A LAN `APP_URL` created while the Hub was unregistered matches neither value
     * and remains unchanged.
     */
    const supersededAutoBaseUrls = new Set(
      [existingAppEnvMap.get('APP_PUBLIC_URL'), platformPublicUrl]
        .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        .map((url) => url.replace(/\/+$/, '')),
    );

    /*
     * Apply the identity update to both the form value and existing environment.
     *
     * The install dialog prefills each `app_base_url` field with
     * `suggestedAppBaseUrl`. `appFormSchema` preserves that submitted value in
     * `app.config`, and each later start, restart, or update replays it as `form`.
     * Therefore, changing only `existingAppEnvMap` would leave the persisted form
     * value on the platform hostname while `APP_PUBLIC_URL` moves to the custom
     * domain.
     *
     * An automatically derived value follows the exposed identity regardless of
     * its source. A value entered by the operator matches neither superseded URL
     * and remains unchanged.
     */
    const followExposedIdentity = (baseUrl: string): string =>
      defaultAppBaseUrl && supersededAutoBaseUrls.has(baseUrl) ? defaultAppBaseUrl : baseUrl;

    for (const field of config.form_fields) {
      if (field.type !== 'app_base_url') {
        continue;
      }

      const envVar = field.env_variable;
      const formValue = form[envVar];
      const hasValidFormValue = formValue !== undefined && formValue !== '' && formValue !== null;

      let resolvedBaseUrl: string | undefined;

      if (hasValidFormValue) {
        resolvedBaseUrl = followExposedIdentity(String(formValue).replace(/\/+$/, ''));
      } else if (existingAppEnvMap.has(envVar)) {
        resolvedBaseUrl = followExposedIdentity(String(existingAppEnvMap.get(envVar)).replace(/\/+$/, ''));
      } else if (field.default !== undefined && String(field.default).trim() !== '') {
        resolvedBaseUrl = String(field.default).replace(/\/+$/, '');
      } else if (defaultAppBaseUrl) {
        resolvedBaseUrl = defaultAppBaseUrl;
      }

      if (!resolvedBaseUrl) {
        if (field.required) {
          throw new Error(`Variable ${field.label || envVar} is required`);
        }
        continue;
      }

      envMap.set(envVar, resolvedBaseUrl);

      const aliasValue = field.trailing_slash ? `${resolvedBaseUrl}/` : resolvedBaseUrl;
      for (const alias of field.alias_env_variables ?? []) {
        envMap.set(alias, aliasValue);
      }
    }

    if (config.exposable && !envMap.has('APP_BASE_URL') && defaultAppBaseUrl) {
      envMap.set('APP_BASE_URL', defaultAppBaseUrl);
    }

    const appBaseUrl = envMap.get('APP_BASE_URL');
    if (appBaseUrl) {
      try {
        const parsed = parseAppBaseUrl(appBaseUrl);
        envMap.set('APP_BASE_HOST', parsed.host);
        envMap.set('APP_BASE_WSS_ORIGIN', deriveAppBaseWsOrigin(parsed));
      } catch {
        this.logger.warn(`Unable to parse APP_BASE_URL for derived host vars: ${appBaseUrl}`);
      }
    }

    if (appName === 'cloudflared') {
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (org?.tunnelToken && org.tunnelId) {
        envMap.set('TUNNEL_TOKEN', org.tunnelToken);
        envMap.set('TUNNEL_ID', org.tunnelId);
      } else {
        this.logger.warn('cloudflared app installation requested, but no organization/tunnel information found.');
      }
    }

    // --- Hub trust material: managed key and internal URL (R-ENV / CI-Engineering#74) ---
    // Two independent reasons an app talks to the Hub:
    //  - `hub_integration.mcp_client` consumes Hub MCP tools with the `mcp` scope.
    //  - An official-store consumer that declares `hub_integration.memory` or
    //    `.oidc` calls app-facing callbacks with the `app` scope in `HUB_APP_KEY`.
    // The install URN gates the callback grant because manifest fields are
    // forgeable but store slugs are not. Third-party-store apps receive no
    // callback credential regardless of their manifest.
    const scopes = hubTrustMaterialScopes(config);
    const isMcpClient = scopes.includes('mcp');
    const isFirstPartyConsumer = scopes.includes('app');
    if (scopes.length > 0) {
      const hubContainer = hubContainerName();
      const hubPort = process.env.API_PORT || '3000';
      const hubInternalUrl = `http://${hubContainer}:${hubPort}`;

      envMap.set('HUB_URL', hubInternalUrl);

      // SEC-MCP-8 provisions one managed key per companion app. Its scopes define
      // which Hub surfaces the app can access. Preserve a valid existing key and
      // reconcile only its scopes, so gaining access does not rotate the credential.
      // Uninstall revokes the key, and the Hub stores only its hash. The raw value
      // exists only in the app environment.
      const existingManagedKey = existingAppEnvMap.get('HUB_APP_KEY') || existingAppEnvMap.get('HUB_MCP_API_KEY');
      const managedKey = await this.apiKeys.provisionManagedKey({
        appUrn,
        appName: config.name ?? appUrn,
        existingRawKey: existingManagedKey,
        scopes,
      });

      if (isMcpClient) {
        // BUG-MCP-1 uses one MCP Streamable HTTP endpoint at `/api/mcp` for
        // POST, GET, and DELETE instead of the former `/sse` and `/messages`
        // pair. Agents authenticate with `HUB_MCP_API_KEY` as a bearer token.
        envMap.set('HUB_MCP_URL', `${hubInternalUrl}/api/mcp`);
        envMap.set('HUB_MCP_API_KEY', managedKey);

        // Preserve the wake secret across regenerations so existing callers remain valid.
        const existingSecret = existingAppEnvMap.get('HUB_WAKE_SECRET');
        if (existingSecret) {
          envMap.set('HUB_WAKE_SECRET', existingSecret);
        } else {
          envMap.set('HUB_WAKE_SECRET', randomBytes(32).toString('hex'));
        }
      }

      if (isFirstPartyConsumer) {
        // The neutral callback credential shares the raw value of `HUB_MCP_API_KEY`
        // when both scopes apply. The app URN lets non-MCP consumers, such as OIDC-only
        // apps, address their per-app Companion Memory connect endpoints.
        envMap.set('HUB_APP_KEY', managedKey);
        envMap.set('CI_APP_URN', appUrn);
      }
    }

    // --- Standardized AI environment variables (opt-in) ---
    // Apps declare required inference values through `hub_integration.inference`.
    // The Hub maps resolved values to the declared environment variable names.
    // Apps without this field receive no inference variables.
    if (isAiAppInfo(config)) {
      try {
        const inference = await this.buildInferenceEnv(appName, config);
        for (const [key, value] of inference.entries) {
          envMap.set(key, value);
        }
      } catch (err) {
        this.logger.warn(`[AppHelpers] Failed to resolve inference env for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Companion Portal OIDC issuer injection ---
    // Apps that sign in through Companion Portal must authenticate against the
    // paired Portal identity provider in `CI_CLOUD_URL`. This origin differs from
    // `hub.<DOMAIN>` because `DOMAIN` identifies the public app zone, not the
    // Portal identity provider. Without the injected issuer, an exposed app can
    // fall back to the wrong provider and fail with `INVALID_REDIRECT_URI`
    // (CI-Hub#870).
    const { ciCloudUrl } = this.config.getConfig();
    const normalizedCloudUrl = ciCloudUrl?.trim().replace(/\/+$/, '');

    // The preferred path mirrors `hub_integration.inference`: manifests opt in and
    // declare the issuer variable plus an optional discovery path. Limiting writes
    // to opted-in apps protects third-party identity-provider variables with the
    // same name.
    const oidcIntegration = config.hub_integration?.oidc;
    if (oidcIntegration) {
      if (normalizedCloudUrl) {
        const suffix = oidcIntegration.issuer_path?.trim().replace(/^\/+/, '').replace(/\/+$/, '');
        const issuer = suffix ? `${normalizedCloudUrl}/${suffix}` : normalizedCloudUrl;
        envMap.set(oidcIntegration.issuer_env, issuer);
        this.logger.debug(`[AppHelpers] Injected paired Portal OIDC issuer for ${appUrn}: ${oidcIntegration.issuer_env}=${issuer}`);
      } else {
        this.logger.warn(`[AppHelpers] ${appUrn} declares hub_integration.oidc but CI_CLOUD_URL is empty; skipping OIDC issuer injection.`);
      }
    }

    // First-party Companion Memory deployments include `ci-memory` and source
    // builds of the same product. Share this predicate across OIDC and maps-key
    // injection so the gates remain consistent.
    const isFirstPartyCiServerApp =
      config.id === 'ci-memory' || (typeof config.source === 'string' && config.source.includes('companionintelligence/CI-Server'));

    // Preserve values that operators pin in the Hub's `.env`, which seeds `envMap`.
    // Hub-derived defaults fill only missing values.
    const setUnlessOperatorSet = (key: string, value: string) => {
      if ((envMap.get(key) ?? '').trim().length > 0) {
        return false;
      }

      envMap.set(key, value);

      return true;
    };

    // For compatibility, first-party Companion Memory apps that predate the manifest
    // flag still receive the bare-origin `OIDC_ISSUER_URL`. Skip this fallback when
    // the manifest already declares an OIDC mapping.
    if (!oidcIntegration && normalizedCloudUrl && isFirstPartyCiServerApp) {
      envMap.set('OIDC_ISSUER_URL', normalizedCloudUrl);
    }

    // --- Companion Portal bearer-token verification (`auth.portal.*`) ---
    // This configuration remains independent from issuer injection.
    // `OIDC_ISSUER_URL` configures Companion Memory's interactive `auth.oidc`
    // flow. These three values configure the `auth.portal` bearer path in
    // `JwtOrApiKeyAuthGuard`, which verifies Portal-issued JWTs against the Portal
    // JWKS. Adding `hub_integration.oidc` must not remove bearer authentication.
    //
    // Companion Memory ships with `auth.portal.enabled: false` and default Portal
    // endpoints. Pairing against another Portal would make bearer-authenticated
    // calls return 401, while `PortalTokenService` hides the verification detail.
    //
    // The issuer is the bare origin, not `<origin>/api/auth`. That path is the OIDC
    // discovery base, while the token's `iss` claim contains the origin. The JWKS
    // remains under `/api/auth`.
    if (isFirstPartyCiServerApp && normalizedCloudUrl) {
      const injected = [
        setUnlessOperatorSet('PORTAL_OIDC_ENABLED', 'true'),
        setUnlessOperatorSet('PORTAL_OIDC_ISSUER', normalizedCloudUrl),
        setUnlessOperatorSet('PORTAL_OIDC_JWKS_URI', `${normalizedCloudUrl}/api/auth/jwks`),
      ].filter(Boolean).length;

      if (injected > 0) {
        this.logger.debug(`[AppHelpers] Injected paired Portal Bearer-auth config for ${appUrn} (${injected}/3 keys; issuer=${normalizedCloudUrl})`);
      }
    } else if (isFirstPartyCiServerApp) {
      this.logger.warn(
        `[AppHelpers] ${appUrn} is a first-party CI-Server app but CI_CLOUD_URL is empty; portal Bearer auth will stay disabled and token-authenticated calls will 401.`,
      );
    }

    // --- Companion Memory Portal device credential (cloud OAuth + geocode) ---
    // Memory authenticates to Portal as this Hub's device. `HUB_DEVICE_ID` +
    // `HUB_API_KEY` are what CI-Server maps to `ciPortal.deviceId` / `apiKey`.
    // Without the key, every OAuth2 provider is forced `localOnly` and Sources
    // shows the bring-your-own OAuth dialog instead of cloud connect.
    //
    // Third-party apps still do not get this value — the strip above stands.
    // Memory already stores user OAuth tokens; giving it the Portal device key
    // is the previous working contract, scoped to the first-party app.
    //
    // Portal also holds GOOGLE_MAPS_API_KEY and serves it at `GET /api/config/maps`.
    // Inject it here so server geocoding and frontend maps work without embedding
    // Vite keys in images. Portal unavailability must not fail env generation.
    if (isFirstPartyCiServerApp) {
      const portalDeviceKey = (this.config.getConfig().ciHubApiKey ?? '').trim();
      if (portalDeviceKey) {
        envMap.set('HUB_API_KEY', portalDeviceKey);
      } else {
        this.logger.warn(
          `[AppHelpers] ${appUrn} is first-party Memory but this Hub has no Portal device key; cloud OAuth will fall back to bring-your-own credentials.`,
        );
      }
      if (normalizedCloudUrl) {
        setUnlessOperatorSet('CI_CLOUD_URL', normalizedCloudUrl);
      }

      const operatorSetMapsKey = (envMap.get('GOOGLE_MAPS_KEY') ?? '').trim().length > 0 || (envMap.get('GEOCODING_API_KEY') ?? '').trim().length > 0;
      if (!operatorSetMapsKey) {
        try {
          const maps = await this.portalClient.fetchMapsConfig();
          const apiKey = maps?.configured ? maps.apiKey?.trim() : '';
          if (apiKey) {
            envMap.set('GOOGLE_MAPS_KEY', apiKey);
            envMap.set('GEOCODING_API_KEY', apiKey);
            this.logger.debug(`[AppHelpers] Injected Portal Google Maps key for ${appUrn}`);
          }
        } catch (err) {
          this.logger.warn(`[AppHelpers] Portal maps-key fetch failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // --- Companion Memory credentials for consumer apps ---
    // Apps opt in through `hub_integration.memory` and declare the variables for
    // their Memory URL and API key. After a user connects an app, each environment
    // generation re-emits the brokered, user-authorized credentials, matching the
    // inference and OIDC mappings. Regeneration preserves the credentials across
    // restarts because a direct `app.env` write would be replaced. Brokered
    // credentials take precedence; operator-entered values apply only when no
    // brokered connection exists.
    const memoryIntegration = config.hub_integration?.memory;
    if (memoryIntegration?.url_env && memoryIntegration?.token_env) {
      // The app URN lets its wrapper query the per-app Companion Memory connect
      // state endpoint (`/api/memory-connect/apps/:urn/state`) to decide whether
      // to show the connect interstitial.
      envMap.set('CI_APP_URN', appUrn);

      const operatorSetToken = (envMap.get(memoryIntegration.token_env) ?? '').trim().length > 0;
      // Keep this best-effort so connection-state resolution cannot fail environment
      // generation. A brokered connection re-emits its credentials, and a manually
      // configured app shows as "manual" (not "Not connected" with a Connect
      // button that would mint a dead key).
      try {
        // A completed brokered connection takes precedence and is re-emitted on
        // every regeneration. Checking it first also prevents a manifest with a
        // nonempty default for `token_env` from pinning a
        // genuinely connected app to `manual` (which would then stop injecting
        // the real credentials). `getInjectableCreds` is non-null only when connected.
        const creds = await this.memoryConnection.getInjectableCreds(appUrn);
        if (creds) {
          // Format only the brokered address according to the manifest. Preserve an
          // operator-supplied external Companion Memory URL exactly as entered.
          envMap.set(memoryIntegration.url_env, memoryUrlForStyle(creds.url, memoryIntegration.url_style));
          envMap.set(memoryIntegration.token_env, creds.token);
          this.logger.debug(`[AppHelpers] Injected Companion Memory creds for ${appUrn}`);
        } else if (operatorSetToken) {
          // When install supplied credentials without a brokered connection, record
          // `manual` so the UI does not prompt. `markManual` skips the write when
          // the state is already manual.
          await this.memoryConnection.markManual(appUrn);
        }
      } catch (err) {
        this.logger.warn(`[AppHelpers] memory-connect env resolution failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- First-party consumer forward-auth identity (CI-Engineering#74) ---
    // Consumer apps verify the Hub-signed X-CI-Hub-User identity headers with a
    // per-app secret. A leaked secret can forge identities only for the app that
    // owns it, not a sibling. Preserve or create the secret like `HUB_WAKE_SECRET`.
    // `GET /api/auth/traefik` signs with the value in this `app.env`, which
    // `ForwardAuthSecretResolver` reads back, so signer and verifier cannot drift.
    // To rotate it, clear the variable, regenerate the environment, and restart.
    // The provider block below intentionally overrides this for ci-memory with the
    // Hub-wide secret because its verifier also authenticates the connect exchange,
    // which is keyed on the global value (memory-exchange.client).
    if (isFirstPartyConsumer) {
      const existingForwardAuthSecret = (existingAppEnvMap.get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim();
      envMap.set('CI_HUB_FORWARD_AUTH_ENABLED', 'true');
      envMap.set('CI_HUB_FORWARD_AUTH_SECRET', existingForwardAuthSecret || randomBytes(32).toString('hex'));
      this.logger.debug(`[AppHelpers] Injected per-app forward-auth secret for ${appUrn}`);
    }

    // --- Companion Memory provider forward-auth provisioning ---
    // `ci-memory` verifies Hub-to-Memory connect calls, including code exchange
    // and revocation, through signed forward-auth headers keyed by the Hub-wide
    // `forwardAuthSecret`. It redirects browsers only to allowlisted Hub origins.
    // Inject the shared secret, enable flag, and Hub origins so the connect flow
    // works on this appliance. `isMemoryProviderApp` gates trust on the
    // official-store install URN instead of forgeable manifest fields, preventing
    // third-party apps from receiving the master secret.
    if (isMemoryProviderApp(config)) {
      const forwardAuthSecret = this.config.get('forwardAuthSecret');
      if (forwardAuthSecret) {
        envMap.set('CI_HUB_FORWARD_AUTH_ENABLED', 'true');
        envMap.set('CI_HUB_FORWARD_AUTH_SECRET', forwardAuthSecret);
      }
      // `ci-memory` allowlists these Hub origins as valid connect return targets.
      //
      // List both browser-reachable origins, separated by commas. Companion Memory
      // splits and normalizes the list in `ConnectService.allowedHubOrigins`. The
      // public tunnel route is the usual path. The LAN origin supports the flow
      // when the tunnel is down or the appliance was never registered. Without it,
      // Companion Memory rejects the local callback (CI-Engineering#75, Problem 4a).
      // A loopback local origin is dropped: on a listen-all INTERNAL_IP,
      // `buildHubLocalOrigin` resolves to `http://127.0.0.1`, which points to the
      // `ci-memory` container itself rather than the Hub. A listen-all appliance
      // has no known LAN address, so it cannot support the LAN callback path.
      // Include the tailnet origin while the Private VPN is connected because VPN
      // callers complete the entire flow on that origin. Without it, Companion
      // Memory rejects their callbacks (CI-Engineering#78). If the VPN is down
      // during environment generation, reconnecting requires an app restart to
      // regenerate the allowlist.
      const hubOrigins = [
        buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain }),
        buildHubLocalOrigin({ internalIp: userSettings.internalIp, port: userSettings.port }),
        await this.hubTailnetOrigin(),
      ].filter((origin): origin is string => origin != null && origin !== '' && !/^https?:\/\/(127\.0\.0\.1|\[::1\])(:|$)/.test(origin));

      if (hubOrigins.length > 0) {
        envMap.set('CI_HUB_ORIGINS', hubOrigins.join(','));
      }
    }

    envMap.delete('APP_PUBLIC_DOMAIN');

    // Give every app a stable inference URL that auto-upgrades to pooled
    // routing when Hub peers are connected. Apps can use this instead of
    // talking to the backend container directly.
    const hubContainer = hubContainerName();
    const hubPort = process.env.API_PORT || '3000';
    envMap.set('HUB_INFERENCE_URL', `http://${hubContainer}:${hubPort}/api/inference/v1`);

    await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
  };
}
