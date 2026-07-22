import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import axios from 'axios';

import { buildHubPublicOrigin, isLocalDevDomain } from '@/common/helpers/hub-origin';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { DockerService } from '../docker/docker.service';
import { CloudflareClientService } from './cloudflare-client.service';

/**
 * Liveness of the Hub's own public route.
 *
 *  - `up`       — the public origin answered; a browser sent there will arrive.
 *  - `down`     — confirmed unreachable: cloudflared is not running, the tunnel
 *                 token is missing on a provisioned Hub, or the origin failed
 *                 {@link FAILURE_THRESHOLD} consecutive probes.
 *  - `disabled` — this appliance has no public route by design: it is not
 *                 registered, or it runs the local/E2E domain. Not a fault, and
 *                 NOT the same as `down` — a local-dev Hub still serves its own
 *                 origin through Traefik.
 *  - `unknown`  — no conclusive reading yet. Callers MUST treat this as "carry on
 *                 as before", never as a failure.
 */
export type TunnelHealth = 'up' | 'down' | 'disabled' | 'unknown';

/** How long a reading is served before a background refresh is triggered. */
const CACHE_TTL_MS = 60_000;
/**
 * Consecutive probe failures required before reporting `down`. A single failure
 * is not enough: this probe hairpins out through Cloudflare and back in through
 * the tunnel, a path that can blip for reasons unrelated to the tunnel's health,
 * and reporting `down` changes what every connect surface offers.
 */
const FAILURE_THRESHOLD = 2;
/** Per-probe timeout. Short: this runs behind a hot endpoint and never blocks it. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * HTTP statuses Cloudflare returns when it cannot reach (or route to) the origin.
 * 530 is Cloudflare's "origin DNS/tunnel error" family, 52x its origin-connection
 * failures — all mean a browser would land on an error page, not on the Hub.
 */
const CLOUDFLARE_FAILURE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

/** Markers present in a Cloudflare-generated error interstitial. */
const CLOUDFLARE_ERROR_MARKERS = ['Cloudflare Ray ID', 'cf-error-details'];

/** A cached liveness reading plus the consecutive-failure run that produced it. */
interface HealthReading {
  health: TunnelHealth;
  sampledAtMs: number;
  consecutiveFailures: number;
}

/**
 * Answers one question for the memory-connect surfaces: *can a browser we redirect
 * to the Hub's public origin actually get there right now?*
 *
 * This exists because `buildHubPublicOrigin` is a pure config read — it says what
 * the public origin **is**, never whether it **works**. Handing that URL out as a
 * clickable action when the tunnel is down is what strands a user on a Cloudflare
 * error page with no way back to the app they started from (CI-Engineering#75).
 *
 * ## Layering
 *
 * The signal is built cheapest-first, because the cheap checks are also the most
 * certain:
 *
 *  1. Local-dev domain, or no public origin at all → `disabled`. Nothing to
 *     probe, and this is not a fault.
 *  2. A provisioned public hostname with no tunnel token, or a `cloudflared`
 *     container that is not running → `down`. Local, authoritative negatives that
 *     cost at most one `docker inspect` and cannot produce a false `down`, so
 *     they bypass {@link FAILURE_THRESHOLD} and apply immediately.
 *  3. Otherwise probe the public origin itself. This is the only check that can
 *     catch a running cloudflared whose *route* is broken (stale DNS, a tunnel
 *     the edge has forgotten), and the only one that can be wrong — hence
 *     {@link FAILURE_THRESHOLD}.
 *
 * ## Freshness
 *
 * Readings are served **stale-while-revalidate**: `getHealth()` always returns
 * immediately from cache and schedules a refresh when the entry is older than
 * {@link CACHE_TTL_MS}. With no reading at all it returns `unknown` and warms the
 * cache in the background. This is deliberate — `GET /api/memory-connect/apps/:urn/state`
 * is hit on every top-level navigation of every memory-consumer app, so a
 * blocking probe would put {@link PROBE_TIMEOUT_MS} on that path exactly when the
 * network is already unhealthy.
 */
@Injectable()
export class TunnelHealthService {
  private readonly logger = new Logger(TunnelHealthService.name);

  /** Last reading; null until the first probe completes. */
  private reading: HealthReading | null = null;
  /** In-flight refresh, so concurrent callers trigger at most one probe. */
  private inFlight: Promise<void> | null = null;
  /**
   * Bumped by {@link invalidate}. A refresh that started before the bump is
   * describing the world as it was BEFORE the repair that triggered it, so its
   * result is dropped rather than written back — otherwise an in-flight probe
   * lands a stale `down` immediately after the cache was cleared, which is the
   * exact staleness `invalidate` was called to prevent.
   */
  private generation = 0;

  constructor(
    private readonly cloudflareClient: CloudflareClientService,
    private readonly deviceRegistration: DeviceRegistrationRepository,
    private readonly configService: ConfigurationService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Current tunnel liveness, served from cache and never blocking.
   *
   * Returns `unknown` on the very first call (and until the first probe lands),
   * which every caller is required to treat as "no opinion" rather than a
   * failure — a cold Hub must not suppress the connect flow.
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
   * Probe now and return the fresh reading, bypassing the cache.
   *
   * Nothing on a request path may use this — every such caller wants
   * {@link getHealth}, which never blocks. It exists for callers that are already
   * off the hot path and want certainty, and it is the seam the unit tests drive
   * the layered check through.
   */
  async getHealthNow(): Promise<TunnelHealth> {
    await this.refresh();

    return this.reading?.health ?? 'unknown';
  }

  /**
   * Drop the cached reading. Called after a tunnel repair (DNS re-sync,
   * cloudflared restart) so the next read reflects the change immediately
   * instead of serving up to {@link CACHE_TTL_MS} of stale pessimism.
   *
   * Also invalidates any refresh already in flight — see {@link generation}.
   */
  invalidate(): void {
    this.reading = null;
    this.generation += 1;
  }

  /**
   * Trigger a background refresh, collapsing concurrent callers onto one probe.
   * Never rejects: a probe failure is recorded as a reading, not raised, because
   * every caller is on a path where an exception would break something unrelated.
   */
  private scheduleRefresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.refresh()
      .catch((err) => {
        this.logger.warn(`Tunnel health refresh failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  /** Run the layered check and store the resulting reading. */
  private async refresh(): Promise<void> {
    const startedAt = this.generation;
    const { health, definite } = await this.evaluate();

    // Someone repaired the tunnel while this probe was in flight, so what it just
    // measured is already history. Drop it and leave the cache cold; the next
    // read schedules a probe against the world as it now is.
    if (startedAt !== this.generation) {
      this.logger.debug('Discarding a tunnel health reading that was superseded by an invalidate');

      return;
    }

    // Deterministic negatives (no tunnel token, cloudflared not running) are
    // local facts that cannot be flaky, so they take effect immediately. Only the
    // network probe — which hairpins out through Cloudflare and back — is
    // threshold-gated.
    if (health === 'down' && definite) {
      if (this.reading?.health !== 'down') {
        this.logger.warn('Hub public origin is unreachable (local check); connect surfaces will offer the LAN route');
      }

      this.reading = { health: 'down', sampledAtMs: Date.now(), consecutiveFailures: FAILURE_THRESHOLD };

      return;
    }

    // A probe failure only counts once it has happened FAILURE_THRESHOLD times in
    // a row; until then the previous reading stands. Any non-failure resets the
    // run, so an intermittent blip can never accumulate its way to `down`.
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
   * The layered check itself (see the class docstring).
   *
   * `definite` marks a verdict that comes from a local fact rather than from the
   * network, so {@link refresh} can apply it immediately instead of waiting for
   * the anti-flap threshold that only the probe needs.
   */
  private async evaluate(): Promise<{ health: TunnelHealth; definite: boolean }> {
    const domain = this.configService.getConfig().domain;

    // Layer 1 — is there supposed to be a public route at all? Both of these are
    // "no public route by design", NOT a fault: the local/E2E stack serves its own
    // origin through Traefik, and an unregistered appliance simply has none.
    if (isLocalDevDomain(domain)) {
      return { health: 'disabled', definite: true };
    }

    const org = await this.deviceRegistration.getFirstDeviceRegistration().catch(() => null);
    const publicOrigin = buildHubPublicOrigin({ hubSubdomain: org?.hubSubdomain, domain });

    if (!publicOrigin) {
      return { health: 'disabled', definite: true };
    }

    // A registered appliance with a public hostname but no tunnel token is broken,
    // not unconfigured: nothing can be routing to that hostname. Checked AFTER the
    // origin so a plain unregistered Hub still reports `disabled`.
    if (!this.cloudflareClient.getTunnelToken()) {
      this.logger.debug('No tunnel token in memory despite a provisioned public hostname — reporting the tunnel down');

      return { health: 'down', definite: true };
    }

    // Layer 2 — cheap, certain local negative. Resolved lazily via ModuleRef
    // because DockerModule is wired into this module behind a forwardRef, and a
    // docker probe that itself fails must not be read as "tunnel down".
    try {
      const dockerService = this.moduleRef.get(DockerService, { strict: false });

      if (dockerService && !(await dockerService.isContainerRunning('cloudflared'))) {
        this.logger.debug('cloudflared container is not running — reporting the tunnel down');

        return { health: 'down', definite: true };
      }
    } catch (err) {
      this.logger.debug(`Could not inspect the cloudflared container, falling through to the origin probe: ${String(err)}`);
    }

    // Layer 3 — does the edge actually route to us? The only fallible check, so
    // its failures are the ones the threshold guards.
    return { health: await this.probePublicOrigin(publicOrigin), definite: false };
  }

  /**
   * Fetch the Hub's own public origin and classify the answer.
   *
   * Not routed through `assertSafeOutboundUrl`: the URL is built from this
   * appliance's own registration record, never from caller input, and the SSRF
   * guard's private-address rejection would be actively wrong here.
   *
   * Any ordinary HTTP answer counts as `up` — including a 401/404, which still
   * proves the browser reached the Hub rather than a Cloudflare error page.
   */
  private async probePublicOrigin(publicOrigin: string): Promise<TunnelHealth> {
    try {
      const response = await axios.get(publicOrigin, {
        timeout: PROBE_TIMEOUT_MS,
        validateStatus: () => true,
        // The Hub's own route; a redirect to /login is a perfectly good "up".
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
