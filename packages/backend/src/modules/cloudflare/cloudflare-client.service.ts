import { APP_DIR, DATA_DIR, DEFAULT_CI_CLOUD_URL, TUNNEL_DIR } from '@/common/constants';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';
import type { AvailableDomain, AvailableDomainsResponse } from '@ci-hub/common/types';
import axios, { AxiosInstance, type AxiosResponse } from 'axios';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { writeHealableTextFile } from '@/common/helpers/bind-mount-helpers';

export interface AppInfo {
  name: string;
  subdomain: string; // Full subdomain (e.g., n8n-bdc) - used for Cloudflare public hostname
  publicDomain?: string; // Selected public root domain for this app hostname
  localPort: number;
  protocol?: 'http' | 'https';
  hostname?: string;
  originServerName?: string; // HTTP Host header to send to Traefik (e.g., n8n-bdc.ci.lan)
  /**
   * Discriminator for infrastructure entries that CI-Cloud must preserve
   * across regular app sync. Unset/undefined means a regular user app
   * (eligible for stale-app cleanup on the Portal). Non-null values are
   * persisted into `application.privileged_kind` in the Portal DB and those
   * rows are skipped during sync pruning, so losing visibility of the entry
   * in a later sync never deletes the Cloudflare tunnel route external
   * clients depend on.
   *
   *   'hub' — the Hub's own application row. The Portal filters this entry
   *           out of the generated ingress rules and reconstructs its route
   *           from the DB so `host.docker.internal:{port}` always reflects
   *           the authoritative port.
   *   'vpn' — legacy discriminator; retained for backward compatibility with
   *           older Portal rows. The Hub no longer syncs Headscale routes.
   *
   * Replaces the older boolean `isHub` + `isVpn` flags; see CI-Portal
   * migration 0017.
   */
  privilegedKind?: 'hub' | 'vpn';
}

/**
 * Outcome of a CI-Cloud state sync. `ok` reflects whether the request itself
 * succeeded; `failed` lists app names CI-Cloud could not create a public DNS
 * record for (a partially-applied sync). Callers must treat a non-empty
 * `failed` list as a user-visible failure — those apps will not resolve.
 */
export interface CloudflareSyncResult {
  ok: boolean;
  failed: string[];
  synced: number;
}

@Injectable()
export class CloudflareClientService {
  private readonly logger = new Logger(CloudflareClientService.name);
  private readonly cloudApiUrl: string;
  private readonly client: AxiosInstance;
  private tunnelToken: string | null = null;
  private tunnelId: string | null = null;

  constructor(
    private configService: ConfigurationService,
    private moduleRef: ModuleRef,
  ) {
    const ciCloudUrl = this.configService.get('ciCloudUrl') || DEFAULT_CI_CLOUD_URL;
    this.cloudApiUrl = `${ciCloudUrl}/api`;

    this.client = axios.create({
      baseURL: this.cloudApiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private getRequestConfig() {
    const authToken = this.configService.get('ciHubApiKey');
    return {
      headers: {
        Authorization: `Bearer ${authToken}`,
        'x-device-key': authToken,
      },
    };
  }

  private isAvailableDomain(entry: unknown): entry is AvailableDomain {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const candidate = entry as Partial<AvailableDomain> & { id?: string | number };

    return (
      (typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
      typeof candidate.domain === 'string' &&
      typeof candidate.isDefault === 'boolean' &&
      (typeof candidate.scope === 'string' || typeof candidate.scope === 'undefined')
    );
  }

  private async updateTunnelFiles(token: string) {
    // Tunnel state defaults under APP_DIR, but tests can redirect it with CI_HUB_TUNNEL_DIR.
    const tunnelDir = TUNNEL_DIR;
    const certsDir = path.join(tunnelDir, 'certs');

    try {
      this.logger.debug(`Writing tunnel token to: ${tunnelDir}`);
      await fs.mkdir(tunnelDir, { recursive: true });
      await fs.mkdir(certsDir, { recursive: true });

      // Write the token to a file that cloudflared will read (configured in docker-compose)
      await writeHealableTextFile(path.join(tunnelDir, 'token'), token, 0o644);
      this.logger.log('Wrote tunnel token to file');
    } catch (e) {
      this.logger.error(`Failed to write tunnel files: ${e}`);
      throw e;
    }
  }

  /**
   * Initialize tunnel by saving credentials provided by CI-Cloud during registration
   */
  async initializeTunnel(
    organizationId: string,
    credentials: { tunnelId: string; token: string },
  ): Promise<{ tunnelId: string; token: string } | null> {
    try {
      this.logger.log(`Configuring tunnel for org: ${organizationId}...`);

      if (credentials?.token) {
        this.tunnelId = credentials.tunnelId;
        this.tunnelToken = credentials.token;

        await this.updateTunnelFiles(this.tunnelToken);

        const domain = this.configService.get('domain');
        if (domain === 'ci.localhost') {
          this.logger.log('Local/E2E mode — skipping cloudflared container start');
          return { tunnelId: this.tunnelId, token: this.tunnelToken };
        }

        this.logger.log('Ensuring cloudflared container is running...');
        const dockerService = this.moduleRef.get(DockerService, { strict: false });
        const composeFile = await this.getComposeFile();
        await dockerService.ensureContainerRunning('cloudflared', {
          composeFile,
          profile: 'cloudflare',
        });
        this.logger.log('Cloudflared container is running.');

        this.logger.log(`Tunnel configured successfully: ${this.tunnelId}`);
        return { tunnelId: this.tunnelId, token: this.tunnelToken };
      }

      this.logger.error(`No credentials provided for tunnel initialization for org ${organizationId}`);
      return null;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to configure tunnel: ${error.message}`);
      } else {
        this.logger.error(`Failed to configure tunnel: ${String(error)}`);
      }
      return null;
    }
  }

  /**
   * Sync local state (running apps) to CI-Cloud
   * CI-Cloud will then update Cloudflare Tunnel Config & DNS
   */
  async syncState(organizationId: string, apps: AppInfo[], tunnelId?: string): Promise<CloudflareSyncResult> {
    if (tunnelId) {
      this.tunnelId = tunnelId;
    }

    if (!this.tunnelId) {
      this.logger.warn('Cannot sync state: Tunnel not initialized and no tunnelId provided');
      return { ok: false, failed: [], synced: 0 };
    }

    try {
      this.logger.log(`Syncing ${apps.length} apps to CI-Cloud (Tunnel: ${this.tunnelId})...`);
      this.logger.log(`Sync Payload: ${JSON.stringify({ organizationId, tunnelId: this.tunnelId, apps }, null, 2)}`);
      const response = await this.client.post(
        'tunnels/state',
        {
          organizationId,
          tunnelId: this.tunnelId,
          apps,
        },
        this.getRequestConfig(),
      );

      this.logger.log(`Sync Response: ${JSON.stringify(response.data)}`);

      if (response.data.success) {
        // CI-Cloud returns `failed` (app names whose public DNS record could not
        // be created) and `synced` (count of DNS records created). Surface a
        // clear warning instead of silently reporting success — a partially
        // applied sync means those apps will not load at their public domain.
        const failed: string[] = Array.isArray(response.data.failed) ? response.data.failed : [];
        const synced: number | undefined = typeof response.data.synced === 'number' ? response.data.synced : undefined;

        if (failed.length > 0) {
          this.logger.warn(
            `[Cloudflare] State sync only partially applied: ${failed.length} app(s) did NOT get a public DNS record and will not load at their public domain: ${failed.join(', ')}. ` +
              `Verify the selected domain's zone is reachable in this environment (see CI-Cloud DNS logs for the underlying Cloudflare error).`,
          );
        } else {
          this.logger.log(`State sync successful${synced === undefined ? '' : ` (${synced} DNS record(s) synced)`}`);
        }

        return { ok: true, failed, synced: synced ?? 0 };
      }
      return { ok: false, failed: [], synced: 0 };
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to sync state: ${error.message}`);
      } else {
        this.logger.error(`Failed to sync state: ${String(error)}`);
      }
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`Error Response: ${JSON.stringify(error.response.data)}`);
      }
      return { ok: false, failed: [], synced: 0 };
    }
  }

  async fetchAvailableDomains(): Promise<AvailableDomainsResponse> {
    try {
      const requestConfig = this.getRequestConfig();
      let response: AxiosResponse<{ domains?: unknown[] }>;

      // CI-Portal serves domain listing at /api/domains. Keep a namespaced
      // fallback for compatibility if CI-Cloud route topology changes.
      try {
        response = await this.client.get('domains', requestConfig);
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status !== 404) {
          throw error;
        }

        this.logger.warn('CI-Cloud domains endpoint returned 404, retrying cloudflare/domains fallback');
        response = await this.client.get('cloudflare/domains', requestConfig);
      }

      const domains = Array.isArray(response.data?.domains)
        ? response.data.domains
            .filter((entry: unknown): entry is AvailableDomain => this.isAvailableDomain(entry))
            .map((entry: AvailableDomain) => ({ ...entry, id: String(entry.id) }))
        : [];

      this.logger.debug(`Fetched ${domains.length} domain(s) from CI-Cloud`);

      return { domains };
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to fetch available domains: ${error.message}`);
      } else {
        this.logger.error(`Failed to fetch available domains: ${String(error)}`);
      }
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`Domain fetch error response: ${JSON.stringify(error.response.data)}`);
      }

      return { domains: [] };
    }
  }

  async checkDnsAvailability(subdomain: string, domain?: string): Promise<{ available: boolean; message?: string }> {
    try {
      const response = await this.client.get('cloudflare/check-dns-availability', {
        ...this.getRequestConfig(),
        params: {
          subdomain,
          ...(domain ? { domain } : {}),
        },
      });

      if (typeof response.data?.available === 'boolean') {
        return {
          available: response.data.available,
          message: typeof response.data?.message === 'string' ? response.data.message : undefined,
        };
      }

      return {
        available: false,
        message: 'Unable to verify DNS availability (unexpected CI-Cloud response)',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message
          ? error.message
          : axios.isAxiosError(error)
            ? [error.code, error.response?.status, error.response?.statusText].filter(Boolean).join(' ') || 'CI-Cloud request failed'
            : String(error);

      this.logger.error(`Failed to check DNS availability: ${errorMessage}`);

      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`DNS availability error response: ${JSON.stringify(error.response.data)}`);
      }

      const errorData = (error as { response?: { data?: { message?: unknown; error?: unknown } } })?.response?.data;
      const responseMessage =
        typeof errorData?.message === 'string' ? errorData.message : typeof errorData?.error === 'string' ? errorData.error : '';

      if (axios.isAxiosError(error) && !error.response) {
        this.logger.warn('CI-Cloud DNS availability check timed out or was unreachable; failing open');
        return {
          available: true,
          message: 'Unable to verify DNS availability right now. Please try again.',
        };
      }

      const message = responseMessage || 'Unable to verify DNS availability right now. Please try again.';

      return {
        available: false,
        message,
      };
    }
  }

  getTunnelId(): string | null {
    return this.tunnelId;
  }

  getTunnelToken(): string | null {
    return this.tunnelToken;
  }

  /**
   * Load tunnel token from disk into memory. Call on startup so getTunnelToken() returns
   * correctly after a restart (token file exists but in-memory state was reset).
   * Optionally set tunnelId from the registered org if available.
   */
  async loadTunnelTokenFromDisk(tunnelId?: string | null): Promise<boolean> {
    try {
      if (tunnelId) {
        this.tunnelId = tunnelId;
      }
      const tokenPath = path.join(TUNNEL_DIR, 'token');
      const token = await fs.readFile(tokenPath, 'utf-8');
      const trimmed = token?.trim();
      if (trimmed) {
        this.tunnelToken = trimmed;
        this.logger.warn(`Loaded tunnel token from disk (${trimmed.length} chars, tunnelId=${tunnelId ?? 'none'})`);
        return true;
      }
      this.logger.warn('Tunnel token file exists but is empty');
    } catch (err) {
      this.logger.error(`Failed to read tunnel token from disk: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /**
   * Idempotently start/restart the cloudflared container when a token is
   * present. Called on every Hub boot: the existing `recoverTunnelTokenFromDb`
   * path only spawns cloudflared when the token file is missing, so restarts
   * of a previously-registered Hub would otherwise leave the tunnel down.
   * Skipped in local/E2E mode (domain === ci.localhost).
   */
  async ensureCloudflaredRunning(options: { forceRestart?: boolean } = {}): Promise<boolean> {
    if (!this.tunnelToken) {
      this.logger.warn('ensureCloudflaredRunning: skipped — no tunnel token in memory');
      return false;
    }
    const domain = this.configService.get('domain');
    if (domain === 'ci.localhost') {
      this.logger.warn('Local/E2E mode — not ensuring cloudflared container');
      return false;
    }
    try {
      const dockerService = this.moduleRef.get(DockerService, { strict: false });

      const alreadyRunning = await dockerService.isContainerRunning('cloudflared');
      if (alreadyRunning && !options.forceRestart) {
        this.logger.debug('ensureCloudflaredRunning: cloudflared is already running, skipping restart');
        return true;
      }

      if (alreadyRunning && options.forceRestart) {
        this.logger.warn('ensureCloudflaredRunning: restarting cloudflared after tunnel credential recovery...');
        await dockerService.restartContainer('cloudflared');
        this.logger.warn('Cloudflared container restarted with recovered credentials.');
        return true;
      }

      this.logger.warn('Ensuring cloudflared container is running (post-boot)...');
      const composeFile = this.getComposeFile();
      await dockerService.ensureContainerRunning('cloudflared', {
        composeFile,
        profile: 'cloudflare',
      });
      this.logger.warn('Cloudflared container is running.');
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to ensure cloudflared is running: ${msg}`);
      return false;
    }
  }

  /**
   * Resolve the docker-compose file used to spawn the `cloudflared` service.
   * Inside the bundled Hub container the active compose file is bind-mounted at
   * `${DATA_DIR}/docker-compose.yml` (matches DockerService.getBaseComposeArgsHub);
   * fall back to the repo-root source file for local `pnpm dev` and tests.
   * Gating on NODE_ENV breaks here because .env.dev sets NODE_ENV=development
   * inside the bundled image, which would point at a non-existent
   * /app/docker-compose.local.yml.
   */
  private getComposeFile(): string {
    const mounted = path.join(DATA_DIR, 'docker-compose.yml');
    if (fsSync.existsSync(mounted)) {
      return mounted;
    }

    const isLocal = process.env.LOCAL === 'true' || process.env.NODE_ENV === 'development';
    const isStaging = process.env.NODE_ENV === 'staging';

    let filename = 'docker-compose.prod.yml';
    if (isLocal) {
      filename = 'docker-compose.local.yml';
    } else if (isStaging) {
      filename = 'docker-compose.staging.yml';
    }

    return path.join(APP_DIR, filename);
  }
}
