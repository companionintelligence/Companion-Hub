import { Test, type TestingModule } from '@nestjs/testing';
import { buildMtplxRemediation, normalizeMtplxBaseUrl, resolveMtplxProbeUrl, MtplxBackend } from '../backends/mtplx.backend';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

describe('MtplxBackend', () => {
  let backend: MtplxBackend;
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
      preferredMtplxUrl: null,
    });
    delete process.env.MTPLX_API_KEY;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MtplxBackend,
        { provide: LoggerService, useValue: loggerService },
        { provide: ConfigurationService, useValue: configurationService },
      ],
    }).compile();

    backend = module.get<MtplxBackend>(MtplxBackend);
  });

  afterEach(() => {
    delete process.env.MTPLX_API_KEY;
  });

  describe('Health check', () => {
    it('SHALL check health via GET /v1/models', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({
        data: { data: [{ id: 'Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed' }] },
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health.running).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.modelsLoaded).toContain('Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed');
    });

    it('should report unhealthy on failure', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const health = await backend.healthCheck();

      expect(health.running).toBe(false);
      expect(health.error).toBeDefined();
    });

    it('sends the configured bearer key to the secured model endpoint', async () => {
      process.env.MTPLX_API_KEY = 'managed-mtplx-key';
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck();

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/models'),
        expect.objectContaining({ headers: { Authorization: 'Bearer managed-mtplx-key' } }),
      );
    });
  });

  describe('Base URL resolution', () => {
    it('prefers the operator-configured URL from Settings over the env default', async () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'mtplx',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredMtplxUrl: 'http://192.168.1.50:8000',
      });

      expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8000');
    });

    it('normalizes a URL pasted with a trailing /v1 or slash', () => {
      configurationService.getInferencePreferences.mockReturnValue({
        preferredBackend: 'mtplx',
        preferredModel: null,
        preferredEmbeddingModel: null,
        preferredVisionModel: null,
        preferredMtplxUrl: 'http://192.168.1.50:8000/v1/',
      });

      expect(backend.getBaseUrl()).toBe('http://192.168.1.50:8000');
    });

    it('probes a candidate URL override without persisting it', async () => {
      (axios.get as any) = vi.fn().mockResolvedValue({ data: { data: [] } });

      await backend.healthCheck('http://10.0.0.9:8000');

      expect(axios.get).toHaveBeenCalledWith('http://10.0.0.9:8000/v1/models', expect.any(Object));
    });
  });

  describe('resolveMtplxProbeUrl', () => {
    it('rewrites localhost to host.docker.internal only when Hub is in a container', () => {
      expect(resolveMtplxProbeUrl('http://localhost:8000/v1', true)).toBe('http://host.docker.internal:8000');
      expect(resolveMtplxProbeUrl('http://127.0.0.1:8000', true)).toBe('http://host.docker.internal:8000');
      expect(resolveMtplxProbeUrl('http://localhost:8000/v1', false)).toBe('http://localhost:8000');
    });

    it('leaves remote URLs unchanged', () => {
      expect(resolveMtplxProbeUrl('http://192.168.1.50:8000', true)).toBe('http://192.168.1.50:8000');
    });
  });

  describe('normalizeMtplxBaseUrl', () => {
    it('strips trailing slashes and /v1', () => {
      expect(normalizeMtplxBaseUrl('http://host.docker.internal:8000/v1/')).toBe('http://host.docker.internal:8000');
    });
  });

  describe('Compose config', () => {
    it('should decline every vendor rather than deploy a Docker container MTPLX has no image for', () => {
      expect(() => backend.getComposeConfig()).toThrow(/no Docker path on any platform/);
      expect(() => backend.getDockerImage()).toThrow(/no Docker image/);
    });
  });

  describe('buildMtplxRemediation', () => {
    it('suggests the Homebrew install + a real catalog model', () => {
      const remediation = buildMtplxRemediation();
      expect(remediation.command).toContain('brew install youssofal/mtplx/mtplx');
      expect(remediation.command).toContain('Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed');
      expect(remediation.hint).toContain('macOS 14+');
    });
  });
});
