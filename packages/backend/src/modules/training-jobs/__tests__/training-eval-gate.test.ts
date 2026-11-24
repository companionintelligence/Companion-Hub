import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../training-eval-gate';

const up = { metric: 'l0_top1', higherIsBetter: true, minDelta: 0, floor: 0.75 };
const down = { metric: 'val_loss', higherIsBetter: false, minDelta: 0.01 };

describe('eval gate', () => {
  it('never promotes a non-finite candidate', () => {
    expect(evaluateGate(up, Number.NaN, 0.8).promote).toBe(false);
    expect(evaluateGate(up, Number.POSITIVE_INFINITY, null).promote).toBe(false);
  });

  it('blocks a candidate under the floor even with no baseline', () => {
    expect(evaluateGate(up, 0.7, null).promote).toBe(false);
  });

  it('promotes the first artifact that clears the floor', () => {
    expect(evaluateGate(up, 0.76, null)).toMatchObject({ promote: true, reason: 'no baseline, floor cleared' });
  });

  it('blocks a regression and allows a tie when minDelta is 0', () => {
    expect(evaluateGate(up, 0.78, 0.8).promote).toBe(false);
    expect(evaluateGate(up, 0.8, 0.8).promote).toBe(true);
  });

  it('handles lower-is-better metrics and a positive minDelta', () => {
    expect(evaluateGate(down, 0.495, 0.5).promote).toBe(false);
    expect(evaluateGate(down, 0.48, 0.5).promote).toBe(true);
  });

  it('treats a non-finite baseline as no baseline', () => {
    expect(evaluateGate(up, 0.8, Number.NaN).promote).toBe(true);
  });

  it('evaluates decision model calibration error and Brier score gates correctly', () => {
    const brierGate = { metric: 'decision_brier_score', higherIsBetter: false, minDelta: 0.02, floor: 0.15 };
    // Exceeds floor (0.18 > 0.15) -> blocked
    expect(evaluateGate(brierGate, 0.18, 0.2).promote).toBe(false);
    // Clears floor with no baseline
    expect(evaluateGate(brierGate, 0.12, null).promote).toBe(true);
    // Compares with baseline (needs 0.02 improvement: 0.14 vs 0.15 is only 0.01 improvement -> blocked)
    expect(evaluateGate(brierGate, 0.14, 0.15).promote).toBe(false);
    // 0.12 vs 0.15 improves by 0.03 -> promoted
    expect(evaluateGate(brierGate, 0.12, 0.15).promote).toBe(true);
  });
});
