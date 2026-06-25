import { describe, it, expect } from 'vitest';
import { mapPortalStoreAppToHub, portalStoreListingsQueryKey } from '@/lib/portal-store';

describe('mapPortalStoreAppToHub', () => {
  it('maps portal store app fields to hub store listing shape', () => {
    const result = mapPortalStoreAppToHub(
      {
        id: 'nextcloud',
        title: 'Nextcloud',
        shortDescription: 'Self-hosted cloud',
        icon: 'https://cdn.example.com/nextcloud.png',
        tags: ['featured', 'utilities'],
      },
      'ci-marketplace',
    );

    expect(result).toEqual(
      expect.objectContaining({
        urn: 'nextcloud:ci-marketplace',
        name: 'Nextcloud',
        short_desc: 'Self-hosted cloud',
        categories: ['featured', 'utilities'],
        iconUrl: 'https://cdn.example.com/nextcloud.png',
      }),
    );
  });

  it('falls back to description and name fields', () => {
    const result = mapPortalStoreAppToHub({
      id: 'app1',
      name: 'App One',
      description: 'Full description',
    });

    expect(result).toMatchObject({
      name: 'App One',
      short_desc: 'Full description',
      urn: 'app1:ci-marketplace',
    });
  });

  it('filters unknown categories and defaults to utilities', () => {
    const result = mapPortalStoreAppToHub({
      id: 'app1',
      tags: ['not-a-real-category'],
    });

    expect(result.categories).toEqual(['utilities']);
  });
});

describe('portalStoreListingsQueryKey', () => {
  it('includes storeId so listings for different stores do not share cache entries', () => {
    const params = { tags: 'featured' };
    expect(portalStoreListingsQueryKey(params, 'ci-apps')).not.toEqual(portalStoreListingsQueryKey(params, 'ci-marketplace'));
    expect(portalStoreListingsQueryKey(params, 'ci-marketplace')).toEqual(['portal', 'store-listings', 'ci-marketplace', params]);
  });
});
