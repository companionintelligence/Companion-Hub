import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { dynamicComposeSchema } from '@ci-hub/common/schemas';

export const createCustomAppSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(50),
  config: dynamicComposeSchema,
});

export class CreateCustomAppDto extends createZodDto(createCustomAppSchema) {}

export const createCustomAppResponseSchema = z.object({
  appUrn: z.string(),
  appName: z.string(),
  storeId: z.string(),
});

export class CreateCustomAppResponseDto extends createZodDto(createCustomAppResponseSchema) {}

export const updateCustomAppSchema = z.object({
  config: dynamicComposeSchema,
});

export class UpdateCustomAppDto extends createZodDto(updateCustomAppSchema) {}

export const updateAppMetadataDto = z.object({
  data: z.string(),
});

export class UpdateAppMetadataDto extends createZodDto(updateAppMetadataDto) {}
