import { Test, type TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { LuceboxBackend, normalizeLuceboxBaseUrl, resolveLuceboxProbeUrl } from '../backends/lucebox.backend';

vi.mock('axios');

describe('LuceboxBackend', () => {
  let backend: LuceboxBackend;
  let loggerService: MockProxy<LoggerService>;

  beforeEach(async () => {
    loggerService = mock<LoggerService>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [LuceboxBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();

    backend = module.get<LuceboxBackend>(LuceboxBackend);
  });

  describe('Health check', () => {
    it('checks Lucebox health and discovers its startup-configured model', async () => {
      (axios.get as any) = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/health')) return Promise.resolve({ status: 200 });
        return Promise.resolve({ data: { data: [{ id: 'dflash' }] } });
      });

      const health = await backend.healthCheck();

      expect(axios.get).toHaveBeenNthCalledWith(1, expect.stringContaining('/health'), expect.any(Object));
      expect(axios.get).toHaveBeenNthCalledWith(2, expect.stringContaining('/v1/models'), expect.any(Object));
      expect(health).toEqual({ running: true, healthy: true, modelsLoaded: ['dflash'] });
    });

    it('reports an unavailable server when the health probe fails', async () => {
      (axios.get as any) = vi.fn().mockRejectedValue(new Error('Connection refused'));

      await expect(backend.healthCheck()).resolves.toMatchObject({
        running: false,
        healthy: false,
        modelsLoaded: [],
        error: 'Connection refused',
      });
      expect(axios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('URL resolution', () => {
    it('strips /v1 and trailing slashes', () => {
      expect(normalizeLuceboxBaseUrl(' http://localhost:8000/v1/ ')).toBe('http://localhost:8000');
    });

    it('rewrites loopback to the Docker host only inside the Hub container', () => {
      expect(resolveLuceboxProbeUrl('http://localhost:8000/v1', true)).toBe('http://host.docker.internal:8000');
      expect(resolveLuceboxProbeUrl('http://127.0.0.1:8000', true)).toBe('http://host.docker.internal:8000');
      expect(resolveLuceboxProbeUrl('http://localhost:8000/v1', false)).toBe('http://localhost:8000');
    });
  });

  describe('Compose config', () => {
    it('selects the CUDA image and NVIDIA runtime', () => {
      const config = backend.getComposeConfig('nvidia');

      expect(config.image).toBe('ghcr.io/luce-org/lucebox-hub:cuda12');
      expect(config.runtime).toBe('nvidia');
      expect(config.ports).toEqual(['8000:8080']);
      expect(config.volumes).toEqual(['lucebox-models:/opt/lucebox-hub/server/models']);
    });

    it('selects the ROCm image and device mounts for AMD', () => {
      const config = backend.getComposeConfig('amd');

      expect(config.image).toBe('ghcr.io/luce-org/lucebox-hub:rocm');
      expect(config.devices).toEqual(['/dev/kfd', '/dev/dri']);
    });
  });

  it('does not pretend that startup-configured models can be pulled', async () => {
    const progress = vi.fn();

    await backend.pullModel('dflash', progress);

    expect(progress).toHaveBeenCalledWith({ status: 'Speculative inference models are configured when the server starts', percent: 100 });
    expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('no pull was requested'));
  });
});
