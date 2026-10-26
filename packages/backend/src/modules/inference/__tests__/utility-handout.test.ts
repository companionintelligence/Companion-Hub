import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { CURATED_MODELS } from '../catalog/curated-models';
import { pickUtilityModel } from '../utility-handout';

const model = (id: string, recommendedVramMb: number, parameterScale: number | undefined, extra: Partial<CuratedModel> = {}): CuratedModel =>
  ({
    id,
    backend: 'lemonade',
    backendModelId: `${id}-GGUF`,
    modality: 'llm',
    parameterScale,
    requirements: { minVramMb: recommendedVramMb, recommendedVramMb, minRamMb: 0, diskMb: 0 },
    ...extra,
  }) as unknown as CuratedModel;

const chat27b = model('qwen3-8-27b', 18_000, 27);
const qwen8b = model('qwen3-8b', 6_000, 8);
const gemma4b = model('gemma-4-e4b', 3_500, 4);
const embedder = model('nomic', 300, undefined, { modality: 'embedding' as CuratedModel['modality'] });

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
    const ollama8b = model('qwen3-8b-ollama', 6_000, 8, { backend: 'ollama' });

    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, embedder, ollama8b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(
      chat27b,
    );
    expect(pickUtilityModel({ chat: chat27b, installed: [], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(chat27b);
  });

  it('never hands background work to a model below the size floor, however well it fits', () => {
    // core-7: gemma3:270m beside qwen3.6:35b copied the example out of Memory's prompt into the owner's memory.
    const chat35b = model('qwen3-6-35b', 23_000, 35);
    const gemma270m = model('gemma3-270m', 300, 0.27);
    const gemma1b = model('gemma3-1b', 800, 1);
    const profile = { effectiveInferenceMemoryMb: 90_148 };

    expect(pickUtilityModel({ chat: chat35b, installed: [chat35b, gemma270m, gemma1b], profile })).toBe(chat35b);
    // A model that clears the floor is still preferred to the chat model. The smallest of those wins.
    expect(pickUtilityModel({ chat: chat35b, installed: [chat35b, gemma270m, gemma1b, qwen8b, gemma4b], profile })).toBe(gemma4b);
  });

  it('takes a model right at the floor and nothing under it', () => {
    const at3b = model('llama3-2-3b', 3_100, 3);
    const at2b = model('gemma4-e2b', 2_500, 2);

    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, at2b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(chat27b);
    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, at2b, at3b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(at3b);
  });

  it('passes over the real catalog rows of the models that caused this', () => {
    const byId = (id: string) => {
      const found = CURATED_MODELS.find((m) => m.id === id);
      if (!found) throw new Error(`catalog has no ${id}`);
      return found;
    };
    const chat = byId('qwen3-6-35b');
    const installed = ['qwen3-6-35b', 'gemma3-270m', 'gemma3-1b', 'gemma4-e2b'].map(byId);
    const profile = { effectiveInferenceMemoryMb: 90_148 };

    expect(pickUtilityModel({ chat, installed, profile })).toBe(chat);
    expect(pickUtilityModel({ chat, installed: [...installed, byId('gemma4-e4b')], profile })?.id).toBe('gemma4-e4b');
  });

  it('never picks a model the catalog gives no size', () => {
    const unsized = model('unsized', 2_000, undefined);

    expect(pickUtilityModel({ chat: chat27b, installed: [chat27b, unsized], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBe(chat27b);
  });

  it('has no answer without a chat model', () => {
    expect(pickUtilityModel({ chat: undefined, installed: [gemma4b], profile: { effectiveInferenceMemoryMb: 65_536 } })).toBeUndefined();
  });
});
