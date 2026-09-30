import { Test, type TestingModule } from '@nestjs/testing';
import { LemonadeBackend, lemonadeErrorDetail } from '../backends/lemonade.backend';
import { lemonadeShowAllBody } from './lemonade-10.2.0-registry.fixture';
import type { DeviceGroupProbe } from '../backends/amd-device-groups.util';
import { InferenceBackendRegistry } from '../backends/backend-registry';
import type { OllamaBackend } from '../backends/ollama.backend';
import type { OmlxBackend } from '../backends/omlx.backend';
import type { VllmBackend } from '../backends/vllm.backend';
import type { CloudFallbackService } from '../cloud-fallback.service';
import type { HardwareInspectorService } from '../hardware-inspector.service';
import { InferenceRouterService } from '../inference-router.service';
import type { MemoryManagerService } from '../memory-manager.service';
import type { ModelPullerService } from '../model-puller.service';
import { ModelRegistryService } from '../model-registry.service';
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

    // L3: a request's load stepped below Hermes' 64000 floor because an app's idle Ollama model held the
    // card. Saved, that window outlived the shortfall: Lemonade's own later loads and every handout
    // capped at the saved window stayed below the floor after the memory came back.
    describe('a provisional window, below an installed app floor for memory this load could not free', () => {
      const savedAt = (recipe_options: Record<string, unknown>) => {
        (axios.get as never) = vi.fn().mockResolvedValue({ data: { id: 'Gemma-4-E4B-it-GGUF', recipe_options } });
        const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
        (axios.post as never) = post;
        return post;
      };

      it('loads at it, with the options already saved, but keeps the larger saved window for the next load', async () => {
        const post = savedAt({ llamacpp_backend: 'vulkan', ctx_size: 64_000 });

        await backend.loadModel('Gemma-4-E4B-it-GGUF', { contextLength: 32_768, provisionalWindow: true });

        expect(post).toHaveBeenCalledWith(
          'http://ci-hub-lemonade:13305/v1/load',
          { llamacpp_backend: 'vulkan', model_name: 'Gemma-4-E4B-it-GGUF', ctx_size: 32_768 },
          { timeout: 120000 },
        );
      });

      // Lemonade's own default is worse than any window the Hub chose: 4096 on 10.2.0, and the whole
      // card's worth on 2026.x, which is how Lemonade and Ollama together froze beta-1 on 2026-09-29.
      it('still saves it where nothing, or a smaller window, is saved', async () => {
        for (const recipe_options of [{}, { ctx_size: -1 }, { ctx_size: 16_384 }]) {
          const post = savedAt(recipe_options);

          await backend.loadModel('Gemma-4-E4B-it-GGUF', { contextLength: 32_768, provisionalWindow: true });

          expect(post).toHaveBeenCalledWith(
            'http://ci-hub-lemonade:13305/v1/load',
            expect.objectContaining({ model_name: 'Gemma-4-E4B-it-GGUF', ctx_size: 32_768, save_options: true }),
            { timeout: 120000 },
          );
        }
      });

      it('is saved like any other window when the load is not provisional', async () => {
        const post = savedAt({ ctx_size: 64_000 });

        await backend.loadModel('Gemma-4-E4B-it-GGUF', { contextLength: 32_768 });

        expect(post).toHaveBeenCalledWith(
          'http://ci-hub-lemonade:13305/v1/load',
          { model_name: 'Gemma-4-E4B-it-GGUF', ctx_size: 32_768, save_options: true },
          { timeout: 120000 },
        );
      });
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

    // L3: a provisional load runs below the saved window without saving (see loadModel). A handout read
    // from the saved window alone promised Hermes 64000 while Lemonade served 32768; one read from what
    // runs now alone would promise more than the next load gives, where the saved window is the smaller.
    it('is the smaller of the window it runs at and the saved one, when it is resident', async () => {
      const serve = (running: number, saved: number) => {
        (axios.get as never) = vi
          .fn()
          .mockImplementation(async (url: string) =>
            url.endsWith('/v1/health')
              ? { data: { all_models_loaded: [{ model_name: 'Gemma-4-E4B-it-GGUF', type: 'llm', recipe_options: { ctx_size: running } }] } }
              : { data: { id: 'Gemma-4-E4B-it-GGUF', recipe_options: { ctx_size: saved } } },
          );
      };

      serve(32_768, 64_000);
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBe(32_768);
      serve(64_000, 32_768);
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBe(32_768);
      serve(64_000, 64_000);
      await expect(backend.servedContextLength('Gemma-4-E4B-it-GGUF')).resolves.toBe(64_000);
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

  // #1685 × #1686. 10.2.0 lists — and knows only — the embedder the Hub registers as `user.<id>`, while
  // the load path, the handouts and the puller ask with the catalog's bare id. Matched exactly, it read
  // as not resident, so every load of it reloaded (and, through the puller, re-registered) a model
  // already in memory; its saved options were read from a route that answers "Model not found".
  describe('a Hub-registered embedder that 10.2.0 lists as user.<id>', () => {
    /** `/v1/health` as 10.2.0's `Router::get_all_loaded_models` writes each record. */
    const health102WithEmbedder = {
      status: 'ok',
      version: '10.2.0',
      model_loaded: 'Gemma-4-E4B-it-GGUF',
      all_models_loaded: [
        {
          model_name: 'Gemma-4-E4B-it-GGUF',
          checkpoint: 'unsloth/gemma-4-E4B-it-GGUF:Q4_K_M',
          type: 'llm',
          device: 'gpu',
          backend_url: 'http://127.0.0.1:8001/v1',
          recipe: 'llamacpp',
          recipe_options: { ctx_size: 32768, llamacpp_backend: 'vulkan' },
          last_use: 1_790_000_000_000,
        },
        {
          model_name: 'user.nomic-embed-text-v1.5-GGUF',
          checkpoint: 'nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.f16.gguf',
          type: 'embedding',
          device: 'gpu',
          backend_url: 'http://127.0.0.1:8002/v1',
          recipe: 'llamacpp',
          recipe_options: { ctx_size: 8192, llamacpp_backend: 'vulkan' },
          last_use: 1_790_000_000_000,
        },
      ],
    };
    /** A 10.2.0 server holding both, whose `/v1/models/{id}` knows the embedder only under `user.`. */
    const serve = () => {
      const get = vi.fn(async (url: string) => {
        if (url.endsWith('/v1/health')) return { status: 200, data: health102WithEmbedder };
        if (url.endsWith('/v1/models/user.nomic-embed-text-v1.5-GGUF')) {
          return { data: { id: 'user.nomic-embed-text-v1.5-GGUF', recipe_options: {} } };
        }
        if (url.endsWith('/v1/models')) {
          return { data: { data: [{ id: 'Gemma-4-E4B-it-GGUF' }, { id: 'user.nomic-embed-text-v1.5-GGUF' }] } };
        }
        throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'Model not found' } } });
      });
      (axios.get as never) = get;
      return get;
    };

    it('reads it as resident under the catalog id, and only what is resident', async () => {
      serve();

      await expect(backend.isModelLoaded('nomic-embed-text-v1.5-GGUF')).resolves.toBe(true);
      await expect(backend.isModelLoaded('user.nomic-embed-text-v1.5-GGUF')).resolves.toBe(true);
      await expect(backend.isModelLoaded('Gemma-4-E4B-it-GGUF')).resolves.toBe(true);
      await expect(backend.isModelLoaded('nomic-embed-text-v1-GGUF')).resolves.toBe(false);
    });

    it('still finds it where a server lists it bare (2026.39.1), before any probe has said so', async () => {
      (axios.get as never) = vi.fn().mockResolvedValue({
        data: { all_models_loaded: [{ model_name: 'nomic-embed-text-v1.5-GGUF', loaded: true, status: 'ready', backend_alive: true }] },
      });

      await expect(backend.isModelLoaded('nomic-embed-text-v1.5-GGUF')).resolves.toBe(true);
    });

    it('reads its saved options, and the window it runs at, under the name the server knows it by', async () => {
      const get = serve();

      await expect(backend.servedContextLength('nomic-embed-text-v1.5-GGUF')).resolves.toBe(8192);

      expect(get).toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/models/user.nomic-embed-text-v1.5-GGUF', { timeout: 5000 });
      expect(get).not.toHaveBeenCalledWith('http://ci-hub-lemonade:13305/v1/models/nomic-embed-text-v1.5-GGUF', expect.anything());
    });

    it('loads it under that name, whichever spelling the caller has', async () => {
      const post = vi.fn().mockResolvedValue({ data: { status: 'success' } });
      (axios.post as never) = post;

      await backend.loadModel('nomic-embed-text-v1.5-GGUF', { embedding: true });

      expect(post).toHaveBeenCalledWith(
        'http://ci-hub-lemonade:13305/v1/load',
        { model_name: 'user.nomic-embed-text-v1.5-GGUF' },
        { timeout: 120000 },
      );
    });

    // Through the router's load path with the real backend: the embedder is adopted as loaded, not
    // loaded again. The pool proxy, MCP hub_load_model and a pin all reach it this way.
    it('is adopted by the load path as resident, with nothing loaded or registered again', async () => {
      serve();
      const post = vi.fn();
      (axios.post as never) = post;
      const logger = mock<LoggerService>();
      const registry = new ModelRegistryService(logger);
      registry.trackModel('nomic-embed-text-v1-5-lemonade', 'pulled');
      const puller = mock<ModelPullerService>();
      const router = new InferenceRouterService(
        logger,
        mock<HardwareInspectorService>(),
        registry,
        mock<MemoryManagerService>(),
        mock<CloudFallbackService>(),
        new InferenceBackendRegistry(mock<OllamaBackend>(), mock<VllmBackend>(), backend, mock<OmlxBackend>()),
        puller,
      );

      await expect(router.loadTrackedModel('nomic-embed-text-v1-5-lemonade', { origin: 'request', numCtx: null })).resolves.toEqual({
        loaded: true,
      });

      expect(registry.getTrackedModel('nomic-embed-text-v1-5-lemonade')?.state).toBe('loaded');
      expect(puller.loadModel).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
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
