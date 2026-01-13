import { Injectable, Logger } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface AppInfo {
  name: string;
  subdomain: string;
  localPort: number;
}

@Injectable()
export class CloudflareClientService {
  private readonly logger = new Logger(CloudflareClientService.name);
  private readonly cloudApiUrl: string;
  private readonly client: AxiosInstance;
  private tunnelToken: string | null = null;
  private tunnelId: string | null = null;

  constructor(private configService: ConfigurationService) {
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

  private async updateTunnelFiles(token: string, caCert?: string) {
    // /app/tunnel is mounted to ./tunnel on the host
    const tunnelDir = path.resolve('/app/tunnel'); 
    const certsDir = path.join(tunnelDir, 'certs');
    
    try {
        await fs.mkdir(certsDir, { recursive: true });
        
        if (caCert) {
            await fs.writeFile(path.join(certsDir, 'custom-ca.pem'), caCert);
            this.logger.log('Wrote custom CA certificate');
        }
        
        // Write the token to a file that can be sourced or read
        // Note: For automatic startup without restart, we might depend on cloudflared reading checks.
        // But realistically, we update the .env file for the next restart.
        // Since we don't know where the .env file IS relative to /app/tunnel easily (it's in root), 
        // we'll leave the .env update to the Registration Service or user.
        // However, we CAN write a credentials.json for cloudflared usage if we wanted.
        
    } catch (e) {
        this.logger.error(`Failed to write tunnel files: ${e}`);
    }
  }

  /**
   * Initialize tunnel by requesting credentials from CI-Cloud
   */
  async initializeTunnel(organizationId: string): Promise<{ tunnelId: string; token: string } | null> {
    try {
      this.logger.log(`Requesting tunnel provision for org: ${organizationId}...`);
      const response = await this.client.post('/tunnels/provision', {
        organizationId
      }, this.getRequestConfig());

      if (response.data && response.data.token) {
        this.tunnelId = response.data.tunnelId as string;
        this.tunnelToken = response.data.token as string;
        const caCert = response.data.caCert as string;

        await this.updateTunnelFiles(this.tunnelToken, caCert);

        this.logger.log(`Tunnel provisioned successfully: ${this.tunnelId}`);
        return { tunnelId: this.tunnelId, token: this.tunnelToken };
      }
      
      return null;
    } catch (error: any) {
      this.logger.error(`Failed to provision tunnel: ${error.message}`);
      if (error.response) {
        this.logger.error(`Response: ${JSON.stringify(error.response.data)}`);
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
