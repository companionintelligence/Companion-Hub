import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown, Inject, forwardRef, Optional } from '@nestjs/common';
import axios from 'axios';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { APP_DATA_DIR, DATA_DIR, TUNNEL_DIR, tunnelUserClearedMarkerPath } from '@/common/constants';
import { buildPortalAxiosConfig, readPortalInternalUrlOverride, withPortalAxiosHeaders } from '@/common/helpers/portal-url';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../docker/traefik-config.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import {
  type ProvisioningPhase,
  type DegradedReason,
  type RegistrationStatus,
  PROVISIONING_PHASES,
  isOperational,
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
import si from 'systeminformation';

const PERIODIC_VALIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLOUD_VALIDATION_THROTTLE_MS = 30 * 1000;
const BOOTSTRAP_VALIDATION_TIMEOUT_MS = 10 * 1000;
const PHASE_READ_CACHE_TTL_MS = 30 * 1000;

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
    @Inject(forwardRef(() => TraefikConfigService)) private readonly traefikConfigService: TraefikConfigService,
    private readonly deviceRegistrationRepository: DeviceRegistrationRepository,
    readonly _repoQueue: RepoEventsQueue,
    @Optional() private readonly agentNotifyService?: AgentNotifyService,
  ) {}

  private portalAxiosConfig() {
    const { ciCloudUrl } = this.config.getConfig();
    return buildPortalAxiosConfig(ciCloudUrl, readPortalInternalUrlOverride());
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
    // Before checking full registration status, try to recover the tunnel
    // token file from the database. isRegistered() requires both a DB record
    // AND the token file on disk, so we must restore the file first.
    const tunnelRecovered = await this.recoverTunnelTokenFromDb();

    // Ensure CloudflareClientService has the token in memory (for getTunnelToken() / app-context).
    // After a restart, the token file may exist on disk but CloudflareClientService starts with null.
    await this.ensureCloudflareClientHasTunnelToken();

    // Covers the "registered-before, Hub restarted" case: recoverTunnelTokenFromDb
    // only spawns cloudflared when the token file is missing, so without this call
    // the public hub-*.$DOMAIN hostname stays DNS-resolvable but the tunnel is dead.
    await this.cloudflareClientService.ensureCloudflaredRunning({ forceRestart: tunnelRecovered });

    // Ensure Traefik has a route for the hub's public hostname (e.g. devbox-core1.companionintelligence.com)
    // so requests through the Cloudflare tunnel reach ci-os-hub.
    await this.ensureHubRouteFromRegistration();

    // Sync in-memory phase from persisted DB state
    await this.syncPhaseFromDb();

    if (isOperational(this._currentPhase)) {
      await this.verifyLicense();

      // Log a warning if tunnelId is missing — hub can still operate but some
      // features (e.g. tunnel config updates) may not work until re-paired.
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

  // ---------------------------------------------------------------------------
  // Phase helpers
  // ---------------------------------------------------------------------------

  /**
   * Sync the in-memory phase from the persisted DB row.
   * Detects disk-level degradation (e.g. missing tunnel token) and
   * transitions accordingly.
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

      // If the DB says we should be operational, verify the tunnel token is on disk.
      // Sync the in-memory phase first so the transition from an operational phase
      // to 'degraded' is legal (unregistered → degraded is not).
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
   * Transition to a new provisioning phase. Persists to DB if an org exists
   * and updates the in-memory cache. Logs the transition.
   */
  public async setPhase(to: ProvisioningPhase, reasons: DegradedReason[] = [], orgId?: string): Promise<void> {
    const from = this._currentPhase;

    // Allow idempotent no-ops — except degraded→degraded which may update reasons
    if (from === to && to !== 'degraded') return;

    if (!isLegalTransition(from, to)) {
      this.logger.warn(`Illegal phase transition ${from} → ${to} — ignoring`);
      return;
    }

    this._currentPhase = to;
    this._degradedReasons = to === 'degraded' ? reasons : [];

    this.logger.info(`Provisioning phase: ${from} → ${to}${reasons.length ? ` (${reasons.join(', ')})` : ''}`);

    // Notify agent of phase transitions
    const urgency = to === 'degraded' ? 'high' : 'medium';
    this.agentNotifyService?.notify('registration.state_changed', { from, to, reasons }, urgency as 'high' | 'medium');

    // Persist when we know the org ID
    const id = orgId ?? (await this.deviceRegistrationRepository.getFirstDeviceRegistration())?.id;
    if (id) {
      await this.deviceRegistrationRepository.updateProvisioningState(id, to, this._degradedReasons).catch((e) => {
        this.logger.warn('Failed to persist provisioning phase', e);
      });
    }

    this.phaseReadCachedAt = Date.now();
  }

  /** Return the current in-memory registration status snapshot. */
  public getRegistrationStatus(): RegistrationStatus {
    return buildRegistrationStatus(this._currentPhase, this._degradedReasons);
  }

  /**
   * Return the current in-memory registration status snapshot.
   * Schedules a background refresh from durable sources (DB + disk) when the
   * read cache is stale; callers get the cached phase immediately.
   */
  public async getLiveRegistrationStatus(): Promise<RegistrationStatus> {
    this.schedulePhaseRefreshFromSources();
    await this.maybeValidateWithCloud();
    return this.getRegistrationStatus();
  }

  /** Refresh phase from DB/disk in the background when the read cache is stale. */
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
        // Throttle retries even when refresh fails so status polls don't hammer DB/disk.
        this.phaseReadCachedAt = Date.now();
        this.phaseRefreshInFlight = null;
      });
  }

  /**
   * Throttled, deduped Portal check-in for status endpoints.
   * Non-fatal when Portal is unreachable.
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

    // Never block status/API handlers on Portal or tunnel probes — return the
    // last-known phase immediately while validation runs in the background.
  }

  /**
   * Single source of truth for refreshing the in-memory phase from DB + disk.
   * Called by getLiveRegistrationStatus() and isRegistered().
   *
   * Rules:
   *  1. If the in-memory phase is already operational AND the tunnel token
   *     exists on disk → keep the current phase (fast path).
   *  2. If operational but the token is missing AND there is no DB row →
   *     reset to unregistered.
   *  3. If operational but the token is missing AND there IS a DB row →
   *     transition to degraded.
   *  4. If not operational → check the DB; if an org exists with the token
   *     on disk, sync the DB phase into memory.
   */
  private async refreshPhaseFromSources(): Promise<void> {
    if (isOperational(this._currentPhase)) {
      if (this.hasTunnelToken()) return;

      const hasOrg = await this.deviceRegistrationRepository.hasAnyDeviceRegistration().catch((error) => {
        this.logger.debug('Could not check organization in database:', error);
        return true; // Assume org exists so we don't wipe state on transient DB errors
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

    // Not currently operational — check DB for an existing registration
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
   * If the DB has a registered org with tunnel credentials but the token file
   * is missing on disk, re-write it. This covers container restarts, volume
   * resets, and dev-mode scenarios.
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
   * Load tunnel token from disk into CloudflareClientService memory.
   * After a restart, the token file exists but CloudflareClientService.tunnelToken is null.
   * This ensures getTunnelToken() returns correctly for /app-context (cloudflareAvailable).
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
   * Logs a warning if the org record is missing its tunnelId.
   * We no longer attempt a cloud round-trip here — if the hub is operational
   * (token file + DB record present) cloudflared is running and requests are
   * being served regardless of what's stored in the tunnelId column.
   * A missing tunnelId will be re-populated naturally on the next full
   * re-pairing or when CI Portal pushes a state update via the callback.
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
   * Validates the current registration against CI Cloud.
   * Checks that the tunnel token file still exists, the device_id matches,
   * and the device status in CI Cloud is 'active'.
   * Only transitions to 'degraded' after 3 consecutive failures to tolerate
   * transient network issues.
   */
  private async validateRegistrationWithCloud(): Promise<void> {
    if (!isOperational(this._currentPhase)) return;

    if (!this.hasTunnelToken()) {
      this.logger.warn('Registration validation: tunnel token missing — transitioning to degraded');
      await this.setPhase('degraded', ['tunnel_token_missing']);
      return;
    }

    // Re-sync CloudflareClientService from disk so getTunnelToken() stays correct
    await this.ensureCloudflareClientHasTunnelToken();

    const { ciCloudUrl } = this.config.getConfig();
    if (!ciCloudUrl) return;

    try {
      const deviceId = await this.getDeviceId();

      // Use the existing unauthenticated check-in endpoint to confirm the
      // device is still active in CI Portal. A 400 means the device is no
      // longer active; network errors are counted toward the failure threshold.
      const response = await axios.post(
        `${this.config.getOutboundCiCloudUrl()}/api/devices/check-in`,
        { device_id: deviceId },
        {
          timeout: 5_000,
          validateStatus: () => true,
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), { 'Content-Type': 'application/json' }),
        },
      );

      if (response.status === 400) {
        // 400 is definitive — device was removed or deactivated in CI Portal.
        this.consecutiveValidationFailures = 0;
        this.logger.warn('Registration validation: device is no longer active in CI Portal (400) — clearing local registration for re-pairing');
        await this.resetRegistration({ reason: 'portal_rejected' });
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        // Transient failure (5xx, etc.) — count toward the 3-strike threshold.
        this.consecutiveValidationFailures++;
        this.logger.warn(`Registration validation: CI Portal check-in returned ${response.status} (failure ${this.consecutiveValidationFailures}/3)`);
        if (this.consecutiveValidationFailures >= 3) {
          await this.setPhase('degraded', ['cloud_validation_failed']);
        }
        return;
      }

      this.consecutiveValidationFailures = 0;

      // Validation passed — recover from degraded if applicable
      if (this._currentPhase === 'degraded') {
        this.logger.info('Registration validation passed — recovering from degraded');
        await this.setPhase('locally_ready');
      } else {
        this.logger.info('Registration validation passed: device is active in CI Portal');
      }

      // Best-effort tunnel reachability logging — never block validation completion.
      if (this._currentPhase === 'locally_ready') {
        void this.logPublicHostnameReachability().catch((error) => {
          this.logger.debug(`Registration validation: public hostname probe failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (e) {
      // Network/timeout errors are transient — count toward the 3-strike threshold.
      this.consecutiveValidationFailures++;
      this.logger.error(`Registration validation: failed to reach CI Portal (failure ${this.consecutiveValidationFailures}/3)`, e);
      if (this.consecutiveValidationFailures >= 3) {
        await this.setPhase('degraded', ['cloud_validation_failed']);
      }
    }
  }

  /** Log-only probe for tunnel DNS/HTTPS reachability — must not block request handlers. */
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
   * Reset device registration to allow re-pairing.
   * Clears in-memory state, database records, tunnel token, and resolved env.
   */
  public async resetRegistration(options?: { reason?: 'manual' | 'portal_rejected' }): Promise<void> {
    const reason = options?.reason ?? 'manual';
    if (reason === 'portal_rejected') {
      this.logger.info('Clearing local device registration after CI Portal rejected check-in');
    } else {
      this.logger.info('Resetting device registration...');
    }

    // Transition via setPhase so the change is logged consistently.
    // Reset → unregistered is always a legal transition.
    await this.setPhase('unregistered');

    // Stop validation intervals
    if (this.periodicValidationInterval) {
      clearInterval(this.periodicValidationInterval);
      this.periodicValidationInterval = null;
    }

    // Delete the device_registration records from the database
    await this.deviceRegistrationRepository.deleteAll();

    // Delete the tunnel token file from disk
    const tokenPath = path.join(TUNNEL_DIR, 'token');
    try {
      await fs.promises.unlink(tokenPath);
    } catch {
      // File may not exist
    }

    // Clear the resolved env file so it regenerates
    const resolvedEnvPath = path.join(DATA_DIR, 'state', '.env.resolved');
    try {
      await fs.promises.unlink(resolvedEnvPath);
    } catch {
      // File may not exist
    }

    await clearRehydrationState();

    this.logger.info('Device registration reset complete');

    // Start polling for new registration
    this.pollRegistration();
  }

  /**
   * Detect when local Hub registration artifacts disagree with CI Portal or
   * persisted app-data. Only meaningful while the Hub is unregistered locally.
   */
  public async getStateDrift(): Promise<RegistrationStateDrift> {
    await this.refreshPhaseFromSources();
    const status = this.getRegistrationStatus();
    const hardwareDeviceId = await this.getDeviceId();

    // Portal may reflect the device immediately after pairing while local provisioning
    // is still in progress — that is expected registration flow, not drift.
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

  /** Persist server-side restore intent before re-pairing (survives beyond sessionStorage). */
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
   * Wipe local registration artifacts so the user can pair as a fresh device.
   * Allowed only while the Hub is unregistered (no operational registration).
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
      message: 'Local registration artifacts cleared. Pair this device as new in your Companion Account.',
      clearedAppEnvFiles,
    };
  }

  /** Unauthenticated Portal probe — true when hardware device_id is active in CI Portal. */
  private async probePortalDeviceActive(deviceId: string, ciCloudUrl: string): Promise<boolean | null> {
    try {
      const response = await axios.post(
        `${ciCloudUrl.replace(/\/+$/, '')}/api/devices/check-in`,
        { device_id: deviceId },
        {
          timeout: 10_000,
          validateStatus: () => true,
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), { 'Content-Type': 'application/json' }),
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

  // Memoized device-id resolution. The detection chain (dmidecode →
  // systeminformation → /sys → /etc/machine-id) is invoked on every app
  // lifecycle command, bootstrap restart, and hourly validation; resolving it
  // once per process avoids re-running (and re-logging) the same probes.
  // Failures are not cached so a later call can retry.
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
    const envDeviceId = process.env.DEVICE_ID?.trim();
    if (envDeviceId) {
      this.logger.debug(`Device ID from DEVICE_ID env var: ${envDeviceId}`);
      return envDeviceId;
    }

    try {
      const serial = execSync('dmidecode -s system-serial-number', {
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();

      const invalidSerials = [
        'not specified',
        'to be filled by o.e.m.',
        'default string',
        'system serial number',
        'chassis serial number',
        'none',
        'na',
        'n/a',
        '0',
        '',
      ];
      if (serial && !invalidSerials.includes(serial.toLowerCase())) {
        this.logger.debug(`Device ID from dmidecode: ${serial}`);
        return serial;
      }

      this.logger.debug(`dmidecode returned unusable value: "${serial}", falling back to systeminformation`);
    } catch (e) {
      // Expected on platforms without dmidecode (e.g. macOS) — not a real error.
      this.logger.debug('dmidecode unavailable, falling back to systeminformation', e);
    }

    const uuid = await si.uuid().catch(() => ({ hardware: '' }));

    const id = uuid.hardware;
    if (id && id !== '00000000-0000-0000-0000-000000000000') {
      this.logger.debug(`Device ID from systeminformation: ${id}`);
      return id;
    }

    // Fallback: read hardware UUID directly (same as systeminformation's si.uuid().hardware)
    try {
      return fs.readFileSync('/sys/class/dmi/id/product_uuid', 'utf-8').trim();
    } catch (e) {
      // Linux-only path; absent on macOS — expected, keep at debug.
      this.logger.debug('Could not read /sys/class/dmi/id/product_uuid', e);
    }

    // Last resort: /etc/machine-id
    try {
      return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    } catch (e) {
      this.logger.debug('Could not read /etc/machine-id', e);
    }

    throw new Error('Unable to determine device ID from any source');
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
    // License verification is not currently implemented
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

    // Initial check
    await check();

    // Start interval if not registered
    if (!isOperational(this._currentPhase)) {
      this.checkInterval = setInterval(check, 30000);
    }
  }

  /**
   * Checks whether registration is complete by inspecting local DB state.
   * Registration arrives via the CI Portal callback (completeRegistrationFromCallback)
   * — there is nothing to poll cloud for. This function simply checks whether
   * the callback has already populated the local DB with valid credentials.
   */
  private async checkRegistrationWithCloud(): Promise<boolean> {
    const { ciCloudUrl } = this.config.getConfig();

    // If CI Cloud API is not configured, allow access (backward compatibility)
    if (!ciCloudUrl) {
      this.logger.debug('CI Cloud not configured, skipping registration check.');
      if (!isOperational(this._currentPhase)) {
        await this.setPhase('locally_ready');
      }
      return true;
    }

    try {
      // Registration state lives in the local DB and is written by the CI Portal
      // callback. Check whether a complete registration record exists locally.
      const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
      if (!org?.tunnelToken) {
        this.logger.debug('checkRegistrationWithCloud: no local registration record yet, waiting for CI Portal callback');
        return false;
      }

      // We have a local registration — require all fields needed by
      // setupOrganizationInfrastructure before proceeding. If any are absent
      // (callback may still be in progress), return false and let the poll
      // loop retry rather than calling infra setup with empty strings.
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
   * Setup Cloudflare tunnel and DNS for the organization
   * Creates organization subdomain: {orgName}.{domain}
   * @param organizationId - Organization ID from CI Cloud
   * @param activationResult - Result from device activation (may contain org details)
   */
  private async setupOrganizationInfrastructure(
    organizationId: string,
    activationResult: { organization_name: string; tunnel_id: string; tunnel_token: string; slug: string; subdomain: string; domain?: string },
  ): Promise<void> {
    // Check if organization infrastructure already exists (idempotent retry)
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

      // Ensure phase is at least locally_ready for idempotent retries
      if (!isOperational(this._currentPhase)) {
        await this.setPhase('locally_ready', [], organizationId);
      }
      return;
    }

    // Transition: paired → provisioning
    await this.setPhase('provisioning', [], organizationId);

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
        provisioningPhase: 'locally_ready',
      });

      // Hub is locally functional — transition to locally_ready
      await this.setPhase('locally_ready', [], organizationId);

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
        if (tunnelReachable) {
          await this.setPhase('publicly_ready', [], organizationId);
        } else {
          this.logger.warn(
            `Tunnel not yet reachable at https://${domain} after ${maxRetries}s — DNS may still be propagating. This is normal for first-time setup.`,
          );
          // Stay at locally_ready — tunnel will be probed again during validation
        }
      }
    } catch (error) {
      this.logger.error(`Error setting up organization infrastructure: ${error}`);
      // Transition to degraded if we were provisioning
      if (this._currentPhase === 'provisioning') {
        await this.setPhase('degraded', ['tunnel_unreachable'], organizationId);
      }
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
   * Pair device using a pairing code — atomic registration in one step.
   * Sends pairing code + device_id to Portal's POST /api/devices/pair,
   * stores all returned data locally, and marks the device as registered.
   */
  public async pairDevice(pairingCode: string): Promise<{ success: boolean; message: string; domain?: string; subdomain?: string }> {
    const { ciCloudUrl } = this.config.getConfig();

    if (!ciCloudUrl) {
      return { success: false, message: 'CI Cloud URL not configured.' };
    }

    const deviceId = await this.getDeviceId();
    if (!deviceId) {
      return { success: false, message: 'Device ID not found. Please ensure your device is properly initialized.' };
    }

    // Check if already registered
    const alreadyRegistered = await this.isRegistered();
    if (alreadyRegistered) {
      return { success: false, message: 'Device is already registered.' };
    }

    try {
      const pairUrl = `${this.config.getOutboundCiCloudUrl()}/api/devices/pair`;
      const response = await axios.post(
        pairUrl,
        { pairing_code: pairingCode, device_id: deviceId },
        {
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), { 'Content-Type': 'application/json' }),
          validateStatus: () => true,
          timeout: 15_000,
        },
      );

      if (response.status < 200 || response.status >= 300) {
        const errorData = (response.data ?? { error: 'Unknown error' }) as { error?: string };
        return {
          success: false,
          message: errorData.error || `Pairing failed: HTTP ${response.status}`,
        };
      }

      const data = response.data as {
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

      // Validate required fields from Portal response
      if (!data.organization_id || !data.tunnel_id || !data.tunnel_token || !data.subdomain || !data.slug) {
        return {
          success: false,
          message: 'Portal returned incomplete registration data.',
        };
      }

      // Use completeRegistrationFromCallback which already handles all the storage logic
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
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return { success: false, message: 'Unable to reach CI Portal. Please check your network connection.' };
      }
      return {
        success: false,
        message: `Pairing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
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
      // Transition to paired before infrastructure setup.
      // Note: paired/provisioning are transient in-memory phases — no DB row
      // exists yet, so this won't survive a restart. If the process crashes
      // during setup, it re-enters as unregistered and retries.
      await this.setPhase('paired');

      await this.setupOrganizationInfrastructure(organizationId, {
        // biome-ignore lint/suspicious/noExplicitAny: External API response
        ...(activateResult as any),
        organization_name: organizationName,
        slug: sanitizedName,
      });

      // setupOrganizationInfrastructure handles phase transitions internally
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
  }): Promise<{ success: boolean; message: string; domain?: string; subdomain?: string }> {
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

      // Transition to paired — the frontend can already detect forward progress
      await this.setPhase('paired');
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
