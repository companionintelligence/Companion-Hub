import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { pickUtilityModel } from '../utility-handout';

const model = (id: string, recommendedVramMb: number, extra: Partial<CuratedModel> = {}): CuratedModel =>
  ({
    id,
    backend: 'lemonade',
    backendModelId: `${id}-GGUF`,
    modality: 'llm',
    requirements: { minVramMb: recommendedVramMb, recommendedVramMb, minRamMb: 0, diskMb: 0 },
    ...extra,
  }) as unknown as CuratedModel;

const chat27b = model('qwen3-8-27b', 18_000);
const qwen8b = model('qwen3-8b', 6_000);
const gemma4b = model('gemma-4-e4b', 3_500);
const embedder = model('nomic', 300, { modality: 'embedding' as CuratedModel['modality'] });

describe('pickUtilityModel', () => {
  it('picks the smallest installed chat model that fits beside the chat model', () => {
    // 24 GB card: 18 000 + 3 500 + the 2 GB reserve fits; the 8B would too, but the 4B is smaller.
    expect(
      pickUtilityModel({ chat: chat27b, installed: [chat27b, qwen8b, gemma4b, embedder], profile: { effectiveInferenceMemoryMb: 24_576 } }),
    ).toBe(gemma4b);
  });

  it('answers the chat model itself when nothing smaller fits beside it, or nothing smaller is installed', () => {
    // 20 GB: 18 000 + 3 500 + reserve is over.
    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, gemma4b], profile: { effectiveInferenceMemoryMb: 20_480 } })).toBe(chat27b);
    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(chat27b);
    // A small chat model has nothing smaller to hand off to.
    expect(pickUtilityModel({ chat: gemma4b, installed: [gemma4b, qwen8b, chat27b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(gemma4b);
  });

  it('never picks an embedder, a model on another engine, or one that is only in the catalog', () => {
    const ollama8b = model('qwen3-8b-ollama', 6_000, { backend: 'ollama' });

    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, embedder, ollama8b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(
      chat27b,
    );
    expect(pickUtilityModel({ chat: chat27b, installed: [], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(chat27b);
  });

  it('has no answer without a chat model', () => {
    expect(pickUtilityModel({ chat: undefined, installed: [gemma4b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBeUndefined();
  });
});
