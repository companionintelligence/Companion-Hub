import { APP_CATEGORIES, appInfoObjectSchema } from '@ci-hub/common/schemas';
import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const metadataSchema = z.object({
  hasCustomConfig: z.boolean().optional(),
  latestVersion: z.number(),
  minHubVersion: z.string().nullable().optional(),
  latestDockerVersion: z.string().optional(),
  composeSchemaVersion: z.number().optional(),
});

const searchAppQuerySchema = z.object({
  search: z.string().optional(),
  pageSize: z.union([z.number().int(), z.string().transform(Number)]).optional(),
  cursor: z.string().optional(),
  category: z.enum(APP_CATEGORIES).optional(),
  storeId: z.string().optional(),
});

const simpleAppInfoSchema = appInfoObjectSchema.pick({
  id: true,
  urn: true,
  name: true,
  short_desc: true,
  categories: true,
  deprecated: true,
  created_at: true,
  supported_architectures: true,
  available: true,
});

const searchAppsResponseSchema = z.object({
  data: z.array(simpleAppInfoSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number(),
});

const successResponseSchema = z.object({
  success: z.boolean(),
});

const appStoreSchema = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
});

const allAppStoresSchema = z.object({
  appStores: z.array(appStoreSchema),
});

const updateAppStoreBodySchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});

const createAppStoreBodySchema = z.object({
  name: z.string().min(1).max(16),
  url: z.string().url(),
});

// App info
export class MetadataDto extends createZodDto(metadataSchema) {}

// Search apps
export class SearchAppsQueryDto extends createZodDto(searchAppQuerySchema) {}
export class SearchAppsDto extends createZodDto(searchAppsResponseSchema) {}

// Pull
export class PullDto extends createZodDto(successResponseSchema) {}

// App stores
export class AppStoreDto extends createZodDto(appStoreSchema) {}
export class AllAppStoresDto extends createZodDto(allAppStoresSchema) {}
export class UpdateAppStoreBodyDto extends createZodDto(updateAppStoreBodySchema) {}
export class CreateAppStoreBodyDto extends createZodDto(createAppStoreBodySchema) {}
export class UpdateAppStoreDto extends createZodDto(successResponseSchema) {}
