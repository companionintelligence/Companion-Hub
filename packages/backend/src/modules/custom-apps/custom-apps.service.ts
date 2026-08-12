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
import type { CreateCustomAppDto, UpdateCustomAppDto } from './dto/custom-apps.dto';
import { getFrontmatter } from '@/utils/frontmatter/frontmatter';
import { frontmatterSchema, type AppInfo, type ServiceInput } from '@ci-hub/common/schemas';

const APPS_FOLDER = '_user';

@Injectable()
export class CustomAppService {
  constructor(
    private readonly logger: LoggerService,
    private readonly filesystem: FilesystemService,
    private readonly configService: ConfigurationService,
    private readonly appsRepository: AppsRepository,
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

    try {
      await this.createAppDirectories(appUrn);
      await this.writeDockerComposeConfig(appUrn, config);
      await this.createAppInfo(appUrn, displayName, config);

      await this.appsRepository.createApp({
        appStoreSlug: APPS_FOLDER,
        appName: slug,
        config: {},
        status: 'missing',
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
      console.error(error);
      throw new TranslatableError('CUSTOM_APP_ERROR_CREATION_FAILED', { name: displayName }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  async updateCustomApp(appUrn: AppUrn, config: UpdateCustomAppDto['config']) {
    if (this.configService.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    const existingApp = await this.appsRepository.getAppByUrn(appUrn);
    if (!existingApp) {
      throw new TranslatableError('CUSTOM_APP_ERROR_NOT_FOUND', { urn: appUrn }, HttpStatus.NOT_FOUND);
    }

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

    const main = config.services.find((s: ServiceInput) => s.isMain) ?? config.services[0];
    const inferredPort = typeof main?.internalPort === 'number' ? main.internalPort : undefined;

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

    const { appName, appStoreId } = extractAppUrn(appUrn);

    if (appStoreId !== APPS_FOLDER) {
      throw new TranslatableError('CUSTOM_APP_ERROR_NOT_CUSTOM', { urn: appUrn }, HttpStatus.BAD_REQUEST);
    }

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
