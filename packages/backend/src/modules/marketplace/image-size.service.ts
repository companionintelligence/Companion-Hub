import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { MarketplaceService } from './marketplace.service';

interface CachedSize {
  totalBytes: number;
  fetchedAt: number;
}

@Injectable()
export class ImageSizeService {
  private cache = new Map<string, CachedSize>();
  private readonly CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

  constructor(
    private readonly logger: LoggerService,
    private readonly marketplaceService: MarketplaceService,
  ) {}

  /**
   * Get the total compressed image size for all services in an app
   */
  async getAppImageSize(appUrn: AppUrn): Promise<{ totalBytes: number | null; formatted: string | null }> {
    const cached = this.cache.get(appUrn);
    if (cached && Date.now() - cached.fetchedAt < this.CACHE_TTL_MS) {
      return { totalBytes: cached.totalBytes, formatted: this.formatBytes(cached.totalBytes) };
    }

    try {
      const { content } = await this.marketplaceService.getDockerComposeJson(appUrn);
      const parsed = content as { services?: Record<string, { image?: string }> };
      if (!parsed || !parsed.services) {
        return { totalBytes: null, formatted: null };
      }

      const services = Object.values(parsed.services);
      const images = services.map((s) => s.image).filter((img): img is string => Boolean(img));

      if (images.length === 0) {
        return { totalBytes: null, formatted: null };
      }

      // Deduplicate images (same image might be used by multiple services)
      const uniqueImages = [...new Set(images)];

      let totalBytes = 0;
      const results = await Promise.allSettled(uniqueImages.map((img) => this.getImageSize(img)));

      let hasAnySize = false;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value !== null) {
          totalBytes += result.value;
          hasAnySize = true;
        }
      }

      if (!hasAnySize) {
        return { totalBytes: null, formatted: null };
      }

      this.cache.set(appUrn, { totalBytes, fetchedAt: Date.now() });

      return { totalBytes, formatted: this.formatBytes(totalBytes) };
    } catch (error) {
      this.logger.error(`Failed to get image size for ${appUrn}:`, error);
      return { totalBytes: null, formatted: null };
    }
  }

  /**
   * Parse a Docker image reference into registry, repository, and tag
   */
  private parseImageRef(image: string): { registry: string; repository: string; tag: string } {
    let registry = 'registry.hub.docker.com';
    let repository: string;
    let tag = 'latest';

    // Split off tag
    const [imagePath, imageTag] = image.split(':');
    if (imageTag) tag = imageTag;

    if (!imagePath) {
      return { registry, repository: image, tag };
    }

    const parts = imagePath.split('/');

    // Detect if first part is a registry (contains . or :)
    const firstPart = parts[0] ?? '';
    if (parts.length >= 3 || (parts.length >= 2 && (firstPart.includes('.') || firstPart.includes(':')))) {
      if (firstPart.includes('.') || firstPart.includes(':')) {
        registry = firstPart;
        repository = parts.slice(1).join('/');
      } else {
        // Docker Hub with org/repo
        repository = imagePath;
      }
    } else if (parts.length === 2) {
      // org/repo on Docker Hub
      repository = imagePath;
    } else {
      // library image
      repository = `library/${imagePath}`;
    }

    repository ??= imagePath;

    return { registry, repository, tag };
  }

  /**
   * Query the Docker registry v2 API for the compressed size of an image
   */
  private async getImageSize(image: string): Promise<number | null> {
    const { registry, repository, tag } = this.parseImageRef(image);

    try {
      // Get auth token if needed
      const headers: Record<string, string> = {
        Accept: 'application/vnd.docker.distribution.manifest.v2+json',
      };

      const token = await this.getAuthToken(registry, repository);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const registryUrl = registry === 'registry.hub.docker.com' ? 'https://registry-1.docker.io' : `https://${registry}`;

      const manifestUrl = `${registryUrl}/v2/${repository}/manifests/${tag}`;
      const response = await fetch(manifestUrl, { headers, signal: AbortSignal.timeout(10000) });

      if (!response.ok) {
        this.logger.warn(`Failed to fetch manifest for ${image}: ${response.status}`);
        return null;
      }

      const manifest = (await response.json()) as {
        schemaVersion?: number;
        config?: { size?: number };
        layers?: Array<{ size?: number }>;
        manifests?: Array<{ digest?: string; platform?: { architecture?: string } }>;
      };

      // Handle manifest list (multi-arch) - pick arm64 first, then amd64
      if (manifest.manifests) {
        const arm64 = manifest.manifests.find((m) => m.platform?.architecture === 'arm64');
        const amd64 = manifest.manifests.find((m) => m.platform?.architecture === 'amd64');
        const target = arm64 || amd64 || manifest.manifests[0];
        if (target?.digest) {
          const subManifestUrl = `${registryUrl}/v2/${repository}/manifests/${target.digest}`;
          const subResponse = await fetch(subManifestUrl, { headers, signal: AbortSignal.timeout(10000) });
          if (!subResponse.ok) return null;
          const subManifest = (await subResponse.json()) as { config?: { size?: number }; layers?: Array<{ size?: number }> };
          return this.sumManifestSize(subManifest);
        }
        return null;
      }

      return this.sumManifestSize(manifest);
    } catch (error) {
      this.logger.warn(`Error fetching image size for ${image}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private sumManifestSize(manifest: { config?: { size?: number }; layers?: Array<{ size?: number }> }): number {
    let total = 0;
    if (manifest.config?.size) total += manifest.config.size;
    if (manifest.layers) {
      for (const layer of manifest.layers) {
        if (layer.size) total += layer.size;
      }
    }
    return total;
  }

  /**
   * Get an auth token for the registry
   */
  private async getAuthToken(registry: string, repository: string): Promise<string | null> {
    try {
      if (registry === 'registry.hub.docker.com') {
        const response = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as { token?: string };
        return data.token ?? null;
      }

      if (registry === 'ghcr.io') {
        const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as { token?: string };
        return data.token ?? null;
      }

      // For other registries (GitLab, etc.), try anonymous access
      return null;
    } catch {
      return null;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
}
