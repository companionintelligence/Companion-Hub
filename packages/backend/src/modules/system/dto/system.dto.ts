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

const systemResourcesSchema = z.object({
  docker: z
    .object({
      cpuCores: z.number(),
      memTotalMb: z.number(),
      serverVersion: z.string().optional(),
    })
    .nullable(),
  host: z
    .object({
      cpuCores: z.number(),
      totalRamMb: z.number(),
      availableRamMb: z.number(),
      diskTotalGb: z.number(),
      diskUsedGb: z.number(),
    })
    .nullable(),
  runtimeKind: runtimeKindSchema,
  hasVmWedge: z.boolean(),
  recommended: z
    .object({
      dockerRamMb: z.number(),
      dockerCpus: z.number(),
      dockerDiskGb: z.number(),
    })
    .nullable(),
  appDefaults: z.object({
    cpuLimit: z.string().optional(),
    memoryLimit: z.string().optional(),
    autoAllocated: z.boolean(),
  }),
  tuning: z.record(z.string(), z.unknown()).nullable(),
});

// Resources
export class SystemResourcesDto extends createZodDto(systemResourcesSchema) {}

const telemetryAppPointSchema = z.object({
  appUrn: z.string(),
  appName: z.string(),
  status: z.string(),
  cpuPercent: z.number(),
  memoryUsageBytes: z.number(),
  containerCount: z.number(),
});

/**
 * One telemetry row. With `?minutes=` the endpoint serves averages over equal buckets instead of raw
 * rows, and those carry only the time, CPU and memory, so everything after them is optional.
 */
const hostTelemetrySampleSchema = z.object({
  sampledAt: z.string(),
  cpuLoad: z.number().nullable(),
  memoryUsed: z.number().nullable(),
  memoryTotal: z.number().nullable(),
  cpuCores: z.number().nullable().optional(),
  diskUsed: z.number().nullable().optional(),
  diskTotal: z.number().nullable().optional(),
  percentUsedMemory: z.number().nullable().optional(),
  dockerAvailable: z.boolean().nullable().optional(),
  dockerInfo: z.record(z.string(), z.unknown()).nullable().optional(),
  apps: z.array(telemetryAppPointSchema).nullable().optional(),
  source: z.string().optional(),
});

const hostEventSchema = z.object({
  createdAt: z.string(),
  level: z.string(),
  source: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export class HostTelemetryHistoryDto extends createZodDto(
  z.object({
    samples: z.array(hostTelemetrySampleSchema),
    /** The span served, after clamping into the retention. Present only with `?minutes=`. */
    minutes: z.number().optional(),
    /** How many seconds each point averages. Present only with `?minutes=`. */
    bucketSeconds: z.number().optional(),
  }),
) {}

export class HostEventLogDto extends createZodDto(
  z.object({
    events: z.array(hostEventSchema),
  }),
) {}
