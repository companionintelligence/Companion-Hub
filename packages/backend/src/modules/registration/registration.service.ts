import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareTunnelService } from '../cloudflare/cloudflare-tunnel.service';
import { OrganizationRepository } from './organization.repository';
import si from 'systeminformation';

@Injectable()
export class RegistrationService implements OnApplicationBootstrap {
  private _isRegistered = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly cloudflareTunnelService: CloudflareTunnelService,
    private readonly organizationRepository: OrganizationRepository,
  ) {}

  async onApplicationBootstrap() {
    // Only start polling if organization ID is already configured
    const { ciHubOrganizationId } = this.config.getConfig();
    if (ciHubOrganizationId) {
      // Start polling for registration
      this.pollRegistration();
    } else {
      this.logger.debug('No organization ID configured, waiting for manual registration');
    }
  }

  public async getDeviceId(): Promise<string> {
    if (process.env.NODE_ENV === 'development') {
      return 'test-device-id';
    }
    return (await si.uuid()).hardware;
  }

  public async isRegistered(): Promise<boolean> {
    // If already registered, return true immediately
    if (this._isRegistered) {
      return true;
    }
    
    // Check if we have any organization in the database (indicates successful registration)
    try {
      const hasOrg = await this.organizationRepository.hasAnyOrganization();
      if (hasOrg) {
        this._isRegistered = true;
        return true;
      }
    } catch (error) {
      // Database might not be ready, ignore error
      this.logger.debug('Could not check organization in database:', error);
    }
    
    return this._isRegistered;
  }

  private async pollRegistration() {
    this.logger.info('Starting registration check loop...');

    const check = async () => {
      if (this._isRegistered) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        return;
      }

      try {
        const registered = await this.checkRegistrationWithCloud();
        if (registered) {
          this._isRegistered = true;
          this.logger.info('Device successfully registered!');
          if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
          }
        } else {
          this.logger.debug('Device not yet registered, retrying in 1s...');
        }
      } catch (error) {
        this.logger.error('Error checking registration status:', error);
      }
    };

    // Initial check
    await check();

    // Start interval if not registered
    if (!this._isRegistered) {
      this.checkInterval = setInterval(check, 1000);
    }
  }

  private async checkRegistrationWithCloud(): Promise<boolean> {
    const { ciCloudApiUrl, ciHubOrganizationId, ciHubApiKey, ciCloudAppStoreUrl } = this.config.getConfig();

    // If CI Cloud API is not configured, allow access (backward compatibility)
    if (!ciCloudApiUrl) {
      this.logger.debug('CI Cloud API not configured, skipping registration check.');
      return true;
    }
    
    // If organization ID is not configured, don't try to register
    if (!ciHubOrganizationId) {
      return false;
    }

    try {
      const deviceId = await this.getDeviceId();
      
      // Step 1: Register device with CI Cloud Hub API
      const registerUrl = `${ciCloudApiUrl}/api/devices/hub/register`;
      
      this.logger.debug(`Registering device at ${registerUrl} for device ${deviceId}`);

      const registerHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (ciHubApiKey) {
        registerHeaders['Authorization'] = `Bearer ${ciHubApiKey}`;
      }

      const registerResponse = await fetch(registerUrl, {
        method: 'POST',
        headers: registerHeaders,
        body: JSON.stringify({
          device_id: deviceId,
          organization_id: ciHubOrganizationId,
          description: `CI OS Hub Device - ${deviceId}`,
        }),
      });

      if (!registerResponse.ok) {
        const errorData = await registerResponse.json().catch(() => ({ error: 'Unknown error' }));
        this.logger.warn(`Device registration failed: ${registerResponse.status} - ${errorData.error || registerResponse.statusText}`);
        
        // If device already exists (409 or similar), try to activate it
        if (registerResponse.status === 409 || registerResponse.status === 400) {
          this.logger.debug('Device may already be registered, attempting activation...');
        } else {
          return false;
        }
      } else {
        const result = await registerResponse.json();
        this.logger.info(`Device registered successfully: ${result.device_id} (status: ${result.status})`);
      }

      // Step 2: Activate device by calling /api/web/register
      // Use ciCloudAppStoreUrl if available, otherwise derive from ciCloudApiUrl
      let activateUrl: string;
      if (ciCloudAppStoreUrl) {
        const urlObj = new URL(ciCloudAppStoreUrl);
        activateUrl = new URL('/api/web/register', urlObj.origin).toString();
      } else {
        activateUrl = `${ciCloudApiUrl}/api/web/register`;
      }

      this.logger.debug(`Activating device at ${activateUrl} for device ${deviceId}`);

      const activateResponse = await fetch(activateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_id: deviceId }),
      });

      if (activateResponse.status === 200) {
        this.logger.info('Device activated successfully!');
        
        // Step 3: Fetch organization details and setup infrastructure
        const activateResult = await activateResponse.json().catch(() => ({}));
        await this.setupOrganizationInfrastructure(ciHubOrganizationId, activateResult);
        
        return true;
      }

      this.logger.warn(`Device activation failed: ${activateResponse.status} - ${activateResponse.statusText}`);
      return false;
    } catch (error) {
      this.logger.error('Failed to contact cloud server for registration:', error);
      return false;
    }
  }

  /**
   * Setup Cloudflare tunnel and DNS for the organization
   * Creates organization subdomain: {orgName}.companionintel.com
   * @param organizationId - Organization ID from CI Cloud
   * @param activationResult - Result from device activation (may contain org details)
   */
  private async setupOrganizationInfrastructure(
    organizationId: string,
    activationResult?: { organization_name?: string; tunnel_id?: string; [key: string]: unknown },
  ): Promise<void> {
    // Check if organization infrastructure already exists
    const existingOrg = await this.organizationRepository.getOrganizationById(organizationId);
    if (existingOrg) {
      this.logger.debug(`Organization infrastructure already exists for ${organizationId}`);
      return;
    }

    // Check if Cloudflare is enabled
    if (!this.cloudflareTunnelService.isEnabled() || !this.cloudflareTunnelService.isDnsEnabled()) {
      this.logger.warn('Cloudflare Tunnel or DNS management not enabled, skipping organization infrastructure setup');
      return;
    }

    try {
      const { ciCloudApiUrl, ciHubApiKey } = this.config.getConfig();

      // Try to fetch organization details from CI Cloud API
      let orgName: string | null = null;
      let tunnelId: string | null = null;

      // First, check if activation result contains organization info
      if (activationResult?.organization_name) {
        orgName = activationResult.organization_name;
        this.logger.debug(`Using organization name from activation result: ${orgName}`);
      }

      if (activationResult?.tunnel_id) {
        tunnelId = activationResult.tunnel_id;
        this.logger.debug(`Using tunnel ID from activation result: ${tunnelId}`);
      }

      // If not in activation result, try to fetch from CI Cloud API
      if (!orgName && ciCloudApiUrl) {
        try {
          const orgUrl = `${ciCloudApiUrl}/api/organizations/${organizationId}`;
          const orgHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          if (ciHubApiKey) {
            orgHeaders['Authorization'] = `Bearer ${ciHubApiKey}`;
          }

          const orgResponse = await fetch(orgUrl, {
            method: 'GET',
            headers: orgHeaders,
          });

          if (orgResponse.ok) {
            const orgData = await orgResponse.json();
            orgName = orgData.name || orgData.organization_name || null;
            tunnelId = orgData.tunnel_id || null;
            this.logger.debug(`Fetched organization details: name=${orgName}, tunnelId=${tunnelId}`);
          } else {
            this.logger.debug(`Could not fetch organization details (${orgResponse.status}), will use slugified ID`);
          }
        } catch (error) {
          this.logger.debug(`Error fetching organization details: ${error}`);
        }
      }

      // Fallback to slugified organization ID if name not available
      if (!orgName) {
        orgName = this.slugifyOrganizationId(organizationId);
        this.logger.debug(`Using slugified organization ID as name: ${orgName}`);
      }

      const orgDomain = `${orgName}.companionintel.com`;

      // Create tunnel if not provided
      if (!tunnelId) {
        this.logger.info(`Creating Cloudflare Tunnel for organization: ${orgDomain}`);
        tunnelId = await this.cloudflareTunnelService.createOrganizationTunnel(orgName);
        if (!tunnelId) {
          this.logger.error(`Failed to create Cloudflare Tunnel for organization ${organizationId}`);
          return;
        }
      } else {
        this.logger.info(`Using existing tunnel ID for organization: ${tunnelId}`);
        // Verify tunnel exists and configure it if needed
        const tunnelConfig = await this.cloudflareTunnelService.getTunnelConfigForTunnel(tunnelId);
        if (!tunnelConfig) {
          // Tunnel exists but has no config, set it up
          const config = {
            ingress: [
              {
                service: 'http://localhost:80',
                originRequest: {
                  httpHostHeader: orgDomain,
                },
              },
            ],
          };
          await this.cloudflareTunnelService.updateTunnelConfigForTunnel(tunnelId, config);
        }
      }

      // Create DNS record for organization domain
      const dnsCreated = await this.cloudflareTunnelService.createOrganizationDnsRecord(orgDomain, tunnelId);
      if (!dnsCreated) {
        this.logger.error(`Failed to create DNS record for ${orgDomain}`);
        // Continue anyway - tunnel is created, DNS can be retried later
      }

      // Store organization info in database
      await this.organizationRepository.createOrganization({
        id: organizationId,
        name: orgName,
        tunnelId: tunnelId,
        domain: orgDomain,
      });

      this.logger.info(`Successfully setup organization infrastructure: ${orgDomain} (tunnel: ${tunnelId})`);
    } catch (error) {
      this.logger.error(`Error setting up organization infrastructure: ${error}`);
    }
  }

  /**
   * Convert organization ID to a valid subdomain slug
   * Removes special characters and converts to lowercase
   */
  private slugifyOrganizationId(orgId: string): string {
    return orgId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Get organization info for the current hub instance
   * Returns the first organization found (since we only support one organization per hub)
   */
  public async getOrganizationInfo() {
    // First try to get by configured organization ID
    const { ciHubOrganizationId } = this.config.getConfig();
    if (ciHubOrganizationId) {
      const org = await this.organizationRepository.getOrganizationById(ciHubOrganizationId);
      if (org) {
        return org;
      }
    }
    
    // If not found, get the first organization (from manual registration)
    // Since we only support one organization per hub, return the first one
    return this.organizationRepository.getFirstOrganization();
  }

  /**
   * Manually initiate device registration with organization
   * Called from the registration form
   */
  public async initiateRegistration(
    organizationId: string,
    organizationName: string,
  ): Promise<{ success: boolean; message: string }> {
    const { ciCloudApiUrl, ciHubApiKey } = this.config.getConfig();

    if (!ciCloudApiUrl) {
      return {
        success: false,
        message: 'CI Cloud API URL not configured. Please set CI_CLOUD_API_URL environment variable.',
      };
    }

    if (!organizationName || !organizationName.trim()) {
      return {
        success: false,
        message: 'Organization name is required.',
      };
    }

    // Sanitize organization name
    const sanitizedName = organizationName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    if (!sanitizedName) {
      return {
        success: false,
        message: 'Invalid organization name. Please use only letters, numbers, and hyphens.',
      };
    }

    try {
      // Temporarily set organization ID for this registration attempt
      // We'll store it in the database after successful registration
      const deviceId = await this.getDeviceId();

      // Step 1: Register device
      const registerUrl = `${ciCloudApiUrl}/api/devices/hub/register`;
      const registerHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (ciHubApiKey) {
        registerHeaders['Authorization'] = `Bearer ${ciHubApiKey}`;
      }

      const registerResponse = await fetch(registerUrl, {
        method: 'POST',
        headers: registerHeaders,
        body: JSON.stringify({
          device_id: deviceId,
          organization_id: organizationId,
          description: `CI OS Hub Device - ${deviceId}`,
        }),
      });

      if (!registerResponse.ok) {
        const errorData = await registerResponse.json().catch(() => ({ error: 'Unknown error' }));
        return {
          success: false,
          message: `Registration failed: ${errorData.error || registerResponse.statusText}`,
        };
      }

      // Step 2: Activate device
      const activateUrl = `${ciCloudApiUrl}/api/web/register`;
      const activateResponse = await fetch(activateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ device_id: deviceId }),
      });

      if (activateResponse.status !== 200) {
        return {
          success: false,
          message: `Activation failed: ${activateResponse.statusText}`,
        };
      }

      const activateResult = await activateResponse.json().catch(() => ({}));

      // Step 3: Validate organization name/subdomain availability before setup
      // Use provided organization name (already sanitized)
      const finalOrgName = sanitizedName;
      
      // Validate subdomain and tunnel name availability
      const validation = await this.cloudflareTunnelService.validateOrganizationSubdomain(finalOrgName);
      if (!validation.available) {
        return {
          success: false,
          message: `Registration failed: ${validation.errors.join(' ')}`,
        };
      }

      // Step 4: Setup organization infrastructure
      await this.setupOrganizationInfrastructure(organizationId, {
        ...activateResult,
        organization_name: finalOrgName,
      });

      // Mark as registered
      this._isRegistered = true;
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      // Update environment/config with organization ID for future use
      // Note: This would ideally update the .env file, but for now we'll rely on the database
      this.logger.info(`Device registered successfully with organization ${organizationId}`);

      return {
        success: true,
        message: 'Device registered and activated successfully',
      };
    } catch (error) {
      this.logger.error('Registration error:', error);
      return {
        success: false,
        message: `Registration error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}
