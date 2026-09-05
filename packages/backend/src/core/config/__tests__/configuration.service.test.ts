import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsSchema } from '@/app.dto';
import { ConfigurationService } from '../configuration.service';

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
      getHubPoolPreferences: () => { poolEnabled: boolean; poolLocalAffinity: number; poolHealthPollSeconds: number };
      setHubPoolPreferences: (p: Record<string, unknown>) => Promise<unknown>;
    };
    svc.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    svc.config = { demoMode: false, userSettings: {} };
    svc.mergeSettingsToDisk = vi.fn().mockResolvedValue(undefined);
    return svc;
  }

  it('falls back to the defaults before anything has been persisted', () => {
    expect(makePoolService().getHubPoolPreferences()).toEqual({ poolEnabled: true, poolLocalAffinity: 1, poolHealthPollSeconds: 30 });
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

  it('rejects out-of-range tuning rather than persisting a value that would break routing', () => {
    expect(settingsSchema.partial().safeParse({ hubPoolLocalAffinity: -1 }).success).toBe(false);
    expect(settingsSchema.partial().safeParse({ hubPoolHealthPollSeconds: 1 }).success).toBe(false);
    expect(settingsSchema.partial().safeParse({ hubPoolHealthPollSeconds: 9999 }).success).toBe(false);
  });
});
