import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, isTerminal, transition } from '../training-job.state';

describe('training job state machine', () => {
  it('walks the happy path to COMPLETED', () => {
    let s = transition('QUEUED', 'resources_granted');
    s = transition(s, 'resources_granted');
    s = transition(s, 'data_ready');
    s = transition(s, 'steps_done');
    s = transition(s, 'gate_passed');
    s = transition(s, 'promoted');
    expect(s).toBe('COMPLETED');
    expect(isTerminal(s)).toBe(true);
  });

  it('treats a rejected gate as completed, not failed', () => {
    expect(transition('EVALUATING', 'gate_rejected')).toBe('COMPLETED');
  });

  it('allows cancel before promotion and not during it', () => {
    for (const s of ['QUEUED', 'ACQUIRING_RESOURCES', 'STAGING_DATA', 'RUNNING', 'EVALUATING'] as const) {
      expect(transition(s, 'cancel')).toBe('CANCELLED');
    }
    expect(() => transition('PROMOTING', 'cancel')).toThrow(InvalidTransitionError);
  });

  it('never leaves a terminal state', () => {
    for (const s of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(() => transition(s, 'error')).toThrow(InvalidTransitionError);
      expect(() => transition(s, 'cancel')).toThrow(InvalidTransitionError);
    }
  });

  it('rejects out-of-order events', () => {
    expect(() => transition('QUEUED', 'steps_done')).toThrow(InvalidTransitionError);
    expect(() => transition('RUNNING', 'promoted')).toThrow(/cannot apply promoted in state RUNNING/);
  });

  it('can fail from any live state', () => {
    for (const s of ['QUEUED', 'ACQUIRING_RESOURCES', 'STAGING_DATA', 'RUNNING', 'EVALUATING', 'PROMOTING'] as const) {
      expect(transition(s, 'error')).toBe('FAILED');
    }
  });
});
