import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Empty string translations are worse than missing keys: i18next renders
 * them as the empty string in the UI, whereas a missing key would fall
 * back to en. If a translator hasn't translated a string yet, the right
 * thing to do is *omit* it from the locale file so the fallback kicks in.
 *
 * Six empty values were found across pt-BR / zh-CN / zh-TW at the time
 * this guard was added; this test prevents that from re-appearing.
 *
 * The global vitest setup (src/tests/vite.setup.ts) replaces `fs` with an
 * in-memory memfs implementation, so we pull the unmocked module via
 * `vi.importActual` for the on-disk reads.
 */

const TRANSLATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'common', 'i18n', 'translations');

describe('i18n empty values', () => {
  it('no locale file contains an empty-string translation value', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const files = realFs.readdirSync(TRANSLATIONS_DIR).filter((f) => f.endsWith('.json'));

    const offenders: string[] = [];

    for (const file of files) {
      const raw = realFs.readFileSync(join(TRANSLATIONS_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value === '') {
          offenders.push(`${file}: ${key}`);
        }
      }
    }

    expect(
      offenders,
      `Empty translation values render as blank in the UI; delete the key instead so en falls back:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
