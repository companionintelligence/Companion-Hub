/** A file in a Hugging Face repo's file tree. */
export interface GgufFile {
  path: string;
  size?: number;
}

/** A layer of a Hugging Face (or registry) Ollama manifest. */
export interface ManifestLayer {
  mediaType: string;
  size: number;
}

const MODEL_LAYER = 'application/vnd.ollama.image.model';
const FIRST_SHARD = /-00001-of-\d{5}\.gguf$/i;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The file that `<quant>` names in a Hugging Face repo: a name that ends with the quant (`Hy3-Q4_K_M.gguf`), or, for a
 * split model, its first shard (`Hy3-Q4_K_M-00001-of-00005.gguf`), which holds the metadata. Modeled on what Hugging
 * Face's registry endpoint served for `AngelSlim/Hy3-GGUF:Q4_K_M` on 2026-11-15: the plain file, not its `-mtp` sibling.
 * A sibling whose name continues after the quant, and a longer quant that begins with the same letters (`Q4_K` against
 * `Q4_K_M`), are not the quant. Matching ignores case (`-q4_k_m.gguf` is `Q4_K_M`). Where several names end with the
 * quant, the one nearest the repo's root wins (JetBrains' Mellum2.1 repo has `mtp/...-MTP-Q4_K_M.gguf` beside its root
 * file, which the endpoint served), then a first shard over a plain file (Qwen's Qwen2.5-Coder-32B repo lists both, and the
 * endpoint answers that tag "sharded"), then the first listed. Returns undefined when no name ends with the quant.
 */
export function pickQuantFile<T extends GgufFile>(weights: readonly T[], quant: string): T | undefined {
  const ends = new RegExp(`(^|[^a-z0-9])${escapeRegExp(quant)}(-00001-of-\\d{5})?\\.gguf$`, 'i');
  const depth = (file: GgufFile) => file.path.split('/').length;
  const rank = (file: GgufFile) => (FIRST_SHARD.test(file.path) ? 0 : 1);
  // `sort` is stable, so files equal on both keep their listed order.
  return weights.filter((file) => ends.test(file.path)).sort((a, b) => depth(a) - depth(b) || rank(a) - rank(b))[0];
}

/**
 * The GGUF a row loads out of a repo's file tree, and the bytes the load maps: the weights (every shard of a split
 * model) plus the vision projector a Lemonade checkpoint names. `spec` is a file name (`...gguf`) or a quant. A quant
 * that no file name ends with is an error and not a guess: a name that merely contains it is another build.
 */
export function selectGguf<T extends GgufFile>(tree: readonly T[], spec: string, mmproj?: string): { wanted: T; fileBytes: number } {
  const files = tree.filter((f) => f.path.toLowerCase().endsWith('.gguf'));
  const weights = files.filter((f) => !/mmproj/i.test(f.path));
  const byName = spec.toLowerCase().endsWith('.gguf');
  const wanted = byName
    ? weights.find((f) => f.path.toLowerCase() === spec.toLowerCase() || f.path.toLowerCase().endsWith(`/${spec.toLowerCase()}`))
    : pickQuantFile(weights, spec);
  if (!wanted) throw new Error(`no GGUF ${byName ? 'named' : 'named for the quant'} ${JSON.stringify(spec)}`);
  // A split model's metadata is in its first shard; its weights are every shard. A shard is `<prefix>-NNNNN-of-<count>.gguf`
  // exactly, so a sibling set with the same prefix and count (an `-mtp` set beside the plain one) is not counted.
  const split = wanted.path.match(/^(.*)-00001-of-(\d{5})\.gguf$/i);
  const shardOf = split ? new RegExp(`^${escapeRegExp(split[1] ?? '')}-\\d{5}-of-${split[2]}\\.gguf$`, 'i') : undefined;
  const shards = shardOf ? weights.filter((f) => shardOf.test(f.path)) : [wanted];
  const projector = mmproj ? files.find((f) => f.path === mmproj || f.path.endsWith(`/${mmproj}`)) : undefined;
  const fileBytes = [...shards, ...(projector ? [projector] : [])].reduce((sum, f) => sum + (f.size ?? 0), 0);
  return { wanted, fileBytes };
}

/**
 * Whether Hugging Face's Ollama endpoint refused a tag because the repo holds only sharded GGUF files, which Ollama cannot pull:
 * a row for it is sized from the files in the tree. The endpoint answers HTTP 400 for two more things, a quant the repo does not
 * list ("not available in the repository") and a tag that is no quantization scheme, and a row that names one of those has no
 * file to pull at all, so it must stop and not take a file from the tree.
 */
export function isShardedRefusal(status: number, body: string): boolean {
  return status === 400 && /sharded/i.test(body);
}

/**
 * Throws when the file read from a repo's tree is not the model layer that Hugging Face's Ollama manifest serves for the
 * same tag. The header comes from the tree's file and the size from the manifest, which is what a pull fetches, so a
 * mismatch of size means the header is another file's (Hy3's `-mtp` build once was). With no manifest (a repo of
 * shards, which the endpoint refuses) there is nothing to compare, but a manifest with no model layer is an error.
 */
export function assertServedFile(treeBytes: number, layers: readonly ManifestLayer[] | undefined, label: string): void {
  if (!layers) return;
  const served = layers.find((layer) => layer.mediaType === MODEL_LAYER)?.size;
  if (served === undefined) throw new Error(`${label}: Hugging Face's Ollama manifest has no model layer to compare the tree's file with`);
  if (served !== treeBytes) {
    throw new Error(
      `${label}: the file read from the tree is ${treeBytes} bytes, but Hugging Face's Ollama manifest serves a ${served}-byte model: the header would be another file's`,
    );
  }
}

/**
 * An `hf.co/<repo>:<quant>` row: the file to read the header from, and the size the pull fetches. That is every layer of
 * Hugging Face's Ollama manifest (a vision projector is one), or, for a repo that serves none, the files in the tree.
 */
export function resolveHuggingFaceGguf<T extends GgufFile>(
  tree: readonly T[],
  tagged: string,
  quant: string,
  layers: readonly ManifestLayer[] | undefined,
): { wanted: T; fileBytes: number } {
  const picked = selectGguf(tree, quant);
  assertServedFile(picked.fileBytes, layers, tagged);
  return { wanted: picked.wanted, fileBytes: layers ? layers.reduce((sum, layer) => sum + layer.size, 0) : picked.fileBytes };
}
