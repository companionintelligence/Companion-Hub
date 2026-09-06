import { describe, expect, it } from 'vitest';
import type { AltsCategory } from '@/modules/onboarding/helpers/types';
import { alternativeEntryMatchesSearch, alternativeSlugsMatchingSearch, filterAlternativesBySearch, textMatchesSearch } from './store-search';

const alts: AltsCategory = {
  data: [
    {
      proprietary: [
        { name: 'Google Drive', icon: '', url: null },
        { name: 'Dropbox', icon: '', url: null },
      ],
      alternatives: [
        { name: 'Nextcloud', icon: '', url: '', appSlug: 'nextcloud' },
        { name: 'Seafile', icon: '', url: '', appSlug: 'seafile' },
      ],
    },
  ],
  media: [
    {
      proprietary: [{ name: 'Google Photos', icon: '', url: null }],
      alternatives: [{ name: 'Immich', icon: '', url: '', appSlug: 'immich' }],
    },
  ],
};

// Narrowed once here so the tests below need no non-null assertions:
// AltsCategory's keys are optional, but this fixture always populates `data`.
const [firstDataEntry] = alts.data ?? [];
if (!firstDataEntry) {
  throw new Error('store-search test fixture is missing alts.data[0]');
}

describe('store-search', () => {
  it('matches a proprietary phrase to its open-source alternatives', () => {
    expect(alternativeSlugsMatchingSearch(alts, 'google drive')).toEqual(['nextcloud', 'seafile']);
    expect(filterAlternativesBySearch(alts, 'google drive')).toEqual({ data: alts.data });
  });

  it('matches tokens so "drive" still finds the Google Drive pairing', () => {
    expect(textMatchesSearch('Google Drive', 'drive')).toBe(true);
    expect(alternativeEntryMatchesSearch(firstDataEntry, 'data', 'drive')).toBe(true);
  });

  it('matches alternative names and slugs in the same listing', () => {
    expect(alternativeSlugsMatchingSearch(alts, 'nextcloud')).toEqual(['nextcloud', 'seafile']);
    expect(alternativeSlugsMatchingSearch(alts, 'seafile')).toEqual(['nextcloud', 'seafile']);
    expect(filterAlternativesBySearch(alts, 'immich')).toEqual({ media: alts.media });
  });

  it('does not treat an unrelated query as a hit', () => {
    expect(alternativeSlugsMatchingSearch(alts, 'slack')).toEqual([]);
    expect(filterAlternativesBySearch(alts, 'slack')).toEqual({});
  });
});
