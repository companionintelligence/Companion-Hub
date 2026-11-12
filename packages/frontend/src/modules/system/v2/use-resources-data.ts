import { getInstalledAppsOptions, getRuntimeModelsOptions, hostTelemetryHistoryOptions } from '@/api-client/@tanstack/react-query.gen';
import type { InferenceBackendStatus } from '@/modules/system/use-dashboard-data';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

/*
 * What the Resources page reads beyond the old dashboard's queries (`useDashboardData`):
 *
 *   /system/telemetry?minutes=   host CPU and memory history for the chosen span, averaged on the Hub
 *   /inference/models/runtime    each running engine's models with their size on disk
 *   /apps/installed              the names Home shows, so the Apps table says "Companion Memory"
 *                                rather than "ci-memory". Same query key and staleness as Home, so
 *                                arriving from Home costs no request, and the table never waits for it.
 */

export const TELEMETRY_SPANS = [30, 60, 360, 720, 1440, 2880] as const;
export type TelemetrySpan = (typeof TELEMETRY_SPANS)[number];

export interface TelemetryPoint {
  sampledAt: string;
  cpuLoad: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
}

export interface DiskModel {
  id: string;
  backend: string;
  sizeBytes: number | null;
  resident: boolean;
}

interface RuntimeModelsPayload {
  backend?: string;
  discoveryUnavailable?: boolean;
  models?: { id: string; sizeBytes?: number | null; resident?: boolean }[];
}

/** A span longer than half an hour changes slowly, so it is not worth polling as often. */
const telemetryPollMs = (span: TelemetrySpan) => (span <= 60 ? 15_000 : 60_000);

export function useTelemetry(span: TelemetrySpan) {
  const query = useQuery({
    ...hostTelemetryHistoryOptions({ query: { minutes: span } }),
    refetchInterval: telemetryPollMs(span),
    retry: false,
  });
  const points = useMemo(
    () => ((query.data?.samples ?? []) as TelemetryPoint[]).slice().sort((a, b) => a.sampledAt.localeCompare(b.sampledAt)),
    [query.data],
  );
  return { points, bucketSeconds: (query.data as { bucketSeconds?: number } | undefined)?.bucketSeconds ?? null, query };
}

/** The size of each model on disk, per running engine. An engine that is down is skipped, not failed. */
export function useDiskModels(engines: InferenceBackendStatus[] | undefined) {
  const running = (engines ?? []).filter((engine) => engine.running && engine.healthy !== false).map((engine) => engine.type);
  const results = useQueries({
    queries: running.map((backend) => ({
      ...getRuntimeModelsOptions({ query: { backend: backend as 'ollama' } }),
      staleTime: 60_000,
      refetchInterval: 120_000,
      retry: false,
    })),
  });

  const models: DiskModel[] = results.flatMap((result, index) => {
    const payload = result.data as RuntimeModelsPayload | undefined;
    return (payload?.models ?? []).map((model) => ({
      id: model.id,
      backend: running[index] ?? payload?.backend ?? '',
      sizeBytes: typeof model.sizeBytes === 'number' && model.sizeBytes > 0 ? model.sizeBytes : null,
      resident: model.resident === true,
    }));
  });
  return { models, pending: results.some((result) => result.isPending), failed: results.length > 0 && results.every((result) => result.isError) };
}

/** URN to the name Home shows for that app. Empty until the installed list arrives. */
export function useAppNames() {
  const query = useQuery({ ...getInstalledAppsOptions(), staleTime: 30_000 });
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of query.data?.installed ?? []) {
      const { urn, name } = entry.info ?? {};
      if (urn && name) names.set(urn, name);
    }
    return names;
  }, [query.data]);
}
