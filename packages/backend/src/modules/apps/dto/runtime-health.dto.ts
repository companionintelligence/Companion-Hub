import { createZodDto } from '@/common/zod-dto';
import { z } from 'zod';

const containerRuntimeStatsSchema = z.object({
  containerId: z.string(),
  name: z.string(),
  state: z.string(),
  status: z.string(),
  health: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  cpuPercent: z.number(),
  memoryUsageBytes: z.number(),
  memoryLimitBytes: z.number(),
});

const unattributedGpuProcessSchema = z.object({
  processName: z.string(),
  vramMb: z.number(),
});

const appRuntimeHistoryPointSchema = z.object({
  appUrn: z.string(),
  appName: z.string(),
  status: z.string(),
  cpuPercent: z.number(),
  memoryUsageBytes: z.number(),
  containerCount: z.number(),
  gpuVramMb: z.number().nullable(),
});

const appRuntimeHealthSchema = z.object({
  appUrn: z.string(),
  appName: z.string(),
  status: z.string(),
  cpuPercent: z.number(),
  memoryUsageBytes: z.number(),
  memoryLimitBytes: z.number(),
  highCpu: z.boolean(),
  sustainedHighCpu: z.boolean(),
  responsive: z.boolean(),
  degraded: z.boolean(),
  forceStopEligible: z.boolean(),
  reason: z.string().nullable(),
  cpuLimit: z.string().nullable(),
  usesDefaultCpuLimit: z.boolean(),
  sampledAt: z.string(),
  containers: z.array(containerRuntimeStatsSchema),
  gpuVramMb: z.number().nullable(),
});

const appRuntimeHistorySampleSchema = z.object({
  sampledAt: z.string(),
  apps: z.array(appRuntimeHistoryPointSchema),
});

const appRuntimeMonitorSchema = z.object({
  sampledAt: z.string(),
  apps: z.array(appRuntimeHealthSchema),
  history: z.array(appRuntimeHistorySampleSchema),
  unattributedGpu: z.array(unattributedGpuProcessSchema).nullable(),
});

export class AppRuntimeHealthDto extends createZodDto(appRuntimeHealthSchema) {}
export class AppRuntimeMonitorDto extends createZodDto(appRuntimeMonitorSchema) {}
