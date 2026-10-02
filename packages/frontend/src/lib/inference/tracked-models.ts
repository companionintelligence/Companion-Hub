import i18next from 'i18next';
import { fetchInferenceTrackedModels, startInferenceModelPull } from '@/lib/inference/inference-api';
import { isI18nKey } from '@/lib/format-api-error';
import { sdkErrorMessage } from '@/lib/sdk-unwrap';
import { TranslatableError } from '@/types/error.types';
import type { TrackedModel } from '@ci-hub/common/types';

const PULLED_MODEL_STATES = new Set(['pulled', 'loaded', 'pinned']);
/** Still on its way. The install wait is shorter than a large download, and the choice should survive it. */
const ARRIVING_MODEL_STATES = new Set(['pulling', 'loading']);

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
 * The id to store as a default. A model that is already usable is kept. A model that is still
 * downloading is kept too: the wait gives up before a large pull finishes, and writing nothing
 * is what drops the choice. A model that failed, or never started, is not stored.
 */
export function preferenceModelId(chosen: string | undefined, availableIds: ReadonlySet<string>, tracked: TrackedModel[]): string | null {
  if (!chosen) return null;
  if (availableIds.has(chosen)) return chosen;
  const entry = tracked.find((model) => model.catalogId === chosen);
  if (entry && ARRIVING_MODEL_STATES.has(entry.state)) return chosen;
  return null;
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

/**
 * The reason to show when the request to start a download failed outright. The app's response
 * interceptor turns an HTTP error into a TranslatableError whose message is often an i18n key
 * (`INTERNAL_SERVER_ERROR`), which the pull toast printed verbatim; other errors keep their text.
 */
export function describePullStartError(err: unknown): string {
  if (err instanceof TranslatableError && isI18nKey(err.message)) {
    return i18next.t(err.message, { ...(err.intlParams ?? {}), defaultValue: err.message });
  }
  return sdkErrorMessage(err);
}

/** Start each download; returns why the Hub refused, by model id. A failed request counts as refused. */
export async function ensurePullsStarted(modelIds: string[], bestEffort = true): Promise<Record<string, string>> {
  const refusedById: Record<string, string> = {};
  for (const modelId of modelIds) {
    try {
      const reason = await ensurePullStarted(modelId, bestEffort);
      if (reason) refusedById[modelId] = reason;
    } catch (err) {
      refusedById[modelId] = describePullStartError(err);
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
