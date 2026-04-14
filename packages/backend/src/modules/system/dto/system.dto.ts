import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const loadSchema = z.object({
  diskUsed: z.number().default(0),
  diskSize: z.number().default(0),
  percentUsed: z.number().default(0),
  cpuLoad: z.number().default(0),
  memoryTotal: z.number().default(0),
  percentUsedMemory: z.number().default(0),
});

// Load
export class LoadDto extends createZodDto(loadSchema) {}
