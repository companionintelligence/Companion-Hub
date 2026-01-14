import { Injectable, type OnApplicationBootstrap, Inject, forwardRef } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { OrganizationRepository } from './organization.repository';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import si from 'systeminformation';

@Injectable()
export class RegistrationService implements OnApplicationBootstrap {
  private _isRegistered = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => CloudflareClientService)) private readonly cloudflareClientService: CloudflareClientService,
    private readonly organizationRepository: OrganizationRepository,
    private readonly repoQueue: RepoEventsQueue,
  ) {}

  async onApplicationBootstrap() {
    // Check if we are already registered
    let isRegistered = await this.isRegistered();

    if (isRegistered) {
      // If registered, verify license with cloud
      await this.verifyLicense();
      // Re-check registration status in case license check failed and wiped it
      isRegistered = this._isRegistered;

      // Check for missing Tunnel ID and recover if needed
      if (isRegistered) {
        const org = await this.organizationRepository.getFirstOrganization();
        if (org && !org.tunnelId) {
          const { cloudflareTunnelId } = this.config.getConfig();

          if (cloudflareTunnelId) {
            this.logger.info(`Recovering Tunnel ID from environment: ${cloudflareTunnelId}`);
            await this.organizationRepository.updateOrganization(org.id, {
              tunnelId: cloudflareTunnelId,
            });
          } else {
            this.logger.warn(`Organization ${org.id} exists but Tunnel ID is missing. Attempting to recover...`);
            try {
              // Attempt to recover by re-registering/check-in with Cloud
              const { ciCloudApiUrl, ciHubApiKey } = this.config.getConfig();
              const deviceId = await this.getDeviceId();

              if (ciCloudApiUrl) {
                this.logger.info(`Attempting to recover tunnel credentials via registration endpoint for device ${deviceId}`);

                const registerUrl = `${ciCloudApiUrl}/devices/hub/register`;
                const headers: Record<string, string> = {
                  'Content-Type': 'application/json',
                };
                if (ciHubApiKey) {
                  headers.Authorization = `Bearer ${ciHubApiKey}`;
                }

                const registerResponse = await fetch(registerUrl, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    device_id: deviceId,
                    organization_id: org.id,
                    description: `CI OS Hub Device - ${deviceId} (Recovery)`,
                  }),
                });

                if (registerResponse.ok) {
                  // biome-ignore lint/suspicious/noExplicitAny: External API response
                  const data = (await registerResponse.json()) as any;

                  if (data.tunnel_id && data.tunnel_token) {
                    const tunnelCredentials = await this.cloudflareClientService.initializeTunnel(org.id, {
                      tunnelId: data.tunnel_id,
                      token: data.tunnel_token,
                    });

                    if (tunnelCredentials) {
                      await this.organizationRepository.updateOrganization(org.id, {
                        tunnelId: tunnelCredentials.tunnelId,
                        tunnelToken: tunnelCredentials.token,
                      });
                      this.logger.info(`Tunnel ID recovered successfully: ${tunnelCredentials.tunnelId}`);
                    }
                  } else {
                    this.logger.error('Failed to recover Tunnel ID: API returned success but no credentials');
                  }
                } else {
                  this.logger.error(`Failed to recover Tunnel ID: API returned ${registerResponse.status}`);
                }
              }
            } catch (err) {
              this.logger.error(`Error during tunnel recovery: ${err}`);
            }
          }
        }
      }
    }

    if (!isRegistered) {
      // Only start polling if organization ID is already configured
      const { ciHubOrganizationId } = this.config.getConfig();
      if (ciHubOrganizationId) {
        // Start polling for registration
        this.pollRegistration();
      } else {
        this.logger.debug('No organization ID configured, waiting for manual registration');
      }
    }
  }

  public async getDeviceId(): Promise<string> {
    this.logger.debug(`NODE_ENV is: ${process.env.NODE_ENV}`);
    this.logger.debug(`process.env.DEVICE_ID is: ${process.env.DEVICE_ID}`);
    if (process.env.DEVICE_ID) {
      return process.env.DEVICE_ID;
    }
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

  private async verifyLicense() {
    this.logger.info('License verification skipped (deprecated). Assuming valid registration.');
    return;
  }

  private async handleLicenseCheckFailure(orgId?: string) {
    this.logger.warn('Resetting registration due to license check failure.');
    if (orgId) {
      await this.organizationRepository.deleteOrganization(orgId);
    } else {
      const org = await this.organizationRepository.getFirstOrganization();
      if (org) {
        await this.organizationRepository.deleteOrganization(org.id);
      }
    }
    this._isRegistered = false;
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
      const registerUrl = `${ciCloudApiUrl}/devices/hub/register`;

      this.logger.debug(`Registering device at ${registerUrl} for device ${deviceId}`);

      const registerHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (ciHubApiKey) {
        registerHeaders.Authorization = `Bearer ${ciHubApiKey}`;
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

      if (registerResponse.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        const result = (await registerResponse.json()) as any;
        this.logger.info(`Device registered successfully: ${result.device_id} (status: ${result.status})`);

        if (result.api_key) {
          await this.config.setUserSettings({ ciHubApiKey: result.api_key });
          this.logger.info('Saved Hub API Key from registration response');
        }

        // Trigger repo update now that we are registered
        this.logger.debug('Triggering repository update after successful registration');
        await this.repoQueue.publish({ command: 'update_all' });

        // Setup infrastructure using the response
        await this.setupOrganizationInfrastructure(ciHubOrganizationId, result);
        return true;
      }

      // biome-ignore lint/suspicious/noExplicitAny: External API response
      const errorData = (await registerResponse.json().catch(() => ({ error: 'Unknown error' }))) as any;
      this.logger.warn(`Device registration failed: ${registerResponse.status} - ${errorData.error || registerResponse.statusText}`);
      return false;
    } catch (error) {
      this.logger.error('Failed to contact cloud server for registration:', error);
      return false;
    }
  }

  /**
   * Setup Cloudflare tunnel and DNS for the organization
   * Creates organization subdomain: {orgName}.ci.computer
   * @param organizationId - Organization ID from CI Cloud
   * @param activationResult - Result from device activation (may contain org details)
   */
  private async setupOrganizationInfrastructure(
    organizationId: string,
    activationResult: { organization_name: string; tunnel_id: string; tunnel_token: string; slug: string; subdomain: string },
  ): Promise<void> {
    // Check if organization infrastructure already exists
    const existingOrg = await this.organizationRepository.getOrganizationById(organizationId);
    if (existingOrg) {
      this.logger.debug(`Organization infrastructure already exists for ${organizationId}`);
      return;
    }

    try {
      const { ciCloudApiUrl, ciHubApiKey, cloudflareTunnelId } = this.config.getConfig();

      // Try to fetch organization details from CI Cloud API
      let orgName: string | null = null;
      let tunnelId: string | null = cloudflareTunnelId || null;
      let tunnelToken: string | null = null;
      let orgSlug: string | null = null;
      let subdomain: string | null = null;

      if (tunnelId) {
        this.logger.debug(`Using tunnel ID from environment: ${tunnelId}`);
      }

      // First, check if activation result contains organization info
      if (activationResult) {
        if (!activationResult.organization_name) {
          throw new Error('Missing organization_name in activation result');
        }
        orgName = activationResult.organization_name;
        this.logger.debug(`Using organization name from activation result: ${orgName}`);

        if (!activationResult.slug) {
          throw new Error('Missing slug in activation result');
        }
        orgSlug = activationResult.slug as string;
        this.logger.debug(`Using organization slug from activation result: ${orgSlug}`);

        if (!activationResult.tunnel_id) {
          throw new Error('Missing tunnel_id in activation result');
        }
        tunnelId = activationResult.tunnel_id;
        this.logger.debug(`Using tunnel ID from activation result: ${tunnelId}`);

        if (!activationResult.tunnel_token) {
          throw new Error('Missing tunnel_token in activation result');
        }
        tunnelToken = activationResult.tunnel_token as string;

        if (!activationResult.subdomain) {
          throw new Error('Missing subdomain in activation result');
        }
        subdomain = activationResult.subdomain as string;
        this.logger.debug(`Using subdomain from activation result: ${subdomain}`);
      }

      const domain = `${subdomain}.ci.computer`;

      // Configure tunnel using credentials from CI-Cloud
      this.logger.info(`Initializing tunnel for organization: ${organizationId}`);

      let tunnelCredentials = null;
      if (tunnelId && tunnelToken) {
        tunnelCredentials = await this.cloudflareClientService.initializeTunnel(organizationId, {
          tunnelId,
          token: tunnelToken,
        });
      }

      if (tunnelCredentials) {
        tunnelId = tunnelCredentials.tunnelId;
        tunnelToken = tunnelCredentials.token;
        this.logger.info(`Successfully initialized tunnel: ${tunnelId}`);
      } else {
        this.logger.error(`Failed to initialize tunnel for organization ${organizationId} - missing credentials`);
        this.logger.error('tunnelCredentials', tunnelCredentials);
        // We might want to abort here, but for now we'll continue and try to create the org record
        // so at least the local state is consistent, even if cloud sync failed.
      }

      // Store organization info in database
      await this.organizationRepository.createOrganization({
        id: organizationId,
        name: orgName!,
        tunnelId: tunnelId,
        tunnelToken: tunnelToken,
        domain: domain,
      });

      this.logger.info(`Successfully setup organization infrastructure: ${domain} (tunnel: ${tunnelId})`);

      // Wait for DNS resolution before returning
      // This ensures that when the user is redirected, the domain is likely working
      this.logger.info(`Waiting for DNS resolution on https://${domain}...`);
      const maxRetries = 60 * 10; // 10 minutes
      for (let i = 0; i < maxRetries; i++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          /* 
            We fetch /api/health to verify the hub itself is reachable through the tunnel.
            Using HEAD might return 404 if the route doesn't support HEAD, so we use GET.
          */
          const response = await fetch(`https://${domain}/api/health`, {
            method: 'GET',
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            this.logger.info(`DNS resolved and Hub is reachable at https://${domain}`);
            break;
          } else {
            this.logger.debug(`Hub reachable but returned status ${response.status}`);
          }
        } catch (e) {
          if (i % 10 === 0) {
            this.logger.debug(`Waiting for DNS/SSL propagation... Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (i > 0 && i % 10 === 0) this.logger.info(`Still waiting for DNS resolution... attempt ${i}/${maxRetries}`);
      }
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
   *
   * This method performs the complete registration flow:
   * 1. Registers device with CI Cloud (/api/devices/hub/register)
   * 2. Activates device (/api/web/register)
   * 3. Validates organization subdomain availability
   * 4. Creates Cloudflare tunnel and DNS records
   * 5. Stores organization info in database
   */
  public async initiateRegistration(
    organizationId: string,
    organizationName: string,
    customDeviceId?: string,
    customDescription?: string,
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
    const sanitizedName = organizationName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!sanitizedName) {
      return {
        success: false,
        message: 'Invalid organization name. Please use only letters, numbers, and hyphens.',
      };
    }

    try {
      // Get device ID (use custom if provided, otherwise auto-generate)
      const deviceId = customDeviceId?.trim() || (await this.getDeviceId());
      const description = customDescription?.trim() || `CI OS Hub Device - ${deviceId}`;

      this.logger.info(`Starting device registration: device_id=${deviceId}, organization_id=${organizationId}, organization_name=${sanitizedName}`);

      // Step 1: Register device with CI Cloud
      // POST http://localhost:8001/api/devices/hub/register
      const registerUrl = `${ciCloudApiUrl}/devices/hub/register`;
      const registerHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (ciHubApiKey) {
        registerHeaders.Authorization = `Bearer ${ciHubApiKey}`;
      }

      this.logger.debug(`Registering device at ${registerUrl}`);
      const registerResponse = await fetch(registerUrl, {
        method: 'POST',
        headers: registerHeaders,
        body: JSON.stringify({
          device_id: deviceId,
          organization_id: organizationId,
          description: description,
        }),
      });

      if (!registerResponse.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        const errorData = (await registerResponse.json().catch(() => ({ error: 'Unknown error' }))) as any;
        this.logger.error(`Device registration failed: ${registerResponse.status} - ${JSON.stringify(errorData)}`);
        return {
          success: false,
          message: `Registration failed: ${errorData.error || registerResponse.statusText}`,
        };
      }

      const registerResult = await registerResponse.json().catch(() => ({}));
      this.logger.info(`Device registered successfully: ${JSON.stringify(registerResult)}`);

      // Step 2: Activate device - REMOVED (Merged into Step 1)
      // The register endpoint now returns the organization details directly.

      const activateResult = registerResult; // Use register result as activation result
      this.logger.info(`Device activated successfully (merged): ${JSON.stringify(activateResult)}`);

      // Step 3: Validate organization name/subdomain availability before setup
      // Use provided organization name (already sanitized)
      const finalOrgName = sanitizedName;

      // Note: We used to validate against local Cloudflare service, now we rely on CI-Cloud provisioning
      // which will happen in setupOrganizationInfrastructure.
      // If validation is needed before setup, we should add a validate endpoint to CI-Cloud.

      // Step 4: Setup organization infrastructure
      await this.setupOrganizationInfrastructure(organizationId, {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        ...(activateResult as any),
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

  /**
   * Complete registration from CI Cloud callback
   * Called when CI Cloud redirects back to OS Hub after registration
   * CI Cloud provides: device_id, organization_id, organization_name, subdomain, tunnel_id (optional)
   */
  public async completeRegistrationFromCallback(data: {
    deviceId: string;
    organizationId: string;
    organizationName: string;
    subdomain: string;
    tunnelId: string;
    tunnelToken: string;
    apiKey?: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      // Verify device ID matches
      const currentDeviceId = await this.getDeviceId();
      if (data.deviceId !== currentDeviceId) {
        this.logger.warn(`Device ID mismatch: expected ${currentDeviceId}, got ${data.deviceId}`);
        return {
          success: false,
          message: 'Device ID mismatch. Registration failed.',
        };
      }

      // Save API Key if provided
      if (data.apiKey) {
        this.logger.info('Saving CI Hub API Key from registration callback');
        await this.config.setUserSettings({ ciHubApiKey: data.apiKey });
      }

      // Save Organization ID
      if (data.organizationId) {
        this.logger.info('Saving CI Hub Organization ID from registration callback');
        await this.config.setUserSettings({ ciHubOrganizationId: data.organizationId });
      }

      // Use the subdomain provided by CI Cloud (already validated on CI Cloud side)
      // The subdomain is the organization name part (e.g., "acme-corp" from "acme-corp.ci.computer")
      // OR device-org slug (e.g. "device-org" from "device-org.ci.computer")
      const incomingSubdomain = data.subdomain.trim();

      if (!incomingSubdomain) {
        return {
          success: false,
          message: 'Invalid subdomain received from CI Cloud.',
        };
      }

      // Setup organization infrastructure (Cloudflare tunnel and DNS)
      // Use the tunnel_id if provided by CI Cloud, otherwise create a new one
      await this.setupOrganizationInfrastructure(data.organizationId, {
        organization_name: data.organizationName,
        tunnel_id: data.tunnelId,
        tunnel_token: data.tunnelToken,
        subdomain: incomingSubdomain,
        slug: incomingSubdomain,
      });
      // Mark as registered
      this._isRegistered = true;
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      this.logger.info(`Device registration completed via callback: organization=${data.organizationId}, subdomain=${data.subdomain}`);

      return {
        success: true,
        message: 'Device registered successfully',
      };
    } catch (error) {
      this.logger.error('Registration callback error:', error);
      return {
        success: false,
        message: `Registration error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}
