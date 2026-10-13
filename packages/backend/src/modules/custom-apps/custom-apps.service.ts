import { TranslatableError } from '@/common/error/translatable-error';
import { createAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { deriveAppSlug, RESERVED_APP_NAMES } from '@ci-hub/common/types';
import path from 'node:path';
import { AppsRepository } from '../apps/apps.repository';
import { PortManagerService, type PortAllocation } from '../network/port-manager.service';
import type { CreateCustomAppDto, UpdateCustomAppDto } from './dto/custom-apps.dto';
import {
  allocateCustomAppHostPort,
  customAppMainPortAvoids,
  hubHostPorts,
  mappedHostPorts,
  parsePort,
  type MappedHostPort,
} from './custom-app-host-port';
import { getFrontmatter } from '@/utils/frontmatter/frontmatter';
import { frontmatterSchema, type AppInfo, type ServiceInput } from '@ci-hub/common/schemas';

const APPS_FOLDER = '_user';

/**
 * The main service's port, which becomes the app's single access port. The create form submits it as
 * typed, a string; a number only comes from a hand-written config. A value that is not a plain port (an
 * env reference, a range) leaves it unset.
 */
function mainServicePort(config: CreateCustomAppDto['config']): number | undefined {
  const main = config.services.find((s: ServiceInput) => s.isMain) ?? config.services[0];
  return parsePort(main?.internalPort);
}

@Injectable()
export class CustomAppService {
  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly configService: ConfigurationService,
    private readonly appsRepository: AppsRepository,
    private readonly portManager: PortManagerService,
  ) {}

  async createCustomApp(dto: CreateCustomAppDto): Promise<{ appUrn: AppUrn; appName: string; storeId: string }> {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const { name, config } = dto;

    const displayName = name.trim();
    // Derive a URL-safe slug from the free-form display name. The slug is the
    // app identifier (URN, on-disk directory); the display name is preserved
    // verbatim for the UI, mirroring how marketplace apps keep `name` and `id`
    // separate.
    const slug = deriveAppSlug(displayName);
    if (!slug) {
      throw new TranslatableError('CUSTOM_APP_NAME_NO_SLUG', undefined, HttpStatus.BAD_REQUEST);
    }
    if (RESERVED_APP_NAMES.includes(slug)) {
      throw new TranslatableError('CUSTOM_APP_NAME_RESERVED', undefined, HttpStatus.BAD_REQUEST);
    }

    const appUrn = createAppUrn(slug, APPS_FOLDER);

    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (existingApp) {
      throw new TranslatableError('CUSTOM_APP_ERROR_DUPLICATE_NAME', { name: displayName }, HttpStatus.CONFLICT);
    }

    const hubPorts = hubHostPorts(this.configService.get('userSettings'));
    const mappings = mappedHostPorts(config.services);

    // Before anything is written, so a refusal leaves no files or row behind.
    await this.assertMappedHostPortsFree(mappings, hubPorts);

    try {
      await this.createAppDirectories(appUrn);
      await this.writeDockerComposeConfig(appUrn, config);
      await this.createAppInfo(appUrn, displayName, config);

      const internalPort = mainServicePort(config);
      let hostPort: number | undefined;
      if (internalPort !== undefined) {
        // No row holds this URN, so any allocation under it was left by an app of the same name whose
        // removal could not give its ports back. Install clears them the same way.
        await this.portManager.releaseAll(appUrn);
        const avoid = await customAppMainPortAvoids(this.appsRepository, appUrn, mappings, [internalPort], hubPorts);
        hostPort = await allocateCustomAppHostPort(this.portManager, appUrn, internalPort, avoid);
      }

      await this.appsRepository.createApp({
        appStoreSlug: APPS_FOLDER,
        appName: slug,
        // Stored as an install stores the port it allocated: the start publishes `${APP_PORT}` from it.
        config: hostPort === undefined ? {} : { port: hostPort },
        port: hostPort,
        // Created but not started yet — same durable status as compose-down stop.
        status: 'stopped',
      });

      this.logger.info(`Custom app ${displayName} (${slug}) created successfully with URN ${appUrn}`);

      return {
        appUrn,
        appName: slug,
        storeId: APPS_FOLDER,
      };
    } catch (error) {
      this.logger.error(`Failed to create custom app ${slug}:`, error);
      await this.cleanupAppDirectories(appUrn).catch(() => {
        // Noop
      });
      await this.portManager.releaseAll(appUrn).catch(() => 0);
      console.error(error);
      throw new TranslatableError('CUSTOM_APP_ERROR_CREATION_FAILED', { name: displayName }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * Refuse a Port Mappings host port that is already held: one the Hub's own containers publish, one the
   * port manager gave an app, one an app's row publishes, or one mapped twice. On an edit, the app's own
   * row counts too: its main port is published on the same host. A port nobody holds stays allowed, even
   * one the port manager won't hand out itself (53 for a DNS server, 5432 for a database), because a
   * mapping is published exactly as given.
   */
  private async assertMappedHostPortsFree(mappings: ReadonlyArray<MappedHostPort>, hubPorts: ReadonlySet<number>): Promise<void> {
    const seen = new Set<string>();
    let allocations: Promise<PortAllocation[]> | undefined;
    const allocated = async (hostPort: number, protocol: 'tcp' | 'udp') => {
      allocations ??= this.portManager.getAllAllocations();
      return (await allocations).some((allocation) => allocation.hostPort === hostPort && allocation.protocol === protocol);
    };

    for (const { hostPort, protocol } of mappings) {
      const key = `${hostPort}/${protocol}`;
      const held =
        seen.has(key) ||
        (protocol === 'tcp' && (hubPorts.has(hostPort) || (await this.appsRepository.getAppsByPort(hostPort)).length > 0)) ||
        (await allocated(hostPort, protocol));

      if (held) {
        throw new TranslatableError('CUSTOM_APP_ERROR_HOST_PORT_IN_USE', { port: String(hostPort) }, HttpStatus.CONFLICT);
      }
      seen.add(key);
    }
  }

  /**
   * Refuse an app that did not come from "Add custom app".
   *
   * ⚠ THE URN IS CALLER-SUPPLIED AND THESE METHODS WRITE TO WHATEVER IT NAMES. An installed
   * store app lives at the same `apps/<store>/<app>/` layout, so without this a custom-app route
   * rewrites an official app's `docker-compose.json` or `config.json` — and that app keeps the
   * extra container privileges granted to its store, which the sandbox that custom content is
   * validated against never gave it.
   */
  private assertCustomApp(appUrn: AppUrn): void {
    if (extractAppUrn(appUrn).appStoreId !== APPS_FOLDER) {
      throw new TranslatableError('CUSTOM_APP_ERROR_NOT_CUSTOM', { urn: appUrn }, HttpStatus.BAD_REQUEST);
    }
  }

  async updateCustomApp(appUrn: AppUrn, config: UpdateCustomAppDto['config']) {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    this.assertCustomApp(appUrn);

    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (!existingApp) {
      throw new TranslatableError('CUSTOM_APP_ERROR_NOT_FOUND', { urn: appUrn }, HttpStatus.NOT_FOUND);
    }

    // An edit can add Port Mappings too, and they are held to the same rule as on creation.
    await this.assertMappedHostPortsFree(mappedHostPorts(config.services), hubHostPorts(this.configService.get('userSettings')));

    try {
      await this.writeDockerComposeConfig(appUrn, config);
      this.logger.info(`Custom app ${appUrn} updated successfully`);
    } catch (error) {
      this.logger.error(`Failed to update custom app ${appUrn}:`, error);
      throw new TranslatableError('CUSTOM_APP_ERROR_UPDATE_FAILED', { urn: appUrn }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async createAppDirectories(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir, appDataDir } = this.configService.get('directories');

    // App definitions live under dataDir/apps; runtime data uses the dedicated appDataDir mount
    // (/app-data), not dataDir/app-data (which is not writable / does not exist in the container).
    const appPath = path.join(dataDir, 'apps', appStoreId, appName);
    const dataPath = path.join(appDataDir, appStoreId, appName);

    const ok = await this.filesystem.createDirectories([appPath, dataPath]);
    if (!ok) {
      throw new Error(`Failed to create app directories at ${appPath} and ${dataPath}`);
    }
  }

  private async writeDockerComposeConfig(appUrn: AppUrn, config: CreateCustomAppDto['config']): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');

    const configPath = path.join(dataDir, 'apps', appStoreId, appName, 'docker-compose.json');
    const configContent = JSON.stringify(config, null, 2);

    const ok = await this.filesystem.writeTextFile(configPath, configContent);
    if (!ok) {
      throw new Error(`Failed to write docker-compose config at ${configPath}`);
    }
  }

  private async createAppInfo(appUrn: AppUrn, name: string, config: CreateCustomAppDto['config']): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');

    const infoPath = path.join(dataDir, 'apps', appStoreId, appName, 'config.json');

    const inferredPort = mainServicePort(config);

    // Create a minimal app.info file for custom apps
    const appInfo = {
      id: appName,
      name: name,
      urn: appUrn,
      available: true,
      port: inferredPort,
      categories: ['utilities'],
      description: `Custom application: ${name}`,
      short_desc: 'User-created custom app',
      replaces: [],
      author: 'User',
      source: '',
      website: '',
      exposable: true,
      no_gui: false,
      supported_architectures: ['amd64', 'arm64'],
      cihub_app_version: 1,
      version: '1.0.0',
      dynamic_config: true,
      deprecated: false,
      force_expose: false,
      generate_vapid_keys: false,
      form_fields: [],
      https: false,
      created_at: Date.now(),
      updated_at: Date.now(),
      force_pull: false,
    } satisfies AppInfo;

    const descriptionPath = path.join(dataDir, 'apps', appStoreId, appName, 'metadata', 'description.md');
    // JSON.stringify produces a valid double-quoted YAML scalar, keeping the
    // frontmatter well-formed for free-form names (e.g. containing a colon).
    const descriptionContent = `---\nname: ${JSON.stringify(name)}\nshort_desc: User-created custom app\nversion: 1.0.0\n---\n\n# ${name}\n\nThis is a user-created custom application.\n`;

    const ok = await this.filesystem.writeJsonFile(infoPath, appInfo);
    if (!ok) {
      throw new Error(`Failed to write app info at ${infoPath}`);
    }

    const metadataDir = path.join(dataDir, 'apps', appStoreId, appName, 'metadata');
    await this.filesystem.createDirectory(metadataDir);

    const okDesc = await this.filesystem.writeTextFile(descriptionPath, descriptionContent);
    if (!okDesc) {
      throw new Error(`Failed to write description at ${descriptionPath}`);
    }
  }

  async uploadAppImage(appUrn: AppUrn, imageBuffer: Buffer): Promise<void> {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    this.assertCustomApp(appUrn);

    const { appName, appStoreId } = extractAppUrn(appUrn);

    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (!existingApp) {
      throw new TranslatableError('CUSTOM_APP_ERROR_NOT_FOUND', { urn: appUrn }, HttpStatus.NOT_FOUND);
    }

    try {
      const { dataDir } = this.configService.get('directories');
      const metadataDir = path.join(dataDir, 'apps', appStoreId, appName, 'metadata');
      const logoPath = path.join(metadataDir, 'logo.jpg');

      await this.filesystem.createDirectory(metadataDir);

      const ok = await this.filesystem.writeBinaryFile(logoPath, imageBuffer);
      if (!ok) {
        throw new Error(`Failed to write logo at ${logoPath}`);
      }

      this.logger.info(`Custom app ${appUrn} logo uploaded successfully`);
    } catch (error) {
      this.logger.error(`Failed to upload logo for custom app ${appUrn}:`, error);
      throw new TranslatableError('CUSTOM_APP_ERROR_UPLOAD_FAILED', { urn: appUrn }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async cleanupAppDirectories(appUrn: AppUrn): Promise<void> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir, appDataDir } = this.configService.get('directories');

    const appPath = path.join(dataDir, 'apps', appStoreId, appName);
    const dataPath = path.join(appDataDir, appStoreId, appName);

    await Promise.all([this.filesystem.removeDirectory(appPath), this.filesystem.removeDirectory(dataPath)]);
  }

  public async updateAppMetadata(appUrn: AppUrn, description: string): Promise<void> {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    this.assertCustomApp(appUrn);

    const { appName, appStoreId } = extractAppUrn(appUrn);
    const { dataDir } = this.configService.get('directories');

    const descriptionPath = path.join(dataDir, 'apps', appStoreId, appName, 'metadata', 'description.md');

    const configPath = path.join(dataDir, 'apps', appStoreId, appName, 'config.json');

    const frontmatterYml = getFrontmatter(description) || {};

    if (frontmatterYml) {
      const frontmatter = await frontmatterSchema.safeParseAsync(frontmatterYml);

      if (!frontmatter.success) {
        throw new Error(`Invalid frontmatter: ${frontmatter.error.message}`);
      }

      const appInfo = await this.filesystem.readJsonFile(configPath);

      if (!appInfo) {
        throw new Error(`Failed to read app info at ${configPath}`);
      }

      const ok = await this.filesystem.writeJsonFile(configPath, {
        ...appInfo,
        ...frontmatter.data,
      });

      if (!ok) {
        throw new Error(`Failed to update app info at ${configPath}`);
      }
    }

    const ok = await this.filesystem.writeTextFile(descriptionPath, description);
    if (!ok) {
      throw new Error(`Failed to write description at ${descriptionPath}`);
    }
  }
}
