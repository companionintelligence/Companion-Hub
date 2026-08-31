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
  /** Custom hostname CI-Cloud has wired for this app; null when it serves on the platform hostname. */
  customDomain: z.string().nullable().optional(),
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
  appDataHostPath: z.string().nullable().optional(),
  mcpInstallSchema: z
    .object({
      transport: z.enum(['stdio', 'http']).optional(),
      requires: z.record(z.string(), z.unknown()).optional(),
      tags: z.array(z.string()),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          hint: z.string().optional(),
          required: z.boolean(),
          secret: z.boolean(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          source: z.enum(['form_field', 'mcp_env']),
        }),
      ),
      toolCount: z.number(),
      bridgeable: z.boolean(),
      bridgeWarning: z.string().optional(),
    })
    .nullable()
    .optional(),
  mcpRuntime: z
    .object({
      bridgeable: z.boolean(),
      transport: z.string().optional(),
      containerStatus: z.enum(['running', 'stopped', 'missing', 'unknown']),
      toolCount: z.number(),
      lastError: z.string().optional(),
      lastProbeAt: z.string().optional(),
      bridgeWarning: z.string().optional(),
      connected: z.boolean(),
    })
    .nullable()
    .optional(),
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

const installedAppUrnsSchema = z.object({
  urns: z.array(z.string()),
});

const updatesAvailableSchema = z.object({
  updatesAvailable: z.number(),
});

export class MyAppsDto extends createZodDto(myAppsSchema) {}
export class GuestAppsDto extends createZodDto(myAppsSchema) {}
export class InstalledAppUrnsDto extends createZodDto(installedAppUrnsSchema) {}
export class UpdatesAvailableDto extends createZodDto(updatesAvailableSchema) {}
export class GetAppDto extends createZodDto(getAppSchema) {}
export class GetRandomPortDto extends createZodDto(getRandomPortSchema) {}
export class GetConfigDiffDto extends createZodDto(getConfigDiffSchema) {}
export class GetComposeDiffDto extends createZodDto(getComposeDiff) {}
