import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DockerService } from '../docker/docker.service';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface AppInfo {
  name: string;
  subdomain: string;
  localPort: number;
  protocol?: 'http' | 'https';
  hostname?: string;
  publicHostname?: string;
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
    this.cloudApiUrl = this.configService.get('ciCloudApiUrl') || 'https://app.ci.computer/api';
    
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
        'Authorization': `Bearer ${authToken}`,
        'x-device-key': authToken
      }
    };
  }

  private async updateTunnelFiles(token: string) {
    // /app/tunnel is mounted to ./tunnel on the host
    const tunnelDir = path.resolve('/app/tunnel'); 
    const certsDir = path.join(tunnelDir, 'certs');
    
    try {
        await fs.mkdir(tunnelDir, { recursive: true });
        await fs.mkdir(certsDir, { recursive: true });
        
        // Write the token to a file that cloudflared will read (configured in docker-compose)
        await fs.writeFile(path.join(tunnelDir, 'token'), token);
        this.logger.log('Wrote tunnel token to file');
        
    } catch (e) {
        this.logger.error(`Failed to write tunnel files: ${e}`);
        throw e;
    }
  }

  /**
   * Initialize tunnel by saving credentials provided by CI-Cloud during registration
   */
  async initializeTunnel(organizationId: string, credentials: { tunnelId: string; token: string }): Promise<{ tunnelId: string; token: string } | null> {
    try {
      this.logger.log(`Configuring tunnel for org: ${organizationId}...`);

      if (credentials?.token) {
        this.tunnelId = credentials.tunnelId;
        this.tunnelToken = credentials.token;

        await this.updateTunnelFiles(this.tunnelToken);
        
        this.logger.log('Restarting cloudflared container to apply new token...');
        const dockerService = this.moduleRef.get(DockerService, { strict: false });
        await dockerService.restartContainer('cloudflared');
        this.logger.log('Cloudflared container restarted.');

        this.logger.log(`Tunnel configured successfully: ${this.tunnelId}`);
        return { tunnelId: this.tunnelId, token: this.tunnelToken };
      }
      
      this.logger.error(`No credentials provided for tunnel initialization for org ${organizationId}`);
      return null;
    } catch (error: any) {
      this.logger.error(`Failed to configure tunnel: ${error.message}`);
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
      const response = await this.client.post('/tunnels/state', {
        organizationId,
        tunnelId: this.tunnelId,
        apps
      }, this.getRequestConfig());

      this.logger.log(`Sync Response: ${JSON.stringify(response.data)}`);

      if (response.data.success) {
        this.logger.log('State sync successful');
        return true;
      }
      return false;
    } catch (error: any) {
      this.logger.error(`Failed to sync state: ${error.message}`);
      if (error.response) {
         this.logger.error(`Error Response: ${JSON.stringify(error.response.data)}`);
      }
      return false;
    }
  }

  getTunnelToken(): string | null {
    return this.tunnelToken;
  }
}
