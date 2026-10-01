import { Test, type TestingModule } from '@nestjs/testing';
import { buildVllmRemediation, normalizeVllmBaseUrl, resolveVllmProbeUrl, VllmBackend } from '../backends/vllm.backend';
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

    it('yields the server to oMLX when /v1/models says it is theirs — both default to host port 8000', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { data: [{ id: 'mlx-community/Qwen3-8B-4bit', owned_by: 'omlx' }] },
      });

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: true, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain("the omlx backend's server, not vllm's");
      expect(health.error).toContain('VLLM_URL');
      await expect(backend.listModels()).resolves.toEqual([]);
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

    it('returns the API key via getApiKey with precedence: override > preferences > env', () => {
      const originalEnv = process.env.VLLM_API_KEY;
      try {
        process.env.VLLM_API_KEY = 'env-key';
        configurationService.getInferencePreferences.mockReturnValue({
          preferredBackend: 'vllm',
          preferredModel: null,
          preferredEmbeddingModel: null,
          preferredVisionModel: null,
          preferredVllmApiKey: null,
        });

        expect(backend.getApiKey()).toBe('env-key');

        configurationService.getInferencePreferences.mockReturnValue({
          preferredBackend: 'vllm',
          preferredModel: null,
          preferredEmbeddingModel: null,
          preferredVisionModel: null,
          preferredVllmApiKey: 'saved-key',
        });

        expect(backend.getApiKey()).toBe('saved-key');
        expect(backend.getApiKey('override-key')).toBe('override-key');
      } finally {
        if (originalEnv === undefined) delete process.env.VLLM_API_KEY;
        else process.env.VLLM_API_KEY = originalEnv;
      }
    });
  });

  // `vllm/status` and `onboarding-profile` pass their `?url=` straight to healthCheck. The saved
  // key used to go to whatever URL that was, so any AuthGuard principal could collect it by naming
  // a listener, and an operator re-checking a new server sent it the old server's key.
  describe('which key a Re-check probe carries', () => {
    const SAVED_URL = 'http://192.168.1.50:8000';

    const saved = (preferredVllmApiKey: string | null) =>
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'vllm',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredVllmApiKey,
        preferredVllmUrl: SAVED_URL,
      } as never);

    const sentAuthorization = () => (vi.mocked(axios.get).mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)?.headers;

    beforeEach(() => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });
    });

    it('sends no key to a URL other than the saved one when no probe key is given', async () => {
      saved('saved-key');

      await backend.healthCheck('http://attacker.example:9999');

      expect(axios.get).toHaveBeenCalledWith('http://attacker.example:9999/v1/models', expect.any(Object));
      expect(sentAuthorization()).toBeUndefined();
    });

    it('withholds VLLM_API_KEY from the environment the same way', async () => {
      const originalEnv = process.env.VLLM_API_KEY;
      try {
        process.env.VLLM_API_KEY = 'env-key';
        saved(null);

        await backend.healthCheck('http://10.0.0.9:8000');

        expect(sentAuthorization()).toBeUndefined();
      } finally {
        if (originalEnv === undefined) delete process.env.VLLM_API_KEY;
        else process.env.VLLM_API_KEY = originalEnv;
      }
    });

    it.each([SAVED_URL, `${SAVED_URL}/`, `${SAVED_URL}/v1`, 'HTTP://192.168.1.50:8000/v1/'])(
      'sends the saved key when re-checking the saved server, spelled %s',
      async (url) => {
        saved('saved-key');

        await backend.healthCheck(url);

        expect(sentAuthorization()).toEqual({ Authorization: 'Bearer saved-key' });
      },
    );

    it('sends the key typed for the probe to any URL, as before', async () => {
      saved('saved-key');

      await backend.healthCheck('http://10.0.0.9:8000', 'typed-key');

      expect(sentAuthorization()).toEqual({ Authorization: 'Bearer typed-key' });
    });

    it('says why no key went out when a new server answers 401', async () => {
      saved('saved-key');
      (axios.get as any) = vi
        .fn()
        .mockRejectedValue({ response: { status: 401 }, message: 'Request failed with status code 401', isAxiosError: true });
      vi.spyOn(axios, 'isAxiosError').mockReturnValue(true);

      const health = await backend.healthCheck('http://10.0.0.9:8000');

      expect(health.error).toContain('sent only to the saved vLLM URL');
    });
  });

  describe('resolveVllmProbeUrl', () => {
    it('rewrites localhost to host.docker.internal only when Hub is in a container', () => {
      expect(resolveVllmProbeUrl('http://localhost:8000/v1', true)).toBe('http://host.docker.internal:8000');
      expect(resolveVllmProbeUrl('http://127.0.0.1:8000', true)).toBe('http://host.docker.internal:8000');
      expect(resolveVllmProbeUrl('http://localhost:8000/v1', false)).toBe('http://localhost:8000');
    });

    it('leaves remote URLs unchanged', () => {
      expect(resolveVllmProbeUrl('http://192.168.1.50:8000', true)).toBe('http://192.168.1.50:8000');
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

    it('should decline Apple vendor rather than deploy a Metal-blind CUDA container via Docker Desktop', () => {
      expect(() => backend.getComposeConfig('apple')).toThrow(/no Docker path on Apple Silicon/);
    });
  });

  describe('buildVllmRemediation', () => {
    it('prints the NVIDIA serve command and sends Apple Silicon to oMLX', () => {
      const remediation = buildVllmRemediation();
      expect(remediation.command).toBe('vllm serve Qwen/Qwen3-4B-Instruct-2507 --host 0.0.0.0 --port 8000');
      expect(remediation.hint).toContain('oMLX');
    });
  });
});
