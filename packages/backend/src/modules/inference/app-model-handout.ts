import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { inventoryListsModel, sameModelId } from '@/common/helpers/hub-pool';
import { clampContextCap } from '@/common/helpers/inference-context-cap';
import { checkModelRequirements, describeRequirements, hasInferenceRequirements, type AppInferenceRequirements } from './app-inference-requirements';
import { type FootprintSighting, recommendContextLength, VISION_ENCODER_RESERVE_MB } from './context-length.util';
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
  /**
   * The node's ceiling on the `num_ctx` it hands its apps (`inferenceMaxNumCtx`), set by its
   * operator to its engine's own context. `null` or absent when it has none, or when the peer's
   * build does not advertise one — the two are the same on the wire, and both read as "takes any
   * window". See {@link poolContextCap}.
   */
  maxNumCtx?: number | null;
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

/**
 * The context cap a pooled handout of `engineId` must respect: the LARGEST cap among the nodes
 * that serve it, or `null` — no cap — when none serve it or any serving node advertises none.
 *
 * A node's cap is its operator's statement of what its engine runs at, and a request above it
 * reloads that node's model with a larger window (core-2, 2026-09-20: 25 GB → 44 GB on a 30B, and
 * every request at another size a reload back). The proxy no longer places such a request there:
 * a request asking for a window is placed only on nodes whose cap is unset or at least that window
 * (`applyContextCap`), the same way a prompt ceiling moves a node back. So the handout can ask for
 * the largest window any serving node offers, and placement keeps it off the rest.
 *
 * It used to be the smallest cap, "what fits everywhere", and that let one small node cap the whole
 * fleet's agents: on 2026-09-21 core-17 (a 4×16384 batch node whose prompt ceiling already kept
 * agent turns off it) advertised 16384, and ci-hermes on core-2 — whose own engine serves the model
 * at 65536 — was handed `HERMES_NUM_CTX=16384` and refused tool use ("Hermes needs at least
 * 64,000"). Set to 65536 by hand the task succeeded in 54 s, entirely on core-2.
 *
 * A serving node with no cap reads as unbounded, because that is what placement makes of it: it
 * accepts any window, so the handout is not bound by any capped node either. A build predating the
 * field is indistinguishable from one with no cap, and is treated the same — which is why every
 * node should carry its cap (`cihub fleet backends --ollama-context` writes them all).
 */
export function poolContextCap(inventory: PoolInventory, engineId: string, backend?: InferenceBackendType): number | null {
  let cap: number | null = null;
  for (const entry of inventory.backends) {
    if (backend && entry.backend !== backend) continue;
    if (!inventoryListsModel(entry.models, engineId)) continue;
    const advertised = clampContextCap(entry.maxNumCtx);
    if (advertised === null) return null;
    if (cap === null || advertised > cap) cap = advertised;
  }
  return cap;
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
  /** The largest context cap among the nodes serving `engineId`, or null when any of them advertises none. See {@link poolContextCap}. */
  contextCap: number | null;
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
    contextCap: poolContextCap(inventory, engineId, model?.backend),
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
  return { engineId: null, model: null, source: 'none', servedBy: [], servedLocally: false, contextCap: null, rejected, error, preferredNote };
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
 *
 * Both answers are then capped at `maxContextLength`, the operator's statement of what the engine
 * runs at (see `inference-context-cap.ts`). The cap wins over an app's floor: the floor is what the
 * app would like, the cap is what the engine will serve without reloading the model, and handing
 * out the floor anyway is exactly the 44 GB reload on core-2. The caller warns when they conflict.
 */
export const PEER_SERVED_CONTEXT_LENGTH = 32_768;

export interface ContextHandoutInput {
  model: CuratedModel;
  servedLocally: boolean;
  /**
   * Memory the model may use on this node: `modelMemoryCeilingMb(profile)`, the budget the load is
   * fit-checked against with nothing else loaded, so the window an app is told is one the load path
   * will not refuse or step down on an empty card.
   */
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
  /** Sequences the engine allocates a KV cache for (`kvSequencesFor`); local path only, like the cost. */
  kvSlots?: number | null;
  /** What this node's engine was seen holding for the model (`MemoryManagerService`); local path only. */
  sighting?: FootprintSighting | null;
  /**
   * The engine-runtime ceiling: this node's `inferenceMaxNumCtx` on the direct path, or for a
   * pooled handout the largest cap among the serving nodes from {@link poolContextCap}. `null` or
   * absent is no cap. Anything this build cannot believe (see `clampContextCap`) is no cap too.
   */
  maxContextLength?: number | null;
}

/**
 * What to keep free for `model`'s image encoder: {@link VISION_ENCODER_RESERVE_MB} when it takes
 * images, else nothing. Apps are handed a vision model as their chat model too (ci-memory's image
 * descriptions run on it), so the reserve belongs to the model, not to one app's use of it.
 */
export function visionReserveMbFor(model: CuratedModel): number {
  return model.runtime.input?.includes('image') || model.metadata?.capabilities?.vision ? VISION_ENCODER_RESERVE_MB : 0;
}

export function handoutContextLength(input: ContextHandoutInput): number {
  const cap = clampContextCap(input.maxContextLength);
  const sized = uncappedContextLength(input);
  return cap === null ? sized : Math.min(sized, cap);
}

function uncappedContextLength(input: ContextHandoutInput): number {
  const { model, minContextLength } = input;
  if (input.servedLocally) {
    return recommendContextLength({
      effectiveInferenceMemoryMb: input.effectiveInferenceMemoryMb,
      modelFootprintMb: model.runtime.memoryFootprintMb,
      modelContextWindow: model.runtime.contextWindow,
      minContextLength,
      kvMbPerToken: input.kvMbPerToken ?? null,
      weightMb: input.weightMb ?? null,
      kvSlots: input.kvSlots ?? null,
      sighting: input.sighting ?? null,
      visionReserveMb: visionReserveMbFor(model),
    });
  }
  const cap = Math.floor(model.runtime.contextWindow > 0 ? model.runtime.contextWindow : PEER_SERVED_CONTEXT_LENGTH);
  const floor = Number.isFinite(minContextLength) ? Math.max(0, Math.floor(minContextLength as number)) : 0;
  return Math.min(Math.max(PEER_SERVED_CONTEXT_LENGTH, floor), cap);
}

/**
 * What an operator should hear about a context handout, for the caller to log at warn level.
 *
 * Two things are worth a line, and both are silent failures otherwise. A cap below the app's floor
 * hands the app a window it has said it refuses — Hermes aborts at startup below 64000 — and the
 * only fix is on the engine (`--ollama-context`) or the cap, not in the Hub. And a handout that
 * differs from the window the local engine currently holds the model at (`/api/ps`
 * `context_length`) is a reload on the app's first request, and a reload back on the next request
 * at the old size; when no cap is set, that is the core-2 flip and the cap is the fix.
 *
 * Through the pool the second reads differently. A handout above this node's own cap is not a
 * reload here: the proxy places the app's requests on a node whose cap can take the window and
 * reaches this node's engine only on failover. So when `localContextCap` is set and below the
 * handout, the line says that instead of promising a reload that placement prevents.
 */
export function describeContextHandout(input: {
  appSlug: string;
  engineId: string;
  numCtx: number;
  maxContextLength: number | null;
  minContextLength?: number;
  /** The `context_length` the local engine reports the model loaded at, or null when it is not loaded or cannot be asked. */
  residentContextLength: number | null;
  /**
   * This node's own cap, when the handout went through the pool and this node serves the model —
   * the one case a handout may lawfully exceed it. Omit on the direct path, where `maxContextLength`
   * already is this node's cap.
   */
  localContextCap?: number | null;
}): string[] {
  const { appSlug, engineId, numCtx, minContextLength, residentContextLength } = input;
  const cap = clampContextCap(input.maxContextLength);
  const localCap = clampContextCap(input.localContextCap);
  const notes: string[] = [];
  if (cap !== null && typeof minContextLength === 'number' && minContextLength > cap) {
    notes.push(
      `${appSlug}: the context cap (${cap}) is below its ${minContextLength}-token floor, so it is handed ${numCtx} and may refuse to start; ` +
        `raise the engine's context (cihub fleet backends --ollama-context) and the cap together, or leave this app off this node.`,
    );
  }
  if (localCap !== null && localCap < numCtx) {
    notes.push(
      `${appSlug}: handed ${numCtx} for ${engineId}, above this node's own cap (${localCap}); ` +
        `the pool places its requests on nodes whose cap can take that window, and this node's engine serves them only on failover, which reloads it at ${numCtx}.`,
    );
    return notes;
  }
  if (residentContextLength !== null && residentContextLength > 0 && residentContextLength !== numCtx) {
    notes.push(
      `${appSlug}: ollama holds ${engineId} at a ${residentContextLength}-token window and the handout is ${numCtx}; ` +
        `its first request reloads the model at ${numCtx}, and the next request at ${residentContextLength} reloads it back` +
        (cap === null
          ? ' — set the context cap (Settings > Inference) to the engine OLLAMA_CONTEXT_LENGTH so every app asks for the same window.'
          : '.'),
    );
  }
  return notes;
}

/**
 * The handout for a model whose engine serves one window whatever a request asks — Lemonade, whose
 * saved `ctx_size` is the window every caller gets — lowered to that window when it is smaller, with
 * a line for the operator.
 *
 * The Hub loads a Lemonade model at the largest window up to the installed apps' floors that fits
 * (`InferenceRouterService.planLoad`); when the card cannot hold the floor, the saved window is
 * smaller than what an app would be told, and the app would find out only once its conversation
 * outgrew it. Handing it the served window says so at startup instead — an app with a floor above
 * it refuses there, which is the honest failure — and the warning names the fix.
 */
export function capHandoutAtServedWindow(input: {
  appSlug: string;
  engineId: string;
  backendType: InferenceBackendType;
  numCtx: number;
  /** The engine's `servedContextLength`, or null when it states none. */
  servedContextLength: number | null;
  minContextLength?: number;
}): { numCtx: number; notes: string[] } {
  const { appSlug, engineId, backendType, numCtx, servedContextLength: served } = input;
  if (served === null || !(served > 0) || served >= numCtx) {
    return { numCtx, notes: [] };
  }
  const floor = input.minContextLength ?? 0;
  const note =
    `${appSlug}: ${backendType} serves ${engineId} at ctx_size ${served}, below the ${numCtx} it would be handed, so it is handed ${served}` +
    (floor > served
      ? `, under its ${floor}-token floor, and may refuse to start; free memory on this node so the model loads at a larger window, or choose a smaller model.`
      : '.');
  return { numCtx: served, notes: [note] };
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
  /**
   * Whether the engine's server can supply `model` (`InferenceBackend.offersModel`). `false` refuses
   * the pull; `null` or absent means the engine cannot say, and the pull goes ahead as before.
   */
  engineOffers?: boolean | null;
}): PrePullDecision | null {
  const { kind, model } = input;
  if (!model) return null;
  const decide = (pull: boolean, reason: string): PrePullDecision => ({ kind, catalogId: model.id, pull, reason });

  if (input.cloudPrimary && kind === 'chat') return decide(false, 'a cloud provider is serving chat for this app');
  // Ollama and Lemonade download through the Hub (`ModelPullerService`). vLLM has no download API
  // (its model is fixed when the server starts). oMLX has one, `POST /admin/api/hf/download`, but it
  // needs an admin session from oMLX's main key, and the Hub does not use it.
  if (input.backendType !== 'ollama' && input.backendType !== 'lemonade') {
    return decide(false, `${input.backendType} has no Hub-managed pull registry`);
  }
  if (!input.endpointReady) return decide(false, `the local ${input.backendType} backend is not ready`);
  if (input.installedLocally) return decide(false, 'already installed on this node');
  // #1679 turned pre-pull on for Lemonade, whose registry varies by version: 10.2.0 (the fleet's)
  // lacks 13 of the catalog's Lemonade rows and answers a pull of one with a misleading error.
  if (input.engineOffers === false) {
    return decide(false, `the local ${input.backendType} server does not list ${model.backendModelId} in its model registry`);
  }
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
