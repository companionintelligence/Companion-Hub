import { describe, expect, it } from 'vitest';
import { estimateContextCost, kvBytesPerToken, type ModelGeometry, parseModelGeometry } from '../model-geometry.util';

function geometryOf(info: Record<string, unknown>): ModelGeometry {
  const geometry = parseModelGeometry(info);
  if (!geometry) throw new Error('fixture geometry did not parse');
  return geometry;
}

const MIB = 1024 ** 2;

/** `/api/show` of qwen3.8:27b-mtp-q4_K_M on 2026-09-17: hybrid attention, 4 KV heads, every 4th block full attention. */
const QWEN38_INFO = {
  'general.architecture': 'qwen35',
  'qwen35.block_count': 65,
  'qwen35.attention.head_count': 24,
  'qwen35.attention.head_count_kv': 4,
  'qwen35.attention.key_length': 256,
  'qwen35.attention.value_length': 256,
  'qwen35.context_length': 262144,
  'qwen35.full_attention_interval': 4,
};
const QWEN38_WEIGHTS = 17_741_872_154;

/** gemma4:e4b: 42 blocks of which 18 share a KV cache. */
const GEMMA4_INFO = {
  'general.architecture': 'gemma4',
  'gemma4.block_count': 42,
  'gemma4.attention.head_count': 8,
  'gemma4.attention.head_count_kv': 2,
  'gemma4.attention.key_length': 512,
  'gemma4.attention.value_length': 512,
  'gemma4.attention.shared_kv_layers': 18,
  'gemma4.context_length': 131_072,
};
const GEMMA4_WEIGHTS = 9_608_350_718;

describe('parseModelGeometry', () => {
  it('reads the geometry under the architecture prefix, including the hybrid-attention interval', () => {
    expect(parseModelGeometry(QWEN38_INFO)).toEqual({
      architecture: 'qwen35',
      blockCount: 65,
      headCount: 24,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      trainingContextLength: 262144,
      sharedKvLayers: 0,
      fullAttentionInterval: 4,
    });
  });

  it('accepts the Map the client typings declare as well as the plain object the wire carries', () => {
    expect(parseModelGeometry(new Map(Object.entries(GEMMA4_INFO)))).toMatchObject({ architecture: 'gemma4', sharedKvLayers: 18 });
  });

  it('returns null when the block or head count is missing, or there is no architecture', () => {
    expect(parseModelGeometry({ 'general.architecture': 'x', 'x.block_count': 10 })).toBeNull();
    expect(parseModelGeometry({ 'x.block_count': 10, 'x.attention.head_count': 2 })).toBeNull();
    expect(parseModelGeometry(null)).toBeNull();
  });
});

describe('kvBytesPerToken', () => {
  it('charges only the layers that own a full-attention KV cache', () => {
    // 17 of 65 blocks are full attention; 4 KV heads × (256 + 256) × 2 bytes.
    expect(kvBytesPerToken(geometryOf(QWEN38_INFO))).toBe(17 * 4 * 512 * 2);
    // 42 − 18 shared = 24 layers; 2 KV heads × 1024 × 2 bytes.
    expect(kvBytesPerToken(geometryOf(GEMMA4_INFO))).toBe(24 * 2 * 1024 * 2);
  });

  it('falls back to head_count when head_count_kv was dropped by the API (over-estimates, the safe direction)', () => {
    const { 'qwen35.attention.head_count_kv': _dropped, ...withoutKv } = QWEN38_INFO;
    expect(kvBytesPerToken(geometryOf(withoutKv))).toBe(17 * 24 * 512 * 2);
  });
});

describe('estimateContextCost', () => {
  it('derives the cost from geometry alone when the model is not loaded', () => {
    const cost = estimateContextCost({ geometry: parseModelGeometry(QWEN38_INFO), weightBytes: QWEN38_WEIGHTS, sighting: null });
    expect(cost?.source).toBe('geometry');
    expect(cost?.kvMbPerToken).toBeCloseTo((17 * 4 * 512 * 2) / MIB, 6);
    expect(cost?.weightMb).toBeCloseTo(QWEN38_WEIGHTS / MIB, 3);
  });

  it('prefers a live sighting when it is tighter than the formula (the dropped-head_count_kv case)', () => {
    const { 'qwen35.attention.head_count_kv': _dropped, ...withoutKv } = QWEN38_INFO;
    // Formula without KV heads says ~0.4 MB/token; the loaded runner shows ~2.3 GB above weights+overhead at 32k.
    const sighting = { contextLength: 32_768, vramBytes: QWEN38_WEIGHTS + 768 * MIB + 2_300 * MIB };
    const cost = estimateContextCost({ geometry: parseModelGeometry(withoutKv), weightBytes: QWEN38_WEIGHTS, sighting });
    expect(cost?.source).toBe('calibrated');
    expect(cost?.kvMbPerToken).toBeCloseTo((2_300 / 32_768) * 1.5, 4);
  });

  it('ignores a sighting whose VRAM is not above the weights plus overhead: it says nothing about context', () => {
    // Ollama reported 17.40 GB resident for a 17.74 GB file on 2026-09-17.
    const sighting = { contextLength: 32_768, vramBytes: 17_399_734_598 };
    const cost = estimateContextCost({ geometry: parseModelGeometry(QWEN38_INFO), weightBytes: QWEN38_WEIGHTS, sighting });
    expect(cost?.source).toBe('geometry');
  });

  it('can still answer from a sighting alone when the geometry is unreadable, and is null with neither', () => {
    const sighting = { contextLength: 16_384, vramBytes: GEMMA4_WEIGHTS + 768 * MIB + 1_000 * MIB };
    expect(estimateContextCost({ geometry: null, weightBytes: GEMMA4_WEIGHTS, sighting })?.source).toBe('calibrated');
    expect(estimateContextCost({ geometry: null, weightBytes: GEMMA4_WEIGHTS, sighting: null })).toBeNull();
  });
});
