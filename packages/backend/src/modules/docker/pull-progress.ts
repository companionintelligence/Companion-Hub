/**
 * How a running image pull adds up, from Docker's per-layer progress events.
 *
 * Docker announces the layers it will fetch before any download starts, but only reports a layer's
 * size once that layer starts downloading. It downloads three at a time. Adding up only the sizes
 * reported so far gave a total that grew all through the download: ZeroNote's 26 MB read
 * "3.0 MB / 3.7 MB" while its first layer was the only one with a size (CI-Hub#2177). So a layer's
 * size can also come from the image manifest, read from the registry while the pull runs. The total
 * is only called known once every announced layer has a size or has finished.
 *
 * Classic Docker announces every layer, with "Already exists" for one it has. Docker's containerd
 * image store never mentions a layer it already has, so the manifest can list layers no event names.
 */

export interface DockerPullLayerSnapshot {
  current: number;
  total: number;
  status: string;
}

/** One of Docker's pull events, as far as a layer's progress goes. */
export interface DockerPullLayerEvent {
  status?: string;
  progressDetail?: { current?: number; total?: number; units?: string };
}

export type DockerPullStage = 'downloading' | 'extracting' | 'complete';

/** The id Docker's pull events give a layer: the first 12 hex digits of its digest. */
export function shortLayerId(digest: string): string {
  const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest;
  return hex.slice(0, 12);
}

const statusOf = (layer: DockerPullLayerSnapshot) => layer.status.toLowerCase();

/** Docker's "Pulling from <repo>" line carries the tag as its id and is not a layer. */
export const isLayerEvent = (status: string) => !status.toLowerCase().startsWith('pulling from');

/** The layer is on disk from before this pull: nothing of it is downloaded. */
const alreadyExists = (status: string) => status.includes('already exists');

/** Downloaded in full. Whatever size it reported, or none, is all it will ever have. */
const downloadFinished = (status: string) =>
  status.includes('pull complete') ||
  status.includes('already exists') ||
  status.includes('download complete') ||
  status.includes('verifying') ||
  status.includes('extract');

/**
 * A status Docker only sends once the image's downloads have begun, by which point every layer it
 * will fetch has been announced. Not "Already exists": classic Docker prints that in a layer's place
 * while it is still announcing the rest.
 */
export const isDownloadPhase = (status: string) => {
  const s = status.toLowerCase();
  return !alreadyExists(s) && (s.startsWith('downloading') || downloadFinished(s));
};

/**
 * The layer after one more of Docker's events. Counts are bytes unless the event names other units:
 * the containerd store counts seconds while it extracts.
 */
export function applyLayerEvent(previous: DockerPullLayerSnapshot | undefined, event: DockerPullLayerEvent): DockerPullLayerSnapshot {
  const snapshot = previous ?? { current: 0, total: 0, status: '' };
  const bytes = event.progressDetail?.units ? undefined : event.progressDetail;
  const current = Math.max(snapshot.current, bytes?.current ?? 0);
  const total = Math.max(snapshot.total, bytes?.total ?? 0, current);
  const status = event.status ?? snapshot.status;
  // A second image that shares a layer this pull has already fetched reports it as "Already exists".
  // Those bytes were still downloaded here.
  if (previous?.status && !alreadyExists(statusOf(previous)) && alreadyExists(status.toLowerCase())) {
    return { current, total, status: 'Pull complete' };
  }
  return { current, total, status };
}

/** A layer's compressed size: what Docker reported, else the manifest's, else what has arrived so far. */
function layerSize(id: string, layer: DockerPullLayerSnapshot, expected: ReadonlyMap<string, number>): number {
  if (alreadyExists(statusOf(layer))) {
    return 0;
  }
  if (layer.total > 0) {
    return Math.max(layer.total, layer.current);
  }
  return Math.max(expected.get(id) ?? 0, layer.current);
}

/** Whether this layer's size is settled: reported, read from the manifest, or the layer is already done. */
export function layerSizeKnown(id: string, layer: DockerPullLayerSnapshot, expected: ReadonlyMap<string, number>): boolean {
  return layer.total > 0 || expected.has(id) || downloadFinished(statusOf(layer));
}

export function summarizePullLayers(
  layers: ReadonlyMap<string, DockerPullLayerSnapshot>,
  expected: ReadonlyMap<string, number> = new Map(),
): {
  completedBytes: number;
  totalBytes: number;
  stage: DockerPullStage;
  /** Layers seen so far and how many are done, for the pull's status log. */
  layersSeen: number;
  layersDone: number;
} {
  let completedBytes = 0;
  let totalBytes = 0;
  let hasExtractingLayer = false;
  let hasActiveLayer = false;
  let layersSeen = 0;
  let layersDone = 0;

  for (const [id, layer] of layers) {
    const status = statusOf(layer);
    const size = layerSize(id, layer, expected);
    totalBytes += size;

    const isComplete = status.includes('pull complete') || alreadyExists(status);

    if (isLayerEvent(status)) {
      layersSeen += 1;
      if (isComplete) layersDone += 1;
    }

    if (status.includes('extract')) {
      hasExtractingLayer = true;
    }

    if (!isComplete) {
      hasActiveLayer = true;
    }

    // The containerd store sends "Download complete" with no byte counts for a layer that came in
    // between two of its progress polls.
    completedBytes += isComplete || downloadFinished(status) ? size : Math.min(layer.current, size);
  }

  const stage: DockerPullStage = hasActiveLayer ? (hasExtractingLayer ? 'extracting' : 'downloading') : 'complete';
  return { completedBytes, totalBytes, stage, layersSeen, layersDone };
}

/**
 * Whether an image's share of the total is final: Docker has finished announcing its layers and each
 * one has a size or is done. A download-phase event says the announcing is over. So does the manifest
 * once every layer it lists is announced, which classic Docker does before any download.
 */
export function imageSizeKnown(options: {
  layerIds: ReadonlySet<string>;
  layers: ReadonlyMap<string, DockerPullLayerSnapshot>;
  expected: ReadonlyMap<string, number> | undefined;
  downloadStarted: boolean;
  complete: boolean;
}): boolean {
  const { layerIds, layers, expected, downloadStarted, complete } = options;
  if (complete) {
    return true;
  }
  if (layerIds.size === 0 || !(downloadStarted || everyAnnounced(expected, layerIds))) {
    return false;
  }
  const sizes = expected ?? new Map<string, number>();
  for (const id of layerIds) {
    const layer = layers.get(id);
    if (layer === undefined || !layerSizeKnown(id, layer, sizes)) {
      return false;
    }
  }
  return true;
}

function everyAnnounced(expected: ReadonlyMap<string, number> | undefined, layerIds: ReadonlySet<string>): boolean {
  if (!expected || expected.size === 0) {
    return false;
  }
  for (const id of expected.keys()) {
    if (!layerIds.has(id)) {
      return false;
    }
  }
  return true;
}
