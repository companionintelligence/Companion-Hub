import { Test, type TestingModule } from '@nestjs/testing';
import { OllamaBackend } from '../backends/ollama.backend';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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
  });
});
