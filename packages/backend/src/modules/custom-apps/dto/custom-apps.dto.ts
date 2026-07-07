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

export const createPortExposeAppSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1)
    .max(50),
  port: z.number().min(1024).max(65535),
  exposureMode: z.enum(['local', 'cloudflare', 'tailscale']),
  localSubdomain: z
    .string()
    .regex(/^[a-zA-Z0-9-]{1,63}$/)
    .optional(),
  publicDomain: z.string().trim().min(1).optional(),
});

export class CreateCustomAppDto extends createZodDto(createCustomAppSchema) {}

export class CreatePortExposeAppDto extends createZodDto(createPortExposeAppSchema) {}

export const updatePortExposeAppSchema = createPortExposeAppSchema.omit({ name: true });

export class UpdatePortExposeAppDto extends createZodDto(updatePortExposeAppSchema) {}

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
