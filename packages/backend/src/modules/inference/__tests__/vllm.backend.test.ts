import { Test, type TestingModule } from '@nestjs/testing';
import { normalizeVllmBaseUrl, resolveVllmProbeUrl, VllmBackend } from '../backends/vllm.backend';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

describe('VllmBackend', () => {
  let backend: VllmBackend;
  let loggerService: MockProxy<LoggerService>;
  let configurationService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    configurationService = mock<ConfigurationService>();
    configurationService.getInferencePreferences.mockReturnValue({
      preferredBackend: null,
      preferredModel: null,
      preferredEmbeddingModel: null,
      preferredVisionModel: null,
      preferredVllmApiKey: null,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VllmBackend,
        { provide: LoggerService, useValue: loggerService },
        { provide: ConfigurationService, useValue: configurationService },
      ],
    }).compile();

    backend = module.get<VllmBackend>(VllmBackend);
  });

  // ─── S-BL-2.2: Health Check ─────────────────────────────────────

  describe('Health check (BL-2)', () => {
    it('S-BL-2.2: SHALL check health via GET /v1/models', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { data: [{ id: 'llama-70b' }] },
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toContain('llama-70b');
    });

    it('should report unhealthy on failure', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('should send the configured vLLM API key when probing /v1/models', async () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: 'vllm-local',
      });
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({ headers: { Authorization: 'Bearer vllm-local' } }),
      );
    });
  });

  describe('Base URL resolution', () => {
    it('prefers the operator-configured URL from Settings over the env default', async () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
        preferredVllmUrl: 'http://192.168.1.50:8000',
      });

      expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8000');
    });

    it('normalizes a URL pasted with a trailing /v1 or slash', () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: null,
        preferredVllmUrl: 'http://192.168.1.50:8000/v1/',
      });

      expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8000');
    });

    it('probes localhost via host.docker.internal when Hub runs in Docker', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck('http://localhost:8000/v1');

      expect(axios.get).toHaveBeenCalledWith('http://host.docker.internal:8000/v1/models', expect.any(Object));
    });

    it('probes a candidate URL override without persisting it', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck('http://10.0.0.9:8000');

      expect(axios.get).toHaveBeenCalledWith('http://10.0.0.9:8000/v1/models', expect.any(Object));
    });

    it('uses a candidate API key override before saved preferences', async () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey: 'saved-key',
      });
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck(undefined, 'probe-key');

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({ headers: { Authorization: 'Bearer probe-key' } }),
      );
    });

    it('reports a clearer error when vLLM rejects the API key', async () => {
      (axios.get as any) = vi
        .fn()
        .mockRejectedValue({ response: { status: 401 }, message: 'Request failed with status code 401', isAxiosError: true });
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

      const health = await backend.healthCheck(undefined, 'wrong-key');

      expect(health.error).toContain('API key');
    });
  });

  describe('resolveVllmProbeUrl', () => {
    it('rewrites localhost to host.docker.internal for Docker-side probes', () => {
      expect(resolveVllmProbeUrl('http://localhost:8000/v1')).toBe('http://host.docker.internal:8000');
      expect(resolveVllmProbeUrl('http://127.0.0.1:8000')).toBe('http://host.docker.internal:8000');
    });

    it('leaves remote URLs unchanged', () => {
      expect(resolveVllmProbeUrl('http://192.168.1.50:8000')).toBe('http://192.168.1.50:8000');
    });
  });

  describe('normalizeVllmBaseUrl', () => {
    it('strips trailing slashes and /v1', () => {
      expect(normalizeVllmBaseUrl('http://host.docker.internal:8000/v1/')).toBe('http://host.docker.internal:8000');
    });
  });

  describe('Compose config', () => {
    it('should include GPU config for NVIDIA', () => {
      const config = backend.getComposeConfig('nvidia');
      expect(config.runtime).toBe('nvidia');
    });

    it('should decline AMD vendor rather than mount devices into the CUDA-only image', () => {
      expect(() => backend.getComposeConfig('amd')).toThrow(/no reliably maintained ROCm image/);
    });
  });
});
