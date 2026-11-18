import { Test } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HardwareProfile } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import {
  buildOmlxCudaHelperRemediation,
  isOmlxHealthBody,
  OMLX_CUDA_HELPER_PAIRING_COMMAND,
  OMLX_CUDA_HELPER_RUN_COMMAND,
  OMLX_NOT_APPLE_SILICON_ERROR,
  OmlxBackend,
  omlxAppApiKey,
} from '../backends/omlx.backend';

// Only `get` and `post` are faked. `isAxiosError` stays real, so the 401 cases below are classified
// the way a live axios rejection would be.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, get: vi.fn(), post: vi.fn() } };
});

const get = vi.mocked(axios.get);
const post = vi.mocked(axios.post);

/** A reply per path suffix. An Error is thrown as the request failing; anything else is the response. */
type Replies = Partial<Record<'/health' | '/v1/models' | '/api/cluster/node_id', { status?: number; data?: unknown } | Error>>;

function serve(replies: Replies) {
  get.mockImplementation(async (url: string) => {
    const path = (Object.keys(replies) as (keyof Replies)[]).find((suffix) => url.endsWith(suffix));
    const reply = path ? replies[path] : undefined;
    if (!reply) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' });
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, data: reply.data };
  });
}

const httpError = (status: number, data?: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });

// Bodies as the engines return them. oMLX: `list_models()` and `health()` in jundot/omlx server.py.
const OMLX_MODELS = { object: 'list', data: [{ id: 'Qwen3-8B-4bit', object: 'model', owned_by: 'omlx', max_model_len: 40960 }] };
const OMLX_HEALTH = {
  status: 'healthy',
  default_model: 'Qwen3-8B-4bit',
  engine_pool: { model_count: 1, loaded_count: 0, final_ceiling: 0, current_model_memory: 0 },
  mcp: null,
};
const VLLM_MODELS = { object: 'list', data: [{ id: 'Qwen/Qwen3.6-27B', object: 'model', owned_by: 'vllm', max_model_len: 32768 }] };

const profileWithGpu = (vendor: HardwareProfile['gpu']['vendor']) => ({ gpu: { vendor } }) as HardwareProfile;

describe('OmlxBackend', () => {
  let backend: OmlxBackend;
  let configuration: MockProxy<ConfigurationService>;
  let hardwareInspector: MockProxy<HardwareInspectorService>;
  const savedOmlxUrl = process.env.OMLX_URL;

  const preferences = (preferredOmlxUrl: string | null = null, preferredOmlxApiKey: string | null = null) =>
    ({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
      preferredOmlxUrl,
      preferredOmlxApiKey,
    }) as ReturnType<ConfigurationService['getInferencePreferences']>;

  beforeEach(async () => {
    get.mockReset();
    post.mockReset();
    delete process.env.OMLX_URL;
    configuration = mock<ConfigurationService>();
    configuration.getInferencePreferences.mockReturnValue(preferences());
    hardwareInspector = mock<HardwareInspectorService>();
    hardwareInspector.getProfile.mockResolvedValue(profileWithGpu('apple'));

    const moduleRef = await Test.createTestingModule({
      providers: [
        OmlxBackend,
        { provide: LoggerService, useValue: mock<LoggerService>() },
        { provide: ConfigurationService, useValue: configuration },
        { provide: HardwareInspectorService, useValue: hardwareInspector },
      ],
    }).compile();
    backend = moduleRef.get(OmlxBackend);
  });

  afterEach(() => {
    if (savedOmlxUrl === undefined) delete process.env.OMLX_URL;
    else process.env.OMLX_URL = savedOmlxUrl;
  });

  describe('on a host that is not Apple Silicon', () => {
    beforeEach(() => {
      hardwareInspector.getProfile.mockResolvedValue(profileWithGpu('nvidia'));
      // What the fleet's vLLM nodes had on :8000. None of it may be read as oMLX.
      serve({ '/v1/models': { data: VLLM_MODELS }, '/health': { data: '' } });
    });

    it('does not probe the default URL, and says why', async () => {
      const health = await backend.healthCheck();

      expect(get).not.toHaveBeenCalled();
      expect(health).toEqual({ running: false, healthy: false, modelsLoaded: [], error: OMLX_NOT_APPLE_SILICON_ERROR });
      await expect(backend.listModels()).resolves.toEqual([]);
      expect(get).not.toHaveBeenCalled();
    });

    // Compose passes `OMLX_URL: ${OMLX_URL:-}`, so an unset variable arrives as an empty string.
    // It must read as "not configured": a compose default once made it always set, and every
    // Linux vLLM node had :8000 probed as oMLX (with OMLX_API_KEY) on each status read.
    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('treats an %s OMLX_URL as unset: no probe, and the not-Apple-Silicon reason', async (_label, value) => {
      process.env.OMLX_URL = value;

      await expect(backend.healthCheck()).resolves.toEqual({ running: false, healthy: false, modelsLoaded: [], error: OMLX_NOT_APPLE_SILICON_ERROR });
      await expect(backend.listModels()).resolves.toEqual([]);
      expect(get).not.toHaveBeenCalled();
    });

    it('probes an oMLX URL the operator set with OMLX_URL: a Linux Hub can use a Mac on the network', async () => {
      process.env.OMLX_URL = 'http://studio.local:8000';
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      const health = await backend.healthCheck();

      expect(get).toHaveBeenCalledWith('http://studio.local:8000/v1/models', expect.any(Object));
      expect(health).toEqual({ running: true, healthy: true, modelsLoaded: ['Qwen3-8B-4bit'] });
    });

    it('probes an oMLX URL saved in Settings', async () => {
      configuration.getInferencePreferences.mockReturnValue(preferences('http://studio.local:8000/v1'));
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      await expect(backend.healthCheck()).resolves.toMatchObject({ running: true, healthy: true });
      expect(get).toHaveBeenCalledWith('http://studio.local:8000/health', expect.any(Object));
    });

    it('probes the URL a Re-check passes in', async () => {
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      await expect(backend.healthCheck('http://studio.local:8000')).resolves.toMatchObject({ running: true, healthy: true });
    });
  });

  describe('identifying the server on the port', () => {
    it('reports oMLX not running when vLLM answers on its port', async () => {
      // vLLM's /health is an empty 200, and its /v1/models names vllm.
      serve({ '/v1/models': { data: VLLM_MODELS }, '/health': { data: '' } });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: false, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain("the vllm backend's server, not omlx's");
      await expect(backend.listModels()).resolves.toEqual([]);
    });

    it('reports oMLX not running when an unrecognised OpenAI server answers there', async () => {
      // llama-server: names itself something the Hub has no engine for, and its /health is not oMLX's.
      serve({
        '/v1/models': { data: { object: 'list', data: [{ id: 'qwen3-8b.gguf', object: 'model', owned_by: 'llamacpp' }] } },
        '/health': { data: { status: 'ok' } },
      });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: false, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain('is not oMLX');
      await expect(backend.listModels()).resolves.toEqual([]);
    });

    it('reports a genuine oMLX running, with its models', async () => {
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      await expect(backend.healthCheck()).resolves.toEqual({ running: true, healthy: true, modelsLoaded: ['Qwen3-8B-4bit'] });
      await expect(backend.listModels()).resolves.toEqual([{ id: 'Qwen3-8B-4bit', name: 'Qwen3-8B-4bit', size: 0, loaded: true }]);
    });

    it("on Apple Silicon, an empty OMLX_URL (compose's default) still probes oMLX's default URL", async () => {
      process.env.OMLX_URL = '';
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      expect(backend.getBaseUrl()).toMatch(/^http:\/\/(localhost|host\.docker\.internal):8000$/);
      await expect(backend.healthCheck()).resolves.toEqual({ running: true, healthy: true, modelsLoaded: ['Qwen3-8B-4bit'] });
      expect(get).toHaveBeenCalledWith(`${backend.getBaseUrl()}/v1/models`, expect.any(Object));
    });

    it('recognises oMLX by owned_by alone when /health does not answer', async () => {
      serve({ '/v1/models': { data: OMLX_MODELS } });

      await expect(backend.healthCheck()).resolves.toMatchObject({ running: true, healthy: true, modelsLoaded: ['Qwen3-8B-4bit'] });
    });

    it('recognises an oMLX with no models yet by its /health body — /v1/models has no owned_by to read', async () => {
      serve({ '/v1/models': { data: { object: 'list', data: [] } }, '/health': { data: { ...OMLX_HEALTH, default_model: null } } });

      await expect(backend.healthCheck()).resolves.toEqual({ running: true, healthy: true, modelsLoaded: [] });
    });

    it('recognises oMLX from the 503 it answers while pinned models preload', async () => {
      serve({ '/v1/models': { data: { object: 'list', data: [] } }, '/health': { status: 503, data: { ...OMLX_HEALTH, status: 'loading' } } });

      await expect(backend.healthCheck()).resolves.toMatchObject({ running: true });
    });

    it('reports an oMLX that refuses the API key as running but unhealthy, and names the fix', async () => {
      serve({ '/v1/models': httpError(401), '/health': { data: OMLX_HEALTH } });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain('Settings > AI');
      expect(health.error).toContain('OMLX_API_KEY');
    });

    it('reports not running when nothing answers', async () => {
      serve({});

      await expect(backend.healthCheck()).resolves.toMatchObject({ running: false, healthy: false, error: expect.stringContaining('ECONNREFUSED') });
    });

    it('still probes, behind the identity check, when the hardware profile cannot be read', async () => {
      hardwareInspector.getProfile.mockRejectedValue(new Error('systeminformation failed'));
      serve({ '/v1/models': { data: VLLM_MODELS }, '/health': { data: '' } });

      await expect(backend.healthCheck()).resolves.toMatchObject({ running: false, healthy: false });
      expect(get).toHaveBeenCalled();
    });
  });

  // What oMLX 0.7.3.dev1 listed on GET /v1/models for one model laid out each way, measured on a live server: the
  // directory's own name, or `<org>--<name>` for the Hugging Face cache. Never the catalog's `mlx-community/<name>`.
  describe('finding a catalog model among what oMLX lists', () => {
    const CATALOG_ID = 'mlx-community/Qwen3-8B-4bit';
    const FROM_MODEL_DIR = 'Qwen3-8B-4bit';
    const FROM_HF_CACHE = 'mlx-community--Qwen3-8B-4bit';
    const listing = (...ids: string[]) => ({
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'omlx', max_model_len: 40960 })),
    });
    const serving = (...ids: string[]) => serve({ '/v1/models': { data: listing(...ids) }, '/health': { data: OMLX_HEALTH } });

    describe('isModelLoaded', () => {
      it.each([
        ['a model directory', FROM_MODEL_DIR],
        ['the Hugging Face cache', FROM_HF_CACHE],
        ['a model directory spelled in another case', 'qwen3-8b-4bit'],
      ])('finds the catalog id when oMLX lists the model from %s', async (_layout, listed) => {
        serving('LiquidAI--LFM2.5-1.2B-Instruct-MLX-bf16', listed);

        await expect(backend.isModelLoaded(CATALOG_ID)).resolves.toBe(true);
      });

      it('finds the id oMLX itself lists', async () => {
        serving(FROM_HF_CACHE);

        await expect(backend.isModelLoaded(FROM_HF_CACHE)).resolves.toBe(true);
      });

      it("does not find a model oMLX does not list, nor another build of it, nor another publisher's of the same name", async () => {
        serving('Qwen3-8B-8bit', 'mlx-community--Llama-3.2-3B-Instruct-4bit', 'lmstudio-community--Qwen3-8B-4bit');

        await expect(backend.isModelLoaded(CATALOG_ID)).resolves.toBe(false);
      });

      it('finds nothing when oMLX is not running', async () => {
        serve({});

        await expect(backend.isModelLoaded(CATALOG_ID)).resolves.toBe(false);
      });
    });

    describe('engineModelId', () => {
      it('is the catalog id until a probe has read what oMLX lists', () => {
        expect(backend.engineModelId(CATALOG_ID)).toBe(CATALOG_ID);
      });

      it.each([
        ['a model directory', FROM_MODEL_DIR],
        ['the Hugging Face cache', FROM_HF_CACHE],
      ])('is the name oMLX lists the model under when it serves it from %s', async (_layout, listed) => {
        serving(listed);
        await backend.healthCheck();

        expect(backend.engineModelId(CATALOG_ID)).toBe(listed);
        expect(backend.engineModelId(listed)).toBe(listed);
      });

      it('keeps the catalog id for a model oMLX does not list', async () => {
        serving(FROM_MODEL_DIR);
        await backend.healthCheck();

        expect(backend.engineModelId('mlx-community/Llama-3.2-3B-Instruct-4bit')).toBe('mlx-community/Llama-3.2-3B-Instruct-4bit');
      });

      it("does not take another server's listing for this one's", async () => {
        serving(FROM_HF_CACHE);
        await backend.healthCheck('http://other-mac.lan:8000');

        expect(backend.engineModelId(CATALOG_ID)).toBe(CATALOG_ID);
      });

      // Settings → AI and onboarding probe a URL the operator is still typing. That Re-check must not cost the
      // configured server's listing: a request after it would name the model as the catalog does, which the
      // Hugging Face cache answers with a 404.
      it("keeps the configured server's listing through a Re-check of another URL", async () => {
        serving(FROM_HF_CACHE);
        await backend.healthCheck();
        serve({ '/v1/models': { data: listing('Qwen3-8B-8bit') }, '/health': { data: OMLX_HEALTH } });
        await backend.healthCheck('http://other-mac.lan:8000');

        expect(backend.engineModelId(CATALOG_ID)).toBe(FROM_HF_CACHE);
      });

      it('follows the configured server when it lists the model under another name later', async () => {
        serving(FROM_MODEL_DIR);
        await backend.healthCheck();
        serving(FROM_HF_CACHE);
        await backend.healthCheck();

        expect(backend.engineModelId(CATALOG_ID)).toBe(FROM_HF_CACHE);
      });
    });
  });

  describe('isOmlxHealthBody', () => {
    it('accepts oMLX /health bodies, ready or loading, with or without a model pool', () => {
      expect(isOmlxHealthBody(OMLX_HEALTH)).toBe(true);
      expect(isOmlxHealthBody({ ...OMLX_HEALTH, status: 'loading' })).toBe(true);
      expect(isOmlxHealthBody({ status: 'healthy', default_model: null, engine_pool: null, mcp: null })).toBe(true);
    });

    it("rejects other engines' /health answers", () => {
      expect(isOmlxHealthBody('')).toBe(false); // vLLM
      expect(isOmlxHealthBody({ status: 'ok' })).toBe(false); // llama-server
      expect(isOmlxHealthBody({ status: 'healthy' })).toBe(false); // no engine_pool
      expect(isOmlxHealthBody(null)).toBe(false);
      expect(isOmlxHealthBody([{ status: 'healthy', engine_pool: null }])).toBe(false);
    });
  });

  describe('Configuration & Auth', () => {
    const savedApiKey = process.env.OMLX_API_KEY;

    afterEach(() => {
      if (savedApiKey === undefined) delete process.env.OMLX_API_KEY;
      else process.env.OMLX_API_KEY = savedApiKey;
    });

    it('returns trimmed getApiKey from OMLX_API_KEY or undefined', () => {
      delete process.env.OMLX_API_KEY;
      expect(backend.getApiKey()).toBeUndefined();

      process.env.OMLX_API_KEY = '  omlx-secret-456  ';
      expect(backend.getApiKey()).toBe('omlx-secret-456');
    });

    it('prefers apiKeyOverride over environment variable in getApiKey', () => {
      process.env.OMLX_API_KEY = 'env-key';
      expect(backend.getApiKey('  override-key  ')).toBe('override-key');
    });

    it('uses the key saved in Settings before OMLX_API_KEY', () => {
      process.env.OMLX_API_KEY = 'env-key';
      configuration.getInferencePreferences.mockReturnValue(preferences(null, '  saved-key  '));

      expect(backend.getApiKey()).toBe('saved-key');
      expect(backend.getApiKey('typed-key')).toBe('typed-key');
    });

    it("never hands an app the saved key, which is oMLX's main key", () => {
      configuration.getInferencePreferences.mockReturnValue(preferences(null, 'saved-key'));
      delete process.env.OMLX_API_KEY;
      expect(omlxAppApiKey()).toBeUndefined();

      process.env.OMLX_API_KEY = ' env-key ';
      expect(omlxAppApiKey()).toBe('env-key');
    });

    it('sends the saved key on the health probe of the configured server', async () => {
      delete process.env.OMLX_API_KEY;
      configuration.getInferencePreferences.mockReturnValue(preferences(null, 'saved-key'));
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      await backend.healthCheck();

      const modelsCall = get.mock.calls.find(([url]) => String(url).endsWith('/v1/models'));
      expect((modelsCall?.[1] as { headers?: unknown } | undefined)?.headers).toEqual({ Authorization: 'Bearer saved-key' });
    });

    it('sends apiKeyOverride when probing /v1/models in healthCheck', async () => {
      serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });

      await backend.healthCheck(undefined, 'probe-api-key');

      expect(get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer probe-api-key' },
        }),
      );
    });

    // `omlx/status` and `onboarding-profile` pass their `?url=` straight to healthCheck, and
    // OMLX_API_KEY used to go to whatever URL that was.
    describe('which key a Re-check probe carries', () => {
      const CONFIGURED = 'http://mac-studio.lan:8000';
      const modelsCall = () => get.mock.calls.find(([url]) => String(url).endsWith('/v1/models'));

      beforeEach(() => {
        process.env.OMLX_API_KEY = 'omlx-secret';
        configuration.getInferencePreferences.mockReturnValue(preferences(CONFIGURED));
        serve({ '/v1/models': { data: OMLX_MODELS }, '/health': { data: OMLX_HEALTH } });
      });

      it('sends no key to a URL other than the configured oMLX when no probe key is given', async () => {
        await backend.healthCheck('http://attacker.example:9999');

        expect(modelsCall()?.[0]).toBe('http://attacker.example:9999/v1/models');
        expect((modelsCall()?.[1] as { headers?: unknown } | undefined)?.headers).toBeUndefined();
      });

      it.each([CONFIGURED, `${CONFIGURED}/v1/`, 'HTTP://MAC-STUDIO.LAN:8000'])(
        'sends OMLX_API_KEY when re-checking the configured server, spelled %s',
        async (url) => {
          await backend.healthCheck(url);

          expect((modelsCall()?.[1] as { headers?: unknown } | undefined)?.headers).toEqual({ Authorization: 'Bearer omlx-secret' });
        },
      );

      it('sends OMLX_API_KEY on the plain health probe of the configured server', async () => {
        await backend.healthCheck();

        expect((modelsCall()?.[1] as { headers?: unknown } | undefined)?.headers).toEqual({ Authorization: 'Bearer omlx-secret' });
      });

      it('sends the key typed for the probe to any URL, as before', async () => {
        await backend.healthCheck('http://other-mac.lan:8000', 'typed-key');

        expect((modelsCall()?.[1] as { headers?: unknown } | undefined)?.headers).toEqual({ Authorization: 'Bearer typed-key' });
      });

      it('says why no key went out when the other server refuses it', async () => {
        serve({ '/v1/models': httpError(401), '/health': { data: OMLX_HEALTH } });

        const health = await backend.healthCheck('http://other-mac.lan:8000');

        expect(health.error).toContain('sent only to the configured oMLX URL');
      });
    });
  });

  describe('pullModel: downloads through the admin API', () => {
    const REPO = 'mlx-community/Qwen3-8B-4bit';
    const BASE = 'http://omlx.lan:8000';
    const task = (status: string, extra: Record<string, unknown> = {}) => ({
      task_id: 'task-1',
      repo_id: REPO,
      status,
      progress: 0,
      error: '',
      ...extra,
    });
    const listing = (...ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model', owned_by: 'omlx' })) });

    /** `GET /admin/api/hf/tasks` answers each entry of `taskReplies` in turn, then the last one forever; `/v1/models` lists `listed()`. */
    function omlxServer(taskReplies: (unknown[] | Error)[], listed: () => string[] = () => ['Qwen3-8B-4bit']) {
      let read = 0;
      get.mockImplementation(async (url: string) => {
        if (url.endsWith('/admin/api/hf/tasks')) {
          const reply = taskReplies[Math.min(read++, taskReplies.length - 1)];
          if (reply instanceof Error) throw reply;
          return { status: 200, data: { tasks: reply } };
        }
        if (url.endsWith('/v1/models')) return { status: 200, data: listing(...listed()) };
        if (url.endsWith('/health')) return { status: 200, data: OMLX_HEALTH };
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      });
    }

    const posts = (suffix: string) => post.mock.calls.filter(([url]) => String(url).endsWith(suffix));

    beforeEach(() => {
      delete process.env.OMLX_API_KEY;
      configuration.getInferencePreferences.mockReturnValue(preferences(BASE, 'main-key'));
      vi.spyOn(backend as unknown as { pause: (ms: number) => Promise<void> }, 'pause').mockResolvedValue();
      post.mockImplementation(async (url: string) => {
        if (url.endsWith('/admin/api/hf/download')) return { status: 200, data: { success: true, task: task('pending') } };
        return { status: 200, data: { status: 'ok' } };
      });
    });

    it('starts the download with the saved key, reports its progress, and finishes once oMLX lists the model', async () => {
      omlxServer([
        [task('pending')],
        [task('downloading', { progress: 42.5, total_size: 1000, downloaded_size: 425 })],
        [task('completed', { progress: 100 })],
      ]);
      const progress: { status: string; percent: number; total?: number; completed?: number }[] = [];

      await backend.pullModel(REPO, (update) => progress.push(update));

      expect(post).toHaveBeenCalledWith(
        `${BASE}/admin/api/hf/download`,
        { repo_id: REPO },
        expect.objectContaining({ headers: { Authorization: 'Bearer main-key' } }),
      );
      const tasksCall = get.mock.calls.find(([url]) => String(url).endsWith('/admin/api/hf/tasks'));
      expect((tasksCall?.[1] as { headers?: unknown } | undefined)?.headers).toEqual({ Authorization: 'Bearer main-key' });
      expect(progress.map((update) => update.percent)).toEqual([0, 42.5, 100]);
      expect(progress[1]).toMatchObject({ total: 1000, completed: 425 });
      expect(posts('/admin/api/reload')).toHaveLength(0);
    });

    it("says the Hub needs oMLX's key, and where to download instead, when the admin API refuses it", async () => {
      configuration.getInferencePreferences.mockReturnValue(preferences('http://host.docker.internal:8000'));
      post.mockRejectedValue(httpError(401, { detail: 'Admin authentication required' }));

      const error = await backend.pullModel(REPO).catch((err: Error) => err);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Settings > AI');
      expect((error as Error).message).toContain('the Hub has none');
      expect((error as Error).message).toContain('http://localhost:8000/admin');
    });

    it("throws oMLX's own error when the download fails", async () => {
      omlxServer([[task('downloading', { progress: 10 })], [task('failed', { error: "Repository 'mlx-community/Qwen3-8B-4bit' is gated." })]]);

      await expect(backend.pullModel(REPO)).rejects.toThrow("Repository 'mlx-community/Qwen3-8B-4bit' is gated.");
    });

    it('throws when the download is cancelled in oMLX', async () => {
      omlxServer([[task('cancelled')]]);

      await expect(backend.pullModel(REPO)).rejects.toThrow('cancelled in oMLX');
    });

    it('follows the download oMLX already runs for the repo instead of failing', async () => {
      post.mockImplementation(async (url: string) => {
        if (url.endsWith('/admin/api/hf/download')) throw httpError(400, { detail: `Download for '${REPO}' is already in progress` });
        return { status: 200, data: { status: 'ok' } };
      });
      const running = { ...task('downloading', { progress: 60 }), task_id: 'task-0' };
      const done = { ...running, status: 'completed', progress: 100 };
      const old = { ...task('failed'), task_id: 'old' };
      omlxServer([
        [old, running],
        [old, running],
        [old, done],
      ]);

      await expect(backend.pullModel(REPO)).resolves.toBeUndefined();
    });

    it('passes on any other refusal to start', async () => {
      post.mockRejectedValue(httpError(400, { detail: "Invalid repository ID: 'nope'" }));
      omlxServer([[]]);

      await expect(backend.pullModel('nope')).rejects.toThrow("oMLX could not start downloading nope: Invalid repository ID: 'nope'");
    });

    it('rides out a few failed reads of the download, as when oMLX restarts', async () => {
      const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      omlxServer([refused, refused, [task('completed', { progress: 100 })]]);

      await expect(backend.pullModel(REPO)).resolves.toBeUndefined();
    });

    it('asks oMLX to rescan once when the finished model is slow to show up', async () => {
      let reloaded = false;
      post.mockImplementation(async (url: string) => {
        if (url.endsWith('/admin/api/hf/download')) return { status: 200, data: { success: true, task: task('pending') } };
        reloaded = true;
        return { status: 200, data: { status: 'ok' } };
      });
      omlxServer([[task('completed', { progress: 100 })]], () => (reloaded ? ['mlx-community--Qwen3-8B-4bit'] : []));

      await expect(backend.pullModel(REPO)).resolves.toBeUndefined();
      expect(posts('/admin/api/reload')).toHaveLength(1);
    });

    it('fails, rather than reporting success, when oMLX never lists the model', async () => {
      omlxServer([[task('completed', { progress: 100 })]], () => []);

      await expect(backend.pullModel(REPO)).rejects.toThrow('does not list it');
      expect(posts('/admin/api/reload')).toHaveLength(1);
    });
  });

  describe("oMLX's CUDA helper on an NVIDIA host", () => {
    // `identity()` in jundot/omlx apps/omlx-cuda-helper/omlx_cuda_helper/discovery.py, as json.dumps writes it.
    const HELPER_IDENTITY = {
      node_id: '6f1c2a90-1d2b-4b8e-9b55-0d6f8e7c1a42',
      version: '0.1.3',
      cluster_name: 'omlx',
      friendly_name: 'core-1',
      caps: {
        chip: '2x NVIDIA RTX A6000',
        ram_gb: 96.0,
        backends: ['cuda'],
        thunderbolt: false,
        jaccl: false,
        loopback_only: false,
        control: 'agent',
      },
      control_port: 8851,
    };

    beforeEach(() => {
      hardwareInspector.getProfile.mockResolvedValue(profileWithGpu('nvidia'));
    });

    it('reads the helper on :8850 and names its cards', async () => {
      serve({ '/api/cluster/node_id': { data: HELPER_IDENTITY } });

      await expect(backend.cudaHelperStatus()).resolves.toEqual({
        running: true,
        name: 'core-1',
        version: '0.1.3',
        chip: '2x NVIDIA RTX A6000',
        gpuMemoryGb: 96,
      });
      expect(get).toHaveBeenCalledWith(expect.stringMatching(/:8850\/api\/cluster\/node_id$/), expect.objectContaining({ timeout: 3000 }));
    });

    it('reports it stopped when nothing answers, or when what answers is not the helper', async () => {
      serve({});
      await expect(backend.cudaHelperStatus()).resolves.toEqual({ running: false });

      // A Mac's oMLX answers the same route, with Metal rather than CUDA.
      serve({ '/api/cluster/node_id': { data: { ...HELPER_IDENTITY, caps: { ...HELPER_IDENTITY.caps, backends: ['metal'] } } } });
      await expect(backend.cudaHelperStatus()).resolves.toEqual({ running: false });
    });

    it.each(['apple', 'amd', 'none'] as const)('never probes for it on a host whose GPU is %s', async (vendor) => {
      hardwareInspector.getProfile.mockResolvedValue(profileWithGpu(vendor));

      await expect(backend.cudaHelperStatus()).resolves.toBeNull();
      expect(get).not.toHaveBeenCalled();
    });

    it('stays out of the health check, which the pool runs on every request', async () => {
      serve({ '/api/cluster/node_id': { data: HELPER_IDENTITY } });

      await backend.healthCheck();

      expect(get).not.toHaveBeenCalled();
    });

    it('hands out the run command until the helper answers, then the pairing command', () => {
      const stopped = buildOmlxCudaHelperRemediation({ running: false });
      expect(stopped.command).toBe(OMLX_CUDA_HELPER_RUN_COMMAND);
      expect(stopped.hint).toContain('driver 580 or newer');
      expect(stopped.hint).toContain('only on a network you trust');

      const running = buildOmlxCudaHelperRemediation({ running: true, name: 'core-1', version: '0.1.3', chip: '2x NVIDIA RTX A6000' });
      expect(running.command).toBe(OMLX_CUDA_HELPER_PAIRING_COMMAND);
      expect(running.hint).toContain('(helper 0.1.3, 2x NVIDIA RTX A6000)');
      expect(running.hint).toContain('press Pair on "core-1"');
    });
  });
});
