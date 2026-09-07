import { describe, expect, it } from 'vitest';
import { alternativeSlugsMatchingSearch, parseAlternativesCatalog, parseReplaces, searchAliasTextByAppId, textMatchesSearch } from '../store-search';

const raw = {
  data: [
    {
      proprietary: [{ name: 'Google Drive' }, { name: 'Dropbox' }],
      alternatives: [
        { name: 'Nextcloud', appSlug: 'nextcloud' },
        { name: 'Seafile', appSlug: 'seafile' },
      ],
    },
  ],
};

describe('store-search', () => {
  it('parses portal alternatives and maps google drive to nextcloud', () => {
    const catalog = parseAlternativesCatalog(raw);
    expect(alternativeSlugsMatchingSearch(catalog, 'google drive')).toEqual(['nextcloud', 'seafile']);
    expect(textMatchesSearch('Google Drive', 'google drive')).toBe(true);
  });

  it('parses per-app replaces metadata', () => {
    expect(parseReplaces(['Google Drive', 'Dropbox', '', 1])).toEqual(['Google Drive', 'Dropbox']);
  });

  it('indexes proprietary names as aliases for MiniSearch', () => {
    const aliases = searchAliasTextByAppId(parseAlternativesCatalog(raw));
    expect(aliases.get('nextcloud')).toContain('Google Drive');
    expect(aliases.get('nextcloud')).toContain('Dropbox');
  });
});
