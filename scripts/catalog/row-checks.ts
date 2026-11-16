/**
 * What a catalog row's primary data says about the row. Pure: the data row-reads.ts fetched goes in, findings come out,
 * so every rule here is tested against recorded registry answers without a network.
 *
 * Two levels of finding, because they ask different things of a person:
 *  - `fail`: the row cannot work as listed. Its model cannot be pulled, its repo is gone, gated or empty, or it is a cloud
 *    proxy in a catalog that is local only. The script exits nonzero.
 *  - `warn`: the row works, but something it says has drifted from the registry or will not hold on the fleet: a size, a
 *    quant label, a context window, or an Ollama version the pin is below. Reported, and a failure only under `--strict`.
 * `unverified` is neither: the registry could not be read, so nothing is known. It also exits nonzero.
 */
import { compareOllamaVersions } from '../lib/fleet-ollama-version';
import { type HfGgufRef, hfGgufRef, ollamaRef } from './registry-endpoints';
import type { HfRepoRead, OllamaConfig, OllamaManifest, Read } from './row-reads';

/** What a check needs to know about one catalog row. */
export interface CheckRow {
  id: string;
  backend: string;
  backendModelId: string;
  /** The label the catalog gives the row's quantisation (`runtime.quantization`). */
  quant: string;
  /** The download size as the row's table authors it, in decimal GB (the TOON `gb` column). */
  gb: number;
  /** The window the row advertises, in tokens. */
  contextWindow: number;
  /** The bytes of files `kv-geometry.generated.ts` records for the row, when it has an entry. */
  fileBytes?: number;
  gpuVendors: readonly string[];
}

export type FindingLevel = 'fail' | 'unverified' | 'warn';

export type FindingCode =
  | 'missing'
  | 'unpullable'
  | 'gated'
  | 'cloud'
  | 'unverified'
  | 'size-drift'
  | 'no-geometry'
  | 'size-gb'
  | 'quant'
  | 'requires'
  | 'ctx'
  | 'no-ctx'
  | 'no-weights';

export interface Finding {
  level: FindingLevel;
  code: FindingCode;
  message: string;
}

/** What was found, and what was read to find it (the facts a row that passes is shown with). */
export interface Verdict {
  findings: Finding[];
  facts: string[];
}

/** `skip` is a row no check covers; the others follow from the worst finding a row has. */
export type RowStatus = 'ok' | 'warn' | 'unverified' | 'fail' | 'skip';

export interface RowResult {
  id: string;
  backend: string;
  /** The row's `backendModelId`. */
  target: string;
  status: RowStatus;
  findings: Finding[];
  facts: string[];
}

export function statusOf(findings: readonly Finding[]): Exclude<RowStatus, 'skip'> {
  for (const level of ['fail', 'unverified', 'warn'] as const) {
    if (findings.some((finding) => finding.level === level)) return level;
  }
  return 'ok';
}

const fail = (code: FindingCode, message: string): Finding => ({ level: 'fail', code, message });
const warn = (code: FindingCode, message: string): Finding => ({ level: 'warn', code, message });
export const unverified = (message: string): Finding => ({ level: 'unverified', code: 'unverified', message });

/** The size a row's authored `gb` may be off the registry's files by. The library's own figures round, and a tag can be rebuilt a little smaller. */
const SIZE_TOLERANCE = 0.1;

const MODEL_LAYER = 'application/vnd.ollama.image.model';

/**
 * Rows whose default build is not the q4_K_M the Ollama table labels every row with, and the `file_type` each carries.
 * An entry is a known mislabel the table lives with; a different `file_type` for the same row is still a finding.
 */
export const FILE_TYPE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'gpt-oss-20b': 'MXFP4',
  'gpt-oss-120b': 'MXFP4',
  'gemma3-270m': 'Q8_0',
};

const bytesText = (n: number): string => `${n.toLocaleString('en-US')} B`;
const gbText = (n: number): string => `${(n / 1e9).toFixed(2)} GB`;
const percentOff = (ratio: number): string => `${ratio >= 1 ? '+' : '-'}${(Math.abs(ratio - 1) * 100).toFixed(1)}%`;

/** A registry's refusal as a finding. Hugging Face answers 401 for a repo that does not exist as well as for one that is private. */
function refusal(status: number, message: string, who: string): Finding {
  const answer = `${who} answered HTTP ${status}${message ? `: ${message}` : ''}`;
  if (status === 404) return fail('missing', answer);
  if (status === 401 || status === 403) {
    return fail('missing', who === 'Hugging Face' ? `${answer} (a missing repo and a private one look alike without a token)` : answer);
  }
  return fail('unpullable', answer);
}

/** Hugging Face's Ollama endpoint uses 400 for two different things: a repo of shards, and a quant the repo does not have. */
function hfGgufRefusal(ref: HfGgufRef, status: number, message: string): Finding {
  if (status === 400 && /sharded/i.test(message)) {
    return fail('unpullable', 'Hugging Face answers HTTP 400: the repo holds only sharded GGUF files, which Ollama cannot pull');
  }
  if (status === 400 && /valid quantization/i.test(message)) {
    return fail('missing', `Hugging Face has no ${ref.quant} quant in ${ref.repo} (HTTP 400: ${message})`);
  }
  return refusal(status, message, 'Hugging Face');
}

const UNSIZED_LAYER = 'a layer of the manifest states no size, so the download size is unchecked';

/** The sum of a manifest's layer sizes, or undefined when a layer states none: counting it as 0 would read as a model that shrank. */
function layerBytes(layers: readonly { size?: number }[]): number | undefined {
  let total = 0;
  for (const layer of layers) {
    if (typeof layer.size !== 'number' || !Number.isFinite(layer.size) || layer.size < 0) return undefined;
    total += layer.size;
  }
  return total;
}

/** The sum of a manifest's layers against the generated table and against the row's authored `gb`. */
function judgeLayerSizes(row: CheckRow, total: number): Finding[] {
  const findings: Finding[] = [];
  if (row.fileBytes === undefined) {
    findings.push(
      warn(
        'no-geometry',
        `kv-geometry.generated.ts has no entry for the row (run gen-kv-geometry.ts --only ${row.id}); the layers total ${bytesText(total)}`,
      ),
    );
  } else if (row.fileBytes !== total) {
    findings.push(
      warn(
        'size-drift',
        `the layers total ${bytesText(total)} but kv-geometry.generated.ts has fileBytes ${bytesText(row.fileBytes)} (run gen-kv-geometry.ts --only ${row.id})`,
      ),
    );
  }
  const ratio = total / 1e9 / row.gb;
  if (!(Math.abs(ratio - 1) <= SIZE_TOLERANCE)) {
    findings.push(
      warn(
        'size-gb',
        `the layers total ${gbText(total)} against the row's gb ${row.gb} (${percentOff(ratio)}, more than ${SIZE_TOLERANCE * 100}% off)`,
      ),
    );
  }
  return findings;
}

/** The label the registry's `file_type` is expected to match: the table's, or the one a known exception carries. */
function judgeFileType(
  row: CheckRow,
  fileType: string | undefined,
  exceptions: Readonly<Record<string, string>>,
): { finding?: Finding; fact?: string } {
  if (!fileType || fileType.toLowerCase() === 'unknown')
    return { finding: warn('quant', `the config states no file_type, so the ${row.quant} label is unchecked`) };
  const exception = exceptions[row.id];
  const expected = exception ?? row.quant;
  if (fileType.toLowerCase() === expected.toLowerCase()) return { fact: exception ? `${fileType} (a known exception to ${row.quant})` : fileType };
  const exceptionNote = exception ? `; the known exception for this row is ${exception}` : '';
  const ungated =
    fileType.toUpperCase() === 'NVFP4' && row.gpuVendors.some((vendor) => vendor !== 'nvidia')
      ? `, and the row's gpuVendors (${row.gpuVendors.join(', ')}) does not gate it to NVIDIA`
      : '';
  return { finding: warn('quant', `config file_type ${fileType}, the row says ${row.quant}${ungated}${exceptionNote}`) };
}

/** An Ollama registry row (`family:tag` or `namespace/model:tag`): its manifest and config blob. */
export function judgeOllamaRow(
  row: CheckRow,
  read: Read<{ manifest: OllamaManifest; config: OllamaConfig }>,
  pin: string,
  exceptions: Readonly<Record<string, string>> = FILE_TYPE_EXCEPTIONS,
): Verdict {
  if (!read.ok) return { findings: [refusal(read.status, read.message, 'registry.ollama.ai')], facts: [] };
  const { manifest, config } = read.value;
  const layers = manifest.layers ?? [];
  const tag = ollamaRef(row.backendModelId).tag;

  // The catalog is local only: a proxy to Ollama's cloud "fits" every machine and would win every recommendation.
  if (config.remote_host || config.remote_model || tag === 'cloud' || tag.endsWith('-cloud')) {
    const marker = config.remote_host
      ? `remote_host ${config.remote_host}`
      : config.remote_model
        ? `remote_model ${config.remote_model}`
        : `tag ${tag}`;
    return { findings: [fail('cloud', `a cloud proxy, not a local build (${marker}), in a catalog that lists only local models`)], facts: [] };
  }
  if (!layers.some((layer) => layer.mediaType === MODEL_LAYER)) {
    return { findings: [fail('unpullable', 'the manifest has no model layer, so there are no weights to pull')], facts: [] };
  }

  const total = layerBytes(layers);
  const findings = total === undefined ? [unverified(UNSIZED_LAYER)] : judgeLayerSizes(row, total);
  const facts = total === undefined ? [] : [gbText(total)];

  const fileType = judgeFileType(row, typeof config.file_type === 'string' ? config.file_type : undefined, exceptions);
  if (fileType.finding) findings.push(fileType.finding);
  if (fileType.fact) facts.unshift(fileType.fact);

  const requires: unknown = config.requires;
  if (typeof requires === 'string' && requires) {
    facts.push(`requires ${requires}`);
    if (compareOllamaVersions(requires, pin) > 0) {
      findings.push(warn('requires', `needs Ollama ${requires}, above the pin ${pin}: a ${pin} client gets HTTP 412 from the registry`));
    }
  } else if (requires !== undefined && requires !== null && requires !== '') {
    findings.push(
      unverified(`the config's requires is ${JSON.stringify(requires)}, not a version string, so the Ollama version it needs is unchecked`),
    );
  }
  return { findings, facts };
}

/** An `hf.co/<repo>:<quant>` row: the manifest Hugging Face serves an Ollama client. */
export function judgeHfGgufRow(
  row: CheckRow,
  read: Read<OllamaManifest>,
  exceptions: Readonly<Record<string, string>> = FILE_TYPE_EXCEPTIONS,
): Verdict {
  const ref = hfGgufRef(row.backendModelId);
  if (!read.ok) return { findings: [hfGgufRefusal(ref, read.status, read.message)], facts: [] };
  const layers = read.value.layers ?? [];
  if (!layers.some((layer) => layer.mediaType === MODEL_LAYER)) {
    return { findings: [fail('unpullable', 'the manifest has no model layer, so there are no weights to pull')], facts: [] };
  }
  const total = layerBytes(layers);
  const findings = total === undefined ? [unverified(UNSIZED_LAYER)] : judgeLayerSizes(row, total);
  // Hugging Face's config blob says `file_type: "unknown"`, so the quant the pull tag names is all there is to compare the label with.
  // A row that is known to carry another quant (an exception, by the tag it pulls) is held to that one.
  const exception = exceptions[row.id];
  if (ref.quant.toLowerCase() !== (exception ?? row.quant).toLowerCase()) {
    findings.push(
      warn(
        'quant',
        `the pull tag is ${ref.quant}, the row says ${row.quant}${exception ? `; the known exception for this row is ${exception}` : ''}`,
      ),
    );
  }
  const tagFact = exception && ref.quant.toLowerCase() === exception.toLowerCase() ? `${ref.quant} (a known exception to ${row.quant})` : ref.quant;
  return { findings, facts: total === undefined ? [tagFact] : [tagFact, gbText(total)] };
}

/** The first `max_position_embeddings` in a Hugging Face `config.json`: the top level, else the text model's section of a multimodal config. */
export function contextLimit(config: Record<string, unknown>): { value: number; path: string } | undefined {
  for (const section of [undefined, 'text_config', 'language_config', 'llm_config']) {
    const scope = section === undefined ? config : config[section];
    const value = typeof scope === 'object' && scope !== null ? (scope as Record<string, unknown>).max_position_embeddings : undefined;
    if (typeof value === 'number' && value > 0) return { value, path: section ? `${section}.max_position_embeddings` : 'max_position_embeddings' };
  }
  return undefined;
}

const OTHER_WEIGHTS = /\.(?:bin|pt|pth|ckpt|gguf|npz)$/i;

/**
 * How much a repo's weights hold: the `.safetensors` at its root, which is what vLLM and mlx-lm load. A file in a subfolder
 * is not loaded: gpt-oss's `original/` is a second copy of the weights, and Ornith's `optiq/` holds a vision tower and a
 * draft head that mlx-lm does not read. `outside` lists them with their sizes, so a finding can say what a larger gb counted.
 */
export function rootWeightBytes(files: NonNullable<HfRepoRead['model']['siblings']>): {
  total: number;
  unsized: string[];
  count: number;
  outside: { name: string; size: number }[];
  /** Weights at the root in a format the checker does not size, such as `.bin` or `.gguf`. */
  other: string[];
} {
  const safetensors = files.filter((file) => file.rfilename?.endsWith('.safetensors'));
  const weights = safetensors.filter((file) => !file.rfilename?.includes('/'));
  return {
    total: weights.reduce((sum, file) => sum + (file.size ?? 0), 0),
    unsized: weights.filter((file) => typeof file.size !== 'number').map((file) => file.rfilename ?? ''),
    count: weights.length,
    outside: safetensors.filter((file) => file.rfilename?.includes('/')).map((file) => ({ name: file.rfilename ?? '', size: file.size ?? 0 })),
    other: files
      .filter((file) => file.rfilename && !file.rfilename.includes('/') && OTHER_WEIGHTS.test(file.rfilename))
      .map((file) => file.rfilename ?? ''),
  };
}

/** The most the authored `gb` may be off the repo's weights, in decimal GB: one decimal's rounding, and 0.5 % of a large model. */
const repoSizeTolerance = (gb: number): number => Math.max(0.1, gb * 0.005);

/** An oMLX or vLLM row: a Hugging Face repo that has to exist, be open to anonymous reads, hold the weights the row says, and reach the window the row advertises. */
export function judgeHfRepoRow(row: CheckRow, read: Read<HfRepoRead>): Verdict {
  if (!read.ok) return { findings: [refusal(read.status, read.message, 'Hugging Face')], facts: [] };
  const { model, config, configStatus } = read.value;
  if (model.private || model.disabled) return { findings: [fail('missing', `the repo is ${model.private ? 'private' : 'disabled'}`)], facts: [] };
  if (model.gated === undefined) return { findings: [unverified('the API record has no `gated` field, so the repo may be gated')], facts: [] };
  if (model.gated !== false) {
    return {
      findings: [fail('gated', `the repo is gated (gated: ${JSON.stringify(model.gated)}); the Hub holds no Hugging Face token, so a pull gets 401`)],
      facts: [],
    };
  }

  const findings: Finding[] = [];
  const facts: string[] = [];
  if (!Array.isArray(model.siblings))
    return { findings: [unverified('the API record has no file list (siblings), so the weights are unchecked')], facts: [] };
  const weights = rootWeightBytes(model.siblings);
  if (weights.count === 0) {
    // A repo with weights in another format may still load (vLLM reads .bin); one with none cannot be served at all.
    findings.push(
      weights.other.length > 0
        ? warn('no-weights', `the repo has no .safetensors file at its root (it holds ${weights.other.join(', ')}), so its size is unchecked`)
        : fail('no-weights', 'the repo holds no weight file at its root (no .safetensors, .bin, .pt or .gguf), so there is nothing to load'),
    );
  } else if (weights.unsized.length > 0) {
    findings.push(unverified(`the API record lists no size for ${weights.unsized.join(', ')}`));
  } else {
    facts.push(gbText(weights.total));
    const tolerance = repoSizeTolerance(row.gb);
    const off = Math.abs(weights.total / 1e9 - row.gb);
    if (off > tolerance) {
      // A gb that is right for the whole repo and wrong for its root shards counted files that vLLM and mlx-lm do not load.
      const whole = weights.total + weights.outside.reduce((sum, file) => sum + file.size, 0);
      const counted =
        weights.outside.length > 0 && Math.abs(whole / 1e9 - row.gb) <= tolerance
          ? `; the row's gb matches the whole repo (${gbText(whole)}), which counts ${weights.outside.map((file) => file.name).join(', ')} outside the root, and vLLM and mlx-lm read only the root shards`
          : '';
      findings.push(
        warn(
          'size-gb',
          `the root .safetensors total ${gbText(weights.total)} against the row's gb ${row.gb} (${off.toFixed(2)} GB off, over ${tolerance.toFixed(2)})${counted}`,
        ),
      );
    }
  }

  if (!config) {
    findings.push(warn('no-ctx', `config.json answered HTTP ${configStatus ?? 'nothing'}, so the ${row.contextWindow}-token window is unchecked`));
    return { findings, facts };
  }
  const limit = contextLimit(config);
  if (!limit) {
    findings.push(warn('no-ctx', `config.json has no max_position_embeddings, so the ${row.contextWindow}-token window is unchecked`));
  } else if (limit.value < row.contextWindow) {
    findings.push(warn('ctx', `${limit.path} is ${limit.value}, below the ${row.contextWindow} tokens the row advertises`));
  } else {
    facts.push(`max_position_embeddings ${limit.value}`);
  }
  return { findings, facts };
}
