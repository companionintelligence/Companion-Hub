import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RegistrationService } from './registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DEFAULT_CI_CLOUD_URL } from '@/common/constants';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { assertSafeOutboundHttpsUrl } from '@/common/helpers/ssrf-url';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';

interface RegisterDeviceDto {
  organization_id: string;
  organization_name: string;
  device_id?: string;
  description?: string;
}

interface VerifyPairingCodeDto {
  pairing_code: string;
}

interface PairDeviceDto {
  pairing_code: string;
}

interface RegistrationCallbackDto {
  /** The nonce this Hub minted for the registration; see `handleCallbackPost`. */
  state?: string;
  device_id: string;
  organization_id: string;
  organization_name: string;
  slug: string;
  subdomain: string;
  tunnel_id: string;
  tunnel_token: string;
  api_key: string;
  domain?: string;
}

@ApiTags('Registration')
@Controller('registration')
export class RegistrationController {
  constructor(
    private readonly registrationService: RegistrationService,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  @Post('reset')
  @UseGuards(AuthGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Reset device registration to allow re-pairing' })
  @ApiResponse({ status: 200, description: 'Registration reset successfully' })
  async resetRegistration(@Body() body?: { deregisterFromPortal?: boolean }) {
    await this.registrationService.resetRegistration({
      deregisterFromPortal: body?.deregisterFromPortal === true,
    });
    return { success: true, message: 'Registration reset. You can now re-pair this device.' };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get device registration and provisioning status' })
  @ApiResponse({ status: 200, description: 'Returns the explicit provisioning status' })
  async getStatus() {
    return this.registrationService.getLiveRegistrationStatus();
  }

  @Post('reconnect-tunnel')
  @UseGuards(AuthGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Recover public/remote access for a registered but tunnel-degraded Hub' })
  @ApiResponse({ status: 200, description: 'Returns the reconnect outcome (recovered, or an action the client should take)' })
  async reconnectTunnel() {
    return this.registrationService.reconnectTunnel();
  }

  @Get('state-drift')
  @ApiOperation({ summary: 'Detect local vs CI Portal registration state drift' })
  @ApiResponse({ status: 200, description: 'Returns drift signals when local and portal state disagree' })
  async getStateDrift() {
    return this.registrationService.getStateDrift();
  }

  @Post('prepare-fresh')
  @UseGuards(DemoModeGuard)
  @ApiOperation({ summary: 'Clear local registration artifacts for a fresh device pairing' })
  @ApiResponse({ status: 200, description: 'Local registration artifacts cleared' })
  async prepareFreshSetup() {
    return this.registrationService.prepareFreshSetup();
  }

  @Post('mark-restore-intent')
  @ApiOperation({ summary: 'Record restore intent before re-pairing an existing Portal device' })
  @ApiResponse({ status: 200, description: 'Restore intent recorded' })
  async markRestoreIntent() {
    return this.registrationService.markRestoreIntent();
  }

  @Get('device-id')
  @ApiOperation({ summary: 'Get device ID for registration redirect' })
  @ApiResponse({ status: 200, description: 'Returns the device ID and registration URL' })
  async getDeviceId(@Req() req: Request) {
    const deviceId = await this.registrationService.getDeviceId();
    const { ciCloudUrl } = this.config.getConfig();

    // Build the Companion Portal callback from the request origin so registration
    // returns to the same Hub address the browser used.
    const protocol = req.protocol || 'http';
    const host = req.get('host') || 'localhost:3000';

    /*
     * ⚠ A ONE-TIME SECRET RIDES IN THE CALLBACK URL, and that is what makes the
     * callback trustworthy.
     *
     * `POST /registration/callback` accepts `api_key`, `tunnel_id` and
     * `tunnel_token` — the Hub's whole identity — and had no guard of any kind.
     * Anyone who could reach this port could hand the Hub attacker-chosen
     * credentials and re-register it onto their own Portal account and tunnel.
     *
     * Minting here binds the callback to a registration THIS Hub started: the
     * nonce exists only in this process's memory, and only a caller who was
     * given this URL can echo it back. Portal treats `callback_url` as opaque
     * and returns to it verbatim, so no Portal change is needed.
     */
    const callbackNonce = this.registrationService.mintCallbackNonce();
    const callbackUrl = `${protocol}://${host}/device-registration?state=${encodeURIComponent(callbackNonce)}`;

    // Use Companion Portal's `/device/register` entry route for authentication
    // and Add Device. Treat blank configuration like a missing value.
    const registrationUrl = ciCloudUrl?.trim()
      ? `${ciCloudUrl.trim()}/device/register?device_id=${encodeURIComponent(deviceId)}&callback_url=${encodeURIComponent(callbackUrl)}`
      : null;

    return {
      device_id: deviceId,
      registration_url: registrationUrl,
      callback_url: callbackUrl,
      ci_cloud_url: ciCloudUrl || null, // Expose the configured Portal origin for diagnostics.
    };
  }

  @Post('callback')
  @ApiOperation({ summary: 'Handle registration callback from CI Cloud' })
  @ApiResponse({ status: 200, description: 'Registration completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid callback data' })
  @ApiResponse({ status: 403, description: 'No valid registration nonce, or the Hub is already registered' })
  async handleCallbackPost(@Body() body: RegistrationCallbackDto, @Query('state') stateQuery?: string) {
    /*
     * ⚠ THIS ROUTE HANDS THE HUB ITS IDENTITY, SO IT HAS TO PROVE WHERE IT CAME
     * FROM.
     *
     * The body carries `api_key`, `tunnel_id` and `tunnel_token`. With no guard
     * at all — no session, no device key, nothing — anyone who could reach this
     * port could re-register a running Hub onto credentials and a tunnel of
     * their choosing, and then receive everything it serves.
     *
     * The nonce is minted by `GET /registration/device-id`, which is what builds
     * the `callback_url` Portal is sent to, and it is spent here. It proves the
     * callback belongs to a registration this Hub started; it does not
     * authenticate Portal, which is why the operational check below is also
     * needed.
     *
     * Accepted from the query string OR the body: the query is where it arrives
     * when Portal returns to `callback_url` verbatim, and the body is for a
     * client that has parsed the redirect and re-posts it.
     */
    if (!this.registrationService.consumeCallbackNonce(stateQuery ?? body?.state)) {
      this.logger.warn('Rejected registration callback with no valid nonce');

      throw new ForbiddenException('This registration link is not valid any more. Start pairing again from this Hub.');
    }

    /*
     * ⚠ AND A REGISTERED HUB DOES NOT ACCEPT ONE.
     *
     * A nonce is minted by an UNAUTHENTICATED route, so on its own it does not
     * stop someone who can reach this port from starting a registration and
     * completing it. Re-registering a Hub that is already running is not a thing
     * a callback should ever do — `resetRegistration` is the deliberate,
     * authenticated way to reach that state, and `prepareFreshSetup` and
     * `markRestoreIntent` both refuse on the same test for the same reason.
     */
    if (await this.registrationService.isCurrentlyOperational()) {
      this.logger.warn('Rejected registration callback: this Hub is already registered');

      throw new ForbiddenException('This Hub is already registered. Reset its registration from Settings before pairing it again.');
    }

    return this.completeRegistrationCallback(body);
  }

  /*
   * ⚠ `GET /registration/callback` IS GONE, AND IT IS NOT COMING BACK.
   *
   * It took the same nine values — `api_key` and `tunnel_token` included — as
   * QUERY PARAMETERS. Those land in access logs, proxy logs, browser history and
   * `Referer` headers, so the Hub's Portal credential was written to disk in
   * several places on every registration. Its own comment called it legacy.
   * A client still using it gets a 404 and should be moved to the POST.
   */

  private async completeRegistrationCallback(body: RegistrationCallbackDto) {
    const {
      device_id: deviceId,
      organization_id: organizationId,
      organization_name: organizationName,
      slug,
      subdomain,
      tunnel_id: tunnelId,
      tunnel_token: tunnelToken,
      api_key: apiKey,
      domain,
    } = body;

    if (!deviceId || !organizationId || !organizationName || !subdomain || !tunnelId || !tunnelToken || !apiKey || !slug) {
      return {
        success: false,
        message: 'Missing required parameters: device_id, organization_id, organization_name, slug, subdomain, tunnel_id, tunnel_token, api_key',
      };
    }

    const result = await this.registrationService.completeRegistrationFromCallback({
      deviceId,
      organizationId,
      organizationName,
      subdomain,
      tunnelId,
      tunnelToken,
      apiKey,
      slug,
      domain,
    });

    return result;
  }

  @Get('config')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Get CI Cloud configuration (operator debug)' })
  @ApiResponse({ status: 200, description: 'Returns the CI Cloud configuration' })
  async getConfig() {
    const config = this.config.getConfig();
    const fs = await import('node:fs');
    const _path = await import('node:path');

    // Read the environment file directly so diagnostics can compare persisted
    // and process values.
    let envFileContent = null;
    let envFileLines: string[] = [];
    try {
      const envPath = config.envFilePath;
      if (fs.existsSync(envPath)) {
        envFileContent = fs.readFileSync(envPath, 'utf-8');
        envFileLines = envFileContent.split('\n').filter((line) => line.includes('CI_CLOUD') && !line.trim().startsWith('#'));
      }
    } catch (_e) {
      // Return the remaining diagnostics when the environment file is unreadable.
    }

    return {
      ciCloudUrl: config.ciCloudUrl || null,
      ciHubApiKey: config.ciHubApiKey ? '***configured***' : null,
      ciHubOrganizationId: config.ciHubOrganizationId || null,
      envFilePath: config.envFilePath,
      // Include only the filtered Portal configuration lines.
      envFileLines: envFileLines.length > 0 ? envFileLines : null,
      // Include the effective process value for comparison.
      processEnv: {
        CI_CLOUD_URL: process.env.CI_CLOUD_URL || DEFAULT_CI_CLOUD_URL,
      },
    };
  }

  @Get('validate')
  @ApiOperation({ summary: 'Validate organization name/subdomain availability' })
  @ApiResponse({ status: 200, description: 'Returns validation result' })
  async validateOrganizationName(@Query('name') name: string) {
    // Companion Portal owns Cloudflare availability checks. Until this endpoint
    // proxies an authenticated Portal request, validate only the local name format.

    if (!name?.trim()) {
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        errors: ['Organization name is required'],
      };
    }

    // Normalize the name to the slug format used during registration.
    const sanitizedName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!sanitizedName) {
      return {
        available: false,
        dnsAvailable: false,
        tunnelNameAvailable: false,
        errors: ['Invalid organization name. Please use only letters, numbers, and hyphens.'],
      };
    }

    // The Hub has no organization credential before registration, so it cannot
    // make the authenticated Portal availability request. Registration performs
    // the authoritative check.
    return {
      available: true,
      dnsAvailable: true,
      tunnelNameAvailable: true,
      message: 'Format is valid. Availability will be confirmed during registration.',
    };
  }

  @Post('verify-pairing-code')
  @ApiOperation({ summary: 'Verify a signup pairing code and bind device identity with CI Cloud' })
  @ApiResponse({ status: 200, description: 'Pairing code verified and device identity bound' })
  @ApiResponse({ status: 400, description: 'Invalid or missing pairing code' })
  async verifyPairingCode(@Body() body: VerifyPairingCodeDto) {
    const pairingCode = body.pairing_code?.trim().toUpperCase();

    if (!pairingCode || pairingCode.length !== 6) {
      return { success: false, message: 'A valid 6-character pairing code is required.' };
    }

    const deviceId = await this.registrationService.getDeviceId();

    if (!deviceId) {
      return { success: false, message: 'Device ID not found. Please ensure your device is properly initialized.' };
    }

    const { ciCloudUrl } = this.config.getConfig();

    if (!ciCloudUrl) {
      return { success: false, message: 'CI Cloud URL not configured.' };
    }

    try {
      const pairUrl = `${ciCloudUrl}/api/devices/pair`;
      const response = await fetch(pairUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairing_code: pairingCode, device_id: deviceId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        return {
          success: false,
          message: (errorData as { error?: string }).error || `Pairing failed: ${response.statusText}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        message: 'Pairing code verified. Device identity bound.',
        device_id: (data as { deviceId?: string }).deviceId,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to verify pairing code: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  @Get('probe-domain')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Probe a CF domain to check if the tunnel is serving the Hub' })
  @ApiResponse({ status: 200, description: 'Probe result' })
  async probeDomain(@Query('url') url: string) {
    if (!url?.startsWith('https://')) {
      return { ready: false };
    }
    try {
      const safeUrl = await assertSafeOutboundHttpsUrl(url);
      const res = await fetch(safeUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });

      // Any non-2xx response means tunnel or DNS setup is not ready.
      if (!res.ok) {
        return { ready: false };
      }

      const body = await res.text();
      // Detect known Cloudflare pages that indicate an unavailable tunnel.
      if (
        body.includes('Error 1033') ||
        body.includes('Error 1003') ||
        body.includes('Error 1000') ||
        body.includes('Error 1016') ||
        body.includes('Error 502') ||
        body.includes('Error 521') ||
        body.includes('Error 522') ||
        body.includes('Error 523') ||
        body.includes('Error 524') ||
        body.includes('Error 530')
      ) {
        return { ready: false };
      }
      // Catch unlisted Cloudflare error pages through their common markers.
      if (body.includes('cloudflare') && body.includes('error code')) {
        return { ready: false };
      }
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  @Post('pair')
  @ApiOperation({ summary: 'Pair device using a pairing code — atomic registration in one step' })
  @ApiResponse({ status: 200, description: 'Device paired and registered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid pairing code or pairing failed' })
  async pairDevice(@Body() body: PairDeviceDto) {
    const pairingCode = body.pairing_code?.trim().toUpperCase();

    this.logger.info(`Received local pairing request: codeLength=${pairingCode?.length ?? 0} validShape=${pairingCode?.length === 6}`);

    if (!pairingCode || pairingCode.length !== 6) {
      return { success: false, message: 'A valid 6-character pairing code is required.' };
    }

    const result = await this.registrationService.pairDevice(pairingCode);
    return result;
  }

  @Post('register')
  @ApiOperation({ summary: 'Initiate device registration with organization' })
  @ApiResponse({ status: 200, description: 'Registration initiated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async registerDevice(@Body() body: RegisterDeviceDto) {
    if (!body.organization_id?.trim()) {
      return {
        success: false,
        message: 'Organization ID is required',
      };
    }

    if (!body.organization_name?.trim()) {
      return {
        success: false,
        message: 'Organization name is required',
      };
    }

    const result = await this.registrationService.initiateRegistration(
      body.organization_id,
      body.organization_name,
      body.device_id,
      body.description,
    );
    return result;
  }
}
