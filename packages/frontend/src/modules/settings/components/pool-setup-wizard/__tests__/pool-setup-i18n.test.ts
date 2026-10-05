import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * i18next resolves a missing key to the key itself, and `tsc` cannot tell a typo in a string from a real
 * key. So this reads the source: every `HUB_POOL_SETUP_*` the guide, the Home card, the onboarding section,
 * the Settings callout and the Settings panel itself (its Add Hubs, Rescan and Add another Hub buttons)
 * name must exist in both English files, and every key those files define must be used by something.
 * The wizard's own tests render real English too, which covers keys built dynamically.
 */

const SRC = resolve(__dirname, '../../../../..');
const TRANSLATIONS = resolve(SRC, '../../common/i18n/translations');
const SOURCE_ROOTS = [
  resolve(SRC, 'modules/settings/components/pool-setup-wizard'),
  resolve(SRC, 'modules/dashboard/components/pool-setup-card.tsx'),
  resolve(SRC, 'modules/onboarding/components/pool-setup-onboarding-section.tsx'),
  resolve(SRC, 'modules/settings/containers/hub-pool-settings.tsx'),
];
const KEY = /HUB_POOL_SETUP_[A-Z0-9_]+/g;

function sourceFiles(path: string, out: string[] = []): string[] {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === '__tests__') continue;
      sourceFiles(join(path, entry), out);
    }
  } else if (/\.tsx?$/.test(path) && !/\.test\./.test(path)) {
    out.push(path);
  }
  return out;
}

const load = (file: string) => JSON.parse(readFileSync(join(TRANSLATIONS, file), 'utf8')) as Record<string, string>;
const en = load('en.json');
const enUS = load('en-US.json');

const referenced = new Set(SOURCE_ROOTS.flatMap((root) => sourceFiles(root)).flatMap((file) => readFileSync(file, 'utf8').match(KEY) ?? []));

/** A plural key is written once in source (`..._RESULT`) and defined twice (`_one`, `_other`). */
const defined = (dictionary: Record<string, string>, key: string) =>
  key in dictionary || (`${key}_one` in dictionary && `${key}_other` in dictionary);
const baseKey = (key: string) => key.replace(/_(one|other)$/, '');

describe('Hub Pool setup guide strings', () => {
  it('finds the keys the guide uses, so the scan below is not vacuous', () => {
    expect(referenced.size).toBeGreaterThan(80);
  });

  it.each([
    ['en.json', en],
    ['en-US.json', enUS],
  ])('defines every HUB_POOL_SETUP_ key the source references in %s', (_name, dictionary) => {
    const missing = [...referenced].filter((key) => !defined(dictionary, key));

    expect(missing).toEqual([]);
  });

  it('defines no HUB_POOL_SETUP_ key that nothing uses', () => {
    const unused = Object.keys(en)
      .filter((key) => key.startsWith('HUB_POOL_SETUP_'))
      .filter((key) => !referenced.has(key) && !referenced.has(baseKey(key)));

    expect(unused).toEqual([]);
  });

  it('carries identical text for every HUB_POOL_SETUP_ key in en.json and en-US.json', () => {
    const keys = (dictionary: Record<string, string>) => Object.keys(dictionary).filter((key) => key.startsWith('HUB_POOL_SETUP_'));

    expect(keys(enUS)).toEqual(keys(en));
    for (const key of keys(en)) {
      expect(enUS[key], key).toBe(en[key]);
    }
  });

  it('defines both plural forms for every plural key', () => {
    const forms = Object.keys(en).filter((key) => key.startsWith('HUB_POOL_SETUP_') && /_(one|other)$/.test(key));

    for (const key of forms) {
      const base = baseKey(key);
      expect(`${base}_one` in en && `${base}_other` in en, base).toBe(true);
    }
  });
});
