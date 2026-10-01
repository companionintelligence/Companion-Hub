import { describe, expect, it } from 'vitest';
import type { CuratedModel, ResidencyReport, TrackedModel } from '@ci-hub/common/types';
import { reconcileTrackedWithResidency } from '../tracked-residency';

const model = (id: string, backend: CuratedModel['backend'], backendModelId: string): CuratedModel =>
  ({ id, backend, backendModelId, modality: 'llm' }) as CuratedModel;
const tracked = (catalogId: string, state: TrackedModel['state']): TrackedModel =>
  ({ catalogId, state, backend: 'lemonade', backendModelId: catalogId, pinned: state === 'pinned' }) as TrackedModel;
const report = (backends: ResidencyReport['backends']): ResidencyReport => ({ backends, residentCount: 0, sampledAt: 'now' });

const chat = model('qwen3-8-27b-lemonade', 'lemonade', 'Qwen3.8-27B-GGUF');
const embedder = model('nomic-embed-text-v1-5-lemonade', 'lemonade', 'nomic-embed-text-v1.5-GGUF');
const ollamaChat = model('hermes4-70b', 'ollama', 'hermes4:70b');
const catalog = [chat, embedder, ollamaChat];

describe('reconcileTrackedWithResidency', () => {
  it('adopts models the engine loaded on its own as loaded, under either spelling Lemonade lists', () => {
    // A Hub restarted after Lemonade's boot auto-load: nothing tracked, two models resident.
    const residency = report([
      { backend: 'lemonade', source: 'engine', models: [{ id: 'Qwen3.8-27B-GGUF' }, { id: 'user.nomic-embed-text-v1.5-GGUF' }] } as never,
    ]);

    expect(reconcileTrackedWithResidency({ catalog, tracked: [], residency })).toEqual([
      { catalogId: chat.id, state: 'loaded' },
      { catalogId: embedder.id, state: 'loaded' },
    ]);
  });

  it('moves a model the Hub thought loaded back to pulled once the engine no longer holds it', () => {
    const residency = report([{ backend: 'lemonade', source: 'engine', models: [{ id: 'Qwen3.8-27B-GGUF' }] } as never]);

    expect(reconcileTrackedWithResidency({ catalog, tracked: [tracked(chat.id, 'loaded'), tracked(embedder.id, 'loaded')], residency })).toEqual([
      { catalogId: embedder.id, state: 'pulled' },
    ]);
  });

  it("leaves the Hub's own work in progress alone, and says nothing for an engine that could not answer", () => {
    const residency = report([
      { backend: 'lemonade', source: 'engine', models: [] } as never,
      { backend: 'ollama', source: 'unreachable', models: null } as never,
    ]);

    expect(
      reconcileTrackedWithResidency({
        catalog,
        tracked: [tracked(chat.id, 'pinned'), tracked(embedder.id, 'loading'), { ...tracked(ollamaChat.id, 'loaded'), backend: 'ollama' }],
        residency,
      }),
    ).toEqual([]);
  });

  it('is a no-op when the registry already agrees with the engines', () => {
    const residency = report([{ backend: 'lemonade', source: 'engine', models: [{ id: 'Qwen3.8-27B-GGUF' }] } as never]);

    expect(reconcileTrackedWithResidency({ catalog, tracked: [tracked(chat.id, 'loaded'), tracked(embedder.id, 'pulled')], residency })).toEqual([]);
  });
});
