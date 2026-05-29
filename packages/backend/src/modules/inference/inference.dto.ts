import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

export const inferenceBackendSchema = z.enum(['ollama', 'vllm', 'lemonade']);

export const inferencePreferencesSchema = z.object({
  backend: inferenceBackendSchema,
  // Optional preferred default model (catalog id) that Companion agents (Hermes, OpenClaw)
  // and the Hub use by default. `null` explicitly clears the stored preference.
  model: z.string().trim().min(1).nullable().optional(),
});

export class UpdateInferencePreferencesBody extends createZodDto(inferencePreferencesSchema) {}

export const runtimeModelsQuerySchema = z.object({
  backend: inferenceBackendSchema,
});

export class RuntimeModelsQueryDto extends createZodDto(runtimeModelsQuerySchema) {}
