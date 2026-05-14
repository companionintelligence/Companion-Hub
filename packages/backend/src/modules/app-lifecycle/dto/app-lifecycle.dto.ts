import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

export const appFormSchema = z
  .object({
    port: z.number().min(1024).max(65535).optional(),
    exposed: z.boolean().optional(),
    exposedLocal: z.boolean().optional(),
    exposureMode: z.enum(['local', 'cloudflare', 'tailscale']).optional(),
    openPort: z.boolean().default(true),
    domain: z.string().optional(),
    isVisibleOnGuestDashboard: z.boolean().optional(),
    enableAuth: z.boolean().optional(),
    localSubdomain: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,63}$/)
      .optional(),
    publicDomain: z.string().optional(),
    maxBackups: z.number().min(0).max(100).optional(),
    skipEnv: z.boolean().default(false),
    skipPull: z.boolean().default(false),
    skipRun: z.boolean().default(false),
  })
  .passthrough();

const uninstallAppBodySchema = z.object({
  removeBackups: z.boolean(),
});

const updateAppBodySchema = z.object({
  performBackup: z.boolean(),
});

const lifecycleRequestSchema = z.object({
  requestId: z.string().uuid(),
});

export class AppFormBody extends createZodDto(appFormSchema) {}

export class UninstallAppBody extends createZodDto(uninstallAppBodySchema) {}

export class UpdateAppBody extends createZodDto(updateAppBodySchema) {}

export class LifecycleRequestDto extends createZodDto(lifecycleRequestSchema) {}
