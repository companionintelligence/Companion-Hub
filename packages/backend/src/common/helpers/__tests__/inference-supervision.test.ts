import { afterEach, describe, expect, it } from 'vitest';
import {
  clampSupervisionPollSeconds,
  DEFAULT_INFERENCE_SUPERVISION_MODE,
  DEFAULT_SUPERVISION_POLL_SECONDS,
  INFERENCE_SUPERVISION_DISABLED_ENV_VAR,
  INFERENCE_SUPERVISION_MODES,
  MAX_SUPERVISION_POLL_SECONDS,
  MIN_SUPERVISION_POLL_SECONDS,
  resolveInferenceSupervisionMode,
} from '../inference-supervision';

describe('inference supervision mode', () => {
  afterEach(() => {
    delete process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR];
  });

  it('has no mode that could restart a backend', () => {
    // The union IS the guarantee. A 'supervise' member would be the whole defect: an appliance that
    // restarts an inference engine on its own is how the ~97,000-restart incident happened, and
    // every restart-capable variant of this design was shown to reproduce its shape.
    expect([...INFERENCE_SUPERVISION_MODES]).toEqual(['off', 'observe']);
  });

  it('defaults to off, so a Hub that never opts in polls nothing', () => {
    expect(DEFAULT_INFERENCE_SUPERVISION_MODE).toBe('off');
    expect(resolveInferenceSupervisionMode(undefined)).toEqual({ mode: 'off', disabledBy: 'setting' });
  });

  it('reports the persisted opt-in', () => {
    expect(resolveInferenceSupervisionMode('observe')).toEqual({ mode: 'observe', disabledBy: null });
  });

  it('lets the environment override the setting, and says which switch won', () => {
    process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR] = 'true';
    expect(resolveInferenceSupervisionMode('observe')).toEqual({ mode: 'off', disabledBy: 'env' });
  });

  it('ignores a non-"true" env value rather than treating any value as set', () => {
    process.env[INFERENCE_SUPERVISION_DISABLED_ENV_VAR] = 'false';
    expect(resolveInferenceSupervisionMode('observe')).toEqual({ mode: 'observe', disabledBy: null });
  });
});

describe('clampSupervisionPollSeconds', () => {
  it('falls back to the default for an absent or unusable value', () => {
    expect(clampSupervisionPollSeconds(undefined)).toBe(DEFAULT_SUPERVISION_POLL_SECONDS);
    expect(clampSupervisionPollSeconds(Number.NaN)).toBe(DEFAULT_SUPERVISION_POLL_SECONDS);
  });

  it('clamps rather than rejecting, because this is read on a path that must not fail', () => {
    expect(clampSupervisionPollSeconds(1)).toBe(MIN_SUPERVISION_POLL_SECONDS);
    expect(clampSupervisionPollSeconds(100_000)).toBe(MAX_SUPERVISION_POLL_SECONDS);
    expect(clampSupervisionPollSeconds(45)).toBe(45);
  });
});
