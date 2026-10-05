import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { InferenceBackendType } from '@ci-hub/common/types';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { clampSupervisionPollSeconds, hubComposeProject, resolveInferenceSupervisionMode } from '@/common/helpers/inference-supervision';
import { withTimeout } from '@/common/helpers/with-timeout';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerReadFacade } from '@/modules/docker/docker-read.facade';
import { HostTelemetryService } from '@/modules/system/host-telemetry.service';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import { diagnoseBackendFailure } from './backend-failure-diagnosis';
import { RestartLoopWatcher } from './restart-loop-watcher';
import { resolveSupervisionTarget, SUPERVISION_CONTAINER_CANDIDATES } from './supervision-target.resolver';
import type {
  BackendDiagnosis,
  BackendObservation,
  ObservedHealth,
  RestartLoopReport,
  SupervisionContainerState,
  SupervisionReport,
} from './supervision.types';

/** Ceiling on one backend's health check, so a hung engine cannot stall the whole tick. */
const HEALTH_CHECK_TIMEOUT_MS = 15_000;

/** Log lines captured when a diagnosis needs evidence. Matches `diagnoseAppContainers`. */
const LOG_TAIL_LINES = 20;

/** Event-log source, so an operator can filter `host_event_log` down to this layer. */
const EVENT_SOURCE = 'inference-observer';

interface BackendRuntimeState {
  health: ObservedHealth;
  healthError: string | null;
  observedAt: number | null;
  lastHealthyAt: number | null;
  consecutiveUnhealthy: number;
  /** Diagnosis codes reported last tick, so a *change* can be announced without repeating. */
  lastDiagnosisKey: string;
  diagnoses: BackendDiagnosis[];
  logTail: string | null;
}

/**
 * Watches the four inference backends and the Hub's own compose project, and tells someone when a
 * container is being restarted in a loop.
 *
 * **This service never restarts, stops, starts, or reconfigures anything.** It has no reference to
 * `DockerService` (which owns the mutating calls), only to `DockerReadFacade`, and the mode enum it
 * reads has no value that would select such a path. See `common/helpers/inference-supervision.ts`
 * for the full reasoning; the short version is that every restart-capable variant of this design
 * reintroduced the shape of the incident it was meant to prevent, and on the fleet the Lucebox
 * container is owned by the desktop app, which would start again anything the Hub stopped.
 *
 * Relationship to `backends/serving-quarantine.ts` — deliberately orthogonal, not a replacement:
 *
 * | | `ServingQuarantine` | this observer |
 * |---|---|---|
 * | subject | one (backend, model) pair | one backend *process* |
 * | evidence | real request outcomes (5xx, failed load) | health polls + container inspect |
 * | effect | withholds a model from routing, 60 s→15 min | none; writes an event and a report |
 * | recovery | any success clears it | health returns |
 *
 * The two do not compose and must not: a quarantine strike is evidence that a *model* cannot load
 * (fleet node core-4 answers `/api/tags` 200 for `gemma3:1b` while every `/api/generate` returns
 * 500), which is precisely the failure that restarting an engine would repeat forever. Quarantine
 * already handles it by routing around the model. Conversely nothing here clears a quarantine —
 * only serving a model is evidence it can be served. Since this observer never acts, there is no
 * interaction to get wrong; if a future change ever gives it teeth, this is the rule it has to keep.
 *
 * Cost when `inferenceSupervisionMode` is `'off'` (the default): zero. `onModuleInit` reads one
 * setting and returns without arming a timer, so a peerless single-node Hub does no new boot work
 * and issues no new probe. That is asserted in the tests.
 */
@Injectable()
export class BackendObserverService implements OnModuleInit, OnModuleDestroy {
  private timerHandle: NodeJS.Timeout | null = null;
  private stopped = false;
  private sweepInFlight = false;
  private lastSweepAt: number | null = null;
  private dockerError: string | null = null;
  private readonly runtime = new Map<InferenceBackendType, BackendRuntimeState>();
  private readonly targets = new Map<InferenceBackendType, ReturnType<typeof resolveSupervisionTarget>>();
  private readonly containerByBackend = new Map<InferenceBackendType, SupervisionContainerState>();
  private readonly restartWatcher = new RestartLoopWatcher();
  private restartLoops: RestartLoopReport[] = [];

  constructor(
    private readonly logger: LoggerService,
    private readonly configuration: ConfigurationService,
    private readonly backends: InferenceBackendRegistry,
    private readonly dockerRead: DockerReadFacade,
    // `@Optional()`, matching `AppRuntimeMonitorService`: this service reaches SystemModule across
    // InferenceModule's `forwardRef`, and its construction must not depend on that chain resolving
    // in a particular order. When telemetry is absent the alarm still reaches the logger.
    @Optional() private readonly telemetry?: HostTelemetryService,
  ) {}

  /**
   * Arms the timer only when the operator has opted in. Never throws: a settings file that cannot
   * be read, a Docker daemon that is not there, a backend registry mid-construction — all of them
   * degrade to "observation is off" and a warning, because taking boot down to report on inference
   * health would be a worse outage than anything this service can detect.
   */
  onModuleInit(): void {
    try {
      const { mode, disabledBy } = this.resolveMode();
      if (mode === 'off') {
        this.logger.debug(`Inference backend observation is off (${disabledBy === 'env' ? 'disabled in the environment' : 'not enabled'}).`);
        return;
      }
      this.logger.info(`Inference backend observation is on, every ${this.pollSeconds()}s. It reports only and never restarts a backend.`);
      this.scheduleNextTick();
    } catch (error) {
      this.logger.warn(`Inference backend observation could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onModuleDestroy(): void {
    // Stops the *observer*, never an engine. An inference engine's lifetime is not the Hub's:
    // stopping one on shutdown would evict a multi-gigabyte model from VRAM on every Hub upgrade
    // and cut off every other client on the box.
    this.stopped = true;
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** The report behind `GET /api/inference/supervision`. Reads memory only; issues no I/O. */
  getReport(): SupervisionReport {
    const { mode, disabledBy } = this.resolveMode();
    return {
      mode,
      disabledBy,
      pollSeconds: this.pollSeconds(),
      observeOnly: true,
      lastSweepAt: this.lastSweepAt === null ? null : new Date(this.lastSweepAt).toISOString(),
      dockerError: this.dockerError,
      backends: INFERENCE_BACKEND_TYPES.map((backend) => this.observationFor(backend)),
      restartLoops: [...this.restartLoops],
    };
  }

  /**
   * Run one observation pass. Public so a test can drive it directly rather than waiting on a
   * timer, and so the report route could warm it — it is read-only in the sense that matters.
   */
  async sweepOnce(): Promise<void> {
    if (this.sweepInFlight) return;
    this.sweepInFlight = true;
    try {
      const containers = await this.listContainers();
      await this.observeBackends(containers);
      await this.reportLoopingContainers(containers);
      this.lastSweepAt = Date.now();
    } catch (error) {
      this.logger.warn(`Inference backend observation tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  // ── Timer ────────────────────────────────────────────────────────────────

  /**
   * Self-rescheduling `setTimeout` rather than `setInterval`, following `HubPoolPeerService`: the
   * interval is re-read from settings on every tick, so retuning it takes effect on the next poll
   * with no separate re-arm path, and chaining after the work means a slow round of health checks
   * can never stack overlapping ticks. There is no `@nestjs/schedule` in this repo.
   */
  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timerHandle = setTimeout(() => {
      void (async () => {
        // Switching the setting off stops the timer at the next tick, so an operator who turns
        // observation off does not have to restart the Hub to stop the polling. Turning it back on
        // takes effect at the next Hub restart — deliberately asymmetric, because the direction
        // that must be immediate is the one that stops work.
        if (this.resolveMode().mode === 'off') {
          this.timerHandle = null;
          this.logger.info('Inference backend observation was switched off; the poll timer is stopped.');
          return;
        }
        await this.sweepOnce();
        this.scheduleNextTick();
      })();
    }, this.pollSeconds() * 1000);
  }

  // ── Backends ─────────────────────────────────────────────────────────────

  private async observeBackends(containers: readonly SupervisionContainerState[]): Promise<void> {
    for (const backend of INFERENCE_BACKEND_TYPES) {
      await this.observeOneBackend(backend, containers);
    }
  }

  private async observeOneBackend(backend: InferenceBackendType, containers: readonly SupervisionContainerState[]): Promise<void> {
    const state = this.runtimeFor(backend);
    const instance = this.backends.get(backend);

    let baseUrl = '';
    try {
      baseUrl = instance.getBaseUrl();
    } catch (error) {
      this.logger.debug(`Could not resolve a base URL for ${backend}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const health = await this.checkHealth(backend);
    state.health = health.health;
    state.healthError = health.error;
    state.observedAt = Date.now();
    if (health.health === 'healthy') {
      state.lastHealthyAt = state.observedAt;
      state.consecutiveUnhealthy = 0;
    } else {
      state.consecutiveUnhealthy += 1;
    }

    const target = resolveSupervisionTarget({
      backend,
      baseUrl,
      containers,
      reachable: health.health === 'healthy' || health.health === 'unhealthy',
    });
    this.targets.set(backend, target);

    const container = target.kind === 'container' ? (containers.find((entry) => entry.name === target.ref) ?? null) : null;
    if (container) {
      this.containerByBackend.set(backend, container);
    } else {
      this.containerByBackend.delete(backend);
    }

    // Evidence is only gathered for a container that is actually in trouble. A healthy engine costs
    // one health check per tick and nothing else — no log tail, no process table.
    let zombieCount: number | null = null;
    const inTrouble = container !== null && (state.health !== 'healthy' || container.restartCount > 0 || !container.running);
    if (container && inTrouble) {
      state.logTail = await this.dockerRead.tailContainerLogs(container.name, LOG_TAIL_LINES);
      if (container.running) {
        zombieCount = await this.dockerRead.countContainerZombieProcesses(container.name);
      }
    } else {
      // Drop a stale tail rather than reporting evidence from a failure that is over.
      state.logTail = null;
    }

    const diagnoses = diagnoseBackendFailure({
      backend,
      container,
      logTail: state.logTail,
      zombieProcessCount: zombieCount,
      healthError: state.healthError,
    });

    const key = diagnoses.map((diagnosis) => diagnosis.code).join(',');
    if (key !== state.lastDiagnosisKey && diagnoses.length > 0) {
      for (const diagnosis of diagnoses) {
        await this.raise('error', `[${backend}] ${diagnosis.summary} ${diagnosis.remediation}`, {
          backend,
          code: diagnosis.code,
          target: target.kind,
          ref: target.ref,
        });
      }
    }
    state.lastDiagnosisKey = key;
    state.diagnoses = diagnoses;
  }

  private async checkHealth(backend: InferenceBackendType): Promise<{ health: ObservedHealth; error: string | null }> {
    try {
      const status = await withTimeout(this.backends.get(backend).healthCheck(), HEALTH_CHECK_TIMEOUT_MS, `${backend} health check timed out`);
      if (status.healthy) return { health: 'healthy', error: null };
      return { health: status.running ? 'unhealthy' : 'unreachable', error: status.error ?? null };
    } catch (error) {
      return { health: 'unreachable', error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Restart loops ────────────────────────────────────────────────────────

  /**
   * The alarm. Sweeps the whole `ci-hub` compose project plus the resolved inference containers,
   * and writes an `error` to `host_event_log` for anything dockerd is looping.
   *
   * Scoped to the compose project rather than to the inference backends on purpose: the worst loop
   * the fleet has recorded was `hub-tailscale` at `RestartCount=11463`, a Hub stack service, and an
   * inference-only sweep structurally cannot see it. That is also why the alarm is not silent — a
   * crash loop nobody sees is the failure mode being fixed.
   */
  private async reportLoopingContainers(containers: readonly SupervisionContainerState[]): Promise<void> {
    const inferenceContainerNames = new Map<string, InferenceBackendType>();
    for (const [backend, container] of this.containerByBackend) {
      inferenceContainerNames.set(container.name, backend);
    }

    const watched = containers.filter((container) => container.inHubComposeProject || inferenceContainerNames.has(container.name));
    this.restartWatcher.prune(new Set(watched.map((container) => container.name)));

    const reports: RestartLoopReport[] = [];
    for (const container of watched) {
      const decision = this.restartWatcher.observe({
        name: container.name,
        image: container.image,
        restartCount: container.restartCount,
        restartPolicy: container.restartPolicy,
        state: container.state,
      });
      const delta = this.restartWatcher.restartsSinceFirstSeen(container.name);

      if (!decision) {
        // Still reported in the read model when the count is non-trivial, so an operator looking at
        // the page sees a loop that has not yet re-crossed its alarm threshold.
        if (delta !== null && delta > 0 && container.restartCount > 1) {
          reports.push({
            containerName: container.name,
            image: container.image,
            restartCount: container.restartCount,
            restartsSinceFirstSeen: delta,
            restartPolicy: container.restartPolicy,
            state: container.state,
            kind: 'rate',
            message: `${container.name} has restarted ${delta} time(s) while the Hub was watching (${container.restartCount} in total).`,
            logTail: null,
            inferenceBackend: inferenceContainerNames.get(container.name) ?? null,
          });
        }
        continue;
      }

      const logTail = await this.dockerRead.tailContainerLogs(container.name, LOG_TAIL_LINES);
      reports.push({
        containerName: container.name,
        image: container.image,
        restartCount: decision.restartCount,
        restartsSinceFirstSeen: decision.restartsSinceFirstSeen,
        restartPolicy: container.restartPolicy,
        state: container.state,
        kind: decision.kind,
        message: decision.message,
        logTail,
        inferenceBackend: inferenceContainerNames.get(container.name) ?? null,
      });

      await this.raise('error', decision.message, {
        container: container.name,
        image: container.image,
        restartCount: decision.restartCount,
        restartsSinceFirstSeen: decision.restartsSinceFirstSeen,
        restartPolicy: container.restartPolicy,
        kind: decision.kind,
        logTail,
      });
    }

    this.restartLoops = reports;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private async listContainers(): Promise<SupervisionContainerState[]> {
    const names = new Set<string>();
    for (const candidates of Object.values(SUPERVISION_CONTAINER_CANDIDATES)) {
      for (const name of candidates) names.add(name);
    }
    try {
      const containers = await this.dockerRead.inspectSupervisionCandidates({
        composeProject: hubComposeProject(),
        containerNames: [...names],
      });
      this.dockerError = null;
      return containers;
    } catch (error) {
      // `inspectSupervisionCandidates` already degrades to `[]`, so reaching here means something
      // more unusual. Record it for the report rather than failing the tick.
      this.dockerError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  /**
   * Write the alarm where a human will find it. `host_event_log` survives a reboot, which matters:
   * an operator who comes back to a box that has been looping for a week needs the record, not a
   * log line that rotated away. The logger is written unconditionally, because telemetry is
   * `@Optional()` and a missing provider must not swallow the one thing this layer is for.
   */
  private async raise(level: 'error' | 'warn', message: string, details: Record<string, unknown>): Promise<void> {
    if (level === 'error') {
      this.logger.error(`[inference-observer] ${message}`);
    } else {
      this.logger.warn(`[inference-observer] ${message}`);
    }
    try {
      await this.telemetry?.recordEvent(level, EVENT_SOURCE, message, details);
    } catch (error) {
      this.logger.warn(`Could not record an inference observation event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveMode(): ReturnType<typeof resolveInferenceSupervisionMode> {
    try {
      return resolveInferenceSupervisionMode(this.configuration.getInferenceSupervisionMode());
    } catch {
      return { mode: 'off', disabledBy: 'setting' };
    }
  }

  private pollSeconds(): number {
    try {
      return clampSupervisionPollSeconds(this.configuration.getInferenceSupervisionPollSeconds());
    } catch {
      return clampSupervisionPollSeconds(undefined);
    }
  }

  private runtimeFor(backend: InferenceBackendType): BackendRuntimeState {
    let state = this.runtime.get(backend);
    if (!state) {
      state = {
        health: 'unknown',
        healthError: null,
        observedAt: null,
        lastHealthyAt: null,
        consecutiveUnhealthy: 0,
        lastDiagnosisKey: '',
        diagnoses: [],
        logTail: null,
      };
      this.runtime.set(backend, state);
    }
    return state;
  }

  private observationFor(backend: InferenceBackendType): BackendObservation {
    const state = this.runtime.get(backend);
    const target = this.targets.get(backend) ?? {
      kind: 'absent' as const,
      ref: null,
      reason: 'Not observed yet — observation has not completed a pass on this node.',
    };
    const container = this.containerByBackend.get(backend) ?? null;
    let baseUrl = '';
    try {
      baseUrl = this.backends.get(backend).getBaseUrl();
    } catch {
      baseUrl = '';
    }
    return {
      backend,
      baseUrl,
      target,
      health: state?.health ?? 'unknown',
      healthError: state?.healthError ?? null,
      observedAt: state?.observedAt ? new Date(state.observedAt).toISOString() : null,
      lastHealthyAt: state?.lastHealthyAt ? new Date(state.lastHealthyAt).toISOString() : null,
      consecutiveUnhealthy: state?.consecutiveUnhealthy ?? 0,
      restartCount: container?.restartCount ?? null,
      restartsSinceFirstSeen: container ? this.restartWatcher.restartsSinceFirstSeen(container.name) : null,
      diagnoses: state?.diagnoses ?? [],
      logTail: state?.logTail ?? null,
    };
  }
}
