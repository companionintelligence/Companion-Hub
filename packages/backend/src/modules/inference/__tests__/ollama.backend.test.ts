import { Test, type TestingModule } from '@nestjs/testing';
import { type DeviceGroupProbe } from '../backends/amd-device-groups.util';
import { OllamaBackend } from '../backends/ollama.backend';
import { BASE_QUARANTINE_MS } from '../backends/serving-quarantine';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import axios from 'axios';

vi.mock('axios');

/**
 * A Strix Halo node: only `card1` and `renderD128` exist, the render group is GID 990 and video
 * is 44. Naming the groups instead would resolve `render` to 109 inside the container.
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

describe('OllamaBackend', () => {
  let backend: OllamaBackend;
  let loggerService: MockProxy<LoggerService>;
  type InspectableOllamaBackend = OllamaBackend & {
    configuredUrl: string;
    resolvedUrl: string;
    urlResolved: boolean;
  };

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [OllamaBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<OllamaBackend>(OllamaBackend);
  });

  const inspectable = () => backend as unknown as InspectableOllamaBackend;

  // ─── S-BL-2.1: Health Check ─────────────────────────────────────

  describe('Health check (BL-2)', () => {
    it('S-BL-2.1: SHALL check health via GET /api/tags', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { models: [{ name: 'phi4-mini' }, { name: 'qwen3:8b' }] },
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/api/tags'), expect.any(Object));
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toContain('phi4-mini');
    });

    it('should report unhealthy when connection fails', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.healthy).toBe(false);
      expect(health.error).toContain('ECONNREFUSED');
    });
  });

  // ─── Serving capability vs. inventory ──────────────────────────────

  /**
   * Fleet node core-4, twice reproduced: `GET /api/tags` answers 200 and lists `gemma3:1b`, and
   * `POST /api/generate` for that same model answers HTTP 500 `model failed to load, this may be
   * due to resource limitations or an internal error`. On the inventory alone that node was a
   * first-choice pool candidate for a model it failed 100% of requests for, and it advertised the
   * same claim to every peer. These walk the signal that stops it.
   */
  describe('Serving capability (core-4: tags 200, generate 500)', () => {
    const MODEL = 'gemma3:1b';

    /** Route the mocked GET by path — the URL probe, the on-disk inventory, and the resident list are three different answers. */
    function mockOllamaGet(options: { tags?: string[]; resident?: string[]; psFails?: boolean } = {}): void {
      (axios.get as any) = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/ps')) {
          if (options.psFails) throw new Error('connection reset by peer');
          return { data: { models: (options.resident ?? []).map((name) => ({ name })) } };
        }
        if (url.includes('/api/tags')) {
          return { data: { models: (options.tags ?? []).map((name) => ({ name })) } };
        }
        return { data: {} }; // /api/version, the reachability probe in resolveUrl()
      });
    }

    /** An error shaped like the one axios throws for core-4's answer. */
    function axiosRejection(status: number, error: string): Error {
      return Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: { status, data: { error } },
      });
    }

    const psCalls = () => ((axios.get as any).mock.calls as [string][]).filter(([url]) => url.includes('/api/ps'));

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('withholds a model the inventory lists but the engine has proved it cannot serve', async () => {
      mockOllamaGet({ tags: [MODEL], resident: [] });

      // Two requests, both answered HTTP 500 — what core-4 does for every request it is sent.
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');

      const health = await backend.healthCheck();

      // The daemon is up and the model IS on disk: both remain true, and the install badge and the
      // model puller depend on them staying true.
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toContain(MODEL);
      // What must change is where work is sent.
      expect(health.unservableModels).toContain(MODEL);
    });

    it('does not withhold a model on a single failure', async () => {
      mockOllamaGet({ tags: [MODEL] });

      backend.noteServingFailure(MODEL, 'HTTP 500');

      // One 5xx is a blip — an OOM under concurrency looks identical — and dropping a working model
      // out of routing costs more than one more failed request does.
      expect((await backend.healthCheck()).unservableModels).toBeUndefined();
    });

    it('leaves the health check at a single request while nothing is withheld', async () => {
      mockOllamaGet({ tags: [MODEL] });

      await backend.healthCheck();

      // The whole point of learning this from live requests is that the poll stays cheap.
      expect(psCalls()).toHaveLength(0);
    });

    it('releases a withheld model that Ollama reports resident in /api/ps', async () => {
      // Resident means loaded in VRAM right now — proof of the exact thing it was withheld for
      // lacking, and free to ask for.
      mockOllamaGet({ tags: [MODEL], resident: [MODEL] });
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');

      const health = await backend.healthCheck();

      expect(health.unservableModels).toBeUndefined();
      expect(psCalls()).toHaveLength(1);
      expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining(`Model ${MODEL} served again`));
    });

    it('keeps the verdict when /api/ps itself fails', async () => {
      // The inventory call already succeeded, so this is a /api/ps problem, not a down engine —
      // and the verdict decays on its own rather than needing this call to survive.
      mockOllamaGet({ tags: [MODEL], psFails: true });
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');

      expect((await backend.healthCheck()).unservableModels).toContain(MODEL);
    });

    it('clears the record as soon as the model is served again', async () => {
      mockOllamaGet({ tags: [MODEL] });
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');

      backend.noteServingSuccess(MODEL);

      expect((await backend.healthCheck()).unservableModels).toBeUndefined();
    });

    it('withholds immediately when the engine rejects an explicit load', async () => {
      mockOllamaGet({ tags: [MODEL] });
      (axios.post as any) = vi
        .fn()
        .mockRejectedValue(axiosRejection(500, 'model failed to load, this may be due to resource limitations or an internal error'));
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

      await expect(backend.loadModel(MODEL)).rejects.toThrow('Request failed with status code 500');

      // loadModel asks the engine to do nothing but load the model, so a server-side rejection
      // there is the direct answer rather than a hint — no second strike needed.
      expect((await backend.healthCheck()).unservableModels).toContain(MODEL);
    });

    it('does not blame the model when the load failed to reach the daemon at all', async () => {
      mockOllamaGet({ tags: [MODEL] });
      (axios.post as any) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(false);

      await expect(backend.loadModel(MODEL)).rejects.toThrow('ECONNREFUSED');

      // That is the whole daemon being unreachable, which healthCheck already reports. Pinning it
      // on the model would outlive the outage.
      expect((await backend.healthCheck()).unservableModels).toBeUndefined();
    });

    it('clears the record when a load finally succeeds', async () => {
      mockOllamaGet({ tags: [MODEL] });
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');
      (axios.post as any) = vi.fn().mockResolvedValue({ data: {} });

      await backend.loadModel(MODEL);

      // Recovery must not have to wait out a penalty earned before the operator fixed the box.
      expect((await backend.healthCheck()).unservableModels).toBeUndefined();
    });

    it('offers the model again once the quarantine decays, and settles it on the re-probe', async () => {
      vi.useFakeTimers();
      try {
        mockOllamaGet({ tags: [MODEL] });
        backend.noteServingFailure(MODEL, 'HTTP 500');
        backend.noteServingFailure(MODEL, 'HTTP 500');
        expect((await backend.healthCheck()).unservableModels).toContain(MODEL);

        vi.advanceTimersByTime(BASE_QUARANTINE_MS + 1_000);

        // Withholding is never permanent: the entry expires and the next request is the re-probe.
        expect((await backend.healthCheck()).unservableModels).toBeUndefined();

        // That re-probe failing settles it on its own — the benefit of the doubt was spent already.
        backend.noteServingFailure(MODEL, 'HTTP 500');

        expect((await backend.healthCheck()).unservableModels).toContain(MODEL);
      } finally {
        vi.useRealTimers();
      }
    });

    it('withholds only the model that failed, not the rest of the inventory', async () => {
      mockOllamaGet({ tags: [MODEL, 'qwen3:8b'] });
      backend.noteServingFailure(MODEL, 'HTTP 500');
      backend.noteServingFailure(MODEL, 'HTTP 500');

      const health = await backend.healthCheck();

      // A node that cannot fit one model is still the right place for the ones it can fit.
      expect(health.unservableModels).toEqual([MODEL]);
      expect(health.modelsLoaded).toEqual([MODEL, 'qwen3:8b']);
    });
  });

  // ─── Model Operations ──────────────────────────────────────────────

  describe('Model operations', () => {
    it('should list models', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { models: [{ name: 'phi4-mini', size: 2600000000 }] },
      });

      const models = await backend.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('phi4-mini');
    });

    it('should invalidate the cached URL when listModels fails', async () => {
      const state = inspectable();
      state.resolvedUrl = 'http://cached:11434';
      state.urlResolved = true;
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('timeout'));

      const models = await backend.listModels();

      expect(models).toEqual([]);
      expect(state.urlResolved).toBe(false);
      expect(state.resolvedUrl).toBe(state.configuredUrl);
    });

    it('should load model with keep_alive=-1 (pin)', async () => {
      (axios.post as any) = vi.fn().mockResolvedValue({ data: {} });

      await backend.loadModel('phi4-mini');

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({ model: 'phi4-mini', keep_alive: -1 }),
        expect.any(Object),
      );
    });

    it('should log error and rethrow when loadModel fails', async () => {
      const state = inspectable();
      state.resolvedUrl = 'http://cached:11434';
      state.urlResolved = true;
      (axios.post as any) = vi.fn().mockRejectedValue(new Error('connection refused'));

      await expect(backend.loadModel('phi4-mini')).rejects.toThrow('connection refused');
      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load model phi4-mini'));
      expect(state.urlResolved).toBe(false);
      expect(state.resolvedUrl).toBe(state.configuredUrl);
    });

    it('should unload model with keep_alive=0', async () => {
      (axios.post as any) = vi.fn().mockResolvedValue({ data: {} });

      await backend.unloadModel('phi4-mini');

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/generate'),
        expect.objectContaining({ model: 'phi4-mini', keep_alive: 0 }),
        expect.any(Object),
      );
    });

    it('should log error and rethrow when unloadModel fails', async () => {
      const state = inspectable();
      state.resolvedUrl = 'http://cached:11434';
      state.urlResolved = true;
      (axios.post as any) = vi.fn().mockRejectedValue(new Error('timeout'));

      await expect(backend.unloadModel('phi4-mini')).rejects.toThrow('timeout');
      expect(loggerService.error).toHaveBeenCalledWith(expect.stringContaining('Failed to unload model phi4-mini'));
      expect(state.urlResolved).toBe(false);
      expect(state.resolvedUrl).toBe(state.configuredUrl);
    });

    it('should load embedding models via /api/embed (not /api/generate)', async () => {
      (axios.post as any) = vi.fn().mockResolvedValue({ data: {} });

      await backend.loadModel('nomic-embed-text', { embedding: true });

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/embed'),
        expect.objectContaining({ model: 'nomic-embed-text', keep_alive: -1 }),
        expect.any(Object),
      );
      const url = (axios.post as any).mock.calls[0][0] as string;
      expect(url).not.toContain('/api/generate');
    });

    it('should unload embedding models via /api/embed with keep_alive=0', async () => {
      (axios.post as any) = vi.fn().mockResolvedValue({ data: {} });

      await backend.unloadModel('nomic-embed-text', { embedding: true });

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/embed'),
        expect.objectContaining({ model: 'nomic-embed-text', keep_alive: 0 }),
        expect.any(Object),
      );
    });

    it('should check if model is loaded via /api/ps', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { models: [{ name: 'phi4-mini' }] },
      });

      const loaded = await backend.isModelLoaded('phi4-mini');
      expect(loaded).toBe(true);
    });

    it('should invalidate the cached URL when isModelLoaded fails', async () => {
      const state = inspectable();
      state.resolvedUrl = 'http://cached:11434';
      state.urlResolved = true;
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const loaded = await backend.isModelLoaded('phi4-mini');

      expect(loaded).toBe(false);
      expect(state.urlResolved).toBe(false);
      expect(state.resolvedUrl).toBe(state.configuredUrl);
    });
  });

  // ─── Pull model (streamed NDJSON) ──────────────────────────────────

  describe('Pull model', () => {
    /** Make resolveUrl() succeed, and have /api/pull stream the given NDJSON lines then end. */
    const mockPullStream = (lines: string[]) => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: {} }); // probe() in resolveUrl
      (axios.post as any) = vi.fn().mockImplementation(async () => {
        const stream = new EventEmitter();
        // Emit after the current microtask queue drains so pullModel has attached its listeners.
        setImmediate(() => {
          for (const line of lines) {
            stream.emit('data', Buffer.from(`${line}\n`));
          }
          stream.emit('end');
        });
        return { data: stream };
      });
    };

    it('resolves and reports progress when the stream ends with a success status', async () => {
      mockPullStream([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ status: 'downloading', digest: 'sha256:abc', total: 100, completed: 50 }),
        JSON.stringify({ status: 'success' }),
      ]);
      const onProgress = vi.fn();

      await expect(backend.pullModel('phi4-mini', onProgress)).resolves.toBeUndefined();

      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', percent: 50 }));
      expect(loggerService.info).toHaveBeenCalledWith('[Ollama] Model pulled: phi4-mini');
    });

    it('reassembles JSON lines split across chunk boundaries', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: {} });
      (axios.post as any) = vi.fn().mockImplementation(async () => {
        const stream = new EventEmitter();
        const successLine = `${JSON.stringify({ status: 'success' })}\n`;
        const mid = Math.floor(successLine.length / 2);
        setImmediate(() => {
          // Split the terminal success line across two chunks.
          stream.emit('data', Buffer.from(`${JSON.stringify({ status: 'pulling manifest' })}\n${successLine.slice(0, mid)}`));
          stream.emit('data', Buffer.from(successLine.slice(mid)));
          stream.emit('end');
        });
        return { data: stream };
      });

      await expect(backend.pullModel('phi4-mini')).resolves.toBeUndefined();
      expect(loggerService.info).toHaveBeenCalledWith('[Ollama] Model pulled: phi4-mini');
    });

    it('rejects when the stream reports an error (e.g. Ollama 412 manifest failure)', async () => {
      const state = inspectable();
      state.resolvedUrl = 'http://cached:11434';
      state.urlResolved = true;
      mockPullStream([
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ error: 'pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama.' }),
      ]);

      await expect(backend.pullModel('nemotron-3-nano:4b')).rejects.toThrow(/requires a newer version of Ollama/);
      expect(loggerService.info).not.toHaveBeenCalledWith('[Ollama] Model pulled: nemotron-3-nano:4b');
      expect(state.urlResolved).toBe(false);
    });

    it('rejects when the stream ends without a success status', async () => {
      mockPullStream([JSON.stringify({ status: 'pulling manifest' })]);

      await expect(backend.pullModel('phi4-mini')).rejects.toThrow(/without a success status/);
      expect(loggerService.info).not.toHaveBeenCalledWith('[Ollama] Model pulled: phi4-mini');
    });
  });

  // ─── Compose Config ────────────────────────────────────────────────

  describe('Docker compose config', () => {
    it('should include NVIDIA GPU config', () => {
      const config = backend.getComposeConfig('nvidia');
      expect(config.runtime).toBe('nvidia');
      expect(config.deploy).toBeDefined();
    });

    it('should include AMD GPU config', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });
      expect(config.devices).toContain('/dev/kfd');
      expect(config.devices).toContain('/dev/dri');
    });

    it('should produce basic config for CPU', () => {
      const config = backend.getComposeConfig('none');
      expect(config.runtime).toBeUndefined();
      expect(config.deploy).toBeUndefined();
    });

    it('should use the default (Vulkan-bundled) tag for AMD when ROCm is not ready', () => {
      expect(backend.getDockerImage()).toBe('ollama/ollama:latest');
      expect(backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe }).image).toBe('ollama/ollama:latest');
    });

    it('should use the :rocm tag for AMD when ROCm passthrough is ready', () => {
      expect(backend.getDockerImage({ rocmReady: true })).toBe('ollama/ollama:rocm');
      expect(backend.getComposeConfig('amd', { rocmReady: true, deviceProbe: strixHaloProbe }).image).toBe('ollama/ollama:rocm');
    });

    it('should force Vulkan weights into unified/GTT memory on a ROCm-not-ready APU', () => {
      const config = backend.getComposeConfig('amd', {
        rocmReady: false,
        unifiedMemory: true,
        deviceProbe: strixHaloProbe,
      });
      expect(config.environment).toEqual({ GGML_VK_PREFER_HOST_MEMORY: '1' });
    });

    it('should NOT force host memory for a discrete AMD GPU (has real VRAM)', () => {
      const config = backend.getComposeConfig('amd', {
        rocmReady: false,
        unifiedMemory: false,
        deviceProbe: strixHaloProbe,
      });
      expect(config.environment).toBeUndefined();
    });

    it('should NOT set the Vulkan host-memory env var once ROCm is ready', () => {
      const config = backend.getComposeConfig('amd', {
        rocmReady: true,
        unifiedMemory: true,
        deviceProbe: strixHaloProbe,
      });
      expect(config.environment).toBeUndefined();
    });

    it('adds numeric host GIDs derived from the device nodes it mounts', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // 990 owns /dev/kfd and renderD128, 44 owns card1 — sorted and de-duplicated.
      expect(config.group_add).toEqual(['44', '990']);
    });

    it('never names a group, which would resolve against the container /etc/group', () => {
      const config = backend.getComposeConfig('amd', { deviceProbe: strixHaloProbe });

      // The original defect: `render` is GID 109 in the container and 990 on these hosts, so the
      // container joined a group granting nothing, every GPU open failed with EACCES, and Ollama
      // quietly served on CPU.
      expect(config.group_add).not.toContain('render');
      expect(config.group_add).not.toContain('video');
      expect(JSON.stringify(config)).not.toMatch(/"(render|video)"/);
    });

    it('honours explicitly supplied group IDs without probing /dev', () => {
      const config = backend.getComposeConfig('amd', { groupIds: [44, 992], deviceProbe: noGpuProbe });

      expect(config.group_add).toEqual(['44', '992']);
    });

    it('still emits a deployable AMD config when no GIDs can be derived', () => {
      // Ollama is the default backend, serves fine on CPU, and runs as root — so unlike Lucebox it
      // degrades rather than throwing. It must still never fall back to names.
      const config = backend.getComposeConfig('amd', { deviceProbe: noGpuProbe });

      expect(config.devices).toEqual(['/dev/kfd', '/dev/dri']);
      expect(config).not.toHaveProperty('group_add');
      expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('omits group_add'));
    });

    it('still applies the Vulkan host-memory fallback when the GIDs degrade away', () => {
      // The degrade path must not short-circuit the rest of the `amd` branch.
      const config = backend.getComposeConfig('amd', {
        rocmReady: false,
        unifiedMemory: true,
        deviceProbe: noGpuProbe,
      });

      expect(config).not.toHaveProperty('group_add');
      expect(config.environment).toEqual({ GGML_VK_PREFER_HOST_MEMORY: '1' });
    });

    it('leaves the non-AMD branches without device permissions', () => {
      for (const vendor of ['nvidia', 'none']) {
        const config = backend.getComposeConfig(vendor, { deviceProbe: strixHaloProbe });

        expect(config).not.toHaveProperty('group_add');
        expect(config).not.toHaveProperty('devices');
      }
    });
  });
});
