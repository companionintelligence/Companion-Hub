import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { CURATED_MODELS } from '../catalog/curated-models';
import { VISION_ENCODER_RESERVE_MB } from '../context-length.util';
import { appInferenceRequirements, checkModelRequirements } from '../app-inference-requirements';
import {
  capHandoutAtServedWindow,
  decideModelPrePull,
  describeContextHandout,
  handoutContextLength,
  visionReserveMbFor,
  LOCAL_POOL_NODE,
  nodesServing,
  PEER_SERVED_CONTEXT_LENGTH,
  poolContextCap,
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

  it('requires tool calling but no context floor for ci-mentra, under both of its app names', () => {
    expect(appInferenceRequirements('ci-mentra')).toEqual({ toolCalling: true });
    expect(appInferenceRequirements('mentra')).toEqual({ toolCalling: true });
    expect(checkModelRequirements(gemma1b, appInferenceRequirements('ci-mentra'))).toEqual({ verdict: 'fails', unmet: ['no tool calling'] });
    expect(checkModelRequirements(qwenCoder30b, appInferenceRequirements('ci-mentra')).verdict).toBe('meets');
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

  describe('the engine-runtime cap (core-2, 2026-09-20)', () => {
    // core-2: 64 GB budget sizes qwen3-coder:30b to 65536, while its Ollama runs OLLAMA_CONTEXT_LENGTH=16384.
    const core2 = { model: qwenCoder30b, servedLocally: true, effectiveInferenceMemoryMb: 65536 };

    it('caps a locally sized window at the cap, so the app asks for what the engine already runs', () => {
      expect(handoutContextLength({ ...core2, maxContextLength: 16_384 })).toBe(16_384);
    });

    it('caps the peer-served fallback and wins over an app floor: the floor is a wish, the cap is the engine', () => {
      expect(handoutContextLength({ model: qwenCoder30b, servedLocally: false, effectiveInferenceMemoryMb: 0, maxContextLength: 16_384 })).toBe(
        16_384,
      );
      expect(handoutContextLength({ ...core2, minContextLength: 64_000, maxContextLength: 16_384 })).toBe(16_384);
    });

    it('is a no-op when the cap is above the sized window, absent, null, or a value this build cannot believe', () => {
      expect(handoutContextLength({ ...core2, maxContextLength: 131_072 })).toBe(65_536);
      expect(handoutContextLength({ ...core2, maxContextLength: null })).toBe(65_536);
      expect(handoutContextLength({ ...core2, maxContextLength: undefined })).toBe(65_536);
      // Below the smallest believable cap (a dropped digit), fractional, and past the largest window on the fleet.
      expect(handoutContextLength({ ...core2, maxContextLength: 128 })).toBe(65_536);
      expect(handoutContextLength({ ...core2, maxContextLength: 16_384.5 })).toBe(65_536);
      expect(handoutContextLength({ ...core2, maxContextLength: 2 ** 21 })).toBe(65_536);
    });
  });
});

/**
 * The bill-co fleet on 2026-09-21: core-17 is a 4×16384 batch node (with a 14000 prompt ceiling
 * that already keeps agent turns off it), beta-max and ci run 4×32768, and the agent tier
 * (core-2/4/5/6) runs 4×65536. The old pool-wide MINIMUM handed ci-hermes on core-2
 * `HERMES_NUM_CTX=16384` — core-17's number — and Hermes refused tool use below 64000 while core-2's
 * own engine served the model at 65536. The proxy now keeps a 65536 request off core-17, so the
 * handout is bound by the LARGEST cap among the serving nodes, and not at all when one has none.
 */
describe('handoutContextLength for Qwen 3.8 27B on Lemonade (7900 XTX, measured 2026-09-29)', () => {
  // Measured on the card: 20,657 MiB at 32k, +560 MiB after one 1280×960 image, ~1,150 MiB held by
  // the desktop and the embedder → 22,387 of 24,560. At 64k the same load needs ~24,570: over.
  const card = 24_560;
  const model = CURATED_MODELS.find((m) => m.id === 'qwen3-8-27b-lemonade') as CuratedModel;

  it('carries the measured per-token cost and takes images, so it gets the vision reserve', () => {
    expect(model.runtime.kvMbPerToken).toBe(0.0667);
    expect(visionReserveMbFor(model)).toBe(VISION_ENCODER_RESERVE_MB);
  });

  it('lands on 32k with the catalog cost and the files Lemonade lists, where the ladder alone said 8k before', () => {
    const numCtx = handoutContextLength({ model, servedLocally: true, effectiveInferenceMemoryMb: card, kvMbPerToken: 0.0667, weightMb: 17_630 });
    expect(numCtx).toBe(32_768);
  });

  it('still gets a usable window from the ladder when nothing could be measured', () => {
    expect(handoutContextLength({ model, servedLocally: true, effectiveInferenceMemoryMb: card })).toBe(16_384);
  });
});

describe('poolContextCap', () => {
  const allCapped: PoolInventory = {
    backends: [
      { node: LOCAL_POOL_NODE, local: true, backend: 'ollama', models: ['qwen3-coder:30b'], maxNumCtx: 65_536 },
      { node: 'core-17', local: false, backend: 'ollama', models: ['qwen3-coder:30b'], maxNumCtx: 16_384 },
      { node: 'beta-max', local: false, backend: 'ollama', models: ['qwen3-coder:30b'], maxNumCtx: 32_768 },
      { node: 'beta-red', local: false, backend: 'ollama', models: ['gemma3:1b'], maxNumCtx: 4096 },
    ],
  };
  const agentTierUncapped: PoolInventory = {
    backends: [
      { node: LOCAL_POOL_NODE, local: true, backend: 'ollama', models: ['qwen3-coder:30b'] },
      { node: 'core-17', local: false, backend: 'ollama', models: ['qwen3-coder:30b'], maxNumCtx: 16_384 },
      { node: 'beta-max', local: false, backend: 'ollama', models: ['qwen3-coder:30b'], maxNumCtx: 32_768 },
    ],
  };

  it('is the largest cap among the nodes serving the model, ignoring nodes that serve something else', () => {
    // beta-red's 4096 does not count: the proxy will never place a qwen3-coder:30b request there.
    expect(poolContextCap(allCapped, 'qwen3-coder:30b')).toBe(65_536);
    expect(poolContextCap(allCapped, 'gemma3:1b')).toBe(4096);
  });

  it('is no cap at all when any serving node advertises none — that node takes any window, so nothing smaller binds', () => {
    // core-2 as it was on 2026-09-21: no cap of its own, and 16384 from core-17 must not be the answer.
    expect(poolContextCap(agentTierUncapped, 'qwen3-coder:30b')).toBeNull();
  });

  it('is never the fleet minimum, whichever position the small node holds', () => {
    const reversed: PoolInventory = { backends: [...agentTierUncapped.backends].reverse() };
    expect(poolContextCap(reversed, 'qwen3-coder:30b')).toBeNull();
    const cappedReversed: PoolInventory = { backends: [...allCapped.backends].reverse() };
    expect(poolContextCap(cappedReversed, 'qwen3-coder:30b')).toBe(65_536);
  });

  it('is null when no serving node advertises a cap, which is what an older build looks like', () => {
    expect(poolContextCap(core4Inventory, 'qwen3-coder:30b')).toBeNull();
    expect(poolContextCap(allCapped, 'nothing-serves:this')).toBeNull();
  });

  it('reads a cap the way the wire is read: an unbelievable value is no cap, and no cap means unbounded', () => {
    const inventory: PoolInventory = {
      backends: [
        { node: 'a', local: false, backend: 'ollama', models: ['m:1b'], maxNumCtx: 12 },
        { node: 'b', local: false, backend: 'ollama', models: ['m:1b'], maxNumCtx: 32_768 },
      ],
    };
    expect(poolContextCap(inventory, 'm:1b')).toBeNull();
  });

  it('is carried on the handout selectPoolChatModel returns, for the model it chose', () => {
    const handout = selectPoolChatModel({
      appSlug: 'openclaw',
      inventory: allCapped,
      catalog: CURATED_MODELS,
      preferredId: null,
      requirements: appInferenceRequirements('openclaw'),
    });
    expect(handout.engineId).toBe('qwen3-coder:30b');
    expect(handout.contextCap).toBe(65_536);
  });
});

describe('describeContextHandout', () => {
  const base = { appSlug: 'openclaw', engineId: 'qwen3-coder:30b', numCtx: 16_384, maxContextLength: 16_384, residentContextLength: null };

  it('says nothing when the handout matches the engine and the app has no floor above the cap', () => {
    expect(describeContextHandout(base)).toEqual([]);
    expect(describeContextHandout({ ...base, residentContextLength: 16_384 })).toEqual([]);
    expect(describeContextHandout({ ...base, minContextLength: 8192 })).toEqual([]);
  });

  it('warns when the cap undercuts the app floor, since Hermes refuses to start below 64000', () => {
    const notes = describeContextHandout({ ...base, appSlug: 'hermes-agent', minContextLength: 64_000 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('hermes-agent: the context cap (16384) is below its 64000-token floor');
    expect(notes[0]).toContain('--ollama-context');
  });

  it('warns that a handout differing from the loaded window reloads the model, and names the cap as the fix when none is set', () => {
    const uncapped = describeContextHandout({ ...base, numCtx: 65_536, maxContextLength: null, residentContextLength: 16_384 });
    expect(uncapped).toHaveLength(1);
    expect(uncapped[0]).toContain('holds qwen3-coder:30b at a 16384-token window and the handout is 65536');
    expect(uncapped[0]).toContain('OLLAMA_CONTEXT_LENGTH');

    // With a cap set the mismatch is still worth a line (the model was loaded by something else at
    // another size), but the fix is no longer "set the cap".
    const capped = describeContextHandout({ ...base, residentContextLength: 65_536 });
    expect(capped).toHaveLength(1);
    expect(capped[0]).not.toContain('Settings > Inference');
  });

  it('says a pooled handout above this node cap is placed elsewhere, instead of promising a reload placement prevents', () => {
    // beta-max (cap 32768) serving qwen3-coder:30b next to an uncapped agent tier: its Hermes is
    // handed 65536, and the proxy sends those turns to the agent tier, not to beta-max's engine.
    const notes = describeContextHandout({
      ...base,
      appSlug: 'hermes-agent',
      numCtx: 65_536,
      maxContextLength: null,
      residentContextLength: 32_768,
      localContextCap: 32_768,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("hermes-agent: handed 65536 for qwen3-coder:30b, above this node's own cap (32768)");
    expect(notes[0]).toContain('only on failover');
    expect(notes[0]).not.toContain('its first request reloads');
  });

  it('keeps the reload warning when this node cap can take the pooled handout', () => {
    const notes = describeContextHandout({ ...base, numCtx: 16_384, residentContextLength: 8192, localContextCap: 16_384 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('holds qwen3-coder:30b at a 8192-token window and the handout is 16384');
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

  it('pulls a Lemonade model through the Hub too, but never a vLLM or oMLX one', () => {
    expect(decideModelPrePull({ ...base, backendType: 'lemonade' })).toMatchObject({ pull: true });
    expect(decideModelPrePull({ ...base, backendType: 'lemonade', endpointReady: false })).toMatchObject({
      pull: false,
      reason: 'the local lemonade backend is not ready',
    });
    for (const backendType of ['vllm', 'omlx'] as const) {
      expect(decideModelPrePull({ ...base, backendType })).toMatchObject({ pull: false, reason: `${backendType} has no Hub-managed pull registry` });
    }
  });
});

describe('capHandoutAtServedWindow', () => {
  const base = { appSlug: 'hermes-agent', engineId: 'Gemma-4-E4B-it-GGUF', backendType: 'lemonade' as const };

  it('lowers the handout to the one window Lemonade serves the model at, and says the app may refuse under its floor', () => {
    const { numCtx, notes } = capHandoutAtServedWindow({ ...base, numCtx: 64_000, servedContextLength: 16_384, minContextLength: 64_000 });
    expect(numCtx).toBe(16_384);
    expect(notes).toEqual([expect.stringContaining('serves Gemma-4-E4B-it-GGUF at ctx_size 16384, below the 64000 it would be handed')]);
    expect(notes[0]).toContain('under its 64000-token floor');
  });

  it('says only that it lowered it when the app has no floor above the served window', () => {
    const { numCtx, notes } = capHandoutAtServedWindow({ ...base, appSlug: 'openclaw', numCtx: 32_768, servedContextLength: 16_384 });
    expect(numCtx).toBe(16_384);
    expect(notes[0]).not.toContain('floor');
  });

  it('leaves the handout alone when the engine serves at least that much, or states no window', () => {
    for (const servedContextLength of [65_536, 64_000, null, 0]) {
      expect(capHandoutAtServedWindow({ ...base, numCtx: 64_000, servedContextLength })).toEqual({ numCtx: 64_000, notes: [] });
    }
  });
});
