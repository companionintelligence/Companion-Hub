import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '../../types/inference.js';
import { defaultChatModelId } from '../default-chat-model.js';

const row = (id: string, modality: CuratedModel['modality'] = 'llm', backend: CuratedModel['backend'] = 'ollama') => ({ id, modality, backend });

// Catalog order, as the onboarding profile lists it for a 128 GB unified-memory AMD machine.
const available = [
  row('gemma4-e2b'),
  row('gemma4-e4b'),
  row('gemma4-26b'),
  row('qwen3-6-35b'),
  row('minimax-m2-community-230b'),
  row('nomic-embed-text', 'embedding'),
  row('gemma4-e4b-lemonade', 'llm', 'lemonade'),
];
// Best first, as `getRecommendedModelsForHardware` ranks them there.
const recommended = [row('minimax-m2-community-230b'), row('qwen3-6-35b'), row('gemma4-26b')];

describe('defaultChatModelId', () => {
  it('takes the first chat model the engine has in catalog order, not the top recommendation', () => {
    const installed = ['nomic-embed-text', 'gemma4-e4b', 'qwen3-6-35b', 'minimax-m2-community-230b'];

    expect(defaultChatModelId({ backend: 'ollama', availableModels: available, recommendedModels: recommended, candidateIds: installed })).toBe(
      'gemma4-e4b',
    );
  });

  it('follows the order it is given, which is what is ticked in the wizard', () => {
    expect(defaultChatModelId({ backend: 'ollama', availableModels: available, candidateIds: ['qwen3-6-35b', 'gemma4-e4b'] })).toBe('qwen3-6-35b');
  });

  it('skips a model on another engine, an embedder and one the caller rules out', () => {
    expect(
      defaultChatModelId({
        backend: 'ollama',
        availableModels: available,
        candidateIds: ['gemma4-e4b-lemonade', 'nomic-embed-text', 'gemma4-e4b', 'gemma4-26b'],
        accept: (model) => model.id !== 'gemma4-e4b',
      }),
    ).toBe('gemma4-26b');
  });

  it('offers the best recommended model to download when the engine has none', () => {
    expect(defaultChatModelId({ backend: 'ollama', availableModels: available, recommendedModels: recommended, candidateIds: [] })).toBe(
      'minimax-m2-community-230b',
    );
    expect(defaultChatModelId({ backend: 'ollama', availableModels: available, candidateIds: [] })).toBe('gemma4-e2b');
  });

  it('names nothing to download for a handout', () => {
    expect(
      defaultChatModelId({
        backend: 'ollama',
        availableModels: available,
        recommendedModels: recommended,
        candidateIds: ['nomic-embed-text'],
        installedOnly: true,
      }),
    ).toBeUndefined();
  });
});
