import { describe, expect, it } from 'vitest';
import { kvGeometryFromGguf, NeedMoreBytes, readGgufMetadata } from '../catalog/gguf-header';

type Value = number | string | boolean | number[] | boolean[] | string[] | { u64: number };

/** A GGUF v3 header with these key/values: u32 for whole numbers, bool, string, and arrays of those. */
function gguf(kv: Record<string, Value>): Uint8Array {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const typed = (v: Exclude<Value, unknown[]>): [number, Buffer] => {
    if (typeof v === 'object') return [10, u64(v.u64)];
    if (typeof v === 'string') return [8, str(v)];
    if (typeof v === 'boolean') return [7, Buffer.from([v ? 1 : 0])];
    return [4, u32(v)];
  };
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length));
  for (const [key, value] of Object.entries(kv)) {
    parts.push(str(key));
    if (Array.isArray(value)) {
      const [type] = typed(value[0] as never);
      parts.push(u32(9), u32(type), u64(value.length), ...value.map((v) => typed(v as never)[1]));
    } else {
      const [type, bytes] = typed(value);
      parts.push(u32(type), bytes);
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

const geometry = (kv: Record<string, Value>) => kvGeometryFromGguf(readGgufMetadata(gguf(kv)));

describe('readGgufMetadata', () => {
  it('reads scalars, strings and arrays, and skips a long array by length', () => {
    const meta = readGgufMetadata(
      gguf({ 'general.architecture': 'llama', 'llama.block_count': 32, 'tokenizer.ggml.scores': Array(5000).fill(1) }),
      4096,
    );
    expect(meta.get('general.architecture')).toBe('llama');
    expect(meta.get('llama.block_count')).toBe(32);
    expect(meta.get('tokenizer.ggml.scores')).toEqual({ skippedArray: 5000 });
  });

  it('asks for more bytes when the prefix ends inside the metadata, and refuses a non-GGUF file', () => {
    const whole = gguf({ 'general.architecture': 'llama', 'general.name': 'x'.repeat(200) });
    expect(() => readGgufMetadata(whole.subarray(0, 100))).toThrow(NeedMoreBytes);
    expect(() => readGgufMetadata(new TextEncoder().encode('Entry not found'))).toThrow(/not a GGUF file/);
  });
});

describe('kvGeometryFromGguf', () => {
  // Qwen 3.8 27B as Lemonade serves it: 64 blocks with full attention every fourth, plus one MTP block.
  // 17 cached layers × 4 heads × (256 + 256) × 2 bytes = 69,632, the 0.0664 MB measured at 0.0667.
  it('counts every Nth block of a hybrid model, and its multi-token-prediction block', () => {
    expect(
      geometry({
        'general.architecture': 'qwen35',
        'qwen35.block_count': 65,
        'qwen35.attention.head_count': 24,
        'qwen35.attention.head_count_kv': 4,
        'qwen35.attention.key_length': 256,
        'qwen35.attention.value_length': 256,
        'qwen35.full_attention_interval': 4,
        'qwen35.nextn_predict_layers': 1,
      }),
    ).toMatchObject({ kvBytesPerToken: 69_632, kvLayers: 17, slidingLayers: 0 });
  });

  it('sums a per-layer head count, where 0 marks a layer with no per-token cache', () => {
    expect(
      geometry({
        'general.architecture': 'qwen35',
        'qwen35.block_count': 8,
        'qwen35.attention.head_count': 16,
        'qwen35.attention.head_count_kv': [0, 0, 0, 4, 0, 0, 0, 4],
        'qwen35.attention.key_length': 256,
        'qwen35.attention.value_length': 256,
      }),
    ).toMatchObject({ kvBytesPerToken: 2 * 4 * 512 * 2, kvLayers: 2 });
  });

  // gemma3 carries no pattern: llama.cpp's set_swa_pattern(6) slides five layers of every six.
  it("splits sliding-window layers out by llama.cpp's family pattern when the file has none", () => {
    expect(
      geometry({
        'general.architecture': 'gemma3',
        'gemma3.block_count': 48,
        'gemma3.attention.head_count': 16,
        'gemma3.attention.head_count_kv': 8,
        'gemma3.attention.key_length': 256,
        'gemma3.attention.value_length': 256,
        'gemma3.attention.sliding_window': 1024,
      }),
    ).toEqual({
      architecture: 'gemma3',
      kvBytesPerToken: 8 * 8 * 512 * 2,
      slidingKvBytesPerToken: 40 * 8 * 512 * 2,
      slidingWindow: 1024,
      kvLayers: 48,
      slidingLayers: 40,
      blockCount: 48,
    });
  });

  it("reads the file's own pattern and the sliding layers' head size, and drops shared-cache layers", () => {
    const pattern = [true, true, false, true, true, false];
    expect(
      geometry({
        'general.architecture': 'gemma4',
        'gemma4.block_count': 6,
        'gemma4.attention.head_count': 8,
        'gemma4.attention.head_count_kv': [4, 4, 1, 4, 4, 1],
        'gemma4.attention.key_length': 512,
        'gemma4.attention.value_length': 512,
        'gemma4.attention.key_length_swa': 256,
        'gemma4.attention.value_length_swa': 256,
        'gemma4.attention.sliding_window': 512,
        'gemma4.attention.sliding_window_pattern': pattern,
        'gemma4.attention.shared_kv_layers': 3,
      }),
    ).toMatchObject({ kvBytesPerToken: 1 * 1024 * 2, slidingKvBytesPerToken: 2 * 4 * 512 * 2, kvLayers: 3, slidingLayers: 2, slidingWindow: 512 });
  });

  it('counts a family llama.cpp does not slide as all-global, sliding_window key or not', () => {
    expect(
      geometry({
        'general.architecture': 'qwen2',
        'qwen2.block_count': 28,
        'qwen2.attention.head_count': 12,
        'qwen2.attention.head_count_kv': 2,
        'qwen2.embedding_length': 1536,
        'qwen2.attention.sliding_window': 4096,
      }),
    ).toMatchObject({ kvBytesPerToken: 28 * 2 * 256 * 2, slidingLayers: 0, slidingWindow: 0 });
  });

  it('charges MLA one compressed latent plus the rope part per layer', () => {
    expect(
      geometry({
        'general.architecture': 'deepseek2',
        'deepseek2.block_count': 47,
        'deepseek2.attention.head_count': 20,
        'deepseek2.attention.kv_lora_rank': 512,
        'deepseek2.rope.dimension_count': 64,
      }),
    ).toMatchObject({ kvBytesPerToken: 47 * 576 * 2 });
  });

  it('returns null without the geometry keys', () => {
    expect(geometry({ 'general.architecture': 'llama' })).toBeNull();
  });
});
