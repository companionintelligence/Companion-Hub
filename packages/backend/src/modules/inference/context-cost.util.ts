import type { CuratedModel, HardwareProfile, InferenceBackendType } from '@ci-hub/common/types';
import { clampOllamaSlots } from '@/common/helpers/inference-ollama-slots';
import type { InferenceBackend } from './backends/backend.interface';
import type { FootprintSighting } from './context-length.util';
import type { ContextCost } from './model-geometry.util';

/**
 * What a token of context costs `model` on `backend`, from the best source there is: the engine's
 * own measurement (Ollama's geometry and sightings) and the catalog's measured `kvMbPerToken`,
 * the smaller winning when both exist — both are biased high, and Ollama's formula over-estimates
 * several-fold whenever `/api/show` drops a per-layer `head_count_kv`. Weights come from the engine:
 * Ollama's `/api/tags`, or the files Lemonade lists. Null when neither can say, and the context
 * ladder then keeps its fixed assumption.
 *
 * The weights' size is dropped for a model whose catalog footprint was measured
 * (`runtime.footprintMeasured`). Context sizing charges the larger of that footprint and the file
 * plus runner overhead, and a file is no floor for such a model: gemma4:e4b's is 9,163 MiB, while
 * its weights, encoders and runtime hold 4,046-4,357 MiB, so the file would put back the refusal the
 * measurement fixed.
 *
 * Only meaningful for a model this node serves; a peer's engine cannot be asked from here.
 * Never throws: a probe that fails costs only the measurement.
 */
export async function probeContextCost(backend: InferenceBackend, model: CuratedModel): Promise<ContextCost | null> {
  const cost = await probeEngineAndCatalog(backend, model);
  return cost && model.runtime.footprintMeasured ? { ...cost, weightMb: null } : cost;
}

async function probeEngineAndCatalog(backend: InferenceBackend, model: CuratedModel): Promise<ContextCost | null> {
  const measured = await Promise.resolve(backend.contextCostForModel?.(model.backendModelId) ?? null).catch(() => null);
  const catalogKv = model.runtime.kvMbPerToken;
  if (typeof catalogKv !== 'number' || !Number.isFinite(catalogKv) || catalogKv <= 0) {
    return measured;
  }
  if (measured) {
    return catalogKv < measured.kvMbPerToken ? { ...measured, kvMbPerToken: catalogKv, source: 'catalog' } : measured;
  }
  const weightMb = await Promise.resolve(backend.weightsOnDiskMb?.(model.backendModelId) ?? null).catch(() => null);
  return { kvMbPerToken: catalogKv, weightMb, source: 'catalog' };
}

/**
 * The model families Ollama starts on a single slot whatever `OLLAMA_NUM_PARALLEL` says, as
 * `general.architecture` names them. Copied from Ollama 0.34.0 `server/sched.go` (`load`, "Some
 * architectures are not safe with num_parallel > 1"), the version the fleet runs. qwen3.8:27b is
 * `qwen35`, so the fleet's 27B is one of them and gemma4 is not.
 */
export const OLLAMA_SINGLE_SLOT_ARCHITECTURES: ReadonlySet<string> = new Set([
  'mllama',
  'qwen3vl',
  'qwen3vlmoe',
  'qwen35',
  'qwen35moe',
  'qwen3next',
  'lfm2',
  'lfm2moe',
  'nemotron_h',
  'nemotron_h_moe',
  'nemotron_h_omni',
]);

/**
 * Families whose one-slot geometry cost already exceeds what every slot of the fleet's Ollama holds,
 * so multiplying it by the slot count only compounds an over-estimate.
 *
 * `kvBytesPerToken` counts sliding-window layers as global because `/api/show` does not say which
 * layers slide. For gemma4 that is 0.09375 MiB a token, 6 GiB at 65536 for ONE sequence, while core-2
 * holds gemma4:e4b at a 65536 window on four slots in 3,437,095,812 bytes in all (`/api/ps`,
 * 2026-09-29) — weights included. Times four, the same arithmetic cut beta-1's handout for it from
 * 65536 to 16384. Only families measured that way belong here: gemma3's ratio of sliding to global
 * layers is smaller and has not been measured on the fleet, so it keeps the multiplication.
 */
export const GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES: ReadonlySet<string> = new Set(['gemma4']);

/**
 * How many sequences' KV cache a load of a model allocates on `backendType`: the `kvSlots` the
 * context sizing multiplies by.
 *
 * Only Ollama multiplies: it sizes its runner at `num_ctx × OLLAMA_NUM_PARALLEL`, and the fleet runs
 * four slots on core-2, beta-max and beta-red and two on core-7, so a window charged at one slot's
 * price was a quarter of what those nodes allocate. `statedSlots` is what the Hub knows of the slot
 * count — the engine's own statement, else the operator's `inferenceOllamaSlots` — and one when it
 * knows nothing, as before. One also for a family Ollama forces to a single slot, for a family whose
 * one-slot geometry already covers every slot ({@link GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES}), and
 * for a `calibrated` cost, which was measured across every slot already. Lemonade takes one
 * `ctx_size` for the whole server, so it is never multiplied.
 */
export function kvSequencesFor(backendType: InferenceBackendType, cost: ContextCost | null, statedSlots: unknown): number {
  if (backendType !== 'ollama') return 1;
  const slots = clampOllamaSlots(statedSlots);
  if (slots === null || slots <= 1) return 1;
  if (cost?.source === 'calibrated') return 1;
  if (cost?.architecture && OLLAMA_SINGLE_SLOT_ARCHITECTURES.has(cost.architecture)) return 1;
  if (cost?.source === 'geometry' && cost.architecture && GEOMETRY_COVERS_EVERY_SLOT_ARCHITECTURES.has(cost.architecture)) return 1;
  return slots;
}

/** What the handouts read to size a model this node serves; see {@link probeLocalSizing}. */
export interface LocalContextSizing {
  kvMbPerToken: number | null;
  weightMb: number | null;
  kvSlots: number;
  sighting: FootprintSighting | null;
}

/**
 * Everything the context sizing knows about `model` on this node's `backend`: the per-token cost,
 * the slots it is multiplied by, and what the engine was last seen holding for it. The app handouts
 * (`InferenceEnvResolver`, `AppCredentialsService`) read it here and the router's load path reads
 * the same three sources, so the window an app is told and the window its model is loaded at come
 * from one arithmetic. `sightings` is optional — without it the catalog base stands — and nothing
 * here throws.
 */
export async function probeLocalSizing(input: {
  backendType: InferenceBackendType;
  backend: InferenceBackend;
  model: CuratedModel;
  profile: HardwareProfile;
  /** The operator's `inferenceOllamaSlots`, consulted when the engine states no slot count itself. */
  statedOllamaSlots: unknown;
  sightings?: {
    footprintSighting(profile: HardwareProfile, backend: InferenceBackendType, backendModelId: string): Promise<FootprintSighting | null>;
  };
}): Promise<LocalContextSizing> {
  const { backendType, backend, model, profile } = input;
  const [cost, sighting] = await Promise.all([
    probeContextCost(backend, model),
    input.sightings
      ? Promise.resolve(input.sightings.footprintSighting(profile, backendType, model.backendModelId)).catch(() => null)
      : Promise.resolve(null),
  ]);
  const statedSlots = backend.engineCapabilities?.()?.slots ?? (backendType === 'ollama' ? input.statedOllamaSlots : null);
  return {
    kvMbPerToken: cost?.kvMbPerToken ?? null,
    weightMb: cost?.weightMb ?? null,
    kvSlots: kvSequencesFor(backendType, cost, statedSlots),
    sighting: sighting ?? null,
  };
}
