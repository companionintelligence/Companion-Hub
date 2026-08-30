import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

const inferenceBackendSchema = z.enum(['ollama', 'vllm', 'lemonade', 'dspark']);

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
  // Base URL of the operator's mlx-dspark server (e.g. http://host.docker.internal:8080).
  // `null` clears the stored preference and falls back to the DSPARK_URL env default.
  dsparkUrl: z.string().trim().url().nullable().optional(),
});

export class UpdateInferencePreferencesBody extends createZodDto(inferencePreferencesSchema) {}

const runtimeModelsQuerySchema = z.object({
  backend: inferenceBackendSchema,
});

export class RuntimeModelsQueryDto extends createZodDto(runtimeModelsQuerySchema) {}

const onboardingProfileQuerySchema = z.object({
  backend: inferenceBackendSchema.optional(),
  // Candidate vLLM base URL the operator typed but has not saved yet — lets the profile's
  // installed-model resolution probe the same server the status card shows as detected.
  vllmUrl: z.string().trim().url().optional(),
  // Same candidate-URL semantics, for the mlx-dspark backend.
  dsparkUrl: z.string().trim().url().optional(),
});

export class OnboardingProfileQueryDto extends createZodDto(onboardingProfileQuerySchema) {}

const vllmStatusQuerySchema = z.object({
  // Same candidate-URL semantics as onboardingProfileQuerySchema.vllmUrl.
  url: z.string().trim().url().optional(),
});

export class VllmStatusQueryDto extends createZodDto(vllmStatusQuerySchema) {}

const dsparkStatusQuerySchema = z.object({
  // Same candidate-URL semantics as onboardingProfileQuerySchema.dsparkUrl.
  url: z.string().trim().url().optional(),
});

export class DsparkStatusQueryDto extends createZodDto(dsparkStatusQuerySchema) {}

export const rocmInstallPhaseSchema = z.enum(['idle', 'downloading', 'installing', 'reboot_required', 'failed', 'completed']);

const updateRocmInstallStateSchema = z.object({
  phase: rocmInstallPhaseSchema,
  message: z.string().optional(),
});

export class UpdateRocmInstallStateBody extends createZodDto(updateRocmInstallStateSchema) {}
