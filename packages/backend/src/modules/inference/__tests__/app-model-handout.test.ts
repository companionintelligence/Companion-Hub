import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { CURATED_MODELS } from '../catalog/curated-models';
import { appInferenceRequirements, checkModelRequirements } from '../app-inference-requirements';
import {
  decideModelPrePull,
  handoutContextLength,
  LOCAL_POOL_NODE,
  nodesServing,
  PEER_SERVED_CONTEXT_LENGTH,
  selectPoolChatModel,
  type PoolInventory,
} from '../app-model-handout';

// The real catalog rows the core-4 incident involved, so these tests break if the catalog's own
// capability flags for them ever change rather than trusting a fixture's idea of them.
const catalogRow = (id: string): CuratedModel => {
  const row = CURATED_MODELS.find((m) => m.id === id);
  if (!row) throw new Error(`catalog row ${id} is missing`);
  return row;
};
const gemma1b = catalogRow('gemma3-1b');
const qwenCoder30b = catalogRow('qwen3-coder-30b');

/** core-4 on 2026-09-17: its own Ollama held gemma3:1b; core-6 served qwen3-coder:30b. */
const core4Inventory: PoolInventory = {
  backends: [
    { node: LOCAL_POOL_NODE, local: true, backend: 'ollama', models: ['gemma3:1b'] },
    { node: 'core-6', local: false, backend: 'ollama', models: ['qwen3-coder:30b', 'qwen3-coder-30b', 'nomic-embed-text:latest'] },
  ],
};

describe('app inference requirements', () => {
  it('declares tool calling for both agents and the 64000-token floor for hermes-agent only', () => {
    expect(appInferenceRequirements('openclaw')).toEqual({ toolCalling: true });
    expect(appInferenceRequirements('hermes-agent')).toEqual({ minContextLength: 64_000, toolCalling: true });
    expect(appInferenceRequirements('ci-memory')).toEqual({});
  });

  it('applies the same requirements under the first-party app names the fleet installs', () => {
    // core-4 runs ci-hermes and ci-openclaw; their app.env is generated under those names, not the bootstrap slugs.
    expect(appInferenceRequirements('ci-hermes')).toEqual(appInferenceRequirements('hermes-agent'));
    expect(appInferenceRequirements('ci-openclaw')).toEqual(appInferenceRequirements('openclaw'));
  });

  it('cannot be tricked into returning an Object.prototype member for a hostile slug', () => {
    for (const slug of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(appInferenceRequirements(slug)).toEqual({});
    }
  });

  it('rules gemma3:1b out for both agents for the reasons the fleet saw, and qwen3-coder:30b in', () => {
    expect(checkModelRequirements(gemma1b, appInferenceRequirements('openclaw'))).toEqual({ verdict: 'fails', unmet: ['no tool calling'] });
    expect(checkModelRequirements(gemma1b, appInferenceRequirements('hermes-agent')).unmet).toEqual([
      'no tool calling',
      '32000-token window (needs 64000)',
    ]);
    expect(checkModelRequirements(qwenCoder30b, appInferenceRequirements('hermes-agent')).verdict).toBe('meets');
  });

  it('calls a model the catalog has no row for unverified, not failing', () => {
    expect(checkModelRequirements(null, appInferenceRequirements('openclaw')).verdict).toBe('unverified');
    expect(checkModelRequirements(null, appInferenceRequirements('ci-memory')).verdict).toBe('meets');
  });
});

describe('selectPoolChatModel', () => {
  const select = (overrides: Partial<Parameters<typeof selectPoolChatModel>[0]> = {}) =>
    selectPoolChatModel({
      appSlug: 'openclaw',
      inventory: core4Inventory,
      catalog: CURATED_MODELS,
      preferredId: null,
      requirements: appInferenceRequirements('openclaw'),
      ...overrides,
    });

  it('picks the model a peer serves over the unusable one this node holds', () => {
    const handout = select();

    expect(handout).toMatchObject({ engineId: 'qwen3-coder:30b', source: 'best-compliant', servedBy: ['core-6'], servedLocally: false, error: null });
    expect(handout.rejected).toEqual([{ engineId: 'gemma3:1b', unmet: ['no tool calling'] }]);
  });

  it('gives the operator preference first place when a node serves it and it meets the app', () => {
    expect(select({ preferredId: 'qwen3-coder-30b' }).source).toBe('preferred');
  });

  it('never hands out a preferred model that fails the app, and says why it was passed over', () => {
    const handout = select({ preferredId: 'gemma3-1b' });

    expect(handout.engineId).toBe('qwen3-coder:30b');
    expect(handout.preferredNote).toBe("preferred model gemma3:1b does not meet openclaw's requirements (no tool calling)");
  });

  it('notes a preferred model no node serves instead of handing it out to 502', () => {
    const handout = select({ preferredId: 'qwen3-coder-480b' });

    expect(handout.engineId).toBe('qwen3-coder:30b');
    expect(handout.preferredNote).toBe('preferred model qwen3-coder:480b is not served by any pool node');
  });

  it('ranks served compliant models with the recommender comparator, not inventory order', () => {
    const inventory: PoolInventory = {
      backends: [{ node: 'core-6', local: false, backend: 'ollama', models: ['qwen3:8b', 'qwen3-coder:30b'] }],
    };
    const qwen8b = catalogRow('qwen3-8b');
    expect((qwen8b.metadata?.intelligenceIndex ?? 0) < (qwenCoder30b.metadata?.intelligenceIndex ?? 0)).toBe(true);

    expect(select({ inventory }).engineId).toBe('qwen3-coder:30b');
  });

  it('returns an explicit error naming what was ruled out when nothing served meets the app', () => {
    const inventory: PoolInventory = { backends: [{ node: LOCAL_POOL_NODE, local: true, backend: 'ollama', models: ['gemma3:1b'] }] };

    const handout = select({ appSlug: 'hermes-agent', inventory, requirements: appInferenceRequirements('hermes-agent') });

    expect(handout.engineId).toBeNull();
    expect(handout.error).toBe(
      "No chat model served by this Hub's pool meets hermes-agent's requirements (tool calling and a context window of at least 64000 tokens). " +
        'Unsuitable: gemma3:1b (no tool calling, 32000-token window (needs 64000)). ' +
        'Pull a model with tool calling and a context window of at least 64000 tokens onto any pool node, or choose one in Settings > Inference.',
    );
  });

  it('falls back to an uncatalogued served model only after every catalogued compliant one', () => {
    const inventory: PoolInventory = {
      backends: [{ node: 'gpu-1', local: false, backend: 'vllm', models: ['acme/private-finetune'] }],
    };

    expect(select({ inventory })).toMatchObject({ engineId: 'acme/private-finetune', source: 'unverified' });
    const withCompliant: PoolInventory = { backends: [...inventory.backends, ...core4Inventory.backends] };
    expect(select({ inventory: withCompliant }).engineId).toBe('qwen3-coder:30b');
  });

  it('does not mistake an embedder, a catalog-id alias, or an Ollama cloud tag for an unverified chat model', () => {
    const inventory: PoolInventory = {
      backends: [
        {
          node: 'core-6',
          local: false,
          backend: 'ollama',
          models: ['nomic-embed-text:latest', 'gemma3-1b', 'mxbai-embed-large', 'deepseek-v4-pro:cloud'],
        },
      ],
    };

    expect(select({ inventory })).toMatchObject({ engineId: null, source: 'none' });
  });

  it('does not hand an agent an uncatalogued Ollama tag, since the catalog cannot vouch for its tools', () => {
    // An Ollama inventory is everything ever pulled: bge-m3 is an embedder the name filter misses,
    // and qwen2.5:0.5b has no row to say it lacks the tool support openclaw needs.
    const inventory: PoolInventory = { backends: [{ node: 'core-6', local: false, backend: 'ollama', models: ['bge-m3:latest', 'qwen2.5:0.5b'] }] };

    expect(select({ inventory })).toMatchObject({ engineId: null, source: 'none' });
    // The operator naming one explicitly is still their call.
    expect(select({ inventory, preferredId: 'qwen2.5:0.5b' })).toMatchObject({ engineId: 'qwen2.5:0.5b', source: 'preferred' });
  });

  it('matches the implicit :latest tag the way the proxy does', () => {
    const inventory: PoolInventory = { backends: [{ node: 'core-6', local: false, backend: 'ollama', models: ['qwen3-coder:30b'] }] };
    expect(nodesServing(inventory, 'qwen3-coder:30b', 'ollama')).toEqual(['core-6']);
    expect(
      nodesServing({ backends: [{ node: 'a', local: false, backend: 'ollama', models: ['nomic-embed-text:latest'] }] }, 'nomic-embed-text'),
    ).toEqual(['a']);
  });
});

describe('handoutContextLength', () => {
  it('sizes a locally served model from this node memory, as before', () => {
    expect(handoutContextLength({ model: qwenCoder30b, servedLocally: true, effectiveInferenceMemoryMb: 65536 })).toBe(65536);
  });

  it('does not size a peer-served model from this node memory', () => {
    // core-4's 6 GB budget minus a 20 GB model is negative, which the local ladder turns into 4096.
    expect(handoutContextLength({ model: qwenCoder30b, servedLocally: false, effectiveInferenceMemoryMb: 6144 })).toBe(PEER_SERVED_CONTEXT_LENGTH);
  });

  it('still applies an app floor and the model window to a peer-served model', () => {
    expect(handoutContextLength({ model: qwenCoder30b, servedLocally: false, effectiveInferenceMemoryMb: 0, minContextLength: 64_000 })).toBe(64_000);
    expect(handoutContextLength({ model: gemma1b, servedLocally: false, effectiveInferenceMemoryMb: 0 })).toBe(32_000);
  });
});

describe('decideModelPrePull', () => {
  const base = {
    kind: 'chat' as const,
    model: qwenCoder30b,
    backendType: 'ollama' as const,
    endpointReady: true,
    cloudPrimary: false,
    installedLocally: false,
    poolServedBy: [] as string[],
  };

  it('does not pull a model a pool node already serves', () => {
    expect(decideModelPrePull({ ...base, poolServedBy: ['core-6'] })).toEqual({
      kind: 'chat',
      catalogId: 'qwen3-coder-30b',
      pull: false,
      reason: 'already served by pool node(s) core-6',
    });
  });

  it('does not pull a model the app would refuse', () => {
    expect(decideModelPrePull({ ...base, model: gemma1b, requirements: appInferenceRequirements('openclaw') })).toMatchObject({
      pull: false,
      reason: "does not meet the app's requirements (no tool calling)",
    });
  });

  it('does not pull a hardware substitute for an app the pool already serves, but does pull the preferred model', () => {
    expect(decideModelPrePull({ ...base, poolHandout: 'qwen3.6:27b' })).toMatchObject({
      pull: false,
      reason: 'the pool already serves this app qwen3.6:27b, and qwen3-coder:30b is not the preferred model',
    });
    expect(decideModelPrePull({ ...base, poolHandout: 'qwen3.6:27b', operatorPreferred: true })).toMatchObject({ pull: true });
    // Embeddings go through the same proxy, and nothing else serves this one, so it is still pulled.
    expect(decideModelPrePull({ ...base, kind: 'embeddings', poolHandout: 'qwen3.6:27b' })).toMatchObject({ pull: true });
  });

  it('pulls only when nothing serves the model, the local Ollama is ready, and chat is not on cloud', () => {
    expect(decideModelPrePull(base)).toMatchObject({ pull: true, reason: 'not installed on this node and no pool node serves it' });
    expect(decideModelPrePull({ ...base, installedLocally: true })).toMatchObject({ pull: false });
    expect(decideModelPrePull({ ...base, endpointReady: false })).toMatchObject({ pull: false });
    expect(decideModelPrePull({ ...base, cloudPrimary: true })).toMatchObject({ pull: false });
    expect(decideModelPrePull({ ...base, backendType: 'vllm' })).toMatchObject({ pull: false });
    expect(decideModelPrePull({ ...base, model: null })).toBeNull();
  });
});
