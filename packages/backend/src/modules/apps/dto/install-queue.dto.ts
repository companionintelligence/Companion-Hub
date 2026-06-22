import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const installQueueEntrySchema = z.object({
  urn: z.string(),
  name: z.string(),
});

export const installQueueSchema = z.object({
  active: installQueueEntrySchema.nullable(),
  queued: z.array(installQueueEntrySchema),
});

export class InstallQueueDto extends createZodDto(installQueueSchema) {}
