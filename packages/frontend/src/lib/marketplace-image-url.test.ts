import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfig } = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock('@/api-client/client.gen', () => ({
  client: {
    getConfig,
  },
}));

import { getMarketplaceAppImagePath, getMarketplaceAppImageUrl } from './marketplace-image-url';

describe('marketplace image URL helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockReturnValue({ baseUrl: '' });
  });

  it('builds the encoded marketplace image path', () => {
    expect(getMarketplaceAppImagePath('app name:store/slug')).toBe('/api/marketplace/apps/app%20name%3Astore%2Fslug/image');
  });

  it('prefixes the API base URL in packaged mode', () => {
    getConfig.mockReturnValue({ baseUrl: 'http://localhost:5002' });

    expect(getMarketplaceAppImageUrl('test-app:community')).toBe('http://localhost:5002/api/marketplace/apps/test-app%3Acommunity/image');
  });

  it('keeps a relative URL in browser mode when no API base URL is configured', () => {
    expect(getMarketplaceAppImageUrl('test-app:community')).toBe('/api/marketplace/apps/test-app%3Acommunity/image');
  });

  it('falls back to the placeholder image when no urn is provided', () => {
    expect(getMarketplaceAppImageUrl()).toBe('/app-not-found.jpg');
  });
});
