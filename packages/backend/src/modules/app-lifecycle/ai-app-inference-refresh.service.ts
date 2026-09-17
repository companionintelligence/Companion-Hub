import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { AppUrn } from '@ci-hub/common/types';
import { InferenceEnvStalenessService } from '../apps/inference-env-staleness.service';
import { AppCredentialsService } from '../inference/app-credentials.service';
import { InferenceEndpointService } from '../inference/inference-endpoint.service';
import { AppLifecycleService } from './app-lifecycle.service';

/**
 * `settings.json` keys that change what the Hub hands AI apps for inference.
 *
 * Two routes write them. `PATCH /api/inference/preferences` used to restart every AI app, and
 * `PATCH /api/user-settings` restarted none, so the same preference change had a different effect
 * depending on which screen saved it. Both now call {@link AiAppInferenceRefreshService.requestRefresh}.
 * The two pool switches are here because they change routing and the pool's inventory; the other
 * pool knobs (affinity, pressure weight, pins) only reorder candidates per request.
 */
export const INFERENCE_ENV_SETTING_KEYS = [
  'inferenceBackend',
  'inferenceModel',
  'inferenceEmbeddingModel',
  'inferenceVisionModel',
  'inferenceVllmApiKey',
  'inferenceVllmUrl',
  'inferenceMtplxUrl',
  'inferenceDsparkUrl',
  'inferenceCloudProviders',
  'hubPoolEnabled',
  'hubPoolOutboundEnabled',
] as const;

/** The inference-relevant keys a settings write carries. */
export function inferenceEnvSettingsIn(body: object | null | undefined): string[] {
  if (!body) return [];
  return INFERENCE_ENV_SETTING_KEYS.filter((key) => Object.hasOwn(body, key));
}

/**
 * Debounce for bursts of writes. A Settings save that POSTs four cloud providers and then PATCHes
 * preferences is five requests inside a second; they should produce one sweep, not five.
 */
export const REFRESH_DEBOUNCE_MS = 1_500;

/**
 * Consecutive polls a new pool membership must hold before apps are restarted for it.
 *
 * The source is already debounced for disconnects — a peer only turns `unreachable` after three
 * failed 30 s capability probes — so this guards the other direction: a single read that lands
 * mid-update, or a pairing that is approved and immediately removed. Two polls is 30–60 s after a
 * change at the default cadence, which is also how long a new peer's inventory takes to arrive.
 */
export const MEMBERSHIP_SETTLE_POLLS = 2;

interface PendingReason {
  reason: string;
  /** Raised by the membership watcher rather than by an operator's write. */
  automatic: boolean;
}

/** One app's outcome from a sweep, for logs and tests. */
export interface AiAppRefreshDecision {
  appUrn: AppUrn;
  restart: boolean;
  why: string;
}

/**
 * The one code path that brings running AI apps' inference config up to date.
 *
 * Triggers: an operator changing an inference setting (either route), and pool membership changing
 * (a peer paired, unpaired, lost, or back). Before this, pairing and unpairing never regenerated
 * anything: `hasConnectedPeers()` is read when an app's env is generated, so core-4's apps kept the
 * direct Ollama URL after core-6 paired until someone restarted them by hand.
 *
 * A sweep restarts only the apps whose env is actually stale (see InferenceEnvStalenessService).
 * The preferences route used to restart every AI app, including Companion Memory, on any change,
 * even one that left its env byte-identical.
 */
@Injectable()
export class AiAppInferenceRefreshService implements OnModuleInit, OnModuleDestroy {
  private debounceTimer: NodeJS.Timeout | null = null;
  private pending: PendingReason[] = [];
  private sweep: Promise<AiAppRefreshDecision[]> | null = null;
  private sweepAgain = false;

  private watchTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** The membership apps were last brought in line with; null until the first observation. */
  private observed: { signature: string; description: string } | null = null;
  private candidate: { signature: string; description: string; seen: number } | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly appLifecycle: AppLifecycleService,
    private readonly staleness: InferenceEnvStalenessService,
    private readonly appCredentials: AppCredentialsService,
    private readonly endpoints: InferenceEndpointService,
    private readonly configuration: ConfigurationService,
  ) {}

  onModuleInit(): void {
    this.scheduleMembershipPoll();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const timer of [this.watchTimer, this.debounceTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.watchTimer = null;
    this.debounceTimer = null;
  }

  /**
   * Ask for a sweep. Returns immediately; the sweep runs after {@link REFRESH_DEBOUNCE_MS} of quiet.
   * The credentials cache is dropped now rather than then, so an app that bootstraps inside the
   * debounce window already gets the new answer.
   */
  requestRefresh(reason: string, options?: { automatic?: boolean }): void {
    this.appCredentials.invalidateCache();
    this.pending.push({ reason, automatic: options?.automatic === true });
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, REFRESH_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  /** Run whatever is pending now. Single-flight: a request that arrives mid-sweep runs once it ends. */
  async flush(): Promise<AiAppRefreshDecision[]> {
    if (this.sweep) {
      this.sweepAgain = true;
      return this.sweep;
    }
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) {
      return [];
    }
    this.sweep = this.runSweep(batch).finally(() => {
      this.sweep = null;
      if (this.sweepAgain) {
        this.sweepAgain = false;
        void this.flush();
      }
    });
    return this.sweep;
  }

  private async runSweep(batch: PendingReason[]): Promise<AiAppRefreshDecision[]> {
    const trigger = [...new Set(batch.map((entry) => entry.reason))].join('; ');
    // Any operator write in the batch makes it an operator sweep: they asked for the change.
    const automatic = batch.every((entry) => entry.automatic);
    const decisions: AiAppRefreshDecision[] = [];

    await this.appLifecycle.restartAiApps({
      trigger,
      shouldRestart: async (appUrn) => {
        const decision = await this.decide(appUrn, automatic);
        decisions.push(decision);
        this.logger.info(
          `[InferenceRefresh] ${appUrn}: ${decision.restart ? 'restarting' : 'leaving running'} — ${decision.why} (trigger: ${trigger})`,
        );
        return decision.restart;
      },
    });
    return decisions;
  }

  private async decide(appUrn: AppUrn, automatic: boolean): Promise<AiAppRefreshDecision> {
    try {
      const result = await this.staleness.check(appUrn);
      if (!result.aiApp) {
        return { appUrn, restart: false, why: 'the Hub hands it no inference config' };
      }
      if (!result.stale) {
        return { appUrn, restart: false, why: 'its inference config is already current' };
      }
      if (automatic && result.wouldRemoveEndpoint) {
        return { appUrn, restart: false, why: `stale (${result.reasons.join('; ')}), but regenerating now would remove its inference endpoint` };
      }
      return { appUrn, restart: true, why: result.reasons.join('; ') || 'stale' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An operator changed a setting and expects apps to pick it up, which is what a restart did
      // unconditionally before this check existed. Nobody asked for an automatic one.
      return automatic
        ? { appUrn, restart: false, why: `staleness check failed (${message}); not restarting automatically` }
        : { appUrn, restart: true, why: `staleness check failed (${message}); restarting because a setting changed` };
    }
  }

  /** One membership observation. Public so tests can drive the watcher without timers. */
  async observePoolMembership(): Promise<void> {
    const { signature, description } = await this.endpoints.poolMembership('InferenceRefresh');
    if (signature === null) {
      return;
    }
    if (this.observed === null) {
      // The first reading is the baseline. Apps started before it were generated against whatever
      // the Hub saw at their start; the Hub-upgrade sync, not this watcher, owns that case.
      this.observed = { signature, description };
      return;
    }
    if (signature === this.observed.signature) {
      this.candidate = null;
      return;
    }
    if (this.candidate?.signature === signature) {
      this.candidate.seen += 1;
    } else {
      this.candidate = { signature, description, seen: 1 };
    }
    if (this.candidate.seen < MEMBERSHIP_SETTLE_POLLS) {
      return;
    }
    const previous = this.observed;
    this.observed = { signature, description };
    this.candidate = null;
    this.requestRefresh(`pool membership changed: ${previous.description} -> ${description}`, { automatic: true });
  }

  private scheduleMembershipPoll(): void {
    const seconds = this.configuration.getHubPoolPreferences().poolHealthPollSeconds;
    this.watchTimer = setTimeout(() => {
      void (async () => {
        try {
          await this.observePoolMembership();
        } catch (err) {
          this.logger.warn(`[InferenceRefresh] pool membership check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!this.stopped) {
          this.scheduleMembershipPoll();
        }
      })();
    }, Math.max(5, seconds) * 1000);
    this.watchTimer.unref?.();
  }
}
