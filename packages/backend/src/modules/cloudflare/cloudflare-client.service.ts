import { APP_DIR, DATA_DIR } from '@/common/constants';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface AppInfo {
  name: string;
  subdomain: string; // Full subdomain (e.g., n8n-bdc) - used for Cloudflare public hostname
  localPort: number;
  protocol?: 'http' | 'https';
  hostname?: string;
  originServerName?: string; // HTTP Host header to send to Traefik (e.g., n8n-bdc.companionintelligence.com)
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
   *   'vpn' — the org's self-hosted Headscale coordination server. Routed
   *           normally through the ingress list but preserved across sync.
   *
   * Replaces the older boolean `isHub` + `isVpn` flags; see CI-Portal
   * migration 0017.
   */
  privilegedKind?: 'hub' | 'vpn';
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
    const ciCloudUrl = this.configService.get('ciCloudUrl') || 'https://portal.companionintelligence.com';
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

  private async updateTunnelFiles(token: string) {
    // APP_DIR is configured to be the repo root in dev, and /app in prod
    const tunnelDir = path.join(APP_DIR, 'tunnel');
    const certsDir = path.join(tunnelDir, 'certs');

    try {
      this.logger.debug(`Writing tunnel token to: ${tunnelDir}`);
      await fs.mkdir(tunnelDir, { recursive: true });
      await fs.mkdir(certsDir, { recursive: true });

      // Write the token to a file that cloudflared will read (configured in docker-compose)
      await fs.writeFile(path.join(tunnelDir, 'token'), token, { mode: 0o644 });
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
  async syncState(organizationId: string, apps: AppInfo[], tunnelId?: string): Promise<boolean> {
    if (tunnelId) {
      this.tunnelId = tunnelId;
    }

    if (!this.tunnelId) {
      this.logger.warn('Cannot sync state: Tunnel not initialized and no tunnelId provided');
      return false;
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
        this.logger.log('State sync successful');
        return true;
      }
      return false;
    } catch (error) {
      if (error instanceof Error) {
        this.logger.error(`Failed to sync state: ${error.message}`);
      } else {
        this.logger.error(`Failed to sync state: ${String(error)}`);
      }
      if (axios.isAxiosError(error) && error.response) {
        this.logger.error(`Error Response: ${JSON.stringify(error.response.data)}`);
      }
      return false;
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
      const tokenPath = path.join(APP_DIR, 'tunnel', 'token');
      const token = await fs.readFile(tokenPath, 'utf-8');
      const trimmed = token?.trim();
      if (trimmed) {
        this.tunnelToken = trimmed;
        this.logger.log('Loaded tunnel token from disk');
        return true;
      }
    } catch {
      // File missing or unreadable — token stays null
    }
    return false;
  }

  /**
   * Resolve the correct docker-compose file for the current environment.
   * Local/dev uses the repo-local compose file. In containerized runtime, the
   * active hub compose file is mounted at /data/docker-compose.yml.
   */
  private async getComposeFile(): Promise<string> {
    const isLocal = process.env.LOCAL === 'true' || process.env.NODE_ENV === 'development';

    if (!isLocal) {
      const runtimeComposeFile = path.join(DATA_DIR, 'docker-compose.yml');

      try {
        await fs.access(runtimeComposeFile);
        return runtimeComposeFile;
      } catch {
        // Fall back to the source compose file when not running inside the hub container.
      }
    }

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
