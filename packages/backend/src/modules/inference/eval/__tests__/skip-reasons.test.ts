import { describe, expect, it } from 'vitest';
import { type EvalOutcomeRow, classifySkipReason, summarizeSkips, summarizeTimeouts } from '../skip-reasons';

describe('classifySkipReason', () => {
  it('sends a missing reason to no-reason, never to other — only one of the two is a defect in the harness', () => {
    for (const empty of [undefined, null, '', '   ', 42, {}]) {
      expect(classifySkipReason(empty).id).toBe('no-reason');
    }
    expect(classifySkipReason('   ').expected).toBe(false);
  });

  it('classifies a reason the patterns do not know as other, keeping it distinct from no-reason', () => {
    const b = classifySkipReason('the moon was in the wrong phase');
    expect(b.id).toBe('other');
    expect(b.fix).toMatch(/read the reason text/i);
  });

  it('routes each reason to the bucket whose fix an operator would act on', () => {
    expect(classifySkipReason('vllm not reachable on this target').id).toBe('backend-absent');
    expect(classifySkipReason('none of the 2 selected model(s) is resident here').id).toBe('model-pin-missed');
    expect(classifySkipReason('no resident embedding model for the role').id).toBe('no-resident-model');
    expect(classifySkipReason('pool is auth-gated, not measurable without a key').id).toBe('pool-guarded');
    expect(classifySkipReason('this build does not mount the pool').id).toBe('pool-absent');
    expect(classifySkipReason('0 of the 8 selected prompt(s) target it').id).toBe('nothing-selected');
    expect(classifySkipReason('Hub API unreachable on that port').id).toBe('hub-unreachable');
    expect(classifySkipReason('declares arm64; selected targets offer amd64').id).toBe('arch');
    expect(classifySkipReason('run stopped before this tuple was dispatched').id).toBe('run-ended');
  });

  it('marks a correct description of the deployment expected, and a mistake actionable', () => {
    expect(classifySkipReason('lemonade not found on this target').expected).toBe(true);
    expect(classifySkipReason('none of the 2 selected model(s) is resident here').expected).toBe(false);
  });
});

describe('summarizeSkips', () => {
  const rows: EvalOutcomeRow[] = [
    { status: 'skip', endpoint: 'a:11434', backend: 'vllm', notes: 'vllm not reachable on this target' },
    { status: 'skip', endpoint: 'b:11434', backend: 'vllm', notes: 'vllm not reachable on this target' },
    { status: 'skip', endpoint: 'a:11434', backend: 'ollama', notes: 'none of the 2 selected model(s) is resident here' },
    { status: 'skip', endpoint: 'c:8000', backend: 'mtplx', notes: '   ' },
    { status: 'pass', endpoint: 'a:11434', backend: 'ollama', notes: 'fine' },
    { status: 'timeout', endpoint: 'a:11434', backend: 'ollama', notes: 'took too long' },
  ];

  it('counts only skips, and never lets a timeout be filed as one', () => {
    const s = summarizeSkips(rows);
    expect(s.total).toBe(4);
    expect(s.buckets.flatMap((b) => b.reasons).some((r) => r.text === 'took too long')).toBe(false);
  });

  it('separates what to act on from what is expected, and reports a reason-less skip as a defect', () => {
    const s = summarizeSkips(rows);
    expect(s.actionable).toBe(2);
    expect(s.unexplained).toBe(1);
    expect(s.headline).toContain('4 skipped');
    expect(s.headline).toContain('2 worth acting on');
    expect(s.headline).toMatch(/NO reason recorded \(a harness defect\)/);
  });

  it('keeps every distinct sentence with its count, most common first', () => {
    const absent = summarizeSkips(rows).buckets.find((b) => b.id === 'backend-absent');
    expect(absent?.n).toBe(2);
    expect(absent?.endpoints).toEqual(['a:11434', 'b:11434']);
    expect(absent?.reasons[0]).toEqual({ text: 'vllm not reachable on this target', n: 2 });
  });

  it('labels the reason-less bucket rather than leaving a blank in the output', () => {
    const none = summarizeSkips(rows).buckets.find((b) => b.id === 'no-reason');
    expect(none?.reasons).toEqual([{ text: '(no reason recorded)', n: 1 }]);
  });

  it('says so plainly when nothing was skipped, instead of reporting a bare 0', () => {
    const s = summarizeSkips([]);
    expect(s.headline).toBe('nothing was skipped');
    expect(s.buckets).toEqual([]);
  });
});

describe('summarizeTimeouts', () => {
  it('groups by endpoint and backend, because 35 on one target is a different finding from 35 spread out', () => {
    const s = summarizeTimeouts([
      { status: 'timeout', endpoint: 'a:11434', backend: 'ollama', promptId: 'p1', timeoutMs: 30000, durationMs: 30100 },
      { status: 'timeout', endpoint: 'a:11434', backend: 'ollama', promptId: 'p1', timeoutMs: 60000, durationMs: 61000 },
      { status: 'timeout', endpoint: 'b:8000', backend: 'vllm', promptId: 'p2', timeoutMs: 30000 },
      { status: 'skip', endpoint: 'b:8000', backend: 'vllm', notes: 'not reachable on this target' },
    ]);
    expect(s.total).toBe(3);
    expect(s.groups[0]?.key).toBe('a:11434 · ollama');
    expect(s.groups[0]?.n).toBe(2);
    expect(s.groups[0]?.budgets).toEqual([30000, 60000]);
    expect(s.groups[0]?.longestMs).toBe(61000);
    expect(s.groups[1]?.longestMs).toBeNull();
  });

  it('states that a timeout measured something, so it is never merged into the skip count', () => {
    const s = summarizeTimeouts([{ status: 'timeout', endpoint: 'a:1', backend: 'ollama', timeoutMs: 1000 }]);
    expect(s.headline).toContain('the request was SENT');
    expect(s.headline).toContain('not a skip');
    expect(summarizeTimeouts([]).headline).toBe('nothing timed out');
  });
});
