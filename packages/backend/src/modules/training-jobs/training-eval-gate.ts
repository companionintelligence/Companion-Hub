import type { TrainingEvalGate } from './training-job.manifest';

export interface GateDecision {
  promote: boolean;
  reason: string;
}

/**
 * Decide whether a freshly trained artifact replaces the current one.
 *
 * HBPE has offline walk-forward evaluation but nothing between "trained" and "served". This is that
 * gate. Rules, in order:
 *  - A non-finite candidate metric never promotes.
 *  - The absolute floor, if set, must be cleared.
 *  - With no baseline (first artifact) the floor alone decides.
 *  - Otherwise the candidate must beat the baseline by at least `minDelta`.
 */
export function evaluateGate(gate: TrainingEvalGate, candidate: number, baseline: number | null): GateDecision {
  if (!Number.isFinite(candidate)) return { promote: false, reason: `${gate.metric} is not finite` };

  if (gate.floor !== undefined) {
    const clears = gate.higherIsBetter ? candidate >= gate.floor : candidate <= gate.floor;
    if (!clears) return { promote: false, reason: `${gate.metric} ${candidate} misses floor ${gate.floor}` };
  }

  if (baseline === null || !Number.isFinite(baseline)) {
    return { promote: true, reason: 'no baseline, floor cleared' };
  }

  const delta = gate.higherIsBetter ? candidate - baseline : baseline - candidate;
  if (delta >= gate.minDelta) return { promote: true, reason: `${gate.metric} improved by ${delta}` };
  return { promote: false, reason: `${gate.metric} changed by ${delta}, needs ${gate.minDelta}` };
}
