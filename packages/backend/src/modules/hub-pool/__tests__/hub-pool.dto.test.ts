import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '@/common/zod-dto';
import {
  MAX_POOL_MAX_PROMPT_TOKENS,
  MAX_POOL_PREFIX_AFFINITY_MARGIN,
  MAX_POOL_PREFIX_AFFINITY_MAX_IN_FLIGHT,
  MAX_POOL_SLOT_AWARENESS,
  MAX_POOL_PROBE_SNAPSHOT_TTL_MS,
  MIN_POOL_MAX_PROMPT_TOKENS,
} from '@/common/helpers/hub-pool';
import { PairPeerBody, UpdateHubPoolPreferencesBody } from '../hub-pool.dto';

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

describe('UpdateHubPoolPreferencesBody — poolSlotAwareness', () => {
  it('accepts 0, which keeps slot counts out of ranking', () => {
    const result = UpdateHubPoolPreferencesBody.schema.safeParse({ poolSlotAwareness: 0 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ poolSlotAwareness: 0 });
  });

  it('accepts 1, which is on and also the upper bound', () => {
    expect(MAX_POOL_SLOT_AWARENESS).toBe(1);
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolSlotAwareness: 1 }).success).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['above the bound', MAX_POOL_SLOT_AWARENESS + 1],
    ['fractional', 0.5],
    ['a string', '1'],
    ['a boolean', true],
    ['null', null],
  ])('rejects %s with a 400', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolSlotAwareness: value }).success).toBe(false);
  });
});

describe('UpdateHubPoolPreferencesBody — poolPrefixAffinityMargin', () => {
  it('accepts 0, which keeps affinity margin checking disabled', () => {
    const result = UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMargin: 0 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ poolPrefixAffinityMargin: 0 });
  });

  it('accepts 1, and the upper bound', () => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMargin: 1 }).success).toBe(true);
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMargin: MAX_POOL_PREFIX_AFFINITY_MARGIN }).success).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['above the bound', MAX_POOL_PREFIX_AFFINITY_MARGIN + 1],
    ['fractional', 0.5],
    ['a string', '1'],
    ['a boolean', true],
    ['null', null],
  ])('rejects %s with a 400', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolPrefixAffinityMargin: value }).success).toBe(false);
  });
});

describe('UpdateHubPoolPreferencesBody — poolMdnsEnabled', () => {
  it('accepts both states, so LAN discovery can be switched off again', () => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMdnsEnabled: true })).toMatchObject({
      success: true,
      data: { poolMdnsEnabled: true },
    });
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMdnsEnabled: false })).toMatchObject({
      success: true,
      data: { poolMdnsEnabled: false },
    });
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s with a 400', (_label, value) => {
    expect(UpdateHubPoolPreferencesBody.schema.safeParse({ poolMdnsEnabled: value }).success).toBe(false);
  });
});

describe('PairPeerBody — mDNS names', () => {
  /** The body as `POST /inference/pool/peers/pair` sees it: through the app's global pipe, with this DTO as the metatype. */
  const validate = (body: unknown) => new ZodValidationPipe().transform(body, { metatype: PairPeerBody });

  /** The first issue's message from the pipe's 400. */
  function refusal(body: unknown): string {
    try {
      validate(body);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const issues = (error as BadRequestException).getResponse() as { message: Array<{ message: string }> };
      return issues.message[0]?.message ?? '';
    }
    throw new Error(`expected ${JSON.stringify(body)} to be refused`);
  }

  // A `.local` name is only ever an mDNS row's, and every field of one came from an unauthenticated
  // datagram. Pairing by it would hand this Hub's name, a fresh token and the PIN to whatever answers.
  it.each(['core-9.local', 'CORE-9.LOCAL.', ' core-9.local '])('refuses to pair by the name %j, saying a tailnet name is needed', (nodeFqdn) => {
    expect(refusal({ nodeFqdn })).toMatch(/tailnet name/);
    expect(refusal({ nodeFqdn, pin: '123456' })).toMatch(/tailnet name/);
  });

  it('still pairs by a tailnet name, including one with "local" in it', () => {
    expect(validate({ nodeFqdn: 'core-9.tailxyz.ts.net' })).toEqual({ nodeFqdn: 'core-9.tailxyz.ts.net' });
    expect(validate({ nodeFqdn: 'local.tailxyz.ts.net', pin: '123456' })).toMatchObject({ nodeFqdn: 'local.tailxyz.ts.net' });
  });

  it('leaves pairing by address alone: an IP, a short LAN name and a host:port all still parse', () => {
    // The address form is PIN-authenticated and never stored, and the name the row is keyed on comes
    // back from the far Hub — this change is about trusting a *name*, not about reaching a handshake.
    for (const address of ['192.168.1.42', 'mini-pc', 'mini-pc:5002', '192.168.1.42:5002']) {
      expect(validate({ address, pin: '123456' })).toEqual({ address, pin: '123456' });
    }
  });

  it('keeps refusing the shapes it refused before', () => {
    expect(() => validate({ nodeFqdn: 'hub-b' })).toThrow(BadRequestException);
    expect(() => validate({ nodeFqdn: '192.168.1.42' })).toThrow(BadRequestException);
    expect(() => validate({ nodeFqdn: 'https://hub-b.tailxyz.ts.net' })).toThrow(BadRequestException);
  });
});
