import type { CuratedModel } from '@ci-hub/common/types';
import { describe, expect, it } from 'vitest';
import { computeSelectionBudget, isSelectionWithinBudget } from '../onboarding-model-selection';

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
    const result = computeSelectionBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024, 4096);

    expect(result.downloadDiskMb).toBe(0);
    expect(result.newMemoryMb).toBe(0);
    expect(result.installedMemoryMb).toBe(20192);
    expect(result.overDisk).toBe(false);
    expect(result.overMemory).toBe(false);
    expect(result.memoryNote).toContain('already in Ollama');
    expect(isSelectionWithinBudget(selected, ['phi-4-mini', 'qwen-coder'], 1024, 4096)).toBe(true);
  });

  it('warns on memory for new downloads without blocking install', () => {
    const selected = [makeModel('phi-4-mini', 2048, 6000), makeModel('qwen-coder', 4096, 7000)];
    const result = computeSelectionBudget(selected, ['phi-4-mini'], 50000, 5000);

    expect(result.downloadDiskMb).toBe(4096);
    expect(result.newMemoryMb).toBe(7000);
    expect(result.installedMemoryMb).toBe(6000);
    expect(result.overDisk).toBe(false);
    expect(result.overMemory).toBe(true);
    expect(result.memoryWarning).toContain('You can continue');
    expect(isSelectionWithinBudget(selected, ['phi-4-mini'], 50000, 5000)).toBe(true);
  });

  it('excludes installed models from disk download budget', () => {
    const selected = [makeModel('phi-4-mini', 2048, 2048)];
    const result = computeSelectionBudget(selected, ['phi-4-mini'], 1024, 24000);

    expect(result.downloadDiskMb).toBe(0);
    expect(result.overDisk).toBe(false);
  });
});
