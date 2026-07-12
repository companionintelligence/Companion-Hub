import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '../configuration.service';

// SECURITY (ISSUE-MCP-2 / ENH-MCP-4): the general updateUserSettings endpoint must never accept or
// echo the MCP admin secrets (mcpApiKey / mcpAllowDestructive). These live in settingsSchema only so
// on-disk values survive general settings writes; the dedicated persistMcpSettings path owns them.
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

describe('ConfigurationService.setUserSettings — MCP secret isolation', () => {
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService();
  });

  it('strips mcpApiKey/mcpAllowDestructive from both the disk write and in-memory settings, and warns', async () => {
    await svc.setUserSettings({ mcpApiKey: 'attacker-known', mcpAllowDestructive: true, themeColor: 'blue' });

    // Never forwarded to disk (mergeSettingsToDisk spreads existing on-disk values, so the real key is preserved).
    const written = svc.mergeSettingsToDisk.mock.calls[0][0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('mcpApiKey');
    expect(written).not.toHaveProperty('mcpAllowDestructive');
    expect(written.themeColor).toBe('blue');

    // Never merged into the in-memory userSettings that GET /app-context returns to the browser.
    expect(svc.config.userSettings).not.toHaveProperty('mcpApiKey');
    expect(svc.config.userSettings).not.toHaveProperty('mcpAllowDestructive');
    expect(svc.config.userSettings.themeColor).toBe('blue');

    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('mcpApiKey/mcpAllowDestructive'));
  });

  it('passes normal settings through unchanged and does not warn', async () => {
    await svc.setUserSettings({ themeColor: 'green' });
    expect(svc.mergeSettingsToDisk.mock.calls[0][0]).toEqual({ themeColor: 'green' });
    expect(svc.config.userSettings.themeColor).toBe('green');
    expect(svc.logger.warn).not.toHaveBeenCalled();
  });
});
