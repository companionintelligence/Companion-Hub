import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Only French typography puts a space before "?". In every other locale the
 * space is a typo the user sees, as in the "Uninstall 2FAuth ?" dialog title
 * (#1728). Untranslated strings are copied from en.json, so one typo there
 * spreads to many locale files.
 *
 * The global vitest setup (src/tests/vite.setup.ts) replaces `fs` with an
 * in-memory memfs implementation, so we pull the unmocked module via
 * `vi.importActual` for the on-disk reads.
 */

const TRANSLATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'common', 'i18n', 'translations');
const LANGUAGES_WITH_SPACE_BEFORE_QUESTION_MARK = new Set(['fr']);

describe('i18n punctuation', () => {
  it('no locale but French puts a space before "?"', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const files = realFs
      .readdirSync(TRANSLATIONS_DIR)
      .filter((f) => f.endsWith('.json') && !LANGUAGES_WITH_SPACE_BEFORE_QUESTION_MARK.has(f.split(/[-.]/)[0]));

    const offenders: string[] = [];

    for (const file of files) {
      const parsed = JSON.parse(realFs.readFileSync(join(TRANSLATIONS_DIR, file), 'utf-8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && /\s\?/.test(value)) {
          offenders.push(`${file} :: ${key}  ${JSON.stringify(value)}`);
        }
      }
    }

    expect(offenders, `Remove the space before "?" in these translations:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
