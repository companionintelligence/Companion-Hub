import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

export const inferenceBackendSchema = z.enum(['ollama', 'vllm', 'lemonade']);

export const inferencePreferencesSchema = z.object({
  backend: inferenceBackendSchema,
});

export class UpdateInferencePreferencesBody extends createZodDto(inferencePreferencesSchema) {}

export const runtimeModelsQuerySchema = z.object({
  backend: inferenceBackendSchema,
});

export class RuntimeModelsQueryDto extends createZodDto(runtimeModelsQuerySchema) {}
