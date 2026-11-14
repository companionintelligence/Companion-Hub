import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import { asLegacyTranslate } from './legacy-translate';

const createT = async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'en', resources: { en: { translation: { GREETING: 'Hello {{name}}' } } } });
  return i18n.getFixedT('en');
};

describe('asLegacyTranslate', () => {
  it('forwards the key and the interpolation values', async () => {
    const t = await createT();

    expect(asLegacyTranslate(t)('GREETING', { name: 'Liam' })).toBe('Hello Liam');
  });

  it('treats a missing vars argument the same as an empty options object', async () => {
    const t = await createT();

    expect(asLegacyTranslate(t)('MISSING_KEY')).toBe(t('MISSING_KEY', {}));
  });

  it('returns the same adapter for the same t, so it keeps its identity across renders', async () => {
    const t = await createT();

    expect(asLegacyTranslate(t)).toBe(asLegacyTranslate(t));
  });
});
