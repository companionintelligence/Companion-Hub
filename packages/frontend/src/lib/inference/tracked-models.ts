import { apiFetch } from '@/lib/api-fetch';
import type { TrackedModel } from '@ci-hub/common/types';

export const PULLED_MODEL_STATES = new Set(['pulled', 'loaded', 'pinned']);

export interface ParsedPullProgress {
  progressById: Record<string, number>;
  errorsById: Record<string, string>;
  /** Catalog ids in a terminal success state. */
  pulledIds: Set<string>;
  /** True when every model needing download has reached a terminal state. */
  allDone: boolean;
}

export async function fetchTrackedModels(): Promise<TrackedModel[]> {
  const res = await apiFetch('/api/inference/models/tracked');
  if (!res.ok) {
    return [];
  }
  return res.json() as Promise<TrackedModel[]>;
}

export function parsePullProgress(modelIds: string[], installedCatalogIds: string[], tracked: TrackedModel[]): ParsedPullProgress {
  const installedSet = new Set(installedCatalogIds);
  const progressById: Record<string, number> = {};
  const errorsById: Record<string, string> = {};
  const pulledIds = new Set<string>(installedCatalogIds);
  let allDone = true;

  for (const modelId of modelIds) {
    if (installedSet.has(modelId)) {
      progressById[modelId] = 100;
      continue;
    }

    const entry = tracked.find((m) => m.catalogId === modelId);
    if (!entry) {
      allDone = false;
      continue;
    }

    if (entry.state === 'error') {
      errorsById[modelId] = entry.errorMessage ?? 'Download failed';
      continue;
    }

    if (PULLED_MODEL_STATES.has(entry.state)) {
      progressById[modelId] = 100;
      pulledIds.add(modelId);
      continue;
    }

    allDone = false;
    if (entry.state === 'pulling') {
      progressById[modelId] = entry.pullProgress ?? 0;
    }
  }

  return { progressById, errorsById, pulledIds, allDone };
}

export async function ensurePullStarted(modelId: string, bestEffort = true): Promise<void> {
  await apiFetch('/api/inference/models/pull/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId, bestEffort }),
  });
}

export async function ensurePullsStarted(modelIds: string[], bestEffort = true): Promise<void> {
  for (const modelId of modelIds) {
    try {
      await ensurePullStarted(modelId, bestEffort);
    } catch {
      // best-effort — tracked polling surfaces errors
    }
  }
}

export async function waitForModelPulls(
  modelIds: string[],
  installedCatalogIds: string[],
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<ParsedPullProgress> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let latest = parsePullProgress(modelIds, installedCatalogIds, []);

  while (Date.now() < deadline) {
    const tracked = await fetchTrackedModels();
    latest = parsePullProgress(modelIds, installedCatalogIds, tracked);
    if (latest.allDone) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const tracked = await fetchTrackedModels();
  return parsePullProgress(modelIds, installedCatalogIds, tracked);
}
