import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { passesByRule, trainingChildEnv } from '../training-child-env';
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
  'MODELS_DIR',
  'HSA_OVERRIDE_GFX_VERSION',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'ROCM_PATH',
  'HIP_PATH',
  'QWEN_MAX_TOKENS_NO_THINK',
  'TOKEN_CORPUS_DIR',
  'CLUSTER_STALENESS_DAYS',
  'FUNCTION_RUNNER_CONCURRENCY',
];

/** Set by the child environment itself, never copied from the Hub. */
const MARKERS = ['PYTHONUNBUFFERED', 'CI_HUB_TRAINING_CHILD'];

const CANARIES = ['JWT_SECRET', 'POSTGRES_PASSWORD', 'AGENT_WEBHOOK_TOKEN', 'INFERENCE_API_KEY', 'HF_TOKEN', 'DATABASE_URL'];

/**
 * Rule-path names, one for each denied substring (KEY, SECRET, TOKEN, PASSWORD, PASS, CREDENTIAL, CREDS, AUTH,
 * COOKIE, DSN, DATABASE), plus a mixed-case name. None may be copied.
 */
const DENIED_RULE_NAMES = [
  'HBPE_LABEL_PASS',
  'QWEN_DB_PASSWORD',
  'HBPE_CREDENTIAL_FILE',
  'HBPE_CREDS_PATH',
  'QWEN_SESSION_COOKIE',
  'HBPE_DSN',
  'HBPE_AUTH_HEADER',
  'HBPE_AUTHORIZATION_MODE',
  'HBPE_DATABASE_URL',
  'QWEN_DATABASE_URL',
  'HBPE_LABEL_API_TOKEN',
  'HBPE_LABEL_KEY',
  'QWEN_CLIENT_SECRET',
  'QWEN_Db_Password',
];

/** What each governor probe prints, so each one can be called back with a value. */
const PROBE_OUTPUT: Record<string, string> = {
  'pmset -g batt': "Now drawing from 'AC Power'\n",
  'pmset -g therm': 'CPU_Speed_Limit = 100\n',
  'sysctl -n hw.memsize': '17179869184\n',
  'nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits': '8192\n',
};

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
      OTHER_HBPE: 'not-listed',
      OPT_IN_OTHER: 'not-listed',
      SOME_OTHER_SETTING: 'not-listed',
      CI_LLM_HOST_REWRITE: 'not-listed',
      CI_LLM_HOST_GATEWAY: 'not-listed',
    };
    for (const name of TRAINING_CHILD_ENV_ALLOWLIST) source[name] = `value-of-${name}`;
    for (const name of DENIED_RULE_NAMES) source[name] = `canary-${name.toLowerCase()}`;

    const env = trainingChildEnv(source);

    const allowed = new Set<string>([...TRAINING_CHILD_ENV_ALLOWLIST, ...MARKERS]);
    for (const name of Object.keys(env)) expect(allowed.has(name)).toBe(true);
  });

  it('copies the HBPE_ and QWEN_ names and the exact names that pass by rule', async () => {
    const { trainingChildEnv } = await loadHelper();
    const names = ['HBPE_LABEL_MAX_REQUESTS_PER_MINUTE', 'QWEN_GGUF_PATH', 'API_URL', 'LLM_API_BASE', 'LLM_DEFAULT_CHAT_MODEL'];
    const source: NodeJS.ProcessEnv = {};
    for (const name of names) source[name] = `value-of-${name}`;

    const env = trainingChildEnv(source);

    for (const name of names) expect(env[name]).toBe(`value-of-${name}`);
  });

  it('does not copy credential-looking names, even under a rule prefix', async () => {
    const { trainingChildEnv } = await loadHelper();
    const names = ['HBPE_LABEL_API_KEY', 'HBPE_LABEL_API_TOKEN', 'QWEN_HF_TOKEN', 'LLM_API_KEY', 'VLLM_API_KEY', 'SIDECAR_AUTH_SECRET'];
    const source: NodeJS.ProcessEnv = {};
    for (const name of names) source[name] = `canary-${name.toLowerCase()}`;

    const env = trainingChildEnv(source);

    for (const name of names) expect(env).not.toHaveProperty(name);
  });

  it('does not copy a rule-path name that contains a denied substring, in any case', async () => {
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {};
    for (const name of DENIED_RULE_NAMES) source[name] = `canary-${name.toLowerCase()}`;

    const env = trainingChildEnv(source);

    for (const name of DENIED_RULE_NAMES) expect(env).not.toHaveProperty(name);
    expect(Object.keys(env).sort()).toEqual(['CI_HUB_TRAINING_CHILD', 'PYTHONUNBUFFERED']);
  });

  it('copies MODELS_DIR, HIP_VISIBLE_DEVICES and the other ROCm names, which are exact names', async () => {
    const { trainingChildEnv } = await loadHelper();
    const names = ['MODELS_DIR', 'HSA_OVERRIDE_GFX_VERSION', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'ROCM_PATH', 'HIP_PATH'];
    const source: NodeJS.ProcessEnv = {};
    for (const name of names) source[name] = `value-of-${name}`;

    const env = trainingChildEnv(source);

    for (const name of names) expect(env[name]).toBe(`value-of-${name}`);
  });

  it('copies the exact names that contain a denied substring, which passesByRule would refuse', async () => {
    const { trainingChildEnv } = await loadHelper();
    const names = ['QWEN_MAX_TOKENS_NO_THINK', 'TOKEN_CORPUS_DIR', 'TOKENIZERS_PARALLELISM', 'CLUSTER_STALENESS_DAYS', 'FUNCTION_RUNNER_CONCURRENCY'];
    const source: NodeJS.ProcessEnv = {};
    for (const name of names) source[name] = `value-of-${name}`;

    const env = trainingChildEnv(source);

    for (const name of names) expect(env[name]).toBe(`value-of-${name}`);
    expect(passesByRule('QWEN_MAX_TOKENS_NO_THINK')).toBe(false);
    expect(passesByRule('TOKEN_CORPUS_DIR')).toBe(false);
  });

  it('passesByRule takes a rule-path name only when it has no denied substring', () => {
    expect(passesByRule('HBPE_LABEL_MAX_REQUESTS_PER_MINUTE')).toBe(true);
    expect(passesByRule('LLM_DEFAULT_CHAT_MODEL')).toBe(true);
    for (const name of DENIED_RULE_NAMES) expect(passesByRule(name)).toBe(false);
    expect(passesByRule('SOME_OTHER_SETTING')).toBe(false);
  });

  it('does not copy an unrelated name', async () => {
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ SOME_OTHER_SETTING: 'value-of-SOME_OTHER_SETTING' });

    expect(env).not.toHaveProperty('SOME_OTHER_SETTING');
  });

  it('withholds a plain URL on the rule path and on the exact list, whatever its scheme', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    // A path-valued name is not URL-checked, so the exact-list case uses a name that is not path-valued.
    const env = trainingChildEnv({ API_URL: 'http://example.invalid/v1', PYTORCH_CUDA_ALLOC_CONF: 'http://example.invalid/cache' });

    expect(env).not.toHaveProperty('API_URL');
    expect(env).not.toHaveProperty('PYTORCH_CUDA_ALLOC_CONF');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('copies a model tag with a colon on a rule name, which has no slash after the colon, no at sign and no question mark', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ LLM_DEFAULT_CHAT_MODEL: 'qwen3:8b', HBPE_LABEL_MODEL: ' qwen2.5:7b ' });

    expect(env.LLM_DEFAULT_CHAT_MODEL).toBe('qwen3:8b');
    // Copied as the Hub has it, so the padding stays: the rule reads the trimmed value only to decide.
    expect(env.HBPE_LABEL_MODEL).toBe(' qwen2.5:7b ');
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies colon-separated paths on the exact list, because the scheme check is anchored to the start', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({ PATH: '/usr/local/bin:/usr/bin:/bin', HF_HOME: '/cache/a:/cache/b' });

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.HF_HOME).toBe('/cache/a:/cache/b');
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies PATH unchanged when one of its directories has an at sign, as the Homebrew openjdk@21 directory does', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const value = '/opt/homebrew/opt/openjdk@21/bin:/usr/bin';

    const env = trainingChildEnv({ PATH: value });

    expect(env.PATH).toBe(value);
    expect(warn).not.toHaveBeenCalled();
  });

  it('copies a path-valued rule name unchanged when its local path contains an at sign', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const value = '/srv/models/team@lab/qwen.gguf';

    const env = trainingChildEnv({ QWEN_GGUF_PATH: value });

    expect(env.QWEN_GGUF_PATH).toBe(value);
    expect(warn).not.toHaveBeenCalled();
  });

  it('withholds a no-scheme value with a question mark on a rule name, because of the question mark alone', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    // Without the question mark the same value is copied: it has no scheme, no at sign and no question mark.
    expect(trainingChildEnv({ HBPE_LABEL_ENDPOINT: 'example.invalid/v1' }).HBPE_LABEL_ENDPOINT).toBe('example.invalid/v1');

    const env = trainingChildEnv({ HBPE_LABEL_ENDPOINT: 'example.invalid/v1?x=1' });

    expect(env).not.toHaveProperty('HBPE_LABEL_ENDPOINT');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('carries a credential or query separator');
    expect(message).not.toContain('the value looks like a URL');
    expect(message).not.toContain('example.invalid');
  });

  it('withholds a backslash after the scheme colon on a rule name, with no at sign and no question mark', async () => {
    silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    // The first string has one backslash and the second has two. Neither has an at sign or a question mark.
    const values = ['https:\\example.invalid/v1', 'https:\\\\example.invalid/v1'];

    for (const value of values) {
      expect(value).not.toMatch(/[@?]/);
      for (const name of ['LLM_API_BASE', 'HBPE_LABEL_ENDPOINT']) {
        expect(trainingChildEnv({ [name]: value })).not.toHaveProperty(name);
      }
    }
  });

  it('withholds a URL-valued setting in every form the rule names, on the rule path and on the exact list', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const values = [
      ' https://user:pw@example.invalid/x', // a leading space before the scheme
      'https:/user:pw@example.invalid/x', // one slash after the scheme colon
      'https:\\user:pw@example.invalid/x', // a backslash in place of the slash, and an at sign later
      'http://example.invalid/v1', // a plain URL: no credentials and no query string, still withheld
      'http://example.invalid/v1?x=1', // a query string
      'user:pw@example.invalid', // an at sign with no scheme
      'ht\ttps://user:pw@example.invalid/x', // a tab inside the scheme, and an at sign
      '\u0001https://user:pw@example.invalid/x', // a leading control character
    ];

    for (const value of values) {
      for (const name of ['API_URL', 'HBPE_LABEL_ENDPOINT', 'PYTORCH_CUDA_ALLOC_CONF']) {
        expect(trainingChildEnv({ [name]: value })).not.toHaveProperty(name);
      }
    }

    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).not.toContain('example.invalid');
      expect(message).not.toContain('user:pw');
    }
  });

  it('withholds a URL-valued setting with credentials or a query string, and warns once per name without the value', async () => {
    const warn = silenceLogger();
    const { trainingChildEnv } = await loadHelper();
    const source: NodeJS.ProcessEnv = {
      API_URL: 'https://user:canary-pw@example.invalid/v1',
      LLM_API_BASE: 'http://example.invalid/v1?x=1',
      PYTORCH_CUDA_ALLOC_CONF: 'https://user@example.invalid/cache',
    };

    const env = trainingChildEnv(source);
    trainingChildEnv(source);

    expect(env).not.toHaveProperty('API_URL');
    expect(env).not.toHaveProperty('LLM_API_BASE');
    expect(env).not.toHaveProperty('PYTORCH_CUDA_ALLOC_CONF');
    expect(warn).toHaveBeenCalledTimes(3);
    const messages = warn.mock.calls.map(([message]) => String(message));
    for (const name of ['API_URL', 'LLM_API_BASE', 'PYTORCH_CUDA_ALLOC_CONF']) {
      expect(messages.filter((message) => message.startsWith(name))).toHaveLength(1);
    }
    for (const message of messages) {
      expect(message).not.toContain('canary-pw');
      expect(message).not.toContain('example.invalid');
      expect(message).toContain('looks like a URL or carries a credential or query separator');
    }
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

  it('does not copy HBPE_DATABASE_URL or QWEN_DATABASE_URL when the database opt-in is true', async () => {
    silenceLogger();
    const { trainingChildEnv } = await loadHelper();

    const env = trainingChildEnv({
      HBPE_DATABASE_URL: 'postgres://example.invalid/db',
      QWEN_DATABASE_URL: 'postgres://example.invalid/db',
      [OPT_IN]: 'true',
    });

    expect(env).not.toHaveProperty('HBPE_DATABASE_URL');
    expect(env).not.toHaveProperty('QWEN_DATABASE_URL');
    expect(Object.keys(env).sort()).toEqual(['CI_HUB_TRAINING_CHILD', 'PYTHONUNBUFFERED']);
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

  it('starts python3 with only the allowlisted environment and the names that pass by rule', async () => {
    silenceLogger();
    const hubEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HF_HOME: '/cache/hf',
      MODELS_DIR: '/models',
      HIP_VISIBLE_DEVICES: '0',
      HBPE_LABEL_MAX_REQUESTS_PER_MINUTE: '30',
      LLM_API_BASE: 'http://example.invalid/v1',
      API_URL: 'https://user:canary-pw@example.invalid/v1',
      HBPE_LABEL_API_KEY: 'canary-hbpe-label-api-key',
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
    for (const name of CANARIES) expect(options.env).not.toHaveProperty(name);
    expect(options.env.PATH).toBe('/usr/bin:/bin');
    expect(options.env.HF_HOME).toBe('/cache/hf');
    expect(options.env.PYTHONUNBUFFERED).toBe('1');
    expect(options.env.CI_HUB_TRAINING_CHILD).toBe('1');
    // A literal set of names and values. It is not computed from the helper under test.
    // LLM_API_BASE is a plain URL in the Hub environment, so it is withheld and not in this literal.
    expect(options.env).toEqual({
      CI_HUB_TRAINING_CHILD: '1',
      HBPE_LABEL_MAX_REQUESTS_PER_MINUTE: '30',
      HF_HOME: '/cache/hf',
      HIP_VISIBLE_DEVICES: '0',
      MODELS_DIR: '/models',
      PATH: '/usr/bin:/bin',
      PYTHONUNBUFFERED: '1',
    });

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
