import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import axios from 'axios';

import { buildHubPublicOrigin, isLocalDevDomain } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
// Load `DockerReadFacade` at its only use site to keep `docker.service` and its
// `AppsService` dependency out of this module's static graph.
import { CloudflareClientService } from './cloudflare-client.service';

/**
 * Describes the liveness of the Companion Hub public route.
 *
 * - `up`: The public origin answered, so a browser can reach it.
 * - `down`: The route is confirmed unreachable. `cloudflared` is not running,
 *   a provisioned Hub has no tunnel token, or the origin failed
 *   {@link FAILURE_THRESHOLD} consecutive probes.
 * - `disabled`: This appliance has no public route by design because it is
 *   unregistered or uses the local or E2E domain. This state differs from `down`;
 *   a local-development Hub still serves its origin through Traefik.
 * - `unknown`: No probe has produced a conclusive result. Callers must preserve
 *   their previous behavior instead of treating this state as a failure.
 */
export type TunnelHealth = 'up' | 'down' | 'disabled' | 'unknown';

/** Duration a cached reading remains fresh before triggering a background probe. */
const CACHE_TTL_MS = 60_000;
/**
 * Number of consecutive probe failures required before reporting `down`.
 *
 * The probe hairpins through Cloudflare and back through the tunnel, so a single
 * transient failure does not prove that the tunnel is unhealthy. A `down` result
 * changes the route offered by every connect surface.
 */
const FAILURE_THRESHOLD = 2;
/** Bounds each background probe because a frequently used endpoint triggers it. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * HTTP statuses Cloudflare returns when it cannot reach or route to the origin.
 *
 * Status 530 represents the origin DNS and tunnel error family, while 52x
 * statuses represent origin connection failures. Each status means the browser
 * reaches an error page instead of the Hub.
 */
const CLOUDFLARE_FAILURE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

/** Identifies markers in a Cloudflare-generated error interstitial. */
const CLOUDFLARE_ERROR_MARKERS = ['Cloudflare Ray ID', 'cf-error-details'];

/** Stores a liveness result and the consecutive failures that produced it. */
interface HealthReading {
  health: TunnelHealth;
  sampledAtMs: number;
  consecutiveFailures: number;
}

/**
 * Determines whether a browser can reach the Companion Hub public origin.
 *
 * `buildHubPublicOrigin` reads configuration and identifies the public origin,
 * but it does not verify reachability. Offering an unavailable origin can strand
 * users on a Cloudflare error page without a return path to the originating app
 * (CI-Engineering#75).
 *
 * Layering
 *
 * The service evaluates the cheapest and most authoritative signals first:
 *
 * 1. A local-development domain or missing public origin returns `disabled`.
 *    Neither state indicates a fault.
 * 2. A provisioned hostname without a tunnel token, or a stopped `cloudflared`
 *    container, returns `down`. These local checks cost at most one
 *    `docker inspect` and cannot produce a false network failure, so they bypass
 *    {@link FAILURE_THRESHOLD}.
 * 3. Otherwise, the service probes the public origin. This probe detects a
 *    running `cloudflared` process with a broken route, such as stale DNS or a
 *    missing edge route. Because network probes can fail transiently,
 *    {@link FAILURE_THRESHOLD} applies.
 *
 * Freshness
 *
 * `getHealth()` uses stale-while-revalidate semantics. It immediately returns the
 * cached value and schedules a refresh after {@link CACHE_TTL_MS}. Before the
 * first result, it returns `unknown` and warms the cache in the background.
 * `GET /api/memory-connect/apps/:urn/state` runs during each top-level navigation
 * in a Companion Memory consumer, so a blocking probe would add up to
 * {@link PROBE_TIMEOUT_MS} when the network is least responsive.
 */
@Injectable()
export class TunnelHealthService {
  private readonly logger = new Logger(TunnelHealthService.name);

  /** Holds the latest reading, or `null` until the first probe completes. */
  private reading: HealthReading | null = null;
  /** Deduplicates concurrent refresh requests into one probe. */
  private inFlight: Promise<void> | null = null;
  /**
   * Tracks invalidations so probes that began before a repair cannot update the
   * cache afterward.
   *
   * Without this generation check, an in-flight probe could restore a stale
   * `down` result immediately after {@link invalidate} cleared it.
   */
  private generation = 0;

  constructor(
    private readonly cloudflareClient: CloudflareClientService,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly configService: ConfigurationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Returns cached tunnel liveness without blocking.
   *
   * The first call and subsequent calls before the initial probe completes return
   * `unknown`. Callers must treat that state as no opinion because a cold Hub must
   * not suppress the connect flow.
   */
  getHealth(): TunnelHealth {
    const cached = this.reading;

    if (!cached) {
      void this.scheduleRefresh();

      return 'unknown';
    }

    if (Date.now() - cached.sampledAtMs > CACHE_TTL_MS) {
      void this.scheduleRefresh();
    }

    return cached.health;
  }

  /**
   * Probes immediately and returns a fresh reading.
   *
   * Request handlers must use {@link getHealth} to avoid blocking. This method
   * serves off-path callers that need a current result and gives unit tests an
   * entry point to the layered checks.
   */
  async getHealthNow(): Promise<TunnelHealth> {
    await this.refresh();

    return this.reading?.health ?? 'unknown';
  }

  /**
   * Clears cached health after a tunnel repair, such as a DNS resync or
   * `cloudflared` restart.
   *
   * The next read can then observe the repair instead of returning a stale result
   * for up to {@link CACHE_TTL_MS}. Detach any in-flight refresh because it
   * measures the pre-repair state. {@link generation} discards that result, and
   * clearing its promise lets the next {@link getHealth} start a new probe
   * immediately instead of waiting for the obsolete probe to time out.
   */
  invalidate(): void {
    this.reading = null;
    this.generation += 1;
    this.inFlight = null;
  }

  /**
   * Starts one background refresh for all concurrent callers.
   *
   * The promise does not reject because probe failures become health readings;
   * propagating an exception would break an unrelated caller path.
   */
  private scheduleRefresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    // Capture the promise so cleanup clears `inFlight` only for this probe.
    // Otherwise, a probe detached by `invalidate()` could finish later and clear
    // the newer probe that replaced it, breaking deduplication.
    const refresh = this.refresh()
      .catch((err) => {
        this.logger.warn(`Tunnel health refresh failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.inFlight === refresh) {
          this.inFlight = null;
        }
      });

    this.inFlight = refresh;

    return this.inFlight;
  }

  /** Runs the layered checks and stores the resulting reading. */
  private async refresh(): Promise<void> {
    const startedAt = this.generation;
    const { health, definite } = await this.evaluate();

    // A repair occurred while this probe was active, so its result describes stale
    // state. Leave the cache empty and let the next read probe the repaired route.
    if (startedAt !== this.generation) {
      this.logger.debug('Discarding a tunnel health reading that was superseded by an invalidate');

      return;
    }

    // Apply deterministic local failures, such as a missing token or stopped
    // `cloudflared`, immediately. Only the network probe hairpins through
    // Cloudflare and needs the failure threshold.
    if (health === 'down' && definite) {
      if (this.reading?.health !== 'down') {
        this.logger.warn('Hub public origin is unreachable (local check); connect surfaces will offer the LAN route');
      }

      this.reading = { health: 'down', sampledAtMs: Date.now(), consecutiveFailures: FAILURE_THRESHOLD };

      return;
    }

    // Keep the previous reading until `FAILURE_THRESHOLD` consecutive probe
    // failures occur. Any successful or disabled result resets the sequence, so
    // intermittent failures cannot accumulate into a `down` state.
    if (health === 'down') {
      const consecutiveFailures = (this.reading?.consecutiveFailures ?? 0) + 1;

      if (consecutiveFailures < FAILURE_THRESHOLD) {
        this.logger.debug(`Tunnel probe failed (${consecutiveFailures}/${FAILURE_THRESHOLD}); holding previous verdict`);
        this.reading = {
          health: this.reading?.health ?? 'unknown',
          sampledAtMs: Date.now(),
          consecutiveFailures,
        };

        return;
      }

      if (this.reading?.health !== 'down') {
        this.logger.warn(
          `Hub public origin is unreachable after ${consecutiveFailures} consecutive probes; connect surfaces will offer the LAN route`,
        );
      }

      this.reading = { health: 'down', sampledAtMs: Date.now(), consecutiveFailures };

      return;
    }

    if (this.reading?.health === 'down' && health === 'up') {
      this.logger.log('Hub public origin is reachable again');
    }

    this.reading = { health, sampledAtMs: Date.now(), consecutiveFailures: 0 };
  }

  /**
   * Evaluates the layered checks described in the class documentation.
   *
   * `definite` marks a result based on a local fact rather than the network.
   * {@link refresh} applies that result immediately instead of using the
   * anti-flap threshold required by the public probe.
   */
  private async evaluate(): Promise<{ health: TunnelHealth; definite: boolean }> {
    const domain = this.configService.getConfig().domain;

    // Layer 1 checks whether this appliance should have a public route. A local or
    // E2E stack serves its own origin through Traefik, while an unregistered
    // appliance has no public origin by design. Neither state indicates a fault.
    if (isLocalDevDomain(domain)) {
      return { health: 'disabled', definite: true };
    }

    const org = await this.deviceRegistration.getFirstDeviceRegistration().catch(() => null);
    const publicOrigin = buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain });

    if (!publicOrigin) {
      return { health: 'disabled', definite: true };
    }

    // A registered appliance with a public hostname but no tunnel token is
    // unavailable, not unconfigured. Check the origin first so an unregistered
    // Hub still reports `disabled`.
    if (!this.cloudflareClient.getTunnelToken()) {
      this.logger.debug('No tunnel token in memory despite a provisioned public hostname — reporting the tunnel down');

      return { health: 'down', definite: true };
    }

    // Layer 2 checks an authoritative local signal. Resolve the read-only
    // `DockerReadFacade` lazily to avoid an `AppsService` dependency. Failure to
    // inspect Docker does not prove that the tunnel is down.
    try {
      const { DockerReadFacade } = await import('../docker/docker-read.facade');
      const dockerReadFacade = this.moduleRef.get(DockerReadFacade, { strict: false });

      if (dockerReadFacade && !(await dockerReadFacade.isContainerRunning('cloudflared'))) {
        this.logger.debug('cloudflared container is not running — reporting the tunnel down');

        return { health: 'down', definite: true };
      }
    } catch (err) {
      this.logger.debug(`Could not inspect the cloudflared container, falling through to the origin probe: ${String(err)}`);
    }

    // Layer 3 verifies edge routing. Because this check can fail transiently, only
    // its failures use the threshold.
    return { health: await this.probePublicOrigin(publicOrigin), definite: false };
  }

  /**
   * Fetches the Hub's public origin and classifies the response.
   *
   * Do not use `assertSafeOutboundUrl` here. The appliance registration record,
   * not caller input, produces the URL, and the SSRF guard would incorrectly
   * reject a private origin.
   *
   * Any ordinary HTTP response, including 401 or 404, counts as `up` because it
   * proves that the request reached the Hub instead of a Cloudflare error page.
   */
  private async probePublicOrigin(publicOrigin: string): Promise<TunnelHealth> {
    try {
      const response = await axios.get(publicOrigin, {
        timeout: PROBE_TIMEOUT_MS,
        validateStatus: () => true,
        // A redirect to `/login` still proves that the Hub route is reachable.
        maxRedirects: 0,
      });

      if (CLOUDFLARE_FAILURE_STATUSES.has(response.status)) {
        this.logger.debug(`Tunnel probe: ${publicOrigin} returned HTTP ${response.status}`);

        return 'down';
      }

      const body = typeof response.data === 'string' ? response.data : '';

      if (CLOUDFLARE_ERROR_MARKERS.some((marker) => body.includes(marker))) {
        this.logger.debug(`Tunnel probe: ${publicOrigin} served a Cloudflare error interstitial`);

        return 'down';
      }

      return 'up';
    } catch (err) {
      this.logger.debug(`Tunnel probe: ${publicOrigin} failed — ${err instanceof Error ? err.message : String(err)}`);

      return 'down';
    }
  }
}
