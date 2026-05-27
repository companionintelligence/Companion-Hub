import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

export const sourcePlatformSchema = z.enum(['umbrel', 'casaos', 'synology', 'unraid', 'docker', 'runtipi']);

export const generateImportScriptSchema = z.object({
  platform: sourcePlatformSchema,
  description: z.string().min(1).max(8000),
});

export class GenerateImportScriptDto extends createZodDto(generateImportScriptSchema) {}

export const generateImportScriptResponseSchema = z.object({
  script: z.string(),
  platform: sourcePlatformSchema,
  warnings: z.array(z.string()).optional(),
});

export class GenerateImportScriptResponseDto extends createZodDto(generateImportScriptResponseSchema) {}

export const generateExportScriptResponseSchema = z.object({
  script: z.string(),
  composefile: z.string(),
  warnings: z.array(z.string()).optional(),
});

export class GenerateExportScriptResponseDto extends createZodDto(generateExportScriptResponseSchema) {}
