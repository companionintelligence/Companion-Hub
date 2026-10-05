import type { InferenceBackendType } from '@ci-hub/common/types';
import type { BackendDiagnosis, SupervisionContainerState } from './supervision.types';

/**
 * A build/JIT/import failure during startup. The fleet hit this as a vLLM restart loop caused by a
 * FlashInfer JIT compile against an incompatible gcc.
 */
const STARTUP_DEPENDENCY_LOG_PATTERN = /flashinfer|nvcc|error: command .* failed|ImportError|ModuleNotFoundError|undefined symbol/i;

export interface DiagnosisInput {
  backend: InferenceBackendType;
  /** The matched container, when the target resolved to one. */
  container: SupervisionContainerState | null;
  /** Last captured `docker logs --tail`, when one was captured. */
  logTail: string | null;
  /** Count of `Z`/`defunct` entries seen in the container's process table, when it was read. */
  zombieProcessCount: number | null;
  /** The health check's own error string. */
  healthError: string | null;
}

/**
 * Classify what is wrong, for the operator. Pure.
 *
 * Every code here answers "what should a human do", never "what should the Hub do next" — the Hub
 * does nothing next. That is why each remediation is a command or a configuration change and none
 * of them is "retrying".
 */
export function diagnoseBackendFailure(input: DiagnosisInput): BackendDiagnosis[] {
  const diagnoses: BackendDiagnosis[] = [];
  const logTail = input.logTail ?? '';

  // ── Startup dependency / JIT compile failure ─────────────────────────────
  if (input.container !== null && !input.container.running && STARTUP_DEPENDENCY_LOG_PATTERN.test(logTail)) {
    diagnoses.push({
      code: 'startup_dependency_failure',
      summary:
        `${input.container.name} exited during startup with a build or import failure in its logs ` +
        `(exit code ${input.container.exitCode ?? 'unknown'}). This is a deterministic failure — it will fail the same way every time it starts.`,
      remediation:
        `Read the failure with: docker logs --tail 200 ${input.container.name}. A JIT/compile failure (FlashInfer, nvcc, gcc) ` +
        `usually means the image's toolchain does not match this host; pin an image built for it rather than letting the ` +
        'container recompile on every start.',
    });
  }

  // ── Accumulated zombie children ──────────────────────────────────────────
  //
  // The fleet saw this on lemonade: the container answers /v1/health while defunct `llama-server`
  // children pile up. Note the reparenting detail — their PPID is `lemond`, not 1, so a
  // "parent is init" test finds nothing. Only the STAT column tells the truth, and only from
  // inside the container's own PID namespace, which is what `docker top` reads.
  if (input.container !== null && input.zombieProcessCount !== null && input.zombieProcessCount >= 8) {
    diagnoses.push({
      code: 'zombie_child_processes',
      summary:
        `${input.container.name} has ${input.zombieProcessCount} defunct child processes. Their parent is the supervisor ` +
        'process inside the container, not init, so they are never reaped and the count only grows.',
      remediation:
        `Confirm with: docker top ${input.container.name} -eo pid,ppid,stat,comm. They clear on the next restart of the ` +
        'container, which is an operator action — the Hub will not restart it.',
    });
  }

  return diagnoses;
}
