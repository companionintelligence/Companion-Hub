import { z } from 'zod';

export type Topic = 'app' | 'app-logs' | 'ci-hub-logs';

const appUrnSchema = z.string().refine((v) => v.split(':').length === 2);

const appStatusSchema = z.enum([
  'running',
  'stopped',
  'starting',
  'stopping',
  'updating',
  'missing',
  'installing',
  'install_failed',
  'uninstalling',
  'resetting',
  'restarting',
  'backing_up',
  'restoring',
  'uninstalled',
]);

const installQueueEntrySchema = z.object({
  urn: z.string(),
  name: z.string(),
});

const installQueueEventSchema = z.object({
  event: z.literal('install_queue'),
  active: installQueueEntrySchema.nullable(),
  queued: z.array(installQueueEntrySchema),
});

const appScopedEventSchema = z.object({
  event: z.enum([
    'status_change',
    'install_success',
    'install_error',
    'uninstall_success',
    'uninstall_error',
    'reset_success',
    'reset_error',
    'update_success',
    'update_error',
    'start_success',
    'start_error',
    'stop_success',
    'stop_error',
    'restart_success',
    'restart_error',
    'generate_env_success',
    'generate_env_error',
    'backup_success',
    'backup_error',
    'restore_success',
    'restore_error',
  ]),
  appUrn: appUrnSchema,
  appStatus: appStatusSchema.optional(),
  error: z.string().optional(),
  progress: z.number().min(0).max(99).optional(),
});

export const sseSchema = z.union([
  z.object({
    topic: z.literal('app'),
    data: z.union([installQueueEventSchema, appScopedEventSchema]),
  }),
  z.object({
    topic: z.literal('app-logs'),
    data: z.object({
      event: z.union([z.literal('newLogs'), z.literal('stopLogs')]),
      appUrn: appUrnSchema,
      lines: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    topic: z.literal('ci-hub-logs'),
    data: z.object({
      event: z.union([z.literal('newLogs'), z.literal('stopLogs')]),
      lines: z.array(z.string()).optional(),
    }),
  }),
]);

export type SSE = z.infer<typeof sseSchema>;
