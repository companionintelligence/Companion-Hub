import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// settings.json is read through node:fs and written through the env-helpers pair, so both are
// mocked here. Nothing else in this file touches either.
vi.mock('node:fs', () => {
  const existsSync = vi.fn(() => true);
  const readFileSync = vi.fn(() => '{}');
  const promises = { readFile: vi.fn(async () => '{}'), writeFile: vi.fn(async () => undefined) };
  return { default: { existsSync, readFileSync, promises }, existsSync, readFileSync, promises };
});

// Only the two fs writers are stubbed. resolveAllowErrorMonitoring stays real: it is the consent
// precedence under test below, and a stub would make that test assert its own mock.
vi.mock('@/common/helpers/env-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/helpers/env-helpers')>()),
  ensureSettingsJsonReady: vi.fn(async () => undefined),
  writeSettingsJsonFile: vi.fn(async () => undefined),
}));

import fs from 'node:fs';
import { settingsSchema } from '@/app.dto';
import { writeSettingsJsonFile } from '@/common/helpers/env-helpers';
import { ConfigurationService } from '../configuration.service';

const mockedFs = vi.mocked(fs);
const mockedWriteSettingsJsonFile = vi.mocked(writeSettingsJsonFile);

// No MCP setting reaches settings.json any more. SEC-MCP-8 moved MCP credentials to the hashed key
// store, and ISSUE-MCP-2's destructive gate became each key's `capability` column — so this endpoint
// has nothing MCP-related left to strip, and both retirements are asserted by the schema tests below.
// ConfigurationService's constructor validates the full appliance env, so we build a bare instance
// via Object.create and stub only what setUserSettings touches (logger, config, mergeSettingsToDisk).

function makeService() {
  const svc = Object.create(ConfigurationService.prototype) as unknown as {
    logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
    config: { demoMode: boolean; userSettings: Record<string, unknown> };
    mergeSettingsToDisk: ReturnType<typeof vi.fn>;
    setUserSettings: (s: Record<string, unknown>) => Promise<void>;
  };
  svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  svc.config = { demoMode: false, userSettings: { themeColor: 'red' } };
  svc.mergeSettingsToDisk = vi.fn().mockResolvedValue(undefined);
  return svc;
}

describe('ConfigurationService.setUserSettings', () => {
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService();
  });

  it('passes normal settings through unchanged and does not warn', async () => {
    await svc.setUserSettings({ themeColor: 'green' });
    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ themeColor: 'green' });
    expect(svc.config.userSettings.themeColor).toBe('green');
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });
});

describe('settingsSchema — retired MCP fields', () => {
  // Both retirements have the same shape: the write DTO refuses the field at the HTTP boundary, and
  // mergeSettingsToDisk re-parses the file through this schema before writing back, so a value left
  // by an older build is not carried forward.
  it('strips a stale mcpApiKey (SEC-MCP-8 moved MCP credentials to the hashed key store)', () => {
    const parsed = settingsSchema.partial().safeParse({ mcpApiKey: 'derived-and-dead', themeColor: 'blue' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ themeColor: 'blue' });
  });

  it('strips a stale mcpAllowDestructive, so an appliance that had the gate on cannot keep it', () => {
    // The gate is now per key. Leaving the old value readable would let a stale 'true' look as if it
    // still granted something, on exactly the appliances where it used to grant the most.
    const parsed = settingsSchema.partial().safeParse({ mcpAllowDestructive: true, themeColor: 'blue' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ themeColor: 'blue' });
  });
});

describe('ConfigurationService Hub Pool preferences', () => {
  function makePoolService() {
    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      config: { demoMode: boolean; userSettings: Record<string, unknown> };
      mergeSettingsToDisk: ReturnType<typeof vi.fn>;
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      getHubPoolPreferences: () => {
        poolEnabled: boolean;
        poolOutboundEnabled: boolean;
        poolInboundEnabled: boolean;
        poolLocalAffinity: number;
        poolHealthPollSeconds: number;
        poolPressureWeight: number;
        poolMaxPromptTokens: number | null;
        poolProbeSnapshotTtlMs: number;
        poolPrefixAffinityMaxInFlight: number;
        poolPrefixAffinityMargin: number;
        poolSlotAwareness: number;
        poolPins: unknown[];
      };
      setHubPoolPreferences: (p: Record<string, unknown>) => Promise<unknown>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    svc.config = { demoMode: false, userSettings: {} };
    svc.mergeSettingsToDisk = vi.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('falls back to the defaults before anything has been persisted', () => {
    // Both directional switches are opt-out too: absent means on, so an untouched settings.json
    // resolves to exactly the behaviour of the build before they existed.
    expect(makePoolService().getHubPoolPreferences()).toEqual({
      poolEnabled: true,
      poolOutboundEnabled: true,
      poolInboundEnabled: true,
      poolLocalAffinity: 1,
      poolHealthPollSeconds: 30,
      // The one pool switch that is opt-IN: it removes the bearer branch older peers depend on, so
      // absent has to resolve to false or upgrading one node of a fleet would strand the rest.
      poolRequireSignedPeers: false,
      // Opt-OUT, back with the three switches above: an upgraded Hub starts publishing its
      // aggregate container rollup to the peers its operator already approved, and it is turning it
      // OFF that takes a decision. Defaulting this off would leave every peer on an upgraded fleet
      // reading "not reported" — indistinguishable from an old build — until someone visited every
      // node, which is the fleet view this exists for, permanently empty.
      poolShareContainerStats: true,
      // 0 is what makes the pressure signal a no-op until an operator opts in: at 0 the band is not
      // in the ranking comparator at all, so a fresh Hub ranks byte-identically to the build before it.
      poolPressureWeight: 0,
      // No prompt ceiling: every node serves any prompt size until an operator says otherwise, which
      // is what the build before the ceiling did.
      poolMaxPromptTokens: null,
      // 0 is the pre-snapshot build: placement probes every local engine live on each request,
      // stall included, until an operator PATCHes a TTL onto a canary node. Off by default so the
      // canary can be measured against a node that took the same image and nothing else.
      poolProbeSnapshotTtlMs: 0,
      // 0 is the pre-affinity build: no prefix is hashed or remembered and the ranker alone decides,
      // until an operator PATCHes a limit onto a canary node. Off by default for the same reason as
      // the snapshot TTL above: the canary is measured against a node that took the same image.
      poolPrefixAffinityMaxInFlight: 0,
      poolPrefixAffinityMargin: 0,
      // 0 is the pre-slots build: no slot count is read and the ranker alone decides, until an
      // operator PATCHes it on at a canary node — off by default for the same reason as the two above.
      poolSlotAwareness: 0,
      // No pins until an operator sets one, so the ranker alone decides — which is the whole
      // "peerless single-node Hub is unaffected" guarantee, held at its source.
      poolPins: [],
      // Opt-OUT: every app is handed this Hub's proxy, peers or not, so one place sees all the
      // node's inference. See `HubPoolPreferences.poolRouteAppsAlways`.
      poolRouteAppsAlways: true,
    });
  });

  it('keeps a persisted opt-out from routing apps through the proxy', () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolRouteAppsAlways: false };

    expect(svc.getHubPoolPreferences()).toMatchObject({ poolRouteAppsAlways: false });
  });

  it('persists the app-routing switch and reports it back', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolRouteAppsAlways: false });

    expect(svc.mergeSettingsToDisk).toHaveBeenCalledWith(expect.objectContaining({ hubPoolRouteAppsAlways: false }));
  });

  it('keeps a persisted container-sharing opt-out', () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolShareContainerStats: false };

    expect(svc.getHubPoolPreferences()).toMatchObject({ poolShareContainerStats: false });
  });

  it('persists the container-sharing switch and reports it back', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolShareContainerStats: false });

    expect(svc.mergeSettingsToDisk).toHaveBeenCalledWith(expect.objectContaining({ hubPoolShareContainerStats: false }));
  });

  it('persists the signed-peers requirement and reports it back', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolRequireSignedPeers: true });

    expect(svc.mergeSettingsToDisk).toHaveBeenCalledWith(expect.objectContaining({ hubPoolRequireSignedPeers: true }));
  });

  it('keeps a persisted directional false, and keeps the two axes independent', () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolOutboundEnabled: false };

    expect(svc.getHubPoolPreferences()).toMatchObject({ poolEnabled: true, poolOutboundEnabled: false, poolInboundEnabled: true });
  });

  it('persists one direction without touching the other', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolInboundEnabled: false });

    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolInboundEnabled: false });
  });

  it('keeps a persisted false rather than reading it as unset', () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolEnabled: false, hubPoolLocalAffinity: 0 };

    // Both values are the meaningful-zero case a `||` fallback would silently discard.
    expect(svc.getHubPoolPreferences()).toMatchObject({ poolEnabled: false, poolLocalAffinity: 0 });
  });

  it('writes only the fields the caller sent, leaving the rest of settings.json alone', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolLocalAffinity: 3 });

    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolLocalAffinity: 3 });
  });

  it('does not rewrite settings.json for a PATCH that changes nothing', async () => {
    const svc = makePoolService();

    // Every write is a read-modify-write of the whole file with no locking, so an empty one can
    // still clobber a concurrent inference-preferences save.
    await svc.setHubPoolPreferences({});

    expect(svc.mergeSettingsToDisk).not.toHaveBeenCalled();
  });

  it('round-trips the pressure weight without touching the other pool fields', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolPressureWeight: 2 });

    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolPressureWeight: 2 });
  });

  it('persists a prompt ceiling and applies it to the next read without a restart', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolMaxPromptTokens: 16_000 });

    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolMaxPromptTokens: 16_000 });
    expect(svc.getHubPoolPreferences().poolMaxPromptTokens).toBe(16_000);
  });

  it('persists the probe snapshot TTL and reads it back, including 0 for live probes', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolProbeSnapshotTtlMs: 0 });

    // `?? DEFAULT` must not swallow a 0: it is the operator's way back to the pre-snapshot build.
    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolProbeSnapshotTtlMs: 0 });
    expect(svc.getHubPoolPreferences().poolProbeSnapshotTtlMs).toBe(0);
  });

  it('persists the prefix-affinity limit and reads it back, including 0 for off', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolPrefixAffinityMaxInFlight: 2 });
    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolPrefixAffinityMaxInFlight: 2 });
    expect(svc.getHubPoolPreferences().poolPrefixAffinityMaxInFlight).toBe(2);

    await svc.setHubPoolPreferences({ poolPrefixAffinityMaxInFlight: 0 });

    // `?? DEFAULT` must not swallow a 0: it is the operator's way back to the pre-affinity build.
    expect(svc.mergeSettingsToDisk.mock.calls[1][0]).toEqual({ hubPoolPrefixAffinityMaxInFlight: 0 });
    expect(svc.getHubPoolPreferences().poolPrefixAffinityMaxInFlight).toBe(0);
  });

  it('persists the prefix-affinity margin and reads it back, including 0 for off', async () => {
    const svc = makePoolService();

    await svc.setHubPoolPreferences({ poolPrefixAffinityMargin: 3 });
    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolPrefixAffinityMargin: 3 });
    expect(svc.getHubPoolPreferences().poolPrefixAffinityMargin).toBe(3);

    await svc.setHubPoolPreferences({ poolPrefixAffinityMargin: 0 });

    expect(svc.mergeSettingsToDisk.mock.calls[1][0]).toEqual({ hubPoolPrefixAffinityMargin: 0 });
    expect(svc.getHubPoolPreferences().poolPrefixAffinityMargin).toBe(0);
  });

  it('clears a prompt ceiling by removing the key, and reads the cleared value as no ceiling', async () => {
    const svc = makePoolService();
    await svc.setHubPoolPreferences({ poolMaxPromptTokens: 16_000 });

    await svc.setHubPoolPreferences({ poolMaxPromptTokens: null });

    // The PATCH has to reach the disk at all — a clear skipped as a no-op would leave the old
    // ceiling excluding the node after the next restart.
    expect(svc.mergeSettingsToDisk).toHaveBeenCalledTimes(2);
    const cleared = svc.mergeSettingsToDisk.mock.calls[1][0] as Record<string, unknown>;
    // `mergeSettingsToDisk` spreads this over the file and serialises it, so the key must vanish
    // from settings.json rather than be written as a null the boot parse would have to degrade.
    expect(JSON.parse(JSON.stringify({ hubPoolMaxPromptTokens: 16_000, ...cleared }))).toEqual({});
    expect(svc.getHubPoolPreferences().poolMaxPromptTokens).toBeNull();
  });

  it('leaves a stored prompt ceiling alone when a PATCH does not mention it', async () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolMaxPromptTokens: 16_000 };

    await svc.setHubPoolPreferences({ poolLocalAffinity: 2 });

    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ hubPoolLocalAffinity: 2 });
    expect(svc.getHubPoolPreferences().poolMaxPromptTokens).toBe(16_000);
  });

  it('keeps a persisted pressure weight of 0 rather than reading it as unset', () => {
    const svc = makePoolService();
    svc.config.userSettings = { hubPoolPressureWeight: 0 };

    // The meaningful-zero case again: 0 is the shipped default AND a value an operator can choose
    // deliberately after trying a higher one, so a `||` fallback would be indistinguishable.
    expect(svc.getHubPoolPreferences()).toMatchObject({ poolPressureWeight: 0 });
  });
});

describe('settingsSchema — Hub Pool fields', () => {
  it('accepts the numeric knobs as strings, as a form would submit them', () => {
    const parsed = settingsSchema.partial().safeParse({ hubPoolLocalAffinity: '4', hubPoolHealthPollSeconds: '60', hubPoolPressureWeight: '2' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ hubPoolLocalAffinity: 4, hubPoolHealthPollSeconds: 60, hubPoolPressureWeight: 2 });
  });

  it('degrades out-of-range tuning to the default instead of failing the parse boot depends on', () => {
    // The write path (UserSettingsBody / UpdateHubPoolPreferencesBody) is what refuses these with a
    // 400; this schema also parses settings.json before Nest exists, where a throw is a crash loop.
    // The bound checks themselves live in src/__tests__/app.dto.test.ts.
    for (const persisted of [
      { hubPoolLocalAffinity: -1 },
      { hubPoolHealthPollSeconds: 1 },
      { hubPoolHealthPollSeconds: 9999 },
      { hubPoolPressureWeight: -1 },
      { hubPoolPressureWeight: 4 },
    ]) {
      const parsed = settingsSchema.partial().safeParse(persisted);

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({});
    }
  });
});

describe('settingsSchema — inference context cap', () => {
  it('accepts the cap as a string, as a form would submit it, and degrades an out-of-range one to "no cap"', () => {
    expect(settingsSchema.partial().safeParse({ inferenceMaxNumCtx: '16384' }).data).toEqual({ inferenceMaxNumCtx: 16384 });
    // A dropped digit and a value past the longest window on the fleet both read as absent on the
    // boot path rather than failing the parse; the write path (UserSettingsBody) refuses them.
    for (const persisted of [{ inferenceMaxNumCtx: 1638 }, { inferenceMaxNumCtx: 2 ** 21 }, { inferenceMaxNumCtx: 'lots' }]) {
      const parsed = settingsSchema.partial().safeParse(persisted);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({});
    }
  });
});

describe('ConfigurationService inference preferences — context cap', () => {
  function makeService(userSettings: Record<string, unknown>) {
    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      config: { demoMode: boolean; userSettings: Record<string, unknown> };
      mergeSettingsToDisk: ReturnType<typeof vi.fn>;
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      getInferencePreferences: () => { maxNumCtx: number | null };
      setInferencePreferences: (...args: unknown[]) => Promise<{ maxNumCtx: number | null }>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    svc.config = { demoMode: false, userSettings };
    svc.mergeSettingsToDisk = vi.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('is null until an operator sets one — the handout then sizes exactly as the build before the cap', () => {
    expect(makeService({}).getInferencePreferences().maxNumCtx).toBeNull();
  });

  it('reads a persisted cap through the clamp, so a value outside this build bounds is no cap rather than a tiny one', () => {
    expect(makeService({ inferenceMaxNumCtx: 16_384 }).getInferencePreferences().maxNumCtx).toBe(16_384);
    expect(makeService({ inferenceMaxNumCtx: 12 }).getInferencePreferences().maxNumCtx).toBeNull();
  });

  it('sets, leaves alone, and clears the cap through setInferencePreferences', async () => {
    const svc = makeService({ inferenceMaxNumCtx: 16_384 });

    // Omitted: unchanged.
    expect((await svc.setInferencePreferences('ollama')).maxNumCtx).toBe(16_384);
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama' });

    // Set.
    expect(
      (await svc.setInferencePreferences('ollama', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 32_768))
        .maxNumCtx,
    ).toBe(32_768);
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama', inferenceMaxNumCtx: 32_768 });

    // Cleared: the key is removed rather than stored as null, like the pool prompt ceiling.
    expect(
      (await svc.setInferencePreferences('ollama', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null))
        .maxNumCtx,
    ).toBeNull();
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama', inferenceMaxNumCtx: undefined });
  });
});

describe('settingsSchema — inference Ollama slots', () => {
  it('accepts the count as a string, as a form would submit it, and degrades an out-of-range one to "not stated"', () => {
    expect(settingsSchema.partial().safeParse({ inferenceOllamaSlots: '4' }).data).toEqual({ inferenceOllamaSlots: 4 });
    // Zero, a value past the bound and a word all read as absent on the boot path rather than
    // failing the parse; the write path (UserSettingsBody) refuses them.
    for (const persisted of [{ inferenceOllamaSlots: 0 }, { inferenceOllamaSlots: 65 }, { inferenceOllamaSlots: 'four' }]) {
      const parsed = settingsSchema.partial().safeParse(persisted);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({});
    }
  });
});

describe('ConfigurationService inference preferences — Ollama slots', () => {
  function makeService(userSettings: Record<string, unknown>) {
    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      config: { demoMode: boolean; userSettings: Record<string, unknown> };
      mergeSettingsToDisk: ReturnType<typeof vi.fn>;
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      getInferencePreferences: () => { ollamaSlots: number | null };
      setInferencePreferences: (...args: unknown[]) => Promise<{ ollamaSlots: number | null }>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    svc.config = { demoMode: false, userSettings };
    svc.mergeSettingsToDisk = vi.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('is null until an operator states one — the pool then ranks this node by queue depth alone, as before slots', () => {
    expect(makeService({}).getInferencePreferences().ollamaSlots).toBeNull();
  });

  it('reads a persisted count through the clamp, so a value outside this build bounds is not stated rather than believed', () => {
    expect(makeService({ inferenceOllamaSlots: 4 }).getInferencePreferences().ollamaSlots).toBe(4);
    expect(makeService({ inferenceOllamaSlots: 0 }).getInferencePreferences().ollamaSlots).toBeNull();
  });

  it('sets, leaves alone, and clears the count through setInferencePreferences', async () => {
    const svc = makeService({ inferenceOllamaSlots: 4 });
    const untouched = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];

    // Omitted: unchanged.
    expect((await svc.setInferencePreferences('ollama')).ollamaSlots).toBe(4);
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama' });

    // Set.
    expect((await svc.setInferencePreferences('ollama', ...untouched, 2)).ollamaSlots).toBe(2);
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama', inferenceOllamaSlots: 2 });

    // Cleared: the key is removed rather than stored as null, like the cap.
    expect((await svc.setInferencePreferences('ollama', ...untouched, null)).ollamaSlots).toBeNull();
    expect(svc.mergeSettingsToDisk).toHaveBeenLastCalledWith({ inferenceBackend: 'ollama', inferenceOllamaSlots: undefined });
  });
});

describe('ConfigurationService.readPersistedSettings', () => {
  function makeReader() {
    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      readPersistedSettings: () => Record<string, unknown>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    return svc;
  }

  function onDisk(contents: string) {
    mockedFs.existsSync.mockReturnValue(true);
    (mockedFs.readFileSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(contents);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
  });

  it('keeps the Portal credential when an unrelated field is unusable', () => {
    // The defect this replaces: one bad field threw out of `settingsSchema.partial().parse`, the
    // catch was empty, and the Hub booted with ciHubApiKey null — indistinguishable from an
    // unregistered appliance, and silent.
    const svc = makeReader();
    onDisk(JSON.stringify({ dnsIp: 'not-an-ip', ciHubApiKey: 'portal-key', inferenceModel: 'qwen3:8b' }));

    const values = svc.readPersistedSettings();

    expect(values.ciHubApiKey).toBe('portal-key');
    expect(values.inferenceModel).toBe('qwen3:8b');
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dnsIp'));
  });

  it('keeps the Portal credential when a Hub Pool knob is out of range', () => {
    const svc = makeReader();
    onDisk(JSON.stringify({ hubPoolLocalAffinity: 999, ciHubApiKey: 'portal-key' }));

    const values = svc.readPersistedSettings();

    expect(values.ciHubApiKey).toBe('portal-key');
    // `.catch(undefined)` absorbs it, so it is a silent degrade rather than a reported drop.
    expect(values.hubPoolLocalAffinity).toBeUndefined();
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });

  it('logs rather than swallows a settings.json that is not valid JSON', () => {
    const svc = makeReader();
    onDisk('{ this is not json');

    const values = svc.readPersistedSettings();

    expect(values.ciHubApiKey).toBeNull();
    expect(svc.logger.error).toHaveBeenCalled();
  });

  it('reports a settings.json whose top level is not an object', () => {
    const svc = makeReader();
    onDisk('[]');

    expect(svc.readPersistedSettings().ciHubApiKey).toBeNull();
    expect(svc.logger.error).toHaveBeenCalledWith(expect.stringContaining('does not contain a JSON object'));
  });

  it('says nothing when there is no settings.json yet', () => {
    const svc = makeReader();
    mockedFs.existsSync.mockReturnValue(false);

    expect(svc.readPersistedSettings().ciHubApiKey).toBeNull();
    expect(svc.logger.error).not.toHaveBeenCalled();
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });
});

describe('ConfigurationService.mergeSettingsToDisk', () => {
  function makeWriter() {
    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
      mergeSettingsToDisk: (s: Record<string, unknown>) => Promise<void>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    return svc;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteSettingsJsonFile.mockResolvedValue(undefined);
  });

  it('drops an unusable field already on disk instead of refusing every future write', async () => {
    // Refusing here 500'd setUserSettings for as long as the bad value stayed on disk — including
    // the write that would have corrected it, so the only exit was editing the file by hand.
    const svc = makeWriter();
    (mockedFs.promises.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(JSON.stringify({ dnsIp: 'not-an-ip', themeColor: 'red' }));

    await expect(svc.mergeSettingsToDisk({ themeColor: 'blue' })).resolves.toBeUndefined();

    const written = JSON.parse(mockedWriteSettingsJsonFile.mock.calls[0][1] as string);
    expect(written).toEqual({ themeColor: 'blue' });
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dnsIp'));
  });

  it('does not carry an out-of-range pool value forward once it has been degraded', async () => {
    const svc = makeWriter();
    (mockedFs.promises.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ hubPoolLocalAffinity: 999, ciHubApiKey: 'portal-key' }),
    );

    await svc.mergeSettingsToDisk({ themeColor: 'blue' });

    const written = JSON.parse(mockedWriteSettingsJsonFile.mock.calls[0][1] as string);
    expect(written).toEqual({ ciHubApiKey: 'portal-key', themeColor: 'blue' });
  });

  it('still round-trips a healthy file untouched', async () => {
    const svc = makeWriter();
    (mockedFs.promises.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ ciHubApiKey: 'portal-key', themeColor: 'red' }),
    );

    await svc.mergeSettingsToDisk({ themeColor: 'blue' });

    expect(JSON.parse(mockedWriteSettingsJsonFile.mock.calls[0][1] as string)).toEqual({ ciHubApiKey: 'portal-key', themeColor: 'blue' });
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });
});

describe('ConfigurationService — error-monitoring consent precedence', () => {
  // The other half of the audited contradiction. generateSystemEnvFile resolved this key env-first
  // and configure() resolved it settings-first, so the resolved env and the running config could
  // disagree about a privacy control. Both now call resolveAllowErrorMonitoring; this pins the
  // configure() half against the same truth table env-helpers.test.ts pins for the boot half.
  const APPLIANCE_ENV: Record<string, string> = {
    POSTGRES_HOST: 'db',
    POSTGRES_DBNAME: 'hub',
    POSTGRES_USERNAME: 'hub',
    POSTGRES_PASSWORD: 'hub',
    RABBITMQ_HOST: 'queue',
    RABBITMQ_USERNAME: 'hub',
    RABBITMQ_PASSWORD: 'hub',
    INTERNAL_IP: '127.0.0.1',
    CI_HUB_VERSION: '0.0.0',
    JWT_SECRET: 'jwt',
    CI_CLOUD_URL: 'https://cloud.example.com',
    DOMAIN: 'example.com',
    CI_HUB_APP_DATA_PATH: '/host/app-data',
    CI_HUB_FORWARD_AUTH_URL: 'http://auth',
    DEMO_MODE: 'false',
    GUEST_DASHBOARD: 'false',
    ALLOW_AUTO_THEMES: 'true',
    PERSIST_TRAEFIK_CONFIG: 'false',
    TZ: 'UTC',
    ROOT_FOLDER_HOST: '/host',
    ADVANCED_SETTINGS: 'false',
    THEME_BASE: 'gray',
    THEME_COLOR: 'blue',
    EXPERIMENTAL_INSECURE_COOKIE: 'false',
  };

  // configure() spreads process.env over the .env map, so the environment half of the truth table
  // has to be set there rather than in APPLIANCE_ENV.
  function configureWith(setting: boolean | undefined, envValue: string) {
    process.env.ALLOW_ERROR_MONITORING = envValue;

    const svc = Object.create(ConfigurationService.prototype) as unknown as {
      getEnvMap: () => Map<string, string>;
      readPersistedSettings: () => Record<string, unknown>;
      configure: () => { userSettings: { allowErrorMonitoring: boolean } };
    };
    svc.getEnvMap = () => new Map(Object.entries(APPLIANCE_ENV));
    svc.readPersistedSettings = () => ({ allowErrorMonitoring: setting });

    return svc.configure().userSettings.allowErrorMonitoring;
  }

  let savedEnvValue: string | undefined;

  beforeEach(() => {
    savedEnvValue = process.env.ALLOW_ERROR_MONITORING;
  });

  afterEach(() => {
    if (savedEnvValue === undefined) delete process.env.ALLOW_ERROR_MONITORING;
    else process.env.ALLOW_ERROR_MONITORING = savedEnvValue;
  });

  it("keeps the user's opt-out when the environment allows reporting", () => {
    expect(configureWith(false, 'true')).toBe(false);
  });

  it("keeps the user's opt-in when the environment forbids reporting", () => {
    expect(configureWith(true, 'false')).toBe(true);
  });

  it('takes the environment value when the user has never touched the switch', () => {
    expect(configureWith(undefined, 'false')).toBe(false);
  });
});
