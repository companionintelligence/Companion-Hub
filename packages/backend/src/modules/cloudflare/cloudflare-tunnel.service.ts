import { Injectable } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigurationService } from '@/core/config/configuration.service';

interface TunnelIngressRule {
  hostname?: string;
  path?: string;
  service: string;
  originRequest?: {
    httpHostHeader?: string;
    noHappyEyeballs?: boolean;
    connectTimeout?: number;
    tcpKeepAlive?: number;
  };
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

// Dashboard port where the main CI-OS-Hub application runs
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
   * Get Cloudflare API credentials for organization-specific operations
   * Uses the provided tunnelId instead of the default one
   */
  private getOrgApiCredentials(tunnelId: string): { apiToken: string; accountId: string; tunnelId: string; zoneId?: string } | null {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;

    if (!apiToken || !accountId) {
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
   * Create a DNS CNAME record pointing to the tunnel with retry logic
   * @param hostname - Full hostname (e.g., "app.companionintel.com")
   * @param retries - Number of retry attempts (default: 3)
   * @returns true if successful, false otherwise
   */
  private async createDnsRecord(hostname: string, retries = 3): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials) {
      this.logger.debug('DNS management not available (Cloudflare credentials not configured)');
      return false;
    }
    if (!credentials.zoneId) {
      this.logger.debug(`DNS management not enabled for ${hostname} (CLOUDFLARE_ZONE_ID not set)`);
      return false;
    }

    // The CNAME target for Cloudflare Tunnel is <tunnel-id>.cfargotunnel.com
    const cnameTarget = `${credentials.tunnelId}.cfargotunnel.com`;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // First, check if the record already exists
        const existingRecord = await this.getDnsRecord(hostname);
        if (existingRecord) {
          // Verify it points to the correct tunnel
          if (existingRecord.content === cnameTarget) {
            this.logger.debug(`DNS record for ${hostname} already exists and is correct`);
            return true;
          }
          // Record exists but points to wrong target - this shouldn't happen normally
          this.logger.warn(`DNS record for ${hostname} exists but points to ${existingRecord.content} instead of ${cnameTarget}`);
          return true; // Still consider it success since DNS record exists
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // Increased timeout

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
          this.logger.error(`Failed to create DNS record (attempt ${attempt}/${retries}): ${response.status} ${errorText}`);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }
          return false;
        }

        const data: CloudflareApiResponse<DnsRecord> = await response.json();

        if (!data.success) {
          // Check if error is "record already exists" - that's actually okay
          const alreadyExists = data.errors?.some(e => e.code === 81057 || e.message?.includes('already exists'));
          if (alreadyExists) {
            this.logger.debug(`DNS record for ${hostname} already exists (confirmed by API)`);
            return true;
          }
          this.logger.error(`Cloudflare DNS API error (attempt ${attempt}/${retries}): ${JSON.stringify(data.errors)}`);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          }
          return false;
        }

        this.logger.info(`Created DNS CNAME record: ${hostname} -> ${cnameTarget}`);
        
        // Verify the record was created by fetching it back
        await new Promise(resolve => setTimeout(resolve, 500)); // Brief delay for propagation
        const verifyRecord = await this.getDnsRecord(hostname);
        if (!verifyRecord) {
          this.logger.warn(`DNS record created but verification failed for ${hostname} - may need time to propagate`);
        }
        
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.logger.warn(`Cloudflare DNS API request timed out (attempt ${attempt}/${retries})`);
        } else {
          this.logger.error(`Error creating DNS record (attempt ${attempt}/${retries}): ${error}`);
        }
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return false;
      }
    }
    return false;
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
   * Check if a DNS record exists for a given subdomain
   * @param subdomain - The subdomain to check (e.g., "ghost")
   * @returns true if the DNS record exists (not available), false if available
   */
  public async checkDnsAvailability(subdomain: string): Promise<{ available: boolean; hostname?: string }> {
    if (!this.isDnsEnabled()) {
      // If DNS management is not enabled, assume it's available
      return { available: true };
    }

    // Get DOMAIN from config (public domain like companionintel.com)
    // Cloudflare DNS records should use the public domain, not localDomain
    const domain = this.config.get('userSettings').domain || process.env.DOMAIN;
    if (!domain) {
      this.logger.debug('No public domain configured, cannot check DNS availability');
      return { available: true };
    }

    const hostname = `${subdomain}.${domain}`;
    const existingRecord = await this.getDnsRecord(hostname);
    
    return {
      available: !existingRecord,
      hostname: hostname,
    };
  }

  /**
   * Check if a tunnel with the given name already exists
   * @param tunnelName - The tunnel name to check (e.g., "hub-acme-corp")
   * @returns true if tunnel exists, false otherwise
   */
  public async checkTunnelNameExists(tunnelName: string): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}`,
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
        return false;
      }

      const data: CloudflareApiResponse<Array<{ id: string; name: string }>> = await response.json();

      if (!data.success) {
        return false;
      }

      // Check if any tunnel with this name exists
      return data.result && data.result.length > 0;
    } catch (error) {
      this.logger.error(`Error checking tunnel name: ${error}`);
      return false;
    }
  }

  /**
   * Validate organization subdomain availability
   * Checks both DNS and tunnel name conflicts
   * @param orgName - Organization name/slug (e.g., "acme-corp")
   * @returns Validation result with availability status and error messages
   */
  public async validateOrganizationSubdomain(orgName: string): Promise<{
    available: boolean;
    dnsAvailable: boolean;
    tunnelNameAvailable: boolean;
    hostname?: string;
    tunnelName?: string;
    errors: string[];
    error?: string; // General error if validation couldn't complete
  }> {
    const errors: string[] = [];
    const domain = this.config.get('userSettings').domain || process.env.DOMAIN || 'companionintel.com';
    const hostname = `${orgName}.${domain}`;
    const tunnelName = `hub-${orgName}`;

    // Check if Cloudflare is enabled
    if (!this.isEnabled()) {
      return {
        available: true, // Allow registration if Cloudflare not enabled
        dnsAvailable: true,
        tunnelNameAvailable: true,
        hostname,
        tunnelName,
        errors: [],
        error: 'Cloudflare integration not enabled. Validation skipped.',
      };
    }

    try {
      // Check tunnel name availability first (most important check)
      const tunnelExists = await this.checkTunnelNameExists(tunnelName);
      const tunnelNameAvailable = !tunnelExists;

      if (tunnelExists) {
        errors.push(`This name is already taken. The connector "${tunnelName}" already exists in your Cloudflare account. Please try another name.`);
      }

      // Check DNS availability if DNS management is enabled
      if (this.isDnsEnabled()) {
        const dnsCheck = await this.checkDnsAvailability(orgName);
        const dnsAvailable = dnsCheck.available;

        if (!dnsAvailable) {
          errors.push(`DNS record already exists for ${hostname}. This subdomain is already in use.`);
        }

        return {
          available: dnsAvailable && tunnelNameAvailable,
          dnsAvailable,
          tunnelNameAvailable,
          hostname,
          tunnelName,
          errors,
        };
      } else {
        // DNS not enabled, only check tunnel name
        return {
          available: tunnelNameAvailable,
          dnsAvailable: true, // Assume available if DNS not managed
          tunnelNameAvailable,
          hostname,
          tunnelName,
          errors,
        };
      }
    } catch (error) {
      this.logger.error(`Error validating organization subdomain: ${error}`);
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        hostname,
        tunnelName,
        errors: ['Failed to validate organization name. Please check your Cloudflare configuration.'],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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
   * Routes to Traefik reverse proxy which then routes to the app container
   * Also creates DNS CNAME record if CLOUDFLARE_ZONE_ID is set
   * Uses organization-specific tunnel if organization is registered
   * @param subdomain - The subdomain (e.g., "ghost")
   * @param port - Unused (kept for compatibility, apps now go through Traefik)
   * @param organizationInfo - Optional organization info (if provided, uses org-specific tunnel)
   * @returns true if successful, false otherwise
   */
  public async createAppRoute(
    subdomain: string,
    port?: number,
    organizationInfo?: { tunnelId: string; domain: string } | null,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // If organization info is provided, use organization-specific tunnel
    if (organizationInfo) {
      return this.createAppRouteForOrganization(
        subdomain,
        organizationInfo.domain,
        organizationInfo.tunnelId,
      );
    }

    // Get DOMAIN from config (public domain like companionintel.com)
    // Cloudflare Tunnel routes should use the public domain for internet access
    // localDomain is for local network access only
    const domain = this.config.get('userSettings').domain || process.env.DOMAIN;
    if (!domain) {
      this.logger.error('No public domain configured. Please set userSettings.domain or DOMAIN environment variable.');
      return false;
    }
    const hostname = `${subdomain}.${domain}`;
    
    // Route to Traefik reverse proxy (port 80 for HTTP, Traefik handles HTTPS internally)
    // Traefik will route to the app container based on the Host header
    // Use localhost since the Cloudflare tunnel runs on the host and Traefik is exposed on host port 80
    const serviceUrl = `http://localhost:80`;

    let currentConfig = await this.getTunnelConfig();
    
    // If tunnel has no configuration, create an initial one with catch-all route to dashboard via Traefik
    if (!currentConfig) {
      this.logger.info('Creating initial tunnel configuration with catch-all route to dashboard via Traefik');
      
      currentConfig = {
        ingress: [
          // Catch-all route - routes all unmatched requests to Traefik (which routes to dashboard)
          // Traefik will handle routing based on Host header
          {
            service: `http://localhost:80`,
            originRequest: {
              // Set Host header so Traefik can route correctly
              httpHostHeader: domain,
            },
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
      // Update existing route if service URL changed or originRequest is missing
      const needsUpdate = existingRoute.service !== serviceUrl || !existingRoute.originRequest;
      
      if (needsUpdate) {
        existingRoute.service = serviceUrl;
        // Ensure originRequest is set for proper Cloudflare proxy behavior
        // Set httpHostHeader to the local domain hostname so Traefik can route correctly
        if (!existingRoute.originRequest) {
          existingRoute.originRequest = {
            httpHostHeader: hostname,
            noHappyEyeballs: false,
            connectTimeout: 30,
            tcpKeepAlive: 30,
          };
        } else {
          // Update httpHostHeader to ensure Traefik routing works
          existingRoute.originRequest.httpHostHeader = hostname;
        }
        const success = await this.updateTunnelConfig(currentConfig);
        if (success) {
          this.logger.info(`Updated Cloudflare Tunnel route for ${hostname} -> ${serviceUrl} (via Traefik)`);
        } else {
          this.logger.error(`Failed to update Cloudflare Tunnel route for ${hostname}`);
        }
        return success;
      }
      this.logger.debug(`Route for hostname ${hostname} already exists with same configuration`);
      // Still try to create DNS record in case it's missing
      const dnsCreated = await this.createDnsRecord(hostname);
      if (!dnsCreated) {
        const credentials = this.getApiCredentials();
        if (!credentials?.zoneId) {
          this.logger.warn(
            `⚠️  DNS record not created for ${hostname}. ` +
            `Set CLOUDFLARE_ZONE_ID environment variable to enable automatic DNS management.`
          );
        } else {
          this.logger.warn(
            `⚠️  Failed to create DNS CNAME record for ${hostname}. ` +
            `The tunnel route exists, but the app may not be accessible until the DNS record is created.`
          );
        }
      }
      return true;
    }

    // Create new ingress rule with originRequest to ensure proper Cloudflare proxy behavior
    const newRule: TunnelIngressRule = {
      hostname: hostname,
      service: serviceUrl,
      originRequest: {
        // Set the Host header to the original hostname so apps know their public domain
        httpHostHeader: hostname,
        // Disable happy eyeballs for faster connections
        noHappyEyeballs: false,
        // Connection timeout (in seconds)
        connectTimeout: 30,
        // TCP keep-alive (in seconds)
        tcpKeepAlive: 30,
      },
    };

    // Add the new rule before the catch-all
    // The catch-all rule should remain last
    const catchAllIndex = currentConfig.ingress.findIndex(
      (rule) => !rule.hostname,
    );

    if (catchAllIndex >= 0) {
      currentConfig.ingress.splice(catchAllIndex, 0, newRule);
    } else {
      // No catch-all, add the new rule and ensure there's a catch-all pointing to Traefik
      currentConfig.ingress.push(newRule);
      currentConfig.ingress.push({
        service: `http://localhost:80`,
        originRequest: {
          // Set Host header so Traefik can route correctly
          httpHostHeader: domain,
        },
      });
    }

    const success = await this.updateTunnelConfig(currentConfig);

    if (success) {
      this.logger.info(`Created Cloudflare Tunnel route for ${hostname} -> ${serviceUrl} (via Traefik)`);
      
      // Create DNS CNAME record - this is CRITICAL for the app to be accessible
      // We treat DNS creation as a required step, not optional
      const dnsCreated = await this.createDnsRecord(hostname);
      if (!dnsCreated) {
        const credentials = this.getApiCredentials();
        if (!credentials?.zoneId) {
          this.logger.warn(
            `⚠️  DNS record not created for ${hostname}. ` +
            `Set CLOUDFLARE_ZONE_ID environment variable to enable automatic DNS management. ` +
            `You may need to manually create a CNAME record: ${hostname} -> ${credentials?.tunnelId || '<tunnel-id>'}.cfargotunnel.com`
          );
        } else {
          // DNS creation failed even though zone ID is set - this is a problem
          this.logger.error(
            `❌ Failed to create DNS CNAME record for ${hostname} after multiple retries. ` +
            `The tunnel route was created, but the app will NOT be accessible until the DNS record is created. ` +
            `Try calling syncMissingDnsRecords() to retry DNS creation.`
          );
        }
      } else {
        this.logger.info(`✅ DNS CNAME record created successfully for ${hostname}`);
      }
    } else {
      this.logger.error(`Failed to create Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }

  /**
   * Sync missing DNS records for all tunnel routes
   * This is useful when DNS records were not created during initial setup
   * or when migrating from a system without DNS management
   * @returns Object with results for each hostname
   */
  public async syncMissingDnsRecords(): Promise<{ synced: string[]; failed: string[]; skipped: string[] }> {
    const result = { synced: [] as string[], failed: [] as string[], skipped: [] as string[] };
    
    if (!this.isDnsEnabled()) {
      this.logger.warn('DNS management not enabled (CLOUDFLARE_ZONE_ID not set)');
      return result;
    }

    const credentials = this.getApiCredentials();
    if (!credentials) {
      this.logger.error('Cloudflare credentials not available');
      return result;
    }

    // Get current tunnel config
    const tunnelConfig = await this.getTunnelConfig();
    if (!tunnelConfig) {
      this.logger.warn('No tunnel configuration found');
      return result;
    }

    // Check each route and create DNS if missing
    for (const rule of tunnelConfig.ingress) {
      if (!rule.hostname) {
        continue; // Skip catch-all route
      }

      const existingRecord = await this.getDnsRecord(rule.hostname);
      if (existingRecord) {
        result.skipped.push(rule.hostname);
        this.logger.debug(`DNS record already exists for ${rule.hostname}`);
        continue;
      }

      this.logger.info(`Creating missing DNS record for ${rule.hostname}`);
      const created = await this.createDnsRecord(rule.hostname);
      if (created) {
        result.synced.push(rule.hostname);
        this.logger.info(`✅ Created DNS record for ${rule.hostname}`);
      } else {
        result.failed.push(rule.hostname);
        this.logger.error(`❌ Failed to create DNS record for ${rule.hostname}`);
      }

      // Small delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    this.logger.info(`DNS sync complete: ${result.synced.length} created, ${result.failed.length} failed, ${result.skipped.length} already existed`);
    return result;
  }

  /**
   * Delete a tunnel route for an app
   * Also deletes the DNS CNAME record if CLOUDFLARE_ZONE_ID is set
   * @param subdomain - The subdomain (e.g., "ghost")
   * @returns true if successful, false otherwise
   */
  /**
   * Update all existing tunnel routes to include originRequest configuration
   * This ensures apps work properly behind Cloudflare Tunnel by setting proper Host headers
   * @returns Object with updated routes, skipped routes, and any errors
   */
  public async updateAllRoutesWithOriginRequest(): Promise<{
    updated: string[];
    skipped: string[];
    failed: string[];
  }> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return { updated: [], skipped: [], failed: [] };
    }

    const currentConfig = await this.getTunnelConfig();
    if (!currentConfig) {
      this.logger.warn('No tunnel configuration found');
      return { updated: [], skipped: [], failed: [] };
    }

    const updated: string[] = [];
    const skipped: string[] = [];
    let needsUpdate = false;

    // Update all routes that have hostnames (skip catch-all routes)
    for (const rule of currentConfig.ingress) {
      if (!rule.hostname) {
        continue; // Skip catch-all routes
      }

      // Check if originRequest is missing or incomplete
      if (!rule.originRequest || !rule.originRequest.httpHostHeader) {
        rule.originRequest = {
          httpHostHeader: rule.hostname,
          noHappyEyeballs: false,
          connectTimeout: 30,
          tcpKeepAlive: 30,
        };
        updated.push(rule.hostname);
        needsUpdate = true;
      } else {
        skipped.push(rule.hostname);
      }
    }

    if (!needsUpdate) {
      this.logger.info('All routes already have originRequest configuration');
      return { updated: [], skipped, failed: [] };
    }

    // Update the tunnel configuration
    const success = await this.updateTunnelConfig(currentConfig);
    if (!success) {
      this.logger.error('Failed to update tunnel configuration with originRequest settings');
      return { updated: [], skipped, failed: updated };
    }

    this.logger.info(
      `Updated ${updated.length} routes with originRequest configuration. ` +
      `${skipped.length} routes already had proper configuration.`
    );

    return { updated, skipped, failed: [] };
  }

  public async deleteAppRoute(
    subdomain: string,
    organizationInfo?: { tunnelId: string; domain: string } | null,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // If organization info is provided, use organization-specific tunnel
    if (organizationInfo) {
      return this.deleteAppRouteForOrganization(
        subdomain,
        organizationInfo.domain,
        organizationInfo.tunnelId,
      );
    }

    // Get DOMAIN from config (public domain like "companionintel.com")
    const domain = this.config.get('userSettings').domain || process.env.DOMAIN || 'companionintel.com';
    const hostname = `${subdomain}.${domain}`;

    const currentConfig = await this.getTunnelConfig();
    if (!currentConfig) {
      // If tunnel has no configuration, there's nothing to delete
      this.logger.debug(`Tunnel has no configuration, nothing to delete for ${hostname}`);
      // Still try to delete DNS record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (dnsDeleted) {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      }
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
      // Add catch-all route to Traefik (which routes to dashboard)
      const domain = this.config.get('userSettings').domain || process.env.DOMAIN || 'companionintel.com';
      filteredIngress.push({
        service: `http://localhost:80`,
        originRequest: {
          // Set Host header so Traefik can route correctly
          httpHostHeader: domain,
        },
      });
    }

    currentConfig.ingress = filteredIngress;

    const success = await this.updateTunnelConfig(currentConfig);

    if (success) {
      this.logger.info(`Deleted Cloudflare Tunnel route for ${hostname}`);
      
      // Also delete DNS CNAME record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (!dnsDeleted) {
        const credentials = this.getApiCredentials();
        if (!credentials?.zoneId) {
          this.logger.debug(`DNS record deletion skipped for ${hostname} (CLOUDFLARE_ZONE_ID not set)`);
        } else {
          this.logger.warn(`⚠️  Failed to delete DNS CNAME record for ${hostname}. You may need to delete it manually.`);
        }
      } else {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      }
    } else {
      this.logger.error(`Failed to delete Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }

  /**
   * Create a Cloudflare Tunnel for an organization
   * @param orgName - Organization name/slug (e.g., "acme-corp")
   * @returns Tunnel ID if successful, null otherwise
   */
  public async createOrganizationTunnel(orgName: string): Promise<string | null> {
    const credentials = this.getApiCredentials();
    if (!credentials) {
      this.logger.error('Cloudflare credentials not available');
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      // Create tunnel (tunnel creation doesn't include config - that's set separately)
      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `hub-${orgName}`,
          }),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to create organization tunnel: ${response.status} ${errorText}`);
        return null;
      }

      const data: CloudflareApiResponse<{ id: string; name: string }> = await response.json();

      if (!data.success) {
        this.logger.error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
        return null;
      }

      const tunnelId = data.result.id;
      this.logger.info(`Created Cloudflare Tunnel for organization ${orgName}: ${tunnelId}`);

      // Now set the tunnel configuration
      const orgDomain = `${orgName}.companionintel.com`;
      const tunnelConfig: TunnelConfig = {
        ingress: [
          {
            service: 'http://localhost:80',
            originRequest: {
              httpHostHeader: orgDomain,
            },
          },
        ],
      };

      const configSet = await this.updateTunnelConfigForTunnel(tunnelId, tunnelConfig);
      if (!configSet) {
        this.logger.warn(`Tunnel created but failed to set initial configuration for ${tunnelId}`);
        // Still return the tunnel ID - config can be set later
      }

      return tunnelId;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.warn('Cloudflare API request timed out');
      } else {
        this.logger.error(`Error creating organization tunnel: ${error}`);
      }
      return null;
    }
  }

  /**
   * Create DNS record for organization domain
   * @param orgDomain - Full organization domain (e.g., "acme-corp.companionintel.com")
   * @param tunnelId - Cloudflare Tunnel ID for the organization
   * @returns true if successful, false otherwise
   */
  public async createOrganizationDnsRecord(orgDomain: string, tunnelId: string): Promise<boolean> {
    const credentials = this.getApiCredentials();
    if (!credentials || !credentials.zoneId) {
      this.logger.error('DNS management not enabled (CLOUDFLARE_ZONE_ID not set)');
      return false;
    }

    const cnameTarget = `${tunnelId}.cfargotunnel.com`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      // Check if record already exists
      const existingRecord = await this.getDnsRecord(orgDomain);
      if (existingRecord) {
        if (existingRecord.content === cnameTarget) {
          this.logger.debug(`DNS record for ${orgDomain} already exists and is correct`);
          return true;
        }
        // Update existing record if it points to wrong target
        const updateResponse = await fetch(
          `${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records/${existingRecord.id}`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${credentials.apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              type: 'CNAME',
              name: orgDomain,
              content: cnameTarget,
              proxied: true,
              ttl: 1,
            }),
            signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (updateResponse.ok) {
          this.logger.info(`Updated DNS CNAME record: ${orgDomain} -> ${cnameTarget}`);
          return true;
        }
      }

      // Create new DNS record
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
            name: orgDomain,
            content: cnameTarget,
            proxied: true,
            ttl: 1,
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
        const alreadyExists = data.errors?.some(e => e.code === 81057 || e.message?.includes('already exists'));
        if (alreadyExists) {
          this.logger.debug(`DNS record for ${orgDomain} already exists`);
          return true;
        }
        this.logger.error(`Cloudflare DNS API error: ${JSON.stringify(data.errors)}`);
        return false;
      }

      this.logger.info(`Created DNS CNAME record: ${orgDomain} -> ${cnameTarget}`);
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
   * Get tunnel configuration for a specific tunnel ID
   */
  public async getTunnelConfigForTunnel(tunnelId: string): Promise<TunnelConfig | null> {
    const credentials = this.getOrgApiCredentials(tunnelId);
    if (!credentials) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${tunnelId}/configurations`,
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
        return null;
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to get tunnel config: ${response.status} ${errorText}`);
        return null;
      }

      const data: CloudflareApiResponse<{ config: TunnelConfig }> = await response.json();

      if (!data.success) {
        if (data.errors?.some((err) => err.code === 1055)) {
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
   * Update tunnel configuration for a specific tunnel ID
   */
  public async updateTunnelConfigForTunnel(tunnelId: string, config: TunnelConfig): Promise<boolean> {
    const credentials = this.getOrgApiCredentials(tunnelId);
    if (!credentials) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(
        `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${tunnelId}/configurations`,
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
   * Create an app route using organization-specific tunnel
   * @param subdomain - App subdomain (e.g., "ghost")
   * @param orgDomain - Organization domain (e.g., "acme-corp.companionintel.com")
   * @param tunnelId - Organization tunnel ID
   * @returns true if successful, false otherwise
   */
  public async createAppRouteForOrganization(
    subdomain: string,
    orgDomain: string,
    tunnelId: string,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    const hostname = `${subdomain}.${orgDomain}`;
    const serviceUrl = `http://localhost:80`;

    let currentConfig = await this.getTunnelConfigForTunnel(tunnelId);

    if (!currentConfig) {
      this.logger.info(`Creating initial tunnel configuration for organization tunnel ${tunnelId}`);
      currentConfig = {
        ingress: [
          {
            service: serviceUrl,
            originRequest: {
              httpHostHeader: orgDomain,
            },
          },
        ],
      };
      const created = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);
      if (!created) {
        this.logger.error('Failed to create initial tunnel configuration');
        return false;
      }
    }

    // Check if route already exists
    const existingRoute = currentConfig.ingress.find((rule) => rule.hostname === hostname);

    if (existingRoute) {
      const needsUpdate = existingRoute.service !== serviceUrl || !existingRoute.originRequest;
      if (needsUpdate) {
        existingRoute.service = serviceUrl;
        if (!existingRoute.originRequest) {
          existingRoute.originRequest = {
            httpHostHeader: hostname,
            noHappyEyeballs: false,
            connectTimeout: 30,
            tcpKeepAlive: 30,
          };
        } else {
          existingRoute.originRequest.httpHostHeader = hostname;
        }
        const success = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);
        if (success) {
          this.logger.info(`Updated Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
        }
        return success;
      }
      this.logger.debug(`Route for hostname ${hostname} already exists`);
      return true;
    }

    // Create new ingress rule
    const newRule: TunnelIngressRule = {
      hostname: hostname,
      service: serviceUrl,
      originRequest: {
        httpHostHeader: hostname,
        noHappyEyeballs: false,
        connectTimeout: 30,
        tcpKeepAlive: 30,
      },
    };

    // Add before catch-all
    const catchAllIndex = currentConfig.ingress.findIndex((rule) => !rule.hostname);
    if (catchAllIndex >= 0) {
      currentConfig.ingress.splice(catchAllIndex, 0, newRule);
    } else {
      currentConfig.ingress.push(newRule);
      currentConfig.ingress.push({
        service: serviceUrl,
        originRequest: {
          httpHostHeader: orgDomain,
        },
      });
    }

    const success = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);

    if (success) {
      this.logger.info(`Created Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
      // Create DNS record
      const dnsCreated = await this.createDnsRecord(hostname);
      if (!dnsCreated) {
        this.logger.warn(`Failed to create DNS record for ${hostname}`);
      }
    } else {
      this.logger.error(`Failed to create Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }

  /**
   * Delete an app route from organization-specific tunnel
   * @param subdomain - App subdomain (e.g., "ghost")
   * @param orgDomain - Organization domain (e.g., "acme-corp.companionintel.com")
   * @param tunnelId - Organization tunnel ID
   * @returns true if successful, false otherwise
   */
  public async deleteAppRouteForOrganization(
    subdomain: string,
    orgDomain: string,
    tunnelId: string,
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    const hostname = `${subdomain}.${orgDomain}`;

    const currentConfig = await this.getTunnelConfigForTunnel(tunnelId);
    if (!currentConfig) {
      // If tunnel has no configuration, there's nothing to delete
      this.logger.debug(`Tunnel ${tunnelId} has no configuration, nothing to delete for ${hostname}`);
      // Still try to delete DNS record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (dnsDeleted) {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      }
      return true;
    }

    // Remove routes matching the hostname
    const filteredIngress = currentConfig.ingress.filter(
      (rule) => rule.hostname !== hostname,
    );

    // Ensure we still have at least a catch-all rule
    const hasCatchAll = filteredIngress.some(
      (rule) => !rule.hostname,
    );

    if (!hasCatchAll) {
      filteredIngress.push({
        service: `http://localhost:80`,
        originRequest: {
          httpHostHeader: orgDomain,
        },
      });
    }

    currentConfig.ingress = filteredIngress;

    const success = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);

    if (success) {
      this.logger.info(`Deleted Cloudflare Tunnel route for ${hostname} from organization tunnel`);
      
      // Also delete DNS CNAME record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (!dnsDeleted) {
        const credentials = this.getApiCredentials();
        if (!credentials?.zoneId) {
          this.logger.debug(`DNS record deletion skipped for ${hostname} (CLOUDFLARE_ZONE_ID not set)`);
        } else {
          this.logger.warn(`⚠️  Failed to delete DNS CNAME record for ${hostname}. You may need to delete it manually.`);
        }
      } else {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      }
    } else {
      this.logger.error(`Failed to delete Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }
}
