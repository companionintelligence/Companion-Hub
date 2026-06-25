import { describe, it, expect } from 'vitest';
import { mapPortalStoreAppToHub } from '@/lib/portal-store';

describe('mapPortalStoreAppToHub', () => {
  it('maps portal store app fields to hub AppInfoSimple shape', () => {
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

    expect(result).toEqual({
      urn: 'nextcloud:ci-marketplace',
      name: 'Nextcloud',
      short_desc: 'Self-hosted cloud',
      categories: ['featured', 'utilities'],
      available: true,
      iconUrl: 'https://cdn.example.com/nextcloud.png',
    });
  });

  it('falls back to description and name fields', () => {
    const result = mapPortalStoreAppToHub({
      id: 'app1',
      name: 'App One',
      description: 'Full description',
    });

    expect(result.name).toBe('App One');
    expect(result.short_desc).toBe('Full description');
    expect(result.urn).toBe('app1:ci-marketplace');
  });
});
