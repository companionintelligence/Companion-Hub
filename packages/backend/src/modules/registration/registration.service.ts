import { Injectable, type OnApplicationBootstrap, Inject, forwardRef } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
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
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    readonly _repoQueue: RepoEventsQueue,
  ) {}

  async onApplicationBootstrap() {
    // Check if we are already registered
    let isRegistered = await this.isRegistered();

    if (isRegistered) {
      // If registered, verify license with cloud
      await this.verifyLicense();
      // Re-check registration status in case license check failed and wiped it
      isRegistered = this._isRegistered;

      // Ensure tunnel token is written to disk in dev mode (since it might be missing or temp)
      if (isRegistered && process.env.NODE_ENV === 'development') {
        try {
          const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
          if (org?.tunnelToken && org.tunnelId) {
            this.logger.debug('DevMode: Ensuring tunnel configuration exists...');
            await this.cloudflareClientService.initializeTunnel(org.id, {
              tunnelId: org.tunnelId,
              token: org.tunnelToken,
            });
          }
        } catch (e) {
          this.logger.warn('DevMode: Seting up tunnel config failed (non-fatal)', e);
        }
      }

      // Check for missing Tunnel ID and recover if needed
      if (isRegistered) {
        const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
        if (org && !org.tunnelId) {
          this.logger.warn(`Organization ${org.id} exists but Tunnel ID is missing. Attempting to recover...`);
          try {
            // Attempt to recover by re-registering/check-in with Cloud
            const { ciCloudApiUrl, ciHubApiKey } = this.config.getConfig();
            const deviceId = await this.getDeviceId();

            if (ciCloudApiUrl) {
              this.logger.info(`Attempting to recover tunnel credentials via registration endpoint for device ${deviceId}`);

              const registerUrl = `${ciCloudApiUrl}/devices/register`;
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
                    await this.deviceRegistrationRepository.updateDeviceRegistration(org.id, {
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

    if (!isRegistered) {
      // Start polling CI-Cloud for registration status (no org ID needed)
      this.pollRegistration();
    }
  }

  public async getDeviceId(): Promise<string> {
    this.logger.debug(`NODE_ENV is: ${process.env.NODE_ENV}`);
    this.logger.debug(`process.env.DEVICE_ID is: ${process.env.DEVICE_ID}`);
    if (process.env.DEVICE_ID) {
      return process.env.DEVICE_ID;
    }
    if (process.env.NODE_ENV === 'development') {
      return 'test-device-id2';
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
      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration();
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
          this.logger.debug('Device not yet registered, retrying in 30s...');
        }
      } catch (error) {
        this.logger.error('Error checking registration status:', error);
      }
    };

    // Initial check
    await check();

    // Start interval if not registered
    if (!this._isRegistered) {
      this.checkInterval = setInterval(check, 30000);
    }
  }

  private async checkRegistrationWithCloud(): Promise<boolean> {
    const { ciCloudApiUrl } = this.config.getConfig();

    // If CI Cloud API is not configured, allow access (backward compatibility)
    if (!ciCloudApiUrl) {
      this.logger.debug('CI Cloud API not configured, skipping registration check.');
      return true;
    }

    const deviceId = await this.getDeviceId();
    const statusUrl = new URL('/devices/registration-status', ciCloudApiUrl);
    statusUrl.searchParams.set('device_id', deviceId);

    try {
      const response = await fetch(statusUrl.toString(), { method: 'GET' });
      if (!response.ok) {
        this.logger.warn(`Registration status check failed: ${response.status} ${response.statusText}`);
        return false;
      }

      const data = (await response.json()) as {
        registered?: boolean;
        ready?: boolean;
        organization_id?: string;
        organization_name?: string;
        slug?: string;
        subdomain?: string;
        tunnel_id?: string;
        tunnel_token?: string;
        api_key?: string;
        domain?: string;
      };

      if (!data.registered) {
        return false;
      }

      if (!data.ready) {
        this.logger.debug('Device is registered but not ready yet (missing tunnel/app data).');
        return false;
      }

      if (!data.organization_id || !data.tunnel_id || !data.tunnel_token || !data.subdomain) {
        this.logger.warn('Registration status missing required fields.');
        return false;
      }

      if (data.api_key) {
        await this.config.setUserSettings({ ciHubApiKey: data.api_key });
      }
      await this.config.setUserSettings({ ciHubOrganizationId: data.organization_id });

      await this.setupOrganizationInfrastructure(data.organization_id, {
        organization_name: data.organization_name || 'Organization',
        tunnel_id: data.tunnel_id,
        tunnel_token: data.tunnel_token,
        subdomain: data.subdomain,
        slug: data.slug || 'org',
        domain: data.domain,
      });

      return true;
    } catch (error) {
      this.logger.error('Error checking registration status from CI Cloud:', error);
      return false;
    }
  }

  /**
   * Setup Cloudflare tunnel and DNS for the organization
   * Creates organization subdomain: {orgName}.{domain}
   * @param organizationId - Organization ID from CI Cloud
   * @param activationResult - Result from device activation (may contain org details)
   */
  private async setupOrganizationInfrastructure(
    organizationId: string,
    activationResult: { organization_name: string; tunnel_id: string; tunnel_token: string; slug: string; subdomain: string; domain?: string },
  ): Promise<void> {
    // Check if organization infrastructure already exists
    const existingOrg = await this.deviceRegistrationRepository.getDeviceRegistrationById(organizationId);
    if (existingOrg) {
      this.logger.debug(`Organization infrastructure already exists for ${organizationId}`);

      // Update tunnel credentials if provided (from device registration)
      if (activationResult?.tunnel_id && activationResult?.tunnel_token) {
        this.logger.info(`Updating organization ${organizationId} with tunnel credentials from registration`);
        await this.deviceRegistrationRepository.updateDeviceRegistration(organizationId, {
          tunnelId: activationResult.tunnel_id,
          tunnelToken: activationResult.tunnel_token,
        });

        // Initialize tunnel with new credentials
        await this.cloudflareClientService.initializeTunnel(organizationId, {
          tunnelId: activationResult.tunnel_id,
          token: activationResult.tunnel_token,
        });
      }
      return;
    }

    try {
      const { userSettings } = this.config.getConfig();
      const rootDomain = userSettings.domain;

      // Try to fetch organization details from CI Cloud API
      let orgName: string | null = null;
      let tunnelId: string | null = null;
      let tunnelToken: string | null = null;
      let orgSlug: string | null = null;
      let subdomain: string | null = null;

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

      const domain = `${subdomain}.${rootDomain}`;

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

      if (!orgName) {
        throw new Error('Organization name is required to create device registration');
      }

      if (!orgSlug) {
        throw new Error('Organization slug is required to create device registration');
      }

      // Store organization info in database
      await this.deviceRegistrationRepository.createDeviceRegistration({
        id: organizationId,
        slug: orgSlug,
        name: orgName,
        tunnelId: tunnelId,
        tunnelToken: tunnelToken,
      });

      this.logger.info(`Successfully setup organization infrastructure: ${domain} (tunnel: ${tunnelId})`);

      // Persist the correct domain to the data .env so it survives restarts.
      // The data .env may have the default 'example.com' from initial generation.
      // Prefer the domain from CI-Cloud response, fall back to the .env.local DOMAIN.
      const correctDomain = activationResult.domain || rootDomain;
      if (correctDomain && correctDomain !== 'example.com') {
        await this.config.setDomain(correctDomain);
      }

      // Sync hub domain to CI-Cloud so it can create DNS and tunnel routes
      // Hub route is managed by CI-Cloud's /devices/register — no syncState needed here.
      // triggerCloudflareSync in app-lifecycle.service.ts includes the Hub on every sync.

      // Verify tunnel connectivity (best-effort, don't block registration)
      this.logger.info(`Checking tunnel connectivity at https://${domain}...`);
      const maxRetries = 60; // 1 minute
      let tunnelReachable = false;
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
            tunnelReachable = true;
            break;
          }
          this.logger.debug(`Hub reachable but returned status ${response.status}`);
        } catch (e) {
          if (i % 10 === 0) {
            this.logger.debug(`Waiting for DNS/SSL propagation... Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (i > 0 && i % 10 === 0) this.logger.info(`Still waiting for DNS resolution... attempt ${i}/${maxRetries}`);
      }
      if (!tunnelReachable) {
        this.logger.warn(
          `Tunnel not yet reachable at https://${domain} after ${maxRetries}s — DNS may still be propagating. This is normal for first-time setup.`,
        );
      }
    } catch (error) {
      this.logger.error(`Error setting up organization infrastructure: ${error}`);
    }
  }

  /**
   * Get device registration info for the current hub instance
   */
  public async getDeviceRegistrationInfo() {
    // First try to get by configured organization ID
    const { ciHubOrganizationId } = this.config.getConfig();
    if (ciHubOrganizationId) {
      const deviceRegistration = await this.deviceRegistrationRepository.getDeviceRegistrationById(ciHubOrganizationId);
      if (deviceRegistration) {
        return deviceRegistration;
      }
    }

    // If not found, get the first device registration (from manual registration)
    // Since we only support one device registration per hub, return the first one
    return this.deviceRegistrationRepository.getFirstDeviceRegistration();
  }

  /**
   * Manually initiate device registration with organization
   * Called from the registration form
   *
   * This method performs the complete registration flow:
   * 1. Registers device with CI Cloud (/api/devices/register)
   * 2. Activates device (/api/web/register)
   * 3. Validates organization subdomain availability
   * 4. Creates Cloudflare tunnel and DNS records
   * 5. Stores device registration info in database
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
      // POST http://localhost:8001/api/devices/register
      const registerUrl = `${ciCloudApiUrl}/devices/register`;
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
      const _finalOrgName = sanitizedName;

      // Note: We used to validate against local Cloudflare service, now we rely on CI-Cloud provisioning
      // which will happen in setupOrganizationInfrastructure.
      // If validation is needed before setup, we should add a validate endpoint to CI-Cloud.

      // Step 4: Setup organization infrastructure
      await this.setupOrganizationInfrastructure(organizationId, {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        ...(activateResult as any),
        organization_name: organizationName,
        slug: sanitizedName,
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
    slug: string;
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
      // The subdomain is the organization name part (e.g., "acme-corp" from "acme-corp.{domain}")
      // OR device-org slug (e.g. "device-org" from "device-org.{domain}")
      const incomingSubdomain = data.subdomain.trim();

      if (!incomingSubdomain) {
        return {
          success: false,
          message: 'Invalid subdomain received from CI Cloud.',
        };
      }

      // Mark as registered immediately so the frontend can redirect
      this._isRegistered = true;
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      // Setup organization infrastructure (Cloudflare tunnel and DNS)
      // Fire-and-forget: don't block the callback response while waiting for DNS/tunnel
      this.setupOrganizationInfrastructure(data.organizationId, {
        organization_name: data.organizationName,
        tunnel_id: data.tunnelId,
        tunnel_token: data.tunnelToken,
        subdomain: incomingSubdomain,
        slug: data.slug,
      }).catch((err) => {
        this.logger.error('Background infrastructure setup failed:', err);
      });

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
