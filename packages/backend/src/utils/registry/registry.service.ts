import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import { HUB_STACK_REGISTRY_REPO } from '@/common/constants';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import * as semver from 'semver';

/** How long successful tag lists are reused (avoids hammering CI Cloud on every UI version check). */
const TAGS_CACHE_TTL_MS = 10 * 60 * 1000;
/** After a failed fetch, wait before retrying (reduces log + network noise when the registry rejects unauthenticated clients). */
const TAGS_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const HUB_RELEASE_FEED_URL = 'https://dl.ci.computer/latest.json';

type LatestHubReleaseFeed = {
  version?: string;
};

@Injectable()
export class RegistryService {
  private readonly tagsCache = new Map<string, { tags: string[]; expiresAt: number }>();
  private latestHubVersionCache: { version: string | null; expiresAt: number } | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configuration: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  public async getLatestVersion(repository: string) {
    const tags = await this.getTags(repository);
    return tags[0] || '0.0.0';
  }

  public async getTagsSince(repository: string, currentVersion: string) {
    if (!semver.valid(currentVersion)) {
      return [];
    }
    const tags = await this.getTags(repository);
    return tags.filter((tag) => semver.gt(tag, currentVersion));
  }

  /**
   * Resolve newer tags and fall back to the public release feed for the Hub stack.
   * This keeps update checks working when OCI tags are digest-only (latest/dev/sha256).
   */
  public async getTagsSinceWithHubFallback(repository: string, currentVersion: string): Promise<string[]> {
    if (!semver.valid(currentVersion)) {
      return [];
    }

    const tagsSince = await this.getTagsSince(repository, currentVersion);
    if (tagsSince.length > 0) {
      return tagsSince;
    }

    if (repository !== HUB_STACK_REGISTRY_REPO) {
      return [];
    }

    const latestFromFeed = await this.getLatestHubVersionFromFeed();
    if (latestFromFeed && semver.gt(latestFromFeed, currentVersion)) {
      return [latestFromFeed];
    }

    return [];
  }

  private async getLatestHubVersionFromFeed(): Promise<string | null> {
    const now = Date.now();
    if (this.latestHubVersionCache && this.latestHubVersionCache.expiresAt > now) {
      return this.latestHubVersionCache.version;
    }

    try {
      const { data } = await firstValueFrom(this.httpService.get(HUB_RELEASE_FEED_URL));
      const payload = data as LatestHubReleaseFeed;
      const cleaned = semver.clean(payload.version ?? '') ?? null;

      if (!cleaned) {
        this.latestHubVersionCache = { version: null, expiresAt: now + TAGS_FAILURE_COOLDOWN_MS };
        return null;
      }

      this.latestHubVersionCache = { version: cleaned, expiresAt: now + TAGS_CACHE_TTL_MS };
      return cleaned;
    } catch (error) {
      this.latestHubVersionCache = { version: null, expiresAt: now + TAGS_FAILURE_COOLDOWN_MS };
      this.logger.debug(`Hub release feed unavailable at ${HUB_RELEASE_FEED_URL}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async getTags(repository: string): Promise<string[]> {
    const registryUrl = this.configuration.get('ciCloudUrl');
    if (!registryUrl) {
      throw new Error('ciCloudUrl is not configured');
    }

    const base = registryUrl.trim().replace(/\/$/, '');
    const cacheKey = `${base}::${repository}`;
    const now = Date.now();
    const cached = this.tagsCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.tags;
    }

    try {
      const { data } = await firstValueFrom(this.httpService.get(`${base}/v2/${repository}/tags/list`));

      const tags = (data.tags || []) as string[];

      const validTags = tags.filter((tag) => semver.valid(tag));
      const sorted = validTags.sort((a, b) => semver.rcompare(a, b));
      this.tagsCache.set(cacheKey, { tags: sorted, expiresAt: now + TAGS_CACHE_TTL_MS });
      return sorted;
    } catch (error) {
      this.tagsCache.set(cacheKey, { tags: [], expiresAt: now + TAGS_FAILURE_COOLDOWN_MS });

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403 || status === 404) {
          this.logger.debug(
            `OCI tags list not available for ${repository} at CI Cloud (HTTP ${status}). Hub updates may not show latest image until registry access works.`,
          );
        } else {
          this.logger.warn(`Failed to get OCI tags for ${repository}: ${error.message}${status ? ` (HTTP ${status})` : ''}`);
        }
      } else {
        this.logger.warn(`Failed to get OCI tags for ${repository}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return [];
    }
  }
}
