import { Test, type TestingModule } from '@nestjs/testing';
import { LemonadeBackend, lemonadeErrorDetail } from '../backends/lemonade.backend';
import { lemonadeShowAllBody } from './lemonade-10.2.0-registry.fixture';
import type { DeviceGroupProbe } from '../backends/amd-device-groups.util';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

/**
 * A Strix Halo node: only `card1` and `renderD128` exist, the render group is GID 990 and
 * video is 44. Naming the groups instead would resolve `render` to 109 inside the container.
 */
const strixHaloProbe: DeviceGroupProbe = {
  readdirSync: () => ['by-path', 'card1', 'renderD128'],
  statSync: (path: string) => {
    if (path === '/dev/kfd' || path === '/dev/dri/renderD128') return { gid: 990 };
    if (path === '/dev/dri/card1') return { gid: 44 };
    throw new Error(`ENOENT: ${path}`);
  },
};

/** Generating the config away from the GPU host: nothing under /dev to stat. */
const noGpuProbe: DeviceGroupProbe = {
  readdirSync: () => {
    throw new Error('ENOENT: /dev/dri');
  },
  statSync: (path: string) => {
    throw new Error(`ENOENT: ${path}`);
  },
};

describe('LemonadeBackend', () => {
  let backend: LemonadeBackend;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [LemonadeBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<LemonadeBackend>(LemonadeBackend);
  });

  // ─── S-BL-2.3: Health Check ─────────────────────────────────────

  describe('Health check (BL-2)', () => {
    it('S-BL-2.3: SHALL check health via GET /v1/health', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v1/health')) return Promise.resolve({ status: 200 });
        if (url.includes('/v1/models')) return Promise.resolve({ data: { data: [{ id: 'kokoro-v1' }] } });
        return Promise.resolve({ data: {} });
      });

      const health = await backend.healthCheck();

      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
    });

    it('should report unhealthy on failure', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.error).toBeDefined();
    });
  });

  // ─── NPU Detection ─────────────────────────────────────────────────

  describe('NPU detection (HW-4)', () => {
    it('S-HW-4.1: SHALL detect NPU via Lemonade system-info', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { npu: { available: true, model: 'XDNA2' } },
      });

      const npu = await backend.detectNpu();

      expect(npu.available).toBe(true);
      expect(npu.model).toBe('XDNA2');
    });

    it('S-HW-4.2: SHALL report unavailable when Lemonade not running', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const npu = await backend.detectNpu();

      expect(npu.available).toBe(false);
    });
  });

  describe('pullModel', () => {
    it('registers and downloads a model the Hub installs from Hugging Face in one call', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.post as never) = post;

      await backend.pullModel('nomic-embed-text-v1.5-GGUF');

      expect(post).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/pull',
        {
          model_name: 'user.nomic-embed-text-v1.5-GGUF',
          recipe: 'llamacpp',
          checkpoint: 'nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.f16.gguf',
          embedding: true,
        },
        { timeout: 0 },
      );
    });

    it("pulls a model from Lemonade's own registry by name", async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.post as never) = post;

      await backend.pullModel('Qwen3.8-27B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/pull', { model_name: 'Qwen3.8-27B-GGUF' }, { timeout: 0 });
    });
  });

  describe('weightsOnDiskMb', () => {
    it('sums the files Lemonade lists for the model, weights and mmproj alike', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: {
          files: [
            { role: 'main', exists: true, size_bytes: 17_559_178_144 },
            { role: 'mmproj', exists: true, size_bytes: 927_607_488 },
          ],
        },
      });

      await expect(backend.weightsOnDiskMb('Qwen3.8-27B-GGUF')).resolves.toBe(17_630);
      expect(axios.get).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/models/Qwen3.8-27B-GGUF/files', { timeout: 5000 });
    });

    it('answers null for a model not downloaded yet, or when Lemonade cannot be asked', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { files: [{ role: 'main', exists: false, size_bytes: 0 }] } });
      await expect(backend.weightsOnDiskMb('Qwen3.8-27B-GGUF')).resolves.toBeNull();

      (axios.get as any) = vi.fn().mockRejectedValue(new Error('404'));
      await expect(backend.weightsOnDiskMb('Qwen3.8-27B-GGUF')).resolves.toBeNull();
    });
  });

  describe('Model lifecycle', () => {
    it('loads through Lemonade’s documented /v1/load endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.loadModel('Qwen3-8B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/load', { model_name: 'Qwen3-8B-GGUF' }, { timeout: 120000 });
    });

    it('saves the window as the model’s own option, then loads at it', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.loadModel('Qwen3.8-27B-GGUF', { contextLength: 16384 });

      // Saved first so Lemonade's OWN loads (an inference request for a model not resident) use it
      // too, instead of its auto-sizing against the whole card.
      expect(post).toHaveBeenNthCalledWith(
        1,
        'http://ci-hub-lemonade:13305/v1/models/Qwen3.8-27B-GGUF/options',
        { ctx_size: 16384 },
        { timeout: 10000 },
      );
      expect(post).toHaveBeenNthCalledWith(
        2,
        'http://ci-hub-lemonade:13305/v1/load',
        { model_name: 'Qwen3.8-27B-GGUF', ctx_size: 16384 },
        { timeout: 120000 },
      );
    });

    it('still loads at the window when saving it fails', async () => {
      const post = vi
        .fn()
        .mockRejectedValueOnce(new Error('404'))
        .mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.loadModel('Qwen3.8-27B-GGUF', { contextLength: 16384 });

      expect(post).toHaveBeenLastCalledWith(
        'http://ci-hub-lemonade:13305/v1/load',
        { model_name: 'Qwen3.8-27B-GGUF', ctx_size: 16384 },
        { timeout: 120000 },
      );
    });

    it('unloads through Lemonade’s documented /v1/unload endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.unloadModel('Qwen3-8B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/unload', { model_name: 'Qwen3-8B-GGUF' }, { timeout: 30000 });
    });
  });

  describe('Compose config', () => {
    it('should include AMD devices', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });
      expect(config.devices).toContain('/dev/kfd');
    });

    it('adds numeric host GIDs derived from the device nodes it mounts', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // 990 owns /dev/kfd and renderD128, 44 owns card1 — sorted and de-duplicated.
      expect(config.group_add).toEqual(['44', '990']);
    });

    it('never names a group, which would resolve against the container /etc/group', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // The original defect: `render` is GID 109 in the container and 990 on these hosts, so
      // the container joined a group granting nothing and every GPU open failed with EACCES.
      expect(config.group_add).not.toContain('render');
      expect(config.group_add).not.toContain('video');
      expect(JSON.stringify(config)).not.toMatch(/"(render|video)"/);
    });

    it('honours explicitly supplied group IDs without probing /dev', () => {
      const probe = { ...noGpuProbe };
      const config = backend.getComposeConfig('amd', { groupIds: [44, 992], deviceProbe: probe });

      expect(config.group_add).toEqual(['44', '992']);
    });

    it('still emits a deployable AMD config when no GIDs can be derived', () => {
      // Lemonade is not GPU-only — it also serves on CPU and the Ryzen AI NPU — so unlike
      // Lucebox it degrades rather than throwing. It must still never fall back to names.
      const config = backend.getComposeConfig('amd', { deviceProbe: noGpuProbe });

      expect(config.devices).toEqual(['/dev/kfd', '/dev/dri']);
      expect(config).not.toHaveProperty('group_add');
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('omits group_add'));
    });

    it('leaves the non-AMD branches without device permissions', () => {
      for (const vendor of ['nvidia', 'none']) {
        const config = backend.getComposeConfig(vendor, { deviceProbe: strixHaloProbe });

        expect(config).not.toHaveProperty('group_add');
        expect(config).not.toHaveProperty('devices');
      }
    });
  });

  // Every fleet Lemonade node runs the 10.2.0 apt package. Its registry lacks 13 of the catalog's
  // Lemonade rows, and it names a Hub-registered model only as `user.<id>`.
  describe('what the connected Lemonade offers (10.2.0 registry)', () => {
    /** A 10.2.0 server: `/v1/health` with its version, `/v1/models` the downloaded ids, `show_all` the registry. */
    const serve10_2_0 = (downloaded: string[] = [], registered: string[] = []) => {
      const get = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/v1/health')) return Promise.resolve({ status: 200, data: { status: 'ok', version: '10.2.0' } });
        if (url.endsWith('/v1/models?show_all=true')) return Promise.resolve({ data: lemonadeShowAllBody(downloaded, registered) });
        if (url.endsWith('/v1/models')) return Promise.resolve({ data: { object: 'list', data: downloaded.map((id) => ({ id })) } });
        return Promise.resolve({ data: {} });
      });
      (axios.get as any) = get;
      return get;
    };
    const showAllReads = (get: ReturnType<typeof vi.fn>) => get.mock.calls.filter(([url]) => String(url).endsWith('?show_all=true')).length;

    it('cannot say before any probe, so nothing is filtered', () => {
      expect(backend.offersModel('Qwen3.8-27B-GGUF')).toBeNull();
    });

    it('offers what the registry lists and what the Hub registers, and nothing else', async () => {
      serve10_2_0();
      await backend.healthCheck();

      expect(backend.offersModel('Gemma-4-E4B-it-GGUF')).toBe(true);
      // Not in 10.2.0: the chat default the Hub picked for a 7900 XTX, and for a 3080.
      expect(backend.offersModel('Qwen3.8-27B-GGUF')).toBe(false);
      expect(backend.offersModel('Gemma-4-12B-it-GGUF')).toBe(false);
      // Not in any Lemonade registry, but the Hub registers it on pull.
      expect(backend.offersModel('nomic-embed-text-v1.5-GGUF')).toBe(true);
    });

    it('filters nothing when the server ignores show_all (entries without a downloaded flag)', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/v1/health')) return Promise.resolve({ status: 200, data: { version: '9.1.0' } });
        return Promise.resolve({ data: { data: [{ id: 'Qwen3-8B-GGUF' }] } });
      });
      await backend.healthCheck();

      expect(backend.offersModel('Qwen3.8-27B-GGUF')).toBeNull();
    });

    it('reads the registry at most once a minute, and again after a pull', async () => {
      const get = serve10_2_0();
      await backend.healthCheck();
      await backend.healthCheck();
      expect(showAllReads(get)).toBe(1);

      (axios.post as never) = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      await backend.pullModel('Gemma-4-E4B-it-GGUF');
      await backend.healthCheck();
      expect(showAllReads(get)).toBe(2);
    });

    // The pool's health loop, the status route and a pull check can all probe as the minute runs out.
    it('sends one registry read for probes that arrive while it is in flight', async () => {
      const get = serve10_2_0();

      await Promise.all([backend.healthCheck(), backend.healthCheck(), backend.healthCheck()]);

      expect(showAllReads(get)).toBe(1);
      expect(backend.offersModel('Gemma-4-E4B-it-GGUF')).toBe(true);
    });

    it('does not keep a registry read that began before a pull registered a model', async () => {
      const inner = serve10_2_0();
      let answerFirstRead: (() => void) | undefined;
      const get = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('?show_all=true') && !answerFirstRead) {
          // The first read: held open until after the pull, and missing what the pull registered.
          return new Promise((resolve) => {
            answerFirstRead = () => resolve({ data: lemonadeShowAllBody() });
          });
        }
        return inner(url);
      });
      (axios.get as any) = get;
      (axios.post as never) = vi.fn().mockResolvedValue({ data: { status: 'success' } });

      const probe = backend.healthCheck();
      await vi.waitFor(() => expect(answerFirstRead).toBeDefined());
      await backend.pullModel('nomic-embed-text-v1.5-GGUF');
      answerFirstRead?.();
      await probe;
      await backend.healthCheck();

      expect(showAllReads(get)).toBe(2);
    });

    it('names a Hub-registered model the way 10.2.0 lists it, and a built-in one by its key', async () => {
      serve10_2_0(['user.nomic-embed-text-v1.5-GGUF'], ['user.nomic-embed-text-v1.5-GGUF']);
      await backend.healthCheck();

      expect(backend.engineModelId('nomic-embed-text-v1.5-GGUF')).toBe('user.nomic-embed-text-v1.5-GGUF');
      expect(backend.engineModelId('Gemma-4-E4B-it-GGUF')).toBe('Gemma-4-E4B-it-GGUF');
    });

    it('uses the bare id where the server lists it bare (2026.39.1)', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/v1/health')) return Promise.resolve({ status: 200, data: { version: '2026.39.1' } });
        return Promise.resolve({ data: { data: [{ id: 'nomic-embed-text-v1.5-GGUF', downloaded: true }] } });
      });
      await backend.healthCheck();

      expect(backend.engineModelId('nomic-embed-text-v1.5-GGUF')).toBe('nomic-embed-text-v1.5-GGUF');
    });

    it('names a not-yet-registered Hub model by its registration name, which every version resolves', () => {
      expect(backend.engineModelId('nomic-embed-text-v1.5-GGUF')).toBe('user.nomic-embed-text-v1.5-GGUF');
    });

    it('reports it loaded and reads its files under the listed spelling', async () => {
      const get = serve10_2_0(['user.nomic-embed-text-v1.5-GGUF'], ['user.nomic-embed-text-v1.5-GGUF']);

      await expect(backend.isModelLoaded('nomic-embed-text-v1.5-GGUF')).resolves.toBe(true);
      await backend.weightsOnDiskMb('nomic-embed-text-v1.5-GGUF');
      expect(get).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/models/user.nomic-embed-text-v1.5-GGUF/files', { timeout: 5000 });
    });

    it('refuses to pull a model the registry does not list, without asking the server', async () => {
      serve10_2_0();
      await backend.healthCheck();
      const post = vi.fn();
      (axios.post as never) = post;

      await expect(backend.pullModel('Qwen3.8-27B-GGUF')).rejects.toThrow(/Lemonade 10\.2\.0 does not offer Qwen3\.8-27B-GGUF/);
      expect(post).not.toHaveBeenCalled();
    });

    it("reports Lemonade's own reason for a failed pull, not axios's status line", async () => {
      const failure = Object.assign(new Error('Request failed with status code 500'), {
        response: {
          status: 500,
          data: { error: 'When registering a new model, the model name must include the `user` namespace, for example `user.Phi-4-Mini-GGUF`.' },
        },
      });
      (axios.post as never) = vi.fn().mockRejectedValue(failure);

      await expect(backend.pullModel('Qwen3.8-27B-GGUF')).rejects.toThrow(
        'Lemonade could not pull Qwen3.8-27B-GGUF: When registering a new model, the model name must include the `user` namespace, for example `user.Phi-4-Mini-GGUF`. (HTTP 500)',
      );
    });
  });

  describe('lemonadeErrorDetail', () => {
    it('reads both error shapes Lemonade answers with, and falls back to the error message', () => {
      const withBody = (data: unknown) => Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data } });
      expect(lemonadeErrorDetail(withBody({ error: 'Model not found: x' }))).toBe('Model not found: x (HTTP 404)');
      expect(lemonadeErrorDetail(withBody({ error: { message: 'bad model', type: 'not_found' } }))).toBe('bad model (HTTP 404)');
      expect(lemonadeErrorDetail(withBody({}))).toBe('Request failed with status code 404');
      expect(lemonadeErrorDetail(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    });
  });

  describe('Configuration & Auth', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    it('resolves getBaseUrl from LEMONADE_URL or default', () => {
      delete process.env.LEMONADE_URL;
      expect(backend.getBaseUrl()).toBe('http://ci-hub-lemonade:13305');

      process.env.LEMONADE_URL = 'http://127.0.0.1:13305';
      expect(backend.getBaseUrl()).toBe('http://127.0.0.1:13305');
    });

    it('returns trimmed getApiKey from LEMONADE_API_KEY or undefined', () => {
      delete process.env.LEMONADE_API_KEY;
      expect(backend.getApiKey()).toBeUndefined();

      process.env.LEMONADE_API_KEY = '  lemon-secret-123  ';
      expect(backend.getApiKey()).toBe('lemon-secret-123');
    });

    it('includes Authorization header in requests when LEMONADE_API_KEY is set', async () => {
      process.env.LEMONADE_API_KEY = 'lemon-secret-123';
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v1/health')) return Promise.resolve({ status: 200 });
        if (url.includes('/v1/models')) return Promise.resolve({ data: { data: [{ id: 'm1' }] } });
        return Promise.resolve({ data: {} });
      });

      await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/health',
        expect.objectContaining({
          headers: { Authorization: 'Bearer lemon-secret-123' },
        }),
      );
    });
  });
});
