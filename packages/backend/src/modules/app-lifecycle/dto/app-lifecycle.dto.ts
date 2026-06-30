import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';
import { optionalCpuLimitSchema } from '@/common/validation/cpu-limit';
import { optionalMemoryLimitSchema } from '@/common/validation/memory-limit';
import isFQDN from 'validator/lib/isFQDN';

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
    publicDomain: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isFQDN(value), { message: 'Invalid public domain' })
      .optional(),
    maxBackups: z.number().min(0).max(100).optional(),
    cpuLimit: optionalCpuLimitSchema,
    memoryLimit: optionalMemoryLimitSchema,
    skipEnv: z.boolean().default(false),
    skipPull: z.boolean().default(false),
    skipRun: z.boolean().default(false),
  })
  .passthrough();

const uninstallAppBodySchema = z.object({
  deleteAllData: z.boolean().optional().default(true),
});

const updateAppBodySchema = z.object({
  performBackup: z.boolean(),
});

const lifecycleRequestSchema = z.object({
  requestId: z.string().uuid(),
});

const cancelOperationBodySchema = z.object({
  // Optional guard so a stale client never cancels a newer operation for the same app.
  requestId: z.string().uuid().optional(),
});

const cancelOperationResponseSchema = z.object({
  // `cancelling`: in-flight abort requested; `cancelled_queued`: was still queued; `refused`: not
  // cancellable / past point-of-no-return; `force_reset`: reserved for stuck-op recovery (Phase 4);
  // `not_found`: no active op for this app (or requestId mismatch).
  outcome: z.enum(['cancelling', 'cancelled_queued', 'refused', 'force_reset', 'not_found']),
  status: z.string().optional(),
  message: z.string().optional(),
});

export class AppFormBody extends createZodDto(appFormSchema) {}

export class UninstallAppBody extends createZodDto(uninstallAppBodySchema) {}

export class UpdateAppBody extends createZodDto(updateAppBodySchema) {}

export class LifecycleRequestDto extends createZodDto(lifecycleRequestSchema) {}

export class CancelOperationBody extends createZodDto(cancelOperationBodySchema) {}

export class CancelOperationResponseDto extends createZodDto(cancelOperationResponseSchema) {}
