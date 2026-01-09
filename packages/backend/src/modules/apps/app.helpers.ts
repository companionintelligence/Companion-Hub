import path from 'node:path';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { EnvUtils } from '../env/env.utils';
import type { AppEventFormInput } from '../queue/entities/app-events';
import { AppFilesManager } from './app-files-manager';
import { OrganizationRepository } from '../registration/organization.repository';

@Injectable()
export class AppHelpers {
  constructor(
    private readonly appFilesManager: AppFilesManager,
    private readonly config: ConfigurationService,
    private readonly filesytem: FilesystemService,
    private readonly envUtils: EnvUtils,
    private readonly logger: LoggerService,
    private readonly organizationRepository: OrganizationRepository,
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
    const { internalIp, envFilePath, rootFolderHost, userSettings } = this.config.getConfig();

    const config = await this.appFilesManager.getInstalledAppInfo(appUrn);

    if (!config) {
      throw new Error(`App ${appUrn} not found`);
    }

    const baseEnvFile = await this.filesytem.readTextFile(envFilePath);
    const envMap = this.envUtils.envStringToMap(baseEnvFile?.toString() ?? '');

    const { appName, appStoreId } = extractAppUrn(appUrn);

    // Ensure DOMAIN and LOCAL_DOMAIN are set (required for Traefik label interpolation)
    // These come from the base env file, but ensure they're present with defaults
    if (!envMap.has('DOMAIN')) {
      envMap.set('DOMAIN', userSettings.domain || 'ci.computer');
    }
    if (!envMap.has('LOCAL_DOMAIN')) {
      envMap.set('LOCAL_DOMAIN', userSettings.localDomain || 'tipi.lan');
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
    // The volume is mounted as: ${RUNTIPI_APP_DATA_PATH:-.internal}/app-data:/app-data
    // We need to construct the absolute host path that matches this mount

    // Get the base path (without /app-data suffix)
    const baseAppDataPath = envMap.get('RUNTIPI_APP_DATA_PATH') || userSettings.appDataPath || rootFolderHost;

    this.logger.debug(
      `Constructing APP_DATA_DIR for ${appUrn}: ` +
        `RUNTIPI_APP_DATA_PATH=${envMap.get('RUNTIPI_APP_DATA_PATH')}, ` +
        `userSettings.appDataPath=${userSettings.appDataPath}, ` +
        `rootFolderHost=${rootFolderHost}, ` +
        `baseAppDataPath=${baseAppDataPath}`,
    );

    // Ensure absolute path - resolve relative paths
    let appDataHostBase: string;
    if (path.isAbsolute(baseAppDataPath)) {
      appDataHostBase = baseAppDataPath;
      this.logger.debug(`Using absolute baseAppDataPath: ${appDataHostBase}`);
    } else if (path.isAbsolute(rootFolderHost)) {
      // Resolve relative path - try multiple strategies
      appDataHostBase = path.resolve(rootFolderHost, baseAppDataPath);
      this.logger.debug(`Resolved relative baseAppDataPath against rootFolderHost: ${appDataHostBase}`);
    } else {
      // Try environment variable
      const envRoot = process.env.ROOT_FOLDER_HOST;
      if (envRoot && path.isAbsolute(envRoot)) {
        appDataHostBase = path.resolve(envRoot, baseAppDataPath);
        this.logger.debug(`Resolved relative baseAppDataPath against process.env.ROOT_FOLDER_HOST: ${appDataHostBase}`);
      } else {
        // Both paths are relative - this is a problem
        this.logger.error(
          `Both ROOT_FOLDER_HOST (${rootFolderHost}) and RUNTIPI_APP_DATA_PATH (${baseAppDataPath}) are relative. ` +
            'APP_DATA_DIR will not resolve correctly. Please set ROOT_FOLDER_HOST to an absolute path.',
        );
        throw new Error(
          'Cannot resolve APP_DATA_DIR: Both ROOT_FOLDER_HOST and RUNTIPI_APP_DATA_PATH are relative paths. ' +
            'ROOT_FOLDER_HOST must be an absolute path.',
        );
      }
    }

    // Ensure the base path doesn't already end with /app-data
    // If RUNTIPI_APP_DATA_PATH already includes /app-data, remove it
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
    if (!path.isAbsolute(finalAppDataDir)) {
      this.logger.error(`APP_DATA_DIR is not absolute: ${finalAppDataDir}. This will cause Docker mount errors.`);
      throw new Error(`APP_DATA_DIR must be an absolute path, got: ${finalAppDataDir}`);
    }

    if (finalAppDataDir.startsWith('/app-data') || finalAppDataDir.startsWith('/data/')) {
      this.logger.error(
        `APP_DATA_DIR appears to be a container path: ${finalAppDataDir}. ` +
          'This will cause Docker mount errors. Using fallback path construction.',
      );
      // Fallback: construct path from ROOT_FOLDER_HOST
      const fallbackBase = path.isAbsolute(rootFolderHost) ? rootFolderHost : process.env.ROOT_FOLDER_HOST || '/tmp';
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

    envMap.set('APP_EXPOSED', 'false');
    envMap.set('APP_HOST', internalIp);
    envMap.set('APP_PROTOCOL', 'http');

    if (config.port && form.port) {
      envMap.set('APP_DOMAIN', `${internalIp}:${form.port}`);
    }

    if (form.exposedLocal) {
      const subdomain = form.localSubdomain ? form.localSubdomain : `${appName}-${appStoreId}`;
      // exposedLocal means "publish to internet via Cloudflare"
      // Container should think it's public and HTTPS (even though Traefik receives HTTP from Cloudflare)
      const publicDomain = envMap.get('DOMAIN') || 'ci.computer';
      envMap.set('APP_LOCAL_DOMAIN', `${subdomain}.${envMap.get('LOCAL_DOMAIN') || 'tipi.lan'}`);

      if (!form.openPort) {
        // App thinks it's public HTTPS (for proper URL generation and SSL handling)
        // Traefik will set X-Forwarded-Proto: https header so apps know they're behind HTTPS
        envMap.set('APP_EXPOSED', 'true');
        envMap.set('APP_EXPOSED_DOMAIN', `${subdomain}.${publicDomain}`);
        envMap.set('APP_PROTOCOL', 'https');
        envMap.set('APP_DOMAIN', `${subdomain}.${publicDomain}`);
        envMap.set('APP_HOST', `${subdomain}.${publicDomain}`);
      }
    }

    if (form.exposed && form.domain && typeof form.domain === 'string') {
      envMap.set('APP_EXPOSED', 'true');
      envMap.set('APP_DOMAIN', form.domain);
      envMap.set('APP_HOST', form.domain);
      envMap.set('APP_EXPOSED_DOMAIN', form.domain);
      envMap.set('APP_PROTOCOL', 'https');
    }

    if (appName === 'cloudflared') {
      const org = await this.organizationRepository.getFirstOrganization();
      if (org && org.tunnelToken && org.tunnelId) {
        envMap.set('TUNNEL_TOKEN', org.tunnelToken);
        envMap.set('TUNNEL_ID', org.tunnelId);
      } else {
        this.logger.warn('cloudflared app installation requested, but no organization/tunnel information found.');
      }
    }

    await this.appFilesManager.writeAppEnv(appUrn, this.envUtils.envMapToString(envMap));
  };
}
