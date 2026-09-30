import { describe, expect, it, vi } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import type { InferenceBackend } from '../backends/backend.interface';
import { probeContextCost } from '../context-cost.util';

const model = (kvMbPerToken?: number) => ({ id: 'm', backendModelId: 'engine-m', runtime: { kvMbPerToken } }) as unknown as CuratedModel;

describe('probeContextCost', () => {
  it("returns the engine's measurement when the catalog has none", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue({ kvMbPerToken: 0.2, weightMb: 9_000, source: 'geometry' }),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, model())).resolves.toEqual({ kvMbPerToken: 0.2, weightMb: 9_000, source: 'geometry' });
    expect(backend.contextCostForModel).toHaveBeenCalledWith('engine-m');
  });

  it("takes the catalog's figure when it is smaller — Ollama over-estimates when head_count_kv is dropped", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue({ kvMbPerToken: 0.375, weightMb: 16_920, source: 'geometry' }),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, model(0.0667))).resolves.toEqual({ kvMbPerToken: 0.0667, weightMb: 16_920, source: 'catalog' });
  });

  it("keeps the engine's figure when it is the smaller", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue({ kvMbPerToken: 0.05, weightMb: 16_920, source: 'calibrated' }),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, model(0.0667))).resolves.toMatchObject({ kvMbPerToken: 0.05, source: 'calibrated' });
  });

  it("pairs the catalog's figure with the files the engine lists, for an engine that has no geometry (Lemonade)", async () => {
    const backend = { weightsOnDiskMb: vi.fn().mockResolvedValue(17_630) } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, model(0.0667))).resolves.toEqual({ kvMbPerToken: 0.0667, weightMb: 17_630, source: 'catalog' });
  });

  it('answers null when nothing can say, and never throws for a failing probe', async () => {
    await expect(probeContextCost({} as InferenceBackend, model())).resolves.toBeNull();
    const failing = {
      contextCostForModel: vi.fn().mockRejectedValue(new Error('down')),
      weightsOnDiskMb: vi.fn().mockRejectedValue(new Error('down')),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(failing, model())).resolves.toBeNull();
    await expect(probeContextCost(failing, model(0.0667))).resolves.toEqual({ kvMbPerToken: 0.0667, weightMb: null, source: 'catalog' });
  });

  // gemma4:e4b on beta-red: `/api/tags` says 9,163 MiB, and its weights, encoders and runtime hold
  // 4,046 there. The file plus runner overhead (9,931) would raise the row's measured 4,362 back over
  // a 10 GB card's budget.
  it('drops the file size for a model whose catalog footprint was measured, and keeps its KV cost', async () => {
    const measuredRow = { id: 'gemma4-e4b', backendModelId: 'gemma4:e4b', runtime: { footprintMeasured: true } } as unknown as CuratedModel;
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue({ kvMbPerToken: 0.09375, weightMb: 9_163, source: 'geometry' }),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, measuredRow)).resolves.toEqual({ kvMbPerToken: 0.09375, weightMb: null, source: 'geometry' });

    const lemonadeRow = { id: 'q', backendModelId: 'Q-GGUF', runtime: { kvMbPerToken: 0.0667, footprintMeasured: true } } as unknown as CuratedModel;
    const lemonade = { weightsOnDiskMb: vi.fn().mockResolvedValue(17_630) } as unknown as InferenceBackend;
    await expect(probeContextCost(lemonade, lemonadeRow)).resolves.toEqual({ kvMbPerToken: 0.0667, weightMb: null, source: 'catalog' });
    await expect(
      probeContextCost({} as InferenceBackend, { ...measuredRow, runtime: { footprintMeasured: true } } as CuratedModel),
    ).resolves.toBeNull();
  });

  it('ignores a catalog figure that is not a positive number', async () => {
    for (const kv of [0, -1, Number.NaN]) {
      await expect(probeContextCost({} as InferenceBackend, model(kv))).resolves.toBeNull();
    }
  });
});
