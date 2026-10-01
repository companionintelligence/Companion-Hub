import { Injectable } from '@nestjs/common';
import { optionalCpuLimitSchema } from '@/common/validation/cpu-limit';
import { optionalMemoryLimitSchema } from '@/common/validation/memory-limit';
import { zodAppUrn } from '@ci-hub/common/types';
import { z } from 'zod';
import isFQDN from 'validator/lib/isFQDN';
import { Queue } from '../queue.entity';

const queueAppFormSchema = z
  .object({
    port: z.number().min(1024).max(65535).optional(),
    exposed: z.boolean().optional(),
    exposedLocal: z.boolean().optional(),
    openPort: z.boolean().default(true),
    domain: z.string().optional(),
    isVisibleOnGuestDashboard: z.boolean().optional(),
    enableAuth: z.boolean().optional(),
    localSubdomain: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,63}$/)
      .optional(),
    skipEnv: z.boolean().default(false),
    skipPull: z.boolean().default(false),
    skipRun: z.boolean().default(false),
    // Start only: let compose recreate just the services whose resolved definition changed. See
    // `AppLifecycleService.restartRunningApps`.
    onlyRecreateChanged: z.boolean().optional(),
    cpuLimit: optionalCpuLimitSchema,
    memoryLimit: optionalMemoryLimitSchema,
    // Explicit fields for public domain selection — previously passed through catchall as unknown.
    // These must be typed explicitly so generateEnvFile and triggerCloudflareSync receive them correctly.
    // Validation mirrors appFormSchema in app-lifecycle.dto.ts for consistency.
    exposureMode: z.enum(['local', 'cloudflare', 'tailscale']).optional(),
    publicDomain: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isFQDN(value), { message: 'Invalid public domain' })
      .optional()
      .nullable(),
  })
  .catchall(z.unknown());

const commonAppCommandSchema = z.object({
  command: z.union([
    z.literal('start'),
    z.literal('stop'),
    z.literal('install'),
    z.literal('reset'),
    z.literal('restart'),
    z.literal('generate_env'),
    z.literal('backup'),
  ]),
  appUrn: zodAppUrn,
  form: queueAppFormSchema,
  requestId: z.uuid(),
});

const restoreAppCommandSchema = z.object({
  command: z.literal('restore'),
  appUrn: zodAppUrn,
  filename: z.string(),
  form: queueAppFormSchema,
  requestId: z.uuid(),
});

const updateAppCommandSchema = z.object({
  command: z.literal('update'),
  appUrn: zodAppUrn,
  form: queueAppFormSchema,
  performBackup: z.boolean().optional().default(true),
  // Whether the app was running when the update was requested; a stopped one is updated and left stopped.
  // Defaults to true, the behaviour before the flag existed, for a message queued by an older Hub.
  wasRunning: z.boolean().optional().default(true),
  requestId: z.uuid(),
});

const uninstallAppCommandSchema = z.object({
  command: z.literal('uninstall'),
  appUrn: zodAppUrn,
  form: queueAppFormSchema,
  deleteAllData: z.boolean().optional().default(true),
  requestId: z.uuid(),
});

export const appEventSchema = commonAppCommandSchema.or(restoreAppCommandSchema).or(updateAppCommandSchema).or(uninstallAppCommandSchema);

export const appEventResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  errorCode: z.string().optional(),
  errorDetail: z.string().optional(),
  settingsPath: z.string().optional(),
  // Non-fatal caveat on an otherwise-successful command; does not flip `success`.
  // Semantics documented on appScopedEventSchema.warningCode (common/schemas/sse.ts).
  warningCode: z.string().optional(),
  // Optional human-readable detail for the caveat (e.g. the host path of a remnant the
  // uninstall couldn't remove, so the client can show a manual cleanup command).
  warningDetail: z.string().optional(),
  // Set by a command when it stopped because the operation was cancelled (vs. failed). The service's
  // completion handling branches on this to finalize a cancel rather than a success/error.
  cancelled: z.boolean().optional(),
  // Resting status a before-PONR cancel reverted to (e.g. 'stopped'). Unused by install (which removes
  // the record); reserved so Phase 2-4 ops can report where they landed.
  cancelledStatus: z.string().optional(),
  // Set by a failed update: the previous version is back in place (and running again, if it was running).
  rolledBack: z.boolean().optional(),
});

export type AppEventFormInput = z.input<typeof commonAppCommandSchema>['form'];

@Injectable()
export class AppEventsQueue extends Queue<typeof appEventSchema, typeof appEventResultSchema> {}
