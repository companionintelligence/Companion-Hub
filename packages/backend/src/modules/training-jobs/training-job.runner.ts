import type { TrainingJobManifest } from './training-job.manifest';

export type StepOutcome = 'ok' | 'failed' | 'skipped' | 'cancelled';

export interface StepResult {
  name: string;
  outcome: StepOutcome;
  error?: string;
  durationMs: number;
  value?: unknown;
}

export interface RunProgress {
  step: string;
  stepIndex: number;
  totalSteps: number;
  /** Seconds left, refined from steps already finished. */
  etaSeconds: number;
}

export type StepHandler = (ctx: { signal: AbortSignal }) => Promise<unknown>;

export interface RunOptions {
  signal: AbortSignal;
  now?: () => number;
  onProgress?: (p: RunProgress) => void;
}

export interface RunReport {
  steps: StepResult[];
  /** True when every step with onFailure=stop succeeded and the run was not cancelled. */
  completed: boolean;
  cancelled: boolean;
}

/**
 * Executes a manifest's steps in order. Port of HBPE `functions.nightly`:
 *  - a failing `continue` step is recorded and the run moves on,
 *  - a failing `stop` step ends the run, the rest are marked skipped,
 *  - cancel is cooperative: it is checked between steps and handed to each handler as a signal,
 *  - a missing handler is a failure of that step, not a crash of the run.
 */
export async function runSteps(
  manifest: Pick<TrainingJobManifest, 'steps'>,
  handlers: Readonly<Record<string, StepHandler>>,
  opts: RunOptions,
): Promise<RunReport> {
  const now = opts.now ?? Date.now;
  const results: StepResult[] = [];
  const total = manifest.steps.length;
  let stopped = false;
  let cancelled = false;
  let stoppedOnFailure = false;

  for (let i = 0; i < total; i++) {
    const step = manifest.steps[i];

    if (stopped || opts.signal.aborted) {
      if (opts.signal.aborted && !stopped) cancelled = true;
      stopped = true;
      results.push({ name: step.name, outcome: cancelled ? 'cancelled' : 'skipped', durationMs: 0 });
      continue;
    }

    opts.onProgress?.({
      step: step.name,
      stepIndex: i,
      totalSteps: total,
      etaSeconds: estimateRemainingSeconds(manifest.steps, results, i),
    });

    const started = now();
    const handler = handlers[step.name];
    if (!handler) {
      results.push({ name: step.name, outcome: 'failed', error: 'no handler registered', durationMs: 0 });
      if (step.onFailure === 'stop') {
        stopped = true;
        stoppedOnFailure = true;
      }
      continue;
    }

    try {
      const value = await handler({ signal: opts.signal });
      results.push({ name: step.name, outcome: 'ok', value, durationMs: now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name: step.name, outcome: 'failed', error: message, durationMs: now() - started });
      if (step.onFailure === 'stop') {
        stopped = true;
        stoppedOnFailure = true;
      }
    }

    if (opts.signal.aborted) cancelled = true;
  }

  return { steps: results, completed: !stoppedOnFailure && !cancelled, cancelled };
}

/**
 * Remaining time: declared ETAs for steps not yet run, scaled by how far finished steps ran over or
 * under their own ETAs. Same idea as HBPE `update_pipeline_progress`, applied per step.
 */
export function estimateRemainingSeconds(
  steps: TrainingJobManifest['steps'],
  done: readonly StepResult[],
  nextIndex: number,
): number {
  let declaredDone = 0;
  let actualDone = 0;
  for (let i = 0; i < done.length && i < steps.length; i++) {
    if (done[i].outcome !== 'ok') continue;
    declaredDone += steps[i].etaSeconds;
    actualDone += done[i].durationMs / 1000;
  }
  const scale = declaredDone > 0 && actualDone > 0 ? actualDone / declaredDone : 1;
  const declaredLeft = steps.slice(nextIndex).reduce((sum, s) => sum + s.etaSeconds, 0);
  return Math.round(declaredLeft * scale);
}
