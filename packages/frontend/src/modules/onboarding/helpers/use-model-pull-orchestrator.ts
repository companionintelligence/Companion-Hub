import { apiFetch } from '@/lib/api-fetch';
import type { TrackedModel } from '@ci-hub/common/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PULLED_STATES = new Set(['pulled', 'loaded', 'pinned']);

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

export function useModelPullOrchestrator({
  selectedModelIds,
  installedCatalogIds,
  enabled,
  bestEffort = true,
}: UseModelPullOrchestratorOptions): ModelPullOrchestratorResult {
  const [progressById, setProgressById] = useState<Record<string, number>>({});
  const [errorsById, setErrorsById] = useState<Record<string, string>>({});
  const [ollamaReady, setOllamaReady] = useState(false);
  const startedPullsRef = useRef(new Set<string>());

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

  const ensurePullStarted = useCallback(
    async (modelId: string) => {
      try {
        await apiFetch('/api/inference/models/pull/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId, bestEffort }),
        });
      } catch {
        // best-effort — tracked polling surfaces errors
      }
    },
    [bestEffort],
  );

  useEffect(() => {
    if (!orchestratorEnabled) return;

    for (const modelId of modelsNeedingDownload) {
      if (startedPullsRef.current.has(modelId)) continue;
      startedPullsRef.current.add(modelId);
      void ensurePullStarted(modelId);
    }
  }, [orchestratorEnabled, modelsNeedingDownload, ensurePullStarted]);

  const applyTracked = useCallback(
    (tracked: TrackedModel[]) => {
      const nextProgress: Record<string, number> = {};
      const nextErrors: Record<string, string> = {};
      let activeCount = 0;
      let completedCount = 0;
      let progressSum = 0;

      for (const modelId of selectedModelIds) {
        if (installedSet.has(modelId)) {
          nextProgress[modelId] = 100;
          completedCount++;
          continue;
        }

        const entry = tracked.find((m) => m.catalogId === modelId);
        if (!entry) continue;

        if (entry.state === 'error') {
          nextErrors[modelId] = entry.errorMessage ?? 'Download failed';
          startedPullsRef.current.delete(modelId);
          continue;
        }

        if (PULLED_STATES.has(entry.state)) {
          nextProgress[modelId] = 100;
          completedCount++;
          continue;
        }

        if (entry.state === 'pulling') {
          const pct = entry.pullProgress ?? 0;
          nextProgress[modelId] = pct;
          activeCount++;
          progressSum += pct;
        }
      }

      setProgressById(nextProgress);
      setErrorsById(nextErrors);

      return { activeCount, completedCount, progressSum };
    },
    [selectedModelIds, installedSet],
  );

  useEffect(() => {
    if (!orchestratorEnabled) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/inference/models/tracked');
        if (!res.ok || cancelled) return;
        const tracked = (await res.json()) as TrackedModel[];
        applyTracked(tracked);
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
  }, [orchestratorEnabled, applyTracked]);

  const derivedActive = modelsNeedingDownload.filter((id) => {
    if (errorsById[id]) return false;
    const pct = progressById[id];
    return pct !== undefined && pct < 100;
  });
  const isPulling = derivedActive.length > 0;
  const progressSum = derivedActive.reduce((sum, id) => sum + (progressById[id] ?? 0), 0);
  const averageActiveProgress = derivedActive.length > 0 ? Math.round(progressSum / derivedActive.length) : 0;
  const completedCount = selectedModelIds.filter((id) => installedSet.has(id) || progressById[id] === 100).length;

  return {
    progressById,
    errorsById,
    isPulling,
    activeCount: derivedActive.length,
    completedCount,
    averageActiveProgress,
  };
}
