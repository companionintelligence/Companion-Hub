import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { BackendHealthStatus, CuratedModel, ResidencyReport, TrackedModel } from '@ci-hub/common/types';
import { LoggerService } from '@/core/logger/logger.service';
import { InferenceController } from '../inference.controller';
import { ModelRegistryService } from '../model-registry.service';
import { ModelResidencyService } from '../model-residency.service';
import { reconcileTrackedWithResidency, trackedPullsNotListed } from '../tracked-residency';

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

describe('trackedPullsNotListed', () => {
  const qwen = model('qwen3-5-4b', 'ollama', 'qwen3.5:4b');
  const nomic = model('nomic-embed-text', 'ollama', 'nomic-embed-text');
  const ollamaCatalog = [qwen, nomic, chat];
  const onOllama = (catalogId: string, state: TrackedModel['state']): TrackedModel => ({ ...tracked(catalogId, state), backend: 'ollama' });

  it('names a model tracked as pulled that the inventory no longer lists, matching tags the way the handout does', () => {
    expect(
      trackedPullsNotListed({
        catalog: ollamaCatalog,
        tracked: [onOllama(qwen.id, 'pulled'), onOllama(nomic.id, 'pulled')],
        backend: 'ollama',
        inventory: ['nomic-embed-text:latest'],
      }),
    ).toEqual([qwen.id]);
  });

  it("leaves a download in progress, the operator's pin, and another engine's model alone", () => {
    expect(
      trackedPullsNotListed({
        catalog: ollamaCatalog,
        tracked: [onOllama(qwen.id, 'pulling'), onOllama(nomic.id, 'pinned'), tracked(chat.id, 'pulled')],
        backend: 'ollama',
        inventory: [],
      }),
    ).toEqual([]);
  });
});

describe('GET /api/inference/models/tracked', () => {
  /**
   * The route over the real registry, with nothing in memory on any engine, and `ollamaHealth` as
   * Ollama's answer (it gets the registry, to change it mid-request).
   */
  function route(ollamaHealth: (registry: ModelRegistryService) => Promise<BackendHealthStatus>) {
    const registry = new ModelRegistryService(mock<LoggerService>());
    const residency = mock<ModelResidencyService>();
    residency.getReport.mockResolvedValue(report([{ backend: 'ollama', source: 'measured', models: [] }]));
    const controller = Object.assign(Object.create(InferenceController.prototype), {
      residency,
      modelRegistry: registry,
      ollamaBackend: { healthCheck: () => ollamaHealth(registry) },
    }) as InferenceController;
    return { registry, controller };
  }

  // The models page lists the registry. A model removed with `ollama rm` stayed on it as `pulled`
  // until the Hub restarted, which is also how long apps went on being handed it.
  it('drops a model the Hub pulled once Ollama no longer lists it', async () => {
    const { registry, controller } = route(async () => ({ running: true, healthy: true, modelsLoaded: ['nomic-embed-text:latest'] }));
    registry.trackModel('qwen3-5-4b', 'pulled');
    registry.trackModel('nomic-embed-text', 'pulled');

    const listed = await controller.getTrackedModels();

    expect(listed.map((entry) => entry.catalogId)).toEqual(['nomic-embed-text']);
  });

  it('keeps every entry while Ollama cannot be asked', async () => {
    const { registry, controller } = route(async () => ({ running: false, healthy: false, modelsLoaded: [] }));
    registry.trackModel('qwen3-5-4b', 'pulled');

    const listed = await controller.getTrackedModels();

    expect(listed.map((entry) => entry.catalogId)).toEqual(['qwen3-5-4b']);
  });

  // Settings > AI polls this route while it waits for a download. Ollama's list here was read
  // before the file landed; dropping the entry the pull then marks `pulled` would leave that wait
  // with nothing to see until it timed out.
  it('keeps a model whose download finished while Ollama was answering', async () => {
    const { registry, controller } = route(async (registryNow) => {
      registryNow.updateModelState('qwen3-5-4b', 'pulled');
      return { running: true, healthy: true, modelsLoaded: [] };
    });
    registry.trackModel('qwen3-5-4b', 'pulling');

    const listed = await controller.getTrackedModels();

    expect(listed).toEqual([expect.objectContaining({ catalogId: 'qwen3-5-4b', state: 'pulled' })]);
  });

  it('keeps a model downloaded again while Ollama was answering', async () => {
    const { registry, controller } = route(async (registryNow) => {
      registryNow.trackModel('qwen3-5-4b', 'pulling');
      registryNow.updateModelState('qwen3-5-4b', 'pulled');
      return { running: true, healthy: true, modelsLoaded: [] };
    });
    registry.trackModel('qwen3-5-4b', 'pulled');

    const listed = await controller.getTrackedModels();

    expect(listed).toEqual([expect.objectContaining({ catalogId: 'qwen3-5-4b', state: 'pulled' })]);
  });
});
