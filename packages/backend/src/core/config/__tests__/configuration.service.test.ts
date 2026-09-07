import { beforeEach, describe, expect, it, vi } from 'vitest';

// settings.json is read through node:fs and written through the env-helpers pair, so both are
// mocked here. Nothing else in this file touches either.
vi.mock('node:fs', () => {
  const existsSync = vi.fn(() => true);
  const readFileSync = vi.fn(() => '{}');
  const promises = { readFile: vi.fn(async () => '{}'), writeFile: vi.fn(async () => undefined) };
  return { default: { existsSync, readFileSync, promises }, existsSync, readFileSync, promises };
});

vi.mock('@/common/helpers/env-helpers', () => ({
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
    });
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
});

describe('settingsSchema — Hub Pool fields', () => {
  it('accepts the numeric knobs as strings, as a form would submit them', () => {
    const parsed = settingsSchema.partial().safeParse({ hubPoolLocalAffinity: '4', hubPoolHealthPollSeconds: '60' });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ hubPoolLocalAffinity: 4, hubPoolHealthPollSeconds: 60 });
  });

  it('degrades out-of-range tuning to the default instead of failing the parse boot depends on', () => {
    // The write path (UserSettingsBody / UpdateHubPoolPreferencesBody) is what refuses these with a
    // 400; this schema also parses settings.json before Nest exists, where a throw is a crash loop.
    // The bound checks themselves live in src/__tests__/app.dto.test.ts.
    for (const persisted of [{ hubPoolLocalAffinity: -1 }, { hubPoolHealthPollSeconds: 1 }, { hubPoolHealthPollSeconds: 9999 }]) {
      const parsed = settingsSchema.partial().safeParse(persisted);

      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data).toEqual({});
    }
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
