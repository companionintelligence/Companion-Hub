import { describe, expect, it, vi } from 'vitest';
import { estimateRemainingSeconds, runSteps } from '../training-job.runner';

const steps = [
  { name: 'a', onFailure: 'continue' as const, etaSeconds: 10 },
  { name: 'b', onFailure: 'continue' as const, etaSeconds: 20 },
  { name: 'c', onFailure: 'stop' as const, etaSeconds: 30 },
  { name: 'd', onFailure: 'continue' as const, etaSeconds: 40 },
];

describe('runSteps', () => {
  it('records a failing continue step and keeps going', async () => {
    const seen: string[] = [];
    const report = await runSteps(
      { steps },
      {
        a: async () => void seen.push('a'),
        b: async () => {
          throw new Error('boom');
        },
        c: async () => void seen.push('c'),
        d: async () => void seen.push('d'),
      },
      { signal: new AbortController().signal },
    );
    expect(seen).toEqual(['a', 'c', 'd']);
    expect(report.steps.map((s) => s.outcome)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(report.steps[1].error).toBe('boom');
    expect(report.completed).toBe(true);
  });

  it('stops after a failing stop step and marks the rest skipped', async () => {
    const report = await runSteps(
      { steps },
      {
        a: async () => undefined,
        b: async () => undefined,
        c: async () => {
          throw new Error('fatal');
        },
        d: async () => undefined,
      },
      { signal: new AbortController().signal },
    );
    expect(report.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'failed', 'skipped']);
    expect(report.completed).toBe(false);
    expect(report.cancelled).toBe(false);
  });

  it('turns a missing handler into a step failure, not a crash', async () => {
    const report = await runSteps(
      { steps: steps.slice(0, 2) },
      { a: async () => undefined },
      {
        signal: new AbortController().signal,
      },
    );
    expect(report.steps[1]).toMatchObject({ name: 'b', outcome: 'failed', error: 'no handler registered' });
  });

  it('cancels between steps and hands the signal to handlers', async () => {
    const ctl = new AbortController();
    const sawSignal = vi.fn();
    const report = await runSteps(
      { steps },
      {
        a: async ({ signal }) => {
          sawSignal(signal === ctl.signal);
          ctl.abort();
        },
        b: async () => undefined,
        c: async () => undefined,
        d: async () => undefined,
      },
      { signal: ctl.signal },
    );
    expect(sawSignal).toHaveBeenCalledWith(true);
    expect(report.steps.map((s) => s.outcome)).toEqual(['ok', 'cancelled', 'cancelled', 'cancelled']);
    expect(report.cancelled).toBe(true);
    expect(report.completed).toBe(false);
  });

  it('does not start any step when already cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const a = vi.fn();
    const report = await runSteps({ steps }, { a }, { signal: ctl.signal });
    expect(a).not.toHaveBeenCalled();
    expect(report.steps.every((s) => s.outcome === 'cancelled')).toBe(true);
  });

  it('reports progress with a shrinking eta', async () => {
    const etas: number[] = [];
    let t = 0;
    await runSteps(
      { steps: steps.slice(0, 3) },
      { a: async () => undefined, b: async () => undefined, c: async () => undefined },
      {
        signal: new AbortController().signal,
        now: () => (t += 1000),
        onProgress: (p) => etas.push(p.etaSeconds),
      },
    );
    expect(etas[0]).toBe(60);
    expect(etas[1]).toBeLessThan(etas[0]);
  });
});

describe('estimateRemainingSeconds', () => {
  it('scales declared eta by how finished steps ran against theirs', () => {
    const done = [{ name: 'a', outcome: 'ok' as const, durationMs: 20_000 }]; // declared 10s, took 20s
    expect(estimateRemainingSeconds(steps, done, 1)).toBe(180); // (20+30+40) * 2
  });

  it('falls back to declared eta with no history', () => {
    expect(estimateRemainingSeconds(steps, [], 0)).toBe(100);
  });
});
