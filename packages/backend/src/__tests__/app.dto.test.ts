import { describe, expect, it } from 'vitest';
import { UserSettingsBody, settingsSchema } from '../app.dto';

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
