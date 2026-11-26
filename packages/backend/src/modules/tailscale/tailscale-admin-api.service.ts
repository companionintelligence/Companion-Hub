import { Injectable, Logger } from '@nestjs/common';
import { type TailscaleOAuthClient, tailscaleServicesStore } from './tailscale-services.store';

export interface TailscaleDevice {
  id: string;
  nodeId: string;
  hostname: string;
  /** Full MagicDNS name, e.g. `hub-demo.tailxyz.ts.net`. */
  name: string;
  addresses: string[];
  os: string;
  clientVersion: string;
  lastSeen: string | null;
  tags: string[];
}

const OAUTH_TOKEN_URL = 'https://api.tailscale.com/api/v2/oauth/token';
const API_BASE_URL = 'https://api.tailscale.com/api/v2';
const REQUEST_TIMEOUT_MS = 10_000;
/** Re-request the token this many seconds before it actually expires, so a call made right at the boundary never races a stale token. */
const TOKEN_EXPIRY_SAFETY_MARGIN_S = 60;

/** The scopes Tailscale Services need: define and approve Services, read devices, mint the node's tagged key. */
export const TAILSCALE_SERVICES_SCOPES = ['services', 'devices:core', 'auth_keys'] as const;

/** One Tailscale Service as the API answers it (`VIPServiceInfo`). */
export interface TailscaleServiceInfo {
  name: string;
  comment?: string;
  ports?: string[];
  tags?: string[];
  addrs?: string[];
}

/** A host of a Service (`ServiceHostInfo`). */
export interface TailscaleServiceHost {
  stableNodeID: string;
  approvalLevel: 'not-approved' | 'approved:auto' | 'approved:manual' | string;
  configured?: string;
}

/** A Tailscale API answer that was not a success, with its status so callers can tell a 404 from a refusal. */
export class TailscaleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TailscaleApiError';
  }
}

/**
 * Thin client for the Tailscale Admin (control-plane) REST API — used only for
 * org-wide device discovery ({@link listDevices}) when pooling multiple Hub
 * nodes together (`HubPoolPeerService`). Everything else CI-Hub does with
 * Tailscale (status, auth, Serve) goes through the CLI-driven {@link
 * TailscaleService} instead; this is a separate, optional credential surface.
 *
 * Requires an OAuth client with the `devices:core:read` scope, configured via
 * `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`. Both are
 * optional. {@link isConfigured} reports only whether that OAuth client is set; it is NOT a test
 * of whether peer discovery is available, and no caller uses it as one. Hub Pool's other two
 * directories — the local Tailscale daemon's peer map and the CI Portal device list — need no
 * credential, so a Hub reading `false` here can still be naming candidates.
 */
@Injectable()
export class TailscaleAdminApiService {
  private readonly logger = new Logger(TailscaleAdminApiService.name);
  /** One token per scope string and client, so the Pool's read-only token and the Services token never mix. */
  private readonly tokenCache = new Map<string, { value: string; expires: number }>();

  /** Whether an OAuth client is known: one saved by the Services setup, or the env pair. */
  isConfigured(): boolean {
    return tailscaleServicesStore.readOAuthClient() !== null;
  }

  /**
   * Exchanges the client for a token limited to `scope`. `client` defaults to the saved one; the
   * Services setup passes the one the operator just typed, to test it before saving it.
   */
  async getAccessToken(scope = 'devices:core:read', client: TailscaleOAuthClient | null = tailscaleServicesStore.readOAuthClient()): Promise<string> {
    const now = Date.now();
    const cacheKey = `${client?.clientId ?? ''} ${scope}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && now < cached.expires) {
      return cached.value;
    }

    const clientId = client?.clientId;
    const clientSecret = client?.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('Tailscale Admin API is not configured (set TAILSCALE_OAUTH_CLIENT_ID and TAILSCALE_OAUTH_CLIENT_SECRET)');
    }

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn(`OAuth token exchange failed (${response.status}) — check the OAuth client's ID, secret and its ${scope} scope`);
      throw new TailscaleApiError(`Tailscale OAuth token exchange failed: ${response.status} ${body}`, response.status);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    const entry = {
      value: data.access_token,
      expires: now + Math.max(0, data.expires_in - TOKEN_EXPIRY_SAFETY_MARGIN_S) * 1000,
    };
    this.tokenCache.set(cacheKey, entry);
    return entry.value;
  }

  /** Drops cached tokens, after the operator replaced or removed the client. */
  forgetTokens(): void {
    this.tokenCache.clear();
  }

  /** The Service, or null when the tailnet has none by that name. `tailnet` `-` is the client's own. */
  async getService(name: string, tailnet = '-'): Promise<TailscaleServiceInfo | null> {
    const response = await this.servicesRequest('GET', `/tailnet/${encodeURIComponent(tailnet)}/services/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    await this.throwUnlessOk(response, `Reading Tailscale Service ${name}`);
    return (await response.json()) as TailscaleServiceInfo;
  }

  /** Creates or updates a Service. */
  async putService(service: TailscaleServiceInfo, tailnet = '-'): Promise<TailscaleServiceInfo> {
    const response = await this.servicesRequest(
      'PUT',
      `/tailnet/${encodeURIComponent(tailnet)}/services/${encodeURIComponent(service.name)}`,
      service,
    );
    await this.throwUnlessOk(response, `Defining Tailscale Service ${service.name}`);
    return (await response.json()) as TailscaleServiceInfo;
  }

  /** Deletes a Service. A Service already gone counts as deleted. */
  async deleteService(name: string, tailnet = '-'): Promise<void> {
    const response = await this.servicesRequest('DELETE', `/tailnet/${encodeURIComponent(tailnet)}/services/${encodeURIComponent(name)}`);
    if (response.status === 404) return;
    await this.throwUnlessOk(response, `Deleting Tailscale Service ${name}`);
  }

  /** The devices advertising a Service, and whether each is approved to host it. */
  async listServiceHosts(name: string, tailnet = '-'): Promise<TailscaleServiceHost[]> {
    const response = await this.servicesRequest('GET', `/tailnet/${encodeURIComponent(tailnet)}/services/${encodeURIComponent(name)}/devices`);
    await this.throwUnlessOk(response, `Listing the hosts of Tailscale Service ${name}`);
    const data = (await response.json()) as { hosts?: TailscaleServiceHost[] };
    return data.hosts ?? [];
  }

  /** Approves `deviceId` (a stable node ID) to host the Service. */
  async approveServiceHost(name: string, deviceId: string, tailnet = '-'): Promise<void> {
    const response = await this.servicesRequest(
      'POST',
      `/tailnet/${encodeURIComponent(tailnet)}/services/${encodeURIComponent(name)}/device/${encodeURIComponent(deviceId)}/approved`,
      { approved: true },
    );
    await this.throwUnlessOk(response, `Approving this Hub to host Tailscale Service ${name}`);
  }

  private async servicesRequest(method: string, pathname: string, body?: unknown): Promise<Response> {
    const token = await this.getAccessToken(TAILSCALE_SERVICES_SCOPES.join(' '));
    return fetch(`${API_BASE_URL}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async throwUnlessOk(response: Response, what: string): Promise<void> {
    if (response.ok) return;
    const text = await response.text().catch(() => '');
    throw new TailscaleApiError(`${what} failed: ${response.status} ${text.slice(0, 300)}`, response.status);
  }

  /**
   * List every device on the given tailnet (pass the tailnet name from
   * `TailscaleService.getStatus().tailnet`). Includes devices that are not
   * CI-Hub nodes — callers must filter (see `HubPoolPeerService.listDiscoverableDevices`,
   * which cross-probes each device's `/inference/pool/identify`).
   */
  async listDevices(tailnet: string): Promise<TailscaleDevice[]> {
    const token = await this.getAccessToken();
    const response = await fetch(`${API_BASE_URL}/tailnet/${encodeURIComponent(tailnet)}/devices?fields=all`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Tailscale device list failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { devices?: Array<Record<string, unknown>> };
    return (data.devices ?? []).map((raw) => this.parseDevice(raw));
  }

  private parseDevice(raw: Record<string, unknown>): TailscaleDevice {
    return {
      id: String(raw.id ?? raw.nodeId ?? ''),
      nodeId: String(raw.nodeId ?? raw.id ?? ''),
      hostname: String(raw.hostname ?? ''),
      name: String(raw.name ?? raw.hostname ?? ''),
      addresses: Array.isArray(raw.addresses) ? (raw.addresses as string[]) : [],
      os: String(raw.os ?? ''),
      clientVersion: String(raw.clientVersion ?? ''),
      lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : null,
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]).map((tag) => String(tag)) : [],
    };
  }
}
