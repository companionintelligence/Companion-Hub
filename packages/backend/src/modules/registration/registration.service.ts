import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown, Inject, forwardRef } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { APP_DIR } from '@/common/constants';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../docker/traefik-config.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import si from 'systeminformation';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class RegistrationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private _isRegistered = false;
  private checkInterval: NodeJS.Timeout | null = null;
  private weeklyValidationInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => CloudflareClientService)) private readonly cloudflareClientService: CloudflareClientService,
    @Inject(forwardRef(() => TraefikConfigService)) private readonly traefikConfigService: TraefikConfigService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    readonly _repoQueue: RepoEventsQueue,
  ) {}

  onApplicationShutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.weeklyValidationInterval) {
      clearInterval(this.weeklyValidationInterval);
      this.weeklyValidationInterval = null;
    }
  }

  async onApplicationBootstrap() {
    // Before checking full registration status, try to recover the tunnel
    // token file from the database. isRegistered() requires both a DB record
    // AND the token file on disk, so we must restore the file first.
    await this.recoverTunnelTokenFromDb();

    // Ensure Traefik has a route for the hub's public hostname (e.g. devbox-core1.companionintelligence.com)
    // so requests through the Cloudflare tunnel reach ci-os-hub.
    await this.ensureHubRouteFromRegistration();

    let isRegistered = await this.isRegistered();

    if (isRegistered) {
      await this.verifyLicense();
      isRegistered = this._isRegistered;

      // Check for missing Tunnel ID and recover from CI-Cloud if needed
      if (isRegistered) {
        await this.recoverTunnelIdFromCloud();
      }
    }

    if (isRegistered) {
      this.startWeeklyValidation();
    } else {
      this.pollRegistration();
    }
  }

  /**
   * Write the Traefik hub route for the public hostname when we have a
   * registered org with hubSubdomain. Ensures the hub is reachable via
   * Cloudflare tunnel after bootstrap/restart.
   */
  private async ensureHubRouteFromRegistration(): Promise<void> {
    try {
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org?.hubSubdomain) return;

      const { domain } = this.config.getConfig();
      if (!domain || domain === 'example.com') return;

      await this.traefikConfigService.writeHubRoute(org.hubSubdomain, domain);
    } catch (e) {
      this.logger.warn('Failed to ensure hub route from registration (non-fatal)', e);
    }
  }

  /**
   * If the DB has a registered org with tunnel credentials but the token file
   * is missing on disk, re-write it. This covers container restarts, volume
   * resets, and dev-mode scenarios.
   */
  private async recoverTunnelTokenFromDb() {
    try {
      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration();
      if (!hasOrg) return;

      if (this.hasTunnelToken()) return;

      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (org?.tunnelToken && org.tunnelId) {
        this.logger.info('Tunnel token file missing — recovering from database...');
        await this.cloudflareClientService.initializeTunnel(org.id, {
          tunnelId: org.tunnelId,
          token: org.tunnelToken,
        });
        this.logger.info('Tunnel token file restored successfully');
      } else {
        this.logger.warn('Organization exists in DB but has no tunnel credentials to recover');
      }
    } catch (e) {
      this.logger.warn('Failed to recover tunnel token from database (non-fatal)', e);
    }
  }

  /**
   * If the org record is missing its tunnelId, attempt to re-register with
   * CI-Cloud to obtain fresh tunnel credentials.
   */
  private async recoverTunnelIdFromCloud() {
    try {
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org || org.tunnelId) return;

      this.logger.warn(`Organization ${org.id} exists but Tunnel ID is missing. Attempting to recover...`);

      const { ciCloudApiUrl, ciHubApiKey } = this.config.getConfig();
      const deviceId = await this.getDeviceId();

      if (!ciCloudApiUrl) return;

      this.logger.info(`Attempting to recover tunnel credentials via registration endpoint for device ${deviceId}`);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ciHubApiKey) {
        headers.Authorization = `Bearer ${ciHubApiKey}`;
      }

      const registerResponse = await fetch(`${ciCloudApiUrl}/devices/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          device_id: deviceId,
          organization_id: org.id,
          description: `CI OS Hub Device - ${deviceId} (Recovery)`,
        }),
      });

      if (!registerResponse.ok) {
        this.logger.error(`Failed to recover Tunnel ID: API returned ${registerResponse.status}`);
        return;
      }

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
    } catch (err) {
      this.logger.error(`Error during tunnel recovery: ${err}`);
    }
  }

  private startWeeklyValidation() {
    if (this.weeklyValidationInterval) {
      return;
    }

    this.validateRegistrationWithCloud().catch((e) => this.logger.error('Initial weekly validation failed', e));

    this.weeklyValidationInterval = setInterval(() => {
      this.validateRegistrationWithCloud().catch((e) => this.logger.error('Weekly validation check failed', e));
    }, ONE_WEEK_MS);
  }

  /**
   * Validates the current registration against CI Cloud.
   * Checks that the tunnel token file still exists, the device_id matches,
   * and the device status in CI Cloud is 'active'.
   * If any check fails, marks the device as unregistered so the frontend
   * reverts to the registration page.
   */
  private async validateRegistrationWithCloud(): Promise<void> {
    if (!this._isRegistered) return;

    if (!this.hasTunnelToken()) {
      this.logger.warn('Weekly validation: tunnel token missing — revoking registration');
      this._isRegistered = false;
      return;
    }

    const { ciCloudApiUrl } = this.config.getConfig();
    if (!ciCloudApiUrl) return;

    try {
      const deviceId = await this.getDeviceId();
      const statusUrl = new URL('devices/registration-status', ciCloudApiUrl.endsWith('/') ? ciCloudApiUrl : `${ciCloudApiUrl}/`);
      statusUrl.searchParams.set('device_id', deviceId);

      const response = await fetch(statusUrl.toString(), { method: 'GET' });
      if (!response.ok) {
        this.logger.warn(`Weekly validation: CI Cloud returned ${response.status} — revoking registration`);
        this._isRegistered = false;
        return;
      }

      const data = (await response.json()) as {
        registered?: boolean;
        device_status?: string;
        status?: string;
      };

      const deviceStatus = data.device_status || data.status;

      if (!data.registered) {
        this.logger.warn('Weekly validation: device no longer registered in CI Cloud — revoking registration');
        this._isRegistered = false;
        return;
      }

      if (deviceStatus && deviceStatus !== 'active') {
        this.logger.warn(`Weekly validation: device status is "${deviceStatus}" (not active) — revoking registration`);
        this._isRegistered = false;
        return;
      }

      this.logger.info('Weekly validation passed: device is active and registered');
    } catch (e) {
      this.logger.error('Weekly validation: failed to reach CI Cloud — keeping current state', e);
    }
  }

  public async getDeviceId(): Promise<string> {
    try {
      const serial = execSync('dmidecode -s system-serial-number', {
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();

      if (serial && serial !== 'Not Specified' && serial !== 'To Be Filled By O.E.M.' && serial !== 'Default string') {
        this.logger.debug(`Device ID from dmidecode: ${serial}`);
        return serial;
      }

      this.logger.warn(`dmidecode returned unusable value: "${serial}", falling back to systeminformation`);
    } catch (e) {
      this.logger.warn('dmidecode failed, falling back to systeminformation', e);
    }

    return (await si.uuid()).hardware;
  }

  private hasTunnelToken(): boolean {
    const tokenPath = path.join(APP_DIR, 'tunnel', 'token');
    try {
      const stat = fs.statSync(tokenPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  public async isRegistered(): Promise<boolean> {
    // If already registered, verify tunnel token still exists on disk
    if (this._isRegistered) {
      if (!this.hasTunnelToken()) {
        this.logger.warn('Tunnel token file missing — marking device as unregistered');
        this._isRegistered = false;
        return false;
      }
      return true;
    }

    // Check if we have any organization in the database (indicates successful registration)
    try {
      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration();
      if (hasOrg) {
        if (!this.hasTunnelToken()) {
          this.logger.warn('Device registration found in database but tunnel token file is missing — device is not fully registered');
          return false;
        }
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
          this.startWeeklyValidation();
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
    const statusUrl = new URL('devices/registration-status', ciCloudApiUrl.endsWith('/') ? ciCloudApiUrl : `${ciCloudApiUrl}/`);
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

      const updates: Record<string, string> = {};

      // Update tunnel credentials if provided (from device registration)
      if (activationResult?.tunnel_id && activationResult?.tunnel_token) {
        this.logger.info(`Updating organization ${organizationId} with tunnel credentials from registration`);
        updates.tunnelId = activationResult.tunnel_id;
        updates.tunnelToken = activationResult.tunnel_token;
      }

      // Backfill hubSubdomain if missing (pre-existing registrations)
      if (!existingOrg.hubSubdomain && activationResult?.subdomain) {
        this.logger.info(`Backfilling hubSubdomain for organization ${organizationId}: ${activationResult.subdomain}`);
        updates.hubSubdomain = activationResult.subdomain;
      }

      if (Object.keys(updates).length > 0) {
        await this.deviceRegistrationRepository.updateDeviceRegistration(organizationId, updates);
      }

      if (activationResult?.tunnel_id && activationResult?.tunnel_token) {
        await this.cloudflareClientService.initializeTunnel(organizationId, {
          tunnelId: activationResult.tunnel_id,
          token: activationResult.tunnel_token,
        });
      }

      // Ensure Traefik has a route for the hub's public hostname
      const hubSub = existingOrg.hubSubdomain ?? updates.hubSubdomain;
      const domainForRoute = this.config.getConfig().domain;
      if (hubSub && domainForRoute && domainForRoute !== 'example.com') {
        await this.traefikConfigService.writeHubRoute(hubSub, domainForRoute);
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

      const correctDomain = activationResult.domain || rootDomain;
      const domain = `${subdomain}.${correctDomain}`;

      // Write Traefik route for hub's public hostname immediately so redirect can succeed.
      // Must happen before tunnel init so the route is in place when Cloudflare forwards traffic.
      if (subdomain && correctDomain && correctDomain !== 'example.com') {
        await this.traefikConfigService.writeHubRoute(subdomain, correctDomain);
      }

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

      // Store organization info in database.
      // `hubSubdomain` is the canonical subdomain prefix for Hub routing (e.g. "core1-xyz"),
      // assigned by CI-Cloud. It is NOT derived from `DOMAIN` / `userSettings.domain`.
      await this.deviceRegistrationRepository.createDeviceRegistration({
        id: organizationId,
        slug: orgSlug,
        name: orgName,
        hubSubdomain: subdomain,
        tunnelId: tunnelId,
        tunnelToken: tunnelToken,
      });

      this.logger.info(`Successfully setup organization infrastructure: ${domain} (tunnel: ${tunnelId})`);

      // Persist the correct root domain (e.g. "companionintelligence.com") to the data .env.
      // `DOMAIN` / `userSettings.domain` is the root domain used for constructing app hostnames
      // (e.g. "{app}-{org}.{DOMAIN}"). It is NOT used for Hub route identity — that comes from
      // `hubSubdomain` stored in `device_registration`.
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
    domain?: string;
  }): Promise<{ success: boolean; message: string; domain?: string }> {
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

      // Persist the root domain immediately so the response includes the correct value
      // for the frontend redirect (e.g. "companionintelligence.com").
      const currentDomain = this.config.getConfig().domain;
      const rootDomain = data.domain || currentDomain;
      if (rootDomain && rootDomain !== 'example.com' && rootDomain !== currentDomain) {
        await this.config.setDomain(rootDomain);
      }

      // Setup organization infrastructure (Cloudflare tunnel and DNS)
      // Fire-and-forget: don't block the callback response while waiting for DNS/tunnel
      this.setupOrganizationInfrastructure(data.organizationId, {
        organization_name: data.organizationName,
        tunnel_id: data.tunnelId,
        tunnel_token: data.tunnelToken,
        subdomain: incomingSubdomain,
        slug: data.slug,
        domain: rootDomain,
      }).catch((err) => {
        this.logger.error('Background infrastructure setup failed:', err);
      });

      this.logger.info(`Device registration completed via callback: organization=${data.organizationId}, subdomain=${data.subdomain}`);

      return {
        success: true,
        message: 'Device registered successfully',
        domain: rootDomain,
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
