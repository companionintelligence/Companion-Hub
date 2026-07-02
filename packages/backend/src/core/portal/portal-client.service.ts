import { TranslatableError } from '@/common/error/translatable-error';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, resolveOutboundPortalBaseUrl } from '@/common/helpers/portal-url';
import { ConfigurationService } from '@/core/config/configuration.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';

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

  async fetchJson<T = unknown>(path: string, init?: { authenticated?: boolean; params?: Record<string, string> }): Promise<T> {
    this.requirePortalUrl();
    const headers = init?.authenticated ? this.getDeviceAuthHeaders() : {};
    const response = await this.apiClient.get<T>(path.replace(/^\//, ''), {
      headers,
      params: init?.params,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: String(response.status), path }, HttpStatus.BAD_GATEWAY);
    }
    return response.data;
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

  async fetchStoreCatalog(): Promise<unknown> {
    return this.fetchJson('/store');
  }

  async fetchAppInstall(slug: string): Promise<unknown> {
    return this.fetchJson(`/store/${encodeURIComponent(slug)}/install`, { authenticated: true });
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

  async postTunnelState(payload: {
    organizationId: string;
    tunnelId: string;
    apps: unknown[];
  }): Promise<{ success?: boolean; failed?: string[]; synced?: number }> {
    return this.postJson('tunnels/state', payload, { authenticated: true });
  }

  async postDeviceCheckIn(payload: Record<string, unknown>): Promise<unknown> {
    return this.postJson('/devices/check-in', payload, { authenticated: true });
  }

  async postDeviceDeregister(deviceId: string): Promise<unknown> {
    return this.postJson('/devices/deregister', { device_id: deviceId }, { authenticated: true });
  }
}
