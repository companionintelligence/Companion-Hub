import { describe, expect, it, vi } from 'vitest';
import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';
import type { InferenceBackend } from '../backends/backend.interface';
import {
  GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES,
  kvSequencesFor,
  OLLAMA_SINGLE_SLOT_ARCHITECTURES,
  probeContextCost,
  probeLocalSizing,
} from '../context-cost.util';

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
  // llama3.1:8b's geometry: 32 layers × 8 KV heads × 256 × 2 B = 0.125 MB per token, every layer global.
  const llama = { kvMbPerToken: 0.125, weightMb: 4_693, source: 'geometry' as const, architecture: 'llama' };
  const gemma4 = { kvMbPerToken: 0.09375, weightMb: 9_163, source: 'geometry' as const, architecture: 'gemma4' };

  it("multiplies an Ollama model's KV by the slots this node states — four on core-2, beta-max and beta-red", () => {
    expect(kvSequencesFor('ollama', llama, 4)).toBe(4);
    expect(kvSequencesFor('ollama', null, 2)).toBe(2);
  });

  it('is one when nothing states the slots, as before', () => {
    for (const stated of [null, undefined, 0, 'four', 65]) {
      expect(kvSequencesFor('ollama', llama, stated)).toBe(1);
    }
  });

  it('is one for a family Ollama 0.34 runs on a single slot whatever OLLAMA_NUM_PARALLEL says (qwen3.8:27b is qwen35)', () => {
    expect(kvSequencesFor('ollama', { ...llama, architecture: 'qwen35' }, 4)).toBe(1);
    expect(OLLAMA_SINGLE_SLOT_ARCHITECTURES.has('gemma4')).toBe(false);
  });

  // core-2, 2026-09-29: gemma4:e4b at 65536 on OLLAMA_NUM_PARALLEL=4 is 3,437,095,812 bytes by /api/ps,
  // weights included, and beta-red holds it at 16384 on four slots in 3,364,754,553. The geometry
  // charges ONE slot 6,144 MB of KV at 65536; times four it cut beta-1's handout from 65536 to 16384.
  it("is one for gemma4's geometry, which already charges one slot more than every slot holds", () => {
    expect(GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES.has('gemma4')).toBe(true);
    expect(kvSequencesFor('ollama', gemma4, 4)).toBe(1);
    // Only the geometry is known to over-state: a cost from elsewhere keeps the multiplication.
    expect(kvSequencesFor('ollama', { ...gemma4, source: 'catalog' }, 4)).toBe(4);
    // gemma3 has not been measured on the fleet, so it keeps the conservative arithmetic.
    expect(kvSequencesFor('ollama', { ...gemma4, architecture: 'gemma3' }, 4)).toBe(4);
  });

  it('is one for a cost calibrated from a sighting, which already spans every slot', () => {
    expect(kvSequencesFor('ollama', { ...llama, source: 'calibrated' }, 4)).toBe(1);
  });

  it('is one for Lemonade, whose one ctx_size is the whole server', () => {
    expect(kvSequencesFor('lemonade', llama, 4)).toBe(1);
  });
});

describe('probeLocalSizing', () => {
  const profile = {} as HardwareProfile;
  const llama = { id: 'llama3-1-8b', backendModelId: 'llama3.1:8b', runtime: {} } as unknown as CuratedModel;
  const cost = { kvMbPerToken: 0.125, weightMb: 4_693, source: 'geometry' as const, architecture: 'llama' };

  it("reads the cost, the operator's slots for Ollama and the sighting, the three things the load path reads", async () => {
    const sighting = { footprintMb: 7_120, contextLength: 16_384, source: 'process' as const };
    const sightings = { footprintSighting: vi.fn().mockResolvedValue(sighting) };
    const backend = { contextCostForModel: vi.fn().mockResolvedValue(cost) } as unknown as InferenceBackend;

    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: llama, profile, statedOllamaSlots: 4, sightings })).resolves.toEqual({
      kvMbPerToken: 0.125,
      weightMb: 4_693,
      kvSlots: 4,
      sighting,
    });
    expect(sightings.footprintSighting).toHaveBeenCalledWith(profile, 'ollama', 'llama3.1:8b');
  });

  it("believes the engine's own slot count over the operator's", async () => {
    const backend = {
      contextCostForModel: vi.fn().mockResolvedValue(cost),
      engineCapabilities: () => ({ slots: 2, contextLength: null }),
    } as unknown as InferenceBackend;
    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: llama, profile, statedOllamaSlots: 4 })).resolves.toMatchObject({
      kvSlots: 2,
      sighting: null,
    });
  });

  it('costs only the sighting when it cannot be read', async () => {
    const backend = { contextCostForModel: vi.fn().mockResolvedValue(cost) } as unknown as InferenceBackend;
    const sightings = { footprintSighting: vi.fn().mockRejectedValue(new Error('sampler down')) };
    await expect(probeLocalSizing({ backendType: 'ollama', backend, model: llama, profile, statedOllamaSlots: null, sightings })).resolves.toEqual({
      kvMbPerToken: 0.125,
      weightMb: 4_693,
      kvSlots: 1,
      sighting: null,
    });
  });
});
