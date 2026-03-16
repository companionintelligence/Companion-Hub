import { TranslatableError } from '@/common/error/translatable-error';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HttpStatus, Injectable, Inject, forwardRef, OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import slugify from 'slugify';
import type { UpdateAppStoreBodyDto } from '../marketplace/dto/marketplace.dto';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { AppStoreRepository } from './app-store.repository';
import { ReposHelpers } from './repos.helpers';

export const RESERVED_APP_STORE_SLUGS = ['_user'];

@Injectable()
export class AppStoreService implements OnApplicationBootstrap, OnApplicationShutdown {
  private pullInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly repoQueue: RepoEventsQueue,
    @Inject(forwardRef(() => ReposHelpers)) private readonly repoHelpers: ReposHelpers,
    private readonly config: ConfigurationService,
    private readonly appStoreRepository: AppStoreRepository,
  ) {
    this.repoQueue.onEvent(async (data, reply) => {
      switch (data.command) {
        case 'update_all': {
          const stores = await this.appStoreRepository.getEnabledAppStores();
          const results = await Promise.allSettled(stores.map((store) => this.repoHelpers.pullRepo(store.url, store.slug, store.type ?? 'git')));
          // Log failures but don't fail the entire operation
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              this.logger.error(`Failed to update repo ${stores[index]?.slug}: ${result.reason}`);
            } else if (result.value.success === false) {
              this.logger.warn(`Skipped invalid repo ${stores[index]?.slug}: ${result.value.message}`);
            }
          });
          await reply({ success: true, message: 'All repos updated' });
          break;
        }
        case 'clone_all': {
          const stores = await this.appStoreRepository.getEnabledAppStores();
          const results = await Promise.allSettled(stores.map((store) => this.repoHelpers.cloneRepo(store.url, store.slug, store.type ?? 'git')));
          // Log failures but don't fail the entire operation
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              this.logger.error(`Failed to clone repo ${stores[index]?.slug}: ${result.reason}`);
            } else if (result.value.success === false) {
              this.logger.warn(`Skipped invalid repo ${stores[index]?.slug}: ${result.value.message}`);
            }
          });
          await reply({ success: true, message: 'All repos cloned' });
          break;
        }
        case 'clone': {
          const store = await this.appStoreRepository.getAppStoreBySlug(data.id);
          const { success, message } = await this.repoHelpers.cloneRepo(data.url, data.id, store?.type ?? 'git');
          await reply({ success, message });
          break;
        }
        case 'update': {
          const store = await this.appStoreRepository.getAppStoreBySlug(data.id);
          const { success, message } = await this.repoHelpers.pullRepo(data.url, data.id, store?.type ?? 'git');
          await reply({ success, message });
          break;
        }
      }
    });
  }

  onApplicationBootstrap() {
    this.logger.info('Scheduling app store updates every 1 hour');
    this.pullInterval = setInterval(
      () => {
        this.pullRepositories().catch((e) => this.logger.error('Failed to scheduled pull repositories', e));
      },
      1000 * 60 * 60,
    );
  }

  onApplicationShutdown() {
    if (this.pullInterval) {
      clearInterval(this.pullInterval);
      this.pullInterval = null;
    }
  }

  public async pullRepositories() {
    const repositories = await this.appStoreRepository.getEnabledAppStores();

    for (const repo of repositories) {
      this.logger.debug(`Pulling repo ${repo.url}`);
      await this.repoHelpers.pullRepo(repo.url, repo.slug, repo.type ?? 'git');
    }

    return { success: true };
  }

  public async registerCloudAppStore() {
    const { ciCloudAppStoreUrl } = this.config.getConfig();

    if (!ciCloudAppStoreUrl) {
      this.logger.debug('Skipping cloud app store registration, no URL configured');
      return;
    }

    const slug = 'ci-marketplace';
    const existing = await this.appStoreRepository.getAppStoreBySlug(slug);

    if (existing) {
      if (existing.url !== ciCloudAppStoreUrl || existing.type !== 'ci_cloud_api') {
        this.logger.info(`Updating cloud app store URL to ${ciCloudAppStoreUrl} and type to ci_cloud_api`);
        await this.appStoreRepository.updateAppStoreHashAndUrl(slug, {
          url: ciCloudAppStoreUrl,
          hash: this.repoHelpers.getRepoHash(ciCloudAppStoreUrl),
        });
        await this.appStoreRepository.updateAppStoreType(slug, 'ci_cloud_api');
      }
      return;
    }

    this.logger.info(`Registering cloud app store: ${ciCloudAppStoreUrl}`);
    await this.appStoreRepository.createAppStore({
      name: 'CI Marketplace',
      url: ciCloudAppStoreUrl,
      slug,
      enabled: true,
      type: 'ci_cloud_api',
    });
  }

  public async getEnabledAppStores() {
    return this.appStoreRepository.getEnabledAppStores();
  }

  public async getAllAppStores() {
    return this.appStoreRepository.getAllAppStores();
  }

  /**
   * Given an app store ID and the new data, update the app store in the database
   *
   * @param slug The ID of the app store to update
   * @param body The new data to update the app store with
   */
  public async updateAppStore(slug: string, body: UpdateAppStoreBodyDto) {
    return this.appStoreRepository.updateAppStore(slug, body);
  }

  /**
   * Given an app store ID, delete it from the database and the filesystem
   *
   * @param slug The ID of the app store to delete
   */
  public async deleteAppStore(slug: string) {
    const stores = await this.appStoreRepository.getAllAppStores();

    if (stores.length === 1) {
      throw new TranslatableError('APP_STORE_DELETE_ERROR_LAST_STORE', {}, HttpStatus.BAD_REQUEST);
    }

    const count = await this.appStoreRepository.getAppCountForStore(slug);

    if (count && count.count > 0) {
      throw new TranslatableError('APP_STORE_DELETE_ERROR_APPS_EXIST', {}, HttpStatus.BAD_REQUEST);
    }

    await this.appStoreRepository.removeAppStoreEntity(slug);
    await this.repoHelpers.deleteRepo(slug);

    return { success: true };
  }

  public async createAppStore(body: { url: string; name: string }) {
    if (this.config.get('demoMode')) {
      throw new TranslatableError('SERVER_ERROR_NOT_ALLOWED_IN_DEMO');
    }

    if (RESERVED_APP_STORE_SLUGS.includes(body.name.trim().toLowerCase())) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_NAME_RESERVED', { name: body.name }, HttpStatus.BAD_REQUEST);
    }

    const hash = this.repoHelpers.getRepoHash(body.url);
    const existing = await this.appStoreRepository.getAppStoreByHash(hash);
    if (existing) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_ALREADY_EXISTS', {}, HttpStatus.CONFLICT);
    }

    const slug = slugify(body.name, { lower: true, trim: true });

    const existingSlug = await this.appStoreRepository.getAppStoreBySlug(slug);
    if (existingSlug) {
      throw new TranslatableError('SERVER_ERROR_DUPLICATE_APP_STORE_NAME', {}, HttpStatus.CONFLICT);
    }

    const created = await this.appStoreRepository.createAppStore({ ...body, slug });
    const { success } = await this.repoHelpers.cloneRepo(body.url, created.slug);

    if (!success) {
      await this.appStoreRepository.removeAppStoreEntity(created.slug);
      throw new TranslatableError('APP_STORE_CLONE_ERROR', { url: body.url }, HttpStatus.BAD_REQUEST);
    }

    return created;
  }

  public async getAppCountForStore(slug: string) {
    return this.appStoreRepository.getAppCountForStore(slug);
  }

  public async getAppStoreBySlug(slug: string) {
    return this.appStoreRepository.getAppStoreBySlug(slug);
  }

  public async deleteAllRepos() {
    await this.repoHelpers.deleteAllRepos();
  }
}
