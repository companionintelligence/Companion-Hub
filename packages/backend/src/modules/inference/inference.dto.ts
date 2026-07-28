import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

const inferenceBackendSchema = z.enum(['ollama', 'vllm', 'lemonade']);

export const inferencePreferencesSchema = z.object({
  backend: inferenceBackendSchema,
  // Optional preferred default model (catalog id) that Companion agents (Hermes, OpenClaw)
  // and the Hub use by default. `null` explicitly clears the stored preference.
  model: z.string().trim().min(1).nullable().optional(),
  // Default embedding model (catalog id). Used for RAG / memory apps.
  embeddingModel: z.string().trim().min(1).nullable().optional(),
  // Default vision-capable LLM (catalog id). Used for image-understanding tasks.
  visionModel: z.string().trim().min(1).nullable().optional(),
});

export class UpdateInferencePreferencesBody extends createZodDto(inferencePreferencesSchema) {}

const runtimeModelsQuerySchema = z.object({
  backend: inferenceBackendSchema,
});

export class RuntimeModelsQueryDto extends createZodDto(runtimeModelsQuerySchema) {}

export const rocmInstallPhaseSchema = z.enum(['idle', 'downloading', 'installing', 'reboot_required', 'failed', 'completed']);

const updateRocmInstallStateSchema = z.object({
  phase: rocmInstallPhaseSchema,
  message: z.string().optional(),
});

export class UpdateRocmInstallStateBody extends createZodDto(updateRocmInstallStateSchema) {}
