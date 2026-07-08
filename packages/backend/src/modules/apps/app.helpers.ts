import { randomBytes } from 'node:crypto';
import { getAppDataHostPath } from '@/common/helpers/app-data-path.helper';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { resolveBrowserHost } from '@/common/helpers/browser-host';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { buildFqdnSubdomain, buildPublicWebIdentity, resolvePublicDomainRoot, sanitizeAppSubdomain } from '@ci-hub/common/types';
import { EnvUtils } from '../env/env.utils';
import type { AppEventFormInput } from '../queue/entities/app-events';
import { AppFilesManager } from './app-files-manager';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { RegistrationService } from '../registration/registration.service';
import { appMinContextLength } from '../inference/context-length.util';
import { InferenceEnvResolver } from '../inference/inference-env-resolver';
import { McpApiKeyService } from '../mcp/mcp-api-key.service';
import { MemoryConnectionService } from '../memory-connect/memory-connection.service';

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
    private readonly mcpApiKeys: McpApiKeyService,
    private readonly memoryConnection: MemoryConnectionService,
  ) {}

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

    // --- MCP Integration for Agent Harness Apps (R-ENV) ---
    if (config.hub_integration?.mcp_client) {
      const hubContainerName = process.env.HUB_CONTAINER_NAME || 'ci-os-hub';
      const hubPort = process.env.API_PORT || '3000';
      const hubInternalUrl = `http://${hubContainerName}:${hubPort}`;

      envMap.set('HUB_URL', hubInternalUrl);
      // BUG-MCP-1: the Hub now speaks the MCP Streamable HTTP transport on a single endpoint
      // (POST/GET/DELETE at /api/mcp), replacing the old /sse + /messages pair. Agents connect an
      // MCP Streamable HTTP client here with the injected HUB_MCP_API_KEY as the Bearer token.
      envMap.set('HUB_MCP_URL', `${hubInternalUrl}/api/mcp`);

      // SEC-MCP-8: provision a DEDICATED managed key for this companion app rather than sharing the
      // single Hub key. The app's existing key is preserved if it still validates (no churn, like
      // HUB_WAKE_SECRET below); otherwise a fresh one is minted. The key is auto-revoked on uninstall,
      // and the Hub stores only its hash — the raw is injected here into the app's env.
      const existingMcpKey = existingAppEnvMap.get('HUB_MCP_API_KEY');
      const mcpKey = await this.mcpApiKeys.provisionManagedKey({
        appUrn,
        appName: config.name ?? appUrn,
        existingRawKey: existingMcpKey,
      });
      envMap.set('HUB_MCP_API_KEY', mcpKey);

      // Generate or preserve wake secret
      const existingSecret = existingAppEnvMap.get('HUB_WAKE_SECRET');
      if (existingSecret) {
        envMap.set('HUB_WAKE_SECRET', existingSecret);
      } else {
        envMap.set('HUB_WAKE_SECRET', randomBytes(32).toString('hex'));
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

    // Backward-compat: first-party CI apps (ci-memory / CI-Server source) that predate
    // the manifest flag still receive the bare-origin OIDC_ISSUER_URL. Skipped when the
    // manifest already declared an OIDC mapping above, to avoid a redundant/conflicting write.
    // The first-party check is computed lazily so opted-in apps (the common path going
    // forward) don't pay for the id/source scan on every env generation.
    if (!oidcIntegration && normalizedCloudUrl) {
      const isFirstPartyPortalOidcApp =
        config.id === 'ci-memory' || (typeof config.source === 'string' && config.source.includes('companionintelligence/CI-Server'));
      if (isFirstPartyPortalOidcApp) {
        envMap.set('OIDC_ISSUER_URL', normalizedCloudUrl);
      }
    }

    // --- Companion Memory credential injection (consumer apps) ---
    // Apps opt in via hub_integration.memory (declaring the env vars they read
    // their memory URL + api key from). Once the user has connected the app
    // through the memory-connect flow, the Hub-brokered, user-consented creds
    // are re-emitted here on every env generation (mirrors the inference/oidc
    // opt-in mappings). Recomputing on each generation is what makes the creds
    // survive restarts — a bare app.env write would be clobbered. A value the
    // operator entered manually at install always takes precedence.
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
          envMap.set(memoryIntegration.url_env, creds.url);
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

    // --- Companion Memory provider (ci-memory) forward-auth provisioning ---
    // ci-memory verifies the Hub's server-to-server connect calls (code
    // exchange, revoke) via signed forward-auth headers keyed on the Hub-global
    // forwardAuthSecret, and only redirects the browser back to allowlisted Hub
    // origins. Inject the shared secret + enable flag + the Hub's public origin
    // so the connect flow works out of the box on this appliance.
    const isMemoryProvider = config.id === 'ci-memory' || !!config.hub_integration?.memory?.provider;
    if (isMemoryProvider) {
      const forwardAuthSecret = this.config.get('forwardAuthSecret');
      if (forwardAuthSecret) {
        envMap.set('CI_HUB_FORWARD_AUTH_ENABLED', 'true');
        envMap.set('CI_HUB_FORWARD_AUTH_SECRET', forwardAuthSecret);
      }
      // The Hub's browser-reachable origin (its Traefik/tunnel route,
      // `<hubSubdomain>.<domain>` — see traefik-config.service.writeHubRoute).
      // This is the origin ci-memory allowlists as a valid connect return target.
      if (org?.hubSubdomain && domain && domain !== 'example.com') {
        envMap.set('CI_HUB_ORIGINS', `https://${org.hubSubdomain}.${domain}`);
      }
    }

    envMap.delete('APP_PUBLIC_DOMAIN');

    await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
  };
}
