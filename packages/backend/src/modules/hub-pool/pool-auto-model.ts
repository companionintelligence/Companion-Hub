import type { CuratedModel, InferenceBackendType } from '@ci-hub/common/types';
import { sameModelId } from '@/common/helpers/hub-pool';

/**
 * What the `auto` alias stands for on a pooled route: the most capable chat model the POOL can serve.
 *
 * It used to mean "this node's default", resolved through `InferenceRouterService.resolveAutoModel`
 * against the entry node alone, and the in-appliance probe of all 16 fleet Hubs at dac546bcf showed
 * what that picked: core-6 → `gemma4:e2b`, core-4 → `gemma3:1b` (no tool calling at all), beta-ms-a2
 * and beta-3-glass → `deepseek-r1:8b`, beta-1 → `north-mini-code-1.0`. After the operator's setting,
 * that resolution took whichever LLM the in-memory registry had pinned or loaded — state set as a side
 * effect of onboarding and pulls, and cleared by a restart — and then the first chat model the engine
 * listed. Ollama lists newest pull first: beta-ms-a2 has no Settings → Inference model, and its list
 * read `nomic-embed-text`, `deepseek-r1:8b`, … with `qwen3.6:27b` and `qwen3.8:27b` further down.
 * None of those is a choice anyone made.
 *
 * And a node with no LLM of its own answered 502 while its peers held a dozen, because the
 * resolution never looked past the entry node. OpenClaw's installed config sends `auto` on every
 * turn, so all of that decided which model ran the fleet's agent traffic.
 *
 * core-6's `gemma4:e2b` is the exception, and this order keeps it: its Settings → Inference model is
 * `gemma4-e2b` (read back 2026-09-17, as is beta-max's `gemma4-e4b`). That is key 1 below doing its
 * job, and it is changed in Settings, not here.
 *
 * The order, and why each key sits where it does:
 *
 *   1. **The operator's Settings → Inference model**, wherever in the pool it is served. The one
 *      signal that is a decision, so it beats every heuristic below — a tiny or tool-less model the
 *      operator chose is still honoured, and so is a `:cloud` tag, which was looked at. The only
 *      thing it cannot override is the chat filter: an embedding model set there is a
 *      misconfiguration, and running a chat turn on it fails anyway.
 *   2. **Tool calling**: known yes, then unknown, then known no. Agents are the traffic `auto`
 *      carries, and a model the catalog says has no tool support (`gemma3:1b`) breaks every agent
 *      turn that uses one. Unknown (an uncatalogued tag) sits between, because it may well have them.
 *   3. **Not tiny** (fewer than {@link AUTO_MIN_PARAMS_B} B parameters, from the catalog or from the
 *      tag's size): a 1–4 B model will call tools, badly, and two of the five picks above were one.
 *   4. **Intelligence index**, highest first — the same Artificial Analysis figure the hardware
 *      recommender ranks on (`compareLlmCandidates`), with the same rule that an unmeasured model
 *      scores 0: capability that has not been measured is not claimed.
 *   5. **Parameter count**, larger first; unknown counts as 0 for the same reason.
 *   6. **Breadth**: more nodes serving it first. Between two models that are otherwise equal, the
 *      one on more nodes spreads the load and survives a node going down.
 *   7. **On this node**, then the model id, so the answer is deterministic.
 *
 * What is deliberately NOT a key: the catalog's `purpose: 'reasoning'`. It reads like "thinking-only"
 * and it is not: `qwen3.8:27b` carries it and is the highest-scoring model on the fleet (index 33.9),
 * as does the whole Qwen 3.5 family, which are hybrid thinkers. Demoting it would have preferred
 * weaker models to dodge a label; `deepseek-r1:8b` loses to every capable model above on its own
 * score (8.1).
 *
 * What the ranking never picks: embedding and rerank models, and `:cloud` tags. An Ollama signed
 * into Ollama Cloud lists `gpt-oss:120b-cloud`-style tags next to local ones, and running one sends
 * the prompt off the appliance — the catalog refuses those rows for the same reason ("LOCAL ONLY" in
 * `curated-models.ts`), and an alias nobody looked at must not be the way a prompt leaves the box.
 *
 * A known consequence, stated so it is not mistaken for a bug: every Hub in a pool resolves `auto`
 * to the same model, so the nodes holding it carry all of the pool's `auto` traffic. The candidate
 * ranking spreads it across those nodes by queue depth; it does not trade capability for spread. An
 * operator who wants a different trade sets Settings → Inference, which is key 1.
 */

/** Below this many billion parameters a model counts as tiny for `auto`. `gemma4:e2b` (2 B) is tiny; `qwen2.5-coder:7b` is not. */
export const AUTO_MIN_PARAMS_B = 7;

/** One node's servable inventory, reduced to what `auto` resolution reads. */
export interface NodeModelInventory {
  local: boolean;
  backends: ReadonlyArray<{ type: InferenceBackendType; models: readonly string[] }>;
}

/** A model some node in the pool can serve right now, as the pool sees it. */
export interface PoolModelOffer {
  /** The engine id as the first node that listed it spells it — the spelling candidate matching reads. */
  model: string;
  backends: InferenceBackendType[];
  /** Whether this node's own engines list it. */
  local: boolean;
  /** How many nodes (this one included) list it. */
  nodes: number;
}

/** The operator's chat-model preference, reduced to an engine id and, when the catalog knows it, the backend it runs on. */
export interface AutoModelPreference {
  engineId: string;
  backend?: InferenceBackendType;
}

export interface AutoModelChoice {
  model: string;
  reason: 'preferred' | 'ranked';
}

/**
 * Merge per-node inventories into one offer per model. `name` and `name:latest` fold into one offer
 * (`sameModelId`), because candidate matching folds them too — two offers for one model would split
 * its breadth and could rank it below a rarer one.
 */
export function collectPoolModelOffers(nodes: readonly NodeModelInventory[]): PoolModelOffer[] {
  const offers: PoolModelOffer[] = [];
  for (const node of nodes) {
    const seenOnThisNode = new Set<PoolModelOffer>();
    for (const backend of node.backends) {
      for (const model of backend.models) {
        let offer = offers.find((existing) => sameModelId(existing.model, model));
        if (!offer) {
          offer = { model, backends: [], local: false, nodes: 0 };
          offers.push(offer);
        }
        if (!offer.backends.includes(backend.type)) offer.backends.push(backend.type);
        offer.local ||= node.local;
        if (!seenOnThisNode.has(offer)) {
          seenOnThisNode.add(offer);
          offer.nodes += 1;
        }
      }
    }
  }
  return offers;
}

/** The catalog row describing an offer, preferring one whose backend actually lists it. */
export function catalogEntryFor(offer: PoolModelOffer, catalog: readonly CuratedModel[]): CuratedModel | undefined {
  const rows = catalog.filter((row) => sameModelId(row.backendModelId, offer.model));
  return rows.find((row) => offer.backends.includes(row.backend)) ?? rows[0];
}

/**
 * Ollama-library embedding and rerank families whose names do not say "embed" (`all-minilm`,
 * `bge-m3`, `bge-large`, `paraphrase-multilingual`). Only consulted for a tag the catalog does not
 * describe; a catalogued model answers by its modality.
 */
const UNCATALOGUED_NON_CHAT = /embed|rerank|minilm|(?:^|\/)bge[-:]|paraphrase-multilingual/i;

/** The tag of an engine id: everything after the first `:` that follows the last `/`, so a registry host's port is never read as one. */
function tagOf(model: string): string {
  const name = model.slice(model.lastIndexOf('/') + 1);
  const colon = name.indexOf(':');
  return colon === -1 ? '' : name.slice(colon + 1);
}

/** An Ollama Cloud tag: `glm-4.6:cloud`, `gpt-oss:120b-cloud`. */
export function isCloudProxiedTag(model: string): boolean {
  return /(?:^|-)cloud$/i.test(tagOf(model));
}

/** Whether the offer can run a chat turn at all: a catalogued model by its modality, anything else by its name. */
function isChatModel(offer: PoolModelOffer, entry: CuratedModel | undefined): boolean {
  if (entry) return entry.modality === 'llm';
  return !UNCATALOGUED_NON_CHAT.test(offer.model);
}

/** Whether the ranking may pick this offer for `auto` on its own: a chat model, and not one that runs off the appliance. */
export function isAutoChatCandidate(offer: PoolModelOffer, entry: CuratedModel | undefined): boolean {
  return !isCloudProxiedTag(offer.model) && isChatModel(offer, entry);
}

/**
 * Parameter count in billions read off a tag the catalog does not describe — `gemma3:1b-cpu` → 1,
 * `qwen2.5:0.5b` → 0.5, `gemma3n:e4b` → 4, `smollm2:135m` → 0.135. Only the tag is read, never the
 * family name, so `qwen2.5` is not mistaken for a size. `undefined` when the tag names none
 * (`llama3.2:latest`).
 */
export function parameterScaleFromTag(model: string): number | undefined {
  const match = tagOf(model).match(/(?:^|[-_])e?(\d+(?:\.\d+)?)([bm])(?=$|[-_.])/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === 'm' ? value / 1000 : value;
}

interface RankKeys {
  offer: PoolModelOffer;
  tools: number;
  tiny: number;
  intelligence: number;
  params: number;
}

function rankKeys(offer: PoolModelOffer, entry: CuratedModel | undefined): RankKeys {
  const tools = entry?.metadata?.capabilities?.tools;
  const params = entry?.parameterScale ?? parameterScaleFromTag(offer.model);
  return {
    offer,
    tools: tools === true ? 0 : tools === undefined ? 1 : 2,
    tiny: params !== undefined && params < AUTO_MIN_PARAMS_B ? 1 : 0,
    intelligence: entry?.metadata?.intelligenceIndex ?? 0,
    params: params ?? 0,
  };
}

function compareRankKeys(a: RankKeys, b: RankKeys): number {
  return (
    a.tools - b.tools ||
    a.tiny - b.tiny ||
    b.intelligence - a.intelligence ||
    b.params - a.params ||
    b.offer.nodes - a.offer.nodes ||
    Number(b.offer.local) - Number(a.offer.local) ||
    (a.offer.model < b.offer.model ? -1 : a.offer.model > b.offer.model ? 1 : 0)
  );
}

/** Every chat-capable offer, best first, by keys 2–7 of the order described at the top of this file. Exported for tests and diagnostics. */
export function rankAutoModelOffers(offers: readonly PoolModelOffer[], catalog: readonly CuratedModel[]): PoolModelOffer[] {
  return offers
    .map((offer) => ({ offer, entry: catalogEntryFor(offer, catalog) }))
    .filter(({ offer, entry }) => isAutoChatCandidate(offer, entry))
    .map(({ offer, entry }) => rankKeys(offer, entry))
    .sort(compareRankKeys)
    .map((keys) => keys.offer);
}

/** The model `auto` stands for, or `undefined` when nothing in the pool can chat. */
export function chooseAutoModel(
  offers: readonly PoolModelOffer[],
  options: { preferred?: AutoModelPreference | null; catalog: readonly CuratedModel[] },
): AutoModelChoice | undefined {
  const { preferred, catalog } = options;
  if (preferred) {
    const match = offers.find(
      (offer) =>
        sameModelId(offer.model, preferred.engineId) &&
        (preferred.backend === undefined || offer.backends.includes(preferred.backend)) &&
        // Not `isAutoChatCandidate`: an operator who names a cloud tag in Settings has looked at it.
        isChatModel(offer, catalogEntryFor(offer, catalog)),
    );
    if (match) return { model: match.model, reason: 'preferred' };
  }
  const best = rankAutoModelOffers(offers, catalog)[0];
  return best ? { model: best.model, reason: 'ranked' } : undefined;
}
