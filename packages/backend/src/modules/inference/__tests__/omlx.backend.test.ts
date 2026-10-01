import { Test } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { HardwareProfile } from '@ci-hub/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HardwareInspectorService } from '../hardware-inspector.service';
import { isOmlxHealthBody, OMLX_NOT_APPLE_SILICON_ERROR, OmlxBackend } from '../backends/omlx.backend';

// Only `get` is faked. `isAxiosError` stays real, so the 401 case below is classified the way a
// live axios rejection would be.
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { default: { ...actual.default, get: vi.fn() } };
});

const get = vi.mocked(axios.get);

/** A reply per path suffix. An Error is thrown as the request failing; anything else is the response. */
type Replies = Partial<Record<'/health' | '/v1/models', { status?: number; data?: unknown } | Error>>;

function serve(replies: Replies) {
  get.mockImplementation(async (url: string) => {
    const path = (Object.keys(replies) as (keyof Replies)[]).find((suffix) => url.endsWith(suffix));
    const reply = path ? replies[path] : undefined;
    if (!reply) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' });
    if (reply instanceof Error) throw reply;
    return { status: reply.status ?? 200, data: reply.data };
  });
}

const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });

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

  const preferences = (preferredOmlxUrl: string | null = null) =>
    ({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
      preferredOmlxUrl,
    }) as ReturnType<ConfigurationService['getInferencePreferences']>;

  beforeEach(async () => {
    get.mockReset();
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
});
