/**
 * How a running image pull adds up, from Docker's per-layer progress events.
 *
 * Docker announces every layer of an image up front ("Pulling fs layer", or "Already exists"
 * for one it has), but only reports a layer's size once that layer starts downloading, and it
 * downloads three at a time. Adding up only the sizes reported so far gave a total that grew all
 * through the download: ZeroNote's 26 MB read "3.0 MB / 3.7 MB" while its first layer was the only
 * one with a size (CI-Hub#2177). So a layer's size can also come from the image manifest, read
 * from the registry while the pull runs, and the total is only called known once every announced
 * layer has a size or has finished.
 */

export interface DockerPullLayerSnapshot {
  current: number;
  total: number;
  status: string;
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
 * A status Docker only sends once the image's downloads have begun, by which point every layer has
 * been announced. Not "Already exists": classic Docker prints that in a layer's place while it is
 * still announcing the rest.
 */
export const isDownloadPhase = (status: string) => {
  const s = status.toLowerCase();
  return !alreadyExists(s) && (s.startsWith('downloading') || downloadFinished(s));
};

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

    completedBytes += isComplete ? size : Math.min(layer.current, size);
  }

  const stage: DockerPullStage = hasActiveLayer ? (hasExtractingLayer ? 'extracting' : 'downloading') : 'complete';
  return { completedBytes, totalBytes, stage, layersSeen, layersDone };
}

/**
 * Whether an image's share of the total is final: every one of its layers has a size or is done,
 * and every layer it has is known to be announced. The manifest says which layers there are; without
 * it, a download-phase event says Docker has finished announcing them.
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
  const allAnnounced = expected && expected.size > 0 ? [...expected.keys()].every((id) => layerIds.has(id)) : downloadStarted;
  if (!allAnnounced || layerIds.size === 0) {
    return false;
  }
  const sizes = expected ?? new Map<string, number>();
  return [...layerIds].every((id) => {
    const layer = layers.get(id);
    return layer !== undefined && layerSizeKnown(id, layer, sizes);
  });
}
