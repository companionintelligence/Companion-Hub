import { Test, type TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { LMSTUDIO_DEFAULT_PORT, LmStudioBackend } from '../backends/lmstudio.backend';

vi.mock('axios');

/** LM Studio's native listing: downloaded models, each with the `state` that says if it is in memory. */
const nativeModels = (rows: Array<Record<string, unknown>>) => ({ data: { data: rows } });

describe('LmStudioBackend', () => {
  let backend: LmStudioBackend;
  let loggerService: MockProxy<LoggerService>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    loggerService = mock<LoggerService>();
    const module: TestingModule = await Test.createTestingModule({
      providers: [LmStudioBackend, { provide: LoggerService, useValue: loggerService }],
    }).compile();
    backend = module.get<LmStudioBackend>(LmStudioBackend);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('endpoint resolution', () => {
    it("defaults to LM Studio's own port on this machine", () => {
      delete process.env.LMSTUDIO_URL;

      expect(backend.getBaseUrl()).toMatch(new RegExp(`:${LMSTUDIO_DEFAULT_PORT}$`));
    });

    it('accepts a configured URL with a /v1 suffix and stores the origin', () => {
      process.env.LMSTUDIO_URL = 'http://macbook.local:1234/v1';

      expect(backend.getBaseUrl()).toBe('http://macbook.local:1234');
    });
  });

  describe('inventory and residency are different questions', () => {
    /*
     * The distinction this backend exists to keep: `/v1/models` on LM Studio lists everything the
     * operator has ever DOWNLOADED, and only the native API says which of them is in memory. Reading
     * residency off the inventory would call a whole model library "loaded".
     */
    it('reports every downloaded model as inventory, and only the loaded one as resident', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/api/v0/models')) {
          return Promise.resolve(
            nativeModels([
              { id: 'qwen3.6-27b', state: 'loaded', max_context_length: 262144, quantization: 'Q4_K_M' },
              { id: 'gemma4-12b', state: 'not-loaded' },
            ]),
          );
        }
        return Promise.resolve({ data: { data: [{ id: 'qwen3.6-27b' }, { id: 'gemma4-12b' }] } });
      });

      await expect(backend.healthCheck()).resolves.toMatchObject({ modelsLoaded: ['qwen3.6-27b', 'gemma4-12b'] });

      const residency = await backend.listResident();
      expect(residency.source).toBe('measured');
      expect(residency.models).toEqual([
        {
          id: 'qwen3.6-27b',
          engineGpuBytes: null,
          totalBytes: null,
          expiresAt: null,
          contextLength: 262144,
          quantization: 'Q4_K_M',
        },
      ]);
    });

    /*
     * 'measured' with an empty list is a fact about the machine — nothing is loaded — and must not
     * be confused with an engine that cannot answer.
     */
    it("reports 'measured' with an empty list when the engine says nothing is loaded", async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockImplementation((url: string) =>
          url.includes('/api/v0/models')
            ? Promise.resolve(nativeModels([{ id: 'gemma4-12b', state: 'not-loaded' }]))
            : Promise.resolve({ data: { data: [{ id: 'gemma4-12b' }] } }),
        );

      const residency = await backend.listResident();

      expect(residency.source).toBe('measured');
      expect(residency.models).toEqual([]);
    });

    /*
     * The native API is in beta, so an older LM Studio 404s there. Falling back to the inventory
     * and calling it residency would be the exact lie above, so it degrades to 'unsupported'.
     */
    it("falls back to 'unsupported' rather than dressing the inventory up as residency", async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockImplementation((url: string) =>
          url.includes('/api/v0/models')
            ? Promise.reject(new Error('Request failed with status code 404'))
            : Promise.resolve({ data: { data: [{ id: 'gemma4-12b' }] } }),
        );

      const residency = await backend.listResident();

      expect(residency.source).toBe('unsupported');
      expect(residency.models).toBeNull();
      await expect(backend.healthCheck()).resolves.toMatchObject({ healthy: true, modelsLoaded: ['gemma4-12b'] });
    });

    it('answers isModelLoaded from residency, never from the download library', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockImplementation((url: string) =>
          url.includes('/api/v0/models')
            ? Promise.resolve(nativeModels([{ id: 'gemma4-12b', state: 'not-loaded' }]))
            : Promise.resolve({ data: { data: [{ id: 'gemma4-12b' }] } }),
        );

      await expect(backend.isModelLoaded('gemma4-12b')).resolves.toBe(false);
    });
  });

  describe('health', () => {
    it('is unreachable when the local server is not running', async () => {
      (axios.get as never as ReturnType<typeof vi.fn>) = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

      const health = await backend.healthCheck();

      expect(health).toMatchObject({ running: false, healthy: false, modelsLoaded: [] });
      expect(health.error).toContain('ECONNREFUSED');
    });
  });

  describe('deployment', () => {
    /* A GUI desktop application. There is no platform on which the Hub could start one. */
    it('refuses to produce an image or a compose config, and names the switch that matters', () => {
      expect(() => backend.getDockerImage()).toThrow(/desktop application/i);
      expect(() => backend.getComposeConfig()).toThrow(/Serve on Local Network/);
      expect(() => backend.getComposeConfig()).toThrow(/LMSTUDIO_URL/);
    });

    it('says downloads happen in LM Studio rather than reporting a pull it cannot do', async () => {
      const progress = vi.fn();

      await backend.pullModel('anything', progress);

      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ percent: 100 }));
      expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('LM Studio itself'));
    });

    it('says a load is unnecessary rather than silently doing nothing', async () => {
      await backend.loadModel('gemma4-12b');

      expect(loggerService.info).toHaveBeenCalledWith(expect.stringContaining('JIT'));
    });
  });
});
