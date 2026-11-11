import { describe, expect, it } from 'vitest';
import { type PlacementNode, type PlacementRequest, rankNodesForJob } from '../training-placement';

function node(over: Partial<PlacementNode> & { key: string }): PlacementNode {
  return {
    isLocal: false,
    acceptingTraining: true,
    tier: 'medium',
    freeMemoryMb: 32_000,
    hasGpu: true,
    images: ['cpu', 'rocm'],
    frameworks: ['pytorch'],
    activeTrainingJobs: 0,
    inferenceInFlight: 0,
    gpuPressure: 0,
    snapshotAgeMs: 1_000,
    ...over,
  };
}

const req: PlacementRequest = {
  requiredMemoryMb: 8_000,
  device: 'any',
  images: ['cpu', 'cuda', 'rocm'],
  framework: 'pytorch',
  priority: 'normal',
  dataHome: null,
  allowRemoteOffload: true,
};

const keys = (r: ReturnType<typeof rankNodesForJob>) => r.candidates.map((c) => c.key);

describe('rankNodesForJob', () => {
  it('prefers the less loaded node', () => {
    const r = rankNodesForJob(req, [
      node({ key: 'busy.ts.net', activeTrainingJobs: 2 }),
      node({ key: 'idle.ts.net', activeTrainingJobs: 0 }),
    ]);
    expect(keys(r)).toEqual(['idle.ts.net', 'busy.ts.net']);
  });

  it('ranks unmeasured counters as mid-load, never idle and never worst', () => {
    const unknown = node({ key: 'unknown.ts.net', activeTrainingJobs: null, inferenceInFlight: null, gpuPressure: null });
    const idle = node({ key: 'idle.ts.net' });
    const swamped = node({ key: 'swamped.ts.net', activeTrainingJobs: 3, inferenceInFlight: 3, gpuPressure: 1 });
    const r = rankNodesForJob(req, [swamped, unknown, idle]);
    // unknown scores 1 + 0.5 * 1 + 1 = 2.5, between idle (0) and swamped (3 + 1.5 + 1 = 5.5)
    expect(keys(r)).toEqual(['idle.ts.net', 'unknown.ts.net', 'swamped.ts.net']);
    expect(r.candidates[1].score).toBeCloseTo(2.5);
  });

  it('rejects a stale node for memory instead of guessing', () => {
    const r = rankNodesForJob(req, [node({ key: 'stale.ts.net', snapshotAgeMs: 120_000 })]);
    expect(r.candidates).toEqual([]);
    expect(r.rejected).toEqual([{ key: 'stale.ts.net', reason: 'memory_unknown' }]);
  });

  it('gives the local node a head start that affinity controls', () => {
    const nodes = [
      node({ key: 'local', isLocal: true, activeTrainingJobs: 1, snapshotAgeMs: null }),
      node({ key: 'peer.ts.net', activeTrainingJobs: 0 }),
    ];
    // Scores tie at 0 (1 - affinity 1 versus 0), and the local node wins the tier tiebreak.
    expect(keys(rankNodesForJob(req, nodes))[0]).toBe('local');
    expect(keys(rankNodesForJob(req, nodes, { localAffinity: 0 }))[0]).toBe('peer.ts.net');
  });

  it('charges inference load by priority', () => {
    const nodes = [
      node({ key: 'chatty.ts.net', inferenceInFlight: 3 }),
      node({ key: 'quiet.ts.net', inferenceInFlight: 0, activeTrainingJobs: 1 }),
    ];
    expect(keys(rankNodesForJob({ ...req, priority: 'interactive' }, nodes))[0]).toBe('chatty.ts.net');
    expect(keys(rankNodesForJob({ ...req, priority: 'nightly_idle' }, nodes))[0]).toBe('quiet.ts.net');
  });

  it('applies hard constraints with a reason for each', () => {
    const r = rankNodesForJob({ ...req, device: 'gpu', requiredMemoryMb: 16_000 }, [
      node({ key: 'a', acceptingTraining: false }),
      node({ key: 'b', frameworks: ['mlx'] }),
      node({ key: 'c', images: ['cuda'], hasGpu: true }),
      node({ key: 'd', images: ['cpu'], hasGpu: true }),
      node({ key: 'e', hasGpu: false }),
      node({ key: 'f', freeMemoryMb: 4_000 }),
      node({ key: 'g', freeMemoryMb: null }),
      node({ key: 'ok' }),
    ]);
    const reasons = Object.fromEntries(r.rejected.map((x) => [x.key, x.reason]));
    expect(reasons).toMatchObject({
      a: 'not_accepting',
      b: 'framework_unsupported',
      e: 'no_gpu',
      f: 'insufficient_memory',
      g: 'memory_unknown',
    });
    expect(keys(r)).toContain('ok');
  });

  it('rejects an image mismatch', () => {
    const r = rankNodesForJob({ ...req, images: ['cuda'] }, [node({ key: 'rocm-only.ts.net', images: ['rocm'] })]);
    expect(r.rejected[0].reason).toBe('no_compatible_image');
  });

  it('pins to the data node unless offload is allowed', () => {
    const nodes = [
      node({ key: 'home.ts.net', activeTrainingJobs: 3 }),
      node({ key: 'other.ts.net', activeTrainingJobs: 0 }),
    ];
    const pinned = rankNodesForJob({ ...req, dataHome: 'home.ts.net', allowRemoteOffload: false }, nodes);
    expect(keys(pinned)).toEqual(['home.ts.net']);
    expect(pinned.rejected).toEqual([{ key: 'other.ts.net', reason: 'data_pinned' }]);
  });

  it('makes remote nodes pay a transfer penalty when offload is allowed', () => {
    const nodes = [
      node({ key: 'home.ts.net', activeTrainingJobs: 1 }),
      node({ key: 'other.ts.net', activeTrainingJobs: 0 }),
    ];
    const r = rankNodesForJob({ ...req, dataHome: 'home.ts.net', allowRemoteOffload: true }, nodes);
    // home: 1 + 0.5*0 + 0 = 1 ; other: 0 + 0 + 0 + penalty 1 = 1 ; tie falls to key order
    expect(keys(r)).toEqual(['home.ts.net', 'other.ts.net']);
    const cheaper = rankNodesForJob({ ...req, dataHome: 'home.ts.net', allowRemoteOffload: true }, nodes, {
      remotePenalty: 0,
    });
    expect(keys(cheaper)[0]).toBe('other.ts.net');
  });

  it('breaks ties by pressure, then tier, then key, deterministically', () => {
    const r = rankNodesForJob(req, [
      node({ key: 'b.ts.net', tier: 'low' }),
      node({ key: 'a.ts.net', tier: 'low' }),
      node({ key: 'c.ts.net', tier: 'high' }),
    ]);
    expect(keys(r)).toEqual(['c.ts.net', 'a.ts.net', 'b.ts.net']);
  });

  it('returns an empty list, not an error, when nothing qualifies', () => {
    const r = rankNodesForJob(req, []);
    expect(r).toEqual({ candidates: [], rejected: [] });
  });
});
