import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { canonicalTimeZone } from '@/common/helpers/timezone-helpers';
import { optionalCpuLimitSchema } from '@/common/validation/cpu-limit';
import { optionalMemoryLimitSchema } from '@/common/validation/memory-limit';

import { userSchema } from './modules/user/dto/user.dto';

import { LOG_LEVEL_ENUM } from './core/logger/logger.service';
import { appInfoObjectSchema } from '@ci-hub/common/schemas';

export const settingsSchema = z.object({
  advancedSettings: z.boolean(),
  allowAutoThemes: z.boolean(),
  allowErrorMonitoring: z.boolean(),
  appDataPath: z.string().trim(),
  appsRepoUrl: z.string().url().optional(),
  defaultAppCpuLimit: optionalCpuLimitSchema,
  defaultAppMemoryLimit: optionalMemoryLimitSchema,
  autoAllocateAppResources: z.boolean().optional(),
  demoMode: z.boolean(),
  disablePasswordReset: z.boolean(),
  dnsIp: z.string().ipv4(),
  domain: z.string().trim(),
  eventsTimeout: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(1).max(120)),
  forwardAuthUrl: z.string().url(),
  guestDashboard: z.boolean(),
  internalIp: z.string().ipv4(),
  listenIp: z.string().ipv4(),
  localDomain: z.string().trim(),
  logLevel: z.enum(LOG_LEVEL_ENUM),
  maxBackups: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(100)),
  persistTraefikConfig: z.boolean(),
  port: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  postgresPort: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  sslPort: z.union([z.number().int(), z.string().transform(Number)]).pipe(z.number().min(0).max(65535)),
  timeZone: z.string().trim(),
  experimental_insecureCookie: z.boolean().optional(),
  themeBase: z.string().optional(),
  themeColor: z.string().optional(),
  ciHubApiKey: z.string().trim().optional(),
  ciHubOrganizationId: z.string().trim().optional(),
  ciHubOrganizationSlug: z.string().trim().optional(),
  ciHubOrganizationLabel: z.string().trim().optional(),
  ciHubDeviceSlug: z.string().trim().optional(),
  ciHubHubSubdomain: z.string().trim().optional(),
  inferenceBackend: z.enum(['ollama', 'vllm', 'lemonade', 'mtplx', 'dspark', 'lucebox']).optional(),
  inferenceModel: z.string().trim().optional(),
  inferenceEmbeddingModel: z.string().trim().optional(),
  inferenceVisionModel: z.string().trim().optional(),
  inferenceVllmApiKey: z.string().trim().optional(),
  inferenceVllmUrl: z.string().trim().optional(),
  inferenceMtplxUrl: z.string().trim().optional(),
  inferenceDsparkUrl: z.string().trim().optional(),
  inferenceCloudProviders: z
    .array(
      z.object({
        provider: z.enum(['openai', 'anthropic', 'google', 'github-copilot']),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string(),
        enabled: z.boolean(),
      }),
    )
    .optional(),
  // No MCP settings live here. SEC-MCP-8 moved MCP credentials into the hashed key store (Settings →
  // Security / `cihub api-key create`), and ISSUE-MCP-2's destructive gate became each key's
  // `capability` column — so neither an unrevocable second credential nor an appliance-wide authority
  // switch can be introduced through settings.json.
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

const versionSchema = z.object({
  current: z.string(),
  latest: z.string(),
  body: z.string(),
  releases: z.array(z.object({ version: z.string(), body: z.string() })),
});

const appContextSchema = z.object({
  version: versionSchema,
  userSettings: settingsSchema,
  // Absolute host path of the root app-data folder (parent of every app's data).
  // Used by the Settings "Open app data folder" button; null when unresolved.
  appDataRootHostPath: z.string().nullable().optional(),
  // Host CPU architecture apps are installed against (from ARCHITECTURE / host probe).
  architecture: z.enum(['amd64', 'arm64']),
  user: userSchema,
  apps: z.array(simpleAppInfoSchema),
  updatesAvailable: z.number(),
  isProduction: z.boolean(),
  cloudflareAvailable: z.boolean(),
  tailscaleAvailable: z.boolean(),
  tailscaleNodeFqdn: z.string().trim().nullable().optional(),
  tailscaleSupportsServices: z.boolean().optional(),
  tailscaleHttpsEnabled: z.boolean().optional(),
});

// timeZone is validated here, on the WRITE path only — deliberately not on `settingsSchema`
// itself. That base schema also parses settings.json at boot (generateSystemEnvFile), where an
// invalid persisted zone must degrade gracefully to the host zone, not fail the parse and take
// down boot. Rejecting it here means a bad zone gets a 400 at the moment it is chosen instead of
// being persisted and silently overridden on every subsequent boot.
export class UserSettingsBody extends createZodDto(
  settingsSchema.partial().extend({
    timeZone: z
      .string()
      .trim()
      .refine((zone) => canonicalTimeZone(zone) !== undefined, { message: 'Must be a valid IANA time zone (e.g. Europe/Berlin)' })
      // Persist ICU's canonical form ('america/new_york' → 'America/New_York'), so settings.json
      // never holds a case-variant that the boot path would have to repair on every start.
      .transform((zone) => canonicalTimeZone(zone) as string)
      .optional(),
  }),
) {}

export type { z as ZodType } from 'zod';

export class AppContextDto extends createZodDto(appContextSchema) {}

const userContextDto = z.object({
  version: z.object({
    current: z.string(),
    latest: z.string(),
    body: z.string(),
    releases: z.array(z.object({ version: z.string(), body: z.string() })),
  }),
  isLoggedIn: z.boolean(),
  isConfigured: z.boolean(),
  isGuestDashboardEnabled: z.boolean(),
  isPasswordResetDisabled: z.boolean(),
  allowAutoThemes: z.boolean(),
  allowErrorMonitoring: z.boolean(),
  themeColor: z.string(),
  themeBase: z.string(),
  localDomain: z.string(),
  domain: z.string(),
  sslPort: z.number(),
  sessionExpiresAt: z.number().optional(),
  sessionRefreshRecommendedAt: z.number().optional(),
});

export class UserContextDto extends createZodDto(userContextDto) {}

export class AcknowledgeWelcomeBody extends createZodDto(z.object({ allowErrorMonitoring: z.boolean() })) {}
