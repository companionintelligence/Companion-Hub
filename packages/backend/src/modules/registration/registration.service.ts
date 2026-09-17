import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown, Inject, forwardRef, Optional } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { scrubString } from '@/core/error-reporting/sentry-scrubber';
import { LoggerService } from '@/core/logger/logger.service';
import { APP_DATA_DIR, DATA_DIR, TUNNEL_DIR, tunnelUserClearedMarkerPath } from '@/common/constants';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, withPortalAxiosHeaders } from '@/common/helpers/portal-url';
import { rateLimitedWaitCopy } from '@/common/helpers/retry-after';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { type TunnelHealth, TunnelHealthService } from '../cloudflare/tunnel-health.service';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { TraefikConfigService } from '../docker/traefik-config.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import {
  type ProvisioningPhase,
  type DegradedReason,
  type RegistrationStatus,
  PROVISIONING_PHASES,
  isOperational,
  requiresPortalRePairing,
  isLegalTransition,
  isActiveRegistrationPhase,
  buildRegistrationStatus,
  parseDegradedReasons,
} from './registration-state';
import {
  buildStateDriftResult,
  clearRegistrationKeysFromAppData,
  collectStaleHubDeviceIds,
  type RegistrationStateDrift,
} from './registration-state-drift';
import { clearRegistrationRecoveryArtifacts, clearRehydrationState, writeRestoreIntent } from '../app-lifecycle/registration-recovery-state';
import { buildCheckInPayload } from './check-in-payload';
import { resolveDeviceId } from './device-id.resolver';
import { ALLOW_FOREIGN_DEVICE_ID_ENV, checkDeviceIdHostBinding, type DeviceIdHostBinding } from './device-id-host-check';
import { ModuleRef } from '@nestjs/core';
import { AuthService } from '@/modules/auth/auth.service';

const PERIODIC_VALIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLOUD_VALIDATION_THROTTLE_MS = 30 * 1000;
const BOOTSTRAP_VALIDATION_TIMEOUT_MS = 10 * 1000;
const PHASE_READ_CACHE_TTL_MS = 30 * 1000;

function describeRegistrationError(error: unknown): string {
  if (error instanceof Error) {
    return scrubString(error.stack || error.message);
  }

  return scrubString(String(error));
}

/**
 * True for a request that never got an HTTP response. Portal calls set
 * `validateStatus: () => true`, so a thrown axios error means DNS, TCP, TLS or
 * the timeout failed rather than the Portal answering.
 */
function isPortalUnreachableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { isAxiosError?: boolean; response?: unknown };
  return candidate.isAxiosError === true && !candidate.response;
}

function describePortalPairingResponse(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return scrubString(String(data));
  }

  const body = data as Record<string, unknown>;
  const safeBody = {
    error: typeof body.error === 'string' ? body.error : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    hasDeviceId: typeof body.device_id === 'string' && body.device_id.length > 0,
    hasOrganizationId: typeof body.organization_id === 'string' && body.organization_id.length > 0,
    hasSlug: typeof body.slug === 'string' && body.slug.length > 0,
    hasSubdomain: typeof body.subdomain === 'string' && body.subdomain.length > 0,
    hasTunnelId: typeof body.tunnel_id === 'string' && body.tunnel_id.length > 0,
    hasTunnelToken: typeof body.tunnel_token === 'string' && body.tunnel_token.length > 0,
    hasApiKey: typeof body.api_key === 'string' && body.api_key.length > 0,
    keys: Object.keys(body).sort(),
  };

  return scrubString(JSON.stringify(safeBody));
}

@Injectable()
export class RegistrationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private _currentPhase: ProvisioningPhase = 'unregistered';
  private _degradedReasons: DegradedReason[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private periodicValidationInterval: NodeJS.Timeout | null = null;
  private consecutiveValidationFailures = 0;
  private lastCloudValidationAt = 0;
  private cloudValidationInFlight: Promise<void> | null = null;
  private phaseReadCachedAt = 0;
  private phaseRefreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => CloudflareClientService)) private readonly cloudflareClientService: CloudflareClientService,
    @Inject(forwardRef(() => PortalClientService)) private readonly portalClient: PortalClientService,
    @Inject(forwardRef(() => TraefikConfigService)) private readonly traefikConfigService: TraefikConfigService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    readonly _repoQueue: RepoEventsQueue,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
    @Optional() private readonly tailscaleService?: TailscaleService,
    // Appended last, and optional, on purpose. This constructor is resolved positionally by
    // several test harnesses and by `CloudflareModule`'s forward-referenced graph; a dependency
    // inserted anywhere but the end silently re-binds the ones after it. Optional also keeps the
    // check-in working on a Hub whose Cloudflare module never came up — the tunnel-health field
    // is a diagnostic, not a precondition.
    @Optional() private readonly tunnelHealthService?: TunnelHealthService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  private portalAxiosConfig() {
    const { ciCloudUrl } = this.config.getConfig();
    return buildPortalAxiosConfig(ciCloudUrl, readPortalInternalUrlOverride());
  }

  /**
   * After Portal accepts this device, pull org membership for every local operator.
   * ModuleRef avoids AuthModule importing RegistrationModule and the reverse.
   */
  private reconcileOperatorMembershipsAfterCheckIn() {
    let auth: AuthService | undefined;
    try {
      auth = this.moduleRef?.get(AuthService, { strict: false });
    } catch {
      return;
    }
    if (!auth) {
      return;
    }
    void auth.reconcileOperatorMemberships().catch((error) => {
      this.logger.warn(`Operator membership sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  onApplicationShutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.periodicValidationInterval) {
      clearInterval(this.periodicValidationInterval);
      this.periodicValidationInterval = null;
    }
  }

  async onApplicationBootstrap() {
    setImmediate(() => {
      void this.runDeferredBootstrap().catch((error) => {
        this.logger.error('Deferred registration bootstrap failed', error);
      });
    });
  }

  private async runDeferredBootstrap() {
    // Loud at every boot, registered or not: a copied DEVICE_ID harms the OTHER Hub at pairing time,
    // and a Hub already paired under it gives no other sign that it shares an identity.
    const binding = this.getDeviceIdHostBinding();
    if (binding.status === 'foreign') {
      this.logger.warn(`Device ID: ${binding.message}`);
    }

    // Restore the tunnel token before checking registration. `isRegistered()`
    // requires both a database row and the on-disk token.
    const tunnelRecovered = await this.recoverTunnelTokenFromDb();

    // Reload the token into `CloudflareClientService` because the file survives a
    // restart while its in-memory `getTunnelToken()` state does not.
    await this.ensureCloudflareClientHasTunnelToken();

    // `recoverTunnelTokenFromDb` starts `cloudflared` only when the token file is
    // missing. Ensure it also runs after a registered Hub restarts with an existing
    // file, or the public hostname could resolve while its tunnel remains down.
    await this.cloudflareClientService.ensureCloudflaredRunning({ forceRestart: tunnelRecovered });

    // Restore the Traefik route so Cloudflare Tunnel requests for the public
    // hostname reach Companion Hub.
    await this.ensureHubRouteFromRegistration();

    // Restore the in-memory phase from durable registration state.
    await this.syncPhaseFromDb();

    if (isOperational(this._currentPhase)) {
      await this.verifyLicense();

      // A missing tunnel ID does not stop the Hub, but tunnel configuration
      // updates remain unavailable until the device pairs again.
      if (isOperational(this._currentPhase)) {
        await this.recoverTunnelIdFromCloud();
      }
    }

    if (isOperational(this._currentPhase)) {
      await Promise.race([
        this.validateRegistrationWithCloud(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, BOOTSTRAP_VALIDATION_TIMEOUT_MS);
        }),
      ]).catch((e) => this.logger.error('Initial registration validation failed', e));

      this.lastCloudValidationAt = Date.now();
      this.startPeriodicValidation();
    } else {
      this.pollRegistration();
    }
  }

  /**
   * Writes the Traefik route for a registered Hub's public hostname.
   *
   * Restore this route during bootstrap so Cloudflare Tunnel can reach the Hub
   * after a restart.
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

  // ---------------------------------------------------------------------------
  // Phase helpers
  // ---------------------------------------------------------------------------

  /**
   * Synchronizes the in-memory phase with the persisted database row.
   *
   * A missing on-disk tunnel token moves an otherwise operational registration
   * into the degraded phase.
   */
  private async syncPhaseFromDb(): Promise<void> {
    try {
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org) {
        this._currentPhase = 'unregistered';
        this._degradedReasons = [];
        return;
      }

      const rawPhase = org.provisioningPhase ?? 'locally_ready';
      const persisted = PROVISIONING_PHASES.includes(rawPhase as ProvisioningPhase) ? (rawPhase as ProvisioningPhase) : 'unregistered';
      if (rawPhase !== persisted) {
        this.logger.warn(`Invalid provisioning phase "${rawPhase}" in DB — falling back to "${persisted}"`);
      }

      // If durable state is operational, require its tunnel token on disk. Set the
      // in-memory phase first so the transition to `degraded` remains legal;
      // `unregistered` cannot transition directly to `degraded`.
      if (isOperational(persisted) && !this.hasTunnelToken()) {
        this.logger.warn('Tunnel token missing — transitioning to degraded');
        this._currentPhase = persisted;
        await this.setPhase('degraded', ['tunnel_token_missing'], org.id);
        return;
      }

      this._currentPhase = persisted;
      this._degradedReasons = parseDegradedReasons(org.degradedReasons);
    } catch (e) {
      this.logger.debug('Could not sync phase from DB:', e);
    }
  }

  /**
   * Transitions to a provisioning phase and updates durable state when an
   * organization exists.
   */
  public async setPhase(to: ProvisioningPhase, reasons: DegradedReason[] = [], orgId?: string): Promise<void> {
    const from = this._currentPhase;

    // Skip idempotent transitions except `degraded` updates that change reasons.
    if (from === to && to !== 'degraded') return;

    if (!isLegalTransition(from, to)) {
      this.logger.warn(`Illegal phase transition ${from} → ${to} — ignoring`);
      return;
    }

    this._currentPhase = to;
    this._degradedReasons = to === 'degraded' ? reasons : [];

    this.logger.info(`Provisioning phase: ${from} → ${to}${reasons.length ? ` (${reasons.join(', ')})` : ''}`);

    // Notify the agent so it can respond to registration-state changes.
    const urgency = to === 'degraded' ? 'high' : 'medium';
    this.agentNotifyService?.notify('registration.state_changed', { from, to, reasons }, urgency as 'high' | 'medium');

    // Persist only when an organization row can own the phase.
    const id = orgId ?? (await this.deviceRegistrationRepository.getFirstDeviceRegistration())?.id;
    if (id) {
      await this.deviceRegistrationRepository.updateProvisioningState(id, to, this._degradedReasons).catch((e) => {
        this.logger.warn('Failed to persist provisioning phase', e);
      });
    }

    this.phaseReadCachedAt = Date.now();
  }

  /** Returns the current in-memory registration status snapshot. */
  public getRegistrationStatus(): RegistrationStatus {
    return buildRegistrationStatus(this._currentPhase, this._degradedReasons);
  }

  /**
   * Returns the current registration status without waiting for durable reads.
   *
   * A stale cache schedules a background refresh from the database and disk.
   */
  public async getLiveRegistrationStatus(): Promise<RegistrationStatus> {
    this.schedulePhaseRefreshFromSources();
    await this.maybeValidateWithCloud();
    return this.getRegistrationStatus();
  }

  /** Refreshes the phase from the database and disk when the read cache is stale. */
  private schedulePhaseRefreshFromSources(): void {
    const now = Date.now();
    if (this.phaseReadCachedAt > 0 && now - this.phaseReadCachedAt < PHASE_READ_CACHE_TTL_MS) {
      return;
    }

    if (this.phaseRefreshInFlight) {
      return;
    }

    this.phaseRefreshInFlight = this.refreshPhaseFromSources()
      .catch((error) => {
        this.logger.debug('Background registration phase refresh failed', error);
      })
      .finally(() => {
        // Throttle failed refreshes too, preventing status polling from repeatedly
        // reading the database and disk.
        this.phaseReadCachedAt = Date.now();
        this.phaseRefreshInFlight = null;
      });
  }

  /**
   * Starts a throttled, deduplicated Portal check-in for status endpoints.
   *
   * Portal unavailability does not fail the status request.
   */
  private async maybeValidateWithCloud(): Promise<void> {
    if (!isOperational(this._currentPhase)) {
      return;
    }

    const { ciCloudUrl } = this.config.getConfig();
    if (!ciCloudUrl) {
      return;
    }

    const now = Date.now();
    if (this.lastCloudValidationAt > 0 && now - this.lastCloudValidationAt < CLOUD_VALIDATION_THROTTLE_MS) {
      return;
    }

    if (!this.cloudValidationInFlight) {
      this.cloudValidationInFlight = this.validateRegistrationWithCloud()
        .catch((e) => this.logger.error('Registration validation check failed', e))
        .finally(() => {
          this.lastCloudValidationAt = Date.now();
          this.cloudValidationInFlight = null;
        });
    }

    // Return the last known phase immediately so Portal and tunnel probes never
    // block status handlers.
  }

  /**
   * Refreshes the in-memory phase from the database and disk.
   *
   * `getLiveRegistrationStatus()` and `isRegistered()` share these rules:
   *
   * 1. Keep an operational in-memory phase when the tunnel token exists.
   * 2. Reset an operational phase to `unregistered` when both the token and
   *    organization row are missing.
   * 3. Move an operational phase to `degraded` when the organization row exists
   *    but the token is missing.
   * 4. When the phase is not operational, restore it from an organization row
   *    that has an on-disk token.
   */
  private async refreshPhaseFromSources(): Promise<void> {
    if (isOperational(this._currentPhase)) {
      if (this.hasTunnelToken()) return;

      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration().catch((error) => {
        this.logger.debug('Could not check organization in database:', error);
        return true; // Preserve state when a transient database error prevents verification.
      });

      if (!hasOrg) {
        this.logger.warn('Cached operational phase has no registration row and no tunnel token — resetting to unregistered');
        await this.setPhase('unregistered');
        return;
      }

      this.logger.warn('Tunnel token file missing — marking device as degraded');
      await this.setPhase('degraded', ['tunnel_token_missing']);
      return;
    }

    // An existing durable registration can restore a nonoperational in-memory phase.
    try {
      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration();
      if (hasOrg) {
        if (!this.hasTunnelToken()) {
          this.logger.warn('Device registration found in database but tunnel token file is missing — device is not fully registered');
          return;
        }
        await this.syncPhaseFromDb();
      }
    } catch (error) {
      this.logger.debug('Could not check organization in database:', error);
    }
  }

  /**
   * Restores a missing tunnel-token file from a registered organization row.
   *
   * Container restarts, volume resets, and development environments can preserve
   * the database credentials while losing the file.
   */
  private async recoverTunnelTokenFromDb(): Promise<boolean> {
    try {
      if (await this.isTunnelTokenUserCleared()) {
        this.logger.info('Tunnel token was cleared by the user — skipping recovery from database');
        return false;
      }

      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration();
      if (!hasOrg) return false;

      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org?.tunnelToken || !org.tunnelId) {
        if (hasOrg) {
          this.logger.warn('Organization exists in DB but has no tunnel credentials to recover');
        }
        return false;
      }

      const tokenPath = path.join(TUNNEL_DIR, 'token');
      let onDiskToken: string | null = null;
      try {
        onDiskToken = (await fs.promises.readFile(tokenPath, 'utf-8')).trim() || null;
      } catch {
        onDiskToken = null;
      }

      const credentialsOutOfSync = !onDiskToken || onDiskToken !== org.tunnelToken.trim();
      if (!credentialsOutOfSync) {
        return false;
      }

      this.logger.info(
        onDiskToken
          ? 'Tunnel token on disk is missing or out of sync with database — rewriting credentials...'
          : 'Tunnel token file missing — recovering from database...',
      );
      const result = await this.cloudflareClientService.initializeTunnel(org.id, {
        tunnelId: org.tunnelId,
        token: org.tunnelToken,
      });
      if (!result) {
        this.logger.error('Failed to restore tunnel credentials from database (check bind-mount permissions on tunnel/token)');
        return false;
      }
      this.logger.info('Tunnel token file restored successfully');
      return true;
    } catch (e) {
      this.logger.warn('Failed to recover tunnel token from database (non-fatal)', e);
      return false;
    }
  }

  /**
   * Loads the on-disk tunnel token into `CloudflareClientService`.
   *
   * A process restart clears the in-memory token but preserves the file. Restoring
   * it keeps `getTunnelToken()` and `/app-context` availability accurate.
   */
  private async ensureCloudflareClientHasTunnelToken(): Promise<void> {
    try {
      if (!this.hasTunnelToken()) return;

      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      await this.cloudflareClientService.loadTunnelTokenFromDisk(org?.tunnelId ?? undefined);
    } catch (e) {
      this.logger.warn('Failed to load tunnel token into CloudflareClientService (non-fatal)', e);
    }
  }

  /**
   * Reports an organization row that lacks its tunnel ID.
   *
   * Do not make a Portal request here. If the Hub is operational, its database
   * row and token file already let `cloudflared` serve requests independently of
   * the `tunnelId` column. Re-pairing or a later Companion Portal callback
   * restores the missing metadata.
   */
  private async recoverTunnelIdFromCloud() {
    try {
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org || org.tunnelId) return;

      this.logger.warn(
        `Organization ${org.id} is operational but tunnelId is missing from DB. ` +
          'Tunnel is still running. Re-pair via CI Portal to restore full tunnel metadata.',
      );
    } catch (err) {
      this.logger.error(`Error checking tunnelId: ${err}`);
    }
  }

  private startPeriodicValidation() {
    if (this.periodicValidationInterval) {
      return;
    }

    this.periodicValidationInterval = setInterval(() => {
      this.validateRegistrationWithCloud().catch((e) => this.logger.error('Registration validation check failed', e));
    }, PERIODIC_VALIDATION_INTERVAL_MS);
  }

  /**
   * Validates the current registration against Companion Portal.
   *
   * The check requires an on-disk tunnel token and an active matching device.
   * Three consecutive remote failures trigger `degraded`, allowing transient
   * network errors to recover without changing the phase.
   */
  private async validateRegistrationWithCloud(): Promise<void> {
    if (!isOperational(this._currentPhase)) return;

    if (!this.hasTunnelToken()) {
      this.logger.warn('Registration validation: tunnel token missing — transitioning to degraded');
      await this.setPhase('degraded', ['tunnel_token_missing']);
      return;
    }

    // Refresh the in-memory token so `getTunnelToken()` matches durable state.
    await this.ensureCloudflareClientHasTunnelToken();

    const { ciCloudUrl, ciHubApiKey, version } = this.config.getConfig();
    if (!ciCloudUrl) return;

    try {
      const deviceId = await this.getDeviceId();

      // Best-effort: piggyback what this node knows about itself on the check-in this method
      // already sends every hour, rather than adding a second round trip to Portal. See
      // `check-in-payload.ts` for the rules that govern the body, and `CheckIn.ts` on the Portal
      // side for the field-absent-vs-blank contract they follow.
      const diagnostics = await this.collectCheckInDiagnostics();

      // Confirm that Companion Portal still considers the device active. The
      // check-in endpoint authenticates with the registered device's
      // `x-device-key`. A 400 is definitive; network errors count toward the
      // transient-failure threshold.
      const response = await axios.post(
        `${this.config.getOutboundCiCloudUrl()}/api/devices/check-in`,
        buildCheckInPayload({
          deviceId,
          hubVersion: version,
          phase: this._currentPhase,
          degradedReasons: this._degradedReasons,
          ...diagnostics,
        }),
        {
          timeout: 5_000,
          validateStatus: () => true,
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), {
            'Content-Type': 'application/json',
            ...(ciHubApiKey ? { 'x-device-key': ciHubApiKey } : {}),
          }),
        },
      );

      if (response.status === 400) {
        // A 400 definitively means Companion Portal removed or deactivated the device.
        this.consecutiveValidationFailures = 0;
        this.logger.warn('Registration validation: device is no longer active in CI Portal (400) — clearing local registration for re-pairing');
        await this.resetRegistration({ reason: 'portal_rejected' });
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        // Count remote failures, including 5xx responses, toward the three-attempt threshold.
        this.consecutiveValidationFailures++;
        this.logger.warn(`Registration validation: CI Portal check-in returned ${response.status} (failure ${this.consecutiveValidationFailures}/3)`);
        if (this.consecutiveValidationFailures >= 3) {
          await this.setPhase('degraded', ['cloud_validation_failed']);
        }
        return;
      }

      this.consecutiveValidationFailures = 0;
      this.reconcileOperatorMembershipsAfterCheckIn();

      // A successful check-in restores a registration degraded by remote failures.
      if (this._currentPhase === 'degraded') {
        this.logger.info('Registration validation passed — recovering from degraded');
        await this.setPhase('locally_ready');
      } else {
        this.logger.info('Registration validation passed: device is active in CI Portal');
      }

      // Probe tunnel reachability for diagnostics without delaying validation.
      if (this._currentPhase === 'locally_ready') {
        void this.logPublicHostnameReachability().catch((error) => {
          this.logger.debug(`Registration validation: public hostname probe failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (e) {
      // Count network and timeout errors toward the transient-failure threshold.
      this.consecutiveValidationFailures++;
      this.logger.error(`Registration validation: failed to reach CI Portal (failure ${this.consecutiveValidationFailures}/3)`, e);
      if (this.consecutiveValidationFailures >= 3) {
        await this.setPhase('degraded', ['cloud_validation_failed']);
      }
    }
  }

  /**
   * Reads the best-effort facts the Portal status report shows beside this device.
   *
   * Each read is guarded individually because none of them may fail the check-in. The caller runs
   * inside the catch that counts Portal failures toward `degraded` and eventually toward telling
   * the owner to re-pair; a wedged Tailscale daemon or a throwing tunnel probe is not Portal being
   * unreachable, and must never be counted as one. A failed read returns `undefined`, which
   * `buildCheckInPayload` drops from the wire — the check-in then simply reports less than usual
   * instead of reporting something false.
   *
   * Both sources are cache reads by design (Tailscale 30s, tunnel health 60s), so this costs no
   * blocking I/O on a path with a 5s HTTP budget that also runs during bootstrap.
   */
  private async collectCheckInDiagnostics(): Promise<{ nodeFqdn?: string | null; tailscaleConnected?: boolean | null; tunnelHealth?: TunnelHealth }> {
    let nodeFqdn: string | null | undefined;
    let tailscaleConnected: boolean | null | undefined;
    try {
      const status = await this.tailscaleService?.getStatusCached();
      nodeFqdn = status?.nodeFqdn;
      /*
       * ⚠ ONLY MEANINGFUL WHEN TAILSCALE IS ACTUALLY INSTALLED.
       *
       * `TailscaleStatus.connected` is a non-optional boolean, and both
       * not-installed paths in `tailscale.service.ts` build their result from a
       * `notInstalled` literal that hard-codes it `false`. Passing it straight
       * through therefore reports `tailscale_connected: false` for a Hub that
       * has no Tailscale at all — indistinguishable, on the wire, from one that
       * has it and has dropped off its tailnet. The first is a deployment
       * choice; the second is a fault worth showing someone.
       *
       * `buildCheckInPayload` already omits a non-boolean, and its comment says
       * exactly this — but it cannot act on it, because the type it is handed
       * can never be undefined. So the distinction has to be made here, where
       * `installed` is still in scope.
       */
      tailscaleConnected = status?.installed ? status.connected : undefined;
    } catch (error) {
      this.logger.debug(`Check-in diagnostics: Tailscale status unavailable, omitting its fields: ${describeRegistrationError(error)}`);
    }

    let tunnelHealth: TunnelHealth | undefined;
    try {
      tunnelHealth = this.tunnelHealthService?.getHealth();
    } catch (error) {
      this.logger.debug(`Check-in diagnostics: tunnel health unavailable, omitting the field: ${describeRegistrationError(error)}`);
    }

    return { nodeFqdn, tailscaleConnected, tunnelHealth };
  }

  /** Probes tunnel DNS and HTTPS for logging without blocking request handlers. */
  private async logPublicHostnameReachability(): Promise<void> {
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const { domain } = this.config.getConfig();

    if (!org?.hubSubdomain || !domain || domain === 'example.com') {
      return;
    }

    const hostname = `${org.hubSubdomain}.${domain}`;
    try {
      const dnsCheck = await axios.head(`https://${hostname}`, {
        timeout: 2_000,
        validateStatus: () => true,
      });
      if (dnsCheck.status >= 400 && dnsCheck.status !== 401 && dnsCheck.status !== 403) {
        this.logger.warn(`Registration validation: public hostname ${hostname} returned ${dnsCheck.status} — tunnel may still be stabilising`);
      }
    } catch {
      this.logger.warn(`Registration validation: public hostname ${hostname} not yet reachable — tunnel may still be stabilising`);
    }
  }

  /**
   * Resets device registration so the appliance can pair again.
   *
   * The reset clears in-memory state, database rows, the tunnel token, and the
   * resolved environment.
   */
  public async resetRegistration(options?: { reason?: 'manual' | 'portal_rejected'; deregisterFromPortal?: boolean }): Promise<void> {
    const reason = options?.reason ?? 'manual';
    if (reason === 'portal_rejected') {
      this.logger.info('Clearing local device registration after CI Portal rejected check-in');
    } else {
      this.logger.info('Resetting device registration...');
    }

    if (options?.deregisterFromPortal) {
      try {
        const deviceId = await this.getDeviceId();
        await this.portalClient.postDeviceDeregister(deviceId);
        this.logger.info('Requested Portal deregistration for paired reset');
      } catch (error) {
        this.logger.warn(
          `Portal deregistration failed during reset (continuing local reset): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Use `setPhase` for consistent logging. Reset to `unregistered` is always legal.
    await this.setPhase('unregistered');

    // Stop validation before removing its registration state.
    if (this.periodicValidationInterval) {
      clearInterval(this.periodicValidationInterval);
      this.periodicValidationInterval = null;
    }

    // Remove all durable device-registration rows.
    await this.deviceRegistrationRepository.deleteAll();

    // Remove the tunnel token from disk.
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    try {
      await fs.promises.unlink(tokenPath);
    } catch {
      // A missing token already satisfies the reset.
    }

    // Remove the resolved environment so the next startup regenerates it.
    const resolvedEnvPath = path.join(DATA_DIR, 'state', '.env.resolved');
    try {
      await fs.promises.unlink(resolvedEnvPath);
    } catch {
      // A missing resolved environment already satisfies the reset.
    }

    await clearRehydrationState();

    this.logger.info('Device registration reset complete');

    // Resume polling for the next registration.
    this.pollRegistration();
  }

  /**
   * Restores remote access for a registered Hub with `tunnel_token_missing`.
   *
   * `pairDevice` refuses an already registered device, so recover the existing
   * tunnel credentials from the database and rewrite the token file. The
   * structured result directs the UI:
   *
   * - `{ recovered: true }`: The token was restored and the tunnel restarted.
   * - `{ recovered: false, action: 'restart' }`: Credentials exist, but the Hub
   *   user cannot write the tunnel directory. A restart lets the container
   *   entrypoint repair ownership before boot recovery tries again.
   * - `{ recovered: false, action: 're_pair' }`: No recoverable credentials
   *   remain, so the device must reset and pair again to provision a tunnel.
   */
  public async reconnectTunnel(): Promise<{ recovered: boolean; action?: 're_pair' | 'restart'; reason: string }> {
    // The banner exposes this action only for a degraded device with
    // `tunnel_token_missing`, so trust the in-memory phase. Calling
    // `refreshPhaseFromSources()` would persist a redundant degraded transition,
    // emit another high-urgency notification, and could reset a registration
    // cleared out of band to `unregistered`.

    // If the token already exists, clear a stale degraded phase. Boot recovery can
    // rewrite the file while Companion Portal is unavailable, leaving the phase
    // unchanged even though the local condition has recovered.
    if (this.hasTunnelToken()) {
      await this.clearTunnelTokenMissingDegraded();
      return { recovered: true, reason: 'tunnel_token_present' };
    }
    if (!this._degradedReasons.includes('tunnel_token_missing')) {
      return { recovered: false, reason: 'not_tunnel_token_missing' };
    }

    // An explicit reconnect overrides an earlier user-cleared token. Remove the
    // marker so database recovery can proceed.
    try {
      await fs.promises.unlink(tunnelUserClearedMarkerPath());
    } catch {
      // A missing marker requires no cleanup.
    }

    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    if (!org) {
      return { recovered: false, action: 're_pair', reason: 'not_registered' };
    }
    if (!org.tunnelToken || !org.tunnelId) {
      // Missing Portal credentials leave nothing to restore locally. Reset and
      // pair again to provision another tunnel.
      return { recovered: false, action: 're_pair', reason: 'no_credentials' };
    }

    // Existing credentials can restore the token file without a new pairing.
    await this.cloudflareClientService.initializeTunnel(org.id, {
      tunnelId: org.tunnelId,
      token: org.tunnelToken,
    });

    // Determine success from the on-disk token, not `initializeTunnel()`'s return
    // value. That method can return `null` after writing the file when a later
    // `cloudflared` or Portal operation fails. If the token remains absent, the
    // write failed, often because the tunnel directory is root-owned. Restarting
    // lets the container entrypoint repair ownership before boot recovery retries.
    if (!this.hasTunnelToken()) {
      return { recovered: false, action: 'restart', reason: 'tunnel_dir_not_writable' };
    }

    // Clear the degraded phase as soon as the local condition recovers; success
    // must not depend on a Portal request. Start `cloudflared` and Portal
    // reconciliation in the background so the response remains prompt.
    await this.clearTunnelTokenMissingDegraded();
    void (async () => {
      try {
        await this.cloudflareClientService.ensureCloudflaredRunning({ forceRestart: true });
      } catch (e) {
        this.logger.warn('Post-reconnect cloudflared restart failed (non-fatal)', e);
      }
      // Share the throttled, deduplicated check-in with status polling to avoid
      // duplicate requests or resets after a Portal 400.
      await this.maybeValidateWithCloud();
    })();

    this.logger.info('Tunnel reconnected from stored credentials');
    return { recovered: true, reason: 'recovered_from_db' };
  }

  /**
   * Clears `degraded` after a missing tunnel token returns.
   *
   * Reset the transient-failure counter so one stale failure cannot immediately
   * degrade the restored phase again.
   */
  private async clearTunnelTokenMissingDegraded(): Promise<void> {
    if (this._currentPhase === 'degraded' && this._degradedReasons.includes('tunnel_token_missing')) {
      this.consecutiveValidationFailures = 0;
      await this.setPhase('locally_ready');
    }
  }

  /**
   * Detects disagreements among local registration artifacts, Companion Portal,
   * and persisted app data.
   *
   * Drift detection applies only while the Hub is locally unregistered.
   */
  public async getStateDrift(): Promise<RegistrationStateDrift> {
    await this.refreshPhaseFromSources();
    const status = this.getRegistrationStatus();
    const hardwareDeviceId = await this.getDeviceId();

    // Companion Portal can reflect a paired device before local provisioning
    // finishes. Treat that intermediate state as expected progress, not drift.
    if (isActiveRegistrationPhase(status.phase)) {
      return buildStateDriftResult({
        hardwareDeviceId,
        localRegistered: status.registered,
        portalDeviceActive: null,
        staleAppEnvDeviceIds: [],
        hasStaleTunnelToken: false,
        hasOrphanedDbRegistration: false,
      });
    }

    const localRegistered = status.registered;

    const staleAppEnvDeviceIds = collectStaleHubDeviceIds(APP_DATA_DIR, hardwareDeviceId);
    const hasStaleTunnelToken = !localRegistered && this.hasTunnelToken();

    let portalDeviceActive: boolean | null = null;
    const { ciCloudUrl } = this.config.getConfig();
    if (ciCloudUrl && !localRegistered) {
      portalDeviceActive = await this.probePortalDeviceActive(hardwareDeviceId, this.config.getOutboundCiCloudUrl());
    }

    const dbRow = localRegistered ? null : await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const hasOrphanedDbRegistration = !localRegistered && Boolean(dbRow);

    return buildStateDriftResult({
      hardwareDeviceId,
      localRegistered,
      portalDeviceActive,
      staleAppEnvDeviceIds,
      hasStaleTunnelToken,
      hasOrphanedDbRegistration,
    });
  }

  /**
   * The one-time secret for the registration this Hub is running: minted with
   * the `callback_url` handed to Portal, and spent when the callback returns.
   * Possession of it shows the callback belongs to a registration this Hub
   * started; it does not authenticate Portal, so `POST /registration/callback`
   * also refuses an already-registered Hub.
   *
   * In memory on purpose, because a registration attempt does not survive a
   * restart either.
   */
  private callbackNonce: { value: string; mintedAt: number } | null = null;

  /** Long enough for a person to sign in at Portal and pick an organization. */
  private static readonly CALLBACK_NONCE_TTL_MS = 30 * 60 * 1000;

  /**
   * Returns the nonce for the registration in flight, minting one when there is
   * none.
   *
   * The registration page re-reads `GET /registration/device-id` on every status
   * poll, so minting one per call would replace the nonce the person is carrying
   * through Portal, and change the QR code they are scanning.
   */
  public mintCallbackNonce(): string {
    const live = this.liveCallbackNonce();

    if (live) {
      return live;
    }

    this.callbackNonce = { value: randomUUID(), mintedAt: Date.now() };

    return this.callbackNonce.value;
  }

  /**
   * Spends the nonce. Returns false when it was never minted here, was already
   * used, or has expired — all of which mean the same thing to the caller.
   */
  public consumeCallbackNonce(nonce: string | undefined): boolean {
    if (!nonce || this.liveCallbackNonce() !== nonce) {
      return false;
    }

    this.callbackNonce = null;

    return true;
  }

  /** The current nonce, or null once it has aged past the TTL. */
  private liveCallbackNonce(): string | null {
    if (!this.callbackNonce) {
      return null;
    }

    if (Date.now() - this.callbackNonce.mintedAt >= RegistrationService.CALLBACK_NONCE_TTL_MS) {
      this.callbackNonce = null;

      return null;
    }

    return this.callbackNonce.value;
  }

  /**
   * Whether this Hub is registered and actually serving, which is the state in
   * which a registration callback must be refused.
   *
   * Deliberately narrower than {@link isRegistered}: a Hub degraded by a missing
   * tunnel token is registered, but pairing again is how it recovers, and the
   * headless setup service completes that pairing through the callback.
   */
  public async isRegisteredAndServing(): Promise<boolean> {
    await this.refreshPhaseFromSources();

    if (requiresPortalRePairing(this._currentPhase, this._degradedReasons)) {
      return false;
    }

    return isOperational(this._currentPhase);
  }

  /** Persists restore intent beyond `sessionStorage` before the device pairs again. */
  public async markRestoreIntent(): Promise<{ success: boolean; message: string }> {
    await this.refreshPhaseFromSources();
    if (isOperational(this._currentPhase)) {
      return {
        success: false,
        message: 'Restore intent is only applicable while the Hub is unregistered',
      };
    }

    await writeRestoreIntent();
    return { success: true, message: 'Restore intent recorded' };
  }

  /**
   * Clears local registration artifacts for a fresh device pairing.
   *
   * An operational registration prevents this destructive preparation.
   */
  public async prepareFreshSetup(): Promise<{ success: boolean; message: string; clearedAppEnvFiles: number }> {
    await this.refreshPhaseFromSources();
    if (isOperational(this._currentPhase)) {
      return {
        success: false,
        message: 'Cannot prepare fresh setup while the Hub is registered. Use reset from Settings instead.',
        clearedAppEnvFiles: 0,
      };
    }

    await this.resetRegistration();
    const clearedAppEnvFiles = await clearRegistrationKeysFromAppData(APP_DATA_DIR);
    await clearRegistrationRecoveryArtifacts();

    this.logger.info(`Prepared fresh device setup (cleared registration keys from ${clearedAppEnvFiles} app.env file(s))`);

    return {
      success: true,
      message: 'Local registration artifacts cleared. Pair this device as new in your CI Account.',
      clearedAppEnvFiles,
    };
  }

  /**
   * Returns whether Companion Portal considers the hardware device ID active.
   *
   * Drift detection calls this only while the Hub is locally unregistered, when
   * a device API key is usually absent. Because the check-in endpoint requires
   * device authentication, a missing or invalid key returns `null` rather than a
   * definitive result. A stale but still valid key can produce an answer.
   */
  private async probePortalDeviceActive(deviceId: string, ciCloudUrl: string): Promise<boolean | null> {
    try {
      const { ciHubApiKey } = this.config.getConfig();
      const response = await axios.post(
        `${ciCloudUrl.replace(/\/+$/, '')}/api/devices/check-in`,
        { device_id: deviceId },
        {
          timeout: 10_000,
          validateStatus: () => true,
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), {
            'Content-Type': 'application/json',
            ...(ciHubApiKey ? { 'x-device-key': ciHubApiKey } : {}),
          }),
        },
      );

      if (response.status >= 200 && response.status < 300) {
        return true;
      }
      if (response.status === 400) {
        return false;
      }

      this.logger.debug(`Portal device probe returned ${response.status} for ${deviceId}`);
      return null;
    } catch (e) {
      this.logger.debug('Portal device probe failed', e);
      return null;
    }
  }

  // Cache device-ID resolution because app lifecycle commands, bootstrap, and
  // hourly validation all use the same environment, `dmidecode`,
  // `systeminformation`, sysfs, machine ID, and generated UUID chain. Resolve and
  // log those probes once per process.
  private deviceIdPromise?: Promise<string>;

  public async getDeviceId(): Promise<string> {
    if (!this.deviceIdPromise) {
      this.deviceIdPromise = this.resolveDeviceId().catch((err) => {
        this.deviceIdPromise = undefined;
        throw err;
      });
    }

    return this.deviceIdPromise;
  }

  private async resolveDeviceId(): Promise<string> {
    return resolveDeviceId({
      dataDir: DATA_DIR,
      logger: this.logger,
    });
  }

  private deviceIdHostBinding?: DeviceIdHostBinding;

  /**
   * Whether `DEVICE_ID` was generated on this machine. Memoized like {@link getDeviceId}: the
   * environment and the host's machine ID cannot change under a running process.
   */
  public getDeviceIdHostBinding(): DeviceIdHostBinding {
    this.deviceIdHostBinding ??= checkDeviceIdHostBinding({
      envDeviceId: process.env.DEVICE_ID,
      allowForeign: process.env[ALLOW_FOREIGN_DEVICE_ID_ENV],
    });
    return this.deviceIdHostBinding;
  }

  /** The refusal message when this Hub must not pair under its `DEVICE_ID`, or `null` when it may. */
  private foreignDeviceIdRefusal(): string | null {
    const binding = this.getDeviceIdHostBinding();
    if (binding.status !== 'foreign') {
      return null;
    }
    this.logger.warn(`Refusing to pair with Portal. ${binding.message}`);
    return binding.message;
  }

  private hasTunnelToken(): boolean {
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    try {
      const stat = fs.statSync(tokenPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private async isTunnelTokenUserCleared(): Promise<boolean> {
    try {
      await fs.promises.access(tunnelUserClearedMarkerPath());
      return true;
    } catch {
      return false;
    }
  }

  public async isRegistered(): Promise<boolean> {
    await this.refreshPhaseFromSources();
    return isOperational(this._currentPhase);
  }

  private async verifyLicense() {
    // Reserve the bootstrap step until license verification is implemented.
    return;
  }

  private async pollRegistration() {
    this.logger.info('Starting registration check loop...');

    const check = async () => {
      if (isOperational(this._currentPhase)) {
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
        return;
      }

      try {
        const registered = await this.checkRegistrationWithCloud();
        if (registered) {
          this.logger.info('Device successfully registered!');
          if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
          }
          this.startPeriodicValidation();
        } else {
          this.logger.debug('Device not yet registered, retrying in 30s...');
        }
      } catch (error) {
        this.logger.error('Error checking registration status:', error);
      }
    };

    // Check immediately before starting the interval.
    await check();

    // Continue polling only while registration remains incomplete.
    if (!isOperational(this._currentPhase)) {
      this.checkInterval = setInterval(check, 30000);
    }
  }

  /**
   * Checks local database state for a completed registration.
   *
   * `completeRegistrationFromCallback` receives registration from Companion
   * Portal, so no remote poll is required. This method waits for that callback to
   * persist complete credentials.
   */
  private async checkRegistrationWithCloud(): Promise<boolean> {
    const { ciCloudUrl } = this.config.getConfig();

    // Preserve backward compatibility by allowing local access without a
    // configured Companion Portal.
    if (!ciCloudUrl) {
      this.logger.debug('CI Cloud not configured, skipping registration check.');
      if (!isOperational(this._currentPhase)) {
        await this.setPhase('locally_ready');
      }
      return true;
    }

    try {
      // The Companion Portal callback writes registration state to the local
      // database. Wait until it has created a complete row.
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org?.tunnelToken) {
        this.logger.debug('checkRegistrationWithCloud: no local registration record yet, waiting for CI Portal callback');
        return false;
      }

      // Require every field used by `setupOrganizationInfrastructure`. The
      // callback can still be writing an incomplete row, so let polling retry
      // instead of provisioning with empty values.
      if (!org.tunnelId || !org.tunnelToken || !org.hubSubdomain || !org.name || !org.slug) {
        this.logger.debug(
          'checkRegistrationWithCloud: local registration exists but is incomplete (missing tunnelId/subdomain/name/slug), waiting for callback to finish',
        );
        return false;
      }

      if (!isOperational(this._currentPhase)) {
        this.logger.info('checkRegistrationWithCloud: found complete local registration, setting up infrastructure');
        const config = this.config.getConfig();
        await this.setupOrganizationInfrastructure(org.id, {
          organization_name: org.name,
          tunnel_id: org.tunnelId,
          tunnel_token: org.tunnelToken,
          subdomain: org.hubSubdomain,
          slug: org.slug,
          domain: config.domain,
        });
      }

      return true;
    } catch (error) {
      this.logger.error('Error checking local registration state:', error);
      return false;
    }
  }

  /**
   * Configures the organization's Cloudflare tunnel, DNS, and public subdomain.
   *
   * @param organizationId Organization ID from Companion Portal.
   * @param activationResult Organization and tunnel details returned by activation.
   */
  private async setupOrganizationInfrastructure(
    organizationId: string,
    activationResult: { organization_name: string; tunnel_id: string; tunnel_token: string; slug: string; subdomain: string; domain?: string },
  ): Promise<void> {
    // Update an existing row in place so provisioning retries remain idempotent.
    const existingOrg = await this.deviceRegistrationRepository.getDeviceRegistrationById(organizationId);
    if (existingOrg) {
      this.logger.debug(`Organization infrastructure already exists for ${organizationId}`);

      const updates: Record<string, string> = {};

      // Registration can refresh tunnel credentials for an existing organization.
      if (activationResult?.tunnel_id && activationResult?.tunnel_token) {
        this.logger.info(`Updating organization ${organizationId} with tunnel credentials from registration`);
        updates.tunnelId = activationResult.tunnel_id;
        updates.tunnelToken = activationResult.tunnel_token;
      }

      // Backfill `hubSubdomain` on rows created before the field existed.
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

      // Restore the Traefik route for the Hub's public hostname.
      const hubSub = existingOrg.hubSubdomain ?? updates.hubSubdomain;
      const domainForRoute = this.config.getConfig().domain;
      if (hubSub && domainForRoute && domainForRoute !== 'example.com') {
        await this.traefikConfigService.writeHubRoute(hubSub, domainForRoute);
      }

      // An idempotent retry must leave existing infrastructure operational.
      if (!isOperational(this._currentPhase)) {
        await this.setPhase('locally_ready', [], organizationId);
      }
      return;
    }

    // Provisioning begins only after the device reaches the paired phase.
    await this.setPhase('provisioning', [], organizationId);

    try {
      const { userSettings } = this.config.getConfig();
      const rootDomain = userSettings.domain;

      // Resolve organization and tunnel details from the activation result.
      let orgName: string | null = null;
      let tunnelId: string | null = null;
      let tunnelToken: string | null = null;
      let orgSlug: string | null = null;
      let subdomain: string | null = null;

      // Validate each required activation field before changing infrastructure.
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

      // Write the Traefik route before tunnel initialization so the first
      // Cloudflare-forwarded redirect can reach the Hub.
      if (subdomain && correctDomain && correctDomain !== 'example.com') {
        await this.traefikConfigService.writeHubRoute(subdomain, correctDomain);
      }

      // Configure the tunnel with credentials from Companion Portal.
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
        // Preserve the organization row even when tunnel startup fails so local
        // registration state remains consistent and can recover later.
      }

      if (!orgName) {
        throw new Error('Organization name is required to create device registration');
      }

      if (!orgSlug) {
        throw new Error('Organization slug is required to create device registration');
      }

      // Store `hubSubdomain` as the canonical Hub routing prefix assigned by
      // Companion Portal. Do not derive it from `DOMAIN` or `userSettings.domain`,
      // which identify the root domain.
      await this.deviceRegistrationRepository.createDeviceRegistration({
        id: organizationId,
        slug: orgSlug,
        name: orgName,
        hubSubdomain: subdomain,
        tunnelId: tunnelId,
        tunnelToken: tunnelToken,
        provisioningPhase: 'locally_ready',
      });

      // The persisted organization makes the Hub locally operational.
      await this.setPhase('locally_ready', [], organizationId);

      this.logger.info(`Successfully setup organization infrastructure: ${domain} (tunnel: ${tunnelId})`);

      // Persist the root domain in the data environment. `DOMAIN` and
      // `userSettings.domain` construct app hostnames, while
      // `device_registration.hubSubdomain` defines the Hub route identity.
      if (correctDomain && correctDomain !== 'example.com') {
        await this.config.setDomain(correctDomain);
      }

      // Companion Portal's `/devices/register` owns the initial Hub DNS and tunnel
      // route, so this path does not call `syncState`. Later calls to
      // `triggerCloudflareSync` include the Hub in every app synchronization.

      // Verify tunnel connectivity without blocking local registration.
      if (process.env.E2E_TEST === 'true') {
        this.logger.info(`Skipping tunnel reachability probe for E2E registration at https://${domain}`);
        await this.setPhase('publicly_ready', [], organizationId);
      } else {
        this.logger.info(`Checking tunnel connectivity at https://${domain}...`);
        const maxRetries = 60; // 1 minute
        let tunnelReachable = false;
        for (let i = 0; i < maxRetries; i++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            /*
             * Request `/api/health` with GET because routes that do not support
             * HEAD can return 404 even when the Hub is reachable.
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
        if (tunnelReachable) {
          await this.setPhase('publicly_ready', [], organizationId);
        } else {
          this.logger.warn(
            `Tunnel not yet reachable at https://${domain} after ${maxRetries}s — DNS may still be propagating. This is normal for first-time setup.`,
          );
          // Keep `locally_ready`; periodic validation probes the tunnel again.
        }
      }
    } catch (error) {
      this.logger.error(`Error setting up organization infrastructure: ${error}`);
      // A provisioning failure leaves existing phases unchanged but degrades an
      // active provisioning attempt.
      if (this._currentPhase === 'provisioning') {
        await this.setPhase('degraded', ['tunnel_unreachable'], organizationId);
      }
    }
  }

  /** Returns registration information for the current Companion Hub. */
  public async getDeviceRegistrationInfo() {
    // Prefer the explicitly configured organization.
    const { ciHubOrganizationId } = this.config.getConfig();
    if (ciHubOrganizationId) {
      const deviceRegistration = await this.deviceRegistrationRepository.getDeviceRegistrationById(ciHubOrganizationId);
      if (deviceRegistration) {
        return deviceRegistration;
      }
    }

    // Manual registration can omit the configured ID. The Hub supports one
    // registration, so the first row is authoritative.
    return this.deviceRegistrationRepository.getFirstDeviceRegistration();
  }

  /**
   * Pairs a device atomically with a pairing code.
   *
   * Send the code and device ID to Companion Portal, persist the returned state,
   * and mark the device as registered.
   */
  public async pairDevice(pairingCode: string): Promise<{ success: boolean; message: string; domain?: string; subdomain?: string }> {
    const { ciCloudUrl, ciHubApiKey } = this.config.getConfig();

    if (!ciCloudUrl) {
      return { success: false, message: 'CI Cloud URL not configured.' };
    }

    // Before Portal is called: once Portal binds the code to a copied device ID, the damage is to the
    // other Hub's registration, and nothing on this side can undo it.
    const foreignDeviceId = this.foreignDeviceIdRefusal();
    if (foreignDeviceId) {
      return { success: false, message: foreignDeviceId };
    }

    const deviceId = await this.getDeviceId();
    if (!deviceId) {
      return { success: false, message: 'Device ID not found. Please ensure your device is properly initialized.' };
    }

    // Prevent pairing from replacing an operational registration.
    const alreadyRegistered = await this.isRegistered();
    if (alreadyRegistered) {
      return { success: false, message: 'Device is already registered.' };
    }

    try {
      const pairUrl = `${this.config.getOutboundCiCloudUrl()}/api/devices/pair`;
      /*
       * A pairing code proves organization membership, not which machine is
       * calling, so the Portal refuses to re-key an existing device row without
       * proof of possession (CI-Portal#688). `ciHubApiKey` is that proof: the
       * device credential from the last pair, which survives `resetRegistration`
       * and is what the Hub already sends as `x-device-key` on check-in. A Hub
       * that holds none is a first pair or has genuinely lost it, and the Portal
       * answers those with `DEVICE_PROOF_REQUIRED` and owner-led re-registration.
       */
      const response = await axios.post(
        pairUrl,
        { pairing_code: pairingCode, device_id: deviceId, ...(ciHubApiKey ? { device_key: ciHubApiKey } : {}) },
        {
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), { 'Content-Type': 'application/json' }),
          validateStatus: () => true,
          timeout: 15_000,
        },
      );

      if (response.status === 429) {
        const message = rateLimitedWaitCopy(response.headers);
        this.logger.warn(`Portal pairing rate-limited: ${message}`);
        return { success: false, message };
      }

      if (response.status < 200 || response.status >= 300) {
        const errorData = (response.data ?? { error: 'Unknown error' }) as { error?: string; message?: string };
        this.logger.warn(`Portal pairing request failed: status=${response.status} body=${describePortalPairingResponse(response.data)}`);
        return {
          success: false,
          message: errorData.error || errorData.message || `Pairing failed: HTTP ${response.status}`,
        };
      }

      const data = (response.data ?? {}) as {
        device_id: string;
        organization_id: string;
        organization_name: string;
        slug: string;
        subdomain: string;
        tunnel_id: string;
        tunnel_token: string;
        api_key: string;
        domain: string;
      };

      if ((data as { success?: boolean }).success === false) {
        const errorData = data as { error?: string; message?: string };
        this.logger.warn(`Portal pairing request was rejected: status=${response.status} body=${describePortalPairingResponse(response.data)}`);
        return {
          success: false,
          message: errorData.error || errorData.message || 'Pairing failed.',
        };
      }

      // Reject incomplete Portal responses before persisting registration state.
      if (!data.organization_id || !data.tunnel_id || !data.tunnel_token || !data.subdomain || !data.slug) {
        this.logger.warn(`Portal pairing response was incomplete: status=${response.status} body=${describePortalPairingResponse(response.data)}`);
        return {
          success: false,
          message: 'Portal returned incomplete registration data.',
        };
      }

      // Reuse the callback path so pairing and redirected registration persist the
      // same fields and phase transitions.
      return await this.completeRegistrationFromCallback({
        deviceId: data.device_id || deviceId,
        organizationId: data.organization_id,
        organizationName: data.organization_name || 'Organization',
        slug: data.slug,
        subdomain: data.subdomain,
        tunnelId: data.tunnel_id,
        tunnelToken: data.tunnel_token,
        apiKey: data.api_key,
        domain: data.domain,
      });
    } catch (error) {
      this.logger.error(`Pairing request failed before local registration completed: ${describeRegistrationError(error)}`);
      if (isPortalUnreachableError(error)) {
        return { success: false, message: 'Unable to reach CI Portal. Please check your network connection.' };
      }
      return {
        success: false,
        message: `Pairing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Starts manual organization registration from the registration form.
   *
   * The flow registers the device with Companion Portal, validates the
   * organization identity, creates Cloudflare tunnel and DNS state, and stores
   * the registration locally.
   */
  public async initiateRegistration(
    organizationId: string,
    organizationName: string,
    customDeviceId?: string,
    customDescription?: string,
  ): Promise<{ success: boolean; message: string }> {
    const { ciCloudUrl, ciHubApiKey } = this.config.getConfig();

    if (!ciCloudUrl) {
      return {
        success: false,
        message: 'CI Cloud URL not configured. Please set CI_CLOUD_URL environment variable.',
      };
    }

    if (!organizationName?.trim()) {
      return {
        success: false,
        message: 'Organization name is required.',
      };
    }

    // Normalize the organization name for use as a slug.
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
      // Prefer an explicit device ID and otherwise use the hardware-derived value.
      const deviceId = customDeviceId?.trim() || (await this.getDeviceId());
      // Only the environment's ID is judged. An ID the operator typed into the form is their decision.
      const foreignDeviceId = customDeviceId?.trim() ? null : this.foreignDeviceIdRefusal();
      if (foreignDeviceId) {
        return { success: false, message: foreignDeviceId };
      }
      const description = customDescription?.trim() || `CI OS Hub Device - ${deviceId}`;

      this.logger.info(`Starting device registration: device_id=${deviceId}, organization_id=${organizationId}, organization_name=${sanitizedName}`);

      // Register the device through Companion Portal's `/api/devices/register`.
      const registerUrl = `${this.config.getOutboundCiCloudUrl()}/api/devices/register`;
      const registerHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (ciHubApiKey) {
        registerHeaders.Authorization = `Bearer ${ciHubApiKey}`;
      }

      this.logger.debug(`Registering device at ${registerUrl}`);
      const registerResponse = await axios.post(
        registerUrl,
        {
          device_id: deviceId,
          organization_id: organizationId,
          description: description,
        },
        {
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), registerHeaders),
          validateStatus: () => true,
          timeout: 15_000,
        },
      );

      if (registerResponse.status < 200 || registerResponse.status >= 300) {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        const errorData = (registerResponse.data ?? { error: 'Unknown error' }) as any;
        this.logger.error(`Device registration failed: ${registerResponse.status} - ${JSON.stringify(errorData)}`);
        return {
          success: false,
          message: `Registration failed: ${errorData.error || registerResponse.statusText}`,
        };
      }

      const registerResult = registerResponse.data ?? {};
      this.logger.info(`Device registered successfully: ${JSON.stringify(registerResult)}`);

      // The registration endpoint now returns the organization details that the
      // former activation step provided.

      const activateResult = registerResult; // Retain the activation-shaped input expected below.
      this.logger.info(`Device activated successfully (merged): ${JSON.stringify(activateResult)}`);

      // Keep the normalized name available for compatibility with the existing
      // registration flow.
      const _finalOrgName = sanitizedName;

      // Companion Portal now validates and provisions the Cloudflare identity
      // during infrastructure setup. A separate preflight would require a
      // Portal validation endpoint.

      // Enter `paired` before infrastructure setup. The `paired` and
      // `provisioning` phases remain in memory until a database row exists. If the
      // process stops during setup, it starts as `unregistered` and can retry.
      await this.setPhase('paired');

      await this.setupOrganizationInfrastructure(organizationId, {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        ...(activateResult as any),
        organization_name: organizationName,
        slug: sanitizedName,
      });

      // Infrastructure setup owns the remaining phase transitions.
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      // The database remains the durable source for the organization ID.
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
   * Completes registration from a Companion Portal callback.
   *
   * The callback returns the device, organization, routing, tunnel, and optional
   * API-key details to Companion Hub.
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
  }): Promise<{ success: boolean; message: string; domain?: string; subdomain?: string }> {
    try {
      // Reject callbacks for a different hardware device.
      const currentDeviceId = await this.getDeviceId();
      if (data.deviceId !== currentDeviceId) {
        this.logger.warn(`Device ID mismatch: expected ${currentDeviceId}, got ${data.deviceId}`);
        return {
          success: false,
          message: 'Device ID mismatch. Registration failed.',
        };
      }

      // Persist the optional device API key for authenticated Portal requests.
      if (data.apiKey) {
        this.logger.info('Saving CI Hub API Key from registration callback');
        await this.config.setUserSettings({ ciHubApiKey: data.apiKey });
      }

      // Persist the organization ID for future Portal disambiguation.
      if (data.organizationId) {
        this.logger.info('Saving CI Hub Organization ID from registration callback');
        await this.config.setUserSettings({ ciHubOrganizationId: data.organizationId });
      }

      // Use the subdomain already validated by Companion Portal. It can represent
      // an organization prefix or a device-and-organization slug.
      const incomingSubdomain = data.subdomain.trim();

      if (!incomingSubdomain) {
        return {
          success: false,
          message: 'Invalid subdomain received from CI Cloud.',
        };
      }

      // Enter `paired` so the frontend can display provisioning progress.
      await this.setPhase('paired');
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      // Persist the root domain before responding so the frontend builds the
      // redirect from the registered value.
      const currentDomain = this.config.getConfig().domain;
      const rootDomain = data.domain || currentDomain;
      if (rootDomain && rootDomain !== 'example.com' && rootDomain !== currentDomain) {
        await this.config.setDomain(rootDomain);
      }

      // Start Cloudflare tunnel and DNS setup without holding the callback open
      // while external infrastructure converges.
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

      await clearRehydrationState();

      return {
        success: true,
        message: 'Device registered successfully',
        domain: rootDomain,
        subdomain: incomingSubdomain,
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
