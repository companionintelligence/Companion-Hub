import { z } from 'zod';
import { createZodDto } from '@/common/zod-dto';

const runtimeKindSchema = z.enum(['container-only', 'docker-desktop-vm', 'wsl2-vm', 'linux-native', 'host-native']);

const loadSchema = z.object({
  diskUsed: z.number().default(0),
  diskSize: z.number().default(0),
  percentUsed: z.number().default(0),
  cpuLoad: z.number().default(0),
  cpuCores: z.number().default(0),
  memoryTotal: z.number().default(0),
  memoryUsed: z.number().default(0),
  percentUsedMemory: z.number().default(0),
  hasVmWedge: z.boolean().default(false),
  runtimeKind: runtimeKindSchema.default('container-only'),
  containerMemoryTotal: z.number().optional(),
  containerMemoryUsed: z.number().optional(),
  containerDiskTotal: z.number().optional(),
  containerDiskUsed: z.number().optional(),
  recommendedDockerRamMb: z.number().optional(),
  platformGuidance: z.string().optional(),
});

// Load
export class LoadDto extends createZodDto(loadSchema) {}
