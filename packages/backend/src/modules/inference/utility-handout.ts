import type { CuratedModel, HardwareProfile } from '@ci-hub/common/types';

/**
 * Memory kept back from the chat + utility pair: KV cache for both, the display, the engine's own
 * scratch. The catalog's `recommendedVramMb` is weights-plus-headroom for one model at a typical
 * window; two models sharing a card each still need their own cache, so the pair is not judged
 * against the whole budget.
 */
const PAIR_RESERVE_MB = 2_048;

/**
 * The model an app should run its background work on: extraction, classification, titling — the
 * hundreds of short calls Companion Memory makes for every chat turn a person types. On a card that
 * can hold a small model *beside* the chat model, those calls belong on the small one: they need
 * no 27B, and routing them there keeps the chat model's slot free for the person.
 *
 * Until 2026-09-30 the Hub handed out no utility model, and Memory's compiled-in default
 * (`gemma4:e4b`, an Ollama tag) was never served by a Lemonade or vLLM host — Memory then warned and
 * ran every utility call on the chat model, which on Kyle's box meant the 27B labelled photos and
 * titled threads. The rule here:
 *
 * 1. Only a model the engine already has (`installed`): the handout must name something the app
 *    can call now, not a download to come.
 * 2. Smaller than the chat model, and the two must fit the host's inference memory together with
 *    {@link PAIR_RESERVE_MB} to spare. A utility model that evicts the chat model would make every
 *    background call cost a reload — the thrash this exists to avoid.
 * 3. The smallest such model, on the active engine, that can chat (a utility call is a chat call
 *    with a schema): an embedder or reranker never qualifies, whatever its size.
 * 4. Otherwise the chat model itself. Always answered, so the app never falls back to a default it
 *    was compiled with for another engine.
 *
 * Pure: the resolver passes in what it already knows. `chat` is undefined when no chat model could
 * be chosen at all, and then there is no utility model either.
 */
export function pickUtilityModel(input: {
  chat: CuratedModel | undefined;
  /** Catalog LLMs on the active engine that the engine has installed, any order. */
  installed: readonly CuratedModel[];
  profile: Pick<HardwareProfile, 'effectiveInferenceMemoryMb'>;
}): CuratedModel | undefined {
  const { chat, installed, profile } = input;

  if (!chat) {
    return undefined;
  }

  const chatMb = footprintMb(chat);
  const budgetMb = profile.effectiveInferenceMemoryMb - PAIR_RESERVE_MB;

  // `modality === 'llm'` is the chat test: embedders, rerankers and speech models are other
  // modalities, and an LLM without tool calling still takes a schema-constrained chat call.
  const fits = installed
    .filter((model) => model.id !== chat.id && model.backend === chat.backend && model.modality === 'llm')
    .filter((model) => footprintMb(model) < chatMb && chatMb + footprintMb(model) <= budgetMb)
    .sort((a, b) => footprintMb(a) - footprintMb(b));

  return fits[0] ?? chat;
}

/** What the catalog says the model occupies at rest: the recommended figure, else the minimum. */
function footprintMb(model: CuratedModel): number {
  return model.requirements.recommendedVramMb || model.requirements.minVramMb || 0;
}
