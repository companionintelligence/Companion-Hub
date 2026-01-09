import { Injectable, Logger } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import axios, { AxiosInstance } from 'axios';

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
      const response = await this.client.post('/tunnels/state', {
        organizationId,
        tunnelId: this.tunnelId,
        apps
      }, this.getRequestConfig());

      if (response.data.success) {
        this.logger.log('State sync successful');
        return true;
      }
      return false;
    } catch (error: any) {
      this.logger.error(`Failed to sync state: ${error.message}`);
      return false;
    }
  }

  getTunnelToken(): string | null {
    return this.tunnelToken;
  }
}
