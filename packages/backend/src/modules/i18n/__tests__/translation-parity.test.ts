import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * `en.json` is the fallback/source-of-truth translation file. Every other
 * locale (en-US, fr-FR, de-DE, …) should expose at least the same set of
 * keys, otherwise the UI falls back to rendering the raw key string.
 *
 * Historically the canonical superset has lived in `en-US.json` and drifted
 * ahead of `en.json` (15 keys at one point — COMMON_PORT,
 * MY_APPS_BATCH_ACTIONS, MY_APPS_{START,STOP,RESTART}_ALL_*…). This test
 * asserts the no-drift invariant going forward.
 *
 * The global vitest setup (src/tests/vite.setup.ts) replaces `fs` with an
 * in-memory memfs implementation. We need real filesystem reads here, so we
 * pull the unmocked module via `vi.importActual` before any other code does.
 */

const TRANSLATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'common', 'i18n', 'translations');

async function loadKeys(file: string): Promise<Set<string>> {
  const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const raw = realFs.readFileSync(join(TRANSLATIONS_DIR, file), 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return new Set(Object.keys(parsed));
}

describe('i18n translation parity', () => {
  it('en.json contains every key present in en-US.json', async () => {
    const en = await loadKeys('en.json');
    const enUS = await loadKeys('en-US.json');

    const missing = [...enUS].filter((k) => !en.has(k)).sort();

    expect(missing, `Missing in en.json (add these or remove from en-US.json):\n${missing.join('\n')}`).toEqual([]);
  });

  it('en-US.json contains every key present in en.json', async () => {
    const en = await loadKeys('en.json');
    const enUS = await loadKeys('en-US.json');

    const missing = [...en].filter((k) => !enUS.has(k)).sort();

    expect(missing, `Missing in en-US.json (add these or remove from en.json):\n${missing.join('\n')}`).toEqual([]);
  });

  it('every translation file parses as valid JSON', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const files = realFs.readdirSync(TRANSLATIONS_DIR).filter((f) => f.endsWith('.json'));

    // A single broken locale file would cause i18next to fall back silently;
    // this assertion fails loudly with the offending file's name.
    for (const file of files) {
      const raw = realFs.readFileSync(join(TRANSLATIONS_DIR, file), 'utf-8');
      expect(() => JSON.parse(raw), `${file} is not valid JSON`).not.toThrow();
    }
  });
});
