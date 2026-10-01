import type { CuratedModel } from '@ci-hub/common/types';
import { describe, expect, it } from 'vitest';
import { computeSelectionBudget, inferenceMemoryMb, isSelectionWithinBudget } from '../onboarding-model-selection';

const makeModel = (id: string, diskMb: number, memoryFootprintMb: number): CuratedModel =>
  ({
    id,
    backend: 'ollama',
    backendModelId: id,
    modality: 'llm',
    purpose: 'general',
    displayName: id,
    description: id,
    requirements: { diskMb, minVramMb: 0, recommendedVramMb: 0, minRamMb: 0, gpuVendors: ['cpu'], npuRequired: false, minTier: 'low' },
    runtime: { contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'], pinnedByDefault: false, memoryFootprintMb },
    tiers: { high: 'available', medium: 'available', low: 'available', cpuOnly: 'available' },
  }) as CuratedModel;

describe('computeSelectionBudget', () => {
  it('does not block when only already-installed models are selected', () => {
    const selected = [makeModel('phi-4-mini', 2048, 8192), makeModel('qwen-coder', 4096, 12000)];
    const result = computeSelectionBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024);

    expect(result.downloadDiskMb).toBe(0);
    expect(result.newMemoryMb).toBe(0);
    expect(result.installedMemoryMb).toBe(20192);
    expect(result.overDisk).toBe(false);
    expect(result.memoryNote).toContain('already in Ollama');
    // The note names the engine that was selected, not Ollama regardless.
    expect(computeSelectionBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024, 'Lemonade').memoryNote).toContain('already in Lemonade');
    expect(isSelectionWithinBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024)).toBe(true);
  });

  it('judges a selection by disk alone: a model larger than the free inference memory is still installable', () => {
    // Downloading touches no GPU, and loading is the router's fit-or-evict decision, not the picker's.
    const selected = [makeModel('phi-4-mini', 2048, 6000), makeModel('qwen-coder', 4096, 7000)];
    const result = computeSelectionBudget(selected, ['phi-4-mini'], 50000);

    expect(result.downloadDiskMb).toBe(4096);
    expect(result.newMemoryMb).toBe(7000);
    expect(result.installedMemoryMb).toBe(6000);
    expect(result.overDisk).toBe(false);
    expect(result).not.toHaveProperty('memoryWarning');
    expect(isSelectionWithinBudget(selected, ['phi-4-mini'], 50000)).toBe(true);
  });

  it('excludes installed models from disk download budget', () => {
    const selected = [makeModel('phi-4-mini', 2048, 2048)];
    const result = computeSelectionBudget(selected, ['phi-4-mini'], 1024);

    expect(result.downloadDiskMb).toBe(0);
    expect(result.overDisk).toBe(false);
  });
});

describe('inferenceMemoryMb', () => {
  it('reads the VRAM budget on a discrete GPU and the RAM budget otherwise, with free capped to it', () => {
    const budget = { modelBudgetVramMb: 23_500, modelBudgetRamMb: 60_000 };

    expect(
      inferenceMemoryMb({
        hardware: { gpu: { available: true, unifiedMemory: false } },
        memoryBudget: budget,
        resourceEstimate: { availableMemoryMb: 3_200 },
      }),
    ).toEqual({
      totalMb: 23_500,
      freeMb: 3_200,
    });
    expect(
      inferenceMemoryMb({
        hardware: { gpu: { available: true, unifiedMemory: true } },
        memoryBudget: budget,
        resourceEstimate: { availableMemoryMb: 70_000 },
      }),
    ).toEqual({
      totalMb: 60_000,
      freeMb: 60_000,
    });
    expect(
      inferenceMemoryMb({
        hardware: { gpu: { available: false, unifiedMemory: false } },
        memoryBudget: budget,
        resourceEstimate: { availableMemoryMb: -5 },
      }),
    ).toEqual({
      totalMb: 60_000,
      freeMb: 0,
    });
  });
});
