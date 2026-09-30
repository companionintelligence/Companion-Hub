import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { HardwareProfile } from '@ci-hub/common/types';
import type { LoggerService } from '@/core/logger/logger.service';
import { LemonadeBackend } from '../backends/lemonade.backend';
import { embedderEngineId, embeddingBackendFor, LEMONADE_V1_EMBEDDER_ID, pickEmbeddingModel } from '../embedder-handout';
import { ModelRegistryService } from '../model-registry.service';

const profile = {
  gpu: { available: true, vendor: 'amd', model: 'x', vramMb: 0, unifiedMemory: true, driverVersion: '1', runtimeAvailable: true },
  npu: { available: false, model: '' },
  ram: { totalMb: 131072, availableMb: 120000 },
  cpu: { arch: 'x86_64', cores: 16, model: 'x' },
  effectiveInferenceMemoryMb: 131072,
  tier: 'high',
} as HardwareProfile;

// The real catalog: these rows are what ships.
const registry = new ModelRegistryService(mock<LoggerService>());

describe('embeddingBackendFor', () => {
  it('embeds on the decoder itself, on a healthy Ollama next to vLLM or Lemonade, and on Lemonade alone', () => {
    expect(embeddingBackendFor('ollama', false)).toBe('ollama');
    expect(embeddingBackendFor('omlx', true)).toBe('omlx');
    expect(embeddingBackendFor('lemonade', true)).toBe('ollama');
    expect(embeddingBackendFor('vllm', true)).toBe('ollama');
    expect(embeddingBackendFor('lemonade', false)).toBe('lemonade');
    expect(embeddingBackendFor('vllm', false)).toBeNull();
  });
});

describe('pickEmbeddingModel', () => {
  it('recommends v1.5 to a Lemonade host that has no embedder yet', () => {
    expect(pickEmbeddingModel(registry, { backend: 'lemonade', profile, served: [] })?.backendModelId).toBe('nomic-embed-text-v1.5-GGUF');
  });

  it('keeps a Lemonade host that has only v1 on v1, whose vectors its index already holds', () => {
    const picked = pickEmbeddingModel(registry, { backend: 'lemonade', profile, served: ['Qwen3-8B-GGUF', 'nomic-embed-text-v1-GGUF'] });

    expect(picked?.id).toBe(LEMONADE_V1_EMBEDDER_ID);
  });

  it('moves to v1.5 once the host has it, in either spelling', () => {
    for (const served of [
      ['nomic-embed-text-v1-GGUF', 'user.nomic-embed-text-v1.5-GGUF'],
      ['nomic-embed-text-v1-GGUF', 'nomic-embed-text-v1.5-GGUF'],
    ]) {
      expect(pickEmbeddingModel(registry, { backend: 'lemonade', profile, served })?.backendModelId).toBe('nomic-embed-text-v1.5-GGUF');
    }
  });

  it("honours the operator's preference on the engine that embeds, and ignores one for another engine", () => {
    expect(pickEmbeddingModel(registry, { backend: 'ollama', preferredId: 'embeddinggemma', profile, served: [] })?.id).toBe('embeddinggemma');
    expect(pickEmbeddingModel(registry, { backend: 'ollama', preferredId: 'nomic-embed-text-v1-5-lemonade', profile, served: [] })?.id).toBe(
      'nomic-embed-text',
    );
  });
});

describe('embedderEngineId', () => {
  const v15 = registry.getCuratedModel('nomic-embed-text-v1-5-lemonade');
  const ollamaNomic = registry.getCuratedModel('nomic-embed-text');

  it('hands out the spelling Lemonade lists, then its own name for it, then the catalog id', () => {
    expect(v15 && embedderEngineId(v15, ['user.nomic-embed-text-v1.5-GGUF'])).toBe('user.nomic-embed-text-v1.5-GGUF');
    // Nothing listed yet: a real LemonadeBackend names it by its registration name.
    expect(v15 && embedderEngineId(v15, [], new LemonadeBackend(mock<LoggerService>()))).toBe('user.nomic-embed-text-v1.5-GGUF');
    expect(v15 && embedderEngineId(v15, [])).toBe('nomic-embed-text-v1.5-GGUF');
  });

  it("keeps Ollama's catalog id, never the :latest tag Ollama lists", () => {
    expect(ollamaNomic && embedderEngineId(ollamaNomic, ['nomic-embed-text:latest'])).toBe('nomic-embed-text');
  });
});
