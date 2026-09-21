import { describe, expect, it } from 'vitest';
import {
  MAX_POOL_MAX_PROMPT_TOKENS,
  MAX_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  MAX_POOL_PROBE_SNAPSHOT_TTL_MS,
  MIN_POOL_MAX_PROMPT_TOKENS,
} from '@/common/helpers/hub-pool';
import { UpdateHubPoolPreferencesBody } from '../hub-pool.dto';

describe('UpdateHubPoolPreferencesBody — poolMaxPromptTokens', () => {
  it('accepts the ceiling the fzzy operator asked for', () => {
    const result = UpdateHubPoolPreferencesBody.schema.safeParse({ poolMaxPromptTokens: 16_000 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ poolMaxPromptTokens: 16_000 });
  });

  it('accepts both bounds', () => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMaxPromptTokens: MIN_POOL_MAX_PROMPT_TOKENS }).success).toBe(true);
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMaxPromptTokens: MAX_POOL_MAX_PROMPT_TOKENS }).success).toBe(true);
  });

  it('accepts null as "clear the ceiling", distinct from omitting the field', () => {
    const cleared = UpdateHubPoolPreferencesBody.schema.safeParse({ poolMaxPromptTokens: null });
    const untouched = UpdateHubPoolPreferencesBody.schema.safeParse({ poolEnabled: true });

    // `null` must survive the parse as a value: stripped to `undefined`, a clear would silently become
    // a no-op PATCH and the ceiling the operator removed would keep excluding the node.
    expect(cleared.success && cleared.data).toEqual({ poolMaxPromptTokens: null });
    expect(untouched.success && 'poolMaxPromptTokens' in untouched.data).toBe(false);
  });

  it.each([
    ['zero', 0],
    ['negative', -16_000],
    ['a dropped 000 — below the floor', 16],
    ['above the bound', MAX_POOL_MAX_PROMPT_TOKENS + 1],
    ['fractional', 16_000.5],
    ['a string', '16000'],
    ['a boolean', false],
  ])('rejects %s with a 400 rather than storing a ceiling that excludes the node from everything', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMaxPromptTokens: value }).success).toBe(false);
  });
});

describe('UpdateHubPoolPreferencesBody — poolProbeSnapshotTtlMs', () => {
  it('accepts 0, which is the way back to live probes on every request', () => {
    const result = UpdateHubPoolPreferencesBody.schema.safeParse({ poolProbeSnapshotTtlMs: 0 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ poolProbeSnapshotTtlMs: 0 });
  });

  it('accepts the upper bound', () => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolProbeSnapshotTtlMs: MAX_POOL_PROBE_SNAPSHOT_TTL_MS }).success).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['above the bound', MAX_POOL_PROBE_SNAPSHOT_TTL_MS + 1],
    ['fractional', 10_000.5],
    ['a string', '10000'],
    ['null', null],
  ])('rejects %s with a 400', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolProbeSnapshotTtlMs: value }).success).toBe(false);
  });
});

describe('UpdateHubPoolPreferencesBody — poolPrefixAffinityMaxInFlight', () => {
  it('accepts 0, which switches prefix affinity off', () => {
    const result = UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMaxInFlight: 0 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ poolPrefixAffinityMaxInFlight: 0 });
  });

  it('accepts the value it is validated at, and the upper bound', () => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMaxInFlight: 2 }).success).toBe(true);
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMaxInFlight: MAX_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT }).success).toBe(
      true,
    );
  });

  it.each([
    ['negative', -1],
    ['above the bound', MAX_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT + 1],
    ['fractional', 1.5],
    ['a string', '2'],
    ['null', null],
  ])('rejects %s with a 400', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMaxInFlight: value }).success).toBe(false);
  });
});
