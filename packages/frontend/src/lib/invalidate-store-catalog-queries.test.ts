import { describe, expect, it } from 'vitest';

import { isStoreCatalogQueryKey } from './invalidate-store-catalog-queries';

describe('isStoreCatalogQueryKey', () => {
  it('matches getApp and other catalog query ids so Check for Updates refetches details', () => {
    expect(isStoreCatalogQueryKey([{ _id: 'getApp' }])).toBe(true);
    expect(isStoreCatalogQueryKey([{ _id: 'searchApps' }])).toBe(true);
    expect(isStoreCatalogQueryKey([{ _id: 'getStoreFeaturedBundle' }])).toBe(true);
    expect(isStoreCatalogQueryKey([{ _id: 'getStoreListings' }])).toBe(true);
    expect(isStoreCatalogQueryKey([{ _id: 'getInstalledApps' }])).toBe(true);
    expect(isStoreCatalogQueryKey(['portal', 'featured-bundle', 'ci-marketplace'])).toBe(true);
  });

  it('does not match unrelated queries', () => {
    expect(isStoreCatalogQueryKey([{ _id: 'getAppComposeDiff' }])).toBe(false);
    expect(isStoreCatalogQueryKey(['app-runtime-health'])).toBe(false);
  });
});
