import { describe, expect, it } from 'vitest';
import { UserSettingsBody, parsePersistedSettings, settingsSchema } from '../app.dto';

describe('UserSettingsBody — timeZone validation (write path)', () => {
  it.each([
    ['Not/AZone', 'unknown zone'],
    ['Etc/Unknown', "ICU's could-not-determine sentinel, truthy but unusable"],
    ['+05:00', 'UTC-offset id — POSIX TZ in app containers silently ignores it'],
    ['UTC\nforged line', 'interior newline'],
  ])('MUST reject %s (%s) with a 400 instead of persisting it', (zone) => {
    const result = UserSettingsBody.schema.safeParse({ timeZone: zone });

    expect(result.success).toBe(false);
  });

  it('MUST accept a valid zone', () => {
    const result = UserSettingsBody.schema.safeParse({ timeZone: 'Europe/Berlin' });

    expect(result.success).toBe(true);
    expect(result.success && result.data.timeZone).toBe('Europe/Berlin');
  });

  it('MUST persist the canonical form of a case-variant zone id', () => {
    const result = UserSettingsBody.schema.safeParse({ timeZone: 'america/new_york' });

    expect(result.success).toBe(true);
    expect(result.success && result.data.timeZone).toBe('America/New_York');
  });

  it('MUST accept a body that omits timeZone', () => {
    expect(UserSettingsBody.schema.safeParse({ logLevel: 'info' }).success).toBe(true);
  });

  // The boot path (generateSystemEnvFile) parses settings.json with this base schema. An install
  // whose settings.json predates the write-path validation may hold a garbage zone; boot must
  // degrade gracefully (it falls back to the host zone and warns), NOT fail the settings parse.
  it('settingsSchema (boot read path) MUST still tolerate an invalid persisted timeZone', () => {
    const result = settingsSchema.partial().safeParse({ timeZone: 'Not/AZone' });

    expect(result.success).toBe(true);
  });
});

describe('settingsSchema — Hub Pool tuning (boot read path)', () => {
  // These two knobs are the reason the boot path can be bricked by a value that is merely out of
  // range: MIN/MAX_POOL_* are constants a build can narrow, so a Hub that saved a value one build
  // accepts and then rolls back to a build that does not would fail the settings parse in
  // generateSystemEnvFile — before Nest exists, with no UI left to correct it from.
  it.each([
    ['hubPoolLocalAffinity', -1, 'below MIN_POOL_LOCAL_AFFINITY'],
    ['hubPoolLocalAffinity', 999, 'above MAX_POOL_LOCAL_AFFINITY'],
    ['hubPoolHealthPollSeconds', 1, 'below MIN_POOL_HEALTH_POLL_SECONDS'],
    ['hubPoolHealthPollSeconds', 9999, 'above MAX_POOL_HEALTH_POLL_SECONDS'],
    ['hubPoolPressureWeight', -1, 'below MIN_POOL_PRESSURE_WEIGHT'],
    ['hubPoolPressureWeight', 4, 'above MAX_POOL_PRESSURE_WEIGHT'],
    ['hubPoolMaxPromptTokens', 16, 'below MIN_POOL_MAX_PROMPT_TOKENS'],
    ['hubPoolMaxPromptTokens', 2_000_000, 'above MAX_POOL_MAX_PROMPT_TOKENS'],
    ['hubPoolMaxPromptTokens', null, 'a stored null, which no build writes'],
    ['hubPoolLocalAffinity', 'not a number', 'not numeric at all'],
  ])('MUST degrade a persisted %s of %s (%s) to the default rather than failing the parse', (key, value) => {
    const result = settingsSchema.partial().safeParse({ [key]: value });

    expect(result.success).toBe(true);
    // Undefined is what `getHubPoolPreferences` resolves against DEFAULT_POOL_*, so dropping the
    // field is exactly "fall back to the default".
    expect(result.success && result.data[key as 'hubPoolLocalAffinity']).toBeUndefined();
  });

  it('MUST keep every other field when one pool knob is out of range', () => {
    // The whole point: a bad tuning value costs that value, not the Portal credential next to it.
    const result = settingsSchema.partial().safeParse({ hubPoolLocalAffinity: -1, ciHubApiKey: 'portal-key', hubPoolEnabled: false });

    expect(result.success).toBe(true);
    expect(result.success && result.data.ciHubApiKey).toBe('portal-key');
    expect(result.success && result.data.hubPoolEnabled).toBe(false);
  });

  it('MUST still accept in-range values, including the string form a form would submit', () => {
    const result = settingsSchema.partial().safeParse({ hubPoolLocalAffinity: '4', hubPoolHealthPollSeconds: 60 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ hubPoolLocalAffinity: 4, hubPoolHealthPollSeconds: 60 });
  });
});

describe('UserSettingsBody — Hub Pool tuning (write path)', () => {
  // Tolerance belongs on the read path only. Choosing an out-of-range value must still 400, or the
  // read-path degrade would quietly become the way values are accepted.
  it.each([
    ['hubPoolLocalAffinity', -1],
    ['hubPoolLocalAffinity', 999],
    ['hubPoolHealthPollSeconds', 1],
    ['hubPoolHealthPollSeconds', 9999],
    ['hubPoolPressureWeight', -1],
    ['hubPoolPressureWeight', 4],
    ['hubPoolMaxPromptTokens', 16],
    ['hubPoolMaxPromptTokens', 2_000_000],
  ])('MUST reject %s = %s at the HTTP boundary', (key, value) => {
    expect(UserSettingsBody.schema.safeParse({ [key]: value }).success).toBe(false);
  });

  it('MUST accept in-range tuning', () => {
    const result = UserSettingsBody.schema.safeParse({ hubPoolLocalAffinity: 5, hubPoolHealthPollSeconds: 30 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ hubPoolLocalAffinity: 5, hubPoolHealthPollSeconds: 30 });
  });
});

describe('parsePersistedSettings', () => {
  it('returns the whole file and no complaints when everything parses', () => {
    const { settings, invalidKeys, unreadable } = parsePersistedSettings({ themeColor: 'blue', hubPoolLocalAffinity: 3 });

    expect(unreadable).toBe(false);
    expect(invalidKeys).toEqual([]);
    expect(settings).toMatchObject({ themeColor: 'blue', hubPoolLocalAffinity: 3 });
  });

  it('drops only the unusable field and names it, keeping the credential beside it', () => {
    // dnsIp has no `.catch`, so this is the general case: any field a future build tightens.
    const { settings, invalidKeys, unreadable } = parsePersistedSettings({
      dnsIp: 'not-an-ip',
      ciHubApiKey: 'portal-key',
      inferenceModel: 'qwen3:8b',
    });

    expect(unreadable).toBe(false);
    expect(invalidKeys).toEqual(['dnsIp']);
    expect(settings.ciHubApiKey).toBe('portal-key');
    expect(settings.inferenceModel).toBe('qwen3:8b');
    expect(settings.dnsIp).toBeUndefined();
  });

  it('strips unknown keys exactly as the whole-object parse does, without calling them invalid', () => {
    const { settings, invalidKeys } = parsePersistedSettings({ dnsIp: 'not-an-ip', mcpApiKey: 'derived-and-dead' });

    expect(invalidKeys).toEqual(['dnsIp']);
    expect(settings).not.toHaveProperty('mcpApiKey');
  });

  it('reports a file whose top level is not an object rather than pretending it was empty', () => {
    for (const raw of [[], 'nonsense', 42, null]) {
      const result = parsePersistedSettings(raw);

      expect(result.unreadable).toBe(true);
      expect(result.settings).toEqual({});
    }
  });

  it('leaves an absent field absent instead of materializing it', () => {
    const { settings } = parsePersistedSettings({ dnsIp: 'not-an-ip' });

    expect(Object.keys(settings)).toEqual([]);
  });
});
