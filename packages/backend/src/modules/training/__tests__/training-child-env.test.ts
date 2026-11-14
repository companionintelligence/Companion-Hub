import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { TrainingGovernorService } from '../training-governor.service';
import { TrainingRunnerService } from '../training-runner.service';
import type { TrainingJobManifest } from '../training.types';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// The runner's spawn is where a training child is started. Mocked so the test sees the env it is given.
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  exec: vi.fn(),
}));

const SPEC_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'LD_LIBRARY_PATH',
  'CUDA_HOME',
  'CUDA_PATH',
  'HBPE_TRAIN_SEED',
  'CUDA_VISIBLE_DEVICES',
  'PYTORCH_CUDA_ALLOC_CONF',
  'PYTORCH_ENABLE_MPS_FALLBACK',
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'TOKENIZERS_PARALLELISM',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'HF_HUB_CACHE',
  'TORCH_HOME',
];

/** Set by the child environment itself, never copied from the Hub. */
const MARKERS = ['PYTHONUNBUFFERED', 'CI_HUB_TRAINING_CHILD'];

const CANARIES = ['JWT_SECRET', 'POSTGRES_PASSWORD', 'AGENT_WEBHOOK_TOKEN', 'INFERENCE_API_KEY', 'HF_TOKEN', 'DATABASE_URL'];

const OPT_IN = 'CI_HUB_TRAIN_CHILD_INHERIT_DATABASE';

/**
 * Loads the helper fresh. The warning is once per process, so each test that depends on it needs a
 * module whose warning has not been logged yet.
 */
async function loadHelper() {
  vi.resetModules();
  return import('../training-child-env');
}

/** Silences the Nest logger and returns the spy, so a test can read what would have been logged. */
function silenceLogger() {
  return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
}

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

type SpawnInternals = {
  spawnTrainingProcess(manifest: TrainingJobManifest, manifestPath: string, artifactsDir: string): Promise<void>;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('trainingChildEnv', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('allowlists exactly the names the spec lists', async () => {
    const { TRAINING_CHILD_ENV_ALLOWLIST } = await loadHelper();
    expect([...TRAINING_CHILD_ENV_ALLOWLIST]).toEqual(SPEC_ALLOWLIST);
  });

  it('leaves out the Hub secrets and DATABASE_URL', async () => {
    silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HF_HOME: '/cache/hf' };
    for (const name of CANARIES) source[name] = `canary-${name.toLowerCase()}`;

    const env = trainingChildEnv(source);

    for (const name of CANARIES) expect(env).not.toHaveProperty(name);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HF_HOME).toBe('/cache/hf');
  });

  it('copies each allowlisted name that is defined, with its value', async () => {
    const { trainingChildEnv, TRAINING_CHILD_ENV_ALLOWLIST } = await loadHelper();
    const source: NodeJS.ProcessEnv = {};
    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) source[name] = `value-of-${name}`;
    // Defined in the source, so it is copied; the one left out is absent from the result.
    delete source.TZ;

    const env = trainingChildEnv(source);

    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) {
      if (name === 'TZ') {
        expect(env).not.toHaveProperty(name);
      } else {
        expect(env[name]).toBe(`value-of-${name}`);
      }
    }
  });

  it('copies nothing outside the allowlist and the two markers', async () => {
    silenceLogger();
    const { trainingChildEnv, TRAINING_CHILD_ENV_ALLOWLIST } = await loadHelper();
    const source: NodeJS.ProcessEnv = {
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      AWS_SECRET_ACCESS_KEY: 'canary-aws',
      CI_HUB_DATA_DIR: '/data',
      HF_TOKEN: 'canary-hf',
      HBPE_OTHER: 'not-listed',
      OPT_IN_OTHER: 'not-listed',
    };
    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) source[name] = `value-of-${name}`;

    const env = trainingChildEnv(source);

    const allowed = new Set<string>([...TRAINING_CHILD_ENV_ALLOWLIST, ...MARKERS]);
    for (const name of Object.keys(env)) expect(allowed.has(name)).toBe(true);
  });

  it('passes DATABASE_URL only when the opt-in is exactly true', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const databaseUrl = 'postgres://canary.invalid/db';

    expect(trainingChildEnv({ DATABASE_URL: databaseUrl, [OPT_IN]: 'true' }).DATABASE_URL).toBe(databaseUrl);

    for (const optIn of [undefined, '', '1', 'yes', 'TRUE', 'false']) {
      const env = trainingChildEnv({ DATABASE_URL: databaseUrl, [OPT_IN]: optIn });
      expect(env).not.toHaveProperty('DATABASE_URL');
    }
    // The opt-in itself is never passed on to the child.
    expect(trainingChildEnv({ [OPT_IN]: 'true' })).not.toHaveProperty(OPT_IN);
    expect(warn).toHaveBeenCalled();
  });

  it('passes every DATABASE_ name when the opt-in is true', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ DATABASE_URL: 'postgres://canary.invalid/db', DATABASE_POOL_SIZE: '4', [OPT_IN]: 'true' });

    expect(env.DATABASE_URL).toBe('postgres://canary.invalid/db');
    expect(env.DATABASE_POOL_SIZE).toBe('4');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs one warning per process when DATABASE_ names are set and the opt-in is off', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    trainingChildEnv({ DATABASE_URL: 'postgres://canary.invalid/db' });
    trainingChildEnv({ DATABASE_URL: 'postgres://canary.invalid/db', DATABASE_POOL_SIZE: '4' });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_ variables are set but not passed');
    expect(message).toContain(OPT_IN);
  });

  it('does not warn without DATABASE_ names', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    trainingChildEnv({ PATH: '/usr/bin:/bin' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('sets PYTHONUNBUFFERED and CI_HUB_TRAINING_CHILD to 1', async () => {
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ PYTHONUNBUFFERED: '0', CI_HUB_TRAINING_CHILD: '0' });

    expect(env.PYTHONUNBUFFERED).toBe('1');
    expect(env.CI_HUB_TRAINING_CHILD).toBe('1');
    expect(trainingChildEnv({}).PYTHONUNBUFFERED).toBe('1');
  });

  it('reads the Hub environment when no source is given, and never changes the source', async () => {
    silenceLogger();
    vi.stubEnv('JWT_SECRET', 'canary-jwt');
    vi.stubEnv('TZ', 'Europe/London');
    vi.stubEnv(OPT_IN, 'false');
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = { TZ: 'Europe/London', JWT_SECRET: 'canary-jwt' };
    const before = { ...source };

    const env = trainingChildEnv();
    const fromSource = trainingChildEnv(source);

    expect(env).not.toHaveProperty('JWT_SECRET');
    expect(env.TZ).toBe('Europe/London');
    expect(fromSource).not.toBe(source);
    expect(source).toEqual(before);
  });
});

describe('the training child spawn', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('starts python3 with only the allowlisted environment', async () => {
    silenceLogger();
    for (const name of CANARIES) vi.stubEnv(name, `canary-${name.toLowerCase()}`);
    vi.stubEnv(OPT_IN, 'false');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('HF_HOME', '/cache/hf');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const runner = new TrainingRunnerService(mock<TrainingGovernorService>());

    const done = (runner as unknown as SpawnInternals).spawnTrainingProcess(manifestFor('env-job'), '/data/manifest.json', '/data/artifacts');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, , options] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('python3');
    for (const name of CANARIES) expect(options.env).not.toHaveProperty(name);
    expect(options.env.PATH).toBe('/usr/bin:/bin');
    expect(options.env.HF_HOME).toBe('/cache/hf');
    expect(options.env.PYTHONUNBUFFERED).toBe('1');
    expect(options.env.CI_HUB_TRAINING_CHILD).toBe('1');
    const allowed = new Set<string>([...SPEC_ALLOWLIST, ...MARKERS]);
    for (const name of Object.keys(options.env)) expect(allowed.has(name)).toBe(true);

    child.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });
});
