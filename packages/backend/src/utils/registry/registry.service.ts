import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import * as semver from 'semver';

/** How long successful tag lists are reused (avoids hammering CI Cloud on every UI version check). */
const TAGS_CACHE_TTL_MS = 10 * 60 * 1000;
/** After a failed fetch, wait before retrying (reduces log + network noise when the registry rejects unauthenticated clients). */
const TAGS_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

@Injectable()
export class RegistryService {
  private readonly tagsCache = new Map<string, { tags: string[]; expiresAt: number }>();

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
