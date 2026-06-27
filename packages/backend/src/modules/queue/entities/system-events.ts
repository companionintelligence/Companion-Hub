import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Queue } from '../queue.entity';

export const systemCommandSchema = z.object({
  command: z.union([z.literal('sync_app_statuses'), z.literal('reconcile_orphan_networks')]),
});

export const systemCommandResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  syncedCount: z.number().optional(),
  skippedCount: z.number().optional(),
  errorCount: z.number().optional(),
  totalApps: z.number().optional(),
  removedCount: z.number().optional(),
});

@Injectable()
export class SystemEventsQueue extends Queue<typeof systemCommandSchema, typeof systemCommandResultSchema> {}
