import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { inventoryListsModel, sameModelId } from '@/common/helpers/hub-pool';
import { checkModelRequirements, describeRequirements, hasInferenceRequirements, type AppInferenceRequirements } from './app-inference-requirements';
import { recommendContextLength } from './context-length.util';
import { compareLlmCandidates } from './model-registry.service';

/**
 * Env key that carries an explicit "the Hub has no model it can hand you" message to an app.
 *
 * An HTTP error is not an option for the credentials endpoint: both bootstrap scripts
 * (CI-OpenClaw and CI-Hermes `bootstrap-from-hub.sh`) curl with `--fail` and, on any non-2xx, log
 * "Hub unreachable" and keep whatever `.env` they already had — which is exactly the stale
 * `gemma3:1b` this exists to stop. A 200 whose managed keys drop the model and carry this message
 * replaces the stale value and puts the reason in the file an operator opens first.
 */
export const INFERENCE_ERROR_ENV_KEY = 'CI_INFERENCE_ERROR';

/** How this node names itself in an inventory. Peers are named by display name, then FQDN. */
export const LOCAL_POOL_NODE = 'this Hub';

/** One backend on one pool node, and the engine ids it will accept a request for. */
export interface PoolInventoryBackend {
  node: string;
  local: boolean;
  backend: InferenceBackendType;
  /** Engine ids with any model the node is withholding as unservable already removed. */
  models: string[];
}

/** What the pool proxy could route a request to right now: this node's healthy backends plus every usable peer's. */
export interface PoolInventory {
  backends: PoolInventoryBackend[];
}

/** The pool nodes that list `engineId`, optionally only on one backend type, deduplicated in inventory order. */
export function nodesServing(inventory: PoolInventory, engineId: string, backend?: InferenceBackendType): string[] {
  const nodes: string[] = [];
  for (const entry of inventory.backends) {
    if (backend && entry.backend !== backend) continue;
    if (inventoryListsModel(entry.models, engineId) && !nodes.includes(entry.node)) {
      nodes.push(entry.node);
    }
  }
  return nodes;
}

function servedLocally(inventory: PoolInventory, engineId: string, backend?: InferenceBackendType): boolean {
  return inventory.backends.some((entry) => entry.local && (!backend || entry.backend === backend) && inventoryListsModel(entry.models, engineId));
}

export interface ChatModelHandout {
  /** The engine id to hand out, or null when nothing qualifies. */
  engineId: string | null;
  /** The catalog row behind `engineId`; null for an uncatalogued model. */
  model: CuratedModel | null;
  source: 'preferred' | 'best-compliant' | 'unverified' | 'none';
  servedBy: string[];
  /** True when this node itself serves the model, so its own memory is the right basis for num_ctx. */
  servedLocally: boolean;
  /** Served models the app's requirements excluded, with the reasons. */
  rejected: Array<{ engineId: string; unmet: string[] }>;
  /** Why no model was handed out, in words an app can show. Null whenever `engineId` is set. */
  error: string | null;
  /** Why the operator's preferred model was not the answer, when there is one and it was not. */
  preferredNote: string | null;
}

/**
 * The chat model to hand an app whose inference goes through the pool proxy.
 *
 * The inventory is the only input that answers "can this request be served": the proxy matches the
 * model id an app sends against every node's engine inventory, so a model this node's hardware
 * recommends but no node lists is a guaranteed 502, and a model only a peer lists is a perfectly
 * good answer. Selecting from this node's own `modelsLoaded`, as both handout paths did, is what
 * handed core-4's apps its local `gemma3:1b` while core-6 served `qwen3-coder:30b` over the pool.
 *
 * Order: the operator's preferred model when a node serves it and it meets the requirements; else
 * the best served catalog model that meets them (the recommender's own ranking); else a served
 * model the catalog cannot vouch for; else nothing, with an explicit error. A model known to fail
 * the requirements is never the answer.
 */
export function selectPoolChatModel(input: {
  appSlug: string;
  inventory: PoolInventory;
  catalog: readonly CuratedModel[];
  preferredId: string | null;
  requirements: AppInferenceRequirements;
}): ChatModelHandout {
  const { appSlug, inventory, preferredId, requirements } = input;
  const llms = input.catalog.filter((m) => m.modality === 'llm' && !m.backendModelId.endsWith(':cloud'));
  const rejected: ChatModelHandout['rejected'] = [];
  const handout = (
    model: CuratedModel | null,
    engineId: string,
    source: ChatModelHandout['source'],
    preferredNote: string | null,
  ): ChatModelHandout => ({
    engineId,
    model,
    source,
    servedBy: nodesServing(inventory, engineId, model?.backend),
    servedLocally: servedLocally(inventory, engineId, model?.backend),
    rejected,
    error: null,
    preferredNote,
  });

  // Catalog rows some node serves, matched on the engine id and backend, because the engine id is
  // what the app will send and what the proxy matches.
  const served = llms.filter((m) => nodesServing(inventory, m.backendModelId, m.backend).length > 0);
  const knownEngineIds = new Set<string>();
  for (const model of served) {
    const check = checkModelRequirements(model, requirements);
    if (check.verdict === 'fails') {
      rejected.push({ engineId: model.backendModelId, unmet: check.unmet });
    }
  }

  let preferredNote: string | null = null;
  if (preferredId) {
    const preferred = llms.find((m) => m.id === preferredId) ?? llms.find((m) => sameModelId(m.backendModelId, preferredId));
    if (preferred) {
      const check = checkModelRequirements(preferred, requirements);
      if (!served.includes(preferred)) {
        preferredNote = `preferred model ${preferred.backendModelId} is not served by any pool node`;
      } else if (check.verdict === 'fails') {
        preferredNote = `preferred model ${preferred.backendModelId} does not meet ${appSlug}'s requirements (${check.unmet.join(', ')})`;
      } else {
        return handout(preferred, preferred.backendModelId, 'preferred', null);
      }
    } else if (nodesServing(inventory, preferredId).length > 0) {
      // An operator can name a model the catalog has no row for (a host-served vLLM id). Their
      // explicit choice outranks the Hub's inability to check it.
      return handout(null, preferredId, 'preferred', null);
    } else {
      preferredNote = `preferred model ${preferredId} is not served by any pool node`;
    }
  }

  const compliant = served.filter((m) => checkModelRequirements(m, requirements).verdict === 'meets').sort(compareLlmCandidates);
  const best = compliant[0];
  if (best) {
    return handout(best, best.backendModelId, 'best-compliant', preferredNote);
  }

  for (const model of llms) {
    knownEngineIds.add(model.backendModelId);
    knownEngineIds.add(model.id);
  }
  // Anything else a node lists, minus catalog rows of other modalities (embedding models) and the
  // catalog-id aliases a peer's inventory carries next to engine ids for tracked models.
  const nonLlmIds = new Set(input.catalog.filter((m) => m.modality !== 'llm').flatMap((m) => [m.backendModelId, m.id]));
  for (const entry of inventory.backends) {
    // Only a host-served engine's own models. An operator runs `vllm serve <model>` on purpose, and
    // the local handout paths have always trusted that list. An Ollama inventory is every tag ever
    // pulled onto the node: embedders the name filter below misses (`bge-m3`), vision models, and
    // sub-1B chat models with no tool support. Handing one of those to an agent because the catalog
    // has no row to rule it out is the core-4 failure again with a different name, and neither local
    // path ever emitted an uncatalogued Ollama tag.
    if (entry.backend === 'ollama') continue;
    for (const engineId of entry.models) {
      const known = [...knownEngineIds].some((id) => sameModelId(id, engineId));
      const nonLlm = [...nonLlmIds].some((id) => sameModelId(id, engineId)) || /embed/i.test(engineId);
      // `:cloud` tags proxy to Ollama's hosted API; the catalog refuses them for the same reason.
      if (!known && !nonLlm && !engineId.endsWith(':cloud')) {
        return handout(null, engineId, 'unverified', preferredNote);
      }
    }
  }

  const error = describeNoSuitableChatModel({ appSlug, requirements, rejected, scope: 'pool' });
  return { engineId: null, model: null, source: 'none', servedBy: [], servedLocally: false, rejected, error, preferredNote };
}

/** The explicit error an app is handed in place of a model, naming what it needs and what was ruled out. */
export function describeNoSuitableChatModel(input: {
  appSlug: string;
  requirements: AppInferenceRequirements;
  rejected: Array<{ engineId: string; unmet: string[] }>;
  scope: 'pool' | 'local';
}): string {
  const { appSlug, requirements, rejected, scope } = input;
  const needs = describeRequirements(requirements);
  const where = scope === 'pool' ? "served by this Hub's pool" : 'installed on this Hub';
  const target = scope === 'pool' ? 'onto any pool node' : 'onto this Hub';
  if (rejected.length > 0) {
    const rejectedText = rejected.map((r) => `${r.engineId} (${r.unmet.join(', ')})`).join('; ');
    return (
      `No chat model ${where} meets ${appSlug}'s requirements (${needs}). Unsuitable: ${rejectedText}. ` +
      `Pull a model with ${needs} ${target}, or choose one in Settings > Inference.`
    );
  }
  const withNeeds = hasInferenceRequirements(requirements) ? ` with ${needs}` : '';
  return `No chat model${withNeeds} is ${where}. Pull one ${target}, or choose one in Settings > Inference.`;
}

/**
 * The num_ctx to hand out for `model`.
 *
 * `recommendContextLength` sizes the window from the memory left after the weights on the machine
 * running them. That is this node when it serves the model; when only a peer does, this node's
 * memory says nothing about the machine that will allocate the KV cache, and the peer does not
 * report its memory. The fallback is the ladder's 32768 rung, the rung nearest the 32000 window
 * CI-OpenClaw's config reconcile has always defaulted to, rather than the 8192 an unknown budget
 * produces — a quarter of the window that app was built and tested against. App floors still apply.
 */
export const PEER_SERVED_CONTEXT_LENGTH = 32_768;

export function handoutContextLength(input: {
  model: CuratedModel;
  servedLocally: boolean;
  effectiveInferenceMemoryMb: number;
  minContextLength?: number;
  /**
   * What a token of context actually costs this model, probed from the local engine
   * (see `model-geometry.util`). Only meaningful when this node serves the model — a peer's
   * geometry cannot be measured from here — so it is ignored on the pool-served path below.
   * Absent, `recommendContextLength` falls back to its footprint heuristic.
   */
  kvMbPerToken?: number | null;
  weightMb?: number | null;
}): number {
  const { model, minContextLength } = input;
  if (input.servedLocally) {
    return recommendContextLength({
      effectiveInferenceMemoryMb: input.effectiveInferenceMemoryMb,
      modelFootprintMb: model.runtime.memoryFootprintMb,
      modelContextWindow: model.runtime.contextWindow,
      minContextLength,
      kvMbPerToken: input.kvMbPerToken ?? null,
      weightMb: input.weightMb ?? null,
    });
  }
  const cap = Math.floor(model.runtime.contextWindow > 0 ? model.runtime.contextWindow : PEER_SERVED_CONTEXT_LENGTH);
  const floor = Number.isFinite(minContextLength) ? Math.max(0, Math.floor(minContextLength as number)) : 0;
  return Math.min(Math.max(PEER_SERVED_CONTEXT_LENGTH, floor), cap);
}

export interface PrePullDecision {
  kind: 'chat' | 'embeddings';
  catalogId: string;
  pull: boolean;
  reason: string;
}

/**
 * Whether serving an app its credentials should also start pulling `model` onto this node.
 *
 * A pull is a multi-gigabyte download and a disk commitment, and it used to be an unlogged side
 * effect of a GET: on core-4, changing the preferred model queued ~21 GB of `qwen3-coder:30b` on
 * the next `bootstrap.env` fetch, for a model core-6 was already serving that app through the pool.
 * Every call now returns a decision with its reason, the caller logs it, and a model any pool node
 * already serves is never pulled from here — copying it onto this node is an operator action, not a
 * handout one. A model nothing serves is still pulled, as on a single-node Hub: that is how the
 * operator's newly chosen preference becomes available at all.
 */
export function decideModelPrePull(input: {
  kind: 'chat' | 'embeddings';
  model: CuratedModel | null;
  backendType: InferenceBackendType;
  endpointReady: boolean;
  cloudPrimary: boolean;
  installedLocally: boolean;
  /** Pool nodes that serve `model`, or [] when the app is not routed through the pool. */
  poolServedBy: string[];
  /**
   * The chat model the pool is already handing this app, when it is routed through the pool and one
   * qualifies. Null otherwise.
   */
  poolHandout?: string | null;
  /** `model` is the operator's preferred model, not a substitute the recommender picked for this hardware. */
  operatorPreferred?: boolean;
  requirements?: AppInferenceRequirements;
}): PrePullDecision | null {
  const { kind, model } = input;
  if (!model) return null;
  const decide = (pull: boolean, reason: string): PrePullDecision => ({ kind, catalogId: model.id, pull, reason });

  if (input.cloudPrimary && kind === 'chat') return decide(false, 'a cloud provider is serving chat for this app');
  if (input.backendType !== 'ollama') return decide(false, `${input.backendType} has no Hub-managed pull registry`);
  if (!input.endpointReady) return decide(false, 'the local ollama backend is not ready');
  if (input.installedLocally) return decide(false, 'already installed on this node');
  if (input.poolServedBy.length > 0) {
    return decide(false, `already served by pool node(s) ${input.poolServedBy.join(', ')}`);
  }
  // The recommender's pick for this node's hardware is a substitute nobody asked for, and the app
  // already has a working model from the pool. Downloading it would be the same unrequested
  // multi-gigabyte side effect of a GET, one step removed. The operator's own choice still pulls.
  if (kind === 'chat' && input.poolHandout && !input.operatorPreferred) {
    return decide(false, `the pool already serves this app ${input.poolHandout}, and ${model.backendModelId} is not the preferred model`);
  }
  if (input.requirements) {
    const check = checkModelRequirements(model, input.requirements);
    if (check.verdict === 'fails') return decide(false, `does not meet the app's requirements (${check.unmet.join(', ')})`);
  }
  return decide(true, 'not installed on this node and no pool node serves it');
}
