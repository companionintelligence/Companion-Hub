import { describe, expect, it, vi } from 'vitest';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';
import type { InferenceBackend } from '../backends/backend.interface';
import { kvSequencesFor, OLLAMA_SINGLE_SLOT_ARCHITECTURES, probeContextCost, probeLocalSizing } from '../context-cost.util';

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

  it('ignores a catalog figure that is not a positive number', async () => {
    for (const kv of [0, -1, Number.NaN]) {
      await expect(probeContextCost({} as InferenceBackend, model(kv))).resolves.toBeNull();
    }
  });

  it("keeps the engine's architecture when the catalog's figure wins, so the slot rule still sees the family", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue({ kvMbPerToken: 0.0664, weightMb: 16_920, source: 'geometry', architecture: 'qwen35' }),
    } as unknown as InferenceBackend;
    await expect(probeContextCost(backend, model(0.0625))).resolves.toEqual({
      kvMbPerToken: 0.0625,
      weightMb: 16_920,
      source: 'catalog',
      architecture: 'qwen35',
    });
  });
});

describe('kvSequencesFor', () => {
  const gemma4 = { kvMbPerToken: 0.09375, weightMb: 9_163, source: 'geometry' as const, architecture: 'gemma4' };

  it("multiplies an Ollama model's KV by the slots this node states — four on core-2, beta-max and beta-red", () => {
    expect(kvSequencesFor('ollama', gemma4, 4)).toBe(4);
    expect(kvSequencesFor('ollama', null, 2)).toBe(2);
  });

  it('is one when nothing states the slots, as before', () => {
    for (const stated of [null, undefined, 0, 'four', 65]) {
      expect(kvSequencesFor('ollama', gemma4, stated)).toBe(1);
    }
  });

  it('is one for a family Ollama 0.34 runs on a single slot whatever OLLAMA_NUM_PARALLEL says (qwen3.8:27b is qwen35)', () => {
    expect(kvSequencesFor('ollama', { ...gemma4, architecture: 'qwen35' }, 4)).toBe(1);
    expect(OLLAMA_SINGLE_SLOT_ARCHITECTURES.has('gemma4')).toBe(false);
  });

  it('is one for a cost calibrated from a sighting, which already spans every slot', () => {
    expect(kvSequencesFor('ollama', { ...gemma4, source: 'calibrated' }, 4)).toBe(1);
  });

  it('is one for Lemonade, whose one ctx_size is the whole server', () => {
    expect(kvSequencesFor('lemonade', gemma4, 4)).toBe(1);
  });
});

describe('probeLocalSizing', () => {
  const profile = {} as HardwareProfile;
  const gemma = { id: 'gemma4-e4b', backendModelId: 'gemma4:e4b', runtime: {} } as unknown as CuratedModel;
  const cost = { kvMbPerToken: 0.09375, weightMb: 9_163, source: 'geometry' as const, architecture: 'gemma4' };

  it("reads the cost, the operator's slots for Ollama and the sighting, the three things the load path reads", async () => {
    const sighting = { footprintMb: 5_550, contextLength: 16_384, source: 'process' as const };
    const sightings = { footprintSighting: vi.fn().mockResolvedValue(sighting) };
    const backend = { contextCostForModel: vi.fn().mockResolvedValue(cost) } as unknown as InferenceBackend;

    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: gemma, profile, statedOllamaSlots: 4, sightings })).resolves.toEqual({
      kvMbPerToken: 0.09375,
      weightMb: 9_163,
      kvSlots: 4,
      sighting,
    });
    expect(sightings.footprintSighting).toHaveBeenCalledWith(profile, 'ollama', 'gemma4:e4b');
  });

  it("believes the engine's own slot count over the operator's", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue(cost),
      engineCapabilities: () => ({ slots: 2, contextLength: null }),
    } as unknown as InferenceBackend;
    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: gemma, profile, statedOllamaSlots: 4 })).resolves.toMatchObject({
      kvSlots: 2,
      sighting: null,
    });
  });

  it('costs only the sighting when it cannot be read', async () => {
    const backend = { contextCostForModel: vi.fn().mockResolvedValue(cost) } as unknown as InferenceBackend;
    const sightings = { footprintSighting: vi.fn().mockRejectedValue(new Error('sampler down')) };
    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: gemma, profile, statedOllamaSlots: null, sightings })).resolves.toEqual({
      kvMbPerToken: 0.09375,
      weightMb: 9_163,
      kvSlots: 1,
      sighting: null,
    });
  });
});
