import { Injectable, Logger } from '@nestjs/common';
import type { BackendHealthStatus, InferenceBackendType } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { InferenceBackendRegistry } from '@/modules/inference/backends/backend-registry';
import type { InferenceBackend } from '@/modules/inference/backends/backend.interface';

/**
 * The longest a pooled request waits for a local engine's health answer before it ranks with what
 * it has.
 *
 * Only a cold read pays it — nothing cached for the engine, or a snapshot past
 * {@link PROBE_SNAPSHOT_MAX_STALE_MS} — and the number is the trade between two failures. Too
 * short and the first request after a restart ranks without a local engine that would have
 * answered in 60 ms on a healthy node. Too long and it is the 5 s transport timeout again, which is
 * what an engine port behind a DROP rule costs: the fleet measured 5035–5200 ms pool TTFT on four
 * nodes for exactly that. 500 ms is an order of magnitude over the warm answer and an order under
 * the stall.
 */
export const PLACEMENT_PROBE_BUDGET_MS = 500;

/**
 * Hard ceiling on serving a snapshot past its TTL, counted from the TTL's end the way
 * `OWN_INVENTORY_MAX_STALE_MS` is in `hub-pool-peer.service.ts`. Inside it a stale answer is served
 * and refreshed behind the caller; past it the caller waits for the refresh, up to
 * {@link PLACEMENT_PROBE_BUDGET_MS}. A node whose refresh keeps failing therefore degrades into
 * half-second reads, not into an inventory from an hour ago.
 */
export const PROBE_SNAPSHOT_MAX_STALE_MS = 60_000;

/** Sentinel the placement budget resolves to, distinct from any health answer. */
const BUDGET_ELAPSED = Symbol('placement budget elapsed');

/** What a local engine last said, and when — the unit both placement and the no-candidate 502 read. */
export interface LocalBackendHealth {
  type: InferenceBackendType;
  backend: InferenceBackend;
  health: BackendHealthStatus;
  /** Epoch ms of the probe that produced `health`, or of the read that gave up waiting for one. */
  probedAt: number;
}

interface SnapshotEntry {
  health: BackendHealthStatus;
  probedAt: number;
  /** Past this a read still serves the entry but starts a refresh behind the caller. */
  expiresAt: number;
}

/**
 * Per-backend health snapshot for the local half of candidate ranking, stale-while-revalidate.
 *
 * Every pooled request used to `await` a live `healthCheck()` on all six local backends before it
 * could rank, each with a 5 s transport timeout. On a node whose firewall DROPs the Hub container's
 * SYN to an engine port — four of fifteen fleet nodes in September 2026 — that was a flat 5.0 s in
 * front of every request, for engines that were never going to be candidates. This service keeps
 * the probe off the request path: a request reads the last answer for each engine, and the probe
 * that refreshes it runs behind the caller.
 *
 * Three tiers per backend, the same shape as `getOwnInventory` in `hub-pool-peer.service.ts`, and
 * the middle one is the point: fresh is served as is; stale is served as is while a refresh runs in
 * the background; only a cold entry waits, and then only up to {@link PLACEMENT_PROBE_BUDGET_MS}. A
 * probe that has not answered by then is reported `running: false` with an error that says so, and
 * the probe keeps running — it is the background refresh that retries a slow engine, never the
 * next request, so one DROP rule costs one half-second read per TTL rather than 5 s per request.
 *
 * What the snapshot does NOT change is the meaning of an answer: `unservableModels` still comes
 * from the backend object's own quarantine on every probe, and the proxy calls {@link invalidate}
 * when it records a verdict that flips a model's withheld state, so a model caught failing is
 * dropped by the next request rather than the next TTL. A quarantine the engine clears on its own
 * (the `/api/ps` reconciliation inside `healthCheck`, a direct `loadModel`) is seen one TTL late.
 *
 * `poolProbeSnapshotTtlMs = 0` — the default, until the snapshot has been measured on a canary —
 * bypasses all of this and probes live per request, which is the pre-snapshot build byte for byte.
 */
@Injectable()
export class HubPoolLocalHealthService {
  private readonly logger = new Logger(HubPoolLocalHealthService.name);
  private readonly entries = new Map<InferenceBackendType, SnapshotEntry>();
  /** Single-flight per backend, so a burst of cold reads shares one probe rather than each starting its own. */
  private readonly inFlight = new Map<InferenceBackendType, Promise<BackendHealthStatus>>();

  constructor(
    private readonly backends: InferenceBackendRegistry,
    private readonly configuration: ConfigurationService,
  ) {}

  /**
   * Every local backend's health, in `INFERENCE_BACKEND_TYPES` order — the order the ranker's
   * stable sort relies on for local ties, so it must not depend on which probe answered first.
   *
   * Returns within {@link PLACEMENT_PROBE_BUDGET_MS} of being called whatever the engines do; the
   * budget is shared across every cold backend in the read, not paid once per backend.
   */
  async read(): Promise<LocalBackendHealth[]> {
    // Read per call, like every other pool setting: a PATCH must take effect on the next request.
    const ttlMs = this.configuration.getHubPoolPreferences().poolProbeSnapshotTtlMs;
    if (ttlMs <= 0) {
      return Promise.all(
        this.backends.entries().map(async ([type, backend]) => ({ type, backend, health: await this.probe(type, backend), probedAt: Date.now() })),
      );
    }

    const now = Date.now();
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<typeof BUDGET_ELAPSED>((resolve) => {
      budgetTimer = setTimeout(() => resolve(BUDGET_ELAPSED), PLACEMENT_PROBE_BUDGET_MS);
    });
    try {
      return await Promise.all(
        this.backends.entries().map(async ([type, backend]): Promise<LocalBackendHealth> => {
          const cached = this.entries.get(type);
          if (cached && now < cached.expiresAt) {
            return { type, backend, health: cached.health, probedAt: cached.probedAt };
          }
          // Stale but serviceable: hand back what we have and refresh behind the caller. Not
          // awaited, and `refresh` cannot reject — `probe` folds a throw into an answer — so there
          // is nothing here for a rejection handler to do.
          if (cached && now < cached.expiresAt + PROBE_SNAPSHOT_MAX_STALE_MS) {
            void this.refresh(type, backend, ttlMs);
            return { type, backend, health: cached.health, probedAt: cached.probedAt };
          }
          const outcome = await Promise.race([this.refresh(type, backend, ttlMs), budget]);
          if (outcome !== BUDGET_ELAPSED) {
            return { type, backend, health: outcome, probedAt: this.entries.get(type)?.probedAt ?? Date.now() };
          }
          // The probe is still running and will overwrite this when it answers. Recorded rather
          // than merely returned so the NEXT request does not wait the budget again for the same
          // engine — that is what "retried by the background refresh, never by the next request"
          // costs. Guarded, because the probe can land between the race settling and this line.
          const landed = this.entries.get(type);
          if (landed && landed !== cached) {
            return { type, backend, health: landed.health, probedAt: landed.probedAt };
          }
          const gaveUp = Date.now();
          const health: BackendHealthStatus = {
            running: false,
            healthy: false,
            modelsLoaded: [],
            error: `health probe did not answer within the ${PLACEMENT_PROBE_BUDGET_MS} ms placement budget; still probing in the background`,
          };
          this.entries.set(type, { health, probedAt: gaveUp, expiresAt: gaveUp + ttlMs });
          this.logger.debug(
            `[PoolLocalHealth] local ${type} health check has not answered after ${PLACEMENT_PROBE_BUDGET_MS} ms; ranking without it`,
          );
          return { type, backend, health, probedAt: gaveUp };
        }),
      );
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  /**
   * Forget what `type` last said, so the next read waits (up to the budget) for a fresh answer.
   *
   * For the proxy's serving verdicts: a 5xx that withheld a model, or a success that released
   * one, changes `unservableModels` on the backend object right now, and a snapshot that kept
   * offering — or kept withholding — the model until its TTL would be routing on a fact it has
   * already been told is wrong.
   */
  invalidate(type: InferenceBackendType): void {
    this.entries.delete(type);
  }

  /** The probe itself, single-flighted per backend. Always resolves; a throw is a `running: false` answer. */
  private refresh(type: InferenceBackendType, backend: InferenceBackend, ttlMs: number): Promise<BackendHealthStatus> {
    const inFlight = this.inFlight.get(type);
    if (inFlight) {
      return inFlight;
    }
    const probe = this.probe(type, backend)
      .then((health) => {
        const probedAt = Date.now();
        this.entries.set(type, { health, probedAt, expiresAt: probedAt + ttlMs });
        return health;
      })
      .finally(() => {
        this.inFlight.delete(type);
      });
    this.inFlight.set(type, probe);
    return probe;
  }

  /** One `healthCheck()`, with a throw folded into the same shape a backend uses to say it is down. */
  private async probe(type: InferenceBackendType, backend: InferenceBackend): Promise<BackendHealthStatus> {
    try {
      return await backend.healthCheck();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`[PoolLocalHealth] local ${type} health check failed: ${message}`);
      return { running: false, healthy: false, modelsLoaded: [], error: message };
    }
  }
}
