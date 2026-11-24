import type { TrainingJobManifest } from './training-job.manifest';

/**
 * HBPE's nightly pipeline expressed as a manifest. Step names and ETAs come straight from
 * CI-Memory `ci.hbpe.functions.nightly` and `STEP_ETA_SECONDS`, so this is the proof that the
 * generic shape can carry the one job that exists today without changing its internals.
 */
export function hbpeNightlyManifest(userId: string): TrainingJobManifest {
  const step = (name: string, etaSeconds: number) => ({ name, onFailure: 'continue' as const, etaSeconds });
  return {
    version: 1,
    kind: 'hbpe.nightly',
    subject: userId,
    steps: [
      step('label', 3600),
      step('label_summaries', 180),
      step('l1_sweep', 45),
      step('l2_sweep', 45),
      step('serialize', 180),
      step('bootstrap_check', 20),
      step('train', 2700),
      step('export', 300),
      step('lora', 240),
      step('backfill_actuals', 90),
      step('recurrence', 90),
      step('drift', 45),
      step('cache', 20),
    ],
    resources: { device: 'any', minMemoryMb: 4096, images: ['cpu', 'cuda', 'rocm'], framework: 'pytorch' },
    trigger: { cron: '0 3 * * *' },
    yieldToInference: { mode: 'yield', maxWaitSeconds: 600 },
    data: {
      mounts: [{ name: 'token-stream', path: '/data/memory/hbpe', mode: 'ro' }],
      network: 'none',
      allowRemoteOffload: false,
    },
    artifacts: {
      dir: '/data/models/hmt/users',
      compatibility: { architecture: '256x6h8ff1024' },
      keepVersions: 3,
    },
    // HBPE targets from CI-HBPE-SPEC-001 section 7.2.
    evalGate: { metric: 'l0_top1', higherIsBetter: true, minDelta: 0, floor: 0.75 },
    timeoutSeconds: 4 * 3600,
  };
}
