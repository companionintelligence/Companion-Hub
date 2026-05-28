import { Test, type TestingModule } from '@nestjs/testing';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { CatalogVerifierService } from '../catalog-verifier.service';
import { ModelRegistryService } from '../model-registry.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { CuratedModel } from '@ci-hub/common/types';

vi.mock('axios', () => ({
  default: {
    head: vi.fn(),
  },
}));

const makeModel = (id: string, backendModelId: string, backend: 'ollama' | 'vllm' = 'ollama'): CuratedModel =>
  ({
    id,
    backend,
    backendModelId,
    modality: 'llm',
    purpose: 'general',
    displayName: id,
    description: '',
    requirements: { minVramMb: 0, recommendedVramMb: 0, minRamMb: 0, diskMb: 0, gpuVendors: ['cpu'], npuRequired: false, minTier: 'cpu-only' },
    runtime: {
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      input: ['text'],
      quantization: 'q4_K_M',
      pinnedByDefault: false,
      memoryFootprintMb: 0,
    },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as unknown as CuratedModel;

describe('CatalogVerifierService', () => {
  let service: CatalogVerifierService;
  let logger: MockProxy<LoggerService>;
  let registry: MockProxy<ModelRegistryService>;
  const head = vi.mocked(axios.head);

  beforeEach(async () => {
    logger = mock<LoggerService>();
    registry = mock<ModelRegistryService>();
    head.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [CatalogVerifierService, { provide: LoggerService, useValue: logger }, { provide: ModelRegistryService, useValue: registry }],
    }).compile();
    service = module.get<CatalogVerifierService>(CatalogVerifierService);
  });

  describe('verifyAll', () => {
    it('marks 200 responses as exists and 404 responses as missing', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b'), makeModel('b', 'fake:1t')]);
      head.mockImplementation(async (url: string) => {
        if (url.includes('gemma3')) return { status: 200, data: '', statusText: 'OK', headers: {}, config: {} as any };
        return { status: 404, data: '', statusText: 'Not Found', headers: {}, config: {} as any };
      });

      const summary = await service.verifyAll();

      expect(summary.totalChecked).toBe(2);
      expect(summary.totalExists).toBe(1);
      expect(summary.totalMissing).toBe(1);
      expect(summary.results.find((r) => r.backendModelId === 'gemma3:4b')?.status).toBe('exists');
      expect(summary.results.find((r) => r.backendModelId === 'fake:1t')?.status).toBe('missing');
    });

    it('treats non-2xx, non-404 responses as unknown with the HTTP status as errorMessage', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b')]);
      head.mockResolvedValue({ status: 503, data: '', statusText: '', headers: {}, config: {} as any });

      const summary = await service.verifyAll();

      expect(summary.totalUnknown).toBe(1);
      expect(summary.results[0].status).toBe('unknown');
      expect(summary.results[0].errorMessage).toContain('503');
    });

    it('captures network errors as unknown with the error message', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b')]);
      head.mockRejectedValue(new Error('ETIMEDOUT'));

      const summary = await service.verifyAll();

      expect(summary.totalUnknown).toBe(1);
      expect(summary.results[0].errorMessage).toBe('ETIMEDOUT');
    });

    it('skips non-Ollama backends so vLLM/Lemonade catalog entries do not hit ollama.com', async () => {
      registry.getCatalog.mockReturnValue([makeModel('o', 'gemma3:4b', 'ollama'), makeModel('v', 'meta/llama-3:fp16', 'vllm')]);
      head.mockResolvedValue({ status: 200, data: '', statusText: '', headers: {}, config: {} as any });

      const summary = await service.verifyAll();

      expect(summary.totalChecked).toBe(1);
      expect(head).toHaveBeenCalledTimes(1);
    });

    it('dedupes catalog entries that share a backendModelId (one probe per tag)', async () => {
      registry.getCatalog.mockReturnValue([
        makeModel('quant1', 'gemma3:4b'),
        makeModel('quant2', 'gemma3:4b'),
        makeModel('quant3', 'gemma3:4b'),
        makeModel('other', 'gemma3:12b'),
      ]);
      head.mockResolvedValue({ status: 200, data: '', statusText: '', headers: {}, config: {} as any });

      const summary = await service.verifyAll();

      expect(summary.totalChecked).toBe(2);
      expect(head).toHaveBeenCalledTimes(2);
    });

    it('builds the registry URL from backend ID, defaulting tag to :latest when omitted', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3'), makeModel('b', 'gemma3:4b')]);
      head.mockResolvedValue({ status: 200, data: '', statusText: '', headers: {}, config: {} as any });

      await service.verifyAll();

      expect(head).toHaveBeenCalledWith('https://registry.ollama.ai/v2/library/gemma3/manifests/latest', expect.any(Object));
      expect(head).toHaveBeenCalledWith('https://registry.ollama.ai/v2/library/gemma3/manifests/4b', expect.any(Object));
    });

    it('does not throw even when every probe errors — verifier never blocks boot', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b'), makeModel('b', 'gemma3:12b')]);
      head.mockRejectedValue(new Error('connection refused'));

      await expect(service.verifyAll()).resolves.toBeDefined();
    });

    it('emits a warn log when any tag is missing', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'fake:1t')]);
      head.mockResolvedValue({ status: 404, data: '', statusText: '', headers: {}, config: {} as any });

      await service.verifyAll();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fake:1t'));
    });

    it('emits an info log (not warn) when every tag exists', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b')]);
      head.mockResolvedValue({ status: 200, data: '', statusText: '', headers: {}, config: {} as any });

      await service.verifyAll();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('serializes concurrent verifyAll calls — second caller returns the cached summary', async () => {
      registry.getCatalog.mockReturnValue([makeModel('a', 'gemma3:4b')]);
      let resolveHead: (v: any) => void = () => {};
      head.mockReturnValueOnce(
        new Promise((r) => {
          resolveHead = r;
        }),
      );

      const first = service.verifyAll();
      const second = service.verifyAll();
      resolveHead({ status: 200, data: '', statusText: '', headers: {}, config: {} as any });
      const [a, b] = await Promise.all([first, second]);

      expect(head).toHaveBeenCalledTimes(1);
      expect(a).toBe(b);
    });
  });

  describe('getSummary', () => {
    it('returns an empty summary before verification has run', () => {
      const summary = service.getSummary();
      expect(summary.startedAt).toBeNull();
      expect(summary.totalChecked).toBe(0);
    });
  });

  describe('onModuleInit', () => {
    it('honors CI_HUB_DISABLE_CATALOG_VERIFY=1 by skipping the background probe', () => {
      const prev = process.env.CI_HUB_DISABLE_CATALOG_VERIFY;
      process.env.CI_HUB_DISABLE_CATALOG_VERIFY = '1';
      try {
        service.onModuleInit();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('disabled via CI_HUB_DISABLE_CATALOG_VERIFY'));
      } finally {
        if (prev === undefined) delete process.env.CI_HUB_DISABLE_CATALOG_VERIFY;
        else process.env.CI_HUB_DISABLE_CATALOG_VERIFY = prev;
      }
    });
  });
});
