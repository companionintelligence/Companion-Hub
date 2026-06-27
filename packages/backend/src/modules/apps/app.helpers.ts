import { randomBytes } from 'node:crypto';
import path from 'node:path';
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

/**
 * Host paths may be POSIX (/foo/bar), Windows drive-letter (C:/foo), or UNC
 * (\\server\share). The backend often runs in a Linux container, so use both
 * path.isAbsolute and path.win32.isAbsolute.
 */
function isAbsoluteHostPath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
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

    // APP_DATA_DIR must be the host absolute path for Docker volume mounts
    // Docker Compose runs from inside the ci-os-hub container but connects to the host Docker daemon
    // So it needs the host path, not the container path
    // The volume is mounted as: ${CI_HUB_APP_DATA_PATH:-.internal}/app-data:/app-data
    // We need to construct the absolute host path that matches this mount

    // Get the base path (without /app-data suffix)
    const baseAppDataPath = envMap.get('CI_HUB_APP_DATA_PATH') || userSettings.appDataPath || rootFolderHost;

    this.logger.debug(
      `Constructing APP_DATA_DIR for ${appUrn}: ` +
        `CI_HUB_APP_DATA_PATH=${envMap.get('CI_HUB_APP_DATA_PATH')}, ` +
        `userSettings.appDataPath=${userSettings.appDataPath}, ` +
        `rootFolderHost=${rootFolderHost}, ` +
        `baseAppDataPath=${baseAppDataPath}`,
    );

    // Ensure absolute path - resolve relative paths
    let appDataHostBase: string;
    if (isAbsoluteHostPath(baseAppDataPath)) {
      appDataHostBase = baseAppDataPath;
      this.logger.debug(`Using absolute baseAppDataPath: ${appDataHostBase}`);
    } else if (isAbsoluteHostPath(rootFolderHost)) {
      // Resolve relative path - try multiple strategies
      appDataHostBase = path.resolve(rootFolderHost, baseAppDataPath);
      this.logger.debug(`Resolved relative baseAppDataPath against rootFolderHost: ${appDataHostBase}`);
    } else {
      // Try environment variable
      const envRoot = process.env.ROOT_FOLDER_HOST;
      if (envRoot && isAbsoluteHostPath(envRoot)) {
        appDataHostBase = path.resolve(envRoot, baseAppDataPath);
        this.logger.debug(`Resolved relative baseAppDataPath against process.env.ROOT_FOLDER_HOST: ${appDataHostBase}`);
      } else {
        // Both paths are relative - this is a problem
        this.logger.error(
          `Both ROOT_FOLDER_HOST (${rootFolderHost}) and CI_HUB_APP_DATA_PATH (${baseAppDataPath}) are relative. ` +
            'APP_DATA_DIR will not resolve correctly. Please set ROOT_FOLDER_HOST to an absolute path.',
        );
        throw new Error(
          'Cannot resolve APP_DATA_DIR: Both ROOT_FOLDER_HOST and CI_HUB_APP_DATA_PATH are relative paths. ' +
            'ROOT_FOLDER_HOST must be an absolute path.',
        );
      }
    }

    // Ensure the base path doesn't already end with /app-data
    // If CI_HUB_APP_DATA_PATH already includes /app-data, remove it
    if (appDataHostBase.endsWith('/app-data') || appDataHostBase.endsWith('\\app-data')) {
      appDataHostBase = appDataHostBase.slice(0, -9); // Remove '/app-data'
      this.logger.debug(`Removed /app-data suffix from base path: ${appDataHostBase}`);
    }

    // Add /app-data suffix if not present
    const appDataHostPath = path.join(appDataHostBase, 'app-data');

    // Final path: {hostPath}/app-data/{appStoreId}/{appName}
    // This will be used in the app's docker-compose.yml as ${APP_DATA_DIR}
    const finalAppDataDir = path.join(appDataHostPath, appStoreId, appName);

    // CRITICAL: Verify this is an absolute host path, not a container path
    if (!isAbsoluteHostPath(finalAppDataDir)) {
      this.logger.error(`APP_DATA_DIR is not absolute: ${finalAppDataDir}. This will cause Docker mount errors.`);
      throw new Error(`APP_DATA_DIR must be an absolute path, got: ${finalAppDataDir}`);
    }

    if (finalAppDataDir.startsWith('/app-data') || finalAppDataDir.startsWith('/data/')) {
      this.logger.error(
        `APP_DATA_DIR appears to be a container path: ${finalAppDataDir}. ` +
          'This will cause Docker mount errors. Using fallback path construction.',
      );
      // Fallback: construct path from ROOT_FOLDER_HOST
      const fallbackBase = isAbsoluteHostPath(rootFolderHost) ? rootFolderHost : process.env.ROOT_FOLDER_HOST || '/tmp';
      const fallbackPath = path.join(fallbackBase, 'app-data', appStoreId, appName);
      envMap.set('APP_DATA_DIR', fallbackPath);
      this.logger.warn(`Using fallback APP_DATA_DIR: ${fallbackPath}`);
    } else {
      envMap.set('APP_DATA_DIR', finalAppDataDir);
      this.logger.info(`Set APP_DATA_DIR for ${appUrn}: ${finalAppDataDir}`);
    }
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
      envMap.set('HUB_MCP_URL', `${hubInternalUrl}/api/mcp/sse`);
      envMap.set('HUB_MCP_MESSAGES_URL', `${hubInternalUrl}/api/mcp/messages`);

      // Inject MCP API key so the agent can authenticate with the Hub MCP endpoint
      if (process.env.MCP_API_KEY) {
        envMap.set('HUB_MCP_API_KEY', process.env.MCP_API_KEY);
      }

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

    // --- Portal OIDC issuer (first-party CI apps only) ---
    // CI-Server's "Sign in with CI-Portal" flow needs the Portal OIDC IdP origin.
    // That is CI_CLOUD_URL (ciCloudUrl) — already normalized to the Portal origin
    // per environment (https://hub.ci.computer in prod, https://hub.companionintelligence.com
    // in dev). NOTE: this is NOT hub.<DOMAIN>: DOMAIN is the public *app* zone
    // (apps deploy at ci-memory-<org>.companionintelligence.com), which in prod is
    // a different zone from the Portal IdP. We only inject for first-party CI apps;
    // a third-party app (e.g. AnythingLLM) may read OIDC_ISSUER_URL for its own IdP,
    // so we must never clobber it.
    const { ciCloudUrl } = this.config.getConfig();
    const isFirstPartyPortalOidcApp =
      config.id === 'ci-memory' || (typeof config.source === 'string' && config.source.includes('companionintelligence/CI-Server'));
    if (isFirstPartyPortalOidcApp && ciCloudUrl) {
      envMap.set('OIDC_ISSUER_URL', ciCloudUrl.replace(/\/+$/, ''));
    }

    envMap.delete('APP_PUBLIC_DOMAIN');

    await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
  };
}
