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

const appReadinessCheckSchema = z.object({
  status: z.string(),
  detail: z.string().optional(),
});

// Normalised, not the app's raw body — see `app-readiness.helpers.ts` for what each field means.
const appReadinessSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unknown']),
  checks: z.record(z.string(), appReadinessCheckSchema),
  busy: z.boolean().nullable(),
  drainable: z.boolean().nullable(),
  sampledAt: z.string(),
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
  // `null` when the app declares no `hub_integration.readiness` endpoint, or is not running so
  // nothing was probed; a probe that happened but produced nothing readable is `unknown`.
  readiness: appReadinessSchema.nullable(),
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
  // `absent` is a real answer ("nothing on this node could measure it"); `null` is the empty
  // snapshot, where no collection happened. See `AppRuntimeMonitorSnapshot.gpuVramSource`.
  gpuVramSource: z.enum(['host-file', 'tool', 'absent']).nullable(),
});

export class AppRuntimeHealthDto extends createZodDto(appRuntimeHealthSchema) {}
export class AppRuntimeMonitorDto extends createZodDto(appRuntimeMonitorSchema) {}
