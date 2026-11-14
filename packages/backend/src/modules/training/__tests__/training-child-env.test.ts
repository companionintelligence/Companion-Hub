import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AT_SIGN_EXEMPT_NAMES, DENYLIST_EXEMPT_NAMES, TRAINING_CHILD_ENV_ALLOWLIST, trainingChildEnv } from '../training-child-env';
import { TrainingGovernorService } from '../training-governor.service';
import { TrainingRunnerService } from '../training-runner.service';
import type { TrainingJobManifest } from '../training.types';

const { spawnMock, execMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execMock: vi.fn() }));

// A training child is started by spawn, and the governor's probes run through exec. Both are mocked, so the
// test sees the env each one is given.
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  exec: (...args: unknown[]) => execMock(...args),
}));

/** The allowlist as the spec lists it, in order. It is compared with the exported constant. */
const EXPECTED_ALLOWLIST = [
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
  'HSA_OVERRIDE_GFX_VERSION',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'ROCM_PATH',
  'HIP_PATH',
  'MODELS_DIR',
  'CI_LLM_HOST_REWRITE',
  'CI_LLM_HOST_GATEWAY',
  'API_URL',
  'LLM_API_BASE',
  'HBPE_LABEL_API_BASE',
  'HBPE_LABEL_HTTP_TIMEOUT',
  'TOKEN_CORPUS_DIR',
  'HBPE_LABEL_MODEL',
  'LLM_DEFAULT_CHAT_MODEL',
  'QWEN_GGUF_PATH',
  'QWEN_GGUF_REPO',
  'QWEN_GGUF_FILE',
  'QWEN_DISABLE_THINKING',
  'QWEN_MAX_TOKENS_NO_THINK',
  'HBPE_LABEL_REPROBE_SECONDS',
  'QWEN_GGUF_BATCH',
  'QWEN_GGUF_RECYCLE_CALLS',
  'HBPE_LABEL_YIELD_TO_CHAT',
  'HBPE_LABEL_YIELD_MAX_SECONDS',
  'HBPE_LABEL_YIELD_POLL_SECONDS',
  'HBPE_LABEL_MAX_REQUESTS_PER_MINUTE',
  'HBPE_ENABLE_DECISION_MODELS',
  'HBPE_DECISION_MODEL_ENDPOINT',
  'HBPE_DECISION_CONFIDENCE_THRESHOLD',
  'CLUSTER_STALENESS_DAYS',
  'HBPE_LABEL_BUDGET_SECONDS',
  'HBPE_LABEL_RECENCY_DAYS',
  'HBPE_LABEL_RECENCY_SHARE',
  'FUNCTION_RUNNER_CONCURRENCY',
  'HBPE_API_PORT',
  'HBPE_LOG_LEVEL',
  'EMBEDDING_API_BASE',
  'LLM_EMBEDDING_API_BASE',
  'CI_EMBEDDING_BASE_URL',
  'OLLAMA_HOST',
  'OLLAMA_EMBED_HOST',
  'CI_OLLAMA_EMBED_HOST',
];

/** The substrings the denylist names. The test states them again, so a change to the list shows here. */
const DENIED = ['KEY', 'SECRET', 'TOKEN', 'PASS', 'CREDENTIAL', 'CREDS', 'AUTH', 'COOKIE', 'DSN', 'DATABASE'];

/** Set by the child environment itself, never copied from the Hub. */
const MARKERS = ['PYTHONUNBUFFERED', 'CI_HUB_TRAINING_CHILD'];

/** Hub secrets that must never reach a child, whatever the list says. */
const CANARIES = ['JWT_SECRET', 'POSTGRES_PASSWORD', 'AGENT_WEBHOOK_TOKEN', 'INFERENCE_API_KEY', 'HF_TOKEN', 'SIDECAR_AUTH_SECRET', 'DATABASE_URL'];

/** What each governor probe prints, so each one can be called back with a value. */
const PROBE_OUTPUT: Record<string, string> = {
  'pmset -g batt': "Now drawing from 'AC Power'\n",
  'pmset -g therm': 'CPU_Speed_Limit = 100\n',
  'sysctl -n hw.memsize': '17179869184\n',
  'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits': '8192\n',
};

const OPT_IN = 'CI_HUB_TRAIN_CHILD_INHERIT_DATABASE';

/**
 * Loads the helper fresh. The warnings are once per process, so each test that depends on one needs a module
 * whose warnings have not been logged yet.
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

/** Runs `fn` with `process.env` replaced by `env`, so the test decides every name the child could inherit. */
function withHubEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = env;
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

/** Runs `fn` as if `process.platform` were `platform`, then restores it. */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
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

  it('allowlists exactly the names the spec lists, in order', () => {
    expect([...TRAINING_CHILD_ENV_ALLOWLIST]).toEqual(EXPECTED_ALLOWLIST);
  });

  it('exempts exactly three names from the denylist, and they are the only allowlisted names that contain a denied substring', () => {
    expect([...DENYLIST_EXEMPT_NAMES]).toEqual(['TOKENIZERS_PARALLELISM', 'QWEN_MAX_TOKENS_NO_THINK', 'TOKEN_CORPUS_DIR']);

    const denied = TRAINING_CHILD_ENV_ALLOWLIST.filter((name) => DENIED.some((substring) => name.toUpperCase().includes(substring)));

    expect([...denied].sort()).toEqual([...DENYLIST_EXEMPT_NAMES].sort());
  });

  it('names exactly the path and locale names that may hold an at sign, and each is on the allowlist', () => {
    expect([...AT_SIGN_EXEMPT_NAMES]).toEqual([
      'PATH',
      'PYTHONPATH',
      'PYTHONHOME',
      'LD_LIBRARY_PATH',
      'VIRTUAL_ENV',
      'CUDA_HOME',
      'CUDA_PATH',
      'HOME',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'HF_HOME',
      'HF_HUB_CACHE',
      'TORCH_HOME',
      'MODELS_DIR',
      'ROCM_PATH',
      'HIP_PATH',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TOKEN_CORPUS_DIR',
      'QWEN_GGUF_PATH',
    ]);
    for (const name of AT_SIGN_EXEMPT_NAMES) expect(TRAINING_CHILD_ENV_ALLOWLIST).toContain(name);
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

  it('copies each allowlisted name that is set to a clean value', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {};
    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) source[name] = `value-of-${name}`;

    const env = trainingChildEnv(source);

    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) expect(env[name]).toBe(`value-of-${name}`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never copies a name that is not on the list, including new HBPE_ and QWEN_ names, so there is no prefix rule', async () => {
    silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {
      HBPE_SOMETHING_NEW: 'clean-value',
      QWEN_SOMETHING_NEW: 'clean-value',
      SOME_OTHER_SETTING: 'clean-value',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    };

    const env = trainingChildEnv(source);

    expect(Object.keys(env).sort()).toEqual([...MARKERS].sort());
  });

  it('withholds a URL with credentials, and copies a path or a locale that contains an at sign', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({
      API_URL: 'https://user:pw@example.invalid/x',
      PATH: '/opt/homebrew/opt/openjdk@21/bin:/usr/bin',
      LANG: 'de_DE@euro',
    });

    expect(env).not.toHaveProperty('API_URL');
    expect(env.PATH).toBe('/opt/homebrew/opt/openjdk@21/bin:/usr/bin');
    expect(env.LANG).toBe('de_DE@euro');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('API_URL');
  });

  it('withholds a question mark for every name, path names included', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({
      HF_HOME: 'https://example.invalid/cache?token=x',
      API_URL: 'example.invalid/v1?x=1',
    });

    expect(env).not.toHaveProperty('HF_HOME');
    expect(env).not.toHaveProperty('API_URL');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('copies an endpoint that has no credential and no question mark', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ API_URL: 'https://example.invalid/v1', LLM_API_BASE: 'http://example.invalid:8000/v1' });

    expect(env.API_URL).toBe('https://example.invalid/v1');
    expect(env.LLM_API_BASE).toBe('http://example.invalid:8000/v1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops an injected name with a denied substring unless it is exempt, and copies an exempt one', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const injected = DENIED.map((substring) => `HBPE_TEST_${substring}_VALUE`);
    const source: NodeJS.ProcessEnv = { TOKENIZERS_PARALLELISM: 'false', hbpe_test_key: 'clean-value' };
    for (const name of injected) source[name] = 'clean-value';

    const env = trainingChildEnv(source, [...injected, 'hbpe_test_key', 'TOKENIZERS_PARALLELISM']);

    expect(Object.keys(env).sort()).toEqual(['CI_HUB_TRAINING_CHILD', 'PYTHONUNBUFFERED', 'TOKENIZERS_PARALLELISM'].sort());
    expect(env.TOKENIZERS_PARALLELISM).toBe('false');
    expect(warn).toHaveBeenCalledTimes(DENIED.length + 1);
    for (const [message] of warn.mock.calls) {
      expect(String(message)).toContain('its name contains a denied substring, so it was withheld.');
    }
  });

  it('passes DATABASE_ names only when the opt-in is exactly true, and never HBPE_DATABASE_URL', async () => {
    silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://canary.invalid/db',
      DATABASE_PASSWORD: 'canary-db-pw',
      HBPE_DATABASE_URL: 'postgres://canary.invalid/db',
    };

    const defaults = trainingChildEnv(source);
    expect(defaults).not.toHaveProperty('DATABASE_URL');
    expect(defaults).not.toHaveProperty('DATABASE_PASSWORD');

    for (const optIn of [undefined, '', '1', 'yes', 'TRUE', 'false']) {
      const env = trainingChildEnv({ ...source, [OPT_IN]: optIn });
      expect(env).not.toHaveProperty('DATABASE_URL');
      expect(env).not.toHaveProperty('DATABASE_PASSWORD');
    }

    const enabled = trainingChildEnv({ ...source, [OPT_IN]: 'true' });
    expect(enabled.DATABASE_URL).toBe('postgres://canary.invalid/db');
    expect(enabled.DATABASE_PASSWORD).toBe('canary-db-pw');
    expect(enabled).not.toHaveProperty('HBPE_DATABASE_URL');
    expect(enabled).not.toHaveProperty(OPT_IN);
  });

  it('warns once per process that DATABASE_ variables are not passed to training children, and names the opt-in', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    trainingChildEnv({ DATABASE_URL: 'postgres://canary.invalid/db' });
    trainingChildEnv({ DATABASE_URL: 'postgres://canary.invalid/db', DATABASE_NAME: 'canary-name' });

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('DATABASE_ variables are set but not passed to training children');
    expect(message).not.toContain('peer');
    expect(message).toContain(OPT_IN);
    expect(message).not.toContain('canary');
  });

  it('logs one warning per withheld variable per process, and no warning carries the value', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {
      API_URL: 'https://user:canary-pw@example.invalid/v1',
      HF_HOME: '/cache/hf?canary-query',
    };

    trainingChildEnv(source);
    trainingChildEnv(source);

    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.startsWith('API_URL'))).toHaveLength(1);
    expect(messages.filter((message) => message.startsWith('HF_HOME'))).toHaveLength(1);
    for (const message of messages) {
      expect(message).toContain('so it was withheld.');
      expect(message).not.toMatch(/canary|example\.invalid|cache/);
    }
  });

  it('does not warn without DATABASE_ names or withheld values', async () => {
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
    const hubEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HF_HOME: '/cache/hf',
      MODELS_DIR: '/models',
      HIP_VISIBLE_DEVICES: '0',
      HBPE_LABEL_MAX_REQUESTS_PER_MINUTE: '30',
      LLM_API_BASE: 'http://example.invalid/v1',
      API_URL: 'https://example.invalid/v1',
      HBPE_LABEL_API_BASE: 'https://user:canary-pw@example.invalid/v1',
      HBPE_LABEL_API_KEY: 'canary-hbpe-label-api-key',
      HBPE_LABEL_NOT_LISTED: 'clean-value',
      [OPT_IN]: 'false',
    };
    for (const name of CANARIES) hubEnv[name] = `canary-${name.toLowerCase()}`;
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const runner = new TrainingRunnerService(mock<TrainingGovernorService>());

    const done = withHubEnv(hubEnv, () =>
      (runner as unknown as SpawnInternals).spawnTrainingProcess(manifestFor('env-job'), '/data/manifest.json', '/data/artifacts'),
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, , options] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(command).toBe('python3');
    // A literal set of names and values. It is not computed from the helper under test.
    // API_URL and LLM_API_BASE are plain endpoints, so both are copied. HBPE_LABEL_API_BASE carries a credential, so it is withheld.
    // HBPE_LABEL_API_KEY and HBPE_LABEL_NOT_LISTED are not on the list, so neither is copied.
    expect(options.env).toEqual({
      API_URL: 'https://example.invalid/v1',
      CI_HUB_TRAINING_CHILD: '1',
      HBPE_LABEL_MAX_REQUESTS_PER_MINUTE: '30',
      HF_HOME: '/cache/hf',
      HIP_VISIBLE_DEVICES: '0',
      LLM_API_BASE: 'http://example.invalid/v1',
      MODELS_DIR: '/models',
      PATH: '/usr/bin:/bin',
      PYTHONUNBUFFERED: '1',
    });
    for (const name of CANARIES) expect(options.env).not.toHaveProperty(name);

    child.emit('close', 0);
    await expect(done).resolves.toBeUndefined();
  });
});

describe('the governor probes', () => {
  beforeEach(() => {
    execMock.mockReset();
    // Calls back as the real exec does, with the output of the probe that was asked for.
    execMock.mockImplementation((command: string, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (error: null, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: PROBE_OUTPUT[command] ?? '', stderr: '' });
    });
  });

  it('gives each of the four probes trainingChildEnv(), and no canary from the Hub environment', async () => {
    silenceLogger();
    vi.stubEnv('JWT_SECRET', 'canary-jwt');
    vi.stubEnv('HBPE_LABEL_MAX_REQUESTS_PER_MINUTE', '30');
    const expected = trainingChildEnv();
    const governor = new TrainingGovernorService();

    // darwin runs three probes (battery, thermal and memory), and linux runs the GPU probe.
    await withPlatform('darwin', () => governor.evaluateLocalCapacity());
    await withPlatform('linux', () => governor.getEstimatedAvailableVramMb());

    const calls = execMock.mock.calls;
    expect(calls.map(([command]) => command).sort()).toEqual(Object.keys(PROBE_OUTPUT).sort());
    for (const [, options] of calls) {
      expect(options).toEqual({ env: expected });
      expect(options.env).not.toHaveProperty('JWT_SECRET');
    }
    expect(Object.values(expected)).not.toContain('canary-jwt');
  });
});
