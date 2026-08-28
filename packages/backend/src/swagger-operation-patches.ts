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

/**
 * A custom domain the organization has connected, as the install dialog sees it.
 *
 * ⚠ `supported` IS NOT `domains.length > 0`. It answers whether CI-Cloud could be
 * asked at all — a deployment predating the route, or one that did not answer —
 * and the dialog owes those two states different sentences. "You have none, add
 * one in the portal" is wrong and misleading when the truth is "we could not
 * check". See CI-Hub#1181.
 */
const availableCustomDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  /*
   * ⚠ WIDER THAN IT LOOKS, AND DELIBERATELY OPEN AT THE EDGES. CI-Cloud reports
   * `securing` (proved, certificate still issuing — Cloudflare gates the two
   * independently) and `drifted` (the customer's records changed under it), and
   * will add more. `unknown` is what this Hub calls a state newer than itself:
   * the parser keeps such a row rather than dropping it, because a Hub is older
   * than the Portal it talks to for most of its life and a vanished domain reads
   * as "the Hub cannot see my domain".
   *
   * The state is a LABEL. `bindable` is the gate.
   */
  state: z.enum(['live', 'parked', 'pending', 'securing', 'drifted', 'unknown']),
  bindable: z.boolean(),
  targetHostname: z.string().nullable(),
  boundAppSlug: z.string().nullable(),
  boundElsewhere: z.boolean(),
});

export const availableCustomDomainsResponseSchema = z.object({
  supported: z.boolean(),
  domains: z.array(availableCustomDomainSchema),
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
  getCustomDomains: { schemaName: 'AvailableCustomDomainsResponseDto', schema: availableCustomDomainsResponseSchema },
  getStoreFeaturedBundle: { schemaName: 'FeaturedStoreBundleDto', schema: featuredStoreBundleSchema },
};
