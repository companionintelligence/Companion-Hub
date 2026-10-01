import { z } from 'zod';
import type { ZodDto } from '@/common/zod-dto';
import { SearchAppsQueryDto } from '@/modules/marketplace/dto/marketplace.dto';
import { GetAppBackupsQueryDto } from '@/modules/backups/dto/backups.dto';
import {
  ManualEndpointStatusQueryDto,
  OmlxStatusQueryDto,
  OnboardingProfileQueryDto,
  RuntimeModelsQueryDto,
  VllmStatusQueryDto,
} from '@/modules/inference/inference.dto';
import { DeletePoolPinQuery, RoutingLogQueryDto } from '@/modules/hub-pool/hub-pool.dto';
import { StreamAppLogsQueryDto, StreamHubLogsQueryDto } from '@/core/sse/dto/sse.dto';
import { dnsAvailabilitySchema } from '@/modules/cloudflare/dns-availability';
import { DesktopReleaseQueryDto } from '@/modules/system-update/dto/desktop-release.dto';

const availableDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  isDefault: z.boolean(),
  scope: z.string().optional(),
  offered: z.boolean().optional(),
});

/**
 * `supported` has the custom-domain list's meaning: whether Companion Portal
 * answered. An empty `domains` with `supported: true` is a Portal offering
 * nothing; with `supported: false` the Hub never got a list.
 */
export const availableDomainsResponseSchema = z.object({
  supported: z.boolean(),
  domains: z.array(availableDomainSchema),
});

/**
 * Describes a connected custom domain as shown in the install dialog.
 *
 * `supported` does not mean `domains.length > 0`. It indicates whether Companion
 * Portal could answer the request. The dialog must distinguish an empty domain
 * list from an older or unavailable Portal, which cannot provide a list. See
 * CI-Hub#1181.
 */
const availableCustomDomainSchema = z.object({
  id: z.string(),
  domain: z.string(),
  /*
   * Keep this state set broader than the initial domain lifecycle. Companion
   * Portal reports `securing` when verification succeeds before certificate
   * issuance and `drifted` when customer DNS changes later. Cloudflare evaluates
   * those conditions independently, and the Portal can add more states.
   *
   * Map states unknown to this Hub to `unknown` and retain the row. Hub versions
   * often lag behind the Portal, and dropping a newer state would make a connected
   * domain disappear. Treat `state` as a display label and `bindable` as the gate.
   */
  state: z.enum(['live', 'parked', 'pending', 'securing', 'drifted', 'failed', 'unknown']),
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

/** Adds query DTOs that Nest cannot reflect from `@Query()` Zod classes. */
export const OPERATION_QUERY_DTOS: Record<string, ZodDto> = {
  searchApps: SearchAppsQueryDto,
  getRuntimeModels: RuntimeModelsQueryDto,
  getPoolRoutingLog: RoutingLogQueryDto,
  deletePoolPin: DeletePoolPinQuery,
  getOnboardingProfile: OnboardingProfileQueryDto,
  getVllmStatus: VllmStatusQueryDto,
  getOmlxStatus: OmlxStatusQueryDto,
  getManualEndpointStatus: ManualEndpointStatusQueryDto,
  getAppBackups: GetAppBackupsQueryDto,
  appLogsEvents: StreamAppLogsQueryDto,
  hubLogsEvents: StreamHubLogsQueryDto,
  getDesktopRelease: DesktopReleaseQueryDto,
};

/** Adds inline `@Body()` types and request bodies missing from reflection. */
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
  unloadModel: { schemaName: 'UnloadModelBody', schema: z.object({ modelId: z.string() }) },
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

/** Adds path parameters missing from Nest Zod DTO reflection. */
export const OPERATION_PATH_PARAMS: Record<string, Array<Record<string, unknown>>> = {
  verifyPasswordResetToken: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
  // The route has a query DTO, and the query patch replaces the parameter list it reflected, `urn` included.
  getAppBackups: [{ name: 'urn', in: 'path', required: true, schema: { type: 'string' } }],
};

/** Replaces `@ApiResponse({ type: Object })` placeholders with concrete schemas. */
export const OPERATION_RESPONSE_SCHEMAS: Record<string, { schemaName: string; schema: z.ZodType }> = {
  getDomains: { schemaName: 'AvailableDomainsResponseDto', schema: availableDomainsResponseSchema },
  getCustomDomains: { schemaName: 'AvailableCustomDomainsResponseDto', schema: availableCustomDomainsResponseSchema },
  checkDnsAvailability: { schemaName: 'DnsAvailabilityResponseDto', schema: dnsAvailabilitySchema },
  getStoreFeaturedBundle: { schemaName: 'FeaturedStoreBundleDto', schema: featuredStoreBundleSchema },
};
