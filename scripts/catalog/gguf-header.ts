/**
 * A GGUF header reader for the catalog's KV-geometry table (gen-kv-geometry.ts): parses the key/value
 * metadata at the start of a GGUF file from a byte prefix, so a model's attention geometry can be read
 * with an HTTP range request instead of a multi-gigabyte download. Pure: bytes in, values out.
 *
 * Format (ggml docs/gguf.md, v2/v3): magic "GGUF", u32 version, u64 tensor count, u64 kv count, then
 * kv pairs of (string key, u32 type, value). Strings are u64 length + bytes; arrays are u32 element
 * type + u64 count + elements. Little-endian throughout.
 */

const TYPE = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 } as const;
const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** The prefix ended before the metadata did: read more bytes and parse again. */
export class NeedMoreBytes extends Error {
  constructor(readonly have: number) {
    super(`GGUF metadata runs past the first ${have} bytes`);
  }
}

export type GgufValue = number | bigint | boolean | string | GgufValue[] | { skippedArray: number };

/**
 * The metadata in `bytes`, a prefix of a GGUF file. Arrays longer than `maxArray` elements (tokenizer
 * vocabularies, merges) are skipped and recorded only by length: geometry never needs them, and
 * holding 150k strings would be wasteful. Throws {@link NeedMoreBytes} when the prefix is too short.
 */
export function readGgufMetadata(bytes: Uint8Array, maxArray = 4096): Map<string, GgufValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > bytes.byteLength) throw new NeedMoreBytes(bytes.byteLength);
  };
  /** The offset of the next `n` bytes, which are then consumed. */
  const take = (n: number): number => {
    need(n);
    const start = at;
    at += n;
    return start;
  };
  const u32 = () => view.getUint32(take(4), true);
  const u64 = () => view.getBigUint64(take(8), true);
  const str = () => {
    const len = Number(u64());
    const start = take(len);
    return new TextDecoder().decode(bytes.subarray(start, start + len));
  };
  const scalar = (type: number): GgufValue => {
    switch (type) {
      case TYPE.U8:
        return view.getUint8(take(1));
      case TYPE.I8:
        return view.getInt8(take(1));
      case TYPE.U16:
        return view.getUint16(take(2), true);
      case TYPE.I16:
        return view.getInt16(take(2), true);
      case TYPE.U32:
        return u32();
      case TYPE.I32:
        return view.getInt32(take(4), true);
      case TYPE.F32:
        return view.getFloat32(take(4), true);
      case TYPE.BOOL:
        return view.getUint8(take(1)) !== 0;
      case TYPE.STRING:
        return str();
      case TYPE.U64:
        return u64();
      case TYPE.I64:
        return view.getBigInt64(take(8), true);
      case TYPE.F64:
        return view.getFloat64(take(8), true);
      default:
        throw new Error(`unknown GGUF value type ${type}`);
    }
  };
  const value = (type: number): GgufValue => {
    if (type !== TYPE.ARRAY) return scalar(type);
    const elementType = u32();
    const count = Number(u64());
    if (count > maxArray) {
      // Skipped without decoding: fixed-size elements by arithmetic, strings one length at a time.
      if (elementType === TYPE.STRING) {
        for (let i = 0; i < count; i++) take(Number(u64()));
      } else {
        const size = FIXED_SIZE[elementType];
        if (size === undefined) throw new Error(`cannot skip an array of GGUF type ${elementType}`);
        take(size * count);
      }
      return { skippedArray: count };
    }
    return Array.from({ length: count }, () => value(elementType));
  };

  need(4);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== 'GGUF') throw new Error(`not a GGUF file (magic ${JSON.stringify(magic)})`);
  at = 4;
  const version = u32();
  if (version < 2) throw new Error(`GGUF version ${version} is not supported`);
  u64(); // tensor count
  const kvCount = Number(u64());
  const out = new Map<string, GgufValue>();
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    const type = u32();
    out.set(key, value(type));
  }
  return out;
}

/** A positive integer, from a number or bigint value. */
function int(v: GgufValue | undefined): number | null {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export interface KvGeometry {
  architecture: string;
  /** f16 KV-cache bytes one token of context costs in the layers whose cache grows with the window. */
  kvBytesPerToken: number;
  /** f16 bytes per cached token in the sliding-window layers, whose cache stops at `slidingWindow` tokens. */
  slidingKvBytesPerToken: number;
  /** Tokens a sliding-window layer keeps; 0 when no layer slides. */
  slidingWindow: number;
  /** Layers that keep a per-token cache of their own, sliding ones included, out of `blockCount`. */
  kvLayers: number;
  slidingLayers: number;
  blockCount: number;
}

/**
 * Which layers slide when the file carries no `attention.sliding_window_pattern`: llama.cpp's
 * `hparams.set_swa_pattern(n)` per family (src/llama-model.cpp), where layer `il` slides when
 * `il % n < n - 1`. A family not listed here is counted as all-global even if its file has a
 * `sliding_window`: llama.cpp ignores the key for some families (qwen2), and over-counting is the
 * safe direction. llama4's chunked attention keeps `chunk_size` tokens in the same way.
 */
const SWA_PATTERN: Readonly<Record<string, number>> = { gemma2: 2, gemma3: 6, 'gpt-oss': 2, cohere2: 4, llama4: 4 };

/**
 * f16 KV bytes per token from llama.cpp's own metadata keys, as the runner allocates them:
 * - `attention.head_count_kv`, a scalar or a per-layer array (qwen35: 0 on the linear-attention layers
 *   that keep a fixed-size state and no per-token cache);
 * - `full_attention_interval` (only every Nth block keeps a cache; multi-token-prediction blocks after
 *   the main stack always do) and `attention.shared_kv_layers`
 *   (gemma3n/gemma4: the last N layers reuse an earlier layer's cache) remove layers;
 * - sliding-window layers (the pattern array, else {@link SWA_PATTERN}) are reported apart, at their
 *   own head size (`key_length_swa`) — llama.cpp sizes their cache to the window plus one batch;
 * - MLA (`attention.kv_lora_rank`, deepseek2/GLM): one compressed latent plus the rope part per layer.
 * Null when the keys are not there.
 */
export function kvGeometryFromGguf(meta: Map<string, GgufValue>): KvGeometry | null {
  const architecture = meta.get('general.architecture');
  if (typeof architecture !== 'string') return null;
  const key = (suffix: string) => meta.get(`${architecture}.${suffix}`);
  const blockCount = int(key('block_count'));
  if (blockCount === null) return null;
  const headCount = int(key('attention.head_count'));
  const embedding = int(key('embedding_length'));
  const none = { slidingKvBytesPerToken: 0, slidingWindow: 0, slidingLayers: 0 };

  const loraRank = int(key('attention.kv_lora_rank'));
  if (loraRank !== null) {
    const rope = int(key('rope.dimension_count')) ?? 64;
    return { architecture, kvBytesPerToken: blockCount * (loraRank + rope) * 2, kvLayers: blockCount, blockCount, ...none };
  }

  const keyLength = int(key('attention.key_length')) ?? (embedding && headCount ? Math.ceil(embedding / headCount) : null);
  const valueLength = int(key('attention.value_length')) ?? keyLength;
  if (keyLength === null || valueLength === null) return null;
  const swaKey = int(key('attention.key_length_swa')) ?? keyLength;
  const swaValue = int(key('attention.value_length_swa')) ?? valueLength;

  const kvHeadsValue = key('attention.head_count_kv');
  const scalarHeads = Array.isArray(kvHeadsValue) ? null : (int(kvHeadsValue) ?? headCount);
  if (!Array.isArray(kvHeadsValue) && scalarHeads === null) return null;
  const headsAt = (il: number) => (Array.isArray(kvHeadsValue) ? (int(kvHeadsValue[il] as GgufValue) ?? 0) : (scalarHeads as number));

  const window = int(key('attention.sliding_window')) ?? int(key('attention.chunk_size'));
  const patternValue = key('attention.sliding_window_pattern');
  const patternN = SWA_PATTERN[architecture];
  const slides = (il: number): boolean => {
    if (window === null) return false;
    if (Array.isArray(patternValue)) return patternValue[il] === true;
    return patternN !== undefined && il % patternN < patternN - 1;
  };
  const owning = blockCount - (int(key('attention.shared_kv_layers')) ?? 0);
  const interval = int(key('full_attention_interval'));
  // Multi-token-prediction blocks (qwen35 MTP: `nextn_predict_layers`) sit after the main stack and
  // are full attention: llama.cpp gives each a cache, which the measured 0.0667 MB/token of Qwen 3.8
  // 27B on Lemonade (65 blocks, 16 + 1 cached) confirms.
  const firstNextn = blockCount - (int(key('nextn_predict_layers')) ?? 0);

  let kvBytesPerToken = 0;
  let slidingKvBytesPerToken = 0;
  let kvLayers = 0;
  let slidingLayers = 0;
  for (let il = 0; il < Math.max(1, owning); il++) {
    // Without a per-layer array, `full_attention_interval` says which blocks keep a cache (every Nth, the last of each group).
    if (!Array.isArray(kvHeadsValue) && interval !== null && interval > 1 && il < firstNextn && (il + 1) % interval !== 0) continue;
    const heads = headsAt(il);
    if (heads <= 0) continue;
    kvLayers++;
    if (slides(il)) {
      slidingLayers++;
      slidingKvBytesPerToken += heads * (swaKey + swaValue) * 2;
    } else {
      kvBytesPerToken += heads * (keyLength + valueLength) * 2;
    }
  }
  if (kvLayers === 0) return null;
  return {
    architecture,
    kvBytesPerToken,
    slidingKvBytesPerToken,
    slidingWindow: slidingLayers > 0 ? (window as number) : 0,
    kvLayers,
    slidingLayers,
    blockCount,
  };
}
