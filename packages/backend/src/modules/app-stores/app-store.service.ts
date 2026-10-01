import { TranslatableError } from '@/common/error/translatable-error';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HttpStatus, Injectable, Inject, forwardRef, OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import slugify from 'slugify';
import type { UpdateAppStoreBodyDto } from '../marketplace/dto/marketplace.dto';
import { MarketplaceCacheBus } from '../marketplace/marketplace-cache.bus';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { CI_MARKETPLACE_STORE_SLUG } from '@/core/portal/portal.constants';
import { AppStoreRepository } from './app-store.repository';
import { ReposHelpers } from './repos.helpers';

// Internal store slugs that must always be PRESENT — marketplace.service
// fabricates a local placeholder for any of these it doesn't already have, so
// this list must stay limited to stores that legitimately should exist as a
// local entry (`_user`, the built-in per-user namespace).
export const RESERVED_APP_STORE_SLUGS = ['_user'];

// Slugs a USER-ADDED store may never claim: the internal ones PLUS the official
// `ci-marketplace` slug. Memory-provider trust (isMemoryProviderApp) is pinned to
// the `ci-memory:ci-marketplace` urn, so a user store slugifying to
// `ci-marketplace` could id-squat the provider and be handed the forward-auth
// secret. Kept SEPARATE from RESERVED_APP_STORE_SLUGS so the official
// ci_cloud_api store is never fabricated as a placeholder git store.
const RESERVED_USER_STORE_SLUGS = [...RESERVED_APP_STORE_SLUGS, CI_MARKETPLACE_STORE_SLUG];

/**
 * What a NEW store's slug may contain. The slug is a folder name under `repos/` and half of
 * every app URN, so it is held to a single plain segment: no dots (`..` is a slug that
 * `slugify` happily returns), no separators, nothing a shell or a path would read specially.
 */
const APP_STORE_SLUG_PATTERN = /^[a-z0-9_-]+$/;

@Injectable()
export class AppStoreService implements OnApplicationBootstrap, OnApplicationShutdown {
  private pullInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly repoQueue: RepoEventsQueue,
    @Inject(forwardRef(() => ReposHelpers)) private readonly repoHelpers: ReposHelpers,
    private readonly config: ConfigurationService,
    private readonly appStoreRepository: AppStoreRepository,
    private readonly portalClient: PortalClientService,
    private readonly marketplaceCacheBus: MarketplaceCacheBus,
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
          this.marketplaceCacheBus.invalidate();
          await reply({ success: true, message: 'All repos updated' });
          break;
        }
        case 'clone_all': {
          const stores = await this.appStoreRepository.getEnabledAppStores();
          const gitStores = stores.filter((store) => store.type !== 'ci_cloud_api');
          const results = await Promise.allSettled(gitStores.map((store) => this.repoHelpers.cloneRepo(store.url, store.slug, store.type ?? 'git')));
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
    this.logger.info('Scheduling app store catalog sync every 1 hour (CI Marketplace + legacy git stores)');
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

  /** Sync enabled app stores — CI Marketplace (`ci_cloud_api`) and legacy git stores. */
  public async pullRepositories() {
    const repositories = await this.appStoreRepository.getEnabledAppStores();

    for (const repo of repositories) {
      this.logger.debug(`Syncing app store ${repo.slug} (${repo.type ?? 'git'})`);
      await this.repoHelpers.pullRepo(repo.url, repo.slug, repo.type ?? 'git');
    }

    this.marketplaceCacheBus.invalidate();

    return { success: true };
  }

  public async registerCloudAppStore() {
    const { ciCloudUrl } = this.config.getConfig();

    if (!ciCloudUrl) {
      this.logger.debug('Skipping cloud app store registration, no URL configured');
      return;
    }

    const ciCloudAppStoreUrl = `${ciCloudUrl}/api`;
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

  /** Proxies Portal `GET /api/store/alternatives` (used by onboarding / app store UI). */
  public async fetchCiCloudStoreAlternatives(): Promise<unknown> {
    return this.portalClient.fetchStoreAlternatives();
  }

  /** Proxies Portal `GET /api/store` (featured/trending/newest listings for the app store UI). */
  public async fetchCiCloudStoreListings(params: { category?: string; tags?: string; sort?: 'newest' | 'trending'; q?: string }): Promise<unknown> {
    return this.portalClient.fetchStoreListings(params);
  }

  /** One round-trip for the featured store view (four listing queries in parallel). */
  public async fetchFeaturedBundle(): Promise<{
    firstParty: unknown;
    featured: unknown;
    trending: unknown;
    newest: unknown;
  }> {
    const [firstParty, featured, trending, newest] = await Promise.all([
      this.fetchCiCloudStoreListings({ tags: 'companion-intelligence' }),
      this.fetchCiCloudStoreListings({ tags: 'featured' }),
      this.fetchCiCloudStoreListings({ sort: 'trending' }),
      this.fetchCiCloudStoreListings({ sort: 'newest' }),
    ]);
    return { firstParty, featured, trending, newest };
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

    // ⚠ THE SLUG IS A URL PARAMETER, AND IT BECOMES A PATH. `DELETE /api/marketplace/..` (or its
    // %2e%2e spelling) reached `repos/..`, which is the data directory itself, and removed it.
    // Only a store that exists can be deleted, so nothing the caller types is ever joined to a path.
    if (!stores.some((store) => store.slug === slug)) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_NOT_FOUND', {}, HttpStatus.NOT_FOUND);
    }

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

    // Characters outside word/space/hyphen are dropped rather than kept: the default
    // allow-list keeps `.`, so a name of `..` slugified to `..`.
    const slug = slugify(body.name, { lower: true, trim: true, remove: /[^\w\s-]+/g });

    if (!APP_STORE_SLUG_PATTERN.test(slug)) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_INVALID_NAME', { name: body.name }, HttpStatus.BAD_REQUEST);
    }

    // Check the DERIVED slug (not just the raw name) against the reserved list:
    // slugify('CI Marketplace') === 'ci-marketplace', which a user-added store must
    // never be able to claim (see RESERVED_APP_STORE_SLUGS).
    if (RESERVED_USER_STORE_SLUGS.includes(slug) || RESERVED_USER_STORE_SLUGS.includes(body.name.trim().toLowerCase())) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_NAME_RESERVED', { name: body.name }, HttpStatus.BAD_REQUEST);
    }

    const hash = this.repoHelpers.getRepoHash(body.url);
    const existing = await this.appStoreRepository.getAppStoreByHash(hash);
    if (existing) {
      throw new TranslatableError('SERVER_ERROR_APP_STORE_ALREADY_EXISTS', {}, HttpStatus.CONFLICT);
    }

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
