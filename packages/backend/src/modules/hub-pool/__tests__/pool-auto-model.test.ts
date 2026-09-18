/**
 * What `auto` stands for on a pooled route — the ranking itself, without a proxy around it.
 *
 * The fleet cases are the real inventories the in-appliance probe found (dac546bcf, 2026-09-17) run
 * against the real catalog, and they assert properties — tool-capable, not tiny, not the model the old
 * resolution picked — rather than one exact winner, so a leaderboard refresh that reorders two capable
 * models does not read as a regression. The ordering rules are pinned separately, on fixtures whose
 * numbers are chosen to isolate one key at a time.
 */

import { describe, expect, it } from 'vitest';
import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { CURATED_MODELS } from '@/modules/inference/catalog/curated-models';
import {
  AUTO_MIN_PARAMS_B,
  catalogEntryFor,
  chooseAutoModel,
  collectPoolModelOffers,
  isCloudProxiedTag,
  parameterScaleFromTag,
  rankAutoModelOffers,
  type NodeModelInventory,
  type PoolModelOffer,
} from '../pool-auto-model';

function node(models: string[], options: { local?: boolean; backend?: InferenceBackendType } = {}): NodeModelInventory {
  return { local: options.local ?? false, backends: [{ type: options.backend ?? 'ollama', models }] };
}

function offer(model: string, overrides: Partial<PoolModelOffer> = {}): PoolModelOffer {
  return { model, backends: ['ollama'], local: false, nodes: 1, ...overrides };
}

/** A catalog row with only the fields the ranking reads set to something meaningful. */
function row(
  backendModelId: string,
  fields: { tools?: boolean; params?: number; intelligence?: number; modality?: CuratedModel['modality']; backend?: InferenceBackendType } = {},
): CuratedModel {
  return {
    id: backendModelId.replace(/[:.]/g, '-'),
    backend: fields.backend ?? 'ollama',
    backendModelId,
    modality: fields.modality ?? 'llm',
    purpose: 'general',
    displayName: backendModelId,
    description: '',
    parameterScale: fields.params,
    metadata: {
      ...(fields.intelligence === undefined ? {} : { intelligenceIndex: fields.intelligence }),
      ...(fields.tools === undefined ? {} : { capabilities: { tools: fields.tools } }),
    },
  } as CuratedModel;
}

describe('collectPoolModelOffers', () => {
  it('folds name and name:latest into one offer, so a model is not split into two rarer ones', () => {
    const offers = collectPoolModelOffers([node(['nomic-embed-text:latest'], { local: true }), node(['nomic-embed-text'])]);

    expect(offers).toEqual([{ model: 'nomic-embed-text:latest', backends: ['ollama'], local: true, nodes: 2 }]);
  });

  it('counts a node once even when two of its backends list the model', () => {
    const offers = collectPoolModelOffers([
      {
        local: true,
        backends: [
          { type: 'ollama', models: ['qwen3.6:27b'] },
          { type: 'vllm', models: ['qwen3.6:27b'] },
        ],
      },
    ]);

    expect(offers).toEqual([{ model: 'qwen3.6:27b', backends: ['ollama', 'vllm'], local: true, nodes: 1 }]);
  });
});

describe('isCloudProxiedTag', () => {
  it.each(['glm-4.6:cloud', 'gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud'])('treats %s as sending the prompt off the appliance', (model) => {
    expect(isCloudProxiedTag(model)).toBe(true);
  });

  it.each(['qwen3.6:27b', 'cloud-model:7b', 'soundcloud', 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL'])('leaves %s alone', (model) => {
    expect(isCloudProxiedTag(model)).toBe(false);
  });
});

describe('parameterScaleFromTag', () => {
  it.each([
    ['gemma3:1b-cpu', 1],
    ['qwen2.5:0.5b', 0.5],
    ['gemma3n:e4b', 4],
    ['qwen3-coder:30b-a3b-q4_K_M', 30],
    ['smollm2:135m', 0.135],
  ])('reads %s as %s B', (model, expected) => {
    expect(parameterScaleFromTag(model)).toBe(expected);
  });

  it.each(['llama3.2:latest', 'qwen2.5', 'hf.co/unsloth/GLM-5.2-GGUF:UD-Q4_K_XL', 'mixtral:8x7b'])('claims no size for %s', (model) => {
    // `qwen2.5` is the family, not a size: only the tag is read.
    expect(parameterScaleFromTag(model)).toBeUndefined();
  });
});

describe('rankAutoModelOffers', () => {
  it('puts a tool-capable model ahead of an unknown one, and an unknown one ahead of a known tool-less one', () => {
    const catalog = [row('with-tools:14b', { tools: true, params: 14 }), row('no-tools:70b', { tools: false, params: 70, intelligence: 30 })];

    const ranked = rankAutoModelOffers([offer('no-tools:70b'), offer('mystery:14b'), offer('with-tools:14b')], catalog);

    // The tool-less model scores highest and is largest; for agent traffic that does not matter.
    expect(ranked.map((o) => o.model)).toEqual(['with-tools:14b', 'mystery:14b', 'no-tools:70b']);
  });

  it(`demotes a model under ${AUTO_MIN_PARAMS_B} B below any that is not, whatever it scores`, () => {
    const catalog = [row('tiny:2b', { tools: true, params: 2, intelligence: 20 }), row('mid:8b', { tools: true, params: 8, intelligence: 5 })];

    expect(rankAutoModelOffers([offer('tiny:2b'), offer('mid:8b')], catalog).map((o) => o.model)).toEqual(['mid:8b', 'tiny:2b']);
  });

  it('then ranks by intelligence index, then size, then breadth, then this node, then id', () => {
    const catalog = [
      row('smart:27b', { tools: true, params: 27, intelligence: 30 }),
      row('big:70b', { tools: true, params: 70, intelligence: 20 }),
      row('small:27b', { tools: true, params: 27, intelligence: 20 }),
      row('wide:27b', { tools: true, params: 27, intelligence: 10 }),
      row('narrow-local:27b', { tools: true, params: 27, intelligence: 10 }),
      row('narrow-b:27b', { tools: true, params: 27, intelligence: 10 }),
      row('narrow-a:27b', { tools: true, params: 27, intelligence: 10 }),
    ];
    const offers = [
      offer('narrow-b:27b'),
      offer('narrow-a:27b'),
      offer('narrow-local:27b', { local: true }),
      offer('wide:27b', { nodes: 5 }),
      offer('small:27b'),
      offer('big:70b'),
      offer('smart:27b'),
    ];

    expect(rankAutoModelOffers(offers, catalog).map((o) => o.model)).toEqual([
      'smart:27b',
      'big:70b',
      'small:27b',
      'wide:27b',
      'narrow-local:27b',
      'narrow-a:27b',
      'narrow-b:27b',
    ]);
  });

  it('drops embedding models, rerankers and cloud-proxied tags entirely, catalogued or not', () => {
    const catalog = [row('nomic-embed-text', { modality: 'embedding' })];
    const offers = [
      offer('nomic-embed-text:latest'),
      offer('mxbai-embed-large:latest'),
      offer('all-minilm:22m'),
      offer('bge-m3:latest'),
      offer('qwen3-reranker:4b'),
      offer('gpt-oss:120b-cloud'),
    ];

    expect(rankAutoModelOffers(offers, catalog)).toEqual([]);
  });

  it('does not demote a model for the catalog calling its purpose "reasoning" — the best model on the fleet carries that label', () => {
    const qwen38 = CURATED_MODELS.find((m) => m.backendModelId === 'qwen3.8:27b');
    const qwen36 = CURATED_MODELS.find((m) => m.backendModelId === 'qwen3.6:27b');
    // Guarded, so a catalog refresh that changes either fact fails here with the reason, not below.
    expect(qwen38?.purpose).toBe('reasoning');
    expect(qwen38?.metadata?.intelligenceIndex ?? 0).toBeGreaterThan(qwen36?.metadata?.intelligenceIndex ?? 0);

    expect(rankAutoModelOffers([offer('qwen3.6:27b'), offer('qwen3.8:27b')], CURATED_MODELS)[0]?.model).toBe('qwen3.8:27b');
  });
});

describe('catalogEntryFor', () => {
  it('prefers the row for a backend that actually lists the model', () => {
    const ollamaRow = row('shared-id', { backend: 'ollama', params: 1 });
    const vllmRow = row('shared-id', { backend: 'vllm', params: 70 });

    expect(catalogEntryFor(offer('shared-id', { backends: ['vllm'] }), [ollamaRow, vllmRow])).toBe(vllmRow);
  });
});

describe('chooseAutoModel', () => {
  const catalog = [
    row('capable:27b', { tools: true, params: 27, intelligence: 20 }),
    row('tiny:1b', { tools: false, params: 1 }),
    row('embedder', { modality: 'embedding' }),
    row('vllm-only:8b', { tools: true, params: 8, backend: 'vllm' }),
  ];

  it("honours the operator's preference even for a model the ranking would put last", () => {
    expect(chooseAutoModel([offer('capable:27b'), offer('tiny:1b')], { preferred: { engineId: 'tiny:1b' }, catalog })).toEqual({
      model: 'tiny:1b',
      reason: 'preferred',
    });
  });

  it('honours a preference for a cloud tag, which the ranking alone would never pick — the operator looked at it', () => {
    const offers = [offer('capable:27b'), offer('gpt-oss:120b-cloud')];

    expect(chooseAutoModel(offers, { catalog })?.model).toBe('capable:27b');
    expect(chooseAutoModel(offers, { preferred: { engineId: 'gpt-oss:120b-cloud' }, catalog })?.model).toBe('gpt-oss:120b-cloud');
  });

  it('ignores a preference for an embedding model, which cannot run a chat turn anyway', () => {
    expect(chooseAutoModel([offer('capable:27b'), offer('embedder')], { preferred: { engineId: 'embedder' }, catalog })).toEqual({
      model: 'capable:27b',
      reason: 'ranked',
    });
  });

  it('matches a catalogued preference only on the backend its row runs on', () => {
    // The same engine id on a different backend is a different build; the preference named a specific one.
    const offers = [offer('capable:27b'), offer('vllm-only:8b', { backends: ['ollama'] })];

    expect(chooseAutoModel(offers, { preferred: { engineId: 'vllm-only:8b', backend: 'vllm' }, catalog })?.reason).toBe('ranked');
  });

  it('answers undefined when nothing in the pool can chat', () => {
    expect(chooseAutoModel([offer('embedder'), offer('nomic-embed-text:latest')], { catalog })).toBeUndefined();
  });
});

describe('the fleet inventories the old resolution got wrong', () => {
  const tools = (model: string) => CURATED_MODELS.find((m) => m.backendModelId === model)?.metadata?.capabilities?.tools;
  const params = (model: string) => CURATED_MODELS.find((m) => m.backendModelId === model)?.parameterScale ?? 0;

  function resolve(nodes: NodeModelInventory[]): string | undefined {
    return chooseAutoModel(collectPoolModelOffers(nodes), { catalog: CURATED_MODELS })?.model;
  }

  // beta-ms-a2's list, read 2026-09-17 (core-6 lists the same 22 tags). With no Settings → Inference
  // model, `auto` ran `deepseek-r1:8b` — the newest pull, second in the list.
  const BETA_MS_A2 = [
    'nomic-embed-text:latest',
    'deepseek-r1:8b',
    'qwen3.5:2b',
    'lfm2.5:8b',
    'ornith-1.5:35b',
    'gemma4:26b',
    'qwen2.5-coder:3b',
    'qwen2.5-coder:7b',
    'qwen3-coder:30b',
    'nomic-embed-text-v2-moe:latest',
    'qwen3.8:27b',
    'mxbai-embed-large:latest',
    'gabegoodhart/minimax-m2:230b',
    'qwen3.5:9b',
    'qwen3.5:4b',
    'gemma3:1b',
    'qwen3.6:27b',
    'qwen3:32b',
    'qwen3:30b',
    'gemma4:e2b',
    'gemma4:31b',
    'qwen3.6:35b',
  ];

  it('beta-ms-a2: a tool-capable model of real size, not the newest pull and not a tiny one', () => {
    const chosen = resolve([node(BETA_MS_A2, { local: true })]) as string;

    expect(['gemma4:e2b', 'deepseek-r1:8b']).not.toContain(chosen);
    expect(tools(chosen)).toBe(true);
    expect(params(chosen)).toBeGreaterThanOrEqual(AUTO_MIN_PARAMS_B);
  });

  it('core-4: its one capable model, not gemma3:1b', () => {
    expect(
      resolve([node(['qwen3-coder:30b', 'nomic-embed-text:cpu', 'gemma3:1b-cpu', 'gemma3:1b', 'nomic-embed-text:latest'], { local: true })]),
    ).toBe('qwen3-coder:30b');
  });

  it('a node with only embeddings, in a pool whose peers hold chat models: a peer model, not nothing', () => {
    const chosen = resolve([node(['nomic-embed-text:latest'], { local: true }), node(BETA_MS_A2)]);

    expect(chosen).toBeDefined();
    expect(tools(chosen as string)).toBe(true);
  });
});
