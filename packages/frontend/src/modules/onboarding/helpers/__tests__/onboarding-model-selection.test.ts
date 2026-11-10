import type { CuratedModel } from '@ci-hub/common/types';
import { describe, expect, it } from 'vitest';
import { computeSelectionBudget, inferenceMemoryMb, isSelectionWithinBudget } from '../onboarding-model-selection';

const makeModel = (
  id: string,
  diskMb: number,
  memoryFootprintMb: number,
  backend: CuratedModel['backend'] = 'ollama',
  modality: CuratedModel['modality'] = 'llm',
): CuratedModel =>
  ({
    id,
    backend,
    backendModelId: id,
    modality,
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
    expect(result.memoryNote).toBe('2 selected models are already in Ollama. Nothing new to download.');
    // The note names the models' engine, not Ollama regardless.
    const onLemonade = [makeModel('qwen3-4b-lemonade', 2048, 4096, 'lemonade')];
    expect(computeSelectionBudget(onLemonade, ['qwen3-4b-lemonade'], 1024).memoryNote).toBe(
      'This model is already in Lemonade. Nothing new to download.',
    );
    expect(isSelectionWithinBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024)).toBe(true);
  });

  it("names each model's own engine: with vLLM selected the embedders are Ollama's", () => {
    // The Hub lists Ollama's installed embedders with vLLM's and oMLX's models, since embeddings stay on Ollama.
    const nomic = makeModel('nomic-embed-text', 274, 500, 'ollama', 'embedding');
    const gemma = makeModel('embeddinggemma', 622, 700, 'ollama', 'embedding');
    const qwen = makeModel('qwen3-8b-vllm', 16000, 18000, 'vllm');

    expect(computeSelectionBudget([nomic], ['nomic-embed-text'], 1024).memoryNote).toBe('This model is already in Ollama. Nothing new to download.');
    expect(computeSelectionBudget([qwen, nomic], ['qwen3-8b-vllm', 'nomic-embed-text'], 1024).memoryNote).toBe(
      '2 selected models are already in vLLM and Ollama. Nothing new to download.',
    );
    expect(computeSelectionBudget([nomic, gemma], ['nomic-embed-text'], 50000).memoryNote).toBe(
      'One selected model (500 MB runtime footprint) is already in Ollama and will not be downloaded again.',
    );
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
    // A card the Hub could not size (VRAM Unknown) is budgeted on RAM, as the Hub budgets its loads.
    expect(
      inferenceMemoryMb({
        hardware: { gpu: { available: true, unifiedMemory: false, vramMb: 0 } },
        memoryBudget: { modelBudgetVramMb: 0, modelBudgetRamMb: 60_000 },
        resourceEstimate: { availableMemoryMb: 31_000 },
      }),
    ).toEqual({
      totalMb: 60_000,
      freeMb: 31_000,
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
