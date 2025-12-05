import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';

interface TunnelIngressRule {
  hostname?: string;
  path?: string;
  service: string;
}

interface TunnelConfig {
  ingress: TunnelIngressRule[];
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

// Dashboard port where the main runtipi application runs
const DASHBOARD_PORT = 5002;

@Injectable()
export class CloudflareTunnelService {
  private readonly apiBaseUrl = 'https://api.cloudflare.com/client/v4';
  private _isEnabled: boolean | null = null; // Cache the enabled state

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Get Cloudflare API credentials from environment
   */
  private getApiCredentials(): { apiToken: string; accountId: string; tunnelId: string; zoneId?: string } | null {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID; // Optional - for DNS management

    if (!apiToken || !accountId || !tunnelId) {
      return null;
    }

    return { apiToken, accountId, tunnelId, zoneId };
  }

  /**
   * Check if Cloudflare Tunnel integration is enabled
   * Cached to avoid repeated environment variable lookups
   * Note: Cache is checked on first call, but we re-check credentials each time
   * to handle cases where env vars might be loaded after service initialization
   */
  public isEnabled(): boolean {
    // Always check credentials (env vars might be loaded after service init)
    // But cache the result to avoid repeated checks within the same request cycle
    const credentials = this.getApiCredentials();
    const enabled = credentials !== null;
    
    // Update cache if it's null or if the state changed
    if (this._isEnabled === null || this._isEnabled !== enabled) {
      this._isEnabled = enabled;
      if (enabled) {
        this.logger.debug('Cloudflare Tunnel integration is enabled');
      }
    }
    
    return this._isEnabled;
  }

  /**
   * Check if DNS management is enabled (requires CLOUDFLARE_ZONE_ID)
   */
  public isDnsEnabled(): boolean {
    const credentials = this.getApiCredentials();
    return credentials !== null && !!credentials.zoneId;
  }

  /**
   * Get current tunnel configuration
   * Returns null if tunnel has no configuration (404), which we'll handle by creating one
   */
  private async getTunnelConfig(): Promise<TunnelConfig | null> {
    const credentials = this.getApiCredentials();
    if (!credentials) {
      return null;
    }

    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${credentials.tunnelId}/configurations`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (response.status === 404) {
        // Tunnel exists but has no configuration yet - this is okay, we'll create one
        this.logger.debug('Tunnel has no configuration yet, will create initial config');
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to get tunnel config: ${response.status} ${errorText}`);
        return null;
      }

      const data: CloudflareApiResponse<{ config: TunnelConfig }> = await response.json();

      if (!data.success) {
        // Check if it's the "configuration not found" error
        if (data.errors?.some((err) => err.code === 1055)) {
          this.logger.debug('Tunnel has no configuration yet, will create initial config');
          return null;
        }
        this.logger.error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
        return null;
      }

      return data.result.config;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Cloudflare API request timed out');
      } else {
        this.logger.error(`Error getting tunnel config: ${error}`);
      }
      return null;
    }
  }

  /**
   * Update tunnel configuration
   */
  private async updateTunnelConfig(config: TunnelConfig): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials) {
      return false;
    }

    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${credentials.tunnelId}/configurations`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ config }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to update tunnel config: ${response.status} ${errorText}`);
        return false;
      }

      const data: CloudflareApiResponse<{ config: TunnelConfig }> = await response.json();

      if (!data.success) {
        this.logger.error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
        return false;
      }

      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Cloudflare API request timed out');
      } else {
        this.logger.error(`Error updating tunnel config: ${error}`);
      }
      return false;
    }
  }

  /**
   * Create a DNS CNAME record pointing to the tunnel
   * @param hostname - Full hostname (e.g., "app.companionintel.com")
   * @returns true if successful, false otherwise
   */
  private async createDnsRecord(hostname: string): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials || !credentials.zoneId) {
      this.logger.debug('DNS management not enabled (CLOUDFLARE_ZONE_ID not set)');
      return false;
    }

    // The CNAME target for Cloudflare Tunnel is <tunnel-id>.cfargotunnel.com
    const cnameTarget = `${credentials.tunnelId}.cfargotunnel.com`;

    try {
      // First, check if the record already exists
      const existingRecord = await this.getDnsRecord(hostname);
      if (existingRecord) {
        this.logger.debug(`DNS record for ${hostname} already exists`);
        return true;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'CNAME',
            name: hostname,
            content: cnameTarget,
            proxied: true, // Enable Cloudflare proxy (orange cloud)
            ttl: 1, // Auto TTL when proxied
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to create DNS record: ${response.status} ${errorText}`);
        return false;
      }

      const data: CloudflareApiResponse<DnsRecord> = await response.json();

      if (!data.success) {
        this.logger.error(`Cloudflare DNS API error: ${JSON.stringify(data.errors)}`);
        return false;
      }

      this.logger.info(`Created DNS CNAME record: ${hostname} -> ${cnameTarget}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Cloudflare DNS API request timed out');
      } else {
        this.logger.error(`Error creating DNS record: ${error}`);
      }
      return false;
    }
  }

  /**
   * Get a DNS record by hostname
   */
  private async getDnsRecord(hostname: string): Promise<DnsRecord | null> {
    const credentials = this.getApiCredentials();
    if (!credentials || !credentials.zoneId) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data: CloudflareApiResponse<DnsRecord[]> = await response.json();

      if (!data.success || !data.result || data.result.length === 0) {
        return null;
      }

      return data.result[0];
    } catch (error) {
      this.logger.error(`Error getting DNS record: ${error}`);
      return null;
    }
  }

  /**
   * Delete a DNS record by hostname
   */
  private async deleteDnsRecord(hostname: string): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials || !credentials.zoneId) {
      this.logger.debug('DNS management not enabled (CLOUDFLARE_ZONE_ID not set)');
      return false;
    }

    try {
      // First, find the record
      const record = await this.getDnsRecord(hostname);
      if (!record) {
        this.logger.debug(`DNS record for ${hostname} not found, nothing to delete`);
        return true;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records/${record.id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to delete DNS record: ${response.status} ${errorText}`);
        return false;
      }

      const data: CloudflareApiResponse<{ id: string }> = await response.json();

      if (!data.success) {
        this.logger.error(`Cloudflare DNS API error: ${JSON.stringify(data.errors)}`);
        return false;
      }

      this.logger.info(`Deleted DNS CNAME record for ${hostname}`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Cloudflare DNS API request timed out');
      } else {
        this.logger.error(`Error deleting DNS record: ${error}`);
      }
      return false;
    }
  }

  /**
   * Create a tunnel route for an app
   * Routes directly to the app's localhost port via Cloudflare Tunnel
   * Also creates DNS CNAME record if CLOUDFLARE_ZONE_ID is set
   * @param subdomain - The subdomain (e.g., "ghost")
   * @param port - The local port where the app is running
   * @returns true if successful, false otherwise
   */
  public async createAppRoute(subdomain: string, port: number): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // Get LOCAL_DOMAIN from config
    const localDomain = this.config.get('userSettings').localDomain || process.env.LOCAL_DOMAIN;
    if (!localDomain) {
      this.logger.error('No local domain configured. Please set userSettings.localDomain or LOCAL_DOMAIN environment variable.');
      return false;
    }
    const hostname = `${subdomain}.${localDomain}`;
    
    // Route directly to the app's port - no Traefik middleman
    const serviceUrl = `http://localhost:${port}`;

    let currentConfig = await this.getTunnelConfig();
    
    // If tunnel has no configuration, create an initial one with catch-all route to dashboard
    if (!currentConfig) {
      this.logger.info('Creating initial tunnel configuration with catch-all route to dashboard');
      
      currentConfig = {
        ingress: [
          // Catch-all route - routes all unmatched requests to the dashboard
          {
            service: `http://localhost:${DASHBOARD_PORT}`,
          },
        ],
      };
      // Create the initial configuration
      const created = await this.updateTunnelConfig(currentConfig);
      if (!created) {
        this.logger.error('Failed to create initial tunnel configuration');
        return false;
      }
    }

    // Check if route already exists (matching hostname)
    const existingRoute = currentConfig.ingress.find(
      (rule) => rule.hostname === hostname,
    );

    if (existingRoute) {
      // Update existing route if port changed
      if (existingRoute.service !== serviceUrl) {
        existingRoute.service = serviceUrl;
        const success = await this.updateTunnelConfig(currentConfig);
        if (success) {
          this.logger.info(`Updated Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
        } else {
          this.logger.error(`Failed to update Cloudflare Tunnel route for ${hostname}`);
        }
        return success;
      }
      this.logger.debug(`Route for hostname ${hostname} already exists with same port`);
      // Still try to create DNS record in case it's missing
      await this.createDnsRecord(hostname);
      return true;
    }

    // Create new ingress rule
    const newRule: TunnelIngressRule = {
      hostname: hostname,
      service: serviceUrl,
    };

    // Add the new rule before the catch-all
    // The catch-all rule should remain last
    const catchAllIndex = currentConfig.ingress.findIndex(
      (rule) => !rule.hostname,
    );

    if (catchAllIndex >= 0) {
      currentConfig.ingress.splice(catchAllIndex, 0, newRule);
    } else {
      // No catch-all, add the new rule and ensure there's a catch-all pointing to dashboard
      currentConfig.ingress.push(newRule);
      currentConfig.ingress.push({
        service: `http://localhost:${DASHBOARD_PORT}`,
      });
    }

    const success = await this.updateTunnelConfig(currentConfig);

    if (success) {
      this.logger.info(`Created Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
      
      // Also create DNS CNAME record pointing to the tunnel
      await this.createDnsRecord(hostname);
    } else {
      this.logger.error(`Failed to create Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }

  /**
   * Delete a tunnel route for an app
   * Also deletes the DNS CNAME record if CLOUDFLARE_ZONE_ID is set
   * @param subdomain - The subdomain (e.g., "ghost")
   * @returns true if successful, false otherwise
   */
  public async deleteAppRoute(subdomain: string): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // Get LOCAL_DOMAIN from config (e.g., "companionintel.com")
    const localDomain = this.config.get('userSettings').localDomain || process.env.LOCAL_DOMAIN || 'companionintel.com';
    const hostname = `${subdomain}.${localDomain}`;

    const currentConfig = await this.getTunnelConfig();
    if (!currentConfig) {
      // If tunnel has no configuration, there's nothing to delete
      this.logger.debug(`Tunnel has no configuration, nothing to delete for ${hostname}`);
      // Still try to delete DNS record
      await this.deleteDnsRecord(hostname);
      return true;
    }

    // Remove routes matching the hostname
    const filteredIngress = currentConfig.ingress.filter(
      (rule) => rule.hostname !== hostname,
    );

    // Ensure we still have at least a catch-all rule pointing to dashboard
    const hasCatchAll = filteredIngress.some(
      (rule) => !rule.hostname,
    );

    if (!hasCatchAll) {
      filteredIngress.push({
        service: `http://localhost:${DASHBOARD_PORT}`,
      });
    }

    currentConfig.ingress = filteredIngress;

    const success = await this.updateTunnelConfig(currentConfig);

    if (success) {
      this.logger.info(`Deleted Cloudflare Tunnel route for ${hostname}`);
      
      // Also delete DNS CNAME record
      await this.deleteDnsRecord(hostname);
    } else {
      this.logger.error(`Failed to delete Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }
}
