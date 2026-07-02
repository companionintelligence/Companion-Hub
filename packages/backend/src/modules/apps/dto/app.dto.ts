import { APP_STATUS } from '@/core/database/drizzle/types';
import { MetadataDto } from '@/modules/marketplace/dto/marketplace.dto';
import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { appInfoSchema } from '@ci-hub/common/schemas';

const metadataSchema = (MetadataDto as unknown as { schema: z.ZodType }).schema;
const appInfoSchemaRef = appInfoSchema;

const appSchema = z.object({
  id: z.number(),
  port: z.number().nullable(),
  status: z.enum(APP_STATUS),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  version: z.number(),
  exposed: z.boolean(),
  openPort: z.boolean(),
  exposedLocal: z.boolean(),
  domain: z.string().nullable(),
  isVisibleOnGuestDashboard: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
  enableAuth: z.boolean().optional(),
  localSubdomain: z.string().nullable().optional(),
  exposureMode: z.enum(['local', 'cloudflare', 'tailscale']).optional(),
  publicDomain: z.string().nullable().optional(),
  pendingRestart: z.boolean(),
  ignoredVersion: z.number().nullable(),
});

const myAppsSchema = z.object({
  installed: z.array(
    z.object({
      app: appSchema,
      info: appInfoSchemaRef,
      metadata: metadataSchema,
    }),
  ),
});

const getAppSchema = z.object({
  app: appSchema.nullable().optional(),
  info: appInfoSchemaRef,
  metadata: metadataSchema,
  // Absolute host path of the app's data folder (…/app-data/{store}/{app}).
  // Used by the desktop "Open data folder" button; null when it can't be resolved.
  appDataHostPath: z.string().nullable().optional(),
});

const getRandomPortSchema = z.object({
  port: z.number(),
});

const getComposeDiff = z.object({
  current: z.string().nullable(),
  new: z.string().nullable(),
});

const getConfigDiffSchema = z.object({
  current: z.string().nullable(),
  new: z.string().nullable(),
});

export class MyAppsDto extends createZodDto(myAppsSchema) {}
export class GuestAppsDto extends createZodDto(myAppsSchema) {}
export class GetAppDto extends createZodDto(getAppSchema) {}
export class GetRandomPortDto extends createZodDto(getRandomPortSchema) {}
export class GetConfigDiffDto extends createZodDto(getConfigDiffSchema) {}
export class GetComposeDiffDto extends createZodDto(getComposeDiff) {}
