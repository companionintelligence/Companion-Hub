import { TranslatableError } from '@/common/error/translatable-error';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import type { PublicDnsFailure } from '@/modules/cloudflare/cloudflare-client.service';
import type { TunnelCustomDomain } from '@ci-hub/common/types';

export type PortalStoreListingsParams = {
  category?: string;
  tags?: string;
  sort?: 'newest' | 'trending';
  q?: string;
};

@Injectable()
export class PortalClientService {
  private readonly publicPortalUrl: string;
  private readonly outboundPortalUrl: string;
  private readonly apiClient: AxiosInstance;

  constructor(private readonly configuration: ConfigurationService) {
    const { ciCloudUrl } = this.configuration.getConfig();
    const publicUrl = (ciCloudUrl ?? '').trim().replace(/\/+$/, '');
    this.publicPortalUrl = publicUrl;
    this.outboundPortalUrl = publicUrl ? resolveOutboundPortalBaseUrl(publicUrl, readPortalInternalUrlOverride()) : '';
    this.apiClient = axios.create({
      baseURL: this.outboundPortalUrl ? `${this.outboundPortalUrl}/api` : undefined,
      timeout: 30_000,
      ...(publicUrl ? buildPortalAxiosConfig(publicUrl, readPortalInternalUrlOverride()) : {}),
    });
  }

  getPublicPortalUrl(): string {
    return this.publicPortalUrl;
  }

  getOutboundPortalUrl(): string {
    return this.outboundPortalUrl;
  }

  requirePortalUrl(): string {
    if (!this.publicPortalUrl) {
      throw new TranslatableError('PORTAL_URL_NOT_CONFIGURED', undefined, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.publicPortalUrl;
  }

  getDeviceAuthHeaders(): Record<string, string> {
    const token = this.configuration.get('ciHubApiKey');
    if (!token) {
      return {};
    }
    return {
      Authorization: `Bearer ${token}`,
      'x-device-key': token,
    };
  }

  async fetchJson<T = unknown>(path: string, init?: { authenticated?: boolean; params?: Record<string, string>; bypassCache?: boolean }): Promise<T> {
    this.requirePortalUrl();
    const headers: Record<string, string> = init?.authenticated ? this.getDeviceAuthHeaders() : {};
    if (init?.bypassCache) {
      headers['Cache-Control'] = 'no-cache';
      headers.Pragma = 'no-cache';
    }
    const params = init?.bypassCache ? { ...init.params, _ts: String(Date.now()) } : init?.params;
    const response = await this.apiClient.get<T>(path.replace(/^\//, ''), {
      headers,
      params,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: String(response.status), path }, HttpStatus.BAD_GATEWAY);
    }
    return response.data;
  }

  /**
   * Platform Google Maps key from Portal (`GET /api/config/maps`).
   * Returns null when Portal is unreachable, unauthenticated, or the
   * wrangler secret is unset — callers must treat that as best-effort.
   */
  async fetchMapsConfig(): Promise<{ configured: boolean; apiKey?: string } | null> {
    if (!this.publicPortalUrl || !this.configuration.get('ciHubApiKey')) {
      return null;
    }

    try {
      return await this.fetchJson<{ configured: boolean; apiKey?: string }>('/config/maps', {
        authenticated: true,
      });
    } catch {
      return null;
    }
  }

  async fetchStoreListings(params: PortalStoreListingsParams = {}): Promise<unknown> {
    const query: Record<string, string> = {};
    if (params.category) query.category = params.category;
    if (params.tags) query.tags = params.tags;
    if (params.sort) query.sort = params.sort;
    if (params.q) query.q = params.q;
    return this.fetchJson('/store', { params: query });
  }

  async fetchStoreAlternatives(): Promise<unknown> {
    return this.fetchJson('/store/alternatives');
  }

  async fetchStoreCatalog(init?: { bypassCache?: boolean }): Promise<unknown> {
    return this.fetchJson('/store', { bypassCache: init?.bypassCache });
  }

  async fetchStoreAppDetails(slug: string): Promise<{ screenshots?: string[]; demo_video?: string } | null> {
    if (!this.publicPortalUrl) {
      return null;
    }

    try {
      return await this.fetchJson<{ screenshots?: string[]; demo_video?: string }>(`/store/${encodeURIComponent(slug)}`);
    } catch {
      return null;
    }
  }

  async fetchAppInstall(slug: string): Promise<unknown> {
    return this.fetchJson(`/store/${encodeURIComponent(slug)}/install`, { authenticated: true });
  }

  /**
   * Hub-facing till check. Returns the HTTP status so callers can tell 402
   * (pay) from 404 (unknown / local app) from a network failure.
   *
   * `null` means Portal is not configured on this Hub — skip the check.
   */
  async checkAppEntitlement(appId: string): Promise<{
    status: number;
    entitled?: boolean;
    reason?: string;
    paymentUrl?: string;
    code?: string;
  } | null> {
    if (!this.outboundPortalUrl) {
      return null;
    }

    const response = await this.apiClient.get<{
      entitled?: boolean;
      reason?: string;
      paymentUrl?: string;
      code?: string;
    }>('entitlements/check', {
      headers: this.getDeviceAuthHeaders(),
      params: { appId },
      validateStatus: () => true,
      timeout: 10_000,
    });

    const data = response.data && typeof response.data === 'object' ? response.data : {};

    return {
      status: response.status,
      entitled: data.entitled,
      reason: data.reason,
      paymentUrl: data.paymentUrl,
      code: data.code,
    };
  }

  async fetchStoreMetadataText(appSlug: string, filename: string): Promise<string | null> {
    if (!this.publicPortalUrl) {
      return null;
    }

    try {
      const path = `store/${encodeURIComponent(appSlug)}/metadata/${encodeURIComponent(filename)}`;
      const response = await this.apiClient.get<string>(path, {
        responseType: 'text',
        validateStatus: () => true,
        timeout: 15_000,
      });

      if (response.status < 200 || response.status >= 300) {
        return null;
      }

      if (!this.isAcceptedDescriptionContentType(response.headers['content-type'])) {
        return null;
      }

      const text = typeof response.data === 'string' ? response.data : '';
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  private isAcceptedDescriptionContentType(contentTypeHeader: unknown): boolean {
    const contentType =
      (typeof contentTypeHeader === 'string' ? contentTypeHeader : Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : '')
        .split(';')[0]
        ?.trim()
        .toLowerCase() ?? '';

    if (!contentType) {
      return true;
    }

    if (contentType === 'text/markdown' || contentType === 'text/x-markdown' || contentType === 'text/plain') {
      return true;
    }

    if (contentType === 'text/html' || contentType.startsWith('image/')) {
      return false;
    }

    return false;
  }

  async postJson<T = unknown>(path: string, body: unknown, init?: { authenticated?: boolean }): Promise<T> {
    this.requirePortalUrl();
    const headers = {
      'Content-Type': 'application/json',
      ...(init?.authenticated ? this.getDeviceAuthHeaders() : {}),
    };
    const response = await this.apiClient.post<T>(path.replace(/^\//, ''), body, {
      headers,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: String(response.status), path }, HttpStatus.BAD_GATEWAY);
    }
    return response.data;
  }

  async postTunnelState(payload: { organizationId: string; tunnelId: string; apps: unknown[] }): Promise<{
    success?: boolean;
    failed?: string[];
    /** Per-app failure detail; absent on Companion Portal versions that predate it. */
    failures?: PublicDnsFailure[];
    synced?: number;
    /**
     * Custom hostnames Companion Portal actually wired into this device's tunnel ingress
     * on this sync. Absent on Companion Portal versions that predate custom domains —
     * which is NOT the same as an empty array, and the consumer must keep the
     * two apart (see `parseTunnelCustomDomains`).
     */
    customDomains?: TunnelCustomDomain[];
  }> {
    return this.postJson('tunnels/state', payload, { authenticated: true });
  }

  /**
   * A device-authenticated request whose STATUS AND BODY are part of the answer.
   *
   * `fetchJson` / `postJson` collapse every non-2xx into one `PORTAL_REQUEST_FAILED`
   * carrying a status string and nothing else, which is right for the calls whose
   * only question is "did it work". The custom-domain routes are not those: a 404
   * means this Companion Portal predates the feature (a supported deployment, not a
   * fault), a 422 means the domain is still verifying and the caller should try
   * again later, and a 404 on the bind distinguishes "the app has not registered
   * yet" from "that domain is gone" by its `code`. Throwing all of that away and
   * then guessing is how a caller ends up retrying something that can never
   * succeed, or giving up on something that would have worked next minute.
   */
  private async requestWithStatus<T>(method: 'get' | 'post', path: string, body?: unknown): Promise<{ status: number; data: T }> {
    this.requirePortalUrl();
    const url = path.replace(/^\//, '');
    const headers = {
      ...this.getDeviceAuthHeaders(),
      ...(method === 'post' ? { 'Content-Type': 'application/json' } : {}),
    };
    const response =
      method === 'get'
        ? await this.apiClient.get<T>(url, { headers, validateStatus: () => true })
        : await this.apiClient.post<T>(url, body, { headers, validateStatus: () => true });

    return { status: response.status, data: response.data };
  }

  /**
   * The organization's connected custom domains, with the bind state of each.
   *
   * This is not the same thing as `customDomains` on the tunnel-state response. That
   * one is what Companion Portal has wired — the hostnames the tunnel answers for, and
   * the only source an app's public identity may be built from. This is what the
   * organization OWNS: the catalogue an install dialog offers, including domains
   * pointing at nothing and domains not yet proved.
   *
   * 404 on a Companion Portal that predates the route, which the caller reports as
   * "nothing offerable" rather than as an error.
   */
  async fetchDeviceCustomDomains(organizationId?: string): Promise<{ status: number; data: { domains?: unknown } }> {
    /*
     * The organization is VERIFIED by Companion Portal against a `device_registration`
     * row, never believed — so sending it is not a trust boundary, it is a
     * disambiguation. A device CAN be registered to more than one organization
     * (a half-completed cross-org move leaves exactly that), and Companion Portal refuses
     * to guess rather than answering with an arbitrary tenant's domains.
     */
    const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : '';

    return this.requestWithStatus('get', `/custom-domains/device${query}`);
  }

  /**
   * Ask Companion Portal to point one of those domains at an app on THIS device.
   *
   * The body names the domain's id and the app's SUBDOMAIN — the same string the
   * tunnel-state payload carries — never a hostname: the target is composed on
   * the Companion Portal side from rows it owns, which is the invariant that stops a
   * device pointing a domain into another organization's tunnel. The Hub could
   * not honestly supply one anyway, since it cannot know whether a name really
   * resolves here.
   */
  async postDeviceCustomDomainBind(payload: { domainId: string; appSlug: string; organizationId?: string }): Promise<{
    status: number;
    data: { id?: string; domain?: string; targetHostname?: string; code?: string; error?: string };
  }> {
    return this.requestWithStatus('post', '/custom-domains/device/bind', payload);
  }

  async postDeviceCheckIn(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson('/devices/check-in', payload, { authenticated: true });
  }

  async postDeviceApplicationsRegistry(payload: {
    organizationId: string;
    apps: Array<{
      name: string;
      slug: string;
      port: number;
      publicDomain?: string;
      remove?: boolean;
    }>;
  }): Promise<{ success?: boolean }> {
    return this.postJson('/devices/applications/registry', payload, { authenticated: true });
  }

  async postDeviceDeregister(deviceId: string): Promise<unknown> {
    return this.postJson('/devices/deregister', { device_id: deviceId }, { authenticated: true });
  }
}
