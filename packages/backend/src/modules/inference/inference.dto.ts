import { createZodDto } from '@/common/zod-dto';
import { MAX_INFERENCE_MAX_NUM_CTX, MIN_INFERENCE_MAX_NUM_CTX } from '@/common/helpers/inference-context-cap';
import { MAX_INFERENCE_OLLAMA_SLOTS, MIN_INFERENCE_OLLAMA_SLOTS } from '@/common/helpers/inference-ollama-slots';
import { INFERENCE_BACKEND_TYPES } from '@ci-hub/common/types';
import { z } from 'zod';

/**
 * Derived from the source tuple, never re-listed. This was one of several hand-written copies of the
 * backend list; the rest — the settings validator in app.dto.ts and the two MCP tool schemas in
 * mcp/tools/inference.tools.ts — were derived in the same change, so a backend added to
 * INFERENCE_BACKEND_TYPES can no longer be accepted by one edge and rejected by another. That
 * asymmetry was the real hazard: app.dto.ts gates settings.json, and a rejected settings object is
 * swallowed whole by the `catch` in configuration.service, so a drifted enum there would have
 * silently discarded every stored setting rather than failing loudly.
 *
 * Zod 4 takes the readonly `as const` tuple directly, so no widening cast is needed.
 */
const inferenceBackendSchema = z.enum(INFERENCE_BACKEND_TYPES);

export const inferencePreferencesSchema = z.object({
  backend: inferenceBackendSchema,
  // Optional preferred default model (catalog id) that Companion agents (Hermes, OpenClaw)
  // and the Hub use by default. `null` explicitly clears the stored preference.
  model: z.string().trim().min(1).nullable().optional(),
  // Default embedding model (catalog id). Used for RAG / memory apps.
  embeddingModel: z.string().trim().min(1).nullable().optional(),
  // Default vision-capable LLM (catalog id). Used for image-understanding tasks.
  visionModel: z.string().trim().min(1).nullable().optional(),
  vllmApiKey: z.string().trim().nullable().optional(),
  // Base URL of the operator's vLLM server (e.g. http://host.docker.internal:8000).
  // `null` clears the stored preference and falls back to the VLLM_URL env default.
  vllmUrl: z.string().trim().url().nullable().optional(),
  // Base URL of the operator's oMLX server (e.g. http://host.docker.internal:8000).
  // `null` clears the stored preference and falls back to OMLX_URL or the host default.
  omlxUrl: z.string().trim().url().nullable().optional(),
  // Manual path. Either may be set alone. Origins, not `/v1` suffixes: the resolver appends `/v1`
  // for decode. Encode is stored as typed and handed to apps as the embeddings host.
  decodeEndpoint: z.string().trim().url().nullable().optional(),
  encodeEndpoint: z.string().trim().url().nullable().optional(),
  // Ceiling on the `num_ctx` handed to apps, in tokens — set it to the engine's own context
  // (`OLLAMA_CONTEXT_LENGTH`) so no app asks for a window that reloads the model. `null` clears it,
  // which restores sizing from the model window and this node's memory alone.
  maxNumCtx: z.number().int().min(MIN_INFERENCE_MAX_NUM_CTX).max(MAX_INFERENCE_MAX_NUM_CTX).nullable().optional(),
  // How many requests this node's Ollama runs at once — set it to the daemon's `OLLAMA_NUM_PARALLEL`
  // so the pool can tell a full engine from a half-empty one. `null` clears it, which ranks this
  // node by queue depth alone again.
  ollamaSlots: z.number().int().min(MIN_INFERENCE_OLLAMA_SLOTS).max(MAX_INFERENCE_OLLAMA_SLOTS).nullable().optional(),
});

export class UpdateInferencePreferencesBody extends createZodDto(inferencePreferencesSchema) {}

/**
 * What the Hub shows in place of a stored key: `GET /api/inference/preferences` sends it for the vLLM
 * key, and Settings > AI shows it for a cloud provider key. A save that sends it back keeps the stored key.
 */
export const MASKED_API_KEY = '••••••••';

/** Whether a key in a save is that placeholder, which the UI sends back for an untouched field. */
export function isMaskedApiKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith('••');
}

/** Inference preferences as the API reports them: the stored vLLM key becomes {@link MASKED_API_KEY}. */
export function maskInferencePreferences<T extends { preferredVllmApiKey?: string | null }>(preferences: T): T {
  return preferences.preferredVllmApiKey ? { ...preferences, preferredVllmApiKey: MASKED_API_KEY } : preferences;
}

const runtimeModelsQuerySchema = z.object({
  backend: inferenceBackendSchema,
});

export class RuntimeModelsQueryDto extends createZodDto(runtimeModelsQuerySchema) {}

const onboardingProfileQuerySchema = z.object({
  backend: inferenceBackendSchema.optional(),
  // Candidate vLLM base URL the operator typed but has not saved yet — lets the profile's
  // installed-model resolution probe the same server the status card shows as detected.
  vllmUrl: z.string().trim().url().optional(),
  omlxUrl: z.string().trim().url().optional(),
  decodeEndpoint: z.string().trim().url().optional(),
  encodeEndpoint: z.string().trim().url().optional(),
});

export class OnboardingProfileQueryDto extends createZodDto(onboardingProfileQuerySchema) {}

const vllmStatusQuerySchema = z.object({
  // Same candidate-URL semantics as onboardingProfileQuerySchema.vllmUrl.
  url: z.string().trim().url().optional(),
});

export class VllmStatusQueryDto extends createZodDto(vllmStatusQuerySchema) {}

const omlxStatusQuerySchema = z.object({
  url: z.string().trim().url().optional(),
});

export class OmlxStatusQueryDto extends createZodDto(omlxStatusQuerySchema) {}

const manualEndpointStatusQuerySchema = z.object({
  url: z.string().trim().url(),
});

export class ManualEndpointStatusQueryDto extends createZodDto(manualEndpointStatusQuerySchema) {}

/**
 * A model to load or unload: a catalog id, or the name an engine holds a file under. `backend` names
 * the engine for a file the catalog does not know; a catalog id is routed without it.
 */
const modelOnBackendSchema = z.object({
  modelId: z.string(),
  backend: inferenceBackendSchema.optional(),
});

export class LoadModelBody extends createZodDto(modelOnBackendSchema) {}

export class UnloadModelBody extends createZodDto(modelOnBackendSchema) {}

export const rocmInstallPhaseSchema = z.enum(['idle', 'downloading', 'installing', 'reboot_required', 'failed', 'completed']);

const updateRocmInstallStateSchema = z.object({
  phase: rocmInstallPhaseSchema,
  message: z.string().optional(),
});

export class UpdateRocmInstallStateBody extends createZodDto(updateRocmInstallStateSchema) {}
