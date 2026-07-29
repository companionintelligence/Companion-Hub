import { randomBytes } from 'node:crypto';
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
import type { AppInfo, MemoryUrlStyle } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { buildFqdnSubdomain, buildPublicWebIdentity, resolvePublicDomainRoot, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { EnvUtils } from '../env/env.utils';
import type { AppEventFormInput } from '../queue/entities/app-events';
import { AppFilesManager } from './app-files-manager';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { RegistrationService } from '../registration/registration.service';
import { appMinContextLength } from '../inference/context-length.util';
import { InferenceEnvResolver } from '../inference/inference-env-resolver';
import { ApiKeyService } from '../api-keys/api-key.service';
import type { ApiKeyScope } from '../api-keys/api-key.scopes';
import { isOfficialStoreApp } from './official-store.predicate';
import { MemoryConnectionService } from '../memory-connect/memory-connection.service';
import { GATEWAY_API_PREFIX } from '../memory-connect/memory-exchange.client';
import { isMemoryProviderApp } from '../memory-connect/memory-provider.predicate';

/**
 * Hub master secrets that must never reach an app container.
 *
 * `generateEnvFile` seeds each app's env from the Hub's own .env, so any of these
 * would otherwise be written into every app.env and passed to the container via
 * env_file — third-party store apps included.
 *
 * - `CI_HUB_FORWARD_AUTH_SECRET` signs the connect exchange/rotate/revoke calls and
 *   the forward-auth identity header. The Hub-global value is re-injected below for
 *   the memory provider ONLY; first-party consumers receive a PER-APP secret minted
 *   further down, never this one — which is the whole point of the provider gate.
 * - `JWT_SECRET` / `MCP_API_KEY` — the Hub's own signing key and admin API key.
 * - `POSTGRES_PASSWORD` — the Hub's database password. Note the stock `postgres`
 *   image reads this from its environment, so leaking it does not merely disclose
 *   the secret, it seeds other databases with it.
 *
 * Stripping is safe for apps that legitimately use these NAMES: an app declares its
 * own via `form_fields`, and the form-field loop below runs AFTER this and re-sets
 * them (reusing the app's existing value, else generating a fresh one). What is
 * removed here is only the Hub's value bleeding through.
 *
 * NOTE (follow-up): a denylist means the next Hub secret added to .env leaks by
 * default. The right shape is an allowlist of what an app may receive — CI-Marketplace
 * already enumerates one (`HUB_PROVIDED_VARS` in its app tests) that this could be
 * driven from.
 */
const HUB_ONLY_SECRET_ENV_VARS = ['CI_HUB_FORWARD_AUTH_SECRET', 'JWT_SECRET', 'MCP_API_KEY', 'POSTGRES_PASSWORD'] as const;

/**
 * Shape the brokered Companion Memory address the way the consuming app declared.
 *
 * The provider is reachable at `http://<service>:<port>`, but its gateway proxies
 * the API only under `/api/` (stripping the prefix before the API). Apps that build
 * `/api/...` paths themselves need the bare origin; apps that treat the value as an
 * API base and append server-local paths need `<origin>/api`. Getting this wrong is
 * silent — the gateway serves its SPA rather than 404ing — so the app declares which
 * it wants and the Hub, the only party that knows the value is the brokered provider
 * address at all, obliges.
 */
function memoryUrlForStyle(brokeredUrl: string, style: MemoryUrlStyle | undefined): string {
  if (style !== 'api_base') {
    return brokeredUrl;
  }

  return `${brokeredUrl.replace(/\/+$/, '')}${GATEWAY_API_PREFIX}`;
}

/**
 * Whether an app's manifest declares a first-party consumer integration that needs
 * the Hub's app-facing callback credential (HUB_APP_KEY): a memory consumer
 * (url_env + token_env — its wrapper drives the connect flow through
 * /api/memory-connect/apps/:urn/state|skip) or a Portal-OIDC consumer. Provenance
 * (official-store install) is checked separately at the call site — this reads only
 * the manifest's declared needs, which are forgeable on their own.
 */
export function needsHubAppKey(config: Pick<AppInfo, 'hub_integration'>): boolean {
  const memory = config.hub_integration?.memory;
  return Boolean((memory?.url_env && memory?.token_env) || config.hub_integration?.oidc);
}

/**
 * Whether this app is provisioned a Hub-managed key at all, and on which grounds:
 * `mcp` for an MCP-tools consumer, `app` for a provenance-gated first-party consumer, both when
 * both apply. The empty array means "no trust material".
 *
 * This is the single definition of the gate — generateEnvFile decides what to inject from it, and
 * HubAccessService reports what an app holds from it. Restating the condition in either place
 * would let a security-facing operator surface drift out of step with what is actually granted.
 */
export function hubTrustMaterialScopes(config: Pick<AppInfo, 'urn' | 'hub_integration'>): ApiKeyScope[] {
  const scopes: ApiKeyScope[] = [];
  if (config.hub_integration?.mcp_client) {
    scopes.push('mcp');
  }
  // Provenance-gated: manifest fields are forgeable, the install URN's store slug is not.
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
   * The Hub's tailnet origin for the `CI_HUB_ORIGINS` allowlist, or null when
   * the Private VPN is not connected / cannot be served. Lazy ModuleRef lookup
   * for the same reason as elsewhere in this module — a static TailscaleService
   * import would cycle. Env generation is rare, so the uncached status read is
   * fine here (and wanted: a connect that just happened must be visible).
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
      // Degrade to "no tailnet entry" but leave a trace — a silently missing
      // origin here means ci-memory rejects every VPN callback with nothing in
      // the logs to say why.
      this.logger.debug(`[AppHelpers] tailnet origin unavailable for CI_HUB_ORIGINS: ${err instanceof Error ? err.message : String(err)}`);

      return null;
    }
  }

  /**
   * This function generates an env file for the provided app.
   * It reads the config.json file for the app, parses it,
   * and uses the app's form fields and domain to generate the env file
   * if the app is exposed and has a domain set, it adds the domain to the env file,
   * otherwise, it adds the internal IP address to the env file
   * It also creates the app-data folder for the app if it does not exist
   *
   * @param {string} appUrn - The id of the app to generate the env file for.
   * @param {AppEventFormInput} form - The config object for the app.
   * @throws Will throw an error if the app has an invalid config.json file or if a required variable is missing.
   */
  public generateEnvFile = async (appUrn: AppUrn, form: AppEventFormInput) => {
    const { internalIp, envFilePath, rootFolderHost, userSettings, ciHubApiKey } = this.config.getConfig();

    const config = await this.appFilesManager.getInstalledAppInfo(appUrn);

    if (!config) {
      throw new Error(`App ${appUrn} not found`);
    }

    const baseEnvFile = await this.filesytem.readTextFile(envFilePath);
    const envMap = this.envUtils.envStringToMap(baseEnvFile?.toString() ?? '');

    // The app env is seeded from the Hub's OWN .env, and every key in it is handed
    // to the container via env_file — including apps from third-party stores. Drop
    // the Hub's master secrets before anything else can leak them.
    //
    // These are normally provisioned into `.env.resolved` (never written back to the
    // source .env), so the default install is clean. But .env.example documents
    // pinning CI_HUB_FORWARD_AUTH_SECRET in .env to keep it stable across a rebuild,
    // and an operator who does that would otherwise hand every installed app the
    // secret that signs the connect exchange/rotate/revoke calls and the forward-auth
    // identity header — defeating the provider-only gate below, which is precisely
    // what stops a hostile app from minting or stealing another app's memory key.
    for (const secret of HUB_ONLY_SECRET_ENV_VARS) {
      envMap.delete(secret);
    }

    // App containers must always run in production mode regardless of Hub's NODE_ENV.
    // Hub's .env may have NODE_ENV=development which propagates via env_file and breaks
    // apps like Rocket.Chat that try to load dev-only dependencies (e.g. pino-pretty).
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

    if (ciHubApiKey) {
      envMap.set('HUB_API_KEY', ciHubApiKey);
    } else {
      envMap.delete('HUB_API_KEY');
    }

    const { appName, appStoreId } = extractAppUrn(appUrn);

    // Fetch organization info to get the correct domain
    // This fixes the issue where apps are generated with the default ci.computer domain instead of the user's specific subdomain
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();

    // the domain is the root domain for the deployment
    const domain = this.config.getConfig().domain;

    // Ensure DOMAIN and LOCAL_DOMAIN are set (required for Traefik label interpolation)
    // We overwrite the value from the .env file if it's the default "ci.computer" but we have a better one from the DB or settings
    const currentEnvDomain = envMap.get('DOMAIN');
    // If the domain matches the config domain, but we found a better authoritative domain, override it.
    if (!currentEnvDomain || (currentEnvDomain === this.config.getConfig().domain && domain !== this.config.getConfig().domain)) {
      envMap.set('DOMAIN', domain);
      this.logger.debug(`Overriding DOMAIN with authoritative domain: ${domain}`);
    }

    if (!envMap.has('LOCAL_DOMAIN')) {
      envMap.set('LOCAL_DOMAIN', userSettings.localDomain || this.config.getConfig().localDomain);
    }

    // Default always present env variables
    if (config.port || form.port) {
      envMap.set('APP_PORT', form.port ? String(form.port) : String(config.port));
    }
    envMap.set('APP_URN', appUrn);
    envMap.set('APP_ID', `${appName}-${appStoreId}`);
    envMap.set('APP_NAME', appName);
    envMap.set('APP_STORE_ID', appStoreId);
    envMap.set('ROOT_FOLDER_HOST', rootFolderHost);

    // APP_DATA_DIR must be the host absolute path for Docker volume mounts.
    // Docker Compose runs from inside the ci-os-hub container but connects to the
    // host Docker daemon, so it needs the host path, not the in-container path.
    // The volume is mounted as: ${CI_HUB_APP_DATA_PATH:-.internal}/app-data:/app-data.
    //
    // The resolution logic is shared with the desktop "Open data folder" button
    // (see getAppDataHostPath) so the mount path and the opened folder are identical.
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

      const formValue = form[field.env_variable];
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

    // --- Core Identity Variables ---
    // These variables represent the fundamental identity of the service.

    // 1. APP_HOSTNAME: bind/listen address (e.g. 0.0.0.0 or 192.168.1.5) — kept raw for containers.
    envMap.set('APP_HOSTNAME', internalIp);

    // 2. APP_PORT (Already set earlier): The internal port

    // Browser-reachable host: listen-all sentinels (0.0.0.0 / ::) map to loopback so ORIGIN,
    // APP_URL, and Hub "Open" URLs stay consistent (see resolveBrowserHost in apps.service.ts).
    const browserHost = resolveBrowserHost(internalIp);

    // 3. APP_INTERNAL_AUTHORITY: host:port suitable for URLs and CSRF origin checks
    if (config.port || form.port) {
      envMap.set('APP_INTERNAL_AUTHORITY', `${browserHost}:${form.port ? form.port : config.port}`);
    }

    // --- Exposure State Variables ---
    // Determine the public access configuration.

    let isExposed = false;
    let scheme = 'http';
    let publicHostname = '';
    let publicUrl = '';
    // Handle Local Exposure (Cloudflare Tunnel via Traefik)
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

      // APP_LOCAL_DOMAIN is distinct - used for local network access
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

    // Handle Public Exposure (Custom Domain)
    if (form.exposed && form.domain && typeof form.domain === 'string') {
      isExposed = true;
      scheme = 'https';
      publicHostname = form.domain;
      publicUrl = `https://${form.domain}`;
    }

    // Set Exposure Variables
    envMap.set('APP_EXPOSED', String(isExposed));
    envMap.set('APP_SCHEME', scheme);

    if (isExposed) {
      envMap.set('APP_PUBLIC_HOSTNAME', publicHostname);
      envMap.set('APP_PUBLIC_URL', publicUrl);
      envMap.delete('APP_PUBLIC_DOMAIN');
    }

    // --- Derived Variables ---
    // These are constructed from the core variables for compatibility with various application patterns.

    envMap.set('APP_PROTOCOL', scheme);

    // APP_HOST: browser-reachable host in internal mode, public FQDN in exposed mode.
    envMap.set('APP_HOST', isExposed ? publicHostname : browserHost);

    // APP_DOMAIN: IP:PORT in internal mode, Public FQDN in exposed mode.
    if (isExposed) {
      envMap.set('APP_DOMAIN', publicHostname);
      envMap.set('APP_EXPOSED_DOMAIN', publicHostname);
    } else {
      const internalAuthority = envMap.get('APP_INTERNAL_AUTHORITY');
      if (internalAuthority) {
        envMap.set('APP_DOMAIN', internalAuthority);
      }
    }

    // APP_URL: The full URL to access the app
    if (isExposed) {
      envMap.set('APP_URL', publicUrl);
    } else {
      const internalAuthority = envMap.get('APP_INTERNAL_AUTHORITY');
      if (internalAuthority) {
        envMap.set('APP_URL', `http://${internalAuthority}`);
      }
    }

    const configDomain = domain;
    const suggestedPublicUrl =
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

    const defaultAppBaseUrl = (suggestedPublicUrl ?? envMap.get('APP_URL') ?? '').replace(/\/+$/, '');

    for (const field of config.form_fields) {
      if (field.type !== 'app_base_url') {
        continue;
      }

      const envVar = field.env_variable;
      const formValue = form[envVar];
      const hasValidFormValue = formValue !== undefined && formValue !== '' && formValue !== null;

      let resolvedBaseUrl: string | undefined;

      if (hasValidFormValue) {
        resolvedBaseUrl = String(formValue).replace(/\/+$/, '');
      } else if (existingAppEnvMap.has(envVar)) {
        resolvedBaseUrl = String(existingAppEnvMap.get(envVar)).replace(/\/+$/, '');
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

    // --- Hub trust material: managed key + internal URL (R-ENV / CI-Engineering#74) ---
    // Two independent reasons an app talks to the Hub:
    //  - hub_integration.mcp_client: it consumes Hub MCP tools ('mcp' scope).
    //  - first-party consumer (official-store install declaring hub_integration.memory
    //    or .oidc): it calls app-facing callback endpoints such as memory-connect
    //    state/skip ('app' scope, injected as the neutral HUB_APP_KEY).
    // The callback grant is provenance-gated on the install URN (isOfficialStoreApp):
    // manifest fields are forgeable, store slugs are not — a third-party-store app
    // receives no callback credential no matter what its manifest declares.
    const scopes = hubTrustMaterialScopes(config);
    const isMcpClient = scopes.includes('mcp');
    const isFirstPartyConsumer = scopes.includes('app');
    if (scopes.length > 0) {
      const hubContainerName = process.env.HUB_CONTAINER_NAME || 'ci-os-hub';
      const hubPort = process.env.API_PORT || '3000';
      const hubInternalUrl = `http://${hubContainerName}:${hubPort}`;

      envMap.set('HUB_URL', hubInternalUrl);

      // SEC-MCP-8: provision ONE dedicated managed key per companion app; its scopes
      // express which Hub surfaces it opens. The app's existing key is preserved when
      // it still validates (no churn, like HUB_WAKE_SECRET below) and only its scopes
      // are reconciled — an app gaining a surface keeps the credential it already
      // holds. The key is auto-revoked on uninstall, and the Hub stores only its
      // hash — the raw is injected here into the app's env.
      const existingManagedKey = existingAppEnvMap.get('HUB_APP_KEY') || existingAppEnvMap.get('HUB_MCP_API_KEY');
      const managedKey = await this.apiKeys.provisionManagedKey({
        appUrn,
        appName: config.name ?? appUrn,
        existingRawKey: existingManagedKey,
        scopes,
      });

      if (isMcpClient) {
        // BUG-MCP-1: the Hub now speaks the MCP Streamable HTTP transport on a single endpoint
        // (POST/GET/DELETE at /api/mcp), replacing the old /sse + /messages pair. Agents connect an
        // MCP Streamable HTTP client here with the injected HUB_MCP_API_KEY as the Bearer token.
        envMap.set('HUB_MCP_URL', `${hubInternalUrl}/api/mcp`);
        envMap.set('HUB_MCP_API_KEY', managedKey);

        // Generate or preserve wake secret
        const existingSecret = existingAppEnvMap.get('HUB_WAKE_SECRET');
        if (existingSecret) {
          envMap.set('HUB_WAKE_SECRET', existingSecret);
        } else {
          envMap.set('HUB_WAKE_SECRET', randomBytes(32).toString('hex'));
        }
      }

      if (isFirstPartyConsumer) {
        // The neutral callback credential (same raw value as HUB_MCP_API_KEY when both
        // apply) plus the app's own URN, so consumers that are not MCP clients (e.g.
        // oidc-only) can still address the per-app memory-connect endpoints.
        envMap.set('HUB_APP_KEY', managedKey);
        envMap.set('CI_APP_URN', appUrn);
      }
    }

    // --- Standardized AI Environment Variables (opt-in) ---
    // Apps declare which inference variables they need in config.json via
    // hub_integration.inference. The Hub resolves the values and maps them
    // to the app's expected env variable names. Apps without this field
    // receive no inference variables — zero overhead for non-AI apps.
    const inferenceMapping = config.hub_integration?.inference;
    if (inferenceMapping && Object.keys(inferenceMapping).length > 0) {
      try {
        // Apply the app's context floor (e.g. Hermes' 64K minimum) so this path
        // matches the credentials.env endpoint and never emits a sub-minimum
        // num_ctx that would make the app abort at startup.
        const aiEnv = await this.inferenceEnv.resolve({ minContextLength: appMinContextLength(appName) });
        const HUB_TO_RESOLVED: Record<string, string | undefined> = {
          llm_base_url: aiEnv.CI_LLM_BASE_URL,
          llm_api_key: aiEnv.CI_LLM_API_KEY,
          chat_model: aiEnv.CI_CHAT_MODEL,
          embedding_model: aiEnv.CI_EMBEDDING_MODEL,
          vision_model: aiEnv.CI_VISION_MODEL,
          ollama_host: aiEnv.OLLAMA_HOST,
          num_ctx: aiEnv.CI_LLM_NUM_CTX,
        };
        for (const [hubKey, appEnvVar] of Object.entries(inferenceMapping)) {
          const resolved = HUB_TO_RESOLVED[hubKey];
          if (resolved !== undefined && appEnvVar) {
            envMap.set(appEnvVar, resolved);
          }
        }
      } catch (err) {
        this.logger.warn(`[AppHelpers] Failed to resolve inference env for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Portal OIDC issuer injection ---
    // Apps that "Sign in with CI-Portal" must authenticate against the *paired*
    // Portal IdP — that is CI_CLOUD_URL (ciCloudUrl), already normalized to the
    // Portal origin per environment (https://hub.ci.computer in prod,
    // https://hub.companionintelligence.com in dev). NOTE: this is NOT hub.<DOMAIN>:
    // DOMAIN is the public *app* zone (apps deploy at
    // ci-import-tools-<device>-<org>.companionintelligence.com), which in prod is a
    // different zone from the Portal IdP. If the issuer is not injected, an exposed
    // app falls back to its hardcoded default IdP and the Portal rejects the
    // sign-in with INVALID_REDIRECT_URI (see CI-Hub#870).
    const { ciCloudUrl } = this.config.getConfig();
    const normalizedCloudUrl = ciCloudUrl?.trim().replace(/\/+$/, '');

    // Preferred path: manifest-driven, opt-in injection (mirrors hub_integration.inference).
    // Apps declare the env var they read the issuer from and, optionally, a path
    // suffix (e.g. "/api/auth" for discovery-based clients like CI-Import-Tools).
    // Only opted-in apps are touched, so a third-party app reading a same-named var
    // for its own IdP is never clobbered.
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

    // First-party CI-Server deployments (ci-memory, plus rebuilds from the CI-Server
    // source). Derived once and shared by the OIDC blocks below and the maps-key block
    // further down, which each used to recompute the same predicate.
    const isFirstPartyCiServerApp =
      config.id === 'ci-memory' || (typeof config.source === 'string' && config.source.includes('companionintelligence/CI-Server'));

    // Never overwrite a value the operator pinned in the Hub's own .env (envMap is
    // seeded from it). Mirrors the GOOGLE_MAPS_KEY handling below: Hub-derived
    // defaults fill gaps, they don't win arguments.
    const setUnlessOperatorSet = (key: string, value: string) => {
      if ((envMap.get(key) ?? '').trim().length > 0) {
        return false;
      }

      envMap.set(key, value);

      return true;
    };

    // Backward-compat: first-party CI apps (ci-memory / CI-Server source) that predate
    // the manifest flag still receive the bare-origin OIDC_ISSUER_URL. Skipped when the
    // manifest already declared an OIDC mapping above, to avoid a redundant/conflicting write.
    if (!oidcIntegration && normalizedCloudUrl && isFirstPartyCiServerApp) {
      envMap.set('OIDC_ISSUER_URL', normalizedCloudUrl);
    }

    // --- Portal Bearer-token verification (CI-Server `auth.portal.*`) ---
    // Distinct from the issuer injection above, and NOT gated on it: OIDC_ISSUER_URL
    // feeds CI-Server's `auth.oidc` (the interactive "Sign in with CI-Portal" browser
    // flow), while these three feed `auth.portal` — the Bearer path in
    // JwtOrApiKeyAuthGuard that verifies portal-issued JWTs against the portal JWKS.
    // Two independent config blocks, so an app that later declares
    // hub_integration.oidc must not silently lose its Bearer config.
    //
    // CI-Server ships `auth.portal.enabled: false` with issuer/jwksUri pointing at the
    // *prod* portal. Paired against any other portal, every Bearer call — the browser
    // extension's GET /api/devices and POST /api/v1/events — 401s, and
    // PortalTokenService swallows the verification error, so the cause is invisible.
    //
    // The issuer is the BARE origin, not `<origin>/api/auth`: that path is only the
    // OIDC *discovery* base; the `iss` claim the portal actually stamps is the origin
    // (confirmed against its published discovery document). The JWKS, however, does
    // live under the /api/auth mount.
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

    // --- Companion Memory Google Maps / geocoding key (from Portal) ---
    // Portal holds GOOGLE_MAPS_API_KEY as a wrangler secret and serves it at
    // GET /api/config/maps. Inject into ci-memory so server geocode + the
    // Memory frontend runtime maps config both work without baking Vite keys
    // into images. Best-effort: never fail env generation if Portal is down.
    if (isFirstPartyCiServerApp) {
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

    // --- Companion Memory credential injection (consumer apps) ---
    // Apps opt in via hub_integration.memory (declaring the env vars they read
    // their memory URL + api key from). Once the user has connected the app
    // through the memory-connect flow, the Hub-brokered, user-consented creds
    // are re-emitted here on every env generation (mirrors the inference/oidc
    // opt-in mappings). Recomputing on each generation is what makes the creds
    // survive restarts — a bare app.env write would be clobbered. A brokered
    // connection takes precedence and is re-emitted first; an operator-entered
    // value is used only when no brokered connection exists (to point at an
    // external CI-Server, the operator must Disconnect the brokered one first).
    const memoryIntegration = config.hub_integration?.memory;
    if (memoryIntegration?.url_env && memoryIntegration?.token_env) {
      // The app's own URN, so its wrapper can query the per-app memory-connect
      // state endpoint (`/api/memory-connect/apps/:urn/state`) to decide whether
      // to show the connect interstitial.
      envMap.set('CI_APP_URN', appUrn);

      const operatorSetToken = (envMap.get(memoryIntegration.token_env) ?? '').trim().length > 0;
      // Best-effort (never fail env generation over it) so the Hub UI reflects
      // reality: a brokered connection re-emits its creds, and a manually
      // configured app shows as "manual" (not "Not connected" with a Connect
      // button that would mint a dead key).
      try {
        // A brokered connection the user completed takes precedence and MUST be
        // re-emitted on every regeneration. Checking it first also prevents a
        // manifest that ships a non-empty DEFAULT for token_env from pinning a
        // genuinely connected app to `manual` (which would then stop injecting
        // the real creds). getInjectableCreds is non-null only when connected.
        const creds = await this.memoryConnection.getInjectableCreds(appUrn);
        if (creds) {
          // Hand the app the URL SHAPE its manifest asks for. Only the brokered
          // address is reshaped — an operator-supplied external CI-Server URL falls
          // through to the `else` below and is passed through exactly as entered.
          envMap.set(memoryIntegration.url_env, memoryUrlForStyle(creds.url, memoryIntegration.url_style));
          envMap.set(memoryIntegration.token_env, creds.token);
          this.logger.debug(`[AppHelpers] Injected Companion Memory creds for ${appUrn}`);
        } else if (operatorSetToken) {
          // Operator supplied creds at install and there is no brokered
          // connection → record `manual` so the UI never prompts. markManual is
          // itself idempotent (it skips the write when already manual), so this
          // stays cheap across repeated env regenerations.
          await this.memoryConnection.markManual(appUrn);
        }
      } catch (err) {
        this.logger.warn(`[AppHelpers] memory-connect env resolution failed for ${appUrn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- First-party consumer forward-auth identity (CI-Engineering#74) ---
    // Consumer apps verify the Hub-signed X-CI-Hub-User identity headers with a
    // PER-APP secret: a leaked secret can only forge identities the leaking app
    // itself accepts, never a sibling's. Preserve-or-mint, like HUB_WAKE_SECRET —
    // GET /api/auth/traefik signs with whatever this app.env holds (the
    // ForwardAuthSecretResolver reads it back), so the pair can never drift and
    // rotation is simply "clear the var, regenerate env, restart the app".
    // The provider block below intentionally overrides this for ci-memory with the
    // Hub-global secret: its verifier also authenticates the connect S2S exchange,
    // which is keyed on the global value (memory-exchange.client).
    if (isFirstPartyConsumer) {
      const existingForwardAuthSecret = (existingAppEnvMap.get('CI_HUB_FORWARD_AUTH_SECRET') ?? '').trim();
      envMap.set('CI_HUB_FORWARD_AUTH_ENABLED', 'true');
      envMap.set('CI_HUB_FORWARD_AUTH_SECRET', existingForwardAuthSecret || randomBytes(32).toString('hex'));
      this.logger.debug(`[AppHelpers] Injected per-app forward-auth secret for ${appUrn}`);
    }

    // --- Companion Memory provider (ci-memory) forward-auth provisioning ---
    // ci-memory verifies the Hub's server-to-server connect calls (code
    // exchange, revoke) via signed forward-auth headers keyed on the Hub-global
    // forwardAuthSecret, and only redirects the browser back to allowlisted Hub
    // origins. Inject the shared secret + enable flag + the Hub's public origin
    // so the connect flow works out of the box on this appliance. Trust is keyed
    // on install provenance (isMemoryProviderApp: official-store install URN) —
    // NOT a manifest field like id/source/provider, so no third-party-store app
    // can spoof its way into being handed the forward-auth master secret.
    if (isMemoryProviderApp(config)) {
      const forwardAuthSecret = this.config.get('forwardAuthSecret');
      if (forwardAuthSecret) {
        envMap.set('CI_HUB_FORWARD_AUTH_ENABLED', 'true');
        envMap.set('CI_HUB_FORWARD_AUTH_SECRET', forwardAuthSecret);
      }
      // The Hub origins ci-memory allowlists as valid connect return targets.
      //
      // BOTH of the Hub's browser-reachable origins are listed, comma-separated
      // (CI-Server splits and normalises the list — see ConnectService
      // `allowedHubOrigins`). The public tunnel route is the usual one; the LAN
      // origin is what lets the whole ceremony run on the local network when the
      // tunnel is down, or on an appliance that was never registered. Without the
      // LAN entry here, ci-memory rejects the callback and the local fallback
      // cannot work at all (CI-Engineering#75, Problem 4a).
      // A loopback local origin is dropped: on a listen-all INTERNAL_IP,
      // buildHubLocalOrigin collapses to `http://127.0.0.1`, and 127.0.0.1 inside
      // the ci-memory container resolves to ci-memory itself, not the Hub — so it
      // can never match a real callback and only bloats the allowlist. The LAN
      // callback leg genuinely cannot work for a listen-all appliance (its real
      // LAN IP is unknown), so there is nothing to preserve.
      // The tailnet origin joins the list whenever the Private VPN is up: it is
      // the origin the whole ceremony runs on for a VPN caller, and without it
      // here ci-memory rejects that caller's callback outright
      // (CI-Engineering#78). Like the LAN entry, its absence (VPN down at env
      // generation time) simply means that leg is not offered — reconnecting the
      // VPN requires regenerating ci-memory's env (a restart) to pick it up.
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

    await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
  };
}
