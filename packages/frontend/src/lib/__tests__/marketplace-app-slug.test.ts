import { describe, expect, it } from 'vitest';
import { catalogAppSlug, findCatalogAppBySlug } from '../marketplace-app-slug';

describe('marketplace-app-slug', () => {
  it('prefers id over urn prefix', () => {
    expect(catalogAppSlug({ id: 'ci-memory', urn: 'other:ci-marketplace' })).toBe('ci-memory');
  });

  it('falls back to urn prefix when id is missing', () => {
    expect(catalogAppSlug({ urn: 'immich:ci-marketplace' })).toBe('immich');
  });

  it('finds apps by slug using urn when id is absent', () => {
    const apps = [{ urn: 'ghost:ci-marketplace', name: 'Ghost' }];
    expect(findCatalogAppBySlug(apps, 'ghost')).toEqual(apps[0]);
  });
});
