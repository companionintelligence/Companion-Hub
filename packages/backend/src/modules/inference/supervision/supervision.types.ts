import type { InferenceBackendType } from '@ci-hub/common/types';
import type { SupervisionContainerInspection } from '@/modules/docker/docker-read.facade';

/**
 * What control plane the Hub actually has over a backend.
 *
 * The inference backends are not uniform and pretending they are is how a supervisor ends up acting on
 * the wrong process. Resolved per tick, never assumed:
 *
 * - `container` — a Docker container the local daemon can see, whose published port matches the URL
 *   the health check probes. This is the only kind whose *lifecycle* is legible to the Hub, and
 *   even here the Hub only reports (see `common/helpers/inference-supervision.ts`).
 * - `host-process` — a daemon outside this container's PID namespace: host ollama under systemd,
 *   vLLM or oMLX under host process managers.
 * - `remote` — an endpoint on another machine. `preferredVllmUrl` legitimately points across a
 *   tailnet. A remote endpoint cannot be supervised locally; saying so is the honest answer, and
 *   the alternative is the Hub "helpfully" acting on a local container named `ci-hub-vllm` because
 *   a server somewhere else went down.
 * - `absent` — nothing answers and nothing matches. There is no process to describe.
 */
export type SupervisionTargetKind = 'container' | 'host-process' | 'remote' | 'absent';

export interface SupervisionTarget {
  kind: SupervisionTargetKind;
  /** Container name, remote host, or a short platform hint. `null` for `absent`. */
  ref: string | null;
  /**
   * Plain language for the operator surface. Always populated: even `container` carries one,
   * because the Hub deliberately does not act on containers either, and a UI that said
   * "supervisable" would be promising something no code path delivers.
   */
  reason: string;
}

/**
 * A container as the observer sees it: the list summary plus the inspect fields that carry loop
 * evidence.
 *
 * Aliased rather than redeclared. `DockerReadFacade` owns the shape because it owns the Dockerode
 * call that fills it, and a second declaration here would be one rename away from a silent
 * mismatch. The import is type-only, so nothing in the pure modules below picks up a runtime
 * dependency on Dockerode.
 */
export type SupervisionContainerState = SupervisionContainerInspection;

/** Codes the diagnosis catalogue can produce. Each is tied to a documented fleet failure. */
export type BackendDiagnosisCode = 'startup_dependency_failure' | 'zombie_child_processes' | 'no_weights' | 'external_restart_loop';

export interface BackendDiagnosis {
  code: BackendDiagnosisCode;
  summary: string;
  /** What the operator should do. Never "the Hub will retry" — it will not. */
  remediation: string;
}

/** Health as the observer records it, one grade coarser than `BackendHealthStatus`. */
export type ObservedHealth = 'healthy' | 'unhealthy' | 'unreachable' | 'unknown';

/** Per-backend observation, served by `GET /api/inference/supervision`. */
export interface BackendObservation {
  backend: InferenceBackendType;
  baseUrl: string;
  target: SupervisionTarget;
  health: ObservedHealth;
  /** The health check's own error string, when it produced one. */
  healthError: string | null;
  /** ISO timestamps of the last observation and the last time this backend was seen healthy. */
  observedAt: string | null;
  lastHealthyAt: string | null;
  /** Consecutive non-healthy observations. Reported, never acted on. */
  consecutiveUnhealthy: number;
  /** dockerd's own restart counter for the matched container; `null` for every other target kind. */
  restartCount: number | null;
  /** Restarts accumulated since this Hub first saw the container. `null` before a second sighting. */
  restartsSinceFirstSeen: number | null;
  diagnoses: BackendDiagnosis[];
  /** Last captured log tail, when a diagnosis needed one. Operator-only. */
  logTail: string | null;
}

/** One container in the Hub compose project that dockerd is looping. */
export interface RestartLoopReport {
  containerName: string;
  image: string;
  restartCount: number;
  restartsSinceFirstSeen: number | null;
  restartPolicy: string | null;
  state: string;
  /** `absolute` needs no history; `rate` is a delta measured while this Hub was watching. */
  kind: 'absolute' | 'rate';
  message: string;
  logTail: string | null;
  /** True when this container is one of the resolved inference backends. */
  inferenceBackend: InferenceBackendType | null;
}

/** The whole report, served by `GET /api/inference/supervision`. */
export interface SupervisionReport {
  mode: 'off' | 'observe';
  disabledBy: 'env' | 'setting' | null;
  pollSeconds: number;
  /**
   * Stated on the wire, not just in the docs, because it is the contract: no field of this report
   * is ever produced by the Hub having acted on a backend.
   */
  observeOnly: true;
  lastSweepAt: string | null;
  /** Why the last Docker sweep produced nothing, when it failed. `null` on success. */
  dockerError: string | null;
  backends: BackendObservation[];
  restartLoops: RestartLoopReport[];
}
