import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

import { userSchema } from './modules/user/dto/user.dto';

import { LOG_LEVEL_ENUM } from './core/logger/logger.service';
import { appInfoSchema } from '@ci-hub/common/schemas';

export const settingsSchema = z.object({
  advancedSettings: z.boolean(),
  allowAutoThemes: z.boolean(),
  allowErrorMonitoring: z.boolean(),
  appDataPath: z.string().trim(),
  appsRepoUrl: z.string().url().optional(),
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
});

const simpleAppInfoSchema = appInfoSchema.pick({
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
  user: userSchema,
  apps: z.array(simpleAppInfoSchema),
  updatesAvailable: z.number(),
  isProduction: z.boolean(),
  cloudflareAvailable: z.boolean(),
  tailscaleAvailable: z.boolean(),
});

export class UserSettingsDto extends createZodDto(settingsSchema) {}

export class UserSettingsBody extends createZodDto(settingsSchema.partial()) {}

export type { z as ZodType } from 'zod';
export type UserSettingsBodyType = z.infer<typeof settingsSchema>;

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
});

export class UserContextDto extends createZodDto(userContextDto) {}

export class AcknowledgeWelcomeBody extends createZodDto(z.object({ allowErrorMonitoring: z.boolean() })) {}
