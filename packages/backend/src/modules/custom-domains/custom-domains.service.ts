/**
 * Custom-domains service — Hub-side proxy for the Portal custom-domain API.
 *
 * The Hub adds local context (device ID, current app exposure target) and
 * forwards requests to Portal. All durable state (custom_domain rows, Entri
 * job IDs, Cloudflare custom-hostname IDs) lives in Portal; Hub only caches
 * the response briefly so the UI can render without a round-trip on every
 * render.
 *
 * @see planning/epic-472-custom-domains-entri.md — H1.1, H1.2
 */

import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { RegistrationService } from '../registration/registration.service';
import { SSEService } from '@/core/sse/sse.service';
import type { CustomDomainStatus, LaunchCustomDomainDto, LaunchCustomDomainResponse } from './custom-domains.dto';

/** How long (ms) the cached domain list is considered fresh. */
const CACHE_TTL_MS = 30_000;

@Injectable()
export class CustomDomainsService {
  /** In-memory cache refreshed on every Portal poll or SSE trigger. */
  private cachedDomains: CustomDomainStatus[] = [];
  private cacheUpdatedAt = 0;

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly registration: RegistrationService,
    private readonly sse: SSEService,
  ) {}

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private get portalBase(): string | null {
    return this.config.getConfig().ciCloudUrl?.trim() || null;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const apiKey = this.config.getConfig().ciHubApiKey;
    if (!apiKey) return {};
    return { Authorization: `Bearer ${apiKey}` };
  }

  private async portalFetch<T>(path: string, options: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T | null }> {
    const base = this.portalBase;
    if (!base) {
      return { ok: false, status: 0, data: null };
    }
    const url = `${base}/api/${path}`;
    const headers = await this.getAuthHeaders();
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(options.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(15_000),
      });
      const data = res.ok ? ((await res.json()) as T) : null;
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      this.logger.warn(`custom-domains: Portal request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: 0, data: null };
    }
  }

  // ─── H1.2: cache update (called by CloudflareClientService on syncState) ───

  /**
   * Update the in-memory domain cache from the Portal tunnel-state response.
   * Called by `CloudflareClientService.syncState()` when it receives a
   * `customDomains[]` array in the response body.
   *
   * Emits an SSE `custom_domains_updated` event when the list changes.
   */
  public updateFromSyncState(domains: CustomDomainStatus[]): void {
    const previousJson = JSON.stringify(this.cachedDomains);
    const newJson = JSON.stringify(domains);
    this.cachedDomains = domains;
    this.cacheUpdatedAt = Date.now();

    if (previousJson !== newJson) {
      this.logger.debug(`custom-domains: cache updated (${domains.length} domains)`);
      // Emit SSE so the frontend can refresh without polling
      this.sse.emit('system', { event: 'custom_domains_updated' });
    }
  }

  // ─── H1.1: proxy routes ─────────────────────────────────────────────────────

  /**
   * `POST /api/custom-domains/launch`
   *
   * Thin proxy to Portal `POST /api/custom-domains/init`.
   * Enriches the request with local context (device ID, application URL target)
   * before forwarding.
   */
  async launch(dto: LaunchCustomDomainDto): Promise<LaunchCustomDomainResponse | { error: string }> {
    const deviceId = await this.registration.getDeviceId().catch(() => null);

    const payload = {
      domain: dto.domain,
      applicationUrn: dto.applicationUrn ?? null,
      deviceId,
    };

    const result = await this.portalFetch<LaunchCustomDomainResponse>('custom-domains/init', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!result.ok || !result.data) {
      const msg = `Portal returned ${result.status} for custom-domains/init`;
      this.logger.warn(`custom-domains: ${msg}`);
      return { error: msg };
    }

    return result.data;
  }

  /**
   * `GET /api/custom-domains`
   *
   * Returns the cached domain list (refreshed from Portal on every syncState
   * cycle or when the cache is stale). Falls through to a direct Portal fetch
   * when the cache has expired.
   */
  async listDomains(): Promise<CustomDomainStatus[]> {
    const age = Date.now() - this.cacheUpdatedAt;
    if (age > CACHE_TTL_MS) {
      await this.refreshCache();
    }
    return this.cachedDomains;
  }

  private async refreshCache(): Promise<void> {
    const result = await this.portalFetch<CustomDomainStatus[]>('custom-domains');
    if (result.ok && result.data) {
      this.updateFromSyncState(result.data);
    }
  }

  /**
   * `DELETE /api/custom-domains/:id`
   *
   * Proxy to Portal `DELETE /api/custom-domains/:id`, then invalidate cache.
   */
  async deleteDomain(id: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.portalFetch<{ success: boolean }>(`custom-domains/${id}`, {
      method: 'DELETE',
    });

    if (!result.ok) {
      return { success: false, error: `Portal returned ${result.status}` };
    }

    // Evict from cache so next list() fetches fresh data
    this.cachedDomains = this.cachedDomains.filter((d) => d.id !== id);
    this.cacheUpdatedAt = Date.now();
    this.sse.emit('system', { event: 'custom_domains_updated' });

    return { success: true };
  }
}
