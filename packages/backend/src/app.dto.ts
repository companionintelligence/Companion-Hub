import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
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
  inferenceBackend: z.enum(['ollama', 'vllm', 'lemonade']).optional(),
  inferenceModel: z.string().trim().optional(),
  inferenceEmbeddingModel: z.string().trim().optional(),
  inferenceVisionModel: z.string().trim().optional(),
  // ISSUE-MCP-2 / ENH-MCP-4: MCP admin-managed settings, persisted so they survive restarts.
  // mcpAllowDestructive gates destructive MCP tools; mcpApiKey holds an operator-rotated key
  // (otherwise the key is derived — see env-helpers). Resolved into MCP_ALLOW_DESTRUCTIVE / MCP_API_KEY.
  mcpAllowDestructive: z.boolean().optional(),
  mcpApiKey: z.string().trim().optional(),
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

export class UserSettingsBody extends createZodDto(settingsSchema.partial()) {}

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
