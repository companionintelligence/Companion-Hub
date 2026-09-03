import { Test, type TestingModule } from '@nestjs/testing';
import { OllamaBackend } from '../backends/ollama.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import axios from 'axios';

vi.mock('axios');

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
      const config = backend.getComposeConfig('amd');
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
      expect(backend.getComposeConfig('amd').image).toBe('ollama/ollama:latest');
    });

    it('should use the :rocm tag for AMD when ROCm passthrough is ready', () => {
      expect(backend.getDockerImage({ rocmReady: true })).toBe('ollama/ollama:rocm');
      expect(backend.getComposeConfig('amd', { rocmReady: true }).image).toBe('ollama/ollama:rocm');
    });

    it('should force Vulkan weights into unified/GTT memory on a ROCm-not-ready APU', () => {
      const config = backend.getComposeConfig('amd', { rocmReady: false, unifiedMemory: true });
      expect(config.environment).toEqual({ GGML_VK_PREFER_HOST_MEMORY: '1' });
    });

    it('should NOT force host memory for a discrete AMD GPU (has real VRAM)', () => {
      const config = backend.getComposeConfig('amd', { rocmReady: false, unifiedMemory: false });
      expect(config.environment).toBeUndefined();
    });

    it('should NOT set the Vulkan host-memory env var once ROCm is ready', () => {
      const config = backend.getComposeConfig('amd', { rocmReady: true, unifiedMemory: true });
      expect(config.environment).toBeUndefined();
    });
  });
});
