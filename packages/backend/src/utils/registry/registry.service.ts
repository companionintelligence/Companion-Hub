import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import * as semver from 'semver';

@Injectable()
export class RegistryService {
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

    try {
      const { data } = await firstValueFrom(this.httpService.get(`${registryUrl}/v2/${repository}/tags/list`));

      const tags = (data.tags || []) as string[];

      const validTags = tags.filter((tag) => semver.valid(tag));
      return validTags.sort((a, b) => semver.rcompare(a, b));
    } catch (error) {
      this.logger.error(`Failed to get tags for ${repository}`, error);
      return [];
    }
  }
}
