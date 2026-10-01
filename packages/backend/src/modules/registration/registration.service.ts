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
import { describeNetworkError } from '@/common/helpers/network-error';
import { rateLimitedWaitCopy } from '@/common/helpers/retry-after';
import { CloudflareClientService } from '../cloudflare/cloudflare-client.service';
import { type TunnelHealth, TunnelHealthService } from '../cloudflare/tunnel-health.service';
import { PORTAL_GRANT_DENIED_CODE } from '@/core/portal/portal-client.service';
import { TraefikConfigService } from '../docker/traefik-config.service';
import { DeviceRegistrationRepository } from './device-registration.repository';
import { RepoEventsQueue } from '../queue/entities/repo-events';
import { AgentNotifyService } from '../agent-notify/agent-notify.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import {
  type ProvisioningPhase,
  type DegradedReason,
  type RegistrationCheckIn,
  type RegistrationPhaseReport,
  type RegistrationStatus,
  PROVISIONING_PHASES,
  isOperational,
  requiresPortalRePairing,
  isLegalTransition,
  isActiveRegistrationPhase,
  buildRegistrationStatus,
  parseDegradedReasons,
  sameDegradedReasons,
} from './registration-state';
import {
  buildStateDriftResult,
  clearRegistrationKeysFromAppData,
  collectStaleHubDeviceIds,
  type RegistrationStateDrift,
} from './registration-state-drift';
import {
  clearRegistrationRecoveryArtifacts,
  clearRehydrationState,
  writePairingAppCheck,
  writeRestoreIntent,
} from '../app-lifecycle/registration-recovery-state';
import { buildCheckInPayload } from './check-in-payload';
import {
  type CheckInOutcome,
  type CheckInRegistration,
  type CheckInVerdict,
  classifyCheckInResponse,
  describeCheckInTransportError,
  isCheckInForCurrentRegistration,
  isDeviceNotActiveResponse,
} from './check-in-response';
import { resolveDeviceId, clearRegisteredDeviceId, persistRegisteredDeviceId } from './device-id.resolver';
import { ALLOW_FOREIGN_DEVICE_ID_ENV, checkDeviceIdHostBinding, type DeviceIdHostBinding } from './device-id-host-check';
import {
  hasTunnelLeftoverMarker,
  removeTunnelLeftoverMarker,
  removeTunnelRegistrationMarker,
  tunnelIdFromToken,
  tunnelTokenPath,
  writeTunnelLeftoverMarker,
  writeTunnelRegistrationMarker,
} from './tunnel-markers';
import { ModuleRef } from '@nestjs/core';
import { AuthService } from '@/modules/auth/auth.service';
import { PortalPushKeyService } from './portal-push-key.service';
import { describePublicReachability, probePublicHostname } from './public-reachability';

const PERIODIC_VALIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const CLOUD_VALIDATION_THROTTLE_MS = 30 * 1000;
const BOOTSTRAP_VALIDATION_TIMEOUT_MS = 10 * 1000;
const PHASE_READ_CACHE_TTL_MS = 30 * 1000;
/** Per step of each registration-time probe, which retries every second for a minute. */
const REGISTRATION_PROBE_TIMEOUT_MS = 2 * 1000;
/**
 * How long registration probes the public URL before leaving the Hub `locally_ready` for check-ins
 * to promote. A clock, not a count of attempts: one attempt that goes around this host's resolver
 * takes up to three steps of `REGISTRATION_PROBE_TIMEOUT_MS`, and `register` waits for this loop.
 */
const REGISTRATION_PROBE_WINDOW_MS = 60 * 1000;
/**
 * How long a `publicly_ready` Hub's public URL must go on failing its probe before the Hub reports
 * `degraded` (`tunnel_unreachable`). One failed probe is not a verdict: `cloudflared` reconnecting
 * or an edge blip fails one too. Ten minutes matches `PORTAL_REJECTION_CONFIRM_MS`, and on the
 * fleet's 15-minute check-in cadence it confirms on the second failed probe.
 */
export const PUBLIC_UNREACHABLE_CONFIRM_MS = 10 * 60 * 1000;

/**
 * How long to wait for `POST /api/devices/pair`.
 *
 * This is not a read: the Portal claims the pairing code first, then lists/adopts or CREATES a
 * Cloudflare tunnel and writes a DNS record. Overshooting costs the code — it is claimed before
 * any of that work and is not given back — so 60s is deliberately generous rather than tuned to
 * the staging run behind it, where a from-scratch tunnel reached Cloudflare at 13.8s and the
 * rest of the request still followed.
 *
 * What a bigger budget does NOT buy: the Portal writes the device's new api_key only in its
 * final update, after the tunnel and DNS work, so a response lost after that point strands a key
 * this Hub never receives however long we wait. Only that last window is unrecoverable; widen
 * this value to avoid spending codes, not to avoid that.
 *
 * Keep every caller's own deadline above this one, or it reports a failure for a pair the Hub
 * goes on to complete: see `submitPairingCode` in `scripts/lib/register-hub.ts` and the
 * cross-domain registration e2e. That ordering is a margin, not a guarantee — see the caveat
 * below. The Hub's own `httpServer.requestTimeout` is not such a deadline
 * (`hub-pool-proxy-timeout.test.ts` pins that it does not cut a slow response), and Traefik
 * responds up to 300s.
 *
 * Caveat: this bounds a response that STALLS, not one that trickles. axios hands the value to
 * follow-redirects, which clears its wall-clock timer once headers arrive and leaves a socket
 * idle timeout; a body arriving in chunks keeps resetting it. Verified against the resolved
 * axios, and unchanged from the previous 15s — a property of the transport, not of this number.
 */
const PORTAL_PAIR_TIMEOUT_MS = 60 * 1000;

/**
 * How long Portal must go on rejecting the device key before the Hub reports `portal_rejected`.
 *
 * One rejection is not a verdict. CI-Portal's `deviceAuthMiddleware` answers the same
 * `401 { code: 'UNAUTHORIZED' }` when `DeviceService.findByApiKey` fails (`!result.ok`, a D1 read
 * error) as when no device holds the key, so a Portal database blip would otherwise mark every Hub
 * that checked in during it `portal_rejected`, tell every owner to pair again, and reopen pairing
 * fleet-wide. A removal does not heal: on 2026-09-17 the five affected Hubs had been rejected for
 * between one day and a week. Ten minutes is a policy choice, not a measurement: longer than a
 * blip, and on the fleet's 15-minute check-in cadence it confirms on the second rejected check-in.
 */
export const PORTAL_REJECTION_CONFIRM_MS = 10 * 60 * 1000;

/**
 * What one removal-watch check tells the Settings page.
 *
 * - `removed`: the Hub is no longer registered, because the Portal answered `DEVICE_NOT_ACTIVE` and
 *   the Hub reset, or because it was already unregistered.
 * - `still_registered`: the Portal still accepts this device.
 * - `key_refused`: the Portal refuses the device key. Nothing was reset, and watching longer will
 *   not change that.
 * - `not_checked`: the Portal could not be asked or did not give a usable answer. Keep watching.
 */
export type RemovalWatchResult = 'removed' | 'still_registered' | 'key_refused' | 'not_checked';

function describeRegistrationError(error: unknown): string {
  if (error instanceof Error) {
    return scrubString(error.stack || error.message);
  }

  return scrubString(String(error));
}

/**
 * The syscalls that fail before any byte of the request is on the wire. Node
 * names the failing syscall on the underlying error and axios 1.18 keeps it on
 * `cause` rather than copying it up, so this is the only positive proof we get
 * that the Portal never saw the request.
 */
const PORTAL_CONNECT_SYSCALLS = new Set(['getaddrinfo', 'connect']);

/**
 * Errno codes only a failed connection attempt produces, for the case where a
 * wrapper stripped `cause`. `ETIMEDOUT` is deliberately absent: it is both the
 * OS connect timeout and what axios reports for its own expired deadline when
 * `transitional.clarifyTimeoutError` is on, so with no `connect` syscall to go
 * by it proves nothing either way.
 */
const PORTAL_CONNECT_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * How far a thrown Portal call got. Portal calls set `validateStatus: () => true`,
 * so a refusal is an answer rather than a throw: anything thrown failed below HTTP.
 *
 * - `never_reached` — the connection attempt itself failed, so nothing was sent
 *   and the pairing code is untouched. The fault is on this side.
 * - `no_answer` — everything else, including our own expired deadline. The
 *   request may be sitting at the Portal: pairing provisions a Cloudflare tunnel
 *   and a DNS record there, and the Portal claims the pairing code before that
 *   work starts (companionintelligence/CI-Portal#748).
 *
 * The two are NOT separable by errno, which is why `no_answer` names both
 * possibilities to the operator instead of asserting one. Measured against axios
 * 1.18: a deadline that expires while the SYN goes unanswered and one that
 * expires while the Portal provisions are byte-identical — both `AxiosError`,
 * `code: 'ECONNABORTED'`, `message: 'timeout of Nms exceeded'`, no `cause`, and
 * both with a non-zero `socket.bytesWritten`. Claiming a bare `ECONNABORTED`
 * means the Portal was reached sends firewalled operators away from the one
 * thing at fault.
 */
function classifyPortalTransportFailure(error: unknown): 'never_reached' | 'no_answer' | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const candidate = error as { isAxiosError?: boolean; code?: unknown; cause?: { syscall?: unknown; errors?: unknown } };
  if (candidate.isAxiosError !== true) {
    return null;
  }

  // Node tried every address the name resolved to, and none accepted the connection. Its
  // `AggregateError` has no syscall, and its code is the first attempt's: `ETIMEDOUT` when that
  // attempt ran out of time, which alone would read as `no_answer` and send the operator for a new
  // pairing code although nothing was sent. Each attempt names the syscall that failed.
  const attempts = candidate.cause?.errors;
  if (Array.isArray(attempts) && attempts.length > 0) {
    const neverConnected = attempts.every(
      (attempt: { syscall?: unknown } | null) => typeof attempt?.syscall === 'string' && PORTAL_CONNECT_SYSCALLS.has(attempt.syscall),
    );
    return neverConnected ? 'never_reached' : 'no_answer';
  }

  const syscall = candidate.cause?.syscall;
  if (typeof syscall === 'string') {
    return PORTAL_CONNECT_SYSCALLS.has(syscall) ? 'never_reached' : 'no_answer';
  }

  return typeof candidate.code === 'string' && PORTAL_CONNECT_FAILURE_CODES.has(candidate.code) ? 'never_reached' : 'no_answer';
}

/**
 * What a `no_answer` pairing failure tells the operator. It names both
 * possibilities on purpose: the errno cannot separate "the Portal has the
 * request and is still provisioning" from "nothing this machine sent ever
 * arrived", and asserting either one sends half the operators who see it to the
 * wrong place.
 */
const PORTAL_NO_ANSWER_PAIRING_MESSAGE =
  'CI Portal did not answer in time. It may still be provisioning this Hub, or this machine may not be reaching it. Get a new pairing code before trying again.';

function describePortalPairingResponse(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return scrubString(String(data));
  }

  const body = data as Record<string, unknown>;
  const safeBody = {
    error: typeof body.error === 'string' ? body.error : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
    code: typeof body.code === 'string' ? body.code : undefined,
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

/**
 * The WhoIs subject the leftover-device probe sends. Portal user IDs are
 * generated, so no user has this one, and the Portal refuses it before it
 * reads any organization data.
 */
const DEVICE_KEY_PROBE_SUBJECT = 'ci-hub-device-key-probe';

/** What a pairing attempt reports to the registration page. */
export type PairDeviceResult = {
  success: boolean;
  message: string;
  /**
   * The Portal's machine-readable refusal code, such as `DEVICE_PROOF_REQUIRED`,
   * when its answer carries one. The page chooses its guidance by this code and
   * shows `message` when the code is absent or unknown, as it is from older
   * Portals and from anything in front of the Portal.
   */
  code?: string;
  /**
   * The organization a refused pairing would have joined, when the Portal names
   * it: with `DEVICE_MOVE_CONFIRMATION_REQUIRED`, the one the page asks the
   * person to move this Hub into.
   */
  organizationName?: string;
  domain?: string;
  subdomain?: string;
};

function portalRefusalCode(data: unknown): { code?: string; organizationName?: string } {
  const body = data && typeof data === 'object' ? (data as { code?: unknown; organization_name?: unknown }) : {};
  return {
    ...(typeof body.code === 'string' && body.code ? { code: body.code } : {}),
    ...(typeof body.organization_name === 'string' && body.organization_name ? { organizationName: body.organization_name } : {}),
  };
}

@Injectable()
export class RegistrationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private _currentPhase: ProvisioningPhase = 'unregistered';
  private _degradedReasons: DegradedReason[] = [];
  private checkInterval: NodeJS.Timeout | null = null;
  private periodicValidationInterval: NodeJS.Timeout | null = null;
  private consecutiveValidationFailures = 0;
  private lastCloudValidationAt = 0;
  private cloudValidationInFlight: Promise<CheckInOutcome> | null = null;
  private lastCheckInOutcome: CheckInOutcome | null = null;
  /**
   * Changes whenever the registration row is cleared or written, so a check-in that was sent for an
   * earlier registration is not acted on. See `isCheckInForCurrentRegistration`.
   */
  private registrationGeneration = 0;
  private phaseReadCachedAt = 0;
  private phaseRefreshInFlight: Promise<void> | null = null;
  /** What the last check-in came back with; read by `GET /registration/phase` without sending one. */
  private lastCheckIn: RegistrationCheckIn | null = null;
  /** When Portal first rejected the key in the current run of rejections; cleared by an accepted check-in. */
  private portalRejectedSince: number | null = null;
  /** The tunnel check could not finish, so the next registration check runs it again. */
  private tunnelCheckPending = false;
  /** An unregistered Hub still needs its `cloudflared` container removed. */
  private tunnelStopPending = false;
  /** The public-URL probe in flight, shared so status polling every 30 s never stacks them. */
  private publicReachabilityInFlight: Promise<void> | null = null;
  /** When a `publicly_ready` Hub's public URL first failed its probe in the current run of failures. */
  private publicUnreachableSince: number | null = null;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    @Inject(forwardRef(() => CloudflareClientService)) private readonly cloudflareClientService: CloudflareClientService,
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

  /**
   * Lazily, and optional: the check-in must not depend on the key store being wired, and the
   * service's tests build this class without it.
   */
  private portalPushKey(): PortalPushKeyService | null {
    try {
      return this.moduleRef?.get(PortalPushKeyService, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

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

    // Read the registration before anything touches the tunnel. `isRegistered()`
    // requires both a database row and the on-disk token, so a registered Hub
    // restores its token here first.
    await this.syncTunnelWithRegistration();

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
      // `unregistered` cannot transition directly to `degraded`. The persisted
      // reasons come along so `setPhase` compares against what is stored, not
      // against whatever this process last held.
      if (isOperational(persisted) && !this.hasTunnelToken()) {
        this.logger.warn('Tunnel token missing — transitioning to degraded');
        this._currentPhase = persisted;
        this._degradedReasons = parseDegradedReasons(org.degradedReasons);
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

    // Skip idempotent transitions, including `degraded` re-asserted with the same
    // reasons. Every failed check-in re-asserts it, and each pass used to rewrite the
    // row and send the agent a high-urgency `registration.state_changed` for a state
    // that had not changed: core-4 logged "degraded → degraded" on every check-in,
    // 130 of them in a row by 2026-09-15.
    if (from === to && (to !== 'degraded' || sameDegradedReasons(this._degradedReasons, reasons))) return;

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
   * The registration status and the last check-in, read without side effects.
   *
   * `getLiveRegistrationStatus` is not an observation: past its 30 s throttle it
   * sends a check-in, which writes Portal's `last_seen`, and it can move the
   * phase. Fleet preflight polled it on 16 Hubs to find out whether each was
   * healthy, and every poll of a registered Hub sent a check-in that stamped it
   * as seen. This reads memory only: no database, no disk, no Portal.
   */
  public getRegistrationPhaseReport(): RegistrationPhaseReport {
    return {
      ...this.getRegistrationStatus(),
      lastCheckIn: this.lastCheckIn ? { ...this.lastCheckIn } : null,
      consecutiveCheckInFailures: this.consecutiveValidationFailures,
    };
  }

  private recordCheckIn(httpStatus: number | null, verdict: Pick<CheckInVerdict, 'code' | 'error'>): void {
    this.lastCheckIn = { at: new Date().toISOString(), httpStatus, code: verdict.code, error: verdict.error };
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
    this.startThrottledCloudValidation();

    // Return the last known phase immediately so Portal and tunnel probes never
    // block status handlers.
  }

  /**
   * Starts the shared check-in unless one ran in the last 30 seconds.
   *
   * Returns the check-in in flight (a new one or one another caller started), or `null` when the
   * throttle or the phase means no check-in is sent now.
   */
  private startThrottledCloudValidation(): Promise<CheckInOutcome> | null {
    if (!isOperational(this._currentPhase)) {
      return null;
    }

    const { ciCloudUrl } = this.config.getConfig();
    if (!ciCloudUrl) {
      return null;
    }

    if (this.cloudValidationInFlight) {
      return this.cloudValidationInFlight;
    }

    const now = Date.now();
    if (this.lastCloudValidationAt > 0 && now - this.lastCloudValidationAt < CLOUD_VALIDATION_THROTTLE_MS) {
      return null;
    }

    this.cloudValidationInFlight = this.validateRegistrationWithCloud()
      .catch((e): CheckInOutcome => {
        this.logger.error('Registration validation check failed', e);
        return 'failed';
      })
      .finally(() => {
        this.lastCloudValidationAt = Date.now();
        this.cloudValidationInFlight = null;
      });

    return this.cloudValidationInFlight;
  }

  /**
   * One check for the Settings page while it waits for the person to delete this Hub in the Portal.
   *
   * The page calls this about every 15 seconds. It shares the status poll's 30-second throttle and
   * in-flight request, so it never adds Portal traffic beyond one check-in per 30 seconds; a call
   * the throttle skips reports what the last check-in said. Removal itself happens inside the
   * check-in, which resets the Hub only on the Portal's `DEVICE_NOT_ACTIVE` answer.
   */
  public async checkForRemoval(): Promise<RemovalWatchResult> {
    const inFlight = this.startThrottledCloudValidation();
    const outcome = inFlight ? await inFlight : this.lastCheckInOutcome;

    if (!isOperational(this._currentPhase)) {
      return 'removed';
    }

    switch (outcome) {
      case 'active':
        return 'still_registered';
      case 'key_refused':
        return 'key_refused';
      default:
        return 'not_checked';
    }
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
   * Makes the tunnel connector follow the registration in the database.
   *
   * A token file proves nothing by itself. It survives an uninstall, so a
   * reinstalled Hub would otherwise connect to the previous Hub's tunnel before
   * anyone pairs it. A registered Hub gets its marker, its token, and a running
   * connector. An unregistered Hub has its connector stopped and any leftover
   * token removed. If the database cannot be read, nothing is started or
   * stopped, and the next registration check tries again.
   */
  private async syncTunnelWithRegistration(): Promise<void> {
    let registration: Awaited<ReturnType<DeviceRegistrationRepository['getFirstDeviceRegistration']>>;
    try {
      registration = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    } catch (error) {
      this.tunnelCheckPending = true;
      this.logger.warn(`Could not read the registration; leaving the tunnel as it is until the next check: ${describeRegistrationError(error)}`);
      return;
    }

    if (!registration) {
      await this.stopUnregisteredTunnel();
      return;
    }

    this.tunnelCheckPending = false;
    this.tunnelStopPending = false;

    // Existing installs predate the marker, so boot writes it for them.
    await this.markTunnelRegistered(registration.tunnelId);

    const tunnelRecovered = await this.recoverTunnelTokenFromDb();

    // Reload the token into `CloudflareClientService` because the file survives a
    // restart while its in-memory `getTunnelToken()` state does not.
    await this.ensureCloudflareClientHasTunnelToken();

    // `recoverTunnelTokenFromDb` starts `cloudflared` only when the token file is
    // missing. Ensure it also runs after a registered Hub restarts with an existing
    // file, or the public hostname could resolve while its tunnel remains down.
    await this.cloudflareClientService.ensureCloudflaredRunning({ forceRestart: tunnelRecovered });
  }

  /** Runs the tunnel check again when an earlier one could not finish. */
  private async retryPendingTunnelCheck(): Promise<void> {
    if (this.tunnelCheckPending) {
      await this.syncTunnelWithRegistration();
    }
  }

  /**
   * Stops `cloudflared` on a Hub with no registration, and moves a leftover token
   * out of reach of the desktop app, the CLI, and this backend.
   *
   * `leftover.json` keeps the tunnel ID so the registration page can still offer
   * to reconnect this Hub after the token is gone.
   */
  private async stopUnregisteredTunnel(): Promise<void> {
    // A pairing writes its token before its registration row exists, and it can
    // start or finish while this check waits on Docker. Act only while the Hub
    // is still unregistered, or the new token would be deleted as a leftover.
    if (this._currentPhase !== 'unregistered') {
      return;
    }

    // `registration.json` without a registration is stale. Beside a token that
    // comes back later, it would let the desktop app and CLI start that token's
    // tunnel before this check runs again.
    await this.unmarkTunnelRegistered();

    const token = await this.readTunnelToken();
    if (this._currentPhase !== 'unregistered') {
      return;
    }
    if (!token && !this.tunnelStopPending) {
      this.tunnelCheckPending = false;
      return;
    }

    const stopped = await this.cloudflareClientService.stopTunnel();
    this.tunnelStopPending = !stopped;
    this.tunnelCheckPending = !stopped;

    if (!token || this._currentPhase !== 'unregistered') {
      return;
    }

    this.logger.warn('Found a tunnel token with no registration; stopped cloudflared and removed the token. Pair this Hub to connect it again.');

    try {
      await writeTunnelLeftoverMarker(tunnelIdFromToken(token));
    } catch (error) {
      this.logger.warn(`Could not record the leftover tunnel: ${describeRegistrationError(error)}`);
    }

    // Remove the token even without the marker: a token left behind is what lets
    // an unregistered Hub start the previous Hub's tunnel.
    try {
      await fs.promises.unlink(tunnelTokenPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.logger.warn(`Could not remove the leftover tunnel token: ${describeRegistrationError(error)}`);
      }
    }
  }

  /** Records that the tunnel token belongs to a registration. Boot rewrites a marker that failed to write. */
  private async markTunnelRegistered(tunnelId: string | null | undefined): Promise<void> {
    try {
      await writeTunnelRegistrationMarker(tunnelId ?? null);
    } catch (error) {
      this.logger.warn(`Could not write the tunnel registration marker: ${describeRegistrationError(error)}`);
    }
  }

  /** Removes `registration.json`, so the desktop app and CLI no longer start the tunnel from the token. */
  private async unmarkTunnelRegistered(): Promise<void> {
    try {
      await removeTunnelRegistrationMarker();
    } catch (error) {
      this.logger.warn(`Could not remove the tunnel registration marker: ${describeRegistrationError(error)}`);
    }
  }

  /**
   * Marks the saved registration's token as registered and forgets any earlier
   * leftover tunnel. A stale `leftover.json` would otherwise offer "Reconnect
   * this Hub" again the next time this registration is reset.
   */
  private async markRegistrationSaved(tunnelId: string | null | undefined): Promise<void> {
    await this.markTunnelRegistered(tunnelId);
    try {
      await removeTunnelLeftoverMarker();
    } catch (error) {
      this.logger.warn(`Could not remove the leftover tunnel marker: ${describeRegistrationError(error)}`);
    }
  }

  private async readTunnelToken(): Promise<string | null> {
    try {
      return (await fs.promises.readFile(tunnelTokenPath(), 'utf-8')).trim() || null;
    } catch {
      return null;
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
  private async validateRegistrationWithCloud(): Promise<CheckInOutcome> {
    const outcome = await this.checkInWithCloud();
    this.lastCheckInOutcome = outcome;
    return outcome;
  }

  private async checkInWithCloud(): Promise<CheckInOutcome> {
    if (!isOperational(this._currentPhase)) return 'skipped';

    // A registered Hub whose boot-time registration read failed starts its tunnel here.
    await this.retryPendingTunnelCheck();

    if (!this.hasTunnelToken()) {
      this.logger.warn('Registration validation: tunnel token missing — transitioning to degraded');
      await this.setPhase('degraded', ['tunnel_token_missing']);
      return 'skipped';
    }

    // Refresh the in-memory token so `getTunnelToken()` matches durable state.
    await this.ensureCloudflareClientHasTunnelToken();

    const { ciCloudUrl, ciHubApiKey, version } = this.config.getConfig();
    if (!ciCloudUrl) return 'skipped';

    const sentFor = this.currentCheckInRegistration();

    try {
      const deviceId = await this.getDeviceId();

      // Best-effort: piggyback what this node knows about itself on the check-in this method
      // already sends every hour, rather than adding a second round trip to Portal. See
      // `check-in-payload.ts` for the rules that govern the body, and `CheckIn.ts` on the Portal
      // side for the field-absent-vs-blank contract they follow.
      const diagnostics = await this.collectCheckInDiagnostics();
      const pushKeyService = this.portalPushKey();
      const pushKey = pushKeyService ? await pushKeyService.checkInFields() : null;

      // Confirm that Companion Portal still considers the device active. The
      // check-in endpoint authenticates with the registered device's
      // `x-device-key`. `classifyCheckInResponse` says which answers are verdicts:
      // only a 400 coded `DEVICE_NOT_ACTIVE` clears the registration, a refused key
      // degrades the Hub once Portal keeps refusing it, and everything else —
      // including an uncoded 400 — counts toward the transient-failure threshold.
      const response = await axios.post(
        `${this.config.getOutboundCiCloudUrl()}/api/devices/check-in`,
        buildCheckInPayload({
          deviceId,
          hubVersion: version,
          phase: this._currentPhase,
          degradedReasons: this._degradedReasons,
          ...diagnostics,
          pushKey,
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

      const verdict = classifyCheckInResponse(response.status, response.data);
      this.recordCheckIn(response.status, verdict);

      if (isDeviceNotActiveResponse(response)) {
        // The answer is about the key this check-in sent. If the Hub was reset or paired again while
        // it was in flight, that key is no longer this Hub's, and resetting would clear the new registration.
        if (!isCheckInForCurrentRegistration(sentFor, this.currentCheckInRegistration())) {
          this.logger.warn(
            'Registration validation: ignoring DEVICE_NOT_ACTIVE for a registration this Hub replaced while the check-in was in flight',
          );
          return 'skipped';
        }

        // The Portal deleted or deactivated this device (someone removed it there). This coded answer
        // is the only one that clears the registration, and the Settings removal watch is waiting for
        // it. A refused key, below, is not it: that one keeps the registration and the tunnel.
        this.consecutiveValidationFailures = 0;
        this.logger.warn(
          'Registration validation: device is no longer active in CI Portal (DEVICE_NOT_ACTIVE) — clearing local registration for re-pairing',
        );
        await this.resetRegistration({ reason: 'portal_rejected' });
        return 'removed';
      }

      if (verdict.kind === 'rejected') {
        /*
         * Keep everything. Portal's verdict is about the device key, not about the tunnel:
         * cloudflared authenticates with its own token and goes on serving until Cloudflare drops
         * the tunnel, and local apps never needed Portal. Deleting the registration here, as the
         * old 400 path did, turns an owner's action in Portal (or a Portal incident) into a public
         * outage on every Hub that notices it, and pairing again does not need the old
         * registration gone: `requiresPortalRePairing` reopens pairing for this reason.
         *
         * And do not believe the first one. Portal sends this same 401 when it cannot read its
         * device table, so a rejection only becomes `portal_rejected` once Portal has kept it up
         * for `PORTAL_REJECTION_CONFIRM_MS`; until then it counts like any other failure.
         */
        const now = Date.now();
        this.portalRejectedSince ??= now;
        const rejectedForMs = now - this.portalRejectedSince;
        const described = `${verdict.error}${verdict.code ? `, ${verdict.code}` : ''}`;

        if (rejectedForMs >= PORTAL_REJECTION_CONFIRM_MS) {
          this.consecutiveValidationFailures = 0;
          this.logger.warn(
            `Registration validation: CI Portal has rejected this Hub's device key for ${Math.round(rejectedForMs / 60_000)} min (${described}). ` +
              'Pair this Hub again (cihub register --code <code>); its tunnel and local registration are kept.',
          );
          await this.setPhase('degraded', ['portal_rejected']);
          return 'key_refused';
        }

        this.consecutiveValidationFailures++;
        this.logger.warn(
          `Registration validation: CI Portal rejected this Hub's device key (${described}); Portal answers the same way when it ` +
            `cannot read its device table, so this is not acted on until it persists for ${PORTAL_REJECTION_CONFIRM_MS / 60_000} min ` +
            `(failure ${this.consecutiveValidationFailures}/3)`,
        );
        await this.degradeAfterRepeatedFailures();
        return 'key_refused';
      }

      if (verdict.kind !== 'accepted') {
        // Count remote failures, including 5xx responses and a 400 without the
        // `DEVICE_NOT_ACTIVE` code (a schema refusal), toward the three-attempt threshold.
        this.consecutiveValidationFailures++;
        if (verdict.kind === 'refused_body') {
          this.logger.error(
            `Registration validation: CI Portal refused the check-in body (${verdict.error}). This Hub and Portal disagree on the ` +
              `check-in schema; it is not a device removal, so the registration is kept (failure ${this.consecutiveValidationFailures}/3)`,
          );
        } else {
          this.logger.warn(
            `Registration validation: CI Portal check-in returned ${response.status} (failure ${this.consecutiveValidationFailures}/3)`,
          );
        }
        await this.degradeAfterRepeatedFailures();
        return 'failed';
      }

      this.consecutiveValidationFailures = 0;
      this.portalRejectedSince = null;
      this.reconcileOperatorMembershipsAfterCheckIn();
      // Portal's answer names the push key it holds; this is what retires the device key as a bearer.
      await pushKeyService?.acknowledge(response.data);

      // A successful check-in restores a registration degraded by remote failures.
      if (this._currentPhase === 'degraded') {
        this.logger.info('Registration validation passed — recovering from degraded');
        await this.setPhase('locally_ready');
      } else {
        this.logger.info('Registration validation passed: device is active in CI Portal');
      }

      // Probe the public URL without delaying validation. This is what moves a Hub out of
      // `locally_ready` once registration's own one-minute probe has given up, and what notices a
      // `publicly_ready` Hub whose public URL has stopped answering.
      if (this._currentPhase === 'locally_ready' || this._currentPhase === 'publicly_ready') {
        void this.checkPublicReachability().catch((error) => {
          this.logger.debug(`Registration validation: public hostname probe failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      return 'active';
    } catch (e) {
      // Count network and timeout errors toward the transient-failure threshold.
      this.consecutiveValidationFailures++;
      this.recordCheckIn(null, { code: null, error: describeCheckInTransportError(e) });
      const failure = `Registration validation: failed to reach CI Portal (failure ${this.consecutiveValidationFailures}/3): ${describeNetworkError(e)}`;
      // Every status is an answer here, so an axios error is a request that failed below HTTP. The
      // line says why, and its stack would be axios's own frames. Anything else failed on this side
      // and keeps its stack.
      if (classifyPortalTransportFailure(e)) {
        this.logger.error(failure);
      } else {
        this.logger.error(failure, e);
      }
      await this.degradeAfterRepeatedFailures();
      return 'failed';
    }
  }

  /**
   * Three transient failures in a row mean `cloud_validation_failed`, unless Portal has already
   * rejected the key. A later 5xx or timeout is no evidence the key came back, and overwriting
   * `portal_rejected` with a reason that says "wait" would hide the one thing an owner has to do.
   */
  private async degradeAfterRepeatedFailures(): Promise<void> {
    if (this.consecutiveValidationFailures < 3 || this._degradedReasons.includes('portal_rejected')) {
      return;
    }

    await this.setPhase('degraded', ['cloud_validation_failed']);
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

  /**
   * Probes the Hub's public URL: `locally_ready` becomes `publicly_ready` once it answers, and
   * `publicly_ready` becomes `degraded` (`tunnel_unreachable`) once it has stopped answering for
   * `PUBLIC_UNREACHABLE_CONFIRM_MS`.
   *
   * Registration probes for one minute and then leaves the Hub `locally_ready`, so every check-in
   * after that has to ask again. This used to only log. Eighteen hours after the 2026-09-26 fleet
   * rebuild, 16 of 17 Hubs still said `locally_ready` while 13 of them answered 200 at their public
   * URL, and a restart could not help: the phase is persisted and restored as it was.
   *
   * The demotion is what keeps `publicly_ready` true afterwards. Without it a Hub whose tunnel broke
   * after promotion said `publicly_ready` for as long as it ran. The next accepted check-in takes
   * `degraded` back to `locally_ready`, and this probe promotes it again once the URL answers.
   */
  private checkPublicReachability(): Promise<void> {
    this.publicReachabilityInFlight ??= this.runPublicReachabilityCheck().finally(() => {
      this.publicReachabilityInFlight = null;
    });
    return this.publicReachabilityInFlight;
  }

  private async runPublicReachabilityCheck(): Promise<void> {
    const org = await this.deviceRegistrationRepository.getFirstDeviceRegistration();
    const { domain } = this.config.getConfig();

    if (!org?.hubSubdomain || !domain || domain === 'example.com') {
      return;
    }

    const hostname = `${org.hubSubdomain}.${domain}`;
    const generation = this.registrationGeneration;
    const probe = await probePublicHostname(hostname);

    // The probe takes seconds, and a check-in or a re-pair can move the phase meanwhile. An answer
    // about a registration this Hub has since replaced is about nothing.
    if (this.registrationGeneration !== generation) {
      return;
    }

    if (probe.reachable) {
      this.publicUnreachableSince = null;
      // Only `locally_ready` is promoted: `degraded` → `publicly_ready` is a legal transition, and
      // taking it here would erase a degraded reason that a public URL answering does nothing to clear.
      if (this._currentPhase !== 'locally_ready') {
        return;
      }
      this.logger.info(
        `Registration validation: public hostname ${hostname} answered (${describePublicReachability(probe)}) — Hub is publicly ready`,
      );
      await this.setPhase('publicly_ready', [], org.id);
      return;
    }

    if (this._currentPhase !== 'publicly_ready') {
      this.publicUnreachableSince = null;
      this.logger.warn(
        `Registration validation: public hostname ${hostname} not yet reachable (${describePublicReachability(probe)}) — tunnel may still be stabilising`,
      );
      return;
    }

    const now = Date.now();
    this.publicUnreachableSince ??= now;
    const unreachableForMs = now - this.publicUnreachableSince;
    if (unreachableForMs < PUBLIC_UNREACHABLE_CONFIRM_MS) {
      this.logger.warn(
        `Registration validation: public hostname ${hostname} stopped answering (${describePublicReachability(probe)}); ` +
          `the Hub reports tunnel_unreachable if that lasts ${PUBLIC_UNREACHABLE_CONFIRM_MS / 60_000} min`,
      );
      return;
    }

    this.publicUnreachableSince = null;
    this.logger.warn(
      `Registration validation: public hostname ${hostname} has not answered for ${Math.round(unreachableForMs / 60_000)} min ` +
        `(${describePublicReachability(probe)}) — Hub is no longer publicly ready`,
    );
    await this.setPhase('degraded', ['tunnel_unreachable'], org.id);
  }

  /** The device key a check-in sends now, and which registration holds it. */
  private currentCheckInRegistration(): CheckInRegistration {
    return { deviceKey: this.config.getConfig().ciHubApiKey ?? null, registrationGeneration: this.registrationGeneration };
  }

  /**
   * Resets device registration so the appliance can pair again.
   *
   * The reset clears in-memory state, database rows, the tunnel token, and the
   * resolved environment. It never changes the Portal: the device stays in the
   * person's account until an owner or admin deletes it there.
   */
  public async resetRegistration(options?: { reason?: 'manual' | 'portal_rejected' }): Promise<void> {
    // A person resets a registration, or Portal's coded `DEVICE_NOT_ACTIVE` does. A check-in Portal
    // merely rejects degrades the Hub instead; see `validateRegistrationWithCloud`.
    const reason = options?.reason ?? 'manual';
    if (reason === 'portal_rejected') {
      this.logger.info('Clearing local device registration after CI Portal reported the device inactive');
    } else {
      this.logger.info('Resetting device registration...');
    }

    this.registrationGeneration++;

    // Use `setPhase` for consistent logging. Reset to `unregistered` is always legal.
    await this.setPhase('unregistered');
    this.portalRejectedSince = null;
    // The next Portal this Hub pairs with must receive a push key of its own.
    await this.portalPushKey()?.forget();

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

    // Deleting the token does not disconnect a running `cloudflared`, which keeps
    // serving this Hub's hostname until its container stops. A failed stop is
    // retried by the registration check that starts below.
    if (!(await this.cloudflareClientService.stopTunnel())) {
      this.tunnelStopPending = true;
      this.tunnelCheckPending = true;
    }
    await this.unmarkTunnelRegistered();

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
      // duplicate requests.
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
        hasMoveKey: Boolean(this.config.getConfig().ciHubMoveKey),
      });
    }

    const localRegistered = status.registered;

    const staleAppEnvDeviceIds = collectStaleHubDeviceIds(APP_DATA_DIR, hardwareDeviceId);
    // Boot removes a leftover token and records it in `leftover.json`, which must
    // still offer to reconnect this Hub.
    const hasStaleTunnelToken = !localRegistered && (this.hasTunnelToken() || hasTunnelLeftoverMarker());

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
      hasMoveKey: Boolean(this.config.getConfig().ciHubMoveKey),
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
   * tunnel token, or by a device key Portal rejects, is registered, but pairing
   * again is how it recovers, and the headless setup service completes that
   * pairing through the callback.
   */
  public async isRegisteredAndServing(): Promise<boolean> {
    await this.refreshPhaseFromSources();

    if (requiresPortalRePairing(this._currentPhase, this._degradedReasons)) {
      return false;
    }

    return isOperational(this._currentPhase);
  }

  /**
   * Holds app sync until `PairingAppRestoreService` has compared the apps Companion Portal lists for this
   * device with the ones installed here, and restored what is missing.
   *
   * Written before anything of the new registration is, so no sync can slip out first. Pairing back onto
   * an existing device otherwise synced this Hub's current app list, empty after a reinstall, and the
   * Portal released every app the device had. A failure to write is logged and pairing goes on: the
   * Portal has already issued this pairing's device key, and abandoning it here would lose that key.
   */
  private async holdAppSyncForPairingCheck(): Promise<void> {
    try {
      await writePairingAppCheck();
    } catch (error) {
      this.logger.error(`Could not hold app sync for the post-pairing apps check: ${describeRegistrationError(error)}`);
    }
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
    // A fresh setup pairs as a new device; the identity it registered under before goes with the
    // registration, and the resolver derives one from the host again.
    clearRegisteredDeviceId(DATA_DIR);
    this.deviceIdPromise = undefined;
    try {
      await removeTunnelLeftoverMarker();
    } catch (error) {
      this.logger.warn(`Could not remove the leftover tunnel marker: ${describeRegistrationError(error)}`);
    }

    this.logger.info(`Prepared fresh device setup (cleared registration keys from ${clearedAppEnvFiles} app.env file(s))`);

    return {
      success: true,
      message: 'Local registration artifacts cleared. Pair this device as new in your CI Account.',
      clearedAppEnvFiles,
    };
  }

  /**
   * Returns whether Companion Portal still accepts this Hub's stored device key.
   *
   * Drift detection calls this only while the Hub is locally unregistered, and
   * the registration page polls drift every few seconds. Two rules follow:
   *
   * - Without a key there is nothing to ask. The Portal answers keyless device
   *   calls with 401, and it deliberately offers no keyless lookup of whether a
   *   device ID exists (CI-Portal#603).
   * - With a key, ask device WhoIs rather than check-in. Check-in stamps the
   *   device's last-seen time, so probing through it made an unregistered Hub
   *   look online in the Portal. WhoIs only reads. The subject is a name no
   *   Portal user has, so the Portal authenticates the key and then refuses
   *   the subject with `GRANT_DENIED` without reading any organization data.
   *
   * `true` means the key authenticates a device that is not inactive. WhoIs
   * does not name that device, so this trusts the key to belong to this
   * hardware, as pairing does when it sends the key as proof. `null` means the
   * answer is unknown, including a key the Portal rejects: the Portal gives a
   * revoked key, a deleted device, and a mistyped key the same 401.
   */
  private async probePortalDeviceActive(deviceId: string, ciCloudUrl: string): Promise<boolean | null> {
    const deviceKey = (this.config.getConfig().ciHubApiKey ?? '').trim();
    if (!deviceKey) {
      return null;
    }

    try {
      const response = await axios.post(
        `${ciCloudUrl.replace(/\/+$/, '')}/api/whois`,
        { subject: DEVICE_KEY_PROBE_SUBJECT, appIds: [], surface: 'hub' },
        {
          timeout: 10_000,
          validateStatus: () => true,
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), {
            'Content-Type': 'application/json',
            'x-device-key': deviceKey,
          }),
        },
      );

      const body = response.data && typeof response.data === 'object' ? (response.data as { code?: unknown; organizations?: unknown }) : undefined;
      const code = body?.code;
      // A 2xx counts only in WhoIs's own shape. A proxy, captive page or wrong
      // host answering 200 has not authenticated the key.
      const passedDeviceAuth =
        (response.status >= 200 && response.status < 300 && Array.isArray(body?.organizations)) ||
        (response.status === 403 && code === PORTAL_GRANT_DENIED_CODE) ||
        (response.status === 409 && code === 'ORGANIZATION_REQUIRED');

      if (passedDeviceAuth) {
        return true;
      }

      this.logger.debug(`Portal device probe returned ${response.status} for ${deviceId}`);
      return null;
    } catch (e) {
      this.logger.debug(`Portal device probe failed: ${describeNetworkError(e)}`);
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
        await this.retryPendingTunnelCheck();

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
    // Read before any phase change below. A re-pair is a registered Hub that pairing is meant to
    // fix: degraded for a reason only pairing clears, or with a key Portal is rejecting right now
    // (`pairDevice` admits an authenticated caller before the rejection is confirmed).
    const rePairing =
      isOperational(this._currentPhase) && (requiresPortalRePairing(this._currentPhase, this._degradedReasons) || this.portalRejectedSince !== null);

    // A new registration from here on: a check-in still in flight for the old key must not act on
    // Portal's answer about it. See `isCheckInForCurrentRegistration`.
    this.registrationGeneration++;

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
      await this.markRegistrationSaved(updates.tunnelId ?? existingOrg.tunnelId);

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

      // An idempotent retry must leave existing infrastructure operational. A re-pair
      // must also clear the degraded reason that asked for it: `degraded` counts as
      // operational, so without this the Hub went on reporting `portal_rejected`
      // with a fresh key on disk until the next check-in happened to pass.
      if (!isOperational(this._currentPhase) || rePairing) {
        this.consecutiveValidationFailures = 0;
        this.portalRejectedSince = null;
        await this.setPhase('locally_ready', [], organizationId);
        // This path skips the registration loop below, and nothing else probes until the next
        // accepted check-in, up to 15 minutes away. A re-pair into the same organization keeps a
        // hostname that usually answers already.
        void this.checkPublicReachability().catch((error) => {
          this.logger.debug(`Registration: public hostname probe failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return;
    }

    // Only a re-pair of a Hub that needed one may replace the registration it already holds.
    const replacesRegistration = rePairing;
    if (replacesRegistration) {
      this.portalRejectedSince = null;
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

      // A Hub holds one registration. A re-pair into a different organization reaches
      // this branch with the old organization's row still present, and it must go:
      // `getFirstDeviceRegistration` reads rows unordered, so it could keep answering
      // with the old organization, and boot recovery would then write the old tunnel
      // token back over the one this pairing just installed.
      if (replacesRegistration && (await this.deviceRegistrationRepository.hasAnyDeviceRegistration())) {
        this.logger.info(`Replacing the previous organization's registration with ${organizationId}`);
        await this.deviceRegistrationRepository.deleteAll();
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
      await this.markRegistrationSaved(tunnelId);

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
        const generation = this.registrationGeneration;
        const deadline = Date.now() + REGISTRATION_PROBE_WINDOW_MS;
        let tunnelReachable = false;
        for (let i = 0; Date.now() < deadline; i++) {
          /*
           * The same probe the check-in runs. It asks the zone's nameservers first, so polling a name
           * Portal has not published yet never plants the NXDOMAIN this Hub's resolver would then
           * repeat for 30 minutes, and it goes around a cached NXDOMAIN something else planted, which
           * a Hub paired again under a just-deleted, re-created hostname sees for that long.
           */
          const probe = await probePublicHostname(domain, { timeoutMs: REGISTRATION_PROBE_TIMEOUT_MS });
          if (probe.reachable) {
            this.logger.info(`Hub is reachable at https://${domain} (${describePublicReachability(probe)})`);
            tunnelReachable = true;
            break;
          }
          if (i % 10 === 0) {
            this.logger.debug(`Waiting for DNS/SSL propagation... ${describePublicReachability(probe)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (i > 0 && i % 10 === 0) this.logger.info(`Still waiting for DNS resolution... attempt ${i}`);
        }
        if (!tunnelReachable) {
          this.logger.warn(
            `Tunnel not yet reachable at https://${domain} after ${REGISTRATION_PROBE_WINDOW_MS / 1000}s — DNS may still be propagating. This is normal for first-time setup.`,
          );
          // Keep `locally_ready`; every passing check-in probes again (`checkPublicReachability`).
        } else if (this._currentPhase === 'locally_ready' && this.registrationGeneration === generation) {
          // The loop runs for a minute and a check-in can move the phase meanwhile: three failed
          // ones make it `degraded`, and a re-pair starts another registration. Promote only what
          // the loop started with, for the same reason `runPublicReachabilityCheck` does.
          await this.setPhase('publicly_ready', [], organizationId);
        } else if (this._currentPhase !== 'publicly_ready') {
          this.logger.info(`Hub is reachable at https://${domain}, but the registration is ${this._currentPhase} now; leaving it to the check-in`);
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
  public async pairDevice(
    pairingCode: string,
    options: {
      callerAuthenticated?: boolean;
      /**
       * The person's yes to `DEVICE_MOVE_CONFIRMATION_REQUIRED`: this Hub is in another organization,
       * and pairing here moves it, taking it from that organization. The Portal only acts on it with
       * the device key and move key this request already sends as proof.
       */
      confirmMove?: boolean;
    } = {},
  ): Promise<PairDeviceResult> {
    const { ciCloudUrl, ciHubApiKey, ciHubMoveKey } = this.config.getConfig();

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

    // Prevent pairing from replacing a registration that is serving. A Hub degraded
    // for a reason only pairing clears must be allowed through: refused here, a
    // `portal_rejected` Hub had no way back except a reset that deletes its tunnel
    // token, and the frontend's `tunnel_token_missing` pairing form dead-ended on
    // "Device is already registered."
    const serving = await this.isRegisteredAndServing();

    /*
     * `POST /registration/pair` is unauthenticated, because a Hub being set up has nobody to log
     * in as. A registered Hub does, and re-pairing one replaces its organization, device key and
     * tunnel with whatever the pairing code names. Letting through anyone who can reach this port
     * (the LAN, or the public hostname while the old tunnel still serves) would let them move the
     * Hub into an organization of their choosing, and this Hub attaches its own device key to the
     * request as proof of possession, so Portal would accept it. Before this route admitted
     * degraded Hubs it refused every registered one, so asking for the caller `reset` requires
     * costs nobody a working path: a Hub session, or the host-local device key or CLI token that
     * `cihub register` sends.
     *
     * That caller may also re-pair a Hub whose key Portal is rejecting right now but has not yet
     * rejected for `PORTAL_REJECTION_CONFIRM_MS`. Otherwise an owner who updates a Hub and runs
     * `cihub register --code` straight away, the remedy in `docs/portal-check-in.md`, is refused for
     * ten minutes after every restart, because the confirmation window restarts with the process.
     */
    if (serving && !(options.callerAuthenticated && this.portalRejectedSince !== null)) {
      return { success: false, message: 'Device is already registered.' };
    }

    if (isOperational(this._currentPhase) && !options.callerAuthenticated) {
      return {
        success: false,
        message: 'This Hub is already registered. Sign in to pair it again, or run `cihub register --code <code>` on the Hub itself.',
      };
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
        {
          pairing_code: pairingCode,
          device_id: deviceId,
          ...(ciHubApiKey ? { device_key: ciHubApiKey } : {}),
          // With the device key, what lets this Hub move itself out of another organization. The
          // Portal reads it only for that; a Hub paired before move keys has none.
          ...(ciHubMoveKey ? { move_key: ciHubMoveKey } : {}),
          ...(options.confirmMove ? { confirm_move: true } : {}),
        },
        {
          ...withPortalAxiosHeaders(this.portalAxiosConfig(), { 'Content-Type': 'application/json' }),
          validateStatus: () => true,
          timeout: PORTAL_PAIR_TIMEOUT_MS,
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
          ...portalRefusalCode(response.data),
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
        /** Absent from a Portal older than move keys. */
        move_key?: string;
        domain: string;
      };

      if ((data as { success?: boolean }).success === false) {
        const errorData = data as { error?: string; message?: string };
        this.logger.warn(`Portal pairing request was rejected: status=${response.status} body=${describePortalPairingResponse(response.data)}`);
        return {
          success: false,
          message: errorData.error || errorData.message || 'Pairing failed.',
          ...portalRefusalCode(response.data),
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
        moveKey: data.move_key,
        domain: data.domain,
      });
    } catch (error) {
      const transportFailure = classifyPortalTransportFailure(error);
      // A request that failed below HTTP is described by why it failed: its message is empty when
      // no address of the Portal answered, and its stack is axios's own frames.
      this.logger.error(
        `Pairing request failed before local registration completed: ${transportFailure ? describeNetworkError(error) : describeRegistrationError(error)}`,
      );

      if (transportFailure === 'no_answer') {
        // CI-Hub#1578: the log is half the complaint, so the durable artifact has to
        // carry the diagnosis and not just the toast the operator already dismissed.
        this.logger.error(
          'The pairing request may have reached CI Portal, which claims the pairing code before it provisions the tunnel and DNS record. ' +
            'Check the Portal for a device row for this Hub before retrying; a device row it left active refuses a keyless re-pair with DEVICE_PROOF_REQUIRED.',
        );
        return {
          success: false,
          message: PORTAL_NO_ANSWER_PAIRING_MESSAGE,
        };
      }

      if (transportFailure === 'never_reached') {
        this.logger.error('The connection to CI Portal never completed, so it never saw the request and the pairing code is still unclaimed.');
        return { success: false, message: `Unable to reach CI Portal (${describeNetworkError(error)}). Please check your network connection.` };
      }
      return {
        success: false,
        message: `Pairing failed: ${describeNetworkError(error)}`,
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

      await this.holdAppSyncForPairingCheck();

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
      // As for pairing: a request that failed below HTTP has an empty message when no address of the
      // Portal answered, so it is described by why it failed.
      this.logger.error(
        `Registration error: ${classifyPortalTransportFailure(error) ? describeNetworkError(error) : describeRegistrationError(error)}`,
      );
      return {
        success: false,
        message: `Registration error: ${describeNetworkError(error)}`,
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
    /** Only `/pair` returns one; the redirected callback never carries it. */
    moveKey?: string;
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

      await this.holdAppSyncForPairingCheck();

      // Persist the optional device API key for authenticated Portal requests.
      if (data.apiKey) {
        this.logger.info('Saving CI Hub API Key from registration callback');
        await this.config.setUserSettings({ ciHubApiKey: data.apiKey });
      }

      /*
       * Kept in settings.json with the device key, and nowhere else: `AppHelpers` hands first-party
       * Memory the device key, never this, so a key leaked from an app cannot move this Hub.
       */
      if (data.moveKey) {
        await this.config.setUserSettings({ ciHubMoveKey: data.moveKey });
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

      // What this Hub registered as is now its identity, whatever a later image can read from the
      // host: the next image may run as a different user and derive a different hardware ID, and
      // Portal answers that with 403 on every check-in.
      persistRegisteredDeviceId(DATA_DIR, await this.getDeviceId(), this.logger);

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
