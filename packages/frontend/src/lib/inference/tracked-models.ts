import { fetchInferenceTrackedModels, startInferenceModelPull } from '@/lib/inference/inference-api';
import type { TrackedModel } from '@ci-hub/common/types';

const PULLED_MODEL_STATES = new Set(['pulled', 'loaded', 'pinned']);

export interface ParsedPullProgress {
  progressById: Record<string, number>;
  errorsById: Record<string, string>;
  /** Catalog ids in a terminal success state. */
  pulledIds: Set<string>;
  /** True when every model needing download has reached a terminal state. */
  allDone: boolean;
}

export async function fetchTrackedModels(): Promise<TrackedModel[]> {
  return fetchInferenceTrackedModels();
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

/**
 * Ask the Hub to start a download. Returns the Hub's reason when it refused (`error`, or `skipped`
 * for a best-effort pull), otherwise null.
 *
 * A refused pull is never tracked, so tracked-model polling cannot report it: a caller that ignores
 * this return waits out its whole timeout on a download that never began.
 */
export async function ensurePullStarted(modelId: string, bestEffort = true): Promise<string | null> {
  const reply = await startInferenceModelPull(modelId, bestEffort);
  if (reply?.status === 'error' || reply?.status === 'skipped') {
    return reply.reason ?? `The Hub did not start a download for ${modelId}.`;
  }
  return null;
}

/** Start each download; returns why the Hub refused, by model id. A failed request counts as refused. */
export async function ensurePullsStarted(modelIds: string[], bestEffort = true): Promise<Record<string, string>> {
  const refusedById: Record<string, string> = {};
  for (const modelId of modelIds) {
    try {
      const reason = await ensurePullStarted(modelId, bestEffort);
      if (reason) refusedById[modelId] = reason;
    } catch (err) {
      refusedById[modelId] = err instanceof Error ? err.message : String(err);
    }
  }
  return refusedById;
}

export async function waitForModelPulls(
  modelIds: string[],
  installedCatalogIds: string[],
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<ParsedPullProgress> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tracked = await fetchTrackedModels();
    const latest = parsePullProgress(modelIds, installedCatalogIds, tracked);
    if (latest.allDone) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const tracked = await fetchTrackedModels();
  return parsePullProgress(modelIds, installedCatalogIds, tracked);
}
