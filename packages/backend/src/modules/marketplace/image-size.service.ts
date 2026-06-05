import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { MarketplaceService } from './marketplace.service';

interface CachedSize {
  totalBytes: number;
  fetchedAt: number;
}

const DEFAULT_REGISTRY = 'registry.hub.docker.com';

/**
 * Parse a Docker/OCI image reference into registry host, repository path, and
 * manifest tag or digest for registry v2 API URLs.
 *
 * Handles registry hosts with ports (my.registry:5000/ns/repo:tag) and digest
 * refs (repo@sha256:...) without splitting on the wrong ':' character.
 */
export function parseDockerImageRef(image: string): { registry: string; repository: string; tag: string } {
  let name = image.trim();

  if (!name) {
    return { registry: DEFAULT_REGISTRY, repository: 'library/unknown', tag: 'latest' };
  }

  let tag = 'latest';
  const atIndex = name.indexOf('@');

  if (atIndex === -1) {
    // Tag delimiter is the last ':' after the last '/' so host ports are preserved.
    const lastSlash = name.lastIndexOf('/');
    const lastColon = name.lastIndexOf(':');

    if (lastColon !== -1 && lastColon > lastSlash) {
      tag = name.slice(lastColon + 1);
      name = name.slice(0, lastColon);
    }
  } else {
    tag = name.slice(atIndex + 1);
    name = name.slice(0, atIndex);
  }

  if (!name) {
    return { registry: DEFAULT_REGISTRY, repository: image, tag };
  }

  const firstSlash = name.indexOf('/');

  if (firstSlash === -1) {
    return { registry: DEFAULT_REGISTRY, repository: `library/${name}`, tag };
  }

  const head = name.slice(0, firstSlash);
  const tail = name.slice(firstSlash + 1);
  const headIsRegistry = head.includes('.') || head.includes(':') || head === 'localhost';

  if (headIsRegistry) {
    return { registry: head, repository: tail, tag };
  }

  return { registry: DEFAULT_REGISTRY, repository: name, tag };
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
      if (!parsed?.services) {
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
   * Best-effort pre-install check that every image in an app actually
   * publishes a manifest for the given host architecture.
   *
   * Returns:
   *   - { ok: true }                          all inspectable images support `arch`
   *   - { ok: false, image, available }       an image definitively lacks `arch`
   *   - null                                  could not inspect (network/registry/auth)
   *                                           — caller should NOT hard-block on this
   */
  async verifyAppArchitecture(appUrn: AppUrn, arch: string): Promise<{ ok: true } | { ok: false; image: string; available: string[] } | null> {
    let images: string[];

    try {
      const { content } = await this.marketplaceService.getDockerComposeJson(appUrn);
      const parsed = content as { services?: Array<{ image?: string }> | Record<string, { image?: string }> };
      const services = Array.isArray(parsed?.services) ? parsed.services : Object.values(parsed?.services ?? {});
      images = [...new Set(services.map((s) => s?.image).filter((img): img is string => Boolean(img)))];
    } catch (error) {
      this.logger.warn(`Could not read compose for ${appUrn} to verify architecture: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    if (images.length === 0) {
      return null;
    }

    let inspectedAny = false;

    for (const image of images) {
      const archs = await this.getImageArchitectures(image);

      if (archs === null) {
        // Couldn't inspect this image — skip it rather than false-blocking.
        continue;
      }

      inspectedAny = true;

      if (!archs.includes(arch)) {
        return { ok: false, image, available: archs };
      }
    }

    return inspectedAny ? { ok: true } : null;
  }

  /**
   * Resolve the CPU architectures an image's manifest publishes. For a
   * multi-arch manifest list / OCI index this is every platform entry; for a
   * single-arch image we resolve the architecture from its config blob.
   * Returns null when the manifest can't be inspected.
   */
  async getImageArchitectures(image: string): Promise<string[] | null> {
    const { registry, repository, tag } = this.parseImageRef(image);

    try {
      const headers: Record<string, string> = {
        Accept: [
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
        ].join(', '),
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
        manifests?: Array<{ platform?: { architecture?: string; os?: string } }>;
        architecture?: string;
        config?: { digest?: string };
      };

      // Multi-arch manifest list / OCI index: read platform architectures.
      if (Array.isArray(manifest.manifests)) {
        const archs = manifest.manifests.map((m) => m.platform?.architecture).filter((a): a is string => Boolean(a) && a !== 'unknown');

        return [...new Set(archs)];
      }

      // Schema v1 fallback: architecture is on the manifest itself.
      if (manifest.architecture) {
        return [manifest.architecture];
      }

      // Single image manifest (v2/OCI): architecture lives in the config blob.
      if (manifest.config?.digest) {
        const configUrl = `${registryUrl}/v2/${repository}/blobs/${manifest.config.digest}`;
        const configResp = await fetch(configUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(10000),
        });

        if (configResp.ok) {
          const cfg = (await configResp.json()) as { architecture?: string };
          if (cfg.architecture) {
            return [cfg.architecture];
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.warn(`Error inspecting architectures for ${image}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private parseImageRef(image: string): { registry: string; repository: string; tag: string } {
    return parseDockerImageRef(image);
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
