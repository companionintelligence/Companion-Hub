import { z } from 'zod';
import type { ZodDto } from '@/common/zod-dto';
import { SearchAppsQueryDto } from '@/modules/marketplace/dto/marketplace.dto';
import { GetAppBackupsQueryDto } from '@/modules/backups/dto/backups.dto';
import { OnboardingProfileQueryDto, RuntimeModelsQueryDto, VllmStatusQueryDto } from '@/modules/inference/inference.dto';
import { StreamAppLogsQueryDto, StreamHubLogsQueryDto } from '@/core/sse/dto/sse.dto';

const availableDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  isDefault: z.boolean(),
  scope: z.string().optional(),
});

export const availableDomainsResponseSchema = z.object({
  domains: z.array(availableDomainSchema),
});

export const updateAdvancedModeBodySchema = z.object({
  advancedMode: z.boolean(),
});

export const setAutoUpdatesBodySchema = z.object({
  enabled: z.boolean(),
});

export const rehydrateBodySchema = z.object({
  force: z.boolean().optional(),
  source: z.literal('restore').optional(),
});

export const featuredStoreBundleSchema = z.object({
  firstParty: z.array(z.unknown()),
  featured: z.array(z.unknown()),
  trending: z.array(z.unknown()),
  newest: z.array(z.unknown()),
});

/** Query DTOs Nest does not reflect into OpenAPI for @Query() Zod classes. */
export const OPERATION_QUERY_DTOS: Record<string, ZodDto> = {
  searchApps: SearchAppsQueryDto,
  getRuntimeModels: RuntimeModelsQueryDto,
  getOnboardingProfile: OnboardingProfileQueryDto,
  getVllmStatus: VllmStatusQueryDto,
  getAppBackups: GetAppBackupsQueryDto,
  appLogsEvents: StreamAppLogsQueryDto,
  hubLogsEvents: StreamHubLogsQueryDto,
};

/** Inline @Body() types and missing request bodies. */
export const OPERATION_REQUEST_BODIES: Record<string, { schemaName: string; schema: z.ZodType }> = {
  updateAdvancedMode: { schemaName: 'UpdateAdvancedModeBody', schema: updateAdvancedModeBodySchema },
  setAutoUpdates: { schemaName: 'SetAutoUpdatesBody', schema: setAutoUpdatesBodySchema },
  executeRehydrate: { schemaName: 'RehydrateBody', schema: rehydrateBodySchema },
  startPullModel: {
    schemaName: 'StartPullModelBody',
    schema: z.object({ modelId: z.string(), bestEffort: z.boolean().optional() }),
  },
  pinModel: { schemaName: 'PinModelBody', schema: z.object({ modelId: z.string() }) },
  unpinModel: { schemaName: 'UnpinModelBody', schema: z.object({ modelId: z.string() }) },
  setCloudProvider: {
    schemaName: 'SetCloudProviderBody',
    schema: z.object({
      provider: z.enum(['openai', 'anthropic', 'google', 'github-copilot']),
      apiKey: z.string(),
      enabled: z.boolean(),
      baseUrl: z.string().optional(),
      defaultModel: z.string().optional(),
    }),
  },
  pairDevice: { schemaName: 'PairDeviceBody', schema: z.object({ pairing_code: z.string() }) },
  performUpdate: { schemaName: 'PerformUpdateBody', schema: z.object({ targetVersion: z.string().optional() }) },
};

/** Path params missing from Nest Zod DTO reflection. */
export const OPERATION_PATH_PARAMS: Record<string, Array<Record<string, unknown>>> = {
  verifyPasswordResetToken: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
};

/** @ApiResponse({ type: Object }) placeholders → concrete response schemas. */
export const OPERATION_RESPONSE_SCHEMAS: Record<string, { schemaName: string; schema: z.ZodType }> = {
  getDomains: { schemaName: 'AvailableDomainsResponseDto', schema: availableDomainsResponseSchema },
  getStoreFeaturedBundle: { schemaName: 'FeaturedStoreBundleDto', schema: featuredStoreBundleSchema },
};
