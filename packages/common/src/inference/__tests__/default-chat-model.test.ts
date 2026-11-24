import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '../../types/inference.js';
import { defaultChatModelId } from '../default-chat-model.js';

const row = (id: string, modality: CuratedModel['modality'] = 'llm', backend: CuratedModel['backend'] = 'ollama') => ({ id, modality, backend });

// Catalog order, as the onboarding profile lists it for a 128 GB unified-memory AMD machine.
const available = [
  row('gemma4-e2b'),
  row('gemma4-e4b'),
  row('gemma4-12b'),
  row('gemma4-26b'),
  row('qwen3-6-35b'),
  row('minimax-m2-community-230b'),
  row('nomic-embed-text', 'embedding'),
  row('gemma4-26b-lemonade', 'llm', 'lemonade'),
];
// Best first, as `getRecommendedModelsForHardware` ranks them there.
const recommended = [
  row('minimax-m2-community-230b'),
  row('qwen3-6-35b'),
  row('gemma4-26b'),
  row('gemma4-12b'),
  row('gemma4-26b-lemonade', 'llm', 'lemonade'),
  row('nomic-embed-text', 'embedding'),
];
const pick = (candidateIds: string[], extra: Partial<Parameters<typeof defaultChatModelId>[0]> = {}) =>
  defaultChatModelId({ backend: 'ollama', availableModels: available, recommendedModels: recommended, candidateIds, ...extra });

describe('defaultChatModelId', () => {
  it("takes the recommended 4B over the smaller models the engine has, on the issue's 7.5 GB card", () => {
    // The catalog lists each family smallest first, so the first in catalog order was Qwen 3.5 0.8B.
    const laptopAvailable = [row('qwen3-5-0-8b'), row('qwen3-5-4b'), row('qwen3-8b'), row('gemma3-270m'), row('nomic-embed-text', 'embedding')];
    const laptopRecommended = [row('qwen3-5-4b'), row('gemma4-e4b'), row('qwen3-8b'), row('nomic-embed-text', 'embedding')];

    expect(
      defaultChatModelId({
        backend: 'ollama',
        availableModels: laptopAvailable,
        recommendedModels: laptopRecommended,
        candidateIds: ['qwen3-5-0-8b', 'qwen3-5-4b', 'gemma3-270m', 'nomic-embed-text'],
      }),
    ).toBe('qwen3-5-4b');
  });

  it('takes the highest on the recommended list, whatever the order of the candidates or the catalog', () => {
    expect(pick(['gemma4-12b', 'gemma4-26b', 'qwen3-6-35b'])).toBe('qwen3-6-35b');
    expect(pick(['gemma4-26b', 'qwen3-6-35b'])).toBe('qwen3-6-35b');
  });

  it('takes MiniMax M2 over Gemma 4 E4B on 128 GB once the engine has both, since only MiniMax is on the list', () => {
    expect(pick(['gemma4-e4b', 'minimax-m2-community-230b'])).toBe('minimax-m2-community-230b');
    expect(pick(['gemma4-e4b'])).toBe('gemma4-e4b');
  });

  it('takes the first candidate in catalog order when none is on the recommended list', () => {
    expect(pick(['gemma4-e4b', 'gemma4-e2b'])).toBe('gemma4-e2b');
    expect(pick(['gemma4-e4b', 'gemma4-e2b'], { recommendedModels: undefined })).toBe('gemma4-e2b');
  });

  it('skips a model on another engine, an embedder and one the caller rules out', () => {
    expect(pick(['gemma4-26b-lemonade', 'nomic-embed-text', 'gemma4-e4b'])).toBe('gemma4-e4b');
    expect(pick(['gemma4-e4b', 'gemma4-26b', 'qwen3-6-35b'], { accept: (model) => model.id !== 'qwen3-6-35b' })).toBe('gemma4-26b');
    // Every recommended candidate ruled out: the catalog order decides among the rest.
    expect(pick(['gemma4-e4b', 'gemma4-26b', 'gemma4-e2b'], { accept: (model) => model.id !== 'gemma4-26b' })).toBe('gemma4-e2b');
  });

  it('passes over a recommended model the hardware may not run', () => {
    expect(pick(['qwen3-5-397b', 'gemma4-e4b'], { recommendedModels: [row('qwen3-5-397b'), ...recommended] })).toBe('gemma4-e4b');
  });

  it('offers the best recommended model to download when no candidate is a chat model here', () => {
    expect(pick([])).toBe('minimax-m2-community-230b');
    expect(pick(['nomic-embed-text'])).toBe('minimax-m2-community-230b');
    expect(pick([], { recommendedModels: undefined })).toBe('gemma4-e2b');
  });

  it('names nothing outside the candidates with candidatesOnly', () => {
    expect(pick(['nomic-embed-text'], { candidatesOnly: true })).toBeUndefined();
    expect(pick([], { candidatesOnly: true })).toBeUndefined();
    expect(pick(['gemma4-e2b', 'gemma4-12b'], { candidatesOnly: true })).toBe('gemma4-12b');
  });
});
