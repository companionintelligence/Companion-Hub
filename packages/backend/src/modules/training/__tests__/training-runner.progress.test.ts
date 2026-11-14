import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { TrainingGovernorService } from '../training-governor.service';
import { TrainingRunnerService } from '../training-runner.service';
import type { TrainingJobManifest, TrainingJobStatus, TrainingProgressEvent } from '../training.types';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// The trainer's stdout is the input under test, so the spawn is replaced with a child the test writes to.
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  exec: vi.fn(),
}));

type SpawnInternals = {
  spawnTrainingProcess(manifest: TrainingJobManifest, manifestPath: string, artifactsDir: string): Promise<void>;
};

type ProgressInternals = {
  handleProgressEvent(jobId: string, payload: unknown): void;
};

function manifestFor(jobId: string): TrainingJobManifest {
  return {
    jobId,
    appId: 'ci-memory',
    jobType: 'hbpe_bootstrap_hmt',
    model: { backboneId: 'ci/hmt-v1', framework: 'pytorch', targetFormat: 'onnx_int8' },
    dataset: { format: 'token_stream_jsonl', dataPath: '/data/train.jsonl', valFraction: 0.15 },
    hyperparameters: { batchSize: 16, learningRate: 1e-4, epochs: 20, mixedPrecision: true },
    resourcePolicy: { devicePreference: 'cpu', allowRemoteOffload: false, priority: 'normal', timeoutSeconds: 3600 },
  };
}

function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
}

/** Deferred before it starts, so the job has a status and no trainer is started for it. */
function deferringGovernor(): MockProxy<TrainingGovernorService> {
  const governor = mock<TrainingGovernorService>();
  governor.evaluateLocalCapacity.mockResolvedValue({ canExecuteLocal: false, recommendedAction: 'DEFER', reason: 'test' });
  return governor;
}

/**
 * A job with a status, whose trainer is a fake child. `progress` writes one stdout line to the trainer,
 * which is parsed as the runner parses it.
 */
async function attachedJob(jobId: string) {
  const runner = new TrainingRunnerService(deferringGovernor());
  await runner.submitJob(manifestFor(jobId));
  await vi.waitFor(() => expect(runner.getJobStatus(jobId)?.state).toBe('DEFERRED'));

  const child = fakeChild();
  spawnMock.mockReturnValueOnce(child);
  void (runner as unknown as SpawnInternals).spawnTrainingProcess(manifestFor(jobId), '/data/manifest.json', '/data/artifacts');

  const progress = (line: string) => child.stdout.emit('data', Buffer.from(`${line}\n`));
  return { runner, progress };
}

describe('TrainingRunnerService progress events', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('copies finite progress numbers into the status a peer reads', async () => {
    const { runner, progress } = await attachedJob('progress-numbers');

    progress('CI_TRAIN_EVENT: {"epoch": 3, "totalEpochs": 10, "trainLoss": 0.52, "valLoss": 0.61, "etaSeconds": 120}');

    expect(runner.getJobStatus('progress-numbers')).toMatchObject({
      currentEpoch: 3,
      totalEpochs: 10,
      progressPercent: 30,
      trainLoss: 0.52,
      valLoss: 0.61,
      etaSeconds: 120,
    });
  });

  it('ignores values that are not finite numbers', async () => {
    const { runner, progress } = await attachedJob('progress-bad');
    progress('CI_TRAIN_EVENT: {"epoch": 3, "totalEpochs": 10, "trainLoss": 0.52, "etaSeconds": 120}');

    // 1e400 parses to Infinity, and the other values are the wrong type.
    progress('CI_TRAIN_EVENT: {"epoch": "7", "totalEpochs": 1e400, "trainLoss": "0.01", "etaSeconds": {"seconds": 1}}');
    progress('CI_TRAIN_EVENT: {"epoch": 1e400, "totalEpochs": 10, "trainLoss": 1e400, "etaSeconds": 1e400}');

    expect(runner.getJobStatus('progress-bad')).toMatchObject({
      currentEpoch: 3,
      totalEpochs: 10,
      progressPercent: 30,
      trainLoss: 0.52,
      etaSeconds: 120,
    });
  });

  it('accepts null as the validation loss, and no other value that is not a finite number', async () => {
    const { runner, progress } = await attachedJob('progress-val');

    progress('CI_TRAIN_EVENT: {"valLoss": 0.7}');
    expect(runner.getJobStatus('progress-val')?.valLoss).toBe(0.7);

    progress('CI_TRAIN_EVENT: {"valLoss": 1e400}');
    progress('CI_TRAIN_EVENT: {"valLoss": "0.4"}');
    expect(runner.getJobStatus('progress-val')?.valLoss).toBe(0.7);

    progress('CI_TRAIN_EVENT: {"valLoss": null}');
    expect(runner.getJobStatus('progress-val')?.valLoss).toBeNull();
  });

  it('updates progress only when epoch is finite and totalEpochs is a finite number above zero', async () => {
    const { runner, progress } = await attachedJob('progress-epochs');

    progress('CI_TRAIN_EVENT: {"epoch": 2, "totalEpochs": 0}');
    progress('CI_TRAIN_EVENT: {"epoch": 2, "totalEpochs": -4}');
    progress('CI_TRAIN_EVENT: {"epoch": 1e400, "totalEpochs": 10}');
    expect(runner.getJobStatus('progress-epochs')).toMatchObject({ currentEpoch: 0, totalEpochs: 20, progressPercent: 0 });

    progress('CI_TRAIN_EVENT: {"epoch": 5, "totalEpochs": 20}');
    expect(runner.getJobStatus('progress-epochs')).toMatchObject({ currentEpoch: 5, totalEpochs: 20, progressPercent: 25 });
  });

  it('ignores a payload that is not a JSON object', async () => {
    const { runner, progress } = await attachedJob('progress-shape');

    expect(() => {
      progress('CI_TRAIN_EVENT: null');
      progress('CI_TRAIN_EVENT: 7');
      progress('CI_TRAIN_EVENT: "text"');
    }).not.toThrow();
    expect(runner.getJobStatus('progress-shape')).toMatchObject({ currentEpoch: 0, totalEpochs: 20, progressPercent: 0 });
  });

  it('emits progress events with a finite learning rate and elapsed time, or zero', async () => {
    const { runner, progress } = await attachedJob('progress-event');
    const events: TrainingProgressEvent[] = [];
    runner.events.on('progress.progress-event', (event: TrainingProgressEvent) => events.push(event));

    progress('CI_TRAIN_EVENT: {"phase": "validation", "learningRate": "fast", "elapsedSeconds": 1e400, "device": "mps"}');
    progress('CI_TRAIN_EVENT: {"learningRate": 0.0003, "elapsedSeconds": 42}');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: 'validation', learningRate: 0, elapsedSeconds: 0, device: 'mps' });
    expect(events[1]).toMatchObject({ learningRate: 0.0003, elapsedSeconds: 42 });
  });

  it('keeps the last epoch fields and progressPercent when the percentage is not finite', async () => {
    const { runner, progress } = await attachedJob('progress-overflow');
    progress('CI_TRAIN_EVENT: {"epoch": 3, "totalEpochs": 10}');

    // 1e308 over 1e-10 overflows to Infinity. None of the three fields is written, so the status is not half updated.
    progress('CI_TRAIN_EVENT: {"epoch": 1e308, "totalEpochs": 1e-10}');

    expect(runner.getJobStatus('progress-overflow')).toMatchObject({ currentEpoch: 3, totalEpochs: 10, progressPercent: 30 });
  });

  it('ignores an array payload, with no event and no change to updatedAt', async () => {
    const { runner } = await attachedJob('progress-array');
    const events: TrainingProgressEvent[] = [];
    runner.events.on('progress.progress-array', (event: TrainingProgressEvent) => events.push(event));
    // A sentinel, so any write to updatedAt shows even when it falls in the same millisecond as the last one.
    const status = runner.getJobStatus('progress-array') as TrainingJobStatus;
    status.updatedAt = '2000-01-01T00:00:00.000Z';
    const handle = (runner as unknown as ProgressInternals).handleProgressEvent.bind(runner);

    // Called directly, as the null test does, so a missing guard shows as a write rather than a swallowed error.
    expect(() => handle('progress-array', [])).not.toThrow();

    expect(events).toHaveLength(0);
    expect(runner.getJobStatus('progress-array')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('ignores a null, numeric or string payload, with no event and no change to updatedAt', async () => {
    const { runner } = await attachedJob('progress-null');
    const events: TrainingProgressEvent[] = [];
    runner.events.on('progress.progress-null', (event: TrainingProgressEvent) => events.push(event));
    // A sentinel, so any write to updatedAt shows even when it falls in the same millisecond as the last one.
    const status = runner.getJobStatus('progress-null') as TrainingJobStatus;
    status.updatedAt = '2000-01-01T00:00:00.000Z';
    const handle = (runner as unknown as ProgressInternals).handleProgressEvent.bind(runner);

    // Called directly: the stdout path would swallow a thrown TypeError, which would hide a missing guard.
    for (const payload of [null, 7, 'text']) {
      expect(() => handle('progress-null', payload)).not.toThrow();
    }

    expect(events).toHaveLength(0);
    expect(runner.getJobStatus('progress-null')?.updatedAt).toBe('2000-01-01T00:00:00.000Z');
  });
});
