import { Injectable, Logger } from '@nestjs/common';

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
  private tokenCache: { value: string; expires: number } | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.TAILSCALE_OAUTH_CLIENT_ID?.trim() && process.env.TAILSCALE_OAUTH_CLIENT_SECRET?.trim());
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expires) {
      return this.tokenCache.value;
    }

    const clientId = process.env.TAILSCALE_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.TAILSCALE_OAUTH_CLIENT_SECRET?.trim();
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
        scope: 'devices:core:read',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.warn(
        `OAuth token exchange failed (${response.status}) — check TAILSCALE_OAUTH_CLIENT_ID/SECRET and the client's devices:core:read scope`,
      );
      throw new Error(`Tailscale OAuth token exchange failed: ${response.status} ${body}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      value: data.access_token,
      expires: now + Math.max(0, data.expires_in - TOKEN_EXPIRY_SAFETY_MARGIN_S) * 1000,
    };
    return this.tokenCache.value;
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
