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
const _DASHBOARD_PORT = 5002;

interface CachedConfig {
  config: TunnelConfig;
  timestamp: number;
}

// Production-optimized constants
const CONFIG_CACHE_TTL = 30000; // 30 seconds cache for tunnel configs
const API_RATE_LIMIT_DELAY = 100; // 100ms between API calls to respect rate limits
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 1 second base delay for exponential backoff
const API_TIMEOUT = 15000; // 15 seconds timeout for API calls

@Injectable()
export class CloudflareTunnelService {
  private readonly apiBaseUrl = 'https://api.cloudflare.com/client/v4';
  private _isEnabled: boolean | null = null; // Cache the enabled state
  private configCache = new Map<string, CachedConfig>(); // Cache tunnel configs by tunnel ID
  private lastApiCall = 0; // Track last API call time for rate limiting
  private pendingOperations = new Map<string, Promise<unknown>>(); // Deduplicate concurrent operations

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Get Cloudflare API credentials from environment
   */
  public getApiCredentials(): { apiToken: string; accountId: string; tunnelId: string; zoneId?: string } | null {
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
   * Rate limit API calls to respect Cloudflare API limits
   * Cloudflare allows 1200 requests per 5 minutes (4 requests/second)
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;
    if (timeSinceLastCall < API_RATE_LIMIT_DELAY) {
      await new Promise((resolve) => setTimeout(resolve, API_RATE_LIMIT_DELAY - timeSinceLastCall));
    }
    this.lastApiCall = Date.now();
  }

  /**
   * Make an API call with retry logic and rate limiting
   */
  private async makeApiCall<T>(
    url: string,
    options: RequestInit,
    retries = MAX_RETRIES,
  ): Promise<{ ok: boolean; status: number; data?: CloudflareApiResponse<T>; errorText?: string }> {
    await this.rateLimit();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseText = await response.text();
        let data: CloudflareApiResponse<T> | undefined;

        try {
          data = JSON.parse(responseText) as CloudflareApiResponse<T>;
        } catch {
          // Not JSON, return as error text
        }

        // Handle rate limiting (429)
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_BASE_DELAY * Math.pow(2, attempt);
          
          if (attempt < retries) {
            this.logger.warn(`Rate limited, retrying after ${waitTime}ms (attempt ${attempt}/${retries})`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            continue;
          }
        }

        // Extract error text from response
        let errorText: string | undefined;
        if (!response.ok) {
          if (data && !data.success && data.errors) {
            // Cloudflare API error format
            errorText = JSON.stringify(data.errors);
          } else {
            // Non-JSON or other error
            errorText = responseText || `HTTP ${response.status}`;
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          data,
          errorText,
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          if (attempt < retries) {
            this.logger.warn(`API request timed out, retrying (attempt ${attempt}/${retries})`);
            await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY * Math.pow(2, attempt)));
            continue;
          }
          return { ok: false, status: 0, errorText: 'Request timeout' };
        }

        if (attempt < retries) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          this.logger.warn(`API call failed, retrying after ${delay}ms (attempt ${attempt}/${retries}): ${error}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    return { ok: false, status: 0, errorText: 'Max retries exceeded' };
  }

  /**
   * Get current tunnel configuration with caching
   * Returns null if tunnel has no configuration (404), which we'll handle by creating one
   */
  public async getTunnelConfig(tunnelId?: string): Promise<TunnelConfig | null> {
    const credentials = tunnelId ? this.getOrgApiCredentials(tunnelId) : this.getApiCredentials();
    if (!credentials) {
      return null;
    }

    const cacheKey = tunnelId || credentials.tunnelId;
    const cached = this.configCache.get(cacheKey);
    const now = Date.now();

    // Return cached config if still valid
    if (cached && now - cached.timestamp < CONFIG_CACHE_TTL) {
      this.logger.debug(`Using cached tunnel config for ${cacheKey}`);
      return cached.config;
    }

    try {
      const url = `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${credentials.tunnelId}/configurations`;
      const result = await this.makeApiCall<{ config: TunnelConfig }>(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (result.status === 404) {
        // Tunnel exists but has no configuration yet - this is okay, we'll create one
        this.logger.debug('Tunnel has no configuration yet, will create initial config');
        return null;
      }

      if (!result.ok || !result.data) {
        this.logger.error(`Failed to get tunnel config: ${result.status} ${result.errorText || 'Unknown error'}`);
        return null;
      }

      if (!result.data.success) {
        // Check if it's the "configuration not found" error
        if (result.data.errors?.some((err) => err.code === 1055)) {
          this.logger.debug('Tunnel has no configuration yet, will create initial config');
          return null;
        }
        this.logger.error(`Cloudflare API error: ${JSON.stringify(result.data.errors)}`);
        return null;
      }

      const tunnelConfig = result.data.result.config;
      
      // Cache the config
      this.configCache.set(cacheKey, {
        config: tunnelConfig,
        timestamp: now,
      });

      return tunnelConfig;
    } catch (error) {
      this.logger.error(`Error getting tunnel config: ${error}`);
      return null;
    }
  }

  /**
   * Invalidate cached config for a tunnel
   */
  private invalidateConfigCache(tunnelId?: string): void {
    if (tunnelId) {
      this.configCache.delete(tunnelId);
    } else {
      const credentials = this.getApiCredentials();
      if (credentials) {
        this.configCache.delete(credentials.tunnelId);
      }
    }
  }

  /**
   * Update tunnel configuration with caching invalidation
   */
  private async updateTunnelConfig(config: TunnelConfig, tunnelId?: string): Promise<boolean> {
    const credentials = tunnelId ? this.getOrgApiCredentials(tunnelId) : this.getApiCredentials();
    if (!credentials) {
      return false;
    }

    try {
      const url = `${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel/${credentials.tunnelId}/configurations`;
      const result = await this.makeApiCall<{ config: TunnelConfig }>(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config }),
      });

      if (!result.ok) {
        const errorDetails = result.errorText || result.data?.errors ? JSON.stringify(result.data?.errors) : 'Unknown error';
        this.logger.error(`Failed to update tunnel config: ${result.status} - ${errorDetails}`);
        if (result.data?.errors) {
          this.logger.error(`Cloudflare API error details: ${JSON.stringify(result.data.errors, null, 2)}`);
          
          // Check if error is due to catch-all route ordering (error code 1056)
          const isCatchAllError = result.data.errors.some(
            (err: { code: number; message: string }) => 
              err.code === 1056 && err.message?.includes('catch-all') || err.message?.includes('hostname')
          );
          
          if (isCatchAllError) {
            this.logger.warn('Detected catch-all route ordering issue. Attempting automatic cleanup...');
            const cleanupResult = await this.removeCatchAllRoutes(tunnelId);
            if (cleanupResult.success && cleanupResult.removed > 0) {
              this.logger.info(`Automatically removed ${cleanupResult.removed} catch-all route(s). Please retry route creation.`);
            }
          }
        }
        return false;
      }

      if (!result.data || !result.data.success) {
        const errorDetails = result.data?.errors ? JSON.stringify(result.data.errors) : 'No response data';
        this.logger.error(`Cloudflare API error: ${errorDetails}`);
        return false;
      }

      // Invalidate cache after successful update
      this.invalidateConfigCache(tunnelId || credentials.tunnelId);

      return true;
    } catch (error) {
      this.logger.error(`Error updating tunnel config: ${error}`);
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

        const response = await fetch(`${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records`, {
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
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`❌ Failed to create DNS record (attempt ${attempt}/${retries}): HTTP ${response.status}`);
          this.logger.error(`   Hostname: ${hostname}`);
          this.logger.error(`   Target: ${cnameTarget}`);
          this.logger.error(`   Zone ID: ${credentials.zoneId}`);
          this.logger.error(`   Response: ${errorText}`);
          
          // Check for common HTTP errors
          if (response.status === 403) {
            this.logger.error(`   ❌ 403 Forbidden: API token may lack DNS write permissions or zone access`);
          } else if (response.status === 404) {
            this.logger.error(`   ❌ 404 Not Found: Zone ID may be incorrect. Verify CLOUDFLARE_ZONE_ID matches the zone for ${hostname.split('.').slice(-2).join('.')}`);
          } else if (response.status === 400) {
            this.logger.error(`   ❌ 400 Bad Request: Check DNS record format (name: ${hostname}, content: ${cnameTarget})`);
          }
          
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            continue;
          }
          return false;
        }

        const data = (await response.json()) as CloudflareApiResponse<DnsRecord>;

        if (!data.success) {
          // Log the full error response for debugging
          this.logger.error(`❌ Cloudflare DNS API returned success=false (attempt ${attempt}/${retries})`);
          this.logger.error(`   Hostname: ${hostname}`);
          this.logger.error(`   Target: ${cnameTarget}`);
          this.logger.error(`   Errors: ${JSON.stringify(data.errors, null, 2)}`);
          
          // Check if error is "record already exists" - that's actually okay
          const alreadyExists = data.errors?.some((e) => e.code === 81057 || e.message?.includes('already exists'));
          if (alreadyExists) {
            this.logger.debug(`DNS record for ${hostname} already exists (confirmed by API)`);
            return true;
          }
          
          // Check for common error codes
          const invalidZone = data.errors?.some((e) => e.code === 1004 || e.message?.includes('zone'));
          if (invalidZone) {
            this.logger.error(`❌ Invalid zone ID. Check CLOUDFLARE_ZONE_ID matches the zone for ${hostname.split('.').slice(-2).join('.')}`);
          }
          
          const permissionError = data.errors?.some((e) => e.code === 1003 || e.message?.includes('permission'));
          if (permissionError) {
            this.logger.error(`❌ API token lacks DNS write permissions. Check CLOUDFLARE_API_TOKEN permissions.`);
          }
          
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            continue;
          }
          return false;
        }

        this.logger.info(`Created DNS CNAME record: ${hostname} -> ${cnameTarget}`);

        // Verify the record was created by fetching it back
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Brief delay for propagation
        const verifyRecord = await this.getDnsRecord(hostname);
        if (!verifyRecord) {
          this.logger.error(`❌ DNS record creation reported success but verification failed for ${hostname}. The record may not exist.`);
          this.logger.error(`   Expected CNAME: ${hostname} -> ${cnameTarget}`);
          this.logger.error(`   Check Cloudflare dashboard to verify the DNS record was created.`);
        } else {
          if (verifyRecord.content !== cnameTarget) {
            this.logger.error(`❌ DNS record exists but points to wrong target: ${verifyRecord.content} (expected: ${cnameTarget})`);
          } else {
            this.logger.info(`✅ Verified DNS CNAME record: ${hostname} -> ${verifyRecord.content} (proxied: ${verifyRecord.proxied})`);
          }
        }

        return true;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.logger.warn(`Cloudflare DNS API request timed out (attempt ${attempt}/${retries})`);
        } else {
          this.logger.error(`Error creating DNS record (attempt ${attempt}/${retries}): ${error}`);
        }
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Get a DNS record by hostname (public method for verification)
   */
  public async getDnsRecord(hostname: string): Promise<DnsRecord | null> {
    const credentials = this.getApiCredentials();
    if (!credentials || !credentials.zoneId) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&type=CNAME`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as CloudflareApiResponse<DnsRecord[]>;

      if (!data.success || !data.result || data.result.length === 0) {
        return null;
      }

      return data.result[0] ?? null;
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

      const response = await fetch(`${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as CloudflareApiResponse<Array<{ id: string; name: string }>>;

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
      }
      // DNS not enabled, only check tunnel name
      return {
        available: tunnelNameAvailable,
        dnsAvailable: true, // Assume available if DNS not managed
        tunnelNameAvailable,
        hostname,
        tunnelName,
        errors,
      };
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

      const response = await fetch(`${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records/${record.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to delete DNS record: ${response.status} ${errorText}`);
        return false;
      }

      const data = (await response.json()) as CloudflareApiResponse<{ id: string }>;

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
   * Routes directly to the app's exposed port on localhost
   * Also creates DNS CNAME record if CLOUDFLARE_ZONE_ID is set
   * Uses organization-specific tunnel if organization is registered
   * @param subdomain - The subdomain (e.g., "ghost")
   * @param port - The port where the app is exposed on localhost
   * @param organizationInfo - Optional organization info (if provided, uses org-specific tunnel)
   * @returns true if successful, false otherwise
   */
  public async createAppRoute(subdomain: string, port?: number, organizationInfo?: { tunnelId: string; domain: string } | null): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // If organization info is provided, use organization-specific tunnel
    if (organizationInfo) {
      this.logger.info(`Creating app route for organization: ${subdomain} on tunnel ${organizationInfo.tunnelId}`);
      return this.createAppRouteForOrganization(subdomain, organizationInfo.domain, organizationInfo.tunnelId, port);
    }

    // Get DOMAIN from config (public domain like companionintel.com)
    // Cloudflare Tunnel routes should use the public domain for internet access
    // localDomain is for local network access only
    // Default to companionintel.com if not configured
    const domain = this.config.get('userSettings').domain || process.env.DOMAIN || 'companionintel.com';
    const hostname = `${subdomain}.${domain}`;

    // Deduplicate concurrent requests for the same hostname
    const operationKey = `create-route-${hostname}`;
    if (this.pendingOperations.has(operationKey)) {
      this.logger.debug(`Deduplicating concurrent route creation for ${hostname}`);
      return (await this.pendingOperations.get(operationKey)) as Promise<boolean>;
    }

    const operation = this.createAppRouteInternal(subdomain, port, domain, hostname);
    this.pendingOperations.set(operationKey, operation);

    try {
      return await operation;
    } finally {
      this.pendingOperations.delete(operationKey);
    }
  }

  private async createAppRouteInternal(subdomain: string, port: number | undefined, domain: string, hostname: string): Promise<boolean> {
    this.logger.info(`Creating Cloudflare Tunnel route and DNS for ${hostname} (subdomain: ${subdomain}, domain: ${domain})`);

    // Verify credentials are available (already checked in isEnabled(), but double-check for better error messages)
    const credsCheck = this.getApiCredentials();
    if (!credsCheck) {
      this.logger.error('❌ Cloudflare credentials not available. Check CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_TUNNEL_ID environment variables.');
      return false;
    }

    this.logger.debug(`Using tunnel ID: ${credsCheck.tunnelId}, account ID: ${credsCheck.accountId}, DNS enabled: ${!!credsCheck.zoneId}`);

    // Validate port is provided
    if (!port) {
      this.logger.error(`❌ Cannot create route for ${hostname} - port is required`);
      return false;
    }

    // Route directly to the app's exposed port on localhost
    // Cloudflare Tunnel runs on the host and connects to apps via their exposed host ports
    const serviceUrl = `http://localhost:${port}`;

    let currentConfig = await this.getTunnelConfig();

    // If tunnel has no configuration, create an empty one
    if (!currentConfig) {
      this.logger.info('Creating initial tunnel configuration');
      currentConfig = {
        ingress: [],
      };
      // Create the initial configuration
      const created = await this.updateTunnelConfig(currentConfig);
      if (!created) {
        this.logger.error('Failed to create initial tunnel configuration');
        return false;
      }
    }

    // Check if route already exists (matching hostname)
    const existingRoute = currentConfig.ingress.find((rule) => rule.hostname === hostname);

    if (existingRoute) {
      // Update existing route if service URL changed or if originRequest exists (we want to remove it)
      const needsUpdate = existingRoute.service !== serviceUrl || !!existingRoute.originRequest;

      if (needsUpdate) {
        existingRoute.service = serviceUrl;
        // Remove originRequest if it exists (we don't want any origin request configuration)
        delete existingRoute.originRequest;
        const success = await this.updateTunnelConfig(currentConfig);
        if (success) {
          this.logger.info(`Updated Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
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
        if (credentials?.zoneId) {
          this.logger.warn(
            `⚠️  Failed to create DNS CNAME record for ${hostname}. ` +
              'The tunnel route exists, but the app may not be accessible until the DNS record is created.',
          );
        } else {
          this.logger.warn(
            `⚠️  DNS record not created for ${hostname}. Set CLOUDFLARE_ZONE_ID environment variable to enable automatic DNS management.`,
          );
        }
      }
      return true;
    }

    // Create new ingress rule without originRequest (direct routing)
    const newRule: TunnelIngressRule = {
      hostname: hostname,
      service: serviceUrl,
    };

    // Add the new rule to the ingress array
    // Remove any existing route with the same hostname first (shouldn't happen, but be safe)
    // Separate routes with hostnames from catch-all routes (no hostname)
    // Cloudflare requires catch-all routes to be LAST in the array
    const routesWithHostname = currentConfig.ingress.filter((rule) => rule.hostname && rule.hostname !== hostname);
    const catchAllRoutes = currentConfig.ingress.filter((rule) => !rule.hostname);
    
    // Build the properly ordered ingress array: specific routes first, then catch-all routes
    currentConfig.ingress = [...routesWithHostname, newRule, ...catchAllRoutes];

    // Create the tunnel route first
    const routeCreated = await this.updateTunnelConfig(currentConfig);

    if (!routeCreated) {
      this.logger.error(`❌ Failed to create Cloudflare Tunnel route for ${hostname}`);
      // Still try to create DNS record in case route creation partially succeeded
      const dnsCreated = await this.createDnsRecord(hostname);
      if (dnsCreated) {
        this.logger.info(`✅ DNS CNAME record created successfully for ${hostname} (route creation failed but DNS created)`);
      }
      return false;
    }

    this.logger.info(`✅ Created Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
    this.logger.info(`   Route details: hostname=${hostname}, service=${serviceUrl}, httpHostHeader=${hostname}`);
    this.logger.info(`   ⚠️  IMPORTANT: Ensure the tunnel daemon (cloudflared) is running and has reloaded the configuration`);
    this.logger.info(`   ⚠️  IMPORTANT: Verify port ${port} is exposed on localhost (check docker-compose ports mapping)`);

    // Create DNS CNAME record - this is CRITICAL for the app to be accessible
    // We treat DNS creation as a required step, not optional
    const dnsCreated = await this.createDnsRecord(hostname);
    if (dnsCreated) {
      this.logger.info(`✅ DNS CNAME record created successfully for ${hostname}`);
      return true;
    }

    // DNS creation failed - log error but route was created
    const credentials = this.getApiCredentials();
    if (credentials?.zoneId) {
      // DNS creation failed even though zone ID is set - this is a problem
      this.logger.error(
        `❌ Failed to create DNS CNAME record for ${hostname} after multiple retries. ` +
          'The tunnel route was created, but the app will NOT be accessible until the DNS record is created. ' +
          'Try calling syncMissingDnsRecords() to retry DNS creation.',
      );
    } else {
      this.logger.warn(
        `⚠️  DNS record not created for ${hostname}. ` +
          'Set CLOUDFLARE_ZONE_ID environment variable to enable automatic DNS management. ' +
          `You may need to manually create a CNAME record: ${hostname} -> ${credentials?.tunnelId || '<tunnel-id>'}.cfargotunnel.com`,
      );
    }

    // Return true because route was created successfully, even if DNS failed
    // DNS can be created later via syncMissingDnsRecords()
    return true;
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
        continue; // Skip routes without hostnames (shouldn't exist, but be defensive)
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
      await new Promise((resolve) => setTimeout(resolve, 500));
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
   * Remove originRequest configuration from all existing tunnel routes
   * We don't want any origin request headers or settings
   * @returns Object with updated routes, skipped routes, and any errors
   */
  public async removeOriginRequestFromAllRoutes(): Promise<{
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

    // Update all routes that have hostnames
    for (const rule of currentConfig.ingress) {
      if (!rule.hostname) {
        continue; // Skip routes without hostnames (shouldn't exist, but be defensive)
      }

      // Remove originRequest if it exists
      if (rule.originRequest) {
        delete rule.originRequest;
        updated.push(rule.hostname);
        needsUpdate = true;
      } else {
        skipped.push(rule.hostname);
      }
    }

    if (!needsUpdate) {
      this.logger.info('All routes already have no originRequest configuration');
      return { updated: [], skipped, failed: [] };
    }

    // Update the tunnel configuration
    const success = await this.updateTunnelConfig(currentConfig);
    if (!success) {
      this.logger.error('Failed to update tunnel configuration to remove originRequest settings');
      return { updated: [], skipped, failed: updated };
    }

    this.logger.info(
      `Removed originRequest from ${updated.length} routes. ${skipped.length} routes already had no originRequest configuration.`,
    );

    return { updated, skipped, failed: [] };
  }

  public async deleteAppRoute(subdomain: string, organizationInfo?: { tunnelId: string; domain: string } | null): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    // If organization info is provided, use organization-specific tunnel
    if (organizationInfo) {
      return this.deleteAppRouteForOrganization(subdomain, organizationInfo.domain, organizationInfo.tunnelId);
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
    currentConfig.ingress = currentConfig.ingress.filter((rule) => rule.hostname !== hostname);

    const success = await this.updateTunnelConfig(currentConfig);

    if (success) {
      this.logger.info(`Deleted Cloudflare Tunnel route for ${hostname}`);

      // Also delete DNS CNAME record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (dnsDeleted) {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      } else {
        const credentials = this.getApiCredentials();
        if (credentials?.zoneId) {
          this.logger.warn(`⚠️  Failed to delete DNS CNAME record for ${hostname}. You may need to delete it manually.`);
        } else {
          this.logger.debug(`DNS record deletion skipped for ${hostname} (CLOUDFLARE_ZONE_ID not set)`);
        }
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
      const response = await fetch(`${this.apiBaseUrl}/accounts/${credentials.accountId}/cfd_tunnel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `hub-${orgName}`,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to create organization tunnel: ${response.status} ${errorText}`);
        return null;
      }

      const data = (await response.json()) as CloudflareApiResponse<{ id: string; name: string }>;

      if (!data.success) {
        this.logger.error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
        return null;
      }

      const tunnelId = data.result.id;
      this.logger.info(`Created Cloudflare Tunnel for organization ${orgName}: ${tunnelId}`);

      // Now set the tunnel configuration (empty initial config, routes will be added as apps are installed)
      const tunnelConfig: TunnelConfig = {
        ingress: [],
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
        const updateResponse = await fetch(`${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records/${existingRecord.id}`, {
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
        });

        clearTimeout(timeoutId);

        if (updateResponse.ok) {
          this.logger.info(`Updated DNS CNAME record: ${orgDomain} -> ${cnameTarget}`);
          return true;
        }
      }

      // Create new DNS record
      const response = await fetch(`${this.apiBaseUrl}/zones/${credentials.zoneId}/dns_records`, {
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
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Failed to create DNS record: ${response.status} ${errorText}`);
        return false;
      }

      const data = (await response.json()) as CloudflareApiResponse<DnsRecord>;

      if (!data.success) {
        const alreadyExists = data.errors?.some((e) => e.code === 81057 || e.message?.includes('already exists'));
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
   * Get tunnel configuration for a specific tunnel ID (with caching)
   */
  public async getTunnelConfigForTunnel(tunnelId: string): Promise<TunnelConfig | null> {
    return this.getTunnelConfig(tunnelId);
  }

  /**
   * Update tunnel configuration for a specific tunnel ID (with cache invalidation)
   */
  public async updateTunnelConfigForTunnel(tunnelId: string, config: TunnelConfig): Promise<boolean> {
    return this.updateTunnelConfig(config, tunnelId);
  }

  /**
   * Create an app route using organization-specific tunnel
   * @param subdomain - App subdomain (e.g., "ghost")
   * @param orgDomain - Organization domain (e.g., "acme-corp.companionintel.com")
   * @param tunnelId - Organization tunnel ID
   * @returns true if successful, false otherwise
   */
  public async createAppRouteForOrganization(subdomain: string, orgDomain: string, tunnelId: string, port?: number): Promise<boolean> {
    if (!this.isEnabled()) {
      this.logger.debug('Cloudflare Tunnel integration is not enabled');
      return false;
    }

    if (!port) {
      this.logger.error(`Cannot create route for organization app - port is required`);
      return false;
    }

    const hostname = `${subdomain}.${orgDomain}`;
    const serviceUrl = `http://localhost:${port}`;

    let currentConfig = await this.getTunnelConfigForTunnel(tunnelId);

    if (!currentConfig) {
      this.logger.info(`Creating initial tunnel configuration for organization tunnel ${tunnelId}`);
      currentConfig = {
        ingress: [],
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
      // Update existing route if service URL changed or if originRequest exists (we want to remove it)
      const needsUpdate = existingRoute.service !== serviceUrl || !!existingRoute.originRequest;
      if (needsUpdate) {
        existingRoute.service = serviceUrl;
        // Remove originRequest if it exists (we don't want any origin request configuration)
        delete existingRoute.originRequest;
        const success = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);
        if (success) {
          this.logger.info(`Updated Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);
        }
        return success;
      }
      this.logger.debug(`Route for hostname ${hostname} already exists`);
      return true;
    }

    // Create new ingress rule without originRequest (direct routing)
    const newRule: TunnelIngressRule = {
      hostname: hostname,
      service: serviceUrl,
    };

    // Add the new rule to the ingress array
    // Remove any existing route with the same hostname first (shouldn't happen, but be safe)
    // Separate routes with hostnames from catch-all routes (no hostname)
    // Cloudflare requires catch-all routes to be LAST in the array
    const routesWithHostname = currentConfig.ingress.filter((rule) => rule.hostname && rule.hostname !== hostname);
    const catchAllRoutes = currentConfig.ingress.filter((rule) => !rule.hostname);
    
    // Build the properly ordered ingress array: specific routes first, then catch-all routes
    currentConfig.ingress = [...routesWithHostname, newRule, ...catchAllRoutes];

    // Create the tunnel route first
    const routeCreated = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);

    if (!routeCreated) {
      this.logger.error(`❌ Failed to create Cloudflare Tunnel route for ${hostname}`);
      // Still try to create DNS record in case route creation partially succeeded
      const dnsCreated = await this.createDnsRecord(hostname);
      if (dnsCreated) {
        this.logger.info(`✅ DNS CNAME record created successfully for ${hostname} (route creation failed but DNS created)`);
      }
      return false;
    }

    this.logger.info(`✅ Created Cloudflare Tunnel route for ${hostname} -> ${serviceUrl}`);

    // Create DNS CNAME record - this is CRITICAL for the app to be accessible
    const dnsCreated = await this.createDnsRecord(hostname);
    if (dnsCreated) {
      this.logger.info(`✅ DNS CNAME record created successfully for ${hostname}`);
      return true;
    }

    // DNS creation failed - log error but route was created
    const credentials = this.getApiCredentials();
    if (credentials?.zoneId) {
      this.logger.error(
        `❌ Failed to create DNS CNAME record for ${hostname} after multiple retries. ` +
          'The tunnel route was created, but the app will NOT be accessible until the DNS record is created.',
      );
    } else {
      this.logger.warn(
        `⚠️  DNS record not created for ${hostname}. ` +
          'Set CLOUDFLARE_ZONE_ID environment variable to enable automatic DNS management.',
      );
    }

    // Return true because route was created successfully, even if DNS failed
    return true;
  }

  /**
   * Delete an app route from organization-specific tunnel
   * @param subdomain - App subdomain (e.g., "ghost")
   * @param orgDomain - Organization domain (e.g., "acme-corp.companionintel.com")
   * @param tunnelId - Organization tunnel ID
   * @returns true if successful, false otherwise
   */
  public async deleteAppRouteForOrganization(subdomain: string, orgDomain: string, tunnelId: string): Promise<boolean> {
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
    currentConfig.ingress = currentConfig.ingress.filter((rule) => rule.hostname !== hostname);

    const success = await this.updateTunnelConfigForTunnel(tunnelId, currentConfig);

    if (success) {
      this.logger.info(`Deleted Cloudflare Tunnel route for ${hostname} from organization tunnel`);

      // Also delete DNS CNAME record
      const dnsDeleted = await this.deleteDnsRecord(hostname);
      if (dnsDeleted) {
        this.logger.info(`✅ DNS CNAME record deleted successfully for ${hostname}`);
      } else {
        const credentials = this.getApiCredentials();
        if (credentials?.zoneId) {
          this.logger.warn(`⚠️  Failed to delete DNS CNAME record for ${hostname}. You may need to delete it manually.`);
        } else {
          this.logger.debug(`DNS record deletion skipped for ${hostname} (CLOUDFLARE_ZONE_ID not set)`);
        }
      }
    } else {
      this.logger.error(`Failed to delete Cloudflare Tunnel route for ${hostname}`);
    }

    return success;
  }

  /**
   * Remove all catch-all routes (routes without hostnames) from tunnel configuration
   * Catch-all routes must be last in the ingress array, and we don't use them anymore
   * @param tunnelId - Optional tunnel ID (if not provided, uses default tunnel)
   * @returns Object with information about removed routes
   */
  public async removeCatchAllRoutes(tunnelId?: string): Promise<{
    success: boolean;
    removed: number;
    remainingRoutes: number;
    message: string;
  }> {
    if (!this.isEnabled()) {
      return {
        success: false,
        removed: 0,
        remainingRoutes: 0,
        message: 'Cloudflare Tunnel integration is not enabled',
      };
    }

    const config = tunnelId ? await this.getTunnelConfigForTunnel(tunnelId) : await this.getTunnelConfig();
    
    if (!config || !config.ingress || config.ingress.length === 0) {
      return {
        success: true,
        removed: 0,
        remainingRoutes: 0,
        message: 'No tunnel configuration found or configuration is empty',
      };
    }

    // Find catch-all routes (routes without hostnames)
    const catchAllRoutes = config.ingress.filter((rule) => !rule.hostname);
    const routesWithHostname = config.ingress.filter((rule) => rule.hostname);

    if (catchAllRoutes.length === 0) {
      return {
        success: true,
        removed: 0,
        remainingRoutes: routesWithHostname.length,
        message: 'No catch-all routes found in tunnel configuration',
      };
    }

    // Remove catch-all routes
    config.ingress = routesWithHostname;

    // Update the tunnel configuration
    const success = tunnelId 
      ? await this.updateTunnelConfigForTunnel(tunnelId, config)
      : await this.updateTunnelConfig(config);

    if (success) {
      this.logger.info(`Removed ${catchAllRoutes.length} catch-all route(s) from tunnel ${tunnelId || 'default'}`);
      catchAllRoutes.forEach((route) => {
        this.logger.debug(`Removed catch-all route: ${route.service}`);
      });

      return {
        success: true,
        removed: catchAllRoutes.length,
        remainingRoutes: routesWithHostname.length,
        message: `Successfully removed ${catchAllRoutes.length} catch-all route(s). ${routesWithHostname.length} specific route(s) remaining.`,
      };
    }

    return {
      success: false,
      removed: 0,
      remainingRoutes: config.ingress.length,
      message: 'Failed to update tunnel configuration',
    };
  }
}
