import { Test, type TestingModule } from '@nestjs/testing';
import { LemonadeBackend } from '../backends/lemonade.backend';
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

    // Lemonade 10.2.0 — every Lemonade on the fleet — has no `/v1/models/{id}/options` route, so the
    // window is saved by the load itself (`save_options`), which both 10.2.0 and 2026.x take. 10.2.0
    // REPLACES the saved options with the request's, so what is already saved rides along.
    it('saves the window with the load itself, carrying back the options already saved', async () => {
      const get = vi.fn().mockResolvedValue({ data: { id: 'Qwen3.8-27B-GGUF', recipe_options: { llamacpp_backend: 'vulkan', ctx_size: 4096 } } });
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.get as never) = get;
      (axios.post as never) = post;

      await backend.loadModel('Qwen3.8-27B-GGUF', { contextLength: 16384 });

      expect(get).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/models/Qwen3.8-27B-GGUF', { timeout: 5000 });
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/load',
        { llamacpp_backend: 'vulkan', model_name: 'Qwen3.8-27B-GGUF', ctx_size: 16384, save_options: true },
        { timeout: 120000 },
      );
    });

    it('loads at the window without saving it when the saved options cannot be read, rather than wiping them', async () => {
      (axios.get as never) = vi.fn().mockRejectedValue(new Error('timeout'));
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.post as never) = post;

      await backend.loadModel('Qwen3.8-27B-GGUF', { contextLength: 16384 });

      expect(post).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/load',
        { model_name: 'Qwen3.8-27B-GGUF', ctx_size: 16384 },
        { timeout: 120000 },
      );
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('not saved'));
    });

    it('sends no window, and reads nothing first, for an embedding model', async () => {
      const get = vi.fn();
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.get as never) = get;
      (axios.post as never) = post;

      await backend.loadModel('nomic-embed-text-v1-GGUF', { embedding: true, contextLength: 8192 });

      expect(get).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/load', { model_name: 'nomic-embed-text-v1-GGUF' }, { timeout: 120000 });
    });

    it('unloads through Lemonade’s documented /v1/unload endpoint', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'ok' } });
      (axios.post as never) = post;

      await backend.unloadModel('Qwen3-8B-GGUF');

      expect(post).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/unload', { model_name: 'Qwen3-8B-GGUF' }, { timeout: 30000 });
    });
  });

  describe('the window it serves', () => {
    it('reads the saved ctx_size as the window every caller gets, and nothing when none is saved', async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({ data: { id: 'Gemma-4-E4B-it-GGUF', recipe_options: { ctx_size: 32768 } } });
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBe(32768);

      // What beta-red's 10.2.0 lists for a model nothing was ever saved for, and Lemonade's "auto".
      for (const recipe_options of [{}, { ctx_size: -1 }]) {
        (axios.get as never) = vi.fn().mockResolvedValue({ data: { id: 'Gemma-4-E4B-it-GGUF', recipe_options } });
        await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBeNull();
      }
      (axios.get as never) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBeNull();
    });

    // Lemonade loads a model by itself on a request for it, or from its own UI. With nothing saved it
    // runs at the configured default — 4096 on 10.2.0 — and the health record carries that effective
    // window, while the saved options alone left Hermes' handout at 64000.
    it('falls back to the window the model is running at when nothing is saved', async () => {
      (axios.get as never) = vi.fn().mockImplementation(async (url: string) =>
        url.endsWith('/v1/health')
          ? {
              data: {
                status: 'ok',
                all_models_loaded: [{ model_name: 'Gemma-4-E4B-it-GGUF', type: 'llm', recipe: 'llamacpp', recipe_options: { ctx_size: 4096 } }],
              },
            }
          : { data: { id: 'Gemma-4-E4B-it-GGUF', recipe_options: {} } },
      );
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBe(4096);
      // Not resident, nothing saved: nothing to say, as before.
      await expect(backend.servedContextLength('Qwen3-4B-GGUF')).resolves.toBeNull();
    });
  });

  describe('residency', () => {
    // `/v1/health` on Lemonade 10.2.0 lists what its router holds with none of 2026.x's
    // loaded/status/backend_alive markers; requiring them read every fleet Lemonade as empty.
    const health102 = {
      status: 'ok',
      version: '10.2.0',
      all_models_loaded: [
        { model_name: 'Gemma-4-E4B-it-GGUF', type: 'llm', recipe: 'llamacpp', recipe_options: { ctx_size: 32768 } },
        { model_name: 'nomic-embed-text-v1-GGUF', type: 'embedding', recipe: 'llamacpp', recipe_options: { ctx_size: 8192 } },
      ],
    };

    it("reads 10.2.0's records as resident, with the window each was loaded at", async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({ data: health102 });

      const residency = await backend.listResident();

      expect(residency.source).toBe('measured');
      expect(residency.models?.map((model) => [model.id, model.contextLength])).toEqual([
        ['Gemma-4-E4B-it-GGUF', 32768],
        ['nomic-embed-text-v1-GGUF', 8192],
      ]);
    });

    it('still drops a 2026.x record whose backend is gone or not ready', async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({
        data: {
          all_models_loaded: [
            { model_name: 'a', loaded: true, status: 'ready', backend_alive: true },
            { model_name: 'b', loaded: true, status: 'ready', backend_alive: false },
            { model_name: 'c', loaded: true, status: 'loading' },
            { model_name: 'd', loaded: false },
          ],
        },
      });

      await expect(backend.listResident()).resolves.toMatchObject({ models: [expect.objectContaining({ id: 'a' })] });
    });

    it('answers "loaded" only for what it holds, not for everything downloaded', async () => {
      // The inventory (`/v1/models`) lists every downloaded model; only one of them is in memory.
      (axios.get as never) = vi.fn(async (url: string) =>
        url.endsWith('/v1/health')
          ? { status: 200, data: health102 }
          : { data: { data: [{ id: 'Gemma-4-E4B-it-GGUF' }, { id: 'Qwen3.5-9B-GGUF' }] } },
      );

      await expect(backend.isModelLoaded('Gemma-4-E4B-it-GGUF')).resolves.toBe(true);
      await expect(backend.isModelLoaded('Qwen3.5-9B-GGUF')).resolves.toBe(false);
    });

    it("states the resident LLM's window to pool placement, and nothing before it has been read", async () => {
      expect(backend.engineCapabilities()).toBeNull();

      (axios.get as never) = vi.fn().mockResolvedValue({ data: health102 });
      await backend.listResident();
      // The embedder's 8192 is not a window any chat request gets.
      expect(backend.engineCapabilities()).toEqual({ slots: null, contextLength: 32768 });

      (axios.get as never) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await backend.listResident();
      expect(backend.engineCapabilities()).toBeNull();
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
