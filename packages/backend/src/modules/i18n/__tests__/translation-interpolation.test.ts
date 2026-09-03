import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * i18next interpolation: when a key's translation references `{{var}}`, the
 * caller must pass that var. If the locale file uses a `{{var}}` that the
 * caller doesn't pass (or omits a `{{var}}` the caller does pass), the user
 * sees the literal placeholder string (e.g. `{{min}}`) in the UI.
 *
 * Treat en-US.json as the contract for what placeholders each key uses, then
 * assert every translated string for that key uses the exact same set of
 * placeholders. Extra or missing placeholders are both bugs.
 *
 * Caught at the time this guard was added:
 *   pt-BR :: APP_INSTALL_FORM_ERROR_MAX_LENGTH was using {{min}} {{max}}
 *   when callers only pass {{label}} {{max}} — `{{min}}` rendered literally.
 */

const TRANSLATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'common', 'i18n', 'translations');
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function extractPlaceholders(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set();
  const out = new Set<string>();
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    out.add(match[1]);
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

describe('i18n interpolation placeholders', () => {
  it('every translated string uses the same {{var}} set as en-US for that key', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const canonical = JSON.parse(realFs.readFileSync(join(TRANSLATIONS_DIR, 'en-US.json'), 'utf-8')) as Record<string, unknown>;
    const files = realFs.readdirSync(TRANSLATIONS_DIR).filter((f) => f.endsWith('.json') && f !== 'en-US.json');

    const offenders: string[] = [];

    for (const file of files) {
      const parsed = JSON.parse(realFs.readFileSync(join(TRANSLATIONS_DIR, file), 'utf-8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!(key in canonical)) continue;
        const expected = extractPlaceholders(canonical[key]);
        const got = extractPlaceholders(value);
        if (!setsEqual(expected, got)) {
          const missing = [...expected].filter((v) => !got.has(v));
          const extra = [...got].filter((v) => !expected.has(v));
          const parts: string[] = [];
          if (missing.length) parts.push(`missing={${missing.join(',')}}`);
          if (extra.length) parts.push(`extra={${extra.join(',')}}`);
          offenders.push(`${file} :: ${key}  ${parts.join(' ')}`);
        }
      }
    }

    expect(
      offenders,
      `Translated strings must use the same {{var}} placeholders as en-US.json (extra placeholders render literally; missing ones drop user-supplied values):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
