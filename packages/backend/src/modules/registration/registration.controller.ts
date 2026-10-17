import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { RegistrationService } from './registration.service';
import type { RegistrationPhaseReport } from './registration-state';
import { probePublicHostname } from './public-reachability';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DEFAULT_CI_CLOUD_URL } from '@/common/constants';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { isLocalHostname, isPrivateOrLocalIp } from '@/common/helpers/ip-address';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { HubSessionGuard } from '@/modules/auth/hub-session.guard';
import { HubManagerGuard, resolveWhoisService } from '@/modules/auth/hub-manager.guard';
import { DemoModeGuard } from '@/common/guards/demo-mode.guard';
import { isRequestFromThisHost } from '@/modules/auth/portal-sso';

interface RegisterDeviceDto {
  organization_id: string;
  organization_name: string;
  device_id?: string;
  description?: string;
}

interface PairDeviceDto {
  pairing_code: string;
  /** Yes to `DEVICE_MOVE_CONFIRMATION_REQUIRED`: move this Hub from the organization that holds it. */
  confirm_move?: boolean;
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
    // Optional only to TypeScript, for the tests that build this controller by hand to reset a Hub.
    // Nest always injects it. Without it the callback finds no WhoIs service to ask about the caller.
    private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * Clears this Hub's registration locally. The Portal keeps the device: removing it from the
   * account is done in the Portal, by an owner or admin, and this Hub learns of it on check-in.
   *
   * A signed-in person only. The Portal device key is refused because first-party Memory holds it,
   * and the CLI JWT and app keys because none of them is a person deciding to unpair this Hub.
   */
  @Post('reset')
  @UseGuards(AuthGuard, HubSessionGuard, HubManagerGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Reset device registration to allow re-pairing' })
  @ApiResponse({ status: 200, description: 'Registration reset successfully' })
  @ApiResponse({ status: 403, description: 'Only a person signed in to this Hub may reset its registration' })
  async resetRegistration() {
    await this.registrationService.resetRegistration();
    return { success: true, message: 'Registration reset. You can now re-pair this device.' };
  }

  /**
   * One check while Settings waits for the person to delete this Hub in the Portal. Shares the
   * check-in throttle with the status route, and resets the Hub only when the Portal answers
   * `DEVICE_NOT_ACTIVE`.
   *
   * No `HubManagerGuard`: this only reports the check-in that the unauthenticated `status` route
   * sends anyway, and once the Portal deletes the device it can't confirm anyone's role.
   */
  @Post('removal-check')
  @UseGuards(AuthGuard, HubSessionGuard, DemoModeGuard)
  @ApiOperation({ summary: 'Check whether this Hub was removed from its account in the Portal' })
  @ApiResponse({
    status: 200,
    description: 'Returns { result: "removed" | "still_registered" | "key_refused" | "not_checked" }',
  })
  @ApiResponse({ status: 403, description: 'Only a person signed in to this Hub may run the removal check' })
  async checkForRemoval() {
    return { result: await this.registrationService.checkForRemoval() };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get device registration and provisioning status' })
  @ApiResponse({ status: 200, description: 'Returns the explicit provisioning status' })
  async getStatus() {
    return this.registrationService.getLiveRegistrationStatus();
  }

  /*
   * `status` is what the UI polls, and past a 30 s throttle each read sends a check-in to Portal.
   * This is the route for anything that only wants to look — `cihub doctor`, fleet preflight, a
   * person with curl — so looking cannot change `last_seen` in Portal or the phase it reports.
   * Unauthenticated like `status`, which already returns the phase and reasons; the check-in
   * fields add a status code and a scrubbed Portal error, and no credential.
   */
  @Get('phase')
  @ApiOperation({ summary: 'Get registration phase and the last Portal check-in without sending one' })
  @ApiResponse({ status: 200, description: 'Returns the in-memory phase, degraded reasons, and last check-in outcome' })
  getPhase(): RegistrationPhaseReport {
    return this.registrationService.getRegistrationPhaseReport();
  }

  @Post('reconnect-tunnel')
  @UseGuards(AuthGuard, HubManagerGuard, DemoModeGuard)
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
     * A one-time secret rides in the callback URL because
     * `POST /registration/callback` takes the Hub's whole identity — `api_key`,
     * `tunnel_id` and `tunnel_token` — and has no session to check. Minting here
     * binds the callback to a registration this Hub started. Portal treats
     * `callback_url` as opaque and returns to it verbatim, so nothing changes
     * there.
     */
    const callbackNonce = this.registrationService.mintCallbackNonce();
    const callbackUrl = `${protocol}://${host}/device-registration?state=${encodeURIComponent(callbackNonce)}`;

    // A DEVICE_ID copied from another machine gets no registration link: following it would bind that
    // other Hub's device ID in Portal, which `pairDevice` refuses for the same reason.
    const hostBinding = this.registrationService.getDeviceIdHostBinding();

    // Use Companion Portal's `/device/register` entry route for authentication
    // and Add Device. Treat blank configuration like a missing value.
    const registrationUrl =
      ciCloudUrl?.trim() && hostBinding.status !== 'foreign'
        ? `${ciCloudUrl.trim()}/device/register?device_id=${encodeURIComponent(deviceId)}&callback_url=${encodeURIComponent(callbackUrl)}`
        : null;

    return {
      device_id: deviceId,
      registration_url: registrationUrl,
      callback_url: callbackUrl,
      ci_cloud_url: ciCloudUrl || null, // Expose the configured Portal origin for diagnostics.
      // Status and message only. The host's own machine ID is never put on this unauthenticated route.
      device_id_host: { status: hostBinding.status, message: hostBinding.status === 'foreign' ? hostBinding.message : null },
    };
  }

  @Post('callback')
  @ApiOperation({ summary: 'Handle registration callback from CI Cloud' })
  @ApiQuery({ name: 'state', required: false, description: 'Registration nonce from `callback_url`; may also be sent in the body.' })
  @ApiResponse({ status: 200, description: 'Registration completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid callback data' })
  @ApiResponse({ status: 403, description: 'No valid registration nonce, or the Hub is registered and the caller may not pair it again' })
  async handleCallbackPost(@Body() body: RegistrationCallbackDto, @Query('state') stateQuery?: string, @Req() req?: Request) {
    // Check the shape before spending the nonce, so a malformed callback does not
    // burn a one-time secret that costs another round trip through Portal.
    const missing = this.missingCallbackParams(body);

    if (missing) {
      return missing;
    }

    /*
     * This route hands the Hub its identity, so it has to prove where it came
     * from: with no guard at all, anyone who could reach this port could
     * re-register a running Hub onto credentials and a tunnel of their choosing.
     *
     * The nonce is minted by `GET /registration/device-id`, which builds the
     * `callback_url` Portal is sent to, and is spent here. Portal returns to that
     * URL verbatim, so the nonce normally arrives in the query string; a client
     * that parsed the redirect re-posts it in the body instead.
     */
    if (!this.registrationService.consumeCallbackNonce(stateQuery?.trim() || body?.state)) {
      this.logger.warn('Rejected registration callback with no valid nonce');

      throw new ForbiddenException('This registration link is not valid any more. Start pairing again from this Hub.');
    }

    return this.completeRegistrationCallback(body, req);
  }

  /**
   * Deprecated. Kept because the CI-OS headless setup service on appliances
   * imaged before it moved to the POST still uses it:
   * `/opt/setup-backend/setup_service.py` forwards the cloud's registration
   * response to `http://127.0.0.1:5002/api/registration/callback` as a GET once
   * the Hub is running, so removing this route strands those appliances when
   * they pair from the setup portal. Newer images send the POST and fall back
   * to this only when the Hub answers 404 or 405.
   *
   * It carries `api_key` and `tunnel_token` in the query string, where they
   * reach request logs. Its caller cannot supply a nonce, so it answers only a
   * request made on this Hub's own machine. Like the POST, it refuses a Hub that
   * is already registered. Delete it once no appliance runs the GET-only setup
   * service; the warning below is how we tell when nothing calls it.
   */
  @Get('callback')
  @ApiOperation({ summary: 'Handle registration callback from CI Cloud (deprecated GET form — use POST)' })
  @ApiResponse({ status: 200, description: 'Registration completed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid callback data' })
  @ApiResponse({ status: 403, description: "Not sent from this Hub's own machine, or the Hub is already registered" })
  async handleCallback(
    @Req() req: Request,
    @Query('device_id') deviceId: string,
    @Query('organization_id') organizationId: string,
    @Query('organization_name') organizationName: string,
    @Query('slug') slug: string,
    @Query('subdomain') subdomain: string,
    @Query('tunnel_id') tunnelId: string,
    @Query('tunnel_token') tunnelToken: string,
    @Query('api_key') apiKey: string,
    @Query('domain') domain: string,
  ) {
    /*
     * The setup service calls the published port from the host, so the Hub sees it arrive from its
     * container's gateway with `Host: 127.0.0.1:5002`, which `isRequestFromThisHost` admits. That
     * places the request by address and isn't authentication, so the rules in
     * `completeRegistrationCallback` still apply.
     */
    if (!isRequestFromThisHost(req)) {
      this.logger.warn(
        `Rejected deprecated GET registration callback from ${req.socket?.remoteAddress ?? 'unknown'}: not sent from this Hub's own machine`,
      );

      throw new ForbiddenException('This callback is only accepted from this Hub itself. Pair this Hub from its pairing page instead.');
    }

    // After the refusal above, so a probe from the LAN does not read as a caller still on the GET.
    this.logger.warn(`Deprecated GET /registration/callback used by ${req.ip ?? 'unknown'} — migrate this caller to POST /registration/callback`);

    return this.completeRegistrationCallback(
      {
        device_id: deviceId,
        organization_id: organizationId,
        organization_name: organizationName,
        slug,
        subdomain,
        tunnel_id: tunnelId,
        tunnel_token: tunnelToken,
        api_key: apiKey,
        domain,
      },
      req,
    );
  }

  /** The fields a callback must carry, whichever route it arrives on. */
  private missingCallbackParams(body: RegistrationCallbackDto): { success: false; message: string } | null {
    const {
      device_id: deviceId,
      organization_id: organizationId,
      organization_name: organizationName,
      slug,
      subdomain,
      tunnel_id: tunnelId,
      tunnel_token: tunnelToken,
      api_key: apiKey,
    } = body ?? ({} as RegistrationCallbackDto);

    if (!deviceId || !organizationId || !organizationName || !subdomain || !tunnelId || !tunnelToken || !apiKey || !slug) {
      return {
        success: false,
        message: 'Missing required parameters: device_id, organization_id, organization_name, slug, subdomain, tunnel_id, tunnel_token, api_key',
      };
    }

    return null;
  }

  private async completeRegistrationCallback(body: RegistrationCallbackDto, req: Request | undefined) {
    const missing = this.missingCallbackParams(body);

    if (missing) {
      return missing;
    }

    /*
     * Neither route's gate proves who sent the callback. The POST's nonce is minted by an
     * unauthenticated route and the GET's check of where it came from is not authentication. So
     * both refuse a Hub that is already serving, since re-registering one is `resetRegistration`'s
     * job.
     *
     * A Hub degraded by a missing tunnel token is excluded. It is registered, but pairing again is
     * how it recovers. The headless setup service finishes that pairing here.
     */
    if (await this.registrationService.isRegisteredAndServing()) {
      this.logger.warn('Rejected registration callback: this Hub is already registered');

      throw new ForbiddenException('This Hub is already registered. Reset its registration from Settings before pairing it again.');
    }

    /*
     * A Hub that holds a registration but needs pairing again (`portal_rejected`,
     * `tunnel_token_missing`) gets past the check above. A `portal_rejected` Hub keeps its tunnel.
     * Pairing it again replaces its device key and tunnel, so it takes someone who may manage this
     * Hub, or a request from this Hub's own machine, where the headless setup service runs with no
     * session. An unregistered Hub has nobody to ask. The row counts as well as the phase
     * (`pairingReplacesRegistration`).
     */
    if ((await this.registrationService.pairingReplacesRegistration()) && !(await this.mayPairRegisteredHubAgain(req))) {
      this.logger.warn(
        `Rejected registration callback for a registered Hub from ${req?.socket?.remoteAddress ?? 'unknown'}: no owner or admin and not sent from this Hub's own machine`,
      );

      throw new ForbiddenException(
        'This Hub is already registered. Sign in as an owner or admin to pair it again, or run `cihub register --code <code>` on the Hub itself.',
      );
    }

    return this.registrationService.completeRegistrationFromCallback({
      deviceId: body.device_id,
      organizationId: body.organization_id,
      organizationName: body.organization_name,
      subdomain: body.subdomain,
      tunnelId: body.tunnel_id,
      tunnelToken: body.tunnel_token,
      apiKey: body.api_key,
      slug: body.slug,
      domain: body.domain,
    });
  }

  /**
   * Who may pair a Hub that holds a registration again, by a callback or a pairing code: a request
   * from this Hub's own machine, or someone `hubManageVerdictForRePairing` allows: the claiming
   * operator, an owner or admin, the CLI or the host-local key. A member is refused, as are the
   * Portal device key and a caller nobody authenticated.
   */
  private async mayPairRegisteredHubAgain(req: Request | undefined): Promise<boolean> {
    if (!req) {
      return false;
    }

    if (isRequestFromThisHost(req)) {
      return true;
    }

    // Nobody authenticated, so no WhoIs answer could allow it. Not asked, so it logs no refusal of its own.
    if (!req.hubPrincipal) {
      return false;
    }

    const whois = this.moduleRef ? resolveWhoisService(this.moduleRef) : null;

    return (await whois?.hubManageVerdictForRePairing(req)) === 'allowed';
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

  @Get('probe-domain')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Probe a CF domain to check if the tunnel is serving the Hub' })
  @ApiResponse({ status: 200, description: 'Probe result' })
  async probeDomain(@Query('url') url: string) {
    let hostname: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return { ready: false };
      }
      hostname = parsed.hostname;
    } catch {
      return { ready: false };
    }
    const literal = hostname.replace(/^\[|\]$/g, '');
    if (isLocalHostname(literal) || isPrivateOrLocalIp(literal, { includeUnspecified: true })) {
      return { ready: false };
    }

    /*
     * The probe the registration phase uses, so the page and the phase ask the same question: does
     * the Hub's liveness route answer 2xx at this name? Only a 2xx counts, which Cloudflare's error
     * pages (1033, 530, 52x) never are. It asks the zone's nameservers first, so polling a name
     * Portal has not published yet does not plant a 30-minute NXDOMAIN in the resolvers this Hub and
     * the person's browser share.
     *
     * Unlike the phase, a request that had to go around this host's resolver does not count: the page
     * sends the browser to this URL next, and a browser on the same network is behind the same
     * cached NXDOMAIN. Falling back to local sign-in is the better answer until that expires.
     */
    const probe = await probePublicHostname(hostname, {
      requireSystemResolver: true,
      isAllowedAddress: (address) => !isPrivateOrLocalIp(address, { includeUnspecified: true }),
    });
    return { ready: probe.reachable };
  }

  @Post('pair')
  @ApiOperation({ summary: 'Pair device using a pairing code — atomic registration in one step' })
  @ApiResponse({ status: 200, description: 'Device paired and registered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid pairing code or pairing failed' })
  async pairDevice(@Body() body: PairDeviceDto, @Req() req?: Request) {
    const pairingCode = body.pairing_code?.trim().toUpperCase();

    this.logger.info(`Received local pairing request: codeLength=${pairingCode?.length ?? 0} validShape=${pairingCode?.length === 6}`);

    if (pairingCode?.length !== 6) {
      return { success: false, message: 'A valid 6-character pairing code is required.' };
    }

    // No guard: first pairing has nobody to authenticate. Only for a Hub that holds a registration
    // does the service ask the question a registration callback asks (`mayPairRegisteredHubAgain`).
    const result = await this.registrationService.pairDevice(pairingCode, {
      mayPairAgain: () => this.mayPairRegisteredHubAgain(req),
      confirmMove: body.confirm_move === true,
    });
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
