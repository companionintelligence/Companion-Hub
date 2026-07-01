import { apiFetch } from '@/lib/api-fetch';
import {
  ensurePullStarted,
  ensurePullsStarted,
  fetchTrackedModels,
  parsePullProgress,
  waitForModelPulls,
  type ParsedPullProgress,
} from '@/lib/inference/tracked-models';
import { useCallback, useEffect, useMemo, useState } from 'react';

export interface ModelPullOrchestratorResult {
  progressById: Record<string, number>;
  errorsById: Record<string, string>;
  isPulling: boolean;
  activeCount: number;
  completedCount: number;
  /** Average progress (0–100) across models still downloading. */
  averageActiveProgress: number;
}

interface UseModelPullOrchestratorOptions {
  selectedModelIds: string[];
  installedCatalogIds: string[];
  /** When false, no pulls are started and polling is paused. */
  enabled: boolean;
  bestEffort?: boolean;
}

function deriveStats(
  modelsNeedingDownload: string[],
  selectedModelIds: string[],
  installedSet: Set<string>,
  parsed: Pick<ParsedPullProgress, 'progressById' | 'errorsById'>,
): Pick<ModelPullOrchestratorResult, 'isPulling' | 'activeCount' | 'completedCount' | 'averageActiveProgress'> {
  const derivedActive = modelsNeedingDownload.filter((id) => {
    if (parsed.errorsById[id]) return false;
    const pct = parsed.progressById[id];
    return pct !== undefined && pct < 100;
  });
  const progressSum = derivedActive.reduce((sum, id) => sum + (parsed.progressById[id] ?? 0), 0);
  return {
    isPulling: derivedActive.length > 0,
    activeCount: derivedActive.length,
    completedCount: selectedModelIds.filter((id) => installedSet.has(id) || parsed.progressById[id] === 100).length,
    averageActiveProgress: derivedActive.length > 0 ? Math.round(progressSum / derivedActive.length) : 0,
  };
}

export function useModelPullOrchestrator({
  selectedModelIds,
  installedCatalogIds,
  enabled,
  bestEffort = true,
}: UseModelPullOrchestratorOptions): ModelPullOrchestratorResult {
  const [progressById, setProgressById] = useState<Record<string, number>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [ollamaReady, setOllamaReady] = useState(false);

  const installedSet = useMemo(() => new Set(installedCatalogIds), [installedCatalogIds]);
  const modelsNeedingDownload = useMemo(() => selectedModelIds.filter((id) => !installedSet.has(id)), [selectedModelIds, installedSet]);
  const orchestratorEnabled = enabled && ollamaReady && modelsNeedingDownload.length > 0;

  useEffect(() => {
    if (!enabled) {
      setOllamaReady(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/inference/ollama/status');
        if (!res.ok) return;
        const data = (await res.json()) as { ready?: boolean; running?: boolean };
        if (!cancelled) setOllamaReady(!!(data.ready ?? data.running));
      } catch {
        if (!cancelled) setOllamaReady(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const applyParsed = useCallback((parsed: ParsedPullProgress) => {
    setProgressById(parsed.progressById);
    setErrorsById(parsed.errorsById);
  }, []);

  useEffect(() => {
    if (!orchestratorEnabled) return;

    for (const modelId of modelsNeedingDownload) {
      void ensurePullStarted(modelId, bestEffort);
    }
  }, [orchestratorEnabled, modelsNeedingDownload, bestEffort]);

  useEffect(() => {
    if (!orchestratorEnabled) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const tracked = await fetchTrackedModels();
        if (cancelled) return;
        applyParsed(parsePullProgress(selectedModelIds, installedCatalogIds, tracked));
      } catch {
        // ignore transient poll failures
      }
    };

    void poll();
    const intervalId = window.setInterval(() => void poll(), 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [orchestratorEnabled, selectedModelIds, installedCatalogIds, applyParsed]);

  const stats = deriveStats(modelsNeedingDownload, selectedModelIds, installedSet, { progressById, errorsById });

  return {
    progressById,
    errorsById,
    ...stats,
  };
}

/** Imperative pull + wait for settings save and other non-hook callers. */
export async function pullAndPinModels(
  modelIds: string[],
  installedCatalogIds: string[],
  options?: { bestEffort?: boolean; timeoutMs?: number },
): Promise<{ errors: string[]; pulledIds: Set<string> }> {
  const modelsToPull = modelIds.filter((id) => !installedCatalogIds.includes(id));
  await ensurePullsStarted(modelsToPull, options?.bestEffort ?? false);
  const result = await waitForModelPulls(modelsToPull, installedCatalogIds, {
    timeoutMs: options?.timeoutMs ?? 600_000,
  });
  const errors = Object.entries(result.errorsById).map(([id, msg]) => `${id}: ${msg}`);
  return { errors, pulledIds: result.pulledIds };
}
